import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompts.js';
import { getAvailableSlots, createAppointment } from './calendar.js';

const client = new Anthropic();

// Histórico de conversa por número de telefone
// Formato: Map<phone, Message[]>
const conversations = new Map();

const TOOLS = [
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
          enum: ['limpeza_normal', 'limpeza_estofados', 'limpeza_pos_obra'],
          description: 'Tipo de serviço solicitado'
        }
      },
      required: ['date', 'service_type']
    }
  },
  {
    name: 'create_appointment',
    description: 'Confirma e cria um agendamento no Google Calendar após o cliente escolher o horário.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Nome completo do cliente' },
        customer_phone: { type: 'string', description: 'Número de telefone do cliente' },
        service_type: {
          type: 'string',
          enum: ['limpeza_normal', 'limpeza_estofados', 'limpeza_pos_obra']
        },
        address: { type: 'string', description: 'Endereço completo do imóvel' },
        date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        time: { type: 'string', description: 'Horário no formato HH:MM' },
        notes: { type: 'string', description: 'Observações adicionais (opcional)' }
      },
      required: ['customer_name', 'customer_phone', 'service_type', 'address', 'date', 'time']
    }
  }
];

async function runTool(name, input) {
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
      system: buildSystemPrompt(),
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
