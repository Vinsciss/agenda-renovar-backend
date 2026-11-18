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
app.use(cors());
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

// Extrai tokens suportando tanto o formato novo (array fcmTokens) quanto legado (string fcmToken)
function obterTokensDoUsuario(userData) {
  if (!userData) return [];
  const lista = [];
  if (Array.isArray(userData.fcmTokens)) {
    lista.push(...userData.fcmTokens.filter(Boolean));
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

app.post('/enviar-notificacao', async (req, res) => {
  const { tokens, titulo, corpo, dados } = req.body;
  
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
    } 
    else {
      const tokensUnicos = [...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean))];
      if (tokensUnicos.length === 0) {
        return res.status(400).json({ erro: "Nenhum token válido fornecido" });
      }
      const mensagemMulticast = {
        notification: { title: titulo, body: corpo },
        data: dadosLimpos,
        android: ANDROID_HIGH_PRIORITY,
        tokens: tokensUnicos
      };
      const resposta = await admin.messaging().sendEachForMulticast(mensagemMulticast);
      console.log(`✅ ${resposta.successCount} notificações diretas enviadas (${resposta.failureCount} falhas).`);
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

app.get('/cron/lembretes-escalas', async (req, res) => {
  try {
    const db = admin.firestore();
    
    // Calcula as datas no fuso horário do Brasil
    const getBrazilDateOffset = (days) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    };

    const hojeStr = getBrazilDateOffset(0);
    const amanhaStr = getBrazilDateOffset(1);
    const semanaStr = getBrazilDateOffset(7);
    
    const hBR = new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo", hour: '2-digit', hour12: false});
    const horaAtual = parseInt(hBR, 10);

    const snapshot = await db.collection('tarefas').where('data', 'in', [hojeStr, amanhaStr, semanaStr]).get();
    const lembretes = {};

    snapshot.forEach(doc => {
      const t = doc.data();
      if (!t.usuarios || !t.data) return;
      
      if (t.data === hojeStr && horaAtual >= 9 && t.hora) {
         const horaEvento = parseInt(t.hora.split(':')[0], 10);
         if (horaEvento <= 9) return;
      }

      t.usuarios.forEach(user => {
         const key = `${user}_${t.eventoId || t.eventoNome}_${t.data}`;
         if (!lembretes[key]) {
             lembretes[key] = { usuario: user, eventoNome: t.eventoNome || "Evento", data: t.data, hora: t.hora, funcoes: [] };
         }
         lembretes[key].funcoes.push(t.nome);
      });
    });

    const promises = [];
    const usuariosRef = db.collection('usuarios');

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

       const snapUser = await usuariosRef.where('nome', '==', info.usuario).get();
       let userTokens = [];
       if (!snapUser.empty) {
           userTokens = obterTokensDoUsuario(snapUser.docs[0].data());
       } else {
           const snapApelido = await usuariosRef.where('apelido', '==', info.usuario).get();
           if (!snapApelido.empty) userTokens = obterTokensDoUsuario(snapApelido.docs[0].data());
       }

       if (userTokens.length > 0) {
           const mensagem = {
             notification: { title: titulo, body: corpo },
             android: ANDROID_HIGH_PRIORITY,
             data: { tipo: 'escala_criada' },
             tokens: userTokens
           };
           promises.push(admin.messaging().sendEachForMulticast(mensagem).catch(e => console.error("Erro push:", e)));
       }
    }

    await Promise.all(promises);
    return res.status(200).json({ sucesso: true, enviados: promises.length });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/cron/lembretes-trocas', async (req, res) => {
  try {
    const db = admin.firestore();
    const snapshot = await db.collection('tarefas').where('status', '==', 'Troca Pendente').get();
    
    const promises = [];
    const usuariosRef = db.collection('usuarios');

    const adminTokens = [];
    const snapAdmins = await usuariosRef.where('admin', '==', true).get();
    snapAdmins.docs.forEach(d => { adminTokens.push(...obterTokensDoUsuario(d.data())); });

    snapshot.forEach(doc => {
      const t = doc.data();
      const solicitante = t.solicitantes && t.solicitantes[0] ? t.solicitantes[0].nome : "Um membro";
      const destino = t.solicitantes && t.solicitantes[0] ? t.solicitantes[0].destino : null;

      const titulo = "⏳ Lembrete de Troca Pendente";
      const corpo = `O pedido de troca de ${solicitante} para a função ${t.nome} no dia ${t.data.split('-').reverse().join('/')} continua aguardando resposta!`;

      promises.push((async () => {
         let tokensTarget = [];
         if (destino && destino !== "Admin" && destino !== "admin") {
             const snapTarget = await usuariosRef.where('nome', '==', destino).get();
             if (!snapTarget.empty) tokensTarget.push(...obterTokensDoUsuario(snapTarget.docs[0].data()));
             else {
                 const snapApelido = await usuariosRef.where('apelido', '==', destino).get();
                 if (!snapApelido.empty) tokensTarget.push(...obterTokensDoUsuario(snapApelido.docs[0].data()));
             }
         }
         if (tokensTarget.length === 0) tokensTarget = adminTokens;

         if (tokensTarget.length > 0) {
             const mensagem = {
               notification: { title: titulo, body: corpo },
               android: ANDROID_HIGH_PRIORITY,
               data: { tipo: 'swap-request' },
               tokens: [...new Set(tokensTarget)]
             };
             await admin.messaging().sendEachForMulticast(mensagem).catch(e => console.error(e));
         }
      })());
    });

    await Promise.all(promises);
    return res.status(200).json({ sucesso: true, pendencias: snapshot.size });
  } catch (err) {
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
