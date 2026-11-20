const crypto = require('crypto');
const {
  gerarIdentificadoresUsuario,
  usuarioBateComNome
} = require('./googleCalendarModule');

const DEFAULT_ACTION_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const INVALID_FCM_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'registration-token-not-registered',
  'messaging/invalid-registration-token',
  'invalid-registration-token'
]);
const PREFIXOS_CARGO_REGEX = /^(pr|pra|diac|miss|tes|sec)\s+/i;

const CANAIS_NOTIFICACAO = {
  ESCALAS: 'canal_escalas',
  TROCAS: 'canal_trocas',
  URGENTE: 'canal_urgente',
  TESOURARIA: 'canal_tesouraria',
  AVISOS: 'canal_avisos'
};

function limparStr(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).trim();
}

function parseJsonSeguro(valor) {
  if (!valor) return null;
  if (typeof valor === 'object') return valor;
  if (typeof valor !== 'string') return null;
  try {
    return JSON.parse(valor);
  } catch {
    return null;
  }
}

function normalizarTextoSimples(str = '') {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function obterEstiloNotificacao(tipo) {
  const t = limparStr(tipo);

  if ([
    'event-created',
    'task-scale-change',
    'escala_criada',
    'lembrete_1day',
    'lembrete_3h',
    'event-edited'
  ].includes(t)) {
    return { channelId: CANAIS_NOTIFICACAO.ESCALAS, color: '#0D9488', priority: 'high' };
  }

  if ([
    'swap-request',
    'swap-info-admin',
    'swap-success',
    'swap-fail',
    'swap-admin-resolved',
    'troca_solicitada',
    'troca_respondida',
    'troca_info_admin'
  ].includes(t)) {
    return { channelId: CANAIS_NOTIFICACAO.TROCAS, color: '#F59E0B', priority: 'high' };
  }

  if (['deletion-alert', 'admin-urgent', 'escala_removida'].includes(t)) {
    return { channelId: CANAIS_NOTIFICACAO.URGENTE, color: '#E11D48', priority: 'high' };
  }

  if (t === 'tesouraria-lembrete') {
    return { channelId: CANAIS_NOTIFICACAO.TESOURARIA, color: '#059669', priority: 'high' };
  }

  if (t === 'tesouraria-atraso') {
    return { channelId: CANAIS_NOTIFICACAO.TESOURARIA, color: '#E11D48', priority: 'high' };
  }

  if (['aviso-novo', 'aviso_geral'].includes(t)) {
    return { channelId: CANAIS_NOTIFICACAO.AVISOS, color: '#6366F1', priority: 'high' };
  }

  return { channelId: CANAIS_NOTIFICACAO.AVISOS, color: '#6366F1', priority: 'high' };
}

function isRotaSegura(rota) {
  return typeof rota === 'string' && rota.startsWith('/') && !rota.startsWith('//');
}

function extrairContextoDados(dados = {}) {
  const obj = dados && typeof dados === 'object' ? dados : {};
  const tarefaOrigemParsed = parseJsonSeguro(obj.tarefaOrigem);
  const idTroca =
    limparStr(obj.idTroca) ||
    limparStr(tarefaOrigemParsed?.solicitantes?.[0]?.idTroca) ||
    '';
  const tarefaId = limparStr(obj.tarefaId) || limparStr(tarefaOrigemParsed?.id) || '';
  const solicitante =
    limparStr(obj.solicitante) ||
    limparStr(tarefaOrigemParsed?.solicitantes?.[0]?.nome) ||
    '';
  const destino =
    limparStr(obj.destino) ||
    limparStr(tarefaOrigemParsed?.solicitantes?.[0]?.destino) ||
    '';
  const txId = limparStr(obj.txId);

  return { idTroca, tarefaId, solicitante, destino, txId };
}

function obterRotaPadraoNotificacao(tipo, dados = {}, isAdmin = false) {
  const t = limparStr(tipo);
  const { idTroca, tarefaId, txId } = extrairContextoDados(dados);

  if (t.startsWith('tesouraria-')) {
    if (isRotaSegura(dados?.rota)) return dados.rota;
    return txId
      ? `/admin/tesouraria?filtro=pendentes&tx=${encodeURIComponent(txId)}`
      : '/admin/tesouraria?filtro=pendentes';
  }

  if (t === 'swap-info-admin' || t === 'troca_info_admin') {
    if (!isAdmin) return '/userdashboard';
    const qs = ['abrir=trocas-admin'];
    if (idTroca) qs.push(`trocaId=${encodeURIComponent(idTroca)}`);
    else if (tarefaId) qs.push(`tarefaId=${encodeURIComponent(tarefaId)}`);
    return `/admindashboard?${qs.join('&')}`;
  }

  if (isRotaSegura(dados?.rota)) return dados.rota;
  return isAdmin ? '/admindashboard' : '/userdashboard';
}

function resolverSigningSecret(overrideSecret, serviceAccount) {
  const candidate =
    overrideSecret ||
    process.env.NOTIFICATION_ACTION_SECRET ||
    process.env.CRON_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET ||
    serviceAccount?.private_key_id ||
    'agenda-renovar-action-fallback';
  return String(candidate);
}

function gerarActionToken(payload, signingSecret, ttlMs = DEFAULT_ACTION_TOKEN_TTL_MS) {
  if (!payload || !payload.uid || !payload.action) {
    throw new Error('Payload de actionToken exige uid e action.');
  }
  const secret = resolverSigningSecret(signingSecret);
  const body = {
    v: 1,
    ...payload,
    exp: payload.exp !== undefined ? Number(payload.exp) : Date.now() + ttlMs
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verificarActionToken(token, signingSecret) {
  if (typeof token !== 'string' || !token.trim()) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;

  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;

  const secret = resolverSigningSecret(signingSecret);
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  const bufProvided = Buffer.from(providedSig, 'utf8');
  const bufExpected = Buffer.from(expectedSig, 'utf8');
  if (bufProvided.length !== bufExpected.length) return null;
  if (!crypto.timingSafeEqual(bufProvided, bufExpected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.uid !== 'string' ||
      !parsed.uid.trim() ||
      typeof parsed.action !== 'string' ||
      !parsed.action.trim() ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function montarAcoesParaUsuario({
  tipo,
  dados = {},
  uid,
  userData = {},
  hasTesourariaPrivilege,
  signingSecret
}) {
  if (!uid) return [];
  const t = limparStr(tipo);
  const { idTroca, tarefaId, solicitante, destino, txId } = extrairContextoDados(dados);
  const isAdmin = userData?.admin === true;

  if ((t === 'swap-request' || t === 'troca_solicitada') && (idTroca || tarefaId)) {
    const base = {
      uid,
      ...(idTroca ? { idTroca } : {}),
      ...(tarefaId ? { tarefaId } : {}),
      ...(solicitante ? { solicitante } : {}),
      ...(destino ? { destino } : {})
    };
    return [
      {
        id: 'swap_accept',
        label: 'Aceitar',
        kind: 'api',
        actionToken: gerarActionToken({ ...base, action: 'swap_accept' }, signingSecret)
      },
      {
        id: 'swap_decline',
        label: 'Recusar',
        kind: 'api',
        actionToken: gerarActionToken({ ...base, action: 'swap_decline' }, signingSecret)
      }
    ];
  }

  if ((t === 'swap-info-admin' || t === 'troca_info_admin') && isAdmin && (idTroca || tarefaId)) {
    const base = {
      uid,
      ...(idTroca ? { idTroca } : {}),
      ...(tarefaId ? { tarefaId } : {}),
      ...(solicitante ? { solicitante } : {}),
      ...(destino ? { destino } : {})
    };
    const rotaIntervencao = obterRotaPadraoNotificacao('swap-info-admin', { idTroca, tarefaId }, true);

    if (destino && destino.toLowerCase() !== 'admin') {
      return [
        {
          id: 'swap_accept',
          label: 'Aprovar',
          kind: 'api',
          actionToken: gerarActionToken({ ...base, action: 'swap_accept' }, signingSecret)
        },
        {
          id: 'open_intervene',
          label: 'Escolher outro',
          kind: 'open',
          rota: rotaIntervencao
        },
        {
          id: 'swap_decline',
          label: 'Recusar',
          kind: 'api',
          actionToken: gerarActionToken({ ...base, action: 'swap_decline' }, signingSecret)
        }
      ];
    }

    return [
      {
        id: 'open_intervene',
        label: 'Intervir no App',
        kind: 'open',
        rota: rotaIntervencao
      },
      {
        id: 'swap_decline',
        label: 'Recusar',
        kind: 'api',
        actionToken: gerarActionToken({ ...base, action: 'swap_decline' }, signingSecret)
      }
    ];
  }

  if (
    (t === 'tesouraria-lembrete' || t === 'tesouraria-atraso') &&
    txId &&
    typeof hasTesourariaPrivilege === 'function' &&
    hasTesourariaPrivilege(userData)
  ) {
    const rotaTesouraria = obterRotaPadraoNotificacao(t, { txId }, isAdmin);
    return [
      {
        id: 'tesouraria_mark_paid',
        label: 'Marcar Pago',
        kind: 'api',
        actionToken: gerarActionToken({ uid, txId, action: 'tesouraria_mark_paid' }, signingSecret)
      },
      {
        id: 'open_tesouraria',
        label: 'Abrir Tesouraria',
        kind: 'open',
        rota: rotaTesouraria
      }
    ];
  }

  return [];
}

function extrairTokensInvalidosDeResposta(tokenResults = []) {
  if (!Array.isArray(tokenResults) || tokenResults.length === 0) return [];
  const dead = new Set();
  for (const item of tokenResults) {
    if (!item || item.success) continue;
    const code = limparStr(item.errorCode);
    if (INVALID_FCM_ERROR_CODES.has(code) && typeof item.token === 'string' && item.token.trim()) {
      dead.add(item.token.trim());
    }
  }
  return [...dead];
}

async function podarTokensInvalidos({ db, admin, deadTokens, tokenMetaMap }) {
  if (!db || !admin || !Array.isArray(deadTokens) || deadTokens.length === 0) return 0;

  const porUid = new Map();
  for (const token of deadTokens) {
    const entries = tokenMetaMap instanceof Map ? tokenMetaMap.get(token) : null;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry?.uid || !entry?.ref) continue;
      if (!porUid.has(entry.uid)) {
        porUid.set(entry.uid, {
          ref: entry.ref,
          tokens: new Set(),
          fcmTokenLegacy: entry.fcmTokenLegacy || null,
          tokenDocRefs: []
        });
      }
      const bucket = porUid.get(entry.uid);
      bucket.tokens.add(token);
      if (Array.isArray(entry.tokenDocRefs)) {
        for (const docRef of entry.tokenDocRefs) bucket.tokenDocRefs.push(docRef);
      }
    }
  }

  const ops = [];
  for (const [, info] of porUid.entries()) {
    const list = [...info.tokens];
    if (list.length === 0) continue;
    const updatePayload = {
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...list)
    };
    if (info.fcmTokenLegacy && info.tokens.has(info.fcmTokenLegacy)) {
      updatePayload.fcmToken = admin.firestore.FieldValue.delete();
    }
    ops.push(info.ref.update(updatePayload));
    for (const subDocRef of info.tokenDocRefs) {
      ops.push(subDocRef.delete());
    }
  }

  if (ops.length > 0) {
    await Promise.allSettled(ops);
  }
  return deadTokens.length;
}

function gerarHashNotifId(seedStr) {
  const hash = crypto.createHash('sha1').update(String(seedStr || '')).digest();
  // Mantém inteiro positivo de 31 bits para NotificationManager.notify
  return String((hash.readUInt32BE(0) & 0x7fffffff) || 1);
}

async function enviarPushInteligente({
  db,
  admin,
  tokens,
  titulo,
  corpo,
  dados = {},
  hasTesourariaPrivilege,
  enviarMulticastEmLotes,
  sanitizarDadosFCM,
  signingSecret,
  usuariosSnapCache = null
}) {
  const tokensUnicos = [
    ...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))
  ];

  if (tokensUnicos.length === 0) {
    return { successCount: 0, failureCount: 0, lotes: 0, prunedCount: 0 };
  }

  const targetSet = new Set(tokensUnicos);
  const snapUsuarios = usuariosSnapCache || (await db.collection('usuarios').get());

  const usuariosMatch = [];
  const tokenMetaMap = new Map();
  const tokenToUidsOwned = new Set();

  snapUsuarios.forEach((doc) => {
    const data = doc.data() || {};
    const list = [];
    if (Array.isArray(data.fcmTokens)) {
      for (const t of data.fcmTokens) {
        if (typeof t === 'string' && t.trim() && targetSet.has(t.trim())) list.push(t.trim());
      }
    }
    const legacy = typeof data.fcmToken === 'string' && data.fcmToken.trim() ? data.fcmToken.trim() : null;
    if (legacy && targetSet.has(legacy)) list.push(legacy);

    const uniqueUserTokens = [...new Set(list)];
    if (uniqueUserTokens.length === 0) return;

    usuariosMatch.push({
      uid: doc.id,
      ref: doc.ref,
      data,
      tokens: uniqueUserTokens,
      fcmTokenLegacy: legacy
    });

    for (const t of uniqueUserTokens) {
      tokenToUidsOwned.add(t);
    }
  });

  // Busca subcoleção /usuarios/{uid}/tokens apenas para os UIDs destinatários (sem collectionGroup)
  const subTokensByUid = new Map();
  if (usuariosMatch.length > 0) {
    const subSnaps = await Promise.all(
      usuariosMatch.map((u) =>
        u.ref
          .collection('tokens')
          .get()
          .then((snap) => ({ uid: u.uid, snap }))
          .catch(() => ({ uid: u.uid, snap: null }))
      )
    );
    for (const { uid, snap } of subSnaps) {
      const richSet = new Set();
      const refsByToken = new Map();
      if (snap) {
        snap.forEach((d) => {
          const td = d.data() || {};
          const tok = typeof td.token === 'string' ? td.token.trim() : '';
          if (!tok) return;
          if (td.richNotifications === true) richSet.add(tok);
          if (!refsByToken.has(tok)) refsByToken.set(tok, []);
          refsByToken.get(tok).push(d.ref);
        });
      }
      subTokensByUid.set(uid, { richSet, refsByToken });
    }
  }

  for (const u of usuariosMatch) {
    const subInfo = subTokensByUid.get(u.uid);
    for (const t of u.tokens) {
      if (!tokenMetaMap.has(t)) tokenMetaMap.set(t, []);
      tokenMetaMap.get(t).push({
        uid: u.uid,
        ref: u.ref,
        fcmTokenLegacy: u.fcmTokenLegacy,
        tokenDocRefs: subInfo?.refsByToken.get(t) || []
      });
    }
  }

  const dadosCompactos = { ...dados };
  delete dadosCompactos.tarefaOrigem;
  delete dadosCompactos.tarefaDestino;
  const dadosLimpos = sanitizarDadosFCM(dadosCompactos);
  const tipo = limparStr(dadosLimpos.tipo) || 'aviso_geral';
  const estilo = obterEstiloNotificacao(tipo);
  const ctxDados = extrairContextoDados(dados);
  if (ctxDados.idTroca && !dadosLimpos.idTroca) dadosLimpos.idTroca = ctxDados.idTroca;
  if (ctxDados.tarefaId && !dadosLimpos.tarefaId) dadosLimpos.tarefaId = ctxDados.tarefaId;
  if (ctxDados.solicitante && !dadosLimpos.solicitante) dadosLimpos.solicitante = ctxDados.solicitante;
  if (ctxDados.destino && !dadosLimpos.destino) dadosLimpos.destino = ctxDados.destino;
  if (ctxDados.txId && !dadosLimpos.txId) dadosLimpos.txId = ctxDados.txId;
  const notifSeed = `${tipo}:${ctxDados.idTroca || ctxDados.txId || ctxDados.tarefaId || titulo}`;
  const notifIdStr = gerarHashNotifId(notifSeed);

  const sendPromises = [];
  const sentTokens = new Set();

  for (const u of usuariosMatch) {
    const subInfo = subTokensByUid.get(u.uid);
    const richTokens = [];
    const legacyTokens = [];

    for (const t of u.tokens) {
      if (sentTokens.has(t)) continue;
      sentTokens.add(t);
      if (subInfo?.richSet.has(t)) richTokens.push(t);
      else legacyTokens.push(t);
    }

    if (richTokens.length === 0 && legacyTokens.length === 0) continue;

    const isAdmin = u.data?.admin === true;
    const rota = obterRotaPadraoNotificacao(tipo, dados, isAdmin);
    const acoes = montarAcoesParaUsuario({
      tipo,
      dados,
      uid: u.uid,
      userData: u.data,
      hasTesourariaPrivilege,
      signingSecret
    });
    const acoesJson = JSON.stringify(acoes);

    if (richTokens.length > 0) {
      sendPromises.push(
        enviarMulticastEmLotes(richTokens, {
          android: { priority: 'high' },
          data: sanitizarDadosFCM({
            ...dadosLimpos,
            rich_native: '1',
            title: titulo,
            body: corpo,
            tipo,
            canal: estilo.channelId,
            cor: estilo.color,
            rota,
            acoes: acoesJson,
            notif_id: notifIdStr
          })
        })
      );
    }

    if (legacyTokens.length > 0) {
      const legacyData = {
        ...dadosLimpos,
        tipo,
        canal: estilo.channelId,
        cor: estilo.color,
        rota
      };
      if (acoes.length > 0) legacyData.acoes = acoesJson;

      sendPromises.push(
        enviarMulticastEmLotes(legacyTokens, {
          notification: { title: titulo, body: corpo },
          android: {
            priority: 'high',
            notification: {
              channelId: estilo.channelId,
              color: estilo.color,
              sound: 'default',
              priority: 'high',
              defaultSound: true,
              defaultVibrateTimings: true
            }
          },
          data: sanitizarDadosFCM(legacyData)
        })
      );
    }
  }

  const orphanTokens = tokensUnicos.filter((t) => !sentTokens.has(t));
  if (orphanTokens.length > 0) {
    const rotaOrphan = obterRotaPadraoNotificacao(tipo, dados, false);
    sendPromises.push(
      enviarMulticastEmLotes(orphanTokens, {
        notification: { title: titulo, body: corpo },
        android: {
          priority: 'high',
          notification: {
            channelId: estilo.channelId,
            color: estilo.color,
            sound: 'default',
            priority: 'high',
            defaultSound: true,
            defaultVibrateTimings: true
          }
        },
        data: sanitizarDadosFCM({
          ...dadosLimpos,
          tipo,
          canal: estilo.channelId,
          cor: estilo.color,
          rota: rotaOrphan
        })
      })
    );
  }

  const resultados = await Promise.all(sendPromises);
  let successCount = 0;
  let failureCount = 0;
  let lotes = 0;
  const deadTokensSet = new Set();

  for (const r of resultados) {
    if (!r) continue;
    successCount += r.successCount || 0;
    failureCount += r.failureCount || 0;
    lotes += r.lotes || 0;
    for (const dead of extrairTokensInvalidosDeResposta(r.tokenResults || [])) {
      deadTokensSet.add(dead);
    }
  }

  let prunedCount = 0;
  if (deadTokensSet.size > 0) {
    try {
      prunedCount = await podarTokensInvalidos({
        db,
        admin,
        deadTokens: [...deadTokensSet],
        tokenMetaMap
      });
      if (prunedCount > 0) {
        console.log(`🧹 Auto-poda: ${prunedCount} token(s) FCM inválido(s) removido(s) do Firestore.`);
      }
    } catch (pruneErr) {
      console.warn('⚠️ Falha na auto-poda de tokens FCM:', pruneErr.message);
    }
  }

  return { successCount, failureCount, lotes, prunedCount };
}

/* ============================================================
   HELPERS PARA EXECUÇÃO DAS AÇÕES RÁPIDAS NO FIRESTORE
   ============================================================ */

function formatarDataHumanaBackend(dataIsoOuString, { incluirDiaSemana = true } = {}) {
  if (!dataIsoOuString) return '';
  const str = String(dataIsoOuString);
  const data = new Date(str.includes('T') ? str : `${str}T12:00:00`);
  if (Number.isNaN(data.getTime())) return str;

  const dataFormatada = data.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo'
  });
  if (!incluirDiaSemana) return dataFormatada;

  const diasSemana = [
    'domingo',
    'segunda-feira',
    'terça-feira',
    'quarta-feira',
    'quinta-feira',
    'sexta-feira',
    'sábado'
  ];
  // Ajusta dia da semana no fuso America/Sao_Paulo
  const spDayName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short'
  }).format(data);
  const mapDia = {
    Sun: diasSemana[0],
    Mon: diasSemana[1],
    Tue: diasSemana[2],
    Wed: diasSemana[3],
    Thu: diasSemana[4],
    Fri: diasSemana[5],
    Sat: diasSemana[6]
  };
  return `${dataFormatada}, ${mapDia[spDayName] || diasSemana[data.getDay()]}`;
}

function formatarNomeAdminBackend(nome) {
  const limpo = limparStr(nome);
  if (!limpo || limpo.toLowerCase() === 'admin') return 'Admin';
  return /^admin\b/i.test(limpo) ? limpo : `Admin ${limpo}`;
}

function obterNomePadraoUsuario(userObj, fallback = '') {
  if (!userObj) return fallback;
  return limparStr(userObj.apelido) || limparStr(userObj.nome) || fallback;
}

function usuarioCorrespondeTexto(nomeA, nomeB) {
  const nA = normalizarTextoSimples(nomeA);
  const nB = normalizarTextoSimples(nomeB);
  return Boolean(nA && nB && nA === nB);
}

function usuarioDocBateComNome(userDoc, alvoNome, codigoOuId = null) {
  if (!userDoc) return false;
  if (codigoOuId && codigoOuId !== 'admin') {
    if (userDoc.id === codigoOuId || userDoc.codigo === codigoOuId) return true;
  }
  if (!alvoNome || alvoNome.toLowerCase() === 'admin') return false;
  const ids = gerarIdentificadoresUsuario(userDoc);
  if (usuarioBateComNome(ids, alvoNome)) return true;
  const alvoNorm = normalizarTextoSimples(alvoNome);
  const nomeNorm = normalizarTextoSimples(userDoc.nome);
  const apelidoNorm = normalizarTextoSimples(userDoc.apelido);
  return Boolean(alvoNorm && (alvoNorm === nomeNorm || alvoNorm === apelidoNorm));
}

function resolverUsuarioNaLista(usuariosDb, alvoNome, codigoOuId = null) {
  if (codigoOuId && codigoOuId !== 'admin') {
    const porId = usuariosDb.find((u) => u.id === codigoOuId || u.codigo === codigoOuId);
    if (porId) return porId;
  }
  if (!alvoNome) return null;
  const exato = usuariosDb.find((u) => usuarioDocBateComNome(u, alvoNome, null));
  return exato || null;
}

function substituirNoGrupoBackend(grupo, alvoNome, substitutoNome, userAlvoRef) {
  const lista = Array.isArray(grupo) ? [...grupo] : [];
  if (lista.length === 0) return lista;

  const alvoNorm = normalizarTextoSimples(alvoNome);
  const nomeRefNorm = userAlvoRef ? normalizarTextoSimples(userAlvoRef.nome) : '';
  const apelidoRefNorm = userAlvoRef ? normalizarTextoSimples(userAlvoRef.apelido) : '';
  const exatos = new Set([alvoNorm, nomeRefNorm, apelidoRefNorm].filter(Boolean));
  if (userAlvoRef) {
    for (const v of gerarIdentificadoresUsuario(userAlvoRef)) {
      exatos.add(normalizarTextoSimples(v));
    }
  }

  let idxMatch = lista.findIndex((item) => exatos.has(normalizarTextoSimples(item)));

  if (idxMatch === -1) {
    const semPrefixoSet = new Set(
      Array.from(exatos)
        .map((t) => t.replace(PREFIXOS_CARGO_REGEX, '').trim())
        .filter(Boolean)
    );
    idxMatch = lista.findIndex((item) => {
      const semPref = normalizarTextoSimples(item).replace(PREFIXOS_CARGO_REGEX, '').trim();
      return Boolean(semPref && semPrefixoSet.has(semPref));
    });
  }

  if (idxMatch === -1) return lista;

  const subNorm = normalizarTextoSimples(substitutoNome);
  const atualizado = [...lista];
  atualizado[idxMatch] = substitutoNome;

  let jaViuSub = false;
  return atualizado.filter((item) => {
    const key = normalizarTextoSimples(item);
    if (!key) return false;
    if (key === subNorm) {
      if (jaViuSub) return false;
      jaViuSub = true;
    }
    return true;
  });
}

function filtrarSolicitantesRestantesBackend(solicitantes, { idTroca = null, solicitanteNome = null } = {}) {
  if (!Array.isArray(solicitantes)) return [];
  return solicitantes.filter((s) => {
    if (idTroca && s?.idTroca) return s.idTroca !== idTroca;
    if (solicitanteNome) return !usuarioCorrespondeTexto(s?.nome, solicitanteNome);
    return false;
  });
}

async function buscarTrocaPendenteBackend(db, { idTroca, tarefaId, solicitante }) {
  if (idTroca) {
    const docSnap = await db.collection('trocas').doc(idTroca).get();
    if (docSnap.exists) {
      return { id: docSnap.id, ref: docSnap.ref, exists: true, ...docSnap.data() };
    }
  }
  if (!tarefaId) return null;
  const snap = await db.collection('trocas').where('tarefaOrigem.id', '==', tarefaId).get();
  if (snap.empty) return null;
  const candidatos = snap.docs.map((d) => ({ id: d.id, ref: d.ref, exists: true, ...d.data() }));
  const pendentes = candidatos.filter((c) => c.status === 'Pendente');
  const lista = pendentes.length > 0 ? pendentes : candidatos;

  if (solicitante) {
    const porSolic = lista.find((c) => usuarioCorrespondeTexto(c.solicitante, solicitante));
    if (porSolic) return porSolic;
  }
  return lista[0] || null;
}

async function resolverNotificacoesTrocaBackend(db, { tarefaId, solicitante, idTroca }) {
  try {
    const snap = await db
      .collection('notificacoes')
      .where('tipo', 'in', ['swap-request', 'swap-info-admin'])
      .get();
    if (snap.empty) return;

    const batch = db.batch();
    let count = 0;
    snap.forEach((d) => {
      const m = d.data()?.meta || {};
      const bateId = idTroca && m.idTroca && m.idTroca === idTroca;
      const bateTarefa = tarefaId && m.tarefaId === tarefaId;
      const bateSolic = !solicitante || !m.solicitante || usuarioCorrespondeTexto(m.solicitante, solicitante);
      if (bateId || (bateTarefa && bateSolic)) {
        batch.update(d.ref, { lida: true, resolvida: true, tipo: 'swap-resolved' });
        count += 1;
      }
    });
    if (count > 0) await batch.commit();
  } catch (err) {
    console.warn('⚠️ Falha ao resolver notificações de troca:', err.message);
  }
}

async function emitirNotificacaoBackend({
  db,
  admin,
  usuariosSnap,
  usuariosAlvo,
  titulo,
  descricao,
  tipo,
  meta = {},
  hasTesourariaPrivilege,
  enviarMulticastEmLotes,
  sanitizarDadosFCM,
  signingSecret
}) {
  const nomesAlvo = [...new Set((Array.isArray(usuariosAlvo) ? usuariosAlvo : [usuariosAlvo]).filter(Boolean))];
  if (nomesAlvo.length === 0) return;

  const allUsers = [];
  usuariosSnap.forEach((d) => allUsers.push({ id: d.id, ...d.data() }));

  const batch = db.batch();
  const tokensSet = new Set();
  const agoraIso = new Date().toISOString();
  const metaComTs = { ...meta, timestamp: Date.now() };

  for (const nomeAlvo of nomesAlvo) {
    if (nomeAlvo.toLowerCase() === 'admin') {
      allUsers.forEach((u) => {
        if (u.admin === true) {
          if (Array.isArray(u.fcmTokens)) u.fcmTokens.filter(Boolean).forEach((t) => tokensSet.add(t));
          else if (u.fcmToken) tokensSet.add(u.fcmToken);
        }
      });
      const notifRef = db.collection('notificacoes').doc();
      batch.set(notifRef, {
        usuario: 'Admin',
        uid: null,
        titulo,
        descricao,
        tipo,
        criada_em: agoraIso,
        lida: false,
        meta: metaComTs
      });
      continue;
    }

    const userObj = resolverUsuarioNaLista(allUsers, nomeAlvo, null);
    if (userObj) {
      if (Array.isArray(userObj.fcmTokens)) userObj.fcmTokens.filter(Boolean).forEach((t) => tokensSet.add(t));
      else if (userObj.fcmToken) tokensSet.add(userObj.fcmToken);
    }

    const notifRef = db.collection('notificacoes').doc();
    batch.set(notifRef, {
      usuario: nomeAlvo,
      uid: userObj?.id || null,
      titulo,
      descricao,
      tipo,
      criada_em: agoraIso,
      lida: false,
      meta: metaComTs
    });
  }

  await batch.commit();

  if (tokensSet.size > 0) {
    await enviarPushInteligente({
      db,
      admin,
      tokens: [...tokensSet],
      titulo,
      corpo: descricao,
      dados: { tipo, ...meta },
      hasTesourariaPrivilege,
      enviarMulticastEmLotes,
      sanitizarDadosFCM,
      signingSecret,
      usuariosSnapCache: usuariosSnap
    }).catch((err) => console.warn('⚠️ Falha ao enviar push de resultado:', err.message));
  }
}

function registerNotificationActionRoutes({
  app,
  admin,
  hasTesourariaPrivilege,
  enviarMulticastEmLotes,
  sanitizarDadosFCM,
  sincronizarGoogleCalendarAfetados,
  signingSecret
}) {
  app.post('/notificacoes/acao-rapida', async (req, res) => {
    try {
      const actionToken = req.body?.actionToken;
      const decoded = verificarActionToken(actionToken, signingSecret);

      if (!decoded) {
        return res.status(401).json({
          ok: false,
          titulo: 'Ação expirada',
          mensagem: 'Abra o app para responder esta solicitação.'
        });
      }

      const db = admin.firestore();
      const userSnap = await db.collection('usuarios').doc(decoded.uid).get();
      if (!userSnap.exists) {
        return res.status(403).json({
          ok: false,
          titulo: 'Acesso negado',
          mensagem: 'Usuário não encontrado para executar esta ação.'
        });
      }

      const userData = { id: userSnap.id, ...userSnap.data() };
      const isAdmin = userData.admin === true;
      const nomeAtor = obterNomePadraoUsuario(userData, 'Usuário');

      // ============================================================
      // 1) TESOURARIA — MARCAR COMO PAGO
      // ============================================================
      if (decoded.action === 'tesouraria_mark_paid') {
        if (!hasTesourariaPrivilege(userData)) {
          return res.status(403).json({
            ok: false,
            titulo: 'Sem permissão',
            mensagem: 'Apenas Tesouraria ou Liderança pode quitar lançamentos.'
          });
        }

        const txId = limparStr(decoded.txId);
        if (!txId) {
          return res.status(400).json({
            ok: false,
            titulo: 'Dados inválidos',
            mensagem: 'Identificador do lançamento ausente.'
          });
        }

        const txRef = db.collection('tesouraria_transacoes').doc(txId);
        const txSnap = await txRef.get();
        if (!txSnap.exists) {
          return res.status(404).json({
            ok: false,
            titulo: 'Lançamento não encontrado',
            mensagem: 'Este lançamento pode ter sido excluído no app.',
            rota: '/admin/tesouraria?filtro=pendentes'
          });
        }

        const txData = txSnap.data() || {};
        if (txData.status === 'pago') {
          return res.status(200).json({
            ok: true,
            jaResolvido: true,
            titulo: 'Já marcado como pago',
            mensagem: `"${txData.description || 'Lançamento'}" já estava quitado.`,
            rota: '/admin/tesouraria?filtro=pendentes'
          });
        }

        // Atualiza APENAS status e updatedAt (preserva amount e createdAt!)
        await txRef.update({
          status: 'pago',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        try {
          const notifsSnap = await db
            .collection('notificacoes')
            .where('tipo', 'in', ['tesouraria-lembrete', 'tesouraria-atraso'])
            .get();
          const batch = db.batch();
          let updatedNotifs = 0;
          notifsSnap.forEach((nDoc) => {
            const nd = nDoc.data() || {};
            if (!nd.resolvida && nd.meta?.txId === txId) {
              batch.update(nDoc.ref, { lida: true, resolvida: true });
              updatedNotifs += 1;
            }
          });
          if (updatedNotifs > 0) await batch.commit();
        } catch (nErr) {
          console.warn('⚠️ Falha ao resolver notificações da tesouraria:', nErr.message);
        }

        if (typeof sincronizarGoogleCalendarAfetados === 'function') {
          sincronizarGoogleCalendarAfetados({ scope: 'tesouraria', affectedNames: [] }).catch(() => {});
        }

        return res.status(200).json({
          ok: true,
          titulo: 'Lançamento quitado!',
          mensagem: `"${txData.description || 'Lançamento'}" foi marcado como pago.`,
          rota: '/admin/tesouraria?filtro=pendentes'
        });
      }

      // ============================================================
      // 2) TROCAS — ACEITAR / APROVAR OU RECUSAR
      // ============================================================
      if (decoded.action === 'swap_accept' || decoded.action === 'swap_decline') {
        const troca = await buscarTrocaPendenteBackend(db, {
          idTroca: limparStr(decoded.idTroca),
          tarefaId: limparStr(decoded.tarefaId),
          solicitante: limparStr(decoded.solicitante)
        });

        const rotaPadrao = isAdmin ? '/admindashboard' : '/userdashboard';

        if (!troca) {
          return res.status(200).json({
            ok: true,
            jaResolvido: true,
            titulo: 'Troca já resolvida',
            mensagem: 'Esta solicitação não está mais pendente.',
            rota: rotaPadrao
          });
        }

        if (troca.status !== 'Pendente') {
          return res.status(200).json({
            ok: true,
            jaResolvido: true,
            titulo: 'Troca já resolvida',
            mensagem: `Esta solicitação já foi marcada como "${troca.status}".`,
            rota: rotaPadrao
          });
        }

        const tarefaId = limparStr(troca.tarefaOrigem?.id) || limparStr(decoded.tarefaId);
        const solicitante = limparStr(troca.solicitante) || limparStr(decoded.solicitante);
        const destino = limparStr(troca.destino) || limparStr(decoded.destino);
        const usuarioEhDestino = usuarioDocBateComNome(userData, destino, troca.destino_codigo);

        if (decoded.action === 'swap_accept') {
          const destinoEhAdminPlaceholder = !destino || destino.toLowerCase() === 'admin';
          if (destinoEhAdminPlaceholder) {
            return res.status(400).json({
              ok: false,
              titulo: 'Escolha no App',
              mensagem: 'Esta solicitação exige selecionar um substituto no aplicativo.',
              rota: `/admindashboard?abrir=trocas-admin&trocaId=${encodeURIComponent(troca.id)}`
            });
          }

          if (!usuarioEhDestino && !isAdmin) {
            return res.status(403).json({
              ok: false,
              titulo: 'Sem permissão',
              mensagem: 'Apenas o destinatário da troca ou a liderança pode confirmar.',
              rota: rotaPadrao
            });
          }

          const tarefaRef = db.collection('tarefas').doc(tarefaId);
          const tarefaSnap = await tarefaRef.get();
          if (!tarefaSnap.exists) {
            return res.status(404).json({
              ok: false,
              titulo: 'Escala não encontrada',
              mensagem: 'A tarefa original da troca não existe mais.',
              rota: rotaPadrao
            });
          }

          const tarefaAtual = { id: tarefaSnap.id, ...tarefaSnap.data() };
          const solicitacaoNaTarefa = Array.isArray(tarefaAtual.solicitantes)
            ? tarefaAtual.solicitantes.find(
                (s) => (troca.id && s.idTroca === troca.id) || usuarioCorrespondeTexto(s.nome, solicitante)
              )
            : null;

          const tarefaDestId = limparStr(troca.tarefaDestino?.id) || limparStr(solicitacaoNaTarefa?.tarefaTroca?.id);
          let tarefaDestData = null;
          let tarefaDestRef = null;
          if (tarefaDestId) {
            tarefaDestRef = db.collection('tarefas').doc(tarefaDestId);
            const docDest = await tarefaDestRef.get();
            if (!docDest.exists) {
              return res.status(404).json({
                ok: false,
                titulo: 'Contrapartida ausente',
                mensagem: 'A escala de contrapartida desta troca não existe mais.',
                rota: rotaPadrao
              });
            }
            tarefaDestData = { id: docDest.id, ...docDest.data() };
          }

          const usuariosSnap = await db.collection('usuarios').get();
          const usuariosDb = usuariosSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

          const userSolic = resolverUsuarioNaLista(
            usuariosDb,
            solicitante,
            troca.solicitante_codigo || solicitacaoNaTarefa?.codigo_solicitante
          );
          const userDest = resolverUsuarioNaLista(
            usuariosDb,
            destino,
            troca.destino_codigo || solicitacaoNaTarefa?.codigo_destino
          );

          const nomeCanonicalSolicitante = obterNomePadraoUsuario(userSolic, solicitante);
          const nomeCanonicalDestino = obterNomePadraoUsuario(userDest, destino);

          const grupoOrigemAtual = Array.isArray(tarefaAtual.usuarios)
            ? tarefaAtual.usuarios
            : tarefaAtual.usuario
              ? [tarefaAtual.usuario]
              : [];
          const novoGrupoOrigem = substituirNoGrupoBackend(
            grupoOrigemAtual,
            solicitante,
            nomeCanonicalDestino,
            userSolic
          );

          if (JSON.stringify(novoGrupoOrigem) === JSON.stringify(grupoOrigemAtual)) {
            return res.status(409).json({
              ok: false,
              titulo: 'Escala alterada',
              mensagem: `${solicitante} não está mais escalado nesta função.`,
              rota: rotaPadrao
            });
          }

          const solicitantesRestantesOrigem = filtrarSolicitantesRestantesBackend(tarefaAtual.solicitantes, {
            idTroca: troca.id,
            solicitanteNome: solicitante
          });

          await tarefaRef.update({
            usuarios: novoGrupoOrigem,
            usuario: null,
            solicitantes: solicitantesRestantesOrigem,
            status: solicitantesRestantesOrigem.length > 0 ? 'Troca Pendente' : 'Confirmada'
          });

          if (tarefaDestData && tarefaDestRef) {
            const grupoDestAtual = Array.isArray(tarefaDestData.usuarios)
              ? tarefaDestData.usuarios
              : tarefaDestData.usuario
                ? [tarefaDestData.usuario]
                : [];
            const novoGrupoDest = substituirNoGrupoBackend(
              grupoDestAtual,
              destino,
              nomeCanonicalSolicitante,
              userDest
            );
            const solicitantesRestantesDest = filtrarSolicitantesRestantesBackend(tarefaDestData.solicitantes, {
              solicitanteNome: nomeCanonicalDestino
            });

            await tarefaDestRef.update({
              usuarios: novoGrupoDest,
              usuario: null,
              solicitantes: solicitantesRestantesDest,
              status: solicitantesRestantesDest.length > 0 ? 'Troca Pendente' : 'Confirmada'
            });

            const snapTrocasContrapartida = await db
              .collection('trocas')
              .where('tarefaOrigem.id', '==', tarefaDestData.id)
              .get();
            const agoraIso = new Date().toISOString();
            const cancelOps = [];
            snapTrocasContrapartida.forEach((tc) => {
              const tcd = tc.data();
              if (tcd.status === 'Pendente' && usuarioCorrespondeTexto(tcd.solicitante, nomeCanonicalDestino)) {
                cancelOps.push(
                  tc.ref.update({
                    status: 'Cancelada',
                    cancelada_em: agoraIso,
                    cancelada_por: 'Troca Mútua Aceita'
                  })
                );
              }
            });
            if (cancelOps.length > 0) await Promise.all(cancelOps);
          }

          await troca.ref.update({
            destino: nomeCanonicalDestino,
            status: 'Aceita',
            aceita_em: new Date().toISOString(),
            aceita_por: nomeAtor
          });

          await resolverNotificacoesTrocaBackend(db, {
            tarefaId: tarefaAtual.id,
            solicitante,
            idTroca: troca.id
          });

          const foiMediacaoAdmin = isAdmin && !usuarioEhDestino;
          const tarefaOrigemNotif = troca.tarefaOrigem || tarefaAtual;
          const dataHumana = formatarDataHumanaBackend(tarefaOrigemNotif.data);
          const dataCurta = formatarDataHumanaBackend(tarefaOrigemNotif.data, { incluirDiaSemana: false });
          const dataContrapartidaCurta = tarefaDestData?.data
            ? formatarDataHumanaBackend(tarefaDestData.data, { incluirDiaSemana: false })
            : '';

          if (foiMediacaoAdmin) {
            const adminLabel = formatarNomeAdminBackend(nomeAtor);
            await emitNotificationPairMediacao({
              db,
              admin,
              usuariosSnap,
              nomeCanonicalSolicitante,
              nomeCanonicalDestino,
              adminLabel,
              tarefaOrigemNotif,
              dataHumana,
              hasTesourariaPrivilege,
              enviarMulticastEmLotes,
              sanitizarDadosFCM,
              signingSecret
            });
          } else {
            await emitNotificationTrocaDiretaAceita({
              db,
              admin,
              usuariosSnap,
              nomeCanonicalSolicitante,
              nomeCanonicalDestino,
              tarefaOrigemNotif,
              dataHumana,
              dataCurta,
              dataContrapartidaCurta,
              hasTesourariaPrivilege,
              enviarMulticastEmLotes,
              sanitizarDadosFCM,
              signingSecret
            });
          }

          if (typeof sincronizarGoogleCalendarAfetados === 'function') {
            sincronizarGoogleCalendarAfetados({
              scope: 'trocas',
              affectedNames: [nomeCanonicalSolicitante, nomeCanonicalDestino]
            }).catch(() => {});
          }

          return res.status(200).json({
            ok: true,
            titulo: 'Troca confirmada!',
            mensagem: `${nomeCanonicalDestino} assumiu "${tarefaOrigemNotif.nome || 'Escala'}" no dia ${dataCurta}.`,
            rota: rotaPadrao
          });
        }

        // swap_decline
        if (!usuarioEhDestino && !isAdmin) {
          return res.status(403).json({
            ok: false,
            titulo: 'Sem permissão',
            mensagem: 'Você não tem permissão para recusar esta troca.',
            rota: rotaPadrao
          });
        }

        const tarefaRef = db.collection('tarefas').doc(tarefaId);
        const tarefaSnap = await tarefaRef.get();
        const tarefaAtual = tarefaSnap.exists ? { id: tarefaSnap.id, ...tarefaSnap.data() } : null;

        if (tarefaAtual) {
          const restantes = filtrarSolicitantesRestantesBackend(tarefaAtual.solicitantes, {
            idTroca: troca.id,
            solicitanteNome: solicitante
          });
          await tarefaRef.update({
            solicitantes: restantes,
            status: restantes.length > 0 ? 'Troca Pendente' : 'Confirmada'
          });
        }

        await troca.ref.update({
          status: 'Recusada',
          recusada_em: new Date().toISOString(),
          recusada_por: nomeAtor
        });

        await resolverNotificacoesTrocaBackend(db, {
          tarefaId,
          solicitante,
          idTroca: troca.id
        });

        const usuariosSnap = await db.collection('usuarios').get();
        const recusadoPorAdmin = isAdmin && (!destino || destino.toLowerCase() === 'admin' || !usuarioEhDestino);
        const tarefaOrigemNotif = troca.tarefaOrigem || tarefaAtual || { id: tarefaId, nome: 'Escala' };
        const dataHumana = formatarDataHumanaBackend(tarefaOrigemNotif.data);
        const dataCurta = formatarDataHumanaBackend(tarefaOrigemNotif.data, { incluirDiaSemana: false });
        const quemRecusou = nomeAtor || destino || 'O destinatário';

        if (recusadoPorAdmin) {
          if (solicitante) {
            await emitirNotificacaoBackend({
              db,
              admin,
              usuariosSnap,
              usuariosAlvo: solicitante,
              titulo: 'Pedido de troca recusado',
              descricao: `Seu pedido de troca da função ${tarefaOrigemNotif.nome} do dia ${dataCurta} foi recusado por ${formatarNomeAdminBackend(quemRecusou)}.`,
              tipo: 'swap-fail',
              meta: { tarefa: tarefaOrigemNotif.nome, tarefaId },
              hasTesourariaPrivilege,
              enviarMulticastEmLotes,
              sanitizarDadosFCM,
              signingSecret
            });
          }
        } else {
          if (solicitante) {
            await emitirNotificacaoBackend({
              db,
              admin,
              usuariosSnap,
              usuariosAlvo: solicitante,
              titulo: 'Pedido de troca recusado',
              descricao: `${quemRecusou} recusou seu pedido de troca da função ${tarefaOrigemNotif.nome} do dia ${dataHumana}.`,
              tipo: 'swap-fail',
              meta: { tarefa: tarefaOrigemNotif.nome, tarefaId },
              hasTesourariaPrivilege,
              enviarMulticastEmLotes,
              sanitizarDadosFCM,
              signingSecret
            });
          }
          await emitirNotificacaoBackend({
            db,
            admin,
            usuariosSnap,
            usuariosAlvo: 'Admin',
            titulo: 'Troca recusada',
            descricao: `${quemRecusou} recusou o pedido de troca de ${solicitante} para a função ${tarefaOrigemNotif.nome} do dia ${dataCurta}.`,
            tipo: 'swap-fail',
            meta: { tarefa: tarefaOrigemNotif.nome, tarefaId },
            hasTesourariaPrivilege,
            enviarMulticastEmLotes,
            sanitizarDadosFCM,
            signingSecret
          });
        }

        if (typeof sincronizarGoogleCalendarAfetados === 'function') {
          sincronizarGoogleCalendarAfetados({
            scope: 'trocas',
            affectedNames: [solicitante, destino].filter(Boolean)
          }).catch(() => {});
        }

        return res.status(200).json({
          ok: true,
          titulo: 'Troca recusada',
          mensagem: `O pedido de ${solicitante || 'membro'} para "${tarefaOrigemNotif.nome || 'Escala'}" foi recusado.`,
          rota: rotaPadrao
        });
      }

      return res.status(400).json({
        ok: false,
        titulo: 'Ação desconhecida',
        mensagem: 'Esta ação não é suportada pelo servidor.'
      });
    } catch (err) {
      console.error('🚨 Erro em /notificacoes/acao-rapida:', err);
      return res.status(500).json({
        ok: false,
        titulo: 'Erro ao processar',
        mensagem: err.message || 'Falha interna ao executar ação rápida.'
      });
    }
  });
}

async function emitNotificationPairMediacao({
  db,
  admin,
  usuariosSnap,
  nomeCanonicalSolicitante,
  nomeCanonicalDestino,
  adminLabel,
  tarefaOrigemNotif,
  dataHumana,
  hasTesourariaPrivilege,
  enviarMulticastEmLotes,
  sanitizarDadosFCM,
  signingSecret
}) {
  if (nomeCanonicalSolicitante) {
    await emitirNotificacaoBackend({
      db,
      admin,
      usuariosSnap,
      usuariosAlvo: nomeCanonicalSolicitante,
      titulo: 'Substituição definida pela liderança',
      descricao: `${adminLabel} escalou ${nomeCanonicalDestino} em seu lugar na função ${tarefaOrigemNotif.nome} do dia ${dataHumana}.`,
      tipo: 'swap-success',
      meta: { tarefa: tarefaOrigemNotif.nome, tarefaId: tarefaOrigemNotif.id || null },
      hasTesourariaPrivilege,
      enviarMulticastEmLotes,
      sanitizarDadosFCM,
      signingSecret
    });
  }
  if (nomeCanonicalDestino && nomeCanonicalDestino !== nomeCanonicalSolicitante) {
    await emitirNotificacaoBackend({
      db,
      admin,
      usuariosSnap,
      usuariosAlvo: nomeCanonicalDestino,
      titulo: 'Nova escala definida pela liderança',
      descricao: `${adminLabel} escalou você no lugar de ${nomeCanonicalSolicitante} na função ${tarefaOrigemNotif.nome} do dia ${dataHumana}.`,
      tipo: 'swap-success',
      meta: { tarefa: tarefaOrigemNotif.nome, tarefaId: tarefaOrigemNotif.id || null, data: tarefaOrigemNotif.data || null },
      hasTesourariaPrivilege,
      enviarMulticastEmLotes,
      sanitizarDadosFCM,
      signingSecret
    });
  }
}

async function emitNotificationTrocaDiretaAceita({
  db,
  admin,
  usuariosSnap,
  nomeCanonicalSolicitante,
  nomeCanonicalDestino,
  tarefaOrigemNotif,
  dataHumana,
  dataCurta,
  dataContrapartidaCurta,
  hasTesourariaPrivilege,
  enviarMulticastEmLotes,
  sanitizarDadosFCM,
  signingSecret
}) {
  if (nomeCanonicalSolicitante) {
    await emitirNotificacaoBackend({
      db,
      admin,
      usuariosSnap,
      usuariosAlvo: nomeCanonicalSolicitante,
      titulo: 'Troca confirmada',
      descricao: dataContrapartidaCurta
        ? `${nomeCanonicalDestino} aceitou trocar a escala com você. Ele assume ${tarefaOrigemNotif.nome} no dia ${dataCurta} e você assume a escala do dia ${dataContrapartidaCurta}.`
        : `${nomeCanonicalDestino} aceitou assumir sua escala de ${tarefaOrigemNotif.nome} no dia ${dataHumana}.`,
      tipo: 'swap-success',
      meta: { tarefa: tarefaOrigemNotif.nome, tarefaId: tarefaOrigemNotif.id || null },
      hasTesourariaPrivilege,
      enviarMulticastEmLotes,
      sanitizarDadosFCM,
      signingSecret
    });
  }
  if (nomeCanonicalDestino) {
    await emitirNotificacaoBackend({
      db,
      admin,
      usuariosSnap,
      usuariosAlvo: nomeCanonicalDestino,
      titulo: 'Escala confirmada',
      descricao: dataContrapartidaCurta
        ? `Troca confirmada com ${nomeCanonicalSolicitante}. Você assume ${tarefaOrigemNotif.nome} no dia ${dataCurta} e ${nomeCanonicalSolicitante} assume sua escala do dia ${dataContrapartidaCurta}.`
        : `Você confirmou que vai assumir a escala de ${tarefaOrigemNotif.nome} no dia ${dataHumana}.`,
      tipo: 'swap-success',
      meta: { tarefa: tarefaOrigemNotif.nome, tarefaId: tarefaOrigemNotif.id || null, data: tarefaOrigemNotif.data || null },
      hasTesourariaPrivilege,
      enviarMulticastEmLotes,
      sanitizarDadosFCM,
      signingSecret
    });
  }
  await emitirNotificacaoBackend({
    db,
    admin,
    usuariosSnap,
    usuariosAlvo: 'Admin',
    titulo: 'Troca concluída',
    descricao: `${nomeCanonicalDestino} aceitou o pedido de troca de ${nomeCanonicalSolicitante} na função ${tarefaOrigemNotif.nome} do dia ${dataCurta}.`,
    tipo: 'swap-success',
    meta: { tarefa: tarefaOrigemNotif.nome, tarefaId: tarefaOrigemNotif.id || null, data: tarefaOrigemNotif.data || null },
    hasTesourariaPrivilege,
    enviarMulticastEmLotes,
    sanitizarDadosFCM,
    signingSecret
  });
}

module.exports = {
  CANAIS_NOTIFICACAO,
  INVALID_FCM_ERROR_CODES,
  obterEstiloNotificacao,
  obterRotaPadraoNotificacao,
  resolverSigningSecret,
  gerarActionToken,
  verificarActionToken,
  montarAcoesParaUsuario,
  extrairTokensInvalidosDeResposta,
  podarTokensInvalidos,
  enviarPushInteligente,
  registerNotificationActionRoutes
};
