import { google } from 'googleapis';
import { addHours, parseISO, setHours, setMinutes, setSeconds } from 'date-fns';
import { fromZonedTime, toZonedTime, format } from 'date-fns-tz';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

// Duração padrão por tipo de serviço (em horas, para o bloco no Calendar)
export const SERVICE_DURATIONS = {
  pos_obra: 8,       // Pós-Obra: bloca 1 dia completo (serviços multi-dia são gerenciados manualmente)
  pre_mudanca: 5,    // Pré-Mudança: estimativa média
  estofados: 3,      // Higienização de Estofados: estimativa média
  vidros: 4          // Limpeza de Vidros: estimativa média
};

export const SERVICE_LABELS = {
  pos_obra: 'Limpeza Pós-Obra',
  pre_mudanca: 'Limpeza Pré-Mudança',
  estofados: 'Higienização de Estofados',
  vidros: 'Limpeza de Vidros'
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
  const duration = SERVICE_DURATIONS[serviceType] || 4;

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

  const fixedHour = parseInt(process.env.APPOINTMENT_HOUR || '9');
  const slotStart = fromZonedTime(
    setSeconds(setMinutes(setHours(date, fixedHour), 0), 0),
    TIMEZONE
  );
  const slotEnd = addHours(slotStart, duration);

  const isFree = !busy.some(b => slotStart < b.end && slotEnd > b.start);

  if (!isFree) {
    return { available: false, reason: `Horário das ${String(fixedHour).padStart(2,'0')}:00 já está ocupado nesta data.` };
  }

  return { available: true, slots: [`${String(fixedHour).padStart(2,'0')}:00`] };
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
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  // Usa duration_hours se passado pelo agente; caso contrário usa o padrão do serviço
  const duration = duration_hours ?? SERVICE_DURATIONS[service_type] ?? 4;
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
