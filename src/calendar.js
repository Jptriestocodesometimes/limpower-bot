import { google } from 'googleapis';
import { addHours, parseISO, setHours, setMinutes, setSeconds } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// Duração padrão por tipo de serviço (em horas, para o bloco no Calendar)
export const SERVICE_DURATIONS = {
  pos_obra: 8,       // Pós-Obra: bloca 1 dia completo (serviços multi-dia são gerenciados manualmente)
  pre_mudanca: 5,    // Pré-Mudança: estimativa média
  estofados: 3,      // Higienização de Estofados: estimativa média
  vidros: 4,         // Limpeza de Vidros: estimativa média
  diaria: 3          // Limpeza Diária: estimativa média
};

export const SERVICE_LABELS = {
  pos_obra: 'Limpeza Pós-Obra',
  pre_mudanca: 'Limpeza Pré-Mudança',
  estofados: 'Higienização de Estofados',
  vidros: 'Limpeza de Vidros',
  diaria: 'Limpeza Diária'
};

function getWorkingConfig() {
  return {
    days: (process.env.WORKING_DAYS || '1,2,3,4,5').split(',').map(Number),
    start: parseInt(process.env.WORKING_HOURS_START || '8'),
    end: parseInt(process.env.WORKING_HOURS_END || '18')
  };
}

function getAuth() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function getCalendar() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}

// Constrói um Date UTC a partir de uma data + hora/minuto interpretados na timezone local da empresa
function zonedDateTime(date, hour, minute = 0) {
  const local = setSeconds(setMinutes(setHours(date, hour), minute), 0);
  return fromZonedTime(local, TIMEZONE);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export async function getAvailableSlots(dateStr, serviceType) {
  const config = getWorkingConfig();
  const duration = SERVICE_DURATIONS[serviceType] || 4;

  const date = parseISO(dateStr);
  const dayOfWeek = toZonedTime(date, TIMEZONE).getDay();

  if (!config.days.includes(dayOfWeek)) {
    return {
      available: false,
      reason: `Não atendemos às ${DAY_NAMES[dayOfWeek]}s.`
    };
  }

  const calendar = getCalendar();

  const { data } = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    timeMin: zonedDateTime(date, config.start).toISOString(),
    timeMax: zonedDateTime(date, config.end).toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const busy = (data.items || []).map(event => ({
    start: new Date(event.start.dateTime || event.start.date),
    end: new Date(event.end.dateTime || event.end.date)
  }));

  const fixedHour = parseInt(process.env.APPOINTMENT_HOUR || '9');
  const slotStart = zonedDateTime(date, fixedHour);
  const slotEnd = addHours(slotStart, duration);

  const isFree = !busy.some(b => slotStart < b.end && slotEnd > b.start);
  const slotLabel = `${pad2(fixedHour)}:00`;

  if (!isFree) {
    return { available: false, reason: `Horário das ${slotLabel} já está ocupado nesta data.` };
  }

  return { available: true, slots: [slotLabel] };
}

export async function createAppointment({
  customer_name,
  customer_phone,
  service_type,
  address,
  date,
  time,
  duration_hours,
  notes
}) {
  const calendar = getCalendar();

  // Usa duration_hours se passado pelo agente; caso contrário usa o padrão do serviço
  const duration = duration_hours ?? SERVICE_DURATIONS[service_type] ?? 4;
  const label = SERVICE_LABELS[service_type] || service_type;

  const [hours, minutes] = time.split(':').map(Number);
  const startUtc = zonedDateTime(parseISO(date), hours, minutes);
  const endUtc = addHours(startUtc, duration);

  const description = [
    `Cliente: ${customer_name}`,
    `Telefone: ${customer_phone}`,
    `Endereço: ${address}`,
    notes ? `Observações: ${notes}` : null
  ]
    .filter(Boolean)
    .join('\n');

  const { data } = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    requestBody: {
      summary: `${label} — ${customer_name}`,
      description,
      start: { dateTime: startUtc.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: endUtc.toISOString(), timeZone: TIMEZONE }
    }
  });

  return {
    success: true,
    event_id: data.id,
    summary: data.summary,
    start: time,
    date,
    duration_hours: duration
  };
}
