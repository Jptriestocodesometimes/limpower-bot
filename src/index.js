import 'dotenv/config';
import express from 'express';
import { processMessage, processFernandaMessage } from './agent.js';
import { sendMessage, sendTyping } from './whatsapp.js';

const app = express();
app.use(express.json());

// Funcionários — bot ignora mensagens desses números silenciosamente
const STAFF_PHONES = new Set([
  '5511959239372', // Marcelo estofados
  '5511945174999', // Mara faxineira
  '5511982742487', // Pedrita faxineira
  '5511993461013', // Natalia faxineira
  '5511948413792', // Juliana faxineira
  '5511963311656', // Nicole faxineira
]);

// JID da Fernanda — suporta número normal (5511...) ou @lid (iOS com privacidade ativada)
const fernandaRaw = process.env.FERNANDA_PHONE || '';
const FERNANDA_JID = fernandaRaw
  ? (fernandaRaw.includes('@') ? fernandaRaw : `${fernandaRaw}@s.whatsapp.net`)
  : null;

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

  // Preserva o JID completo para suportar @lid (contas com privacidade ativada)
  const phone = jid.endsWith('@s.whatsapp.net') ? jid.replace('@s.whatsapp.net', '') : jid;

  // Extrai o texto da mensagem (suporta mensagens simples e extendidas)
  const text =
    data.message?.conversation ||
    data.message?.extendedTextMessage?.text ||
    '';

  if (!text.trim()) return;

  // ── Funcionários — ignora silenciosamente ───────────────────────────────────
  if (STAFF_PHONES.has(phone)) return;

  // ── Mensagens da Fernanda ───────────────────────────────────────────────────
  if (FERNANDA_JID && jid === FERNANDA_JID) {
    await handleFernandaMessage(phone, text.trim());
    return;
  }

  // ── Mensagens de clientes ───────────────────────────────────────────────────
  const customerName = data.pushName || 'Cliente';
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

// Canal interno — Fernanda conversa com a Li
async function handleFernandaMessage(fernandaPhone, text) {
  console.log(`[Fernanda] ${text}`);
  try {
    const reply = await processFernandaMessage(text);
    if (reply) {
      await sendMessage(fernandaPhone, reply);
      console.log(`[Li → Fernanda] ${reply}`);
    }
  } catch (err) {
    console.error('[Fernanda] Erro ao processar mensagem:', err);
    await sendMessage(fernandaPhone, '❌ Tive um problema interno. Verifique os logs.');
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Limpower Bot rodando na porta ${PORT}`);
  if (!FERNANDA_JID) {
    console.warn('⚠️  FERNANDA_PHONE não configurado — aprovações não serão roteadas!');
  }
});
