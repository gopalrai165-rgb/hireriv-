// iCalendar (RFC 5545) invites for interviews, so they drop straight into
// Gmail, Outlook and phone calendars. REQUEST creates/updates, CANCEL removes.

const esc = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

const utc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Lines longer than 75 octets must be folded with CRLF + space.
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

function interviewIcs({ method, interview, candidate, jobTitle, site }) {
  const start = new Date(interview.at);
  const end = new Date(start.getTime() + interview.duration * 60000);
  const where = interview.mode === 'Video call' ? interview.where || 'Video call' : interview.where || interview.mode;
  const description = [
    `${interview.mode} interview for ${jobTitle}.`,
    interview.interviewer ? `Interviewer: ${interview.interviewer}` : '',
    interview.where && /^https?:\/\//.test(interview.where) ? `Join: ${interview.where}` : '',
    interview.message || '',
    `Questions? ${site.phone} · ${site.email}`,
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${site.name}//Interviews//EN`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${interview.id}@hireriv`,
    `SEQUENCE:${interview.sequence || 0}`,
    `DTSTAMP:${utc(Date.now())}`,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${esc(`Interview: ${jobTitle} (${site.name})`)}`,
    `DESCRIPTION:${esc(description)}`,
    `LOCATION:${esc(where)}`,
    `ORGANIZER;CN=${esc(site.name)}:mailto:${site.email}`,
    `ATTENDEE;CN=${esc(candidate.name)};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${candidate.email}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(method === 'CANCEL' ? [] : ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Interview reminder', 'TRIGGER:-PT30M', 'END:VALARM']),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// "2026-10-01" + "15:30" entered by a recruiter in India → exact instant.
const istToDate = (date, time) => new Date(`${date}T${time}:00+05:30`);

const formatIst = (d) =>
  new Date(d).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST';

module.exports = { interviewIcs, istToDate, formatIst };
