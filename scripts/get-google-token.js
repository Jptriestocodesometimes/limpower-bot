/**
 * Execute uma vez para gerar o GOOGLE_REFRESH_TOKEN.
 * Passo a passo:
 *   1. Copie .env.example para .env e preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET
 *   2. npm run get-token
 *   3. Acesse o URL que aparecer no terminal
 *   4. Autorize — o token será capturado automaticamente
 *   5. Copie o refresh_token gerado para o .env
 */

import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';

const PORT = 3333;
const REDIRECT_URI = `http://localhost:${PORT}`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar']
});

console.log('\nAcesse este URL no navegador:\n');
console.log(authUrl);
console.log('\nAguardando autorização...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');

  if (!code) {
    res.end('Código não encontrado. Tente novamente.');
    return;
  }

  res.end('<h2>Autorizado! Pode fechar esta aba e voltar ao terminal.</h2>');
  server.close();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('✔ Autenticado com sucesso!\n');
    console.log('Adicione ao seu .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch (err) {
    console.error('Erro ao obter token:', err.message);
  }
});

server.listen(PORT);
