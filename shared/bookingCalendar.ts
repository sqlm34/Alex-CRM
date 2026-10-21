import { parseServiceWindows, timeMinutes } from './serviceWindows'

export const bookingTimeZone = 'America/Indiana/Indianapolis'
export type CalendarBooking = { id: string; customer?: string; email?: string | null; address: string; appliance: string; service_date: string; service_window: string; status?: string }

export function bookingTimes(job: CalendarBooking) {
  const date = String(job.service_date).slice(0, 10)
  const windows = parseServiceWindows(job.service_window)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !windows.length) throw Error('Invalid booking schedule')
  const local = (minutes: number) => `${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`
  return { start: local(timeMinutes(windows[0].split(' - ')[0])!), end: local(timeMinutes(windows.at(-1)!.split(' - ')[1])!) }
}

export const bookingArrivalMessage = "We'll contact you before heading to your address with our estimated arrival time."

export function googleBookingCalendarUrl(job: CalendarBooking) {
  const times = bookingTimes(job)
  const query = new URLSearchParams({ action: 'TEMPLATE', text: `Alex Appliance Repair - ${job.appliance}`,
    dates: `${times.start.replace(/[-:]/g, '')}/${times.end.replace(/[-:]/g, '')}`, ctz: bookingTimeZone,
    location: job.address, details: `${bookingArrivalMessage}\nQuestions or changes? Call (463) 248-8429.\nBooking: ${job.id}` })
  return `https://calendar.google.com/calendar/render?${query}`
}

function icsText(value: string) { return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,') }

export function bookingCalendarFile(job: CalendarBooking, now = new Date()) {
  const { start, end } = bookingTimes(job)
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Alex Appliance Repair//Booking//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE', `TZID:${bookingTimeZone}`, 'BEGIN:DAYLIGHT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', `UID:${icsText(job.id)}@aleksappliancerepair.com`, `DTSTAMP:${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;TZID=${bookingTimeZone}:${start.replace(/[-:]/g, '')}`, `DTEND;TZID=${bookingTimeZone}:${end.replace(/[-:]/g, '')}`,
    `SUMMARY:${icsText(`Alex Appliance Repair - ${job.appliance}`)}`, `LOCATION:${icsText(job.address)}`, `DESCRIPTION:${icsText(bookingArrivalMessage)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Appliance repair appointment', 'TRIGGER:-PT24H', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR']
  // Fold on UTF-8 octet boundaries without splitting a character.
  return lines.map(line => { let out = '', length = 0; for (const c of line) { const n = new TextEncoder().encode(c).length; if (length + n > 74) { out += '\r\n '; length = 1 } out += c; length += n } return out }).join('\r\n') + '\r\n'
}
