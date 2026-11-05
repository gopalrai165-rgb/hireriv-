// Fill the job form from a pasted job post (a WhatsApp message, an email or a
// client's job description). Rules only, no AI: it reads the title, city and
// area, pay, experience, openings, job type, work arrangement, shift, hours,
// working days, English, minimum education, perks, things the worker must
// have, walk-in, immediate joining, skills and the text sections, and returns
// values the form accepts. Phone numbers, emails and links are left out of
// the text, so candidates apply through Hireriv. Nothing is saved: the page
// fills only the empty fields and the person checks them before saving.
const geo = require('./geo');
const { COMMON_SKILLS } = require('./resume-parse');

const MAX_TEXT = 8000;

const CITY_ALIASES = {
  bangalore: 'Bengaluru', bengaluru: 'Bengaluru', bombay: 'Mumbai', gurgaon: 'Gurugram', calcutta: 'Kolkata', madras: 'Chennai',
  trivandrum: 'Thiruvananthapuram', vizag: 'Visakhapatnam', cochin: 'Kochi', ernakulam: 'Kochi', mysore: 'Mysuru', 'new delhi': 'Delhi',
  baroda: 'Vadodara', poona: 'Pune', secunderabad: 'Hyderabad', 'greater noida': 'Noida',
};

// Words in the title (or the whole post) that point to a category. Only used
// when that category is on the site's list.
const CATEGORY_HINTS = [
  [/\b(tele ?callers?|telesales|bpo|call cent(?:er|re)|customer (?:support|care|service)|voice process|chat process|cce)\b/i, 'Customer Support & BPO'],
  [/\b(accountants?|accounts? (?:executive|assistant)|tally|bookkeep\w*|ca inter|finance executive)\b/i, 'Finance & Accounting'],
  [/\b(developers?|programmers?|software|full ?stack|front ?end|back ?end|devops|qa engineer|tester|data analyst|it support)\b/i, 'Technology'],
  [/\b(delivery|riders?|drivers?|warehouse|pickers?|packers?|loaders?|logistics|dispatch|forklift|store keeper|courier)\b/i, 'Logistics & Operations'],
  [/\b(nurses?|nursing|pharmacist|pharma|medical|lab technician|ward boy|hospital)\b/i, 'Healthcare & Pharma'],
  [/\b(teachers?|tutors?|trainers?|faculty|lecturer|counsellor)\b/i, 'Education & Training'],
  [/\b(hr|recruiters?|talent acquisition|human resources?)\b/i, 'Human Resources'],
  [/\b(data entry|office (?:assistant|boy|admin)|receptionist|front desk|back office|admin(?:istration)? (?:executive|assistant)|computer operator|peon)\b/i, 'Admin & Office Support'],
  [/\b(electricians?|technicians?|fitters?|welders?|machine operators?|cnc|plumbers?|mechanics?|production|maintenance engineer|helpers?)\b/i, 'Engineering & Manufacturing'],
  [/\b(cooks?|chefs?|kitchen|housekeeping|hotel|waiters?|stewards?|restaurant|travel)\b/i, 'Hospitality & Travel'],
  [/\b(cashiers?|store (?:manager|executive)|retail|showroom|sales ?(?:girl|boy)|shop)\b/i, 'Retail & E-commerce'],
  [/\b(digital marketing|graphic designer|content writer|social media|seo|video editor|marketing executive)\b/i, 'Marketing & Creative'],
  [/\b(sales|business development|bde|bdm|field sales|relationship manager|marketing)\b/i, 'Sales & Business Development'],
  [/\b(security guards?|guards?|security supervisor|bouncers?)\b/i, 'Admin & Office Support'],
  [/\b(site engineer|civil engineer|supervisor construction|real estate|mason|carpenter)\b/i, 'Construction & Real Estate'],
  [/\b(loan|insurance|banking|bank|credit card|collection)\b/i, 'Banking & Insurance'],
];

const PERK_RULES = [
  ['food', /\b(free )?(food|meals?|lunch|canteen|tiffin)\b/i],
  ['stay', /\b(accommodation|stay|hostel|room|lodging)\b(?! (?:at home|safe))/i],
  ['transport', /\b(cab|transport|pick ?up|drop facility|bus facility|conveyance)\b/i],
  ['pf', /\b(pf|esi|esic|provident fund)\b/i],
  ['incentives', /\bincentives?\b/i],
  ['insurance', /\b(health insurance|medical insurance|mediclaim|insurance cover)\b/i],
  ['joiningbonus', /\bjoining bonus\b/i],
  ['dailypay', /\b(daily (?:payment|pay|wages?)|same day payment|paid daily)\b/i],
];
const BRING_RULES = [
  ['bike', /\b(own (?:bike|two[- ]wheeler|vehicle)|two[- ]wheeler|bike (?:is )?(?:must|mandatory|required))\b/i],
  ['licence', /\b(driving licen[cs]e|valid licen[cs]e|dl (?:is )?(?:must|mandatory|required)|licen[cs]e (?:is )?(?:must|mandatory|required))\b/i],
  ['smartphone', /\b(smart ?phone|android (?:phone|mobile))\b/i],
  ['laptop', /\b(own laptop|laptop (?:is )?(?:must|mandatory|required)|with laptop)\b/i],
];
// Lowest level wins: "12th pass or graduate" needs 12th.
const EDUCATION_RULES = [
  ['none', /\b(no (?:education|qualification) (?:needed|required)|education not required|illiterate|any qualification)\b/i],
  ['10th', /\b(10th|ssc|matric(?:ulation)?|sslc|high school)\b/i],
  ['iti', /\b(iti|diploma)\b/i],
  ['12th', /\b(12th|hsc|intermediate|puc|higher secondary)\b/i],
  ['graduate', /\b(graduat(?:e|es|ion)|any degree|bachelor'?s?|b\.? ?com|b\.? ?sc|b\.? ?a\b|bba|bca|b\.? ?tech|b\.? ?e\b|degree)\b/i],
  ['postgraduate', /\b(post ?graduat\w*|mba|m\.? ?com|mca|m\.? ?sc|m\.? ?tech|masters?)\b/i],
];
const SECTION_HEADS = [
  ['responsibilities', /^(?:key )?(?:roles?(?: and| &)? )?(?:responsibilit(?:y|ies)|duties|job (?:role|duties|responsibilities)|what you(?:'ll| will) do|work(?: details)?)\s*:?\s*$/i],
  ['qualifications', /^(?:requirements?|eligibility(?: criteria)?|qualifications?|who can apply|candidate profile|desired profile|skills required|must have)\s*:?\s*$/i],
  ['benefits', /^(?:benefits|perks(?: and benefits)?|facilities|what we offer|we offer)\s*:?\s*$/i],
  ['description', /^(?:job description|about the (?:job|role)|description|jd)\s*:?\s*$/i],
];

const LABEL_LINE = /^(?:job title|position|post|role|designation|profile|vacancy|opening|openings|no\.? of (?:positions|posts|openings|vacancies)|location|job location|work location|city|place|salary|ctc|pay|stipend|package|experience|exp|qualification|education|eligibility|timings?|working hours|shift|working days|job type|employment type|skills?|key skills|gender|age|languages?|english|industry|department|interview|walk[- ]?in(?: date| time| venue)?|joining)\s*[:\-–]/i;
const PHONE_RE =/(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|bit\.ly|t\.me)\/\S+/i;
const contactIn = (s) => PHONE_RE.test(s) || EMAIL_RE.test(s) || URL_RE.test(s);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Hr|It|Bpo|Bde|Bdm|Cce|Qa|Ui|Ux|Seo|Cnc|Iti|Mis)\b/g, (m) => m.toUpperCase());
// "Telecallers" -> "Telecaller", "Delivery Executives" -> "Delivery Executive"; keeps "Sales", "Accounts".
function singular(title) {
  const words = title.split(' ');
  const last = words[words.length - 1];
  const keep = /^(sales|accounts|operations|logistics|services|business|process|ss)$/i;
  if (last.length > 4 && /s$/i.test(last) && !/ss$/i.test(last) && !keep.test(last)) words[words.length - 1] = /ies$/i.test(last) ? last.slice(0, -3) + 'y' : last.slice(0, -1);
  return words.join(' ');
}
const cleanTitle = (s) => singular(titleCase(String(s).replace(/[*_~"“”]+/g, '').replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s:,.–—-]+$/g, '').trim())).slice(0, 80);
const NOT_TITLE = /\b(salary|ctc|stipend|experience|location|contact|call|whatsapp|send|apply|interview|address|timing|qualification|education|urgent(?:ly)?$)\b/i;

function findTitle(lines, text) {
  for (const l of lines) {
    const m = l.match(/^(?:job title|position|post|role|designation|profile|vacancy|opening)\s*[:\-–]\s*(.{3,70})$/i);
    if (m) return cleanTitle(m[1]);
  }
  // "Security guards required at …", "Driver wanted in …"
  const before = text.match(/^(?:[*_🔥📢✅\s]*(?:urgent(?:ly)?|immediate(?:ly)?)?\s*)([a-z][a-z/&. -]{2,40}?)\s+(?:required|needed|wanted)\b/im);
  if (before && !NOT_TITLE.test(before[1]) && !/^(candidates?|people|persons?|staff|freshers?)$/i.test(before[1].trim())) return cleanTitle(before[1]);
  const m = text.match(/\b(?:we are hiring|we're hiring|now hiring|hiring|urgent(?:ly)? (?:requirement|required|hiring|need)(?: (?:for|of))?|requirement (?:for|of)|required|need(?:ed)?|looking for|openings? for|vacanc(?:y|ies) for)\s*:?\s*(?:\d{1,4}\s*(?:nos?\.?\s*)?)?(?:(?:an?|the)\s+)?([a-z][a-z/&. -]{2,45}?)(?=\s+(?:in|at|for|from|with|on|near|-|–|—|\(|$)|[,.!:\n(]|$)/im);
  if (m && !NOT_TITLE.test(m[1]) && !/^(?:at|in|for|from|near|on)\b/i.test(m[1].trim()) && !/^(candidates?|people|persons?|staff|freshers?|immediate(?:ly)?|urgently)$/i.test(m[1].trim())) return cleanTitle(m[1]);
  const first = lines.find((l) => l.length >= 3 && l.length <= 60 && !NOT_TITLE.test(l) && !contactIn(l) && !/\d{4,}/.test(l));
  return first ? cleanTitle(first.replace(/^(?:we are hiring|hiring|urgent(?:ly)? (?:requirement|hiring)|job opening|job alert)\s*[:!\-–]*\s*/i, '')) : '';
}

function findCity(text, cities) {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const found = [];
  const names = [...cities.filter((c) => !['Remote', 'Multiple locations'].includes(c)).map((c) => [c.toLowerCase(), c]), ...Object.entries(CITY_ALIASES)]
    .sort((a, b) => b[0].length - a[0].length);
  let rest = lower;
  const at = new Map();
  for (const [name, city] of names) {
    const re = new RegExp(` ${escapeRe(name.replace(/[^a-z0-9]+/g, ' '))} `);
    const i = rest.search(re);
    if (i !== -1 && cities.includes(city)) {
      if (!found.includes(city)) found.push(city);
      at.set(city, Math.min(at.has(city) ? at.get(city) : Infinity, i));
      // Blank it out with the same length, so later positions still line up.
      rest = rest.replace(re, (m) => ' '.repeat(m.length));
    }
  }
  found.sort((a, b) => at.get(a) - at.get(b));
  // "Delhi NCR" names both Delhi and NCR: keep the longer one.
  if (found.includes('Delhi NCR')) return { city: 'Delhi NCR', all: found };
  if (found.length > 1 && cities.includes('Multiple locations')) return { city: 'Multiple locations', all: found };
  return { city: found[0] || '', all: found };
}

function findArea(text, city) {
  if (!city) return '';
  const a = geo.areaOf({ location: city, address: text });
  return a ? a.name : '';
}

// Rupees from "15k", "15,000", "2.5 lakh", "3 LPA".
const rupees = (n, unit) => {
  const v = Number(String(n).replace(/,/g, ''));
  if (!Number.isFinite(v)) return 0;
  if (/^(k|thousand)$/i.test(unit || '')) return Math.round(v * 1000);
  if (/^(l|lakh|lakhs|lac|lacs|lpa)$/i.test(unit || '')) return Math.round(v * 100000);
  return Math.round(v);
};
function findPay(text) {
  const t = text.replace(/₹\s*/g, 'Rs ').replace(/\s+/g, ' ');
  const num = '(\\d{1,3}(?:,\\d{2,3})+|\\d+(?:\\.\\d+)?)';
  const unit = '\\s*(k|thousand|l|lakhs?|lacs?|lpa)?\\b';
  const range = new RegExp(`(?:salary|pay|ctc|stipend|package|wages?|rs\\.?|inr)[^\\d\\n]{0,25}${num}${unit}\\s*(?:-|–|to|—)\\s*(?:rs\\.?\\s*)?${num}${unit}([^\\n.]{0,30})`, 'i');
  const bare = new RegExp(`\\b${num}\\s*(k|lpa)\\b\\s*(?:-|–|to)\\s*${num}\\s*(k|lpa)?\\b([^\\n.]{0,30})`, 'i');
  const single = new RegExp(`(?:salary|pay|ctc|stipend|package|wages?|earn(?:ings?)?)\\s*(?:is|of|:|-|–|till|around|approx\\.?)?\\s*((?:upto|up to|maximum|max\\.?)\\s*)?(?:rs\\.?|inr)?\\s*(?:upto|up to)?\\s*${num}${unit}([^\\n.]{0,30})`, 'i');
  let min = 0; let max = 0; let tail = ''; let u1 = ''; let u2 = '';
  let m = t.match(range) || t.match(bare);
  if (m) { [, , u1, , u2] = m; min = rupees(m[1], m[2] || m[4]); max = rupees(m[3], m[4] || m[2]); tail = m[5] || ''; }
  else if ((m = t.match(single))) { u1 = m[3]; const v = rupees(m[2], m[3]); if (m[1] || /\b(?:upto|up to)\s*(?:rs\.?|inr)?\s*$/i.test(t.slice(0, m.index + m[0].indexOf(m[2])))) max = v; else { min = v; max = v; } tail = m[4] || ''; }
  if (!max) return null;
  if (min > max) [min, max] = [max, min];
  const around = `${u1 || ''} ${u2 || ''} ${tail} ${t.slice(Math.max(0, (m.index || 0) - 20), (m.index || 0) + m[0].length + 30)}`;
  let period = 'month';
  if (/\b(lpa|lakhs?|lacs?|per annum|p\.? ?a\.?|annual(?:ly)?|yearly|per year|\/ ?year)\b/i.test(around)) period = 'year';
  else if (/\b(per day|\/ ?day|daily|a day)\b/i.test(around)) period = 'day';
  else if (/\b(per hour|\/ ?hour|hourly|an hour)\b/i.test(around)) period = 'hour';
  // A phone number or a PIN code is not pay.
  if (max > 10000000 || (period === 'month' && max < 1000)) return null;
  return { salaryMin: min ? String(min) : '', salaryMax: String(max), salaryPeriod: period };
}

function findExperience(text) {
  let m = text.match(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i);
  if (m && Number(m[1]) <= Number(m[2])) return `${m[1]}-${m[2]} years`;
  m = text.match(/\b(?:minimum|min\.?|at ?least)?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:experience|exp)\b|\b(?:experience|exp)\s*[:\-–]?\s*(?:minimum|min\.?)?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i);
  if (m) return `${m[1] || m[2]}+ years`;
  if (/\bfreshers?\b/i.test(text)) return /\b(experienced|freshers? (?:and|&|or|\/) experienced|experienced (?:and|&|or|\/) freshers?)\b/i.test(text) ? 'Fresher or experienced' : 'Fresher';
  m = text.match(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*months?\s+(?:of\s+)?(?:experience|exp)\b/i);
  if (m) return `${m[1]}-${m[2]} months`;
  return '';
}

function findOpenings(text) {
  const m = text.match(/\b(\d{1,4})\s*\+?\s*(?:nos\.?\s*)?(?:openings?|vacanc(?:y|ies)|positions?|posts?|seats?|candidates|people|persons|members|heads?)\b/i)
    || text.match(/\b(?:openings?|vacanc(?:y|ies)|no\.? of (?:positions|posts|openings|vacancies)|positions?|headcount)\s*[:\-–]?\s*(\d{1,4})\b/i)
    || text.match(/\b(?:need|needed|hiring|required|requirement (?:for|of))\s+(\d{1,4})\s+(?!years?|yrs?|months?|days?|am|pm)[a-z]/i);
  const n = m && Number(m[1]);
  return n && n > 0 && n <= 5000 ? String(n) : '';
}

function findType(text) {
  if (/\bintern(?:ship)?s?\b/i.test(text)) return 'Internship';
  if (/\bapprentice(?:ship)?\b/i.test(text)) return 'Apprenticeship';
  if (/\b(daily wages?|gig|per day basis)\b/i.test(text)) return 'Daily wage / Gig';
  if (/\bpart[- ]?time\b/i.test(text)) return 'Part-time';
  if (/\b(contract(?:ual)?|third[- ]party payroll|on contract)\b/i.test(text)) return 'Contract';
  if (/\btemporary\b/i.test(text)) return 'Temporary';
  if (/\bfull[- ]?time\b/i.test(text)) return 'Full-time';
  return '';
}

function findMode(text) {
  if (/\b(work from home|wfh|remote(?:ly)?|from home)\b/i.test(text) && !/\bno (?:work from home|wfh)\b/i.test(text)) return 'Remote';
  if (/\bhybrid\b/i.test(text)) return 'Hybrid';
  if (/\b(field (?:work|job|sales|visits?)|on ?field)\b/i.test(text)) return 'Field work';
  if (/\b(client site|client location|deputed at)\b/i.test(text)) return 'Client site';
  if (/\b(work from office|wfo|on[- ]?site|in[- ]office)\b/i.test(text)) return 'On-site';
  return '';
}

function findShift(text) {
  if (/\bnight shifts?\b/i.test(text)) return 'Night';
  if (/\brotational shifts?\b/i.test(text)) return 'Rotational';
  if (/\bflexible (?:shifts?|timings?|hours)\b/i.test(text)) return 'Flexible';
  if (/\b(day shifts?|general shift)\b/i.test(text)) return 'Day';
  return '';
}

function findHours(text) {
  const m = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))/i);
  if (!m) return '';
  const tidy = (s) => s.replace(/\./g, '').replace(/\s*(am|pm)$/i, (x, ap) => ` ${ap.toUpperCase()}`).trim();
  return `${tidy(m[1])} – ${tidy(m[2])}`;
}

function findSchedule(text) {
  const m = text.match(/\b([4-7])\s*days?\s*(?:working|a week|\/ ?week|per week|week)\b/i);
  if (m) return `${m[1]} days a week`;
  const d = text.match(/\b(mon(?:day)?)\s*(?:-|–|to)\s*(fri(?:day)?|sat(?:urday)?)\b/i);
  if (d) return /^fri/i.test(d[2]) ? 'Monday to Friday' : 'Monday to Saturday';
  return '';
}

function findEnglish(text) {
  if (/\b(no english|english (?:is )?not (?:required|needed|mandatory)|without english|hindi only|local language only)\b/i.test(text)) return 'None';
  if (/\b(fluent|excellent|strong) (?:english|communication in english)|english[^.\n]{0,12}\bfluen/i.test(text)) return 'Fluent';
  if (/\bgood (?:english|communication (?:skills? )?in english)|english[^.\n]{0,12}\bgood\b/i.test(text)) return 'Good';
  if (/\bbasic english|english[^.\n]{0,12}\bbasic\b/i.test(text)) return 'Basic';
  return '';
}

function findEducation(text) {
  const levels = EDUCATION_RULES.filter(([, re]) => re.test(text)).map(([k]) => k);
  return levels[0] || '';
}

function findSkills(lines, text) {
  for (const l of lines) {
    const m = l.match(/^(?:key )?skills?(?: required)?\s*[:\-–]\s*(.+)$/i);
    if (m) return [...new Set(m[1].split(/[,;|/•]+/).map((s) => s.replace(/^\s*(?:and|&)\s+/i, '').trim()).filter((s) => s.length >= 2 && s.length <= 40))].slice(0, 15);
  }
  const lower = text.toLowerCase();
  return COMMON_SKILLS.filter((s) => new RegExp(`(^|[^a-z0-9])${escapeRe(s.toLowerCase())}($|[^a-z0-9+#])`).test(lower)).slice(0, 15);
}

function findCategory(title, text, categories) {
  for (const src of [title, text]) {
    for (const [re, cat] of CATEGORY_HINTS) if (re.test(src) && categories.includes(cat)) return cat;
  }
  return '';
}

// Splits the post into the form's text sections under the headings it uses;
// lines with a phone number, email or link are left out.
function sections(lines) {
  const out = { description: [], responsibilities: [], qualifications: [], benefits: [] };
  let current = 'description';
  let leftOut = 0;
  for (const raw of lines) {
    const line = raw.replace(/^[\s•*·▪►✓✔☑➤➢\-–—]+|^\d{1,2}[.)]\s+/, '').trim();
    if (!line) continue;
    const head = SECTION_HEADS.find(([, re]) => re.test(line.replace(/[*_]/g, '')));
    if (head) { current = head[0]; continue; }
    if (contactIn(line)) {
      // Keep the sentences around the phone number, email or link.
      const kept = line.split(/(?<=[.!?])\s+/).filter((s) => !contactIn(s));
      leftOut++;
      if (!kept.length) continue;
      out[current].push(kept.join(' ').replace(/[*_~]+/g, ''));
      continue;
    }
    if (/^(?:interested candidates?|apply now|send (?:your )?(?:cv|resume)|share (?:your )?(?:cv|resume)|contact|call|whatsapp|hr name|hr contact|regards|thanks)/i.test(line)) continue;
    // Read into the form's own fields already ("Salary: 15k", "Location: Pune").
    if (current === 'description' && LABEL_LINE.test(line.replace(/[*_]/g, ''))) continue;
    // A bare heading like "Urgent Hiring 🔥" or "Job Alert!".
    if (/^[^a-z0-9]*(?:urgent(?:ly)?\s+)?(?:hiring|we are hiring|we're hiring|now hiring|requirement|urgent requirement|job opening|job alert|vacancy|openings?)[^a-z0-9]*$/i.test(line)) continue;
    out[current].push(line.replace(/[*_~]+/g, ''));
  }
  // One point per line, as the form's text boxes take them.
  const bullet = (list) => list.join('\n');
  return {
    description: out.description.join(' ').replace(/\s+/g, ' ').trim().slice(0, 3000),
    responsibilities: bullet(out.responsibilities).slice(0, 3000),
    qualifications: bullet(out.qualifications).slice(0, 3000),
    benefits: bullet(out.benefits).slice(0, 1500),
    leftOut,
  };
}

// Returns { fields, checks, found, notes }: `fields` by form name (text,
// selects), `checks` the tick boxes, `found` the labels of what was read.
function parseJobPost(input, { cities = [], categories = [] } = {}) {
  const text = String(input || '').replace(/\r/g, '').slice(0, MAX_TEXT);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const fields = {};
  const found = [];
  const notes = [];
  const labels = {};
  const set = (name, value, label) => { if (value) { fields[name] = value; if (label) { labels[name] = label; if (!found.includes(label)) found.push(label); } } };

  const title = findTitle(lines, text);
  set('title', title, 'Job title');
  const { city, all } = findCity(text, cities);
  const mode = findMode(text);
  if (city) set('location', city, 'City');
  else if (mode === 'Remote' && cities.includes('Remote')) set('location', 'Remote', 'City');
  if (city === 'Multiple locations') notes.push(`It names several cities (${all.join(', ')}): the city is set to "Multiple locations". Post one job per city if you want each city's page to show it.`);
  set('area', city && city !== 'Multiple locations' ? findArea(text, city) : '', 'Area');
  set('mode', mode, 'Work arrangement');
  set('type', findType(text), 'Job type');
  const pay = findPay(text);
  if (pay) { set('salaryMin', pay.salaryMin, 'Pay'); set('salaryMax', pay.salaryMax, 'Pay'); set('salaryPeriod', pay.salaryPeriod, 'Pay'); }
  set('experience', findExperience(text), 'Experience');
  set('openings', findOpenings(text), 'Openings');
  set('shift', findShift(text), 'Shift');
  set('hours', findHours(text), 'Working hours');
  set('schedule', findSchedule(text), 'Working days');
  set('english', findEnglish(text), 'English needed');
  set('minEducation', findEducation(text), 'Minimum education');
  const category = findCategory(title, text, categories);
  set('category', category, 'Category');
  const skills = findSkills(lines, text);
  set('skills', skills.join(', '), 'Skills');

  const sec = sections(lines.filter((l) => cleanTitle(l) !== title || !title));
  for (const k of ['description', 'responsibilities', 'qualifications', 'benefits']) set(k, sec[k], { description: 'Description', responsibilities: 'Responsibilities', qualifications: 'Requirements', benefits: 'Benefits' }[k]);
  if (sec.leftOut) notes.push(`Left out ${sec.leftOut} line${sec.leftOut === 1 ? '' : 's'} with a phone number, email or link, so candidates apply through Hireriv and contact details stay off the public job page.`);

  const checks = {
    perks: PERK_RULES.filter(([, re]) => re.test(text)).map(([k]) => k),
    bring: BRING_RULES.filter(([, re]) => re.test(text)).map(([k]) => k),
    walkIn: /\bwalk[- ]?in(?:s)?\b/i.test(text),
    immediate: /\b(immediate(?:ly)? (?:join(?:ing|er|ers)?|start)|join(?:ing)? immediately|immediate joiners?)\b/i.test(text),
  };
  if (checks.perks.length) found.push('Perks');
  if (checks.bring.length) found.push('Things the worker must have');
  if (checks.walkIn) found.push('Walk-in');
  if (checks.immediate) found.push('Immediate joining');
  if (/\b(registration|security|joining|training|processing|interview|kit|uniform|document(?:ation)?)\s+(fee|fees|charges?|deposit)\b|\brefundable\s+deposit\b/i.test(text)) notes.push('The post asks candidates to pay a fee or deposit. Hireriv does not list jobs that charge candidates, so remove that before sending it for review.');
  Object.assign(labels, { perks: 'Perks', bring: 'Things the worker must have', walkIn: 'Walk-in', immediate: 'Immediate joining' });
  return { fields, checks, found, labels, notes };
}

module.exports = { parseJobPost, MAX_TEXT, findPay, findExperience, findTitle };
