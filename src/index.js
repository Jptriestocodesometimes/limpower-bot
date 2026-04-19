import 'dotenv/config';
import express from 'express';
import { processMessage, injectApprovalResult } from './agent.js';
import { sendMessage, sendTyping } from './whatsapp.js';

const app = express();
app.use(express.json());

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

// Processa respostas de aprovação da Fernanda
// Formato esperado: "CODIGO sim" ou "CODIGO nao"
async function handleFernandaMessage(fernandaPhone, text) {
  const match = text.match(/^(\S+)\s+(sim|nao|não|aprovado|recusado)$/i);

  if (!match) {
    console.log(`[Fernanda] Mensagem não reconhecida como aprovação: "${text}"`);
    await sendMessage(fernandaPhone, `⚠️ Formato não reconhecido.\n\nPara responder, envie:\n*CODIGO sim* ou *CODIGO nao*\n\nExemplo: \`João128M2 sim\``);
    return;
  }

  const code = match[1];
  const approved = /^(sim|aprovado)$/i.test(match[2]);

  console.log(`[Fernanda] Resposta recebida — código: ${code} | aprovado: ${approved}`);

  try {
    const handled = await injectApprovalResult(code, approved);

    if (handled) {
      await sendMessage(fernandaPhone, `✅ Resposta processada para o código *${code}*.`);
    } else {
      await sendMessage(fernandaPhone, `⚠️ Código *${code}* não encontrado ou já processado.`);
    }
  } catch (err) {
    console.error(`Erro ao processar aprovação da Fernanda (código ${code}):`, err);
    await sendMessage(fernandaPhone, `❌ Erro ao processar o código *${code}*. Verifique os logs.`);
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
