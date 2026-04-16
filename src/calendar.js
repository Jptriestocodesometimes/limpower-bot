import { google } from 'googleapis';
import { addHours, parseISO, setHours, setMinutes, setSeconds } from 'date-fns';
import { fromZonedTime, toZonedTime, format } from 'date-fns-tz';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

export const SERVICE_DURATIONS = {
  limpeza_normal: 3,
  limpeza_estofados: 2,
  limpeza_pos_obra: 6
};

export const SERVICE_LABELS = {
  limpeza_normal: 'Limpeza Normal da Casa',
  limpeza_estofados: 'Limpeza de Estofados',
  limpeza_pos_obra: 'Limpeza Pós Obra'
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

export async function getAvailableSlots(dateStr, serviceType) {
  const config = getWorkingConfig();
  const duration = SERVICE_DURATIONS[serviceType] || 3;

  // Parse date in local timezone
  const date = parseISO(dateStr);
  const dayOfWeek = toZonedTime(date, TIMEZONE).getDay();

  if (!config.days.includes(dayOfWeek)) {
    const dayNames = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    return {
      available: false,
      reason: `Não atendemos às ${dayNames[dayOfWeek]}s.`
    };
  }

  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  // Build start/end of working day in UTC
  const startLocal = setSeconds(setMinutes(setHours(date, config.start), 0), 0);
  const endLocal = setSeconds(setMinutes(setHours(date, config.end), 0), 0);
  const startUtc = fromZonedTime(startLocal, TIMEZONE);
  const endUtc = fromZonedTime(endLocal, TIMEZONE);

  const { data } = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    timeMin: startUtc.toISOString(),
    timeMax: endUtc.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const busy = (data.items || []).map(event => ({
    start: new Date(event.start.dateTime || event.start.date),
    end: new Date(event.end.dateTime || event.end.date)
  }));

  // Generate 1-hour slots within working hours
  const slots = [];
  let cursor = new Date(startUtc);

  while (addHours(cursor, duration) <= endUtc) {
    const slotEnd = addHours(cursor, duration);
    const isFree = !busy.some(b => cursor < b.end && slotEnd > b.start);

    if (isFree) {
      const localTime = toZonedTime(cursor, TIMEZONE);
      slots.push(format(localTime, 'HH:mm', { timeZone: TIMEZONE }));
    }

    cursor = addHours(cursor, 1);
  }

  if (slots.length === 0) {
    return { available: false, reason: 'Sem horários disponíveis nesta data.' };
  }

  return { available: true, slots };
}

export async function createAppointment({
  customer_name,
  customer_phone,
  service_type,
  address,
  date,
  time,
  notes
}) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const duration = SERVICE_DURATIONS[service_type] || 3;
  const label = SERVICE_LABELS[service_type] || service_type;

  const [hours, minutes] = time.split(':').map(Number);
  const dateObj = parseISO(date);
  const startLocal = setSeconds(setMinutes(setHours(dateObj, hours), minutes), 0);
  const startUtc = fromZonedTime(startLocal, TIMEZONE);
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
