import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildFernandaSystemPrompt } from './prompts.js';
import { getAvailableSlots, createAppointment } from './calendar.js';
import { sendMessage, sendDocument } from './whatsapp.js';
import { generateProposalModelA, buildFileName } from './proposal.js';

const client = new Anthropic();

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const PROPOSALS_DIR = path.join(DATA_DIR, 'proposals');
fs.mkdirSync(CONV_DIR, { recursive: true });
fs.mkdirSync(PROPOSALS_DIR, { recursive: true });

function loadConversation(phone) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONV_DIR, `${phone}.json`), 'utf8'));
  } catch { return []; }
}

function saveConversation(phone, messages) {
  const file = path.join(CONV_DIR, `${phone}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(messages));
  fs.renameSync(tmp, file);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const PENDING_FILE  = path.join(DATA_DIR, 'pending_approvals.json');
const INPUTS_FILE   = path.join(DATA_DIR, 'proposal_inputs.json');
const CHANGES_FILE  = path.join(DATA_DIR, 'proposal_changes.jsonl');

function logProposalChange(original, changes, customerName, customerPhone) {
  const keys = Object.keys(changes);
  const before = Object.fromEntries(keys.map(k => [k, original[k]]));
  const after  = Object.fromEntries(keys.map(k => [k, changes[k]]));

  const entry = {
    timestamp:      new Date().toISOString(),
    customer_name:  customerName,
    customer_phone: customerPhone,
    service_type:   original.service_type,
    area_m2:        original.area_m2,
    neighborhood:   original.neighborhood,
    dirt_level:     original.dirt_level ?? null,
    before,
    after
  };
  fs.appendFileSync(CHANGES_FILE, JSON.stringify(entry) + '\n');
}

function savePendingApprovals() {
  saveJson(PENDING_FILE, Object.fromEntries(pendingApprovals));
}

function saveProposalInputs() {
  saveJson(INPUTS_FILE, Object.fromEntries(pendingProposalInputs));
}

function proposalDocPath(phone) {
  return path.join(PROPOSALS_DIR, `${phone.replace(/[@.]/g, '_')}.docx`);
}

function savePendingDocument(phone, buffer, fileName) {
  pendingDocuments.set(phone, { buffer, fileName });
  const docPath = proposalDocPath(phone);
  fs.writeFileSync(docPath, buffer);
  saveJson(docPath + '.meta.json', { fileName });
}

function getPendingDocument(phone) {
  if (pendingDocuments.has(phone)) return pendingDocuments.get(phone);
  const docPath = proposalDocPath(phone);
  try {
    const buffer = fs.readFileSync(docPath);
    const { fileName } = loadJson(docPath + '.meta.json', {});
    if (!fileName) return null;
    const doc = { buffer, fileName };
    pendingDocuments.set(phone, doc);
    return doc;
  } catch { return null; }
}

function deletePendingDocument(phone) {
  pendingDocuments.delete(phone);
  const docPath = proposalDocPath(phone);
  try { fs.unlinkSync(docPath); } catch {}
  try { fs.unlinkSync(docPath + '.meta.json'); } catch {}
}

// Histórico de conversa por número de telefone
// Formato: Map<phone, Message[]>
const conversations = new Map();

// Aprovações pendentes aguardando resposta da Fernanda
const pendingApprovals = new Map(Object.entries(loadJson(PENDING_FILE, {})));

// Documentos gerados aguardando envio após aprovação
const pendingDocuments = new Map();

// Inputs originais das propostas para permitir reedição pela Fernanda
const pendingProposalInputs = new Map(Object.entries(loadJson(INPUTS_FILE, {})));

const FERNANDA_CONV_FILE = path.join(CONV_DIR, 'fernanda_internal.json');

function saveFernandaConversation() {
  saveJson(FERNANDA_CONV_FILE, fernandaConversation);
}

// Conversa da Fernanda com a Li (canal interno) — persistida entre reinicializações
const fernandaConversation = loadJson(FERNANDA_CONV_FILE, []);

const FERNANDA_TOOLS = [
  {
    name: 'listar_pendentes',
    description: 'Lista todos os orçamentos pendentes de aprovação, com nome do cliente, telefone e código.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'atualizar_proposta',
    description: 'Aplica alterações em uma proposta pendente e reenvia o documento atualizado para a Fernanda revisar.',
    input_schema: {
      type: 'object',
      properties: {
        customer_phone: { type: 'string', description: 'Telefone do cliente cuja proposta será alterada' },
        value: { type: 'string', description: 'Novo valor (ex: "2.000,00")' },
        duration_days: { type: 'number', description: 'Novo número de dias' },
        team_count: { type: 'number', description: 'Novo total de pessoas na equipe' },
        team_cleaners: { type: 'number', description: 'Novas pessoas de limpeza' },
        services_list: { type: 'array', items: { type: 'string' }, description: 'Nova lista de serviços' },
        preferred_date: { type: 'string', description: 'Nova data preferida' },
        local_description: { type: 'string', description: 'Nova descrição do local' }
      },
      required: ['customer_phone']
    }
  },
  {
    name: 'aprovar_rejeitar',
    description: 'Aprova ou rejeita um orçamento pelo código de aprovação.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Código de aprovação (ex: João235M2)' },
        approved: { type: 'boolean', description: 'true para aprovar, false para rejeitar' }
      },
      required: ['code', 'approved']
    }
  },
  {
    name: 'enviar_mensagem_cliente',
    description: 'Envia uma mensagem diretamente para um cliente pelo WhatsApp.',
    input_schema: {
      type: 'object',
      properties: {
        customer_phone: { type: 'string', description: 'Telefone do cliente' },
        message: { type: 'string', description: 'Mensagem a enviar' }
      },
      required: ['customer_phone', 'message']
    },
    cache_control: { type: 'ephemeral' }
  }
];

const TOOLS = [
  {
    name: 'notify_fernanda',
    description: 'Envia uma notificação para a Fernanda via WhatsApp. Use para aprovação de orçamento antes de enviar ao cliente, confirmação de agendamento após aceite, pedido de desconto, reclamação ou dúvida fora do escopo.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['nova_consulta', 'aprovacao_orcamento', 'pedido_desconto', 'reclamacao', 'duvida'],
          description: 'Tipo da notificação'
        },
        customer_name: {
          type: 'string',
          description: 'Nome completo do cliente'
        },
        customer_phone: {
          type: 'string',
          description: 'Número de telefone do cliente'
        },
        message: {
          type: 'string',
          description: 'Mensagem formatada para a Fernanda, conforme os templates do fluxo de atendimento'
        },
        area_m2: {
          type: 'number',
          description: 'Área em m² do imóvel (para serviços pos_obra e pre_mudanca — usado para gerar o código de aprovação)'
        }
      },
      required: ['type', 'customer_name', 'customer_phone', 'message']
    }
  },
  {
    name: 'generate_proposal',
    description: 'Gera o documento Word (proposta) com os dados do serviço. Chamar ANTES de notify_fernanda no Passo 3.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Nome completo do cliente' },
        customer_phone: { type: 'string', description: 'Telefone do cliente (use customer_phone do sistema)' },
        treatment: { type: 'string', description: 'Prezado Sr. / Prezada Sra. / Prezados' },
        destinatario_linha: { type: 'string', description: 'Linha do destinatário antes do Prezado (empresa ou vazio)' },
        local_description: { type: 'string', description: 'Ex: Apartamento 155 m² - Vila Olímpia - SP' },
        neighborhood: { type: 'string', description: 'Bairro (para nome do arquivo)' },
        service_type: { type: 'string', enum: ['pos_obra', 'pre_mudanca', 'estofados', 'vidros', 'diaria'] },
        preferred_date: { type: 'string', description: 'Data preferida pelo cliente (texto, ex: 21/04/2026)' },
        services_list: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de serviços a serem executados (cada item = 1 parágrafo)'
        },
        value: { type: 'string', description: 'Valor sem R$, ex: 3.800,00' },
        duration_days: { type: 'number', description: 'Número de dias de serviço' },
        team_count: { type: 'number', description: 'Total de pessoas na equipe' },
        team_cleaners: { type: 'number', description: 'Pessoas para limpeza (opcional — padrão: team_count - 1)' },
        area_m2: { type: 'number', description: 'Área do imóvel em m² (para nome do arquivo)' },
        dirt_level: { type: 'string', enum: ['padrao', 'medio', 'pesado'], description: 'Nível de sujeira para pós-obra (padrao/medio/pesado) — obrigatório para pos_obra' }
      },
      required: ['customer_name', 'customer_phone', 'treatment', 'local_description', 'service_type', 'services_list', 'value', 'duration_days', 'team_count']
    }
  },
  {
    name: 'check_availability',
    description: 'Verifica horários disponíveis no Google Calendar para uma data e tipo de serviço específicos.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Data no formato YYYY-MM-DD'
        },
        service_type: {
          type: 'string',
          enum: ['pos_obra', 'pre_mudanca', 'estofados', 'vidros', 'diaria'],
          description: 'Tipo de serviço solicitado'
        }
      },
      required: ['date', 'service_type']
    }
  },
  {
    name: 'create_appointment',
    description: 'Confirma e cria um agendamento no Google Calendar após a Fernanda aprovar e o cliente aceitar.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Nome completo do cliente' },
        customer_phone: { type: 'string', description: 'Número de telefone do cliente' },
        service_type: {
          type: 'string',
          enum: ['pos_obra', 'pre_mudanca', 'estofados', 'vidros', 'diaria']
        },
        address: { type: 'string', description: 'Endereço completo do imóvel' },
        date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        time: { type: 'string', description: 'Horário no formato HH:MM' },
        duration_hours: {
          type: 'number',
          description: 'Duração do serviço em horas (opcional — substitui o padrão do tipo de serviço)'
        },
        notes: { type: 'string', description: 'Observações adicionais (opcional)' }
      },
      required: ['customer_name', 'customer_phone', 'service_type', 'address', 'date', 'time']
    },
    cache_control: { type: 'ephemeral' }
  }
];

// Gera o código de aprovação no formato: PrimeiroNome + sufixo
// Ex: pos_obra 128m² → "Bia128M2_A3F2" | estofados → "BiaEst" | vidros → "BiaVid"
function approvalCodeSuffix(type, areaMq) {
  if (areaMq && type === 'aprovacao_orcamento') {
    const unique = Date.now().toString(36).slice(-4).toUpperCase();
    return `${Math.round(areaMq)}M2_${unique}`;
  }
  switch (type) {
    case 'pedido_desconto': return 'Desc';
    case 'reclamacao':      return 'Rec';
    case 'duvida':          return 'Duvida';
    default:                return Date.now().toString().slice(-4); // fallback
  }
}

function generateApprovalCode(customerName, type, areaMq) {
  const firstName = customerName.trim().split(/\s+/)[0];
  return `${firstName}${approvalCodeSuffix(type, areaMq)}`;
}

async function runGenerateProposal(input) {
  const {
    customer_name, customer_phone, treatment, destinatario_linha = '',
    local_description, neighborhood = '', service_type,
    preferred_date = '', services_list, value, duration_days,
    team_count, team_cleaners, area_m2
  } = input;

  try {
    const buffer = await generateProposalModelA({
      customerName: customer_name,
      treatment,
      destinatarioLinha: destinatario_linha,
      localDescription: local_description,
      preferredDate: preferred_date,
      servicesList: services_list,
      value,
      durationDays: duration_days,
      teamCount: team_count,
      teamCleaners: team_cleaners
    });

    const fileName = buildFileName({ serviceType: service_type, customerName: customer_name, neighborhood, areaMq: area_m2 });
    savePendingDocument(customer_phone, buffer, fileName);
    pendingProposalInputs.set(customer_phone, input);
    saveProposalInputs();

    console.log(`[generate_proposal] Documento gerado: ${fileName} | Cliente: ${customer_phone}`);
    return { success: true, fileName };
  } catch (err) {
    console.error('[generate_proposal] Erro:', err.message);
    return { success: false, error: err.message };
  }
}

async function runNotifyFernanda({ type, customer_name, customer_phone, message, area_m2 }) {
  const fernandaPhone = process.env.FERNANDA_PHONE;
  if (!fernandaPhone) {
    console.warn('[notify_fernanda] FERNANDA_PHONE não configurado no .env');
    return { success: false, error: 'FERNANDA_PHONE não configurado.' };
  }

  await sendMessage(fernandaPhone, message);

  // nova_consulta é só informativa — não requer aprovação nem código
  if (type === 'nova_consulta') {
    console.log(`[notify_fernanda] Nova consulta notificada. Cliente: ${customer_phone}`);
    return { success: true, note: 'Fernanda notificada sobre a nova consulta.' };
  }

  // Para os demais tipos, gera código interno para rastreamento (não exibido para a Fernanda)
  const code = generateApprovalCode(customer_name, type, area_m2);
  pendingApprovals.set(code.toLowerCase(), { phone: customer_phone, type });
  savePendingApprovals();

  if (type === 'aprovacao_orcamento') {
    const doc = getPendingDocument(customer_phone);
    if (doc) {
      try {
        await sendDocument(fernandaPhone, doc.buffer, doc.fileName, '📎 Proposta para revisão');
      } catch (err) {
        console.warn('[notify_fernanda] Erro ao enviar documento para Fernanda:', err.message);
      }
    }
  }

  console.log(`[notify_fernanda] Notificação enviada. Código interno: ${code} | Tipo: ${type} | Cliente: ${customer_phone}`);
  return {
    success: true,
    note: 'Notificação enviada para a Fernanda. Aguarde a resposta dela pelo canal interno.'
  };
}

const TOOL_HANDLERS = {
  generate_proposal:  input => runGenerateProposal(input),
  notify_fernanda:    input => runNotifyFernanda(input),
  check_availability: input => getAvailableSlots(input.date, input.service_type),
  create_appointment: input => createAppointment(input)
};

async function runTool(name, input) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Ferramenta desconhecida: ${name}`);
  return handler(input);
}

async function runListarPendentes() {
  const pendentes = [];
  for (const [code, data] of pendingApprovals) {
    const stored = pendingProposalInputs.get(data.phone);
    pendentes.push({
      code,
      telefone: data.phone,
      cliente: stored?.customer_name ?? 'desconhecido',
      tipo: data.type
    });
  }
  return pendentes.length > 0 ? pendentes : { message: 'Nenhum orçamento pendente no momento.' };
}

async function runAtualizarProposta(input) {
  const { customer_phone, ...changes } = input;
  const stored = pendingProposalInputs.get(customer_phone);
  if (!stored) return { success: false, error: 'Proposta não encontrada para esse cliente.' };

  logProposalChange(stored, changes, stored.customer_name, customer_phone);

  const result = await runGenerateProposal({ ...stored, ...changes });
  if (!result.success) return result;

  const fernandaPhone = process.env.FERNANDA_PHONE;
  const doc = getPendingDocument(customer_phone);
  if (doc && fernandaPhone) {
    try {
      await sendDocument(fernandaPhone, doc.buffer, doc.fileName, '📎 Proposta atualizada para revisão');
    } catch (err) {
      console.warn('[atualizar_proposta] Erro ao reenviar documento:', err.message);
    }
  }

  return { success: true, message: `Proposta de ${stored.customer_name} atualizada e reenviada.` };
}

async function runAprovarRejeitar({ code, approved }) {
  const handled = await injectApprovalResult(code, approved);
  if (!handled) return { success: false, error: `Código "${code}" não encontrado ou já processado.` };
  return { success: true };
}

async function runEnviarMensagemCliente({ customer_phone, message }) {
  await sendMessage(customer_phone, message);
  return { success: true };
}

const FERNANDA_TOOL_HANDLERS = {
  listar_pendentes:        runListarPendentes,
  atualizar_proposta:      runAtualizarProposta,
  aprovar_rejeitar:        runAprovarRejeitar,
  enviar_mensagem_cliente: runEnviarMensagemCliente
};

async function runFernandaTool(name, input) {
  const handler = FERNANDA_TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Ferramenta desconhecida: ${name}`);
  return handler(input);
}

const MAX_AGENT_ITERATIONS = 10;

// Loop agêntico genérico — chama a API até end_turn ou stop_reason inesperado,
// despachando tool_use blocks pelo handler fornecido. Retorna { thread, text }.
async function runAgentLoop({ system, tools, messages, runToolFn, logTag }) {
  const thread = [...messages];
  let finalText = null;
  let iterations = 0;

  while (true) {
    if (++iterations > MAX_AGENT_ITERATIONS) {
      console.error(`[${logTag}] Limite de iterações atingido — possível ciclo de ferramentas`);
      break;
    }
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system,
      tools,
      messages: thread
    });

    thread.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      finalText = textBlock?.text ?? null;
      break;
    }

    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`[${logTag}] ${block.name}`, JSON.stringify(block.input));
      let result;
      try {
        result = await runToolFn(block.name, block.input);
        console.log(`[${logTag} result]`, JSON.stringify(result));
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    thread.push({ role: 'user', content: toolResults });
  }

  return { thread, text: finalText };
}

// Remove tool_result órfãos no início do histórico (causariam erro na API na próxima chamada)
function trimOrphanToolResults(messages) {
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const hasOrphan = Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result');
    if (!hasOrphan) break;
    i++;
  }
  return i === 0 ? messages : messages.slice(i);
}

export async function processFernandaMessage(text) {
  fernandaConversation.push({ role: 'user', content: text });

  const { thread, text: finalResponse } = await runAgentLoop({
    system: buildFernandaSystemPrompt(),
    tools: FERNANDA_TOOLS,
    messages: fernandaConversation,
    runToolFn: runFernandaTool,
    logTag: 'fernanda tool'
  });

  const kept = trimOrphanToolResults(thread.slice(-12));
  fernandaConversation.splice(0, fernandaConversation.length, ...kept);
  saveFernandaConversation();
  return finalResponse;
}

export async function processMessage(phone, text, customerName) {
  if (!conversations.has(phone)) {
    conversations.set(phone, loadConversation(phone));
  }

  // Bloqueia tentativa de cliente injetar o padrão interno de aprovação
  const safeText = customerName !== 'Sistema'
    ? text.replace(/\[RESPOSTA_FERNANDA\]/gi, '[mensagem bloqueada]')
    : text;

  const messages = conversations.get(phone);
  messages.push({ role: 'user', content: safeText });

  const { thread, text: finalResponse } = await runAgentLoop({
    system: buildSystemPrompt(phone),
    tools: TOOLS,
    messages,
    runToolFn: runTool,
    logTag: 'tool'
  });

  const kept = thread.slice(-20);
  conversations.set(phone, kept);
  saveConversation(phone, kept);

  return finalResponse;
}

// Chamado pelo index.js quando a Fernanda responde com "CODIGO sim/nao"
export async function injectApprovalResult(code, approved) {
  const pending = pendingApprovals.get(code.toLowerCase());
  if (!pending) {
    console.warn(`[injectApprovalResult] Código não encontrado: ${code}`);
    return false;
  }

  pendingApprovals.delete(code.toLowerCase());
  savePendingApprovals();

  const { phone, type } = pending;
  const resposta = approved ? 'aprovado' : 'recusado';
  let systemMsg = `[RESPOSTA_FERNANDA] Código: ${code} | Fernanda ${resposta} a solicitação. Tipo: ${type}`;

  // Inclui dados atuais da proposta para que a Li use os valores corretos ao confirmar com o cliente
  if (approved && type === 'aprovacao_orcamento') {
    const input = pendingProposalInputs.get(phone);
    if (input) {
      systemMsg += `\n\n⚠️ Use ESTES dados atualizados ao confirmar com o cliente (ignore valores antigos da conversa):\n- Valor: R$ ${input.value}\n- Duração: ${input.duration_days} dia(s)\n- Equipe: ${input.team_count} pessoa(s)\n- Serviços: ${(input.services_list || []).join(' | ')}`;
    }
  }

  console.log(`[injectApprovalResult] ${systemMsg} → cliente ${phone}`);

  const reply = await processMessage(phone, systemMsg, 'Sistema');
  if (reply) {
    await sendMessage(phone, reply);
    console.log(`[bot → ${phone}] ${reply}`);
  }

  // Envia o documento ao cliente após aprovação do orçamento
  if (approved && type === 'aprovacao_orcamento') {
    const doc = getPendingDocument(phone);
    if (doc) {
      try {
        await sendDocument(phone, doc.buffer, doc.fileName, '📎 Segue a proposta em anexo!');
        deletePendingDocument(phone);
        pendingProposalInputs.delete(phone);
        saveProposalInputs();
        savePendingApprovals();
        console.log(`[bot → ${phone}] Proposta enviada: ${doc.fileName}`);
      } catch (err) {
        console.warn(`[injectApprovalResult] Erro ao enviar documento ao cliente ${phone}:`, err.message);
      }
    }
  }

  return true;
}
