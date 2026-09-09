import codecs

with codecs.open('E:/agenda-renovar-backend/index.js', 'r', 'utf-8') as f:
    content = f.read()

cron_routes = '''
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
         const key = ${user}__;
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

       const titulo = ${prefixoTempo} ;
       const funcStr = info.funcoes.join(", ");
       const corpo = Lembrete da sua escala:\\n📍 Funções: \\n⏰ Horário: ;

       const snapUser = await usuariosRef.where('nome', '==', info.usuario).get();
       let fcmToken = null;
       if (!snapUser.empty) {
           fcmToken = snapUser.docs[0].data().fcmToken;
       } else {
           const snapApelido = await usuariosRef.where('apelido', '==', info.usuario).get();
           if (!snapApelido.empty) fcmToken = snapApelido.docs[0].data().fcmToken;
       }

       if (fcmToken) {
           const mensagem = { notification: { title: titulo, body: corpo }, token: fcmToken };
           promises.push(admin.messaging().send(mensagem).catch(e => console.error("Erro push:", e)));
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
    snapAdmins.docs.forEach(d => { if (d.data().fcmToken) adminTokens.push(d.data().fcmToken); });

    snapshot.forEach(doc => {
      const t = doc.data();
      const solicitante = t.solicitantes && t.solicitantes[0] ? t.solicitantes[0].nome : "Um membro";
      const destino = t.solicitantes && t.solicitantes[0] ? t.solicitantes[0].destino : null;

      const titulo = "⏳ Lembrete de Troca Pendente";
      const corpo = O pedido de troca de  para a função  no dia  continua aguardando resposta!;

      promises.push((async () => {
         let tokensTarget = [];
         if (destino && destino !== "Admin" && destino !== "admin") {
             const snapTarget = await usuariosRef.where('nome', '==', destino).get();
             if (!snapTarget.empty && snapTarget.docs[0].data().fcmToken) tokensTarget.push(snapTarget.docs[0].data().fcmToken);
             else {
                 const snapApelido = await usuariosRef.where('apelido', '==', destino).get();
                 if (!snapApelido.empty && snapApelido.docs[0].data().fcmToken) tokensTarget.push(snapApelido.docs[0].data().fcmToken);
             }
         }
         if (tokensTarget.length === 0) tokensTarget = adminTokens;

         if (tokensTarget.length > 0) {
             const mensagem = { notification: { title: titulo, body: corpo }, tokens: [...new Set(tokensTarget)] };
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
'''

# Find the spot to inject. Before the GET '/' route is good.
marker = "app.get('/', (req, res) => {"
if marker in content and "lembretes-escalas" not in content:
    content = content.replace(marker, cron_routes + "\n" + marker)
    with codecs.open('E:/agenda-renovar-backend/index.js', 'w', 'utf-8') as f:
        f.write(content)
        print("Backend atualizado!")
else:
    print("Já atualizado ou marcador não encontrado.")
