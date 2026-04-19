import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompts.js';
import { getAvailableSlots, createAppointment } from './calendar.js';
import { sendMessage, sendDocument } from './whatsapp.js';
import { generateProposalModelA, buildFileName } from './proposal.js';

const client = new Anthropic();

// Histórico de conversa por número de telefone
// Formato: Map<phone, Message[]>
const conversations = new Map();

// Aprovações pendentes aguardando resposta da Fernanda
// Formato: Map<code_lowercase, { phone, type }>
const pendingApprovals = new Map();

// Documentos gerados aguardando envio após aprovação
// Formato: Map<customer_phone, { buffer, fileName }>
const pendingDocuments = new Map();

const TOOLS = [
  {
    name: 'notify_fernanda',
    description: 'Envia uma notificação para a Fernanda via WhatsApp. Use para aprovação de orçamento antes de enviar ao cliente, confirmação de agendamento após aceite, pedido de desconto, reclamação ou dúvida fora do escopo.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['aprovacao_orcamento', 'pedido_desconto', 'reclamacao', 'duvida'],
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
        service_type: { type: 'string', enum: ['pos_obra', 'pre_mudanca', 'estofados', 'vidros'] },
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
        area_m2: { type: 'number', description: 'Área do imóvel em m² (para nome do arquivo)' }
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
          enum: ['pos_obra', 'pre_mudanca', 'estofados', 'vidros'],
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
          enum: ['pos_obra', 'pre_mudanca', 'estofados', 'vidros']
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
    }
  }
];

// Gera o código de aprovação no formato: PrimeiroNome + sufixo
// Ex: pos_obra 128m² → "Bia128M2" | estofados → "BiaEst" | vidros → "BiaVid"
function generateApprovalCode(customerName, type, areaMq) {
  const firstName = customerName.trim().split(/\s+/)[0];
  let suffix;

  if (areaMq && (type === 'aprovacao_orcamento' || type === 'orcamento_aceito')) {
    suffix = `${Math.round(areaMq)}M2`;
  } else if (type === 'pedido_desconto') {
    suffix = 'Desc';
  } else if (type === 'reclamacao') {
    suffix = 'Rec';
  } else if (type === 'duvida') {
    suffix = 'Duvida';
  } else {
    // Fallback: últimos 4 dígitos do timestamp
    suffix = Date.now().toString().slice(-4);
  }

  return `${firstName}${suffix}`;
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
    pendingDocuments.set(customer_phone, { buffer, fileName });

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

  const code = generateApprovalCode(customer_name, type, area_m2);

  // Registra a aprovação pendente
  pendingApprovals.set(code.toLowerCase(), { phone: customer_phone, type });

  const fullMessage =
    `${message}\n\n` +
    `📌 *Código de resposta:* ${code}\n` +
    `👉 Responda: \`${code} sim\` ou \`${code} nao\``;

  await sendMessage(fernandaPhone, fullMessage);

  // Envia o documento gerado para Fernanda (se houver)
  if (type === 'aprovacao_orcamento') {
    const doc = pendingDocuments.get(customer_phone);
    if (doc) {
      try {
        await sendDocument(fernandaPhone, doc.buffer, doc.fileName, '📎 Proposta para revisão');
      } catch (err) {
        console.warn('[notify_fernanda] Erro ao enviar documento para Fernanda:', err.message);
      }
    }
  }

  console.log(`[notify_fernanda] Notificação enviada para Fernanda. Código: ${code} | Cliente: ${customer_phone}`);

  return {
    success: true,
    approval_code: code,
    note: 'Notificação enviada para a Fernanda. Informe o cliente que está preparando o orçamento e aguarde a resposta da Fernanda.'
  };
}

async function runTool(name, input) {
  if (name === 'generate_proposal') {
    return await runGenerateProposal(input);
  }
  if (name === 'notify_fernanda') {
    return await runNotifyFernanda(input);
  }
  if (name === 'check_availability') {
    return await getAvailableSlots(input.date, input.service_type);
  }
  if (name === 'create_appointment') {
    return await createAppointment(input);
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

export async function processMessage(phone, text, customerName) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }

  const messages = conversations.get(phone);
  messages.push({ role: 'user', content: text });

  // Cópia local para o loop — evita mutação durante processamento
  const thread = [...messages];

  let finalResponse = null;

  // Loop agêntico: continua até end_turn ou ausência de tool_use
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(phone),
      tools: TOOLS,
      messages: thread
    });

    thread.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      finalResponse = textBlock?.text ?? null;
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        console.log(`[tool] ${block.name}`, JSON.stringify(block.input));

        let result;
        try {
          result = await runTool(block.name, block.input);
          console.log(`[tool result]`, JSON.stringify(result));
        } catch (err) {
          result = { error: err.message };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result)
        });
      }

      thread.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason inesperado — sai do loop
    break;
  }

  // Persiste apenas as últimas 30 mensagens para não crescer demais
  conversations.set(phone, thread.slice(-30));

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

  const { phone, type } = pending;
  const resposta = approved ? 'aprovado' : 'recusado';
  const systemMsg = `[RESPOSTA_FERNANDA] Código: ${code} | Fernanda ${resposta} a solicitação. Tipo: ${type}`;

  console.log(`[injectApprovalResult] ${systemMsg} → cliente ${phone}`);

  const reply = await processMessage(phone, systemMsg, 'Sistema');
  if (reply) {
    await sendMessage(phone, reply);
    console.log(`[bot → ${phone}] ${reply}`);
  }

  // Envia o documento ao cliente após aprovação do orçamento
  if (approved && type === 'aprovacao_orcamento') {
    const doc = pendingDocuments.get(phone);
    if (doc) {
      try {
        await sendDocument(phone, doc.buffer, doc.fileName, '📎 Segue a proposta em anexo!');
        pendingDocuments.delete(phone);
        console.log(`[bot → ${phone}] Proposta enviada: ${doc.fileName}`);
      } catch (err) {
        console.warn(`[injectApprovalResult] Erro ao enviar documento ao cliente ${phone}:`, err.message);
      }
    }
  }

  return true;
}
