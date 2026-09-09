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

app.post('/enviar-notificacao', async (req, res) => {
  const { tokens, titulo, corpo, dados } = req.body;
  
  if (!tokens || tokens.length === 0) {
    return res.status(400).json({ erro: "Nenhum destino/token fornecido" });
  }

  try {
    if (tokens === 'igreja_geral' || (Array.isArray(tokens) && tokens[0] === 'igreja_geral')) {
      const mensagemTopico = {
        notification: { title: titulo, body: corpo },
        data: dados || {},
        topic: 'igreja_geral'
      };
      const resposta = await admin.messaging().send(mensagemTopico);
      console.log('✅ Notificação global enviada:', resposta);
      return res.status(200).json({ sucesso: true, detalhes: resposta, tipo: 'topico' });
    } 
    else {
      const mensagemMulticast = {
        notification: { title: titulo, body: corpo },
        data: dados || {},
        tokens: Array.isArray(tokens) ? tokens : [tokens]
      };
      const resposta = await admin.messaging().sendEachForMulticast(mensagemMulticast);
      console.log('✅ ' + resposta.successCount + ' notificações diretas enviadas.');
      return res.status(200).json({ sucesso: true, detalhes: resposta, tipo: 'direta' });
    }
  } catch (erro) {
    console.error("🚨 Erro ao enviar:", erro);
    return res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

// Rota de teste para ver se o servidor está online
app.get('/', (req, res) => {
  res.send('Servidor de Notificações Ativo! 🚀');
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log('🚀 Servidor backend rodando na porta ' + PORTA);
});
