/**
 * Execute uma vez para gerar o GOOGLE_REFRESH_TOKEN.
 * Passo a passo:
 *   1. Copie .env.example para .env e preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET
 *   2. npm run get-token
 *   3. Acesse o URL que aparecer no terminal
 *   4. Autorize e cole o código aqui
 *   5. Copie o refresh_token gerado para o .env
 */

import 'dotenv/config';
import { google } from 'googleapis';
import readline from 'readline';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar']
});

console.log('\nAcesse este URL no navegador:\n');
console.log(authUrl);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Cole o código de autorização aqui: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log('\n✔ Autenticado com sucesso!');
    console.log('\nAdicione ao seu .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch (err) {
    console.error('Erro ao obter token:', err.message);
  }
});
