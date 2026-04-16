import axios from 'axios';

const api = axios.create({
  baseURL: process.env.EVOLUTION_API_URL,
  headers: { apikey: process.env.EVOLUTION_API_KEY }
});

const INSTANCE = () => process.env.EVOLUTION_INSTANCE;

export async function sendMessage(phone, text) {
  await api.post(`/message/sendText/${INSTANCE()}`, {
    number: phone,
    text
  });
}

export async function sendTyping(phone, durationMs = 2000) {
  try {
    await api.post(`/chat/sendPresence/${INSTANCE()}`, {
      number: phone,
      options: { presence: 'composing', delay: durationMs }
    });
  } catch {
    // não crítico
  }
}
