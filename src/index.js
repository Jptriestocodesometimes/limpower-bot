import 'dotenv/config';
import express from 'express';
import { processMessage } from './agent.js';
import { sendMessage, sendTyping } from './whatsapp.js';

const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  // Responde imediatamente para o Evolution API não retentar
  res.sendStatus(200);

  const { event, data } = req.body;

  if (event !== 'messages.upsert') return;
  if (!data?.key) return;
  if (data.key.fromMe) return; // ignora mensagens enviadas pelo próprio bot
  if (data.messageType === 'protocolMessage') return;

  const jid = data.key.remoteJid ?? '';

  // Ignora grupos
  if (jid.endsWith('@g.us')) return;

  const phone = jid.replace('@s.whatsapp.net', '');
  const customerName = data.pushName || 'Cliente';

  // Extrai o texto da mensagem (suporta mensagens simples e extendidas)
  const text =
    data.message?.conversation ||
    data.message?.extendedTextMessage?.text ||
    '';

  if (!text.trim()) return;

  console.log(`[${phone}] ${customerName}: ${text}`);

  try {
    await sendTyping(phone, 1500);
    const reply = await processMessage(phone, text, customerName);
    if (reply) {
      await sendMessage(phone, reply);
      console.log(`[${phone}] bot: ${reply}`);
    }
  } catch (err) {
    console.error(`Erro ao processar mensagem de ${phone}:`, err);
    await sendMessage(phone, 'Desculpe, tive um probleminha aqui. Pode repetir?');
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Limpower Bot rodando na porta ${PORT}`);
});
