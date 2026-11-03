// Bulk job upload for employers (Step 149): a CSV file (one job per row, a
// header row naming the columns) becomes job drafts. Nothing here saves: it
// reads the file, matches the column names and the values to the lists the
// job form uses (case does not matter), and gives back form-shaped input for
// each row, so every job is checked exactly like one typed into the form.

const MAX_ROWS = 50;
const MAX_BYTES = 300 * 1024;

// Column → job form field. Several spellings of each header are accepted.
const COLUMNS = [
  { field: 'title', label: 'Job title', required: true, aliases: ['title', 'job title', 'role', 'position'], example: 'Delivery Executive', help: 'What the job is called' },
  { field: 'location', label: 'City', required: true, aliases: ['city', 'location', 'job location'], example: 'Pune', help: 'A city from the job form list' },
  { field: 'area', label: 'Area', aliases: ['area', 'locality'], example: 'Hinjewadi', help: 'The area or locality (optional)' },
  { field: 'category', label: 'Category', required: true, aliases: ['category', 'job category', 'department'], example: 'Logistics & Operations', help: 'A category from the job form list' },
  { field: 'type', label: 'Job type', aliases: ['job type', 'type', 'employment type'], example: 'Full-time', help: 'Full-time, Part-time, Contract, Temporary, Daily wage / Gig, Apprenticeship or Internship (Full-time if empty)' },
  { field: 'mode', label: 'Work mode', aliases: ['work mode', 'mode', 'workplace'], example: 'On-site', help: 'On-site, Hybrid, Remote, Field work or Client site (On-site if empty)' },
  { field: 'experience', label: 'Experience', aliases: ['experience', 'experience needed'], example: 'Fresher', help: 'For example Fresher, 0-1 years, 1-3 years' },
  { field: 'salaryMin', label: 'Pay from', aliases: ['pay from', 'salary from', 'min salary', 'salary min', 'pay min'], example: '15000', help: 'In rupees, numbers only' },
  { field: 'salaryMax', label: 'Pay to', aliases: ['pay to', 'salary to', 'max salary', 'salary max', 'pay max'], example: '20000', help: 'In rupees, numbers only' },
  { field: 'salaryPeriod', label: 'Pay per', aliases: ['pay per', 'per', 'salary per', 'pay period'], example: 'month', help: 'month, year, day or hour (month if empty)' },
  { field: 'payNote', label: 'Pay note', aliases: ['pay note', 'salary note', 'incentives'], example: 'Plus petrol allowance and incentives', help: 'Incentives, or how pay is decided when there is no figure' },
  { field: 'openings', label: 'Openings', aliases: ['openings', 'vacancies', 'number of openings', 'positions'], example: '10', help: 'How many people you are hiring' },
  { field: 'shift', label: 'Shift', aliases: ['shift'], example: 'Day', help: 'Day, Night, Rotational or Flexible' },
  { field: 'hours', label: 'Working hours', aliases: ['working hours', 'hours', 'timings'], example: '9 am – 6 pm, 6 days a week', help: 'Hours or days of work' },
  { field: 'education', label: 'Education', aliases: ['education', 'qualification'], example: '10th pass', help: 'In your own words (optional)' },
  { field: 'skills', label: 'Skills', aliases: ['skills', 'key skills'], example: 'Two-wheeler, Smartphone', help: 'Separated by commas' },
  { field: 'description', label: 'Description', required: true, aliases: ['description', 'job description', 'about the job'], example: 'Deliver parcels to homes and shops in your area.', help: 'What the job is, in a few sentences' },
  { field: 'responsibilities', label: 'Responsibilities', required: true, aliases: ['responsibilities', 'duties', 'main responsibilities'], example: 'Pick up parcels from the hub | Deliver on time | Collect cash or UPI payments', help: 'Separated by | (or one per line inside the cell)' },
  { field: 'address', label: 'Address', aliases: ['address', 'workplace address', 'office address'], example: '', help: 'The workplace address (optional)' },
  { field: 'closesOn', label: 'Closing date', aliases: ['closing date', 'closes on', 'last date', 'apply by'], example: '', help: 'YYYY-MM-DD, or empty to keep the job open' },
];
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s_*]+/g, ' ').replace(/[()]/g, '').trim();
const BY_HEADER = new Map(COLUMNS.flatMap((c) => [c.label, c.field, ...c.aliases].map((a) => [norm(a), c])));

// RFC 4180 CSV: quoted cells may hold commas, quotes ("") and new lines.
function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

// A value matched to one of the allowed ones, ignoring case and spacing; the
// value as given when nothing matches (the job check then names the problem).
const pickFrom = (list, v) => list.find((x) => norm(x) === norm(v)) || v;

// CSV text → { rows: [{ line, input, title }], errors }. `lists` holds the
// allowed values: categories, locations, modes, types, shifts.
function read(text, lists) {
  const errors = [];
  if (Buffer.byteLength(String(text || '')) > MAX_BYTES) return { rows: [], errors: [`the file is too large (up to ${MAX_BYTES / 1024} KB)`] };
  const all = parseCsv(text);
  const lineOf = []; // CSV row index → the spreadsheet row number people see
  const table = [];
  all.forEach((r, i) => { if (r.some((c) => c.trim())) { table.push(r); lineOf.push(i + 1); } });
  if (!table.length) return { rows: [], errors: ['the file is empty'] };
  const header = table[0].map((h) => BY_HEADER.get(norm(h)) || null);
  const missing = COLUMNS.filter((c) => c.required && !header.includes(c));
  if (missing.length) errors.push(`the header row needs these columns: ${missing.map((c) => c.label).join(', ')} (download the template to see them)`);
  const unknown = table[0].filter((h, i) => h.trim() && !header[i]).map((h) => h.trim());
  if (unknown.length) errors.push(`these columns are not recognised and will be ignored: ${unknown.slice(0, 8).join(', ')}`);
  const body = table.slice(1);
  if (!body.length) errors.push('the file has a header row but no jobs');
  if (body.length > MAX_ROWS) errors.push(`up to ${MAX_ROWS} jobs per file; this one has ${body.length}. Split it into smaller files`);
  if (missing.length || !body.length || body.length > MAX_ROWS) return { rows: [], errors };
  const rows = body.map((cells, n) => {
    const input = {};
    header.forEach((col, i) => { if (col && cells[i] !== undefined && String(cells[i]).trim()) input[col.field] = String(cells[i]).trim(); });
    if (input.responsibilities) input.responsibilities = input.responsibilities.split(/\s*\|\s*|\r?\n/).map((x) => x.trim()).filter(Boolean).join('\n');
    if (input.category) input.category = pickFrom(lists.categories, input.category);
    if (input.location) input.location = pickFrom(lists.locations, input.location);
    input.mode = input.mode ? pickFrom(lists.modes, input.mode) : 'On-site';
    input.type = input.type ? pickFrom(lists.types, input.type) : 'Full-time';
    if (input.shift) input.shift = pickFrom(lists.shifts, input.shift);
    input.salaryPeriod = input.salaryPeriod ? norm(input.salaryPeriod).replace(/^per /, '').replace(/ly$/, '').replace(/^dai$/, 'day').replace(/^annual$/, 'year') : 'month';
    for (const k of ['salaryMin', 'salaryMax', 'openings']) if (input[k]) input[k] = input[k].replace(/[₹,\s]|rs\.?/gi, '');
    return { line: lineOf[n + 1], input, title: input.title || '' };
  });
  return { rows, errors };
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
// The template: the header row and one example job.
const template = () => `${[COLUMNS.map((c) => csvCell(c.label)).join(','), COLUMNS.map((c) => csvCell(c.example)).join(',')].join('\r\n')}\r\n`;

module.exports = { COLUMNS, MAX_ROWS, MAX_BYTES, parseCsv, read, template };
