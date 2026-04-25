# CLAUDE.md

Este arquivo fornece orientações ao Claude Code (claude.ai/code) ao trabalhar neste repositório.

## O que é isso

Bot de atendimento WhatsApp para a Limpower (empresa de limpeza). Recebe mensagens via Evolution API, processa com Claude AI (persona "Li"), gerencia um fluxo de aprovação com a gerente (canal "Fernanda") e integra com Google Calendar para agendamentos.

## Comandos

```bash
npm start          # Iniciar em produção
npm run dev        # Iniciar com watch de arquivos
npm run get-token  # Gerar OAuth refresh token do Google (interativo)
```

Docker (infraestrutura local):
```bash
docker-compose up -d   # Subir PostgreSQL + Evolution API
```

Não há testes automatizados. Para validar mudanças, rodar `npm run dev` e enviar mensagens de teste pelo webhook.

## Servidor de Produção

- **Pasta do bot:** `~/limpower-bot/`
- **Process manager:** pm2 — processo: `limpower-bot`
- **Deploy:** copiar arquivos alterados via `scp` + `pm2 restart limpower-bot` (o servidor não tem git)
- **Credenciais de acesso:** IP, usuário e chave SSH estão na memória local do Claude Code

## Arquitetura

**Entry point:** `src/index.js` — servidor Express na porta 3000 com duas rotas:
- `POST /webhook` — recebe todos os eventos de mensagem da Evolution API
- `GET /health` — verificação de status

**Roteamento de mensagens** em `src/index.js`: mensagens são separadas por número de telefone. Se o remetente for a Fernanda (gerente), vai pro backchannel de gerência; todos os outros vão pro fluxo de cliente.

**Módulos principais:**

| Arquivo | Função |
|---------|--------|
| `src/agent.js` | Loop agêntico da Claude API — gerencia uso de ferramentas, histórico de conversa e fluxo de aprovação |
| `src/prompts.js` | Prompts de sistema para Li (atendente) e Fernanda (gerente); contém tabelas de preço completas |
| `src/proposal.js` | Gera documentos `.docx` de proposta usando a lib `docx` |
| `src/whatsapp.js` | Wrapper das chamadas da Evolution API: enviar texto, documentos, indicador de digitação |
| `src/calendar.js` | Integração Google Calendar — verificar disponibilidade (slot fixo 9h) e criar eventos |

**Fluxo de aprovação:**
1. Li coleta dados do cliente → gera proposta → salva em `data/pending_approvals.json`
2. Bot notifica Fernanda via WhatsApp com código de aprovação
3. Fernanda aprova/rejeita pelo backchannel
4. Na aprovação, bot envia o `.docx` + oferta atualizada ao cliente; na rejeição, fluxo reinicia

**Persistência de dados** (tudo em `data/`, criado em runtime):
- `conversations/{phone}.json` — histórico de conversa Claude por cliente
- `pending_approvals.json` — propostas aguardando decisão da Fernanda
- `proposal_inputs.json` — inputs originais salvos para reedição
- `proposal_changes.jsonl` — log de auditoria de todas as edições de proposta
- `proposals/{phone}.docx` — documentos Word gerados

## Integração com IA

- Modelo: `claude-haiku-4-5-20251001` (otimizado para custo)
- Prompt caching habilitado (prompt de sistema é cacheado)
- Histórico de conversa é truncado para manter custo baixo — ver lógica em `agent.js`
- Loop de tool use: agente chama ferramentas (verificar calendário, criar proposta, enviar mensagem) até concluir

## Configuração do Ambiente

Copiar `.env.example` para `.env` e preencher:
- `EVOLUTION_API_URL`, `EVOLUTION_INSTANCE`, `EVOLUTION_API_KEY` — gateway WhatsApp
- `ANTHROPIC_API_KEY` — Claude API
- `FERNANDA_PHONE` — número da gerente (aciona o roteamento pro backchannel)
- `GOOGLE_*` — credenciais do Calendar (rodar `npm run get-token` para gerar `GOOGLE_REFRESH_TOKEN`)
- `TIMEZONE`, `WORKING_DAYS`, `WORKING_HOURS_START/END` — restrições de agendamento

## Comportamentos Importantes

- **Códigos de aprovação** são case-insensitive e gerados por proposta para evitar aprovações não autorizadas
- **Filtro de números internos** — lista hardcoded em `src/index.js`; mensagens de funcionários são silenciosamente ignoradas
- **Tabelas de preço** ficam em `src/prompts.js` — atualizar lá quando os preços mudarem
- O roteamento via `FERNANDA_PHONE` é o que ativa o backchannel da gerente; trocar a variável muda qual número tem acesso de gerente
