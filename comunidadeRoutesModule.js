/**
 * Rotas gratuitas de notificações e sincronização da Comunidade (substitui Cloud Functions no plano Spark).
 * Valida os documentos diretamente no Firestore via Admin SDK para evitar spoofing/spam.
 */
function registerComunidadeRoutes({
  app,
  admin,
  verificarAutenticacao,
  enviarMulticastEmLotes,
  sanitizarDadosFCM,
}) {
  const rateLimitMap = new Map();

  function checkIpRateLimit(ip, key, maxPerMinute = 12) {
    const now = Date.now();
    const bucketKey = `${key}:${ip || 'unknown'}`;
    const entry = rateLimitMap.get(bucketKey) || { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60_000;
    }
    entry.count += 1;
    rateLimitMap.set(bucketKey, entry);
    if (rateLimitMap.size > 2000) {
      for (const [k, v] of rateLimitMap.entries()) {
        if (now > v.resetAt) rateLimitMap.delete(k);
      }
    }
    return entry.count <= maxPerMinute;
  }

  function isAdminOrPastor(u) {
    if (!u || typeof u !== 'object') return false;
    const role = String(u.role || '').trim().toLowerCase();
    return u.admin === true || role === 'admin' || role === 'pastor' || role === 'pastora';
  }

  function isSecretario(u) {
    if (!u || typeof u !== 'object') return false;
    const role = String(u.role || '').trim().toLowerCase();
    return role === 'secretario' || role === 'secretário' || role === 'secretaria' || role === 'secretária';
  }

  // 1) Notifica liderança sobre nova interação pública (Oração, Dúvida, Visitante, Acesso Membro)
  app.post('/comunidade/notificar-interacao', async (req, res) => {
    try {
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
      if (!checkIpRateLimit(ip, 'interacao', 10)) {
        return res.status(429).json({ erro: 'Muitas solicitações. Tente novamente em instantes.' });
      }

      const interacaoId = String(req.body?.interacaoId || '').trim();
      if (!interacaoId || interacaoId.length > 120) {
        return res.status(400).json({ erro: 'interacaoId inválido.' });
      }

      const db = admin.firestore();
      const docRef = db.collection('comunidade_interacoes').doc(interacaoId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ erro: 'Interação não encontrada.' });
      }

      const data = snap.data() || {};
      if (data.notificacaoEnviada === true) {
        return res.status(200).json({ sucesso: true, jaNotificado: true });
      }

      const tipo = String(data.tipo || 'duvida').toLowerCase();
      const isConfidencial = data.confidencial === true;
      const onlyPastoral = isConfidencial || tipo === 'acesso_membro';

      const titulos = {
        oracao: isConfidencial ? '🙏 Pedido de Oração (Confidencial)' : '🙏 Novo Pedido de Oração',
        visitante: '✨ Novo Cartão de Visitante',
        acesso_membro: '🪪 Solicitação de Acesso de Membro',
        sugestao: '💡 Nova Sugestão da Comunidade',
        duvida: '💬 Nova Dúvida da Comunidade',
      };
      const titulo = titulos[tipo] || '📩 Nova Interação na Comunidade';
      const remetente = data.anonimo ? 'Anônimo' : String(data.nome || 'Visitante').trim();
      const corpo = isConfidencial
        ? `${remetente} enviou um pedido confidencial para a liderança pastoral.`
        : `${remetente}: ${String(data.mensagem || data.assunto || 'Nova mensagem recebida').slice(0, 120)}`;

      const usersSnap = await db.collection('usuarios').get();
      const tokens = [];
      const batch = db.batch();
      let destinatarios = 0;

      usersSnap.forEach((userDoc) => {
        const u = userDoc.data() || {};
        if (u.acessoApp === false) return;
        const allowed = onlyPastoral
          ? isAdminOrPastor(u)
          : isAdminOrPastor(u) || isSecretario(u);
        if (!allowed) return;

        destinatarios += 1;
        if (Array.isArray(u.fcmTokens)) {
          u.fcmTokens.forEach((t) => {
            if (typeof t === 'string' && t.trim()) tokens.push(t.trim());
          });
        }
        const notifRef = db.collection('notificacoes').doc();
        batch.set(notifRef, {
          usuario: u.nome || userDoc.id,
          usuarioId: userDoc.id,
          titulo,
          mensagem: corpo,
          tipo: tipo === 'acesso_membro' ? 'comunidade-acesso-membro' : 'comunidade-interacao',
          rota: '/admin/comunidade',
          interacaoId,
          lida: false,
          criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      batch.update(docRef, { notificacaoEnviada: true });
      await batch.commit();

      const uniqueTokens = Array.from(new Set(tokens));
      if (uniqueTokens.length > 0 && typeof enviarMulticastEmLotes === 'function') {
        const fcmData = sanitizarDadosFCM({
          tipo: tipo === 'acesso_membro' ? 'comunidade-acesso-membro' : 'comunidade-interacao',
          rota: '/admin/comunidade',
          interacaoId,
        });
        await enviarMulticastEmLotes(uniqueTokens, {
          notification: { title: titulo, body: corpo },
          data: fcmData,
          android: {
            priority: 'high',
            notification: { channelId: 'avisos', color: '#E64F0E' },
          },
        });
      }

      return res.status(200).json({ sucesso: true, destinatarios, pushes: uniqueTokens.length });
    } catch (err) {
      console.error('❌ Erro em /comunidade/notificar-interacao:', err);
      return res.status(500).json({ erro: 'Erro ao notificar interação.' });
    }
  });

  // 2) Notifica membros/comunidade sobre nova publicação (autenticado Admin/Pastor/Secretário)
  app.post('/comunidade/notificar-post', verificarAutenticacao, async (req, res) => {
    try {
      const db = admin.firestore();
      const requesterSnap = await db.collection('usuarios').doc(req.usuario.uid).get();
      const requester = requesterSnap.data() || {};
      if (!isAdminOrPastor(requester) && !isSecretario(requester)) {
        return res.status(403).json({ erro: 'Sem permissão para notificar publicações.' });
      }

      const postId = String(req.body?.postId || '').trim();
      if (!postId) return res.status(400).json({ erro: 'postId obrigatório.' });

      const postSnap = await db.collection('comunidade_posts').doc(postId).get();
      if (!postSnap.exists) return res.status(404).json({ erro: 'Publicação não encontrada.' });

      const post = postSnap.data() || {};
      const titulo = `📢 ${String(post.titulo || 'Nova publicação da igreja').slice(0, 80)}`;
      const corpo = String(post.conteudo || post.descricao || 'Confira os detalhes no Portal da Comunidade.').slice(0, 140);
      const rota = `/comunidade/post/${encodeURIComponent(postId)}`;

      const usersSnap = await db.collection('usuarios').get();
      const tokens = [];
      usersSnap.forEach((doc) => {
        const u = doc.data() || {};
        if (u.acessoApp === false) return;
        if (Array.isArray(u.fcmTokens)) {
          u.fcmTokens.forEach((t) => {
            if (typeof t === 'string' && t.trim()) tokens.push(t.trim());
          });
        }
      });

      const uniqueTokens = Array.from(new Set(tokens));
      if (uniqueTokens.length > 0 && typeof enviarMulticastEmLotes === 'function') {
        const fcmData = sanitizarDadosFCM({
          tipo: 'comunidade-post',
          rota,
          postId,
        });
        await enviarMulticastEmLotes(uniqueTokens, {
          notification: { title: titulo, body: corpo },
          data: fcmData,
          android: {
            priority: 'high',
            notification: { channelId: 'avisos', color: '#E64F0E' },
          },
        });
      }

      return res.status(200).json({ sucesso: true, pushes: uniqueTokens.length });
    } catch (err) {
      console.error('❌ Erro em /comunidade/notificar-post:', err);
      return res.status(500).json({ erro: 'Erro ao notificar publicação.' });
    }
  });

  // 3) Sincroniza atomicamente o contador rsvpCount de um evento
  app.post('/comunidade/sync-rsvp', async (req, res) => {
    try {
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
      if (!checkIpRateLimit(ip, 'rsvp', 20)) {
        return res.status(429).json({ erro: 'Muitas solicitações.' });
      }
      const postId = String(req.body?.postId || '').trim();
      if (!postId || postId.length > 120) {
        return res.status(400).json({ erro: 'postId inválido.' });
      }

      const db = admin.firestore();
      const postRef = db.collection('comunidade_posts').doc(postId);
      const postSnap = await postRef.get();
      if (!postSnap.exists) {
        return res.status(404).json({ erro: 'Evento não encontrado.' });
      }

      const rsvpsSnap = await db.collection('comunidade_rsvps').where('postId', '==', postId).get();
      let totalPessoas = 0;
      rsvpsSnap.forEach((d) => {
        const item = d.data() || {};
        totalPessoas += Number(item.totalPessoas) || 1 + (Number(item.acompanhantes) || 0);
      });

      await postRef.update({
        rsvpCount: totalPessoas,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ sucesso: true, rsvpCount: totalPessoas });
    } catch (err) {
      console.error('❌ Erro em /comunidade/sync-rsvp:', err);
      return res.status(500).json({ erro: 'Erro ao sincronizar RSVP.' });
    }
  });
}

module.exports = { registerComunidadeRoutes };
