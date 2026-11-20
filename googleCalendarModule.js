const crypto = require('crypto');

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// Escopo não-sensível: cria e gerencia apenas a sub-agenda "Agenda Renovar" criada pelo app,
// sem acessar compromissos pessoais da agenda principal do usuário.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

const ALLOWED_FRONTEND_ORIGINS = new Set([
  'https://agenda-renovar.web.app',
  'https://agenda-renovar.firebaseapp.com',
  'http://localhost:5173',
  'http://localhost:4173'
]);

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PREFIXOS_CARGO_REGEX = /^(pr|pra|diac|miss|tes|sec)\s+/i;

const GOOGLE_EVENT_COLORS = {
  ESCALA_MINHA: '10',       // Verde (Basil)
  ESCALA_GERAL: '9',        // Azul (Blueberry)
  TROCA_PENDENTE: '6',      // Laranja (Tangerine)
  AVISO: '3',               // Roxo (Grape)
  TESOURARIA_PAGAR: '11',   // Vermelho (Tomato) — saídas pendentes e atrasados
  TESOURARIA_RECEBER: '5'   // Amarelo (Banana) — entradas pendentes no prazo
};

function normalizarTexto(str) {
  if (typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isGoogleOAuthConfigured() {
  return Boolean(
    typeof process.env.GOOGLE_CLIENT_ID === 'string' &&
    process.env.GOOGLE_CLIENT_ID.trim() &&
    typeof process.env.GOOGLE_CLIENT_SECRET === 'string' &&
    process.env.GOOGLE_CLIENT_SECRET.trim()
  );
}

function getGoogleRedirectUri() {
  return (
    (process.env.GOOGLE_REDIRECT_URI || '').trim() ||
    'https://agenda-renovar-backend.onrender.com/auth/google/callback'
  );
}

function getDefaultFrontendUrl() {
  return (process.env.FRONTEND_URL || '').trim() || 'https://agenda-renovar.web.app';
}

function sanitizeReturnTo(rawReturnTo) {
  const fallback = `${getDefaultFrontendUrl()}/configuracoes`;
  if (typeof rawReturnTo !== 'string' || !rawReturnTo.trim()) return fallback;
  try {
    const parsed = new URL(rawReturnTo.trim());
    if (!ALLOWED_FRONTEND_ORIGINS.has(parsed.origin)) {
      return fallback;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return fallback;
  }
}

function getUserCapabilities(userData) {
  const isAdmin = Boolean(
    userData && (userData.admin === true || String(userData.role || '').toLowerCase() === 'admin')
  );
  const roleNorm = normalizarTexto(userData?.role || '');
  const canSyncTesouraria = Boolean(
    isAdmin ||
    userData?.tesouraria === true ||
    roleNorm.includes('pastor') ||
    roleNorm.includes('tesoureir')
  );
  const canSyncAvisos = Boolean(isAdmin || roleNorm.includes('secretar'));

  return {
    isAdmin,
    canSyncTesouraria,
    canSyncAvisos
  };
}

function gerarIdentificadoresUsuario(userData) {
  const nomes = new Set();
  const adicionar = (val) => {
    const norm = normalizarTexto(val);
    if (!norm) return;
    nomes.add(norm);
    const semPrefixo = norm.replace(PREFIXOS_CARGO_REGEX, '').trim();
    if (semPrefixo) nomes.add(semPrefixo);
  };

  if (userData?.nome) {
    adicionar(userData.nome);
    const partes = String(userData.nome).trim().split(/\s+/);
    if (partes.length >= 2) {
      adicionar(`${partes[0]} ${partes[partes.length - 1]}`);
      adicionar(`${partes[0]} ${partes[1][0]}.`);
      adicionar(`${partes[0]} ${partes[1][0]}`);
    }
  }
  if (userData?.apelido) {
    adicionar(userData.apelido);
  }
  return nomes;
}

function usuarioBateComNome(identificadores, candidato) {
  const norm = normalizarTexto(candidato);
  if (!norm) return false;
  if (identificadores.has(norm)) return true;
  const semPrefixo = norm.replace(PREFIXOS_CARGO_REGEX, '').trim();
  return Boolean(semPrefixo && identificadores.has(semPrefixo));
}

const ABREVIACOES_ESCALA_PERMITIDAS = {
  'Diácono(a)': 'Diac.',
  'Pastor(a)': 'Pr.',
  'Missionário(a)': 'Miss.'
};

/**
 * Formata nome de exibição para escalas:
 * - Sempre usa apelido (ou primeiro nome se não houver apelido)
 * - Prefixa abreviação APENAS para Pastor(a), Diácono(a) e Missionário(a).
 */
function formatarNomeEscalado(user) {
  if (!user || typeof user !== 'object') return '';
  const nome = typeof user.nome === 'string' ? user.nome.trim() : '';
  const apelido = typeof user.apelido === 'string' ? user.apelido.trim() : '';
  const cleanRole = typeof user.role === 'string' ? user.role.trim() : '';

  let prefixo = ABREVIACOES_ESCALA_PERMITIDAS[cleanRole] || '';
  let nomeExibicao = apelido || (nome ? nome.split(/\s+/)[0] : '');

  if (cleanRole === 'Pastor(a)' && nomeExibicao) {
    prefixo = nomeExibicao.toLowerCase().endsWith('a') ? 'Pra.' : 'Pr.';
  }

  if (!prefixo) {
    return nomeExibicao.replace(/^(tes|sec)\.?\s+/i, '').trim();
  }

  if (!apelido && nome) {
    const pLower = prefixo.toLowerCase();
    const pSemPonto = pLower.slice(0, -1);
    const nLower = nome.toLowerCase();
    if (nLower.startsWith(pLower) || nLower.startsWith(`${pSemPonto} `)) {
      const parts = nome.split(/\s+/);
      nomeExibicao = parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts[0];
    }
  }

  const pLower = prefixo.toLowerCase();
  const pSemPonto = pLower.slice(0, -1);
  const currLower = nomeExibicao.toLowerCase();
  if (currLower.startsWith(pLower) || currLower.startsWith(`${pSemPonto} `)) {
    return nomeExibicao;
  }

  return `${prefixo} ${nomeExibicao}`;
}

function resolverNomeEscalado(rawName, usuarios = []) {
  const texto = String(rawName || '').trim();
  if (!texto) return '';
  for (const u of usuarios || []) {
    const ids = gerarIdentificadoresUsuario(u);
    if (usuarioBateComNome(ids, texto)) {
      const formatado = formatarNomeEscalado(u);
      if (formatado) return formatado;
    }
  }
  const semTesSec = texto.replace(/^(tes|sec)\.?\s+/i, '').trim();
  const parts = semTesSec.split(/\s+/);
  if (/^(pr|pra|diac|miss)\.?$/i.test(parts[0]) && parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0] || semTesSec;
}

function usuarioEstaEscaladoNaTarefa(t, identificadores, userId) {
  if (!t || typeof t !== 'object') return false;
  if (userId && Array.isArray(t.usuariosUids) && t.usuariosUids.includes(userId)) {
    return true;
  }
  if (Array.isArray(t.usuarios) && t.usuarios.some((u) => usuarioBateComNome(identificadores, u))) {
    return true;
  }
  return false;
}

function getEndOfWeekISO(isoDate) {
  if (!ISO_DATE_REGEX.test(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay(); // 0=Dom..6=Sab
  const diff = day === 0 ? 0 : 7 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function tarefaEstaAtiva(t, minDateStr, maxDateStr) {
  if (!t || typeof t !== 'object') return false;
  if (t.prioridade === 'evento' || t.prioridade === 'importante') return false;
  if (typeof t.data !== 'string' || !ISO_DATE_REGEX.test(t.data)) return false;
  if (maxDateStr && t.data > maxDateStr) return false;
  if (!minDateStr) return true;
  if (t.data >= minDateStr) return true;
  if (t.nome === 'Limpar a Igreja') {
    return getEndOfWeekISO(t.data) >= minDateStr;
  }
  return false;
}

function gerarEventIdGoogle(chave) {
  // Google Calendar API exige [a-v0-9] minúsculo entre 5 e 1024 caracteres; hex ([a-f0-9]) é subconjunto válido.
  const hash = crypto.createHash('sha256').update(String(chave)).digest('hex');
  return `ar${hash.slice(0, 30)}`;
}

function calcularProximoDiaISO(isoDate) {
  if (!ISO_DATE_REGEX.test(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function calcularHoraFim(isoDate, horaStr, duracaoMinutos = 120) {
  const match = String(horaStr || '').trim().match(TIME_HHMM_REGEX);
  if (!match) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const startUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const endUtc = new Date(startUtc + duracaoMinutos * 60 * 1000);
  const ey = endUtc.getUTCFullYear();
  const em = String(endUtc.getUTCMonth() + 1).padStart(2, '0');
  const ed = String(endUtc.getUTCDate()).padStart(2, '0');
  const eh = String(endUtc.getUTCHours()).padStart(2, '0');
  const emin = String(endUtc.getUTCMinutes()).padStart(2, '0');
  return {
    startDateTime: `${isoDate}T${match[1]}:${match[2]}:00-03:00`,
    endDateTime: `${ey}-${em}-${ed}T${eh}:${emin}:00-03:00`
  };
}

function montarIntervaloEvento(isoDate, horaStr, diaTodo = false, duracaoMinutos = 120) {
  if (!ISO_DATE_REGEX.test(isoDate)) return null;
  if (!diaTodo && horaStr && TIME_HHMM_REGEX.test(String(horaStr).trim())) {
    const intervalo = calcularHoraFim(isoDate, String(horaStr).trim(), duracaoMinutos);
    if (intervalo) {
      return {
        start: { dateTime: intervalo.startDateTime, timeZone: 'America/Sao_Paulo' },
        end: { dateTime: intervalo.endDateTime, timeZone: 'America/Sao_Paulo' }
      };
    }
  }
  return {
    start: { date: isoDate },
    end: { date: calcularProximoDiaISO(isoDate) }
  };
}

function formatarMoedaBRL(valor) {
  const n = Number(valor);
  const seguro = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(seguro)
    .replace(/\u00a0/g, ' ');
}

function criarPayloadEvento({ id, kind, summary, description, start, end, remindersOverrides, colorId }) {
  const baseForHash = JSON.stringify({ summary, description, start, end, kind, colorId: colorId || null });
  const contentHash = crypto.createHash('sha1').update(baseForHash).digest('hex').slice(0, 20);

  return {
    id,
    summary: String(summary || 'Agenda Renovar').slice(0, 250),
    description: String(description || '').slice(0, 4000),
    start,
    end,
    ...(colorId ? { colorId: String(colorId) } : {}),
    reminders: {
      useDefault: false,
      overrides: remindersOverrides || [
        { method: 'popup', minutes: 24 * 60 },
        { method: 'popup', minutes: 120 }
      ]
    },
    extendedProperties: {
      private: {
        agendaRenovarManaged: 'true',
        agendaRenovarKind: kind,
        agendaRenovarHash: contentHash
      }
    }
  };
}

/**
 * Constrói a lista determinística de eventos Google Calendar para um usuário
 * de acordo com o cargo (Membro, Secretário, Tesoureiro, Admin) e preferências.
 */
function construirEventosParaUsuario({
  userData,
  userId = null,
  preferences,
  usuarios = [],
  eventos = [],
  tarefas = [],
  avisos = [],
  transacoesPendentes = [],
  hojeStr,
  minDateStr,
  maxDateStr
}) {
  const caps = getUserCapabilities(userData);
  const mode = caps.isAdmin && preferences?.mode === 'completo' ? 'completo' : 'simples';
  const incluirTudoAdmin = caps.isAdmin && mode === 'completo';
  const incluirTesouraria =
    incluirTudoAdmin || (caps.canSyncTesouraria && preferences?.syncTesouraria === true);
  const incluirAvisos =
    incluirTudoAdmin || (caps.canSyncAvisos && preferences?.syncAvisos === true);

  const resolvedUserId = userId || userData?.id || userData?.uid || null;
  const identificadores = gerarIdentificadoresUsuario(userData);
  const dataMinimaEscala = minDateStr || hojeStr || null;
  const dentroJanela = (iso) =>
    typeof iso === 'string' &&
    ISO_DATE_REGEX.test(iso) &&
    (!dataMinimaEscala || iso >= dataMinimaEscala) &&
    (!maxDateStr || iso <= maxDateStr);

  const eventosById = new Map();
  for (const ev of eventos || []) {
    if (ev?.id) eventosById.set(ev.id, ev);
  }

  const mapaEventos = new Map();

  // 1. ESCALAS / TAREFAS
  // Nota: Igual ao AdminDashboard e UserDashboard, eventos são construídos apenas a partir de tarefas ativas
  // (docs órfãos na coleção `eventos` sem nenhuma tarefa vinculada nunca são sincronizados).
  if (incluirTudoAdmin) {
    // Modo Completo (Admin): todos os eventos com tarefas ativas + lista de escalados + destaque se o Admin estiver escalado
    const grupos = new Map();

    for (const t of tarefas) {
      if (!tarefaEstaAtiva(t, dataMinimaEscala, maxDateStr)) continue;
      const evReal = t.eventoId ? eventosById.get(t.eventoId) : null;
      const chave = t.eventoId || `legado_${t.data}_${t.eventoNome || t.nome || t.id}`;
      if (!grupos.has(chave)) {
        grupos.set(chave, {
          key: chave,
          eventoNome: evReal?.nome || t.eventoNome || t.nome || 'Culto / Evento',
          data: evReal?.data || t.data,
          hora: evReal?.hora || t.hora || t.eventoHora || '',
          local: evReal?.local || '',
          linhasTarefas: [],
          minhasFuncoes: []
        });
      }
      const g = grupos.get(chave);
      if (!g.hora) g.hora = evReal?.hora || t.hora || t.eventoHora || '';
      const nomeFuncao = t.nome || 'Função';
      const escalados = Array.isArray(t.usuarios) && t.usuarios.length > 0
        ? t.usuarios.map((u) => resolverNomeEscalado(u, usuarios)).join(', ')
        : 'Sem escalados';
      g.linhasTarefas.push(`• ${nomeFuncao}: ${escalados}`);

      if (usuarioEstaEscaladoNaTarefa(t, identificadores, resolvedUserId)) {
        if (!g.minhasFuncoes.includes(nomeFuncao)) {
          g.minhasFuncoes.push(nomeFuncao);
        }
      }
    }

    for (const g of grupos.values()) {
      const intervalo = montarIntervaloEvento(g.data, g.hora, false, 120);
      if (!intervalo) continue;
      const id = gerarEventIdGoogle(`admin_evento_${g.key}`);
      const estouEscalado = g.minhasFuncoes.length > 0;
      const summary = estouEscalado
        ? `⛪ ${g.eventoNome} — Sua tarefa: ${g.minhasFuncoes.join(', ')}`
        : `⛪ ${g.eventoNome} (Escala Geral)`;

      const descPartes = [
        estouEscalado ? `⭐ SUA TAREFA: ${g.minhasFuncoes.join(', ')}` : null,
        `Evento: ${g.eventoNome}`,
        g.hora ? `Horário: ${g.hora}` : null,
        g.local ? `Local: ${g.local}` : null,
        g.linhasTarefas.length > 0 ? `\nEscalados:\n${g.linhasTarefas.join('\n')}` : null,
        '\nSincronizado automaticamente pelo Agenda Renovar (Modo Completo).'
      ].filter(Boolean);

      mapaEventos.set(
        id,
        criarPayloadEvento({
          id,
          kind: estouEscalado ? 'escala-admin-escalado' : 'escala-geral',
          summary,
          description: descPartes.join('\n'),
          start: intervalo.start,
          end: intervalo.end,
          colorId: estouEscalado ? GOOGLE_EVENT_COLORS.ESCALA_MINHA : GOOGLE_EVENT_COLORS.ESCALA_GERAL
        })
      );
    }
  } else {
    // Modo Simples (Membro, Secretário, Tesoureiro ou Admin no modo simples): apenas tarefas do próprio usuário
    const gruposPessoais = new Map();

    for (const t of tarefas) {
      if (!tarefaEstaAtiva(t, dataMinimaEscala, maxDateStr)) continue;
      if (!usuarioEstaEscaladoNaTarefa(t, identificadores, resolvedUserId)) continue;

      const evReal = t.eventoId ? eventosById.get(t.eventoId) : null;
      const evNome = evReal?.nome || t.eventoNome || t.nome || 'Culto / Evento';
      const evData = evReal?.data || t.data;
      const evHora = t.hora || t.eventoHora || evReal?.hora || '';
      const chave = `${t.eventoId || evNome}_${evData}_${evHora}`;

      if (!gruposPessoais.has(chave)) {
        gruposPessoais.set(chave, {
          key: chave,
          eventoNome: evNome,
          data: evData,
          hora: evHora,
          local: evReal?.local || '',
          funcoes: []
        });
      }
      const g = gruposPessoais.get(chave);
      if (t.nome && !g.funcoes.includes(t.nome)) {
        g.funcoes.push(t.nome);
      }
    }

    for (const g of gruposPessoais.values()) {
      const intervalo = montarIntervaloEvento(g.data, g.hora, false, 120);
      if (!intervalo) continue;
      const id = gerarEventIdGoogle(`minha_escala_${g.key}`);
      const funcoesStr = g.funcoes.join(', ') || 'Escala';
      const desc = [
        `⭐ Sua tarefa: ${funcoesStr}`,
        `Evento: ${g.eventoNome}`,
        g.hora ? `Horário: ${g.hora}` : null,
        g.local ? `Local: ${g.local}` : null,
        '\nSincronizado automaticamente pelo Agenda Renovar.'
      ]
        .filter(Boolean)
        .join('\n');

      mapaEventos.set(
        id,
        criarPayloadEvento({
          id,
          kind: 'escala-pessoal',
          summary: `⛪ ${g.eventoNome} — Sua tarefa: ${funcoesStr}`,
          description: desc,
          start: intervalo.start,
          end: intervalo.end,
          colorId: GOOGLE_EVENT_COLORS.ESCALA_MINHA
        })
      );
    }
  }

  // 2. PEDIDOS DE TROCA PENDENTES
  for (const t of tarefas) {
    if (t.status !== 'Troca Pendente') continue;
    if (!tarefaEstaAtiva(t, dataMinimaEscala, maxDateStr)) continue;
    const solicitantes = Array.isArray(t.solicitantes) ? t.solicitantes : [];
    const evReal = t.eventoId ? eventosById.get(t.eventoId) : null;
    const evNome = evReal?.nome || t.eventoNome || 'Evento';
    const evHora = t.hora || t.eventoHora || evReal?.hora || '';

    for (const s of solicitantes) {
      const solicitanteNome = s?.nome || 'Membro';
      const destinoNome = s?.destino || 'Admin';
      const pertenceAoUsuario =
        usuarioBateComNome(identificadores, destinoNome) ||
        usuarioBateComNome(identificadores, solicitanteNome);

      const deveIncluirTroca = incluirTudoAdmin || pertenceAoUsuario;
      if (!deveIncluirTroca) continue;

      const intervalo = montarIntervaloEvento(t.data, evHora, false, 60);
      if (!intervalo) continue;
      const id = gerarEventIdGoogle(`troca_${t.id || t.nome}_${s?.idTroca || solicitanteNome}_${destinoNome}`);
      const ehDestino = usuarioBateComNome(identificadores, destinoNome);
      const solDisplay = resolverNomeEscalado(solicitanteNome, usuarios);
      const destDisplay = /^admin$/i.test(String(destinoNome).trim())
        ? 'Admin'
        : resolverNomeEscalado(destinoNome, usuarios);
      const papelDesc = ehDestino
        ? `${solDisplay} solicitou troca com você. Abra o Agenda Renovar para aceitar ou recusar.`
        : `Pedido de troca de ${solDisplay} para ${destDisplay} aguardando resposta.`;

      mapaEventos.set(
        id,
        criarPayloadEvento({
          id,
          kind: 'troca-pendente',
          summary: `🔄 [Troca Pendente] ${t.nome || 'Escala'} — ${evNome}`,
          description: `${papelDesc}\n\nFunção: ${t.nome || 'Escala'}\nEvento: ${evNome}\n\nSincronizado pelo Agenda Renovar.`,
          start: intervalo.start,
          end: intervalo.end,
          colorId: GOOGLE_EVENT_COLORS.TROCA_PENDENTE,
          remindersOverrides: [{ method: 'popup', minutes: 12 * 60 }]
        })
      );
    }
  }

  // 3. CAIXA DE AVISOS (Secretário com vínculo ativo ou Admin no Modo Completo)
  if (incluirAvisos) {
    for (const av of avisos) {
      const dataAviso = typeof av.data === 'string' && ISO_DATE_REGEX.test(av.data) ? av.data : null;
      if (!dataAviso || !dentroJanela(dataAviso)) continue;

      const intervalo = montarIntervaloEvento(dataAviso, av.hora, Boolean(av.diaTodo), 60);
      if (!intervalo) continue;
      const id = gerarEventIdGoogle(`aviso_${av.id || `${av.titulo}_${dataAviso}`}`);
      const desc = [
        av.descricao || '',
        av.fixado ? '\n📌 Aviso fixado na Caixa de Avisos.' : null,
        '\nSincronizado da Caixa de Avisos — Agenda Renovar.'
      ]
        .filter(Boolean)
        .join('\n');

      mapaEventos.set(
        id,
        criarPayloadEvento({
          id,
          kind: 'aviso',
          summary: `📢 [Aviso] ${av.titulo || 'Comunicado da Igreja'}`,
          description: desc,
          start: intervalo.start,
          end: intervalo.end,
          colorId: GOOGLE_EVENT_COLORS.AVISO,
          remindersOverrides: [{ method: 'popup', minutes: 24 * 60 }]
        })
      );
    }
  }

  // 4. TESOURARIA — LANÇAMENTOS PENDENTES (Tesoureiro com vínculo ativo ou Admin no Modo Completo)
  if (incluirTesouraria) {
    for (const tx of transacoesPendentes) {
      if (tx.status !== 'pendente') continue;
      const dataRef =
        typeof tx.dueDate === 'string' && ISO_DATE_REGEX.test(tx.dueDate)
          ? tx.dueDate
          : typeof tx.date === 'string' && ISO_DATE_REGEX.test(tx.date)
          ? tx.date
          : null;
      if (!dataRef) continue;
      // Para Tesouraria, inclui também atrasados recentes (até 60 dias atrás) e futuros até maxDateStr
      if (maxDateStr && dataRef > maxDateStr) continue;

      const intervalo = montarIntervaloEvento(dataRef, null, true);
      if (!intervalo) continue;

      const isSaida = tx.type === 'saida';
      const valorFmt = formatarMoedaBRL(tx.amount);
      const atrasado = Boolean(hojeStr && dataRef < hojeStr);
      const id = gerarEventIdGoogle(`tesouraria_${tx.id || `${tx.description}_${dataRef}`}`);
      const prefixo = atrasado
        ? '🚨 [Atrasado]'
        : isSaida
        ? '💰 [Pagar]'
        : '💵 [Receber]';

      const reminderDays =
        typeof tx.reminderDaysBefore === 'number' && Number.isInteger(tx.reminderDaysBefore)
          ? tx.reminderDaysBefore
          : 3;
      const remindersOverrides =
        reminderDays < 0
          ? []
          : reminderDays === 0
          ? [{ method: 'popup', minutes: 0 }]
          : [
              { method: 'popup', minutes: reminderDays * 24 * 60 },
              { method: 'popup', minutes: 24 * 60 }
            ];

      const desc = [
        `${isSaida ? 'Saída / Conta a Pagar' : 'Entrada Pendente'}: ${tx.description || 'Lançamento'}`,
        `Valor: ${valorFmt}`,
        tx.category ? `Categoria: ${tx.category}` : null,
        tx.memberName ? `Membro: ${tx.memberName}` : null,
        tx.notes ? `Observações: ${tx.notes}` : null,
        '\nStatus: Pendente na Tesouraria — Agenda Renovar.'
      ]
        .filter(Boolean)
        .join('\n');

      mapaEventos.set(
        id,
        criarPayloadEvento({
          id,
          kind: 'tesouraria-pendente',
          summary: `${prefixo} ${tx.description || 'Lançamento'} (${valorFmt})`,
          description: desc,
          start: intervalo.start,
          end: intervalo.end,
          colorId: (isSaida || atrasado)
            ? GOOGLE_EVENT_COLORS.TESOURARIA_PAGAR
            : GOOGLE_EVENT_COLORS.TESOURARIA_RECEBER,
          remindersOverrides
        })
      );
    }
  }

  return Array.from(mapaEventos.values());
}

async function resolveUsuarioDoc(db, decodedUser) {
  const byUidRef = db.collection('usuarios').doc(decodedUser.uid);
  const byUidSnap = await byUidRef.get();
  if (byUidSnap.exists) {
    return { ref: byUidRef, id: byUidSnap.id, data: byUidSnap.data() };
  }
  if (decodedUser.email) {
    const byEmailSnap = await db
      .collection('usuarios')
      .where('email', '==', decodedUser.email)
      .limit(1)
      .get();
    if (!byEmailSnap.empty) {
      const doc = byEmailSnap.docs[0];
      return { ref: doc.ref, id: doc.id, data: doc.data() };
    }
  }
  return null;
}

async function trocarRefreshTokenPorAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID.trim(),
    client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    const errCode = json.error || `HTTP_${resp.status}`;
    const err = new Error(`Falha ao renovar token Google (${errCode}): ${json.error_description || ''}`);
    err.googleError = errCode;
    throw err;
  }

  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000
  };
}

async function obterAccessTokenValido(db, userDocId) {
  const tokenRef = db.collection('usuarios_google_tokens').doc(userDocId);
  const snap = await tokenRef.get();
  if (!snap.exists) {
    throw new Error('Conta Google não vinculada.');
  }
  const tokenData = snap.data();

  if (tokenData.accessToken && tokenData.expiresAt && tokenData.expiresAt > Date.now() + 60 * 1000) {
    return { accessToken: tokenData.accessToken, tokenData, tokenRef };
  }

  if (!tokenData.refreshToken) {
    throw new Error('Refresh token ausente. Reconecte sua conta Google.');
  }

  const renovado = await trocarRefreshTokenPorAccessToken(tokenData.refreshToken);
  await tokenRef.set(
    {
      accessToken: renovado.accessToken,
      expiresAt: renovado.expiresAt,
      updatedAt: new Date().toISOString()
    },
    { merge: true }
  );

  return {
    accessToken: renovado.accessToken,
    tokenData: { ...tokenData, ...renovado },
    tokenRef
  };
}

async function googleCalendarFetch(accessToken, path, options = {}) {
  const resp = await fetch(`${GOOGLE_CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

async function garantirCalendarioAgendaRenovar(accessToken, existingCalendarId, tokenRef, userRef) {
  if (existingCalendarId) {
    const check = await googleCalendarFetch(
      accessToken,
      `/calendars/${encodeURIComponent(existingCalendarId)}`,
      { method: 'GET' }
    );
    if (check.ok && check.json?.id) {
      return check.json.id;
    }
  }

  const created = await googleCalendarFetch(accessToken, '/calendars', {
    method: 'POST',
    body: JSON.stringify({
      summary: 'Agenda Renovar',
      description: 'Escalas, pedidos de troca, avisos e lembretes sincronizados automaticamente pelo Agenda Renovar.',
      timeZone: 'America/Sao_Paulo'
    })
  });

  if (!created.ok || !created.json?.id) {
    throw new Error(`Não foi possível criar o calendário "Agenda Renovar" (${created.status}).`);
  }

  const newCalendarId = created.json.id;
  await Promise.all([
    tokenRef.set({ calendarId: newCalendarId, updatedAt: new Date().toISOString() }, { merge: true }),
    userRef.set({ googleCalendar: { calendarId: newCalendarId } }, { merge: true })
  ]);

  return newCalendarId;
}

async function listarEventosGerenciados(accessToken, calendarId) {
  const items = [];
  let pageToken = null;

  do {
    const qs = new URLSearchParams({
      privateExtendedProperty: 'agendaRenovarManaged=true',
      maxResults: '250',
      singleEvents: 'false',
      showDeleted: 'false'
    });
    if (pageToken) qs.set('pageToken', pageToken);

    const resp = await googleCalendarFetch(
      accessToken,
      `/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
      { method: 'GET' }
    );

    if (!resp.ok) {
      throw new Error(`Erro ao listar eventos existentes no Google Calendar (${resp.status}).`);
    }

    if (Array.isArray(resp.json?.items)) {
      items.push(...resp.json.items);
    }
    pageToken = resp.json?.nextPageToken || null;
  } while (pageToken);

  return items;
}

async function carregarSnapshotAgenda(db, { precisarAvisos, precisarTesouraria }) {
  // `eventos` e `usuarios` são sempre carregados para enriquecer nome/horário e formatar apelido + cargo permitido.
  const queries = [
    db.collection('tarefas').get(),
    db.collection('eventos').get(),
    db.collection('usuarios').get()
  ];
  queries.push(precisarAvisos ? db.collection('avisos').get() : Promise.resolve(null));
  queries.push(
    precisarTesouraria
      ? db.collection('tesouraria_transacoes').where('status', '==', 'pendente').get()
      : Promise.resolve(null)
  );

  const [snapTarefas, snapEventos, snapUsuarios, snapAvisos, snapTx] = await Promise.all(queries);

  return {
    tarefas: snapTarefas ? snapTarefas.docs.map((d) => ({ id: d.id, ...d.data() })) : [],
    eventos: snapEventos ? snapEventos.docs.map((d) => ({ id: d.id, ...d.data() })) : [],
    usuarios: snapUsuarios ? snapUsuarios.docs.map((d) => ({ id: d.id, ...d.data() })) : [],
    avisos: snapAvisos ? snapAvisos.docs.map((d) => ({ id: d.id, ...d.data() })) : [],
    transacoesPendentes: snapTx ? snapTx.docs.map((d) => ({ id: d.id, ...d.data() })) : []
  };
}

function registerGoogleCalendarRoutes({
  app,
  admin,
  verificarAutenticacao,
  verificarAutorizacaoCron,
  getBrazilDateOffset
}) {
  async function sincronizarUsuario(db, userDocId, userData, userRef, sharedSnapshot = null) {
    const gc = userData?.googleCalendar || {};
    if (!gc.connected || gc.enabled === false) {
      return { ignorado: true, motivo: 'Integração desconectada ou desativada.' };
    }

    const caps = getUserCapabilities(userData);
    const mode = caps.isAdmin && gc.mode === 'completo' ? 'completo' : 'simples';
    const incluirTudoAdmin = caps.isAdmin && mode === 'completo';
    const incluirTesouraria =
      incluirTudoAdmin || (caps.canSyncTesouraria && gc.syncTesouraria === true);
    const incluirAvisos = incluirTudoAdmin || (caps.canSyncAvisos && gc.syncAvisos === true);

    try {
      const { accessToken, tokenData, tokenRef } = await obterAccessTokenValido(db, userDocId);
      const calendarId = await garantirCalendarioAgendaRenovar(
        accessToken,
        tokenData.calendarId || gc.calendarId,
        tokenRef,
        userRef
      );

      const snapshot =
        sharedSnapshot ||
        (await carregarSnapshotAgenda(db, {
          precisarAvisos: incluirAvisos,
          precisarTesouraria: incluirTesouraria
        }));

      const hojeStr = getBrazilDateOffset(0);
      const minDateStr = hojeStr;
      const maxDateStr = getBrazilDateOffset(120);

      const desejados = construirEventosParaUsuario({
        userData,
        userId: userDocId,
        preferences: { mode, syncTesouraria: incluirTesouraria, syncAvisos: incluirAvisos },
        ...snapshot,
        hojeStr,
        minDateStr,
        maxDateStr
      });

      const existentes = await listarEventosGerenciados(accessToken, calendarId);
      const mapExistentes = new Map(existentes.map((ev) => [ev.id, ev]));
      const idsDesejados = new Set(desejados.map((ev) => ev.id));

      let criados = 0;
      let atualizados = 0;
      let removidos = 0;

      for (const ev of desejados) {
        const atual = mapExistentes.get(ev.id);
        const hashNovo = ev.extendedProperties?.private?.agendaRenovarHash;
        const hashAtual = atual?.extendedProperties?.private?.agendaRenovarHash;

        if (atual && hashAtual === hashNovo) {
          continue;
        }

        if (atual) {
          const putResp = await googleCalendarFetch(
            accessToken,
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(ev.id)}`,
            { method: 'PUT', body: JSON.stringify(ev) }
          );
          if (putResp.ok) atualizados += 1;
        } else {
          const postResp = await googleCalendarFetch(
            accessToken,
            `/calendars/${encodeURIComponent(calendarId)}/events`,
            { method: 'POST', body: JSON.stringify(ev) }
          );
          if (postResp.ok) {
            criados += 1;
          } else if (postResp.status === 409) {
            // Evento já existiu e foi cancelado/removido no Google Calendar -> PUT restaura e atualiza
            const putResp = await googleCalendarFetch(
              accessToken,
              `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(ev.id)}`,
              { method: 'PUT', body: JSON.stringify({ ...ev, status: 'confirmed' }) }
            );
            if (putResp.ok) atualizados += 1;
          }
        }
      }

      for (const atual of existentes) {
        if (!idsDesejados.has(atual.id)) {
          const delResp = await googleCalendarFetch(
            accessToken,
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(atual.id)}`,
            { method: 'DELETE' }
          );
          if (delResp.ok || delResp.status === 404 || delResp.status === 410) {
            removidos += 1;
          }
        }
      }

      const nowIso = new Date().toISOString();
      await userRef.set(
        {
          googleCalendar: {
            ...gc,
            connected: true,
            enabled: true,
            calendarId,
            lastSyncAt: nowIso,
            lastSyncCount: desejados.length,
            lastSyncError: null
          }
        },
        { merge: true }
      );

      return { sucesso: true, criados, atualizados, removidos, total: desejados.length, lastSyncAt: nowIso };
    } catch (err) {
      const revoked = err.googleError === 'invalid_grant';
      await userRef
        .set(
          {
            googleCalendar: {
              ...gc,
              connected: revoked ? false : Boolean(gc.connected),
              enabled: revoked ? false : Boolean(gc.enabled),
              lastSyncError: String(err.message || 'Erro ao sincronizar').slice(0, 200)
            }
          },
          { merge: true }
        )
        .catch(() => {});
      throw err;
    }
  }

  // 1. Status e capacidades do usuário autenticado
  app.get('/google-calendar/status', verificarAutenticacao, async (req, res) => {
    try {
      const db = admin.firestore();
      const resolved = await resolveUsuarioDoc(db, req.user);
      if (!resolved) {
        return res.status(404).json({ erro: 'Perfil de usuário não encontrado.' });
      }
      const caps = getUserCapabilities(resolved.data);
      const gc = resolved.data.googleCalendar || {};

      return res.status(200).json({
        configured: isGoogleOAuthConfigured(),
        connected: Boolean(gc.connected),
        enabled: Boolean(gc.enabled),
        email: gc.email || null,
        mode: caps.isAdmin && gc.mode === 'completo' ? 'completo' : 'simples',
        syncTesouraria: caps.isAdmin && gc.mode === 'completo'
          ? true
          : Boolean(caps.canSyncTesouraria && gc.syncTesouraria),
        syncAvisos: caps.isAdmin && gc.mode === 'completo'
          ? true
          : Boolean(caps.canSyncAvisos && gc.syncAvisos),
        lastSyncAt: gc.lastSyncAt || null,
        lastSyncCount: typeof gc.lastSyncCount === 'number' ? gc.lastSyncCount : 0,
        lastSyncError: gc.lastSyncError || null,
        capabilities: caps
      });
    } catch (err) {
      console.error('❌ Erro em /google-calendar/status:', err);
      return res.status(500).json({ erro: 'Erro ao consultar status do Google Agenda.' });
    }
  });

  // 2. Inicia fluxo OAuth 2.0 (retorna URL oficial da Google)
  app.get('/auth/google/url', verificarAutenticacao, async (req, res) => {
    if (!isGoogleOAuthConfigured()) {
      return res.status(503).json({
        erro: 'Integração com Google Agenda ainda não configurada no servidor (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ausentes).'
      });
    }

    try {
      const db = admin.firestore();
      const resolved = await resolveUsuarioDoc(db, req.user);
      if (!resolved) {
        return res.status(404).json({ erro: 'Perfil de usuário não encontrado.' });
      }

      const returnTo = sanitizeReturnTo(req.query.returnTo);
      const state = crypto.randomBytes(24).toString('hex');

      await db.collection('google_oauth_states').doc(state).set({
        uid: req.user.uid,
        userDocId: resolved.id,
        returnTo,
        expiresAt: Date.now() + 10 * 60 * 1000,
        createdAt: new Date().toISOString()
      });

      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID.trim(),
        redirect_uri: getGoogleRedirectUri(),
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state
      });

      return res.status(200).json({ url: `${GOOGLE_AUTH_BASE}?${params.toString()}` });
    } catch (err) {
      console.error('❌ Erro ao gerar URL OAuth Google:', err);
      return res.status(500).json({ erro: 'Erro ao iniciar conexão com o Google.' });
    }
  });

  // 3. Callback OAuth 2.0 da Google
  app.get('/auth/google/callback', async (req, res) => {
    const db = admin.firestore();
    const { code, state, error } = req.query;
    const defaultRedirect = `${getDefaultFrontendUrl()}/configuracoes`;

    if (!state || typeof state !== 'string') {
      return res.redirect(`${defaultRedirect}?google_calendar=error&reason=missing_state`);
    }

    const stateRef = db.collection('google_oauth_states').doc(state);
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) {
      return res.redirect(`${defaultRedirect}?google_calendar=error&reason=invalid_state`);
    }

    const stateData = stateSnap.data();
    await stateRef.delete().catch(() => {});

    const returnTo = sanitizeReturnTo(stateData.returnTo);

    if (error) {
      return res.redirect(`${returnTo}?google_calendar=cancelled`);
    }

    if (!code || typeof code !== 'string' || Date.now() > Number(stateData.expiresAt || 0)) {
      return res.redirect(`${returnTo}?google_calendar=error&reason=expired`);
    }

    try {
      const tokenBody = new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID.trim(),
        client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
        redirect_uri: getGoogleRedirectUri(),
        grant_type: 'authorization_code'
      });

      const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString()
      });

      const tokenJson = await tokenResp.json().catch(() => ({}));
      if (!tokenResp.ok || !tokenJson.access_token) {
        console.error('❌ Erro ao trocar code por token Google:', tokenJson);
        return res.redirect(`${returnTo}?google_calendar=error&reason=token_exchange`);
      }

      const accessToken = tokenJson.access_token;
      const expiresAt = Date.now() + (Number(tokenJson.expires_in) || 3600) * 1000;

      // Recupera e-mail da conta Google conectada
      let googleEmail = null;
      try {
        const uResp = await fetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (uResp.ok) {
          const uJson = await uResp.json();
          googleEmail = uJson.email || null;
        }
      } catch {
        // E-mail é informativo; segue mesmo se falhar
      }

      const userRef = db.collection('usuarios').doc(stateData.userDocId);
      const tokenRef = db.collection('usuarios_google_tokens').doc(stateData.userDocId);
      const [userSnap, prevTokenSnap] = await Promise.all([userRef.get(), tokenRef.get()]);

      if (!userSnap.exists) {
        return res.redirect(`${returnTo}?google_calendar=error&reason=user_not_found`);
      }

      const userData = userSnap.data();
      const prevGc = userData.googleCalendar || {};
      const prevTokenData = prevTokenSnap.exists ? prevTokenSnap.data() : {};
      const refreshToken = tokenJson.refresh_token || prevTokenData.refreshToken || null;

      await tokenRef.set(
        {
          uid: stateData.uid,
          accessToken,
          refreshToken,
          expiresAt,
          email: googleEmail,
          calendarId: prevTokenData.calendarId || prevGc.calendarId || null,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );

      const calendarId = await garantirCalendarioAgendaRenovar(
        accessToken,
        prevTokenData.calendarId || prevGc.calendarId,
        tokenRef,
        userRef
      );

      const caps = getUserCapabilities(userData);
      const novoGoogleCalendar = {
        connected: true,
        enabled: true,
        email: googleEmail,
        mode: caps.isAdmin && prevGc.mode === 'completo' ? 'completo' : 'simples',
        syncTesouraria:
          typeof prevGc.syncTesouraria === 'boolean'
            ? prevGc.syncTesouraria && caps.canSyncTesouraria
            : caps.canSyncTesouraria && !caps.isAdmin,
        syncAvisos:
          typeof prevGc.syncAvisos === 'boolean'
            ? prevGc.syncAvisos && caps.canSyncAvisos
            : caps.canSyncAvisos && !caps.isAdmin,
        calendarId,
        lastSyncAt: prevGc.lastSyncAt || null,
        lastSyncCount: prevGc.lastSyncCount || 0,
        lastSyncError: null
      };

      await userRef.set({ googleCalendar: novoGoogleCalendar }, { merge: true });

      // Sincronização inicial imediata (best-effort para não bloquear o redirect por muito tempo)
      await sincronizarUsuario(
        db,
        stateData.userDocId,
        { ...userData, googleCalendar: novoGoogleCalendar },
        userRef
      ).catch((syncErr) => {
        console.warn('⚠️ Aviso na sincronização inicial pós-OAuth:', syncErr.message);
      });

      return res.redirect(`${returnTo}?google_calendar=connected`);
    } catch (err) {
      console.error('❌ Erro no callback OAuth Google:', err);
      return res.redirect(`${returnTo}?google_calendar=error&reason=internal`);
    }
  });

  // 4. Atualiza preferências (ativar/pausar, modo simples/completo, tesouraria, avisos)
  app.post('/google-calendar/preferences', verificarAutenticacao, async (req, res) => {
    try {
      const db = admin.firestore();
      const resolved = await resolveUsuarioDoc(db, req.user);
      if (!resolved) {
        return res.status(404).json({ erro: 'Perfil de usuário não encontrado.' });
      }

      const caps = getUserCapabilities(resolved.data);
      const prevGc = resolved.data.googleCalendar || {};
      const body = req.body || {};

      const enabled = typeof body.enabled === 'boolean' ? body.enabled : Boolean(prevGc.enabled);
      const requestedMode = body.mode === 'completo' ? 'completo' : 'simples';
      const mode = caps.isAdmin ? requestedMode : 'simples';

      const syncTesouraria =
        caps.isAdmin && mode === 'completo'
          ? true
          : caps.canSyncTesouraria
          ? typeof body.syncTesouraria === 'boolean'
            ? body.syncTesouraria
            : Boolean(prevGc.syncTesouraria)
          : false;

      const syncAvisos =
        caps.isAdmin && mode === 'completo'
          ? true
          : caps.canSyncAvisos
          ? typeof body.syncAvisos === 'boolean'
            ? body.syncAvisos
            : Boolean(prevGc.syncAvisos)
          : false;

      const updatedGc = {
        ...prevGc,
        enabled,
        mode,
        syncTesouraria,
        syncAvisos,
        lastSyncError: null
      };

      await resolved.ref.set({ googleCalendar: updatedGc }, { merge: true });

      let syncResult = null;
      if (updatedGc.connected && updatedGc.enabled && isGoogleOAuthConfigured()) {
        syncResult = await sincronizarUsuario(
          db,
          resolved.id,
          { ...resolved.data, googleCalendar: updatedGc },
          resolved.ref
        );
      }

      return res.status(200).json({
        sucesso: true,
        googleCalendar: {
          ...updatedGc,
          ...(syncResult?.lastSyncAt ? { lastSyncAt: syncResult.lastSyncAt } : {}),
          ...(typeof syncResult?.total === 'number' ? { lastSyncCount: syncResult.total } : {})
        },
        syncResult
      });
    } catch (err) {
      console.error('❌ Erro em /google-calendar/preferences:', err);
      return res.status(500).json({ erro: err.message || 'Erro ao salvar preferências.' });
    }
  });

  // 5. Sincronização manual imediata do usuário logado
  app.post('/google-calendar/sync', verificarAutenticacao, async (req, res) => {
    if (!isGoogleOAuthConfigured()) {
      return res.status(503).json({ erro: 'Google Agenda não configurado no servidor.' });
    }

    try {
      const db = admin.firestore();
      const resolved = await resolveUsuarioDoc(db, req.user);
      if (!resolved) {
        return res.status(404).json({ erro: 'Perfil de usuário não encontrado.' });
      }
      const result = await sincronizarUsuario(db, resolved.id, resolved.data, resolved.ref);
      return res.status(200).json(result);
    } catch (err) {
      console.error('❌ Erro em /google-calendar/sync:', err);
      return res.status(500).json({ erro: err.message || 'Erro ao sincronizar Google Agenda.' });
    }
  });

  async function sincronizarAfetadosInterno(db, { scope = 'all', affectedNames: rawAffectedNames = [] } = {}) {
    if (!isGoogleOAuthConfigured()) {
      return { sucesso: true, ignorado: true, motivo: 'Google OAuth não configurado.' };
    }

    const scopeStr = String(scope || 'all');
    const affectedNames = Array.isArray(rawAffectedNames)
      ? rawAffectedNames.map((n) => normalizarTexto(n)).filter(Boolean)
      : [];

    const snapUsuarios = await db
      .collection('usuarios')
      .where('googleCalendar.connected', '==', true)
      .get();

    const alvos = [];
    snapUsuarios.forEach((doc) => {
      const u = doc.data();
      const gc = u.googleCalendar || {};
      if (!gc.connected || gc.enabled === false) return;

      const caps = getUserCapabilities(u);
      const isAdminCompleto = caps.isAdmin && gc.mode === 'completo';

      if (scopeStr === 'tesouraria') {
        if (isAdminCompleto || (caps.canSyncTesouraria && gc.syncTesouraria)) {
          alvos.push({ id: doc.id, data: u, ref: doc.ref });
        }
        return;
      }
      if (scopeStr === 'avisos') {
        if (isAdminCompleto || (caps.canSyncAvisos && gc.syncAvisos)) {
          alvos.push({ id: doc.id, data: u, ref: doc.ref });
        }
        return;
      }
      if (scopeStr === 'escalas' || scopeStr === 'trocas') {
        if (isAdminCompleto || affectedNames.length === 0) {
          alvos.push({ id: doc.id, data: u, ref: doc.ref });
          return;
        }
        const idsUsuario = gerarIdentificadoresUsuario(u);
        if (affectedNames.some((n) => usuarioBateComNome(idsUsuario, n))) {
          alvos.push({ id: doc.id, data: u, ref: doc.ref });
        }
        return;
      }

      alvos.push({ id: doc.id, data: u, ref: doc.ref });
    });

    if (alvos.length === 0) {
      return { sucesso: true, sincronizados: 0, erros: 0 };
    }

    const sharedSnapshot = await carregarSnapshotAgenda(db, {
      precisarEventos: alvos.some((a) => getUserCapabilities(a.data).isAdmin && a.data.googleCalendar?.mode === 'completo'),
      precisarAvisos: alvos.some((a) => {
        const c = getUserCapabilities(a.data);
        return (c.isAdmin && a.data.googleCalendar?.mode === 'completo') || (c.canSyncAvisos && a.data.googleCalendar?.syncAvisos);
      }),
      precisarTesouraria: alvos.some((a) => {
        const c = getUserCapabilities(a.data);
        return (c.isAdmin && a.data.googleCalendar?.mode === 'completo') || (c.canSyncTesouraria && a.data.googleCalendar?.syncTesouraria);
      })
    });

    let sincronizados = 0;
    let erros = 0;
    const CONCURRENCY = 4;

    for (let i = 0; i < alvos.length; i += CONCURRENCY) {
      const batch = alvos.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((alvo) => sincronizarUsuario(db, alvo.id, alvo.data, alvo.ref, sharedSnapshot))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') sincronizados += 1;
        else erros += 1;
      }
    }

    return { sucesso: true, sincronizados, erros };
  }

  // 6. Gatilho automático quando escalas, trocas, avisos ou tesouraria são alterados no app
  app.post('/google-calendar/sync-affected', verificarAutenticacao, async (req, res) => {
    try {
      const db = admin.firestore();
      const result = await sincronizarAfetadosInterno(db, {
        scope: req.body?.scope || 'all',
        affectedNames: req.body?.affectedNames || []
      });
      if (result.ignorado) {
        return res.status(200).json(result);
      }
      return res.status(200).json(result);
    } catch (err) {
      console.error('❌ Erro em /google-calendar/sync-affected:', err);
      return res.status(500).json({ erro: 'Erro ao sincronizar agendas afetadas.' });
    }
  });

  // 7. Desvincular conta Google
  app.post('/google-calendar/disconnect', verificarAutenticacao, async (req, res) => {
    try {
      const db = admin.firestore();
      const resolved = await resolveUsuarioDoc(db, req.user);
      if (!resolved) {
        return res.status(404).json({ erro: 'Perfil de usuário não encontrado.' });
      }

      const tokenRef = db.collection('usuarios_google_tokens').doc(resolved.id);
      const tokenSnap = await tokenRef.get();

      if (tokenSnap.exists) {
        const tokenData = tokenSnap.data();
        // Best-effort: revoga token no Google
        const tokenParaRevogar = tokenData.refreshToken || tokenData.accessToken;
        if (tokenParaRevogar) {
          await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokenParaRevogar)}`, {
            method: 'POST'
          }).catch(() => {});
        }
        await tokenRef.delete().catch(() => {});
      }

      await resolved.ref.set(
        {
          googleCalendar: {
            connected: false,
            enabled: false,
            email: null,
            mode: 'simples',
            syncTesouraria: false,
            syncAvisos: false,
            calendarId: null,
            lastSyncAt: null,
            lastSyncCount: 0,
            lastSyncError: null
          }
        },
        { merge: true }
      );

      return res.status(200).json({ sucesso: true });
    } catch (err) {
      console.error('❌ Erro em /google-calendar/disconnect:', err);
      return res.status(500).json({ erro: 'Erro ao desconectar conta Google.' });
    }
  });

  // 8. Cron de reconciliação geral para todos os usuários conectados
  app.get('/cron/sincronizar-google-agenda', verificarAutorizacaoCron, async (req, res) => {
    if (!isGoogleOAuthConfigured()) {
      return res.status(200).json({ sucesso: true, ignorado: true, motivo: 'Google OAuth não configurado.' });
    }

    try {
      const db = admin.firestore();
      const snapUsuarios = await db
        .collection('usuarios')
        .where('googleCalendar.connected', '==', true)
        .get();

      const alvos = [];
      snapUsuarios.forEach((doc) => {
        const u = doc.data();
        if (u.googleCalendar?.connected && u.googleCalendar?.enabled !== false) {
          alvos.push({ id: doc.id, data: u, ref: doc.ref });
        }
      });

      if (alvos.length === 0) {
        return res.status(200).json({ sucesso: true, sincronizados: 0, erros: 0 });
      }

      const sharedSnapshot = await carregarSnapshotAgenda(db, {
        precisarEventos: true,
        precisarAvisos: true,
        precisarTesouraria: true
      });

      let sincronizados = 0;
      let erros = 0;
      for (const alvo of alvos) {
        try {
          await sincronizarUsuario(db, alvo.id, alvo.data, alvo.ref, sharedSnapshot);
          sincronizados += 1;
        } catch (err) {
          erros += 1;
          console.warn(`⚠️ Falha ao sincronizar Google Agenda de ${alvo.id}:`, err.message);
        }
      }

      return res.status(200).json({ sucesso: true, total: alvos.length, sincronizados, erros });
    } catch (err) {
      return res.status(500).json({ erro: err.message });
    }
  });

  return {
    sincronizarAfetadosInterno: async ({ scope = 'all', affectedNames = [] } = {}) => {
      const db = admin.firestore();
      return sincronizarAfetadosInterno(db, { scope, affectedNames });
    }
  };
}

module.exports = {
  registerGoogleCalendarRoutes,
  getUserCapabilities,
  gerarIdentificadoresUsuario,
  usuarioBateComNome,
  formatarNomeEscalado,
  resolverNomeEscalado,
  gerarEventIdGoogle,
  construirEventosParaUsuario,
  sanitizeReturnTo,
  GOOGLE_EVENT_COLORS
};
