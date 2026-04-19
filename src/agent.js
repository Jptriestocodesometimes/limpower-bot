import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompts.js';
import { getAvailableSlots, createAppointment } from './calendar.js';
import { sendMessage } from './whatsapp.js';

const client = new Anthropic();

// Histórico de conversa por número de telefone
// Formato: Map<phone, Message[]>
const conversations = new Map();

// Aprovações pendentes aguardando resposta da Fernanda
// Formato: Map<code_lowercase, { phone, type }>
const pendingApprovals = new Map();

const TOOLS = [
  {
    name: 'notify_fernanda',
    description: 'Envia uma notificação para a Fernanda via WhatsApp. Use para aprovação de orçamento antes de enviar ao cliente, confirmação de agendamento após aceite, pedido de desconto, reclamação ou dúvida fora do escopo.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['aprovacao_orcamento', 'orcamento_aceito', 'pedido_desconto', 'reclamacao', 'duvida'],
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

  console.log(`[notify_fernanda] Notificação enviada para Fernanda. Código: ${code} | Cliente: ${customer_phone}`);

  return {
    success: true,
    approval_code: code,
    note: 'Notificação enviada para a Fernanda. Informe o cliente que está preparando o orçamento e aguarde a resposta da Fernanda.'
  };
}

async function runTool(name, input) {
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

  return true;
}
