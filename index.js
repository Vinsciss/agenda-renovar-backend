const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// 🔒 Sistema de Segurança: Lê das Variáveis de Ambiente (Nuvem) OU do arquivo local
let serviceAccount;
if (process.env.FIREBASE_PRIVATE_KEY) {
  serviceAccount = {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    // O Render costuma escapar as quebras de linha da chave, isso corrige o formato:
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  };
} else {
  serviceAccount = require('./firebase-adminsdk.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();

// 🌐 CORS restrito às origens conhecidas do app (permite chamadas sem Origin como crons/servidor)
const DEFAULT_ALLOWED_ORIGINS = [
  'https://agenda-renovar.web.app',
  'https://agenda-renovar.firebaseapp.com',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  'http://localhost:5173'
];

const extraAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraAllowedOrigins]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      return callback(null, true);
    }
    const err = new Error('Origem não permitida pela política CORS.');
    err.status = 403;
    return callback(err);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cron-secret']
}));

app.use((err, req, res, next) => {
  if (err && err.status === 403) {
    return res.status(403).json({ erro: err.message });
  }
  return next(err);
});

app.use(express.json());

// Configuração padrão Android para garantir entrega imediata mesmo em Doze/tela bloqueada
const ANDROID_HIGH_PRIORITY = {
  priority: 'high',
  notification: {
    channelId: 'agenda_renovar_channel',
    sound: 'default',
    priority: 'high',
    defaultSound: true,
    defaultVibrateTimings: true
  }
};

const FCM_MULTICAST_BATCH_SIZE = 500;

// Extrai o Bearer Token do header Authorization
function extrairBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return token || null;
}

// Comparação timing-safe para segredos
function segredoConfere(fornecido, esperado) {
  if (typeof fornecido !== 'string' || typeof esperado !== 'string' || !esperado) {
    return false;
  }
  const bufA = Buffer.from(fornecido);
  const bufB = Buffer.from(esperado);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Middleware: exige Firebase ID Token válido
async function verificarAutenticacao(req, res, next) {
  const token = extrairBearerToken(req);
  if (!token) {
    return res.status(401).json({ erro: 'Token de autenticação ausente.' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch (err) {
    console.warn('🔒 Token Firebase inválido:', err.message);
    return res.status(401).json({ erro: 'Token de autenticação inválido ou expirado.' });
  }
}

// Middleware: protege rotas de cron por CRON_SECRET (se configurado) OU token Firebase de Admin
async function verificarAutorizacaoCron(req, res, next) {
  const bearerToken = extrairBearerToken(req);
  let tokenValidoNaoAdmin = false;

  if (bearerToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(bearerToken);
      const userSnap = await admin.firestore().collection('usuarios').doc(decoded.uid).get();
      if (userSnap.exists && userSnap.data()?.admin === true) {
        req.user = decoded;
        req.isAdmin = true;
        return next();
      }
      tokenValidoNaoAdmin = true;
    } catch (err) {
      console.warn('🔒 Falha ao verificar Bearer token no cron:', err.message);
    }
  }

  const cronSecret = process.env.CRON_SECRET;
  if (typeof cronSecret === 'string' && cronSecret.length > 0) {
    const providedSecret = req.headers['x-cron-secret'] || req.query.secret;
    if (typeof providedSecret === 'string' && segredoConfere(providedSecret, cronSecret)) {
      req.isAdmin = false;
      return next();
    }
  }

  if (tokenValidoNaoAdmin) {
    return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
  }
  return res.status(401).json({ erro: 'Não autorizado para executar este cron.' });
}

// Calcula a data YYYY-MM-DD no fuso horário de São Paulo
function getBrazilDateOffset(days = 0) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

// Retorna hora atual (0-23) no fuso horário de São Paulo sem o bug de meia-noite "24"
function getBrazilCurrentHour() {
  const hBR = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(new Date());
  const parsed = parseInt(hBR, 10);
  return parsed === 24 ? 0 : parsed;
}

// Extrai tokens suportando tanto o formato novo (array fcmTokens) quanto legado (string fcmToken)
function obterTokensDoUsuario(userData) {
  if (!userData) return [];
  const lista = [];
  if (Array.isArray(userData.fcmTokens)) {
    lista.push(...userData.fcmTokens.filter((t) => typeof t === 'string' && t.trim()));
  }
  if (typeof userData.fcmToken === 'string' && userData.fcmToken.trim()) {
    lista.push(userData.fcmToken.trim());
  }
  return [...new Set(lista)];
}

// Garante que todos os valores de 'data' sejam strings (exigência do FCM)
function sanitizarDadosFCM(dados) {
  const out = {};
  if (!dados || typeof dados !== 'object') return out;
  for (const [k, v] of Object.entries(dados)) {
    if (v !== null && v !== undefined) {
      out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return out;
}

// Envia notificações multicast dividindo tokens em lotes de no máximo 500 (limite do Firebase Admin SDK)
async function enviarMulticastEmLotes(tokens, payload) {
  const tokensUnicos = [
    ...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter((t) => typeof t === 'string' && t.trim()))
  ];

  if (tokensUnicos.length === 0) {
    return { successCount: 0, failureCount: 0, responses: [], lotes: 0 };
  }

  let successCount = 0;
  let failureCount = 0;
  const responses = [];
  let lotes = 0;

  for (let i = 0; i < tokensUnicos.length; i += FCM_MULTICAST_BATCH_SIZE) {
    const lote = tokensUnicos.slice(i, i + FCM_MULTICAST_BATCH_SIZE);
    const resposta = await admin.messaging().sendEachForMulticast({
      ...payload,
      tokens: lote
    });
    successCount += resposta.successCount || 0;
    failureCount += resposta.failureCount || 0;
    if (Array.isArray(resposta.responses)) {
      responses.push(...resposta.responses);
    }
    lotes += 1;
  }

  return { successCount, failureCount, responses, lotes };
}

// Carrega toda a coleção de usuários uma única vez por execução de cron (evita N+1 queries)
async function carregarMapaUsuarios(db) {
  const snapUsuarios = await db.collection('usuarios').get();
  const porNome = new Map();
  const porApelido = new Map();
  const adminTokensSet = new Set();

  const adicionarTokens = (mapa, chave, tokens) => {
    if (typeof chave !== 'string') return;
    const chaveLimpa = chave.trim();
    if (!chaveLimpa || tokens.length === 0) return;
    if (!mapa.has(chaveLimpa)) mapa.set(chaveLimpa, new Set());
    const set = mapa.get(chaveLimpa);
    for (const token of tokens) set.add(token);
  };

  snapUsuarios.forEach((doc) => {
    const data = doc.data();
    const tokens = obterTokensDoUsuario(data);
    if (tokens.length === 0) return;

    adicionarTokens(porNome, data.nome, tokens);
    adicionarTokens(porApelido, data.apelido, tokens);
    if (data.admin === true) {
      for (const token of tokens) adminTokensSet.add(token);
    }
  });

  const buscarTokens = (identificador) => {
    if (typeof identificador !== 'string') return [];
    const chave = identificador.trim();
    if (!chave) return [];
    const byNome = porNome.get(chave);
    if (byNome && byNome.size > 0) return [...byNome];
    const byApelido = porApelido.get(chave);
    if (byApelido && byApelido.size > 0) return [...byApelido];
    return [];
  };

  return {
    buscarTokens,
    adminTokens: [...adminTokensSet]
  };
}

// Guarda de idempotência diária em cron_runs/{jobName}_{hojeStr}
async function adquirirExecucaoDiariaCron(db, jobName, hojeStr, forceRun) {
  const runId = `${jobName}_${hojeStr}`;
  const runRef = db.collection('cron_runs').doc(runId);

  if (forceRun) {
    await runRef.set({
      jobName,
      data: hojeStr,
      status: 'running',
      forced: true,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { adquirido: true, runRef, runId };
  }

  const adquirido = await db.runTransaction(async (tx) => {
    const snap = await tx.get(runRef);
    if (snap.exists) {
      const existing = snap.data();
      if (existing?.status === 'completed' || existing?.status === 'running') {
        return false;
      }
    }
    tx.set(runRef, {
      jobName,
      data: hojeStr,
      status: 'running',
      forced: false,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  });

  return { adquirido, runRef, runId };
}

app.post('/enviar-notificacao', verificarAutenticacao, async (req, res) => {
  const { tokens, titulo, corpo, dados } = req.body || {};

  if (!tokens || tokens.length === 0) {
    return res.status(400).json({ erro: "Nenhum destino/token fornecido" });
  }

  const dadosLimpos = sanitizarDadosFCM(dados);

  try {
    if (tokens === 'igreja_geral' || (Array.isArray(tokens) && tokens[0] === 'igreja_geral')) {
      const mensagemTopico = {
        notification: { title: titulo, body: corpo },
        data: dadosLimpos,
        android: ANDROID_HIGH_PRIORITY,
        topic: 'igreja_geral'
      };
      const resposta = await admin.messaging().send(mensagemTopico);
      console.log('✅ Notificação global enviada:', resposta);
      return res.status(200).json({ sucesso: true, detalhes: resposta, tipo: 'topico' });
    } else {
      const tokensUnicos = [
        ...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter((t) => typeof t === 'string' && t.trim()))
      ];
      if (tokensUnicos.length === 0) {
        return res.status(400).json({ erro: "Nenhum token válido fornecido" });
      }
      const resposta = await enviarMulticastEmLotes(tokensUnicos, {
        notification: { title: titulo, body: corpo },
        data: dadosLimpos,
        android: ANDROID_HIGH_PRIORITY
      });
      console.log(`✅ ${resposta.successCount} notificações diretas enviadas (${resposta.failureCount} falhas, ${resposta.lotes} lote(s)).`);
      return res.status(200).json({ sucesso: true, detalhes: resposta, tipo: 'direta' });
    }
  } catch (erro) {
    console.error("🚨 Erro ao enviar:", erro);
    return res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

// Rota leve de health check (útil para manter servidor acordado no Render)
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, timestamp: Date.now() });
});


// ==========================================
// ⏰ ROTAS DE CRON JOBS (LEMBRETES INTELIGENTES)
// ==========================================

app.get('/cron/lembretes-escalas', verificarAutorizacaoCron, async (req, res) => {
  const db = admin.firestore();
  const hojeStr = getBrazilDateOffset(0);
  const jobName = 'lembretes-escalas';
  let runRef = null;

  try {
    if (req.query.force === 'true' && !req.isAdmin) {
      return res.status(403).json({ erro: 'Apenas administradores autenticados podem usar force=true.' });
    }
    const forceRun = req.query.force === 'true' && req.isAdmin === true;

    const lock = await adquirirExecucaoDiariaCron(db, jobName, hojeStr, forceRun);
    if (!lock.adquirido) {
      return res.status(200).json({
        sucesso: true,
        ignorado: true,
        motivo: `Cron ${jobName} já executado hoje (${hojeStr}).`,
        runId: lock.runId
      });
    }
    runRef = lock.runRef;

    const amanhaStr = getBrazilDateOffset(1);
    const semanaStr = getBrazilDateOffset(7);
    const horaAtual = getBrazilCurrentHour();

    const [snapshot, mapaUsuarios] = await Promise.all([
      db.collection('tarefas').where('data', 'in', [hojeStr, amanhaStr, semanaStr]).get(),
      carregarMapaUsuarios(db)
    ]);

    const lembretes = {};

    snapshot.forEach((doc) => {
      const t = doc.data();
      if (!Array.isArray(t.usuarios) || !t.data) return;

      if (t.data === hojeStr && horaAtual >= 9 && typeof t.hora === 'string' && t.hora.trim()) {
        const horaEvento = parseInt(t.hora.split(':')[0], 10);
        if (!Number.isNaN(horaEvento) && horaEvento <= 9) return;
      }

      t.usuarios.forEach((user) => {
        const key = `${user}_${t.eventoId || t.eventoNome}_${t.data}`;
        if (!lembretes[key]) {
          lembretes[key] = { usuario: user, eventoNome: t.eventoNome || "Evento", data: t.data, hora: t.hora, funcoes: [] };
        }
        lembretes[key].funcoes.push(t.nome);
      });
    });

    const promises = [];

    for (const key in lembretes) {
      const info = lembretes[key];

      let prefixoTempo = "";
      if (info.data === hojeStr) prefixoTempo = "É Hoje! 🎉";
      else if (info.data === amanhaStr) prefixoTempo = "É Amanhã! ⏳";
      else if (info.data === semanaStr) prefixoTempo = "Falta 1 semana! 📅";

      const titulo = `${prefixoTempo} ${info.eventoNome}`;
      const funcStr = info.funcoes.join(", ");
      const corpo = `Lembrete da sua escala:
📍 Funções: ${funcStr}
⏰ Horário: ${info.hora || '--:--'}`;

      const userTokens = mapaUsuarios.buscarTokens(info.usuario);

      if (userTokens.length > 0) {
        promises.push(
          enviarMulticastEmLotes(userTokens, {
            notification: { title: titulo, body: corpo },
            android: ANDROID_HIGH_PRIORITY,
            data: { tipo: 'escala_criada' }
          }).catch((e) => console.error("Erro push:", e))
        );
      }
    }

    await Promise.all(promises);

    await runRef.set({
      status: 'completed',
      enviados: promises.length,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).json({ sucesso: true, enviados: promises.length });
  } catch (err) {
    if (runRef) {
      await runRef.set({
        status: 'failed',
        erro: err.message,
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
    }
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/cron/lembretes-trocas', verificarAutorizacaoCron, async (req, res) => {
  const db = admin.firestore();
  const hojeStr = getBrazilDateOffset(0);
  const jobName = 'lembretes-trocas';
  let runRef = null;

  try {
    if (req.query.force === 'true' && !req.isAdmin) {
      return res.status(403).json({ erro: 'Apenas administradores autenticados podem usar force=true.' });
    }
    const forceRun = req.query.force === 'true' && req.isAdmin === true;

    const lock = await adquirirExecucaoDiariaCron(db, jobName, hojeStr, forceRun);
    if (!lock.adquirido) {
      return res.status(200).json({
        sucesso: true,
        ignorado: true,
        motivo: `Cron ${jobName} já executado hoje (${hojeStr}).`,
        runId: lock.runId
      });
    }
    runRef = lock.runRef;

    const [snapshot, mapaUsuarios] = await Promise.all([
      db.collection('tarefas').where('status', '==', 'Troca Pendente').get(),
      carregarMapaUsuarios(db)
    ]);

    const promises = [];

    snapshot.forEach((doc) => {
      const t = doc.data();
      const solicitante = t.solicitantes && t.solicitantes[0] ? t.solicitantes[0].nome : "Um membro";
      const destino = t.solicitantes && t.solicitantes[0] ? t.solicitantes[0].destino : null;

      const dataFormatada = (typeof t.data === 'string' && t.data.includes('-'))
        ? t.data.split('-').reverse().join('/')
        : (typeof t.data === 'string' && t.data.trim() ? t.data.trim() : 'data não informada');

      const titulo = "⏳ Lembrete de Troca Pendente";
      const corpo = `O pedido de troca de ${solicitante} para a função ${t.nome || 'Escala'} no dia ${dataFormatada} continua aguardando resposta!`;

      let tokensTarget = [];
      if (destino && destino !== "Admin" && destino !== "admin") {
        tokensTarget = mapaUsuarios.buscarTokens(destino);
      }
      if (tokensTarget.length === 0) {
        tokensTarget = mapaUsuarios.adminTokens;
      }

      if (tokensTarget.length > 0) {
        promises.push(
          enviarMulticastEmLotes(tokensTarget, {
            notification: { title: titulo, body: corpo },
            android: ANDROID_HIGH_PRIORITY,
            data: { tipo: 'swap-request' }
          }).catch((e) => console.error(e))
        );
      }
    });

    await Promise.all(promises);

    await runRef.set({
      status: 'completed',
      pendencias: snapshot.size,
      enviados: promises.length,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).json({ sucesso: true, pendencias: snapshot.size });
  } catch (err) {
    if (runRef) {
      await runRef.set({
        status: 'failed',
        erro: err.message,
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
    }
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Servidor de Notificações Ativo! 🚀');
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log('🚀 Servidor backend rodando na porta ' + PORTA);
});
