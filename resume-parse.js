// Read uploaded resumes: pull the text out of PDF and Word (.docx) files, then
// spot contact details, years of experience, skills, job history and education.
// Used to pre-fill the apply form, to search inside resumes in the talent pool,
// for skill matching, and to suggest profile details that the candidate checks
// and corrects before anything is saved. Old binary .doc files can't be read;
// they're simply skipped. Resume text is never logged.
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const { norm } = require('./match');

const MAX_TEXT = 20000; // characters kept per resume
const TIMEOUT_MS = 8000;

// Common skills beyond what's on the current jobs, so matching works for new roles too.
const COMMON_SKILLS = [
  'JavaScript', 'TypeScript', 'React', 'Angular', 'Vue', 'Node.js', 'Express', 'Next.js', 'Python', 'Django', 'Flask', 'Java', 'Spring Boot',
  'C#', '.NET', 'C++', 'Go', 'PHP', 'Laravel', 'Ruby', 'Kotlin', 'Swift', 'Flutter', 'React Native', 'Android', 'iOS', 'SQL', 'MySQL',
  'PostgreSQL', 'MongoDB', 'Redis', 'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'Git', 'Linux', 'DevOps',
  'Machine Learning', 'Data Science', 'Power BI', 'Tableau', 'Excel', 'Selenium', 'Figma', 'UI/UX', 'Salesforce', 'SAP', 'Tally', 'GST',
  'TDS', 'Accounting', 'Payroll', 'Auditing', 'Financial Analysis', 'SEO', 'SEM', 'Google Ads', 'Content Writing', 'Social Media',
  'Recruitment', 'Sourcing', 'Onboarding', 'HRMS', 'Sales', 'Business Development', 'CRM', 'Customer Service', 'Supply Chain',
  'Logistics', 'Procurement', 'Inventory', 'Warehouse', 'Six Sigma', 'Project Management', 'Agile', 'Scrum', 'JIRA', 'AutoCAD',
];

const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT_MS))]);

// Text from a resume file (path or Buffer). Returns '' when it can't be read.
async function extractText(input, originalName) {
  const ext = path.extname(originalName || (typeof input === 'string' ? input : '')).toLowerCase();
  try {
    const data = typeof input === 'string' ? await fs.promises.readFile(input) : input;
    let text = '';
    if (ext === '.pdf') {
      const parser = new PDFParse({ data: new Uint8Array(data) });
      try {
        text = (await withTimeout(parser.getText())).text || '';
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else if (ext === '.docx') {
      text = (await withTimeout(mammoth.extractRawText({ buffer: data }))).value || '';
    }
    return text.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  } catch (err) {
    return '';
  }
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Details spotted in resume text. Anything not found is left empty.
function analyze(text, knownSkills = []) {
  const out = { name: '', email: '', phone: '', linkedin: '', years: null, experience: '', skills: [] };
  if (!text) return out;
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email) out.email = email[0].toLowerCase();
  // Indian mobile numbers, with or without +91 / 0, allowing spaces and dashes.
  const phone = text.match(/(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}\b/);
  if (phone) out.phone = phone[0].replace(/[^\d+]/g, '').replace(/^0/, '').replace(/^(\d{10})$/, '+91$1').replace(/^91(\d{10})$/, '+91$1');
  const li = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+/i);
  if (li) out.linkedin = li[0].startsWith('http') ? li[0] : `https://${li[0]}`;
  // Name: the first short line of letters near the top that isn't a heading.
  for (const line of text.split('\n').slice(0, 8).map((l) => l.trim())) {
    if (/^[A-Za-z][A-Za-z.'\s-]{2,40}$/.test(line) && line.split(/\s+/).length >= 2 && line.split(/\s+/).length <= 4 && !/resume|curriculum|vitae|profile|summary/i.test(line)) {
      out.name = titleCase(line.replace(/\s+/g, ' '));
      break;
    }
  }
  // "6 years", "6+ yrs", "6.5 years of experience"; the largest sensible figure wins.
  const years = [...text.matchAll(/(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years|yrs|year)/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 45);
  if (years.length) {
    out.years = Math.max(...years);
    out.experience = out.years < 1 ? '0-1 years' : out.years < 3 ? '1-3 years' : out.years < 5 ? '3-5 years' : out.years < 10 ? '5-10 years' : '10+ years';
  }
  const hay = norm(text);
  const seen = new Set();
  for (const s of [...knownSkills, ...COMMON_SKILLS]) {
    const key = s.toLowerCase();
    if (!seen.has(key) && s.length > 1 && hay.includes(norm(s))) {
      seen.add(key);
      out.skills.push(s);
    }
  }
  out.skills = out.skills.slice(0, 25);
  return out;
}

// ---------- job history and education ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_WORD = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
// One end of a date range: "Jan 2020", "January, 2020", "01/2020", "2020-01", "2020".
const POINT = `(?:${MONTH_WORD}[\\s,'-]*(\\d{4})|(\\d{1,2})[/.-](\\d{4})|(\\d{4})[/.-](\\d{1,2})(?!\\d)|(\\d{4}))`;
const NOW_WORD = '(present|current|currently|now|till date|to date|ongoing)';
const RANGE_RE = new RegExp(`${POINT}\\s*(?:-|–|—|to|till|until)\\s*(?:${POINT}|${NOW_WORD})`, 'i');
const thisYear = () => new Date().getFullYear();
const okYear = (y) => y >= 1960 && y <= thisYear() + 1;
const pad = (n) => String(n).padStart(2, '0');

// The YYYY-MM of one end, from regex groups. A bare year is January when a job
// starts and December when it ends.
function pointOf(g, end = false) {
  const [mw, my, nm, ny, iy, im, by] = g;
  let y; let m;
  if (my) { y = +my; m = MONTHS[mw.toLowerCase().slice(0, mw.toLowerCase().startsWith('sept') ? 4 : 3)] || 1; }
  else if (ny) { y = +ny; m = +nm; }
  else if (iy) { y = +iy; m = +im; }
  else if (by) { y = +by; m = end ? 12 : 1; }
  if (!y || !okYear(y) || !(m >= 1 && m <= 12)) return '';
  return `${y}-${pad(m)}`;
}
function rangeOf(line) {
  const r = line.match(RANGE_RE);
  if (!r) return null;
  const from = pointOf(r.slice(1, 8));
  const current = Boolean(r[15]);
  const to = current ? '' : pointOf(r.slice(8, 15), true);
  if (!from || (!current && !to) || (to && to < from)) return null;
  return { from, to, current, text: r[0] };
}

// Section headings: which part of the resume a line starts.
const HEADINGS = [
  ['experience', /^(work\s+|professional\s+|employment\s+|job\s+)?(experience|history|employment)(\s+(history|details|summary))?:?$/i],
  ['education', /^(education|educational\s+(qualifications?|background|details)|academic\s+(qualifications?|details|background)|qualifications?|academics)(\s+details)?:?$/i],
  ['other', /^(skills|technical\s+skills|key\s+skills|core\s+skills|projects?|certifications?|licen[cs]es?|languages?|achievements|awards|hobbies|interests|personal\s+(details|information|profile)|declaration|references|summary|profile|objective|career\s+objective|contact|strengths|training|internships?)(\s+&\s+\w+)?:?$/i],
];
function sections(text) {
  const out = { experience: [], education: [], other: [], top: [] };
  let current = 'top';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s•●▪■◦*·-]+/, '').trim();
    if (!line) continue;
    const h = line.length <= 40 && HEADINGS.find(([, re]) => re.test(line));
    if (h) { current = h[0]; continue; }
    out[current].push(line);
  }
  return out;
}

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').replace(/^[\s,|:–—-]+|[\s,|:–—-]+$/g, '').slice(0, n);
// "Warehouse Supervisor at Acme Logistics", "Acme Logistics | Warehouse
// Supervisor", "Warehouse Supervisor, Acme Logistics": title and company.
const COMPANY_HINT = /\b(pvt|private|ltd|limited|llp|inc|corp|company|co\.|technologies|solutions|services|systems|industries|enterprises|logistics|group|bank|hospital|hotel|school|college|university|labs?|consulting)\b/i;
function titleCompany(text) {
  const t = clean(text, 200);
  if (!t) return null;
  let m = t.match(/^(.{2,80}?)\s+(?:at|@)\s+(.{2,80})$/i);
  if (m) return { title: clean(m[1], 120), company: clean(m[2], 120) };
  const parts = t.split(/\s*(?:\||,|\s[–—-]\s)\s*/).map((x) => clean(x, 120)).filter(Boolean);
  if (parts.length >= 2) {
    const [a, b] = parts;
    return COMPANY_HINT.test(a) && !COMPANY_HINT.test(b) ? { title: b, company: a } : { title: a, company: b };
  }
  return { title: t.slice(0, 120), company: '' };
}
// Jobs: each line in the experience section with a date range, with the title
// and company from that line or the one or two lines just before it
// ("Forklift Operator" / "Delta Industries" / "2015 – 2017").
function experiencesOf(lines) {
  const out = [];
  let used = -1; // lines up to here belong to a job already found
  const free = (j) => j > used && j >= 0 && !rangeOf(lines[j]) && lines[j].length <= 100;
  for (let i = 0; i < lines.length && out.length < 10; i++) {
    const r = rangeOf(lines[i]);
    if (!r) continue;
    const rest = clean(lines[i].replace(r.text, '').replace(/[()]/g, ' '), 200);
    let tc = null;
    if (rest.length >= 3) {
      tc = titleCompany(rest);
      if (!tc.company && free(i - 1) && COMPANY_HINT.test(lines[i - 1])) tc.company = clean(lines[i - 1], 120);
    } else if (free(i - 1)) {
      tc = titleCompany(lines[i - 1]);
      if (!tc.company && free(i - 2)) {
        const [a, b] = [clean(lines[i - 2], 120), tc.title];
        tc = COMPANY_HINT.test(a) && !COMPANY_HINT.test(b) ? { title: b, company: a } : { title: a, company: b };
      }
    }
    used = i;
    if (!tc || !/[a-z]/i.test(tc.title)) continue;
    out.push({ title: tc.title, company: tc.company === tc.title ? '' : tc.company, from: r.from, to: r.to, current: r.current });
  }
  return out;
}

// Education levels (the profile's list), from what the degree is called.
const LEVEL_PATTERNS = [
  ['Doctorate', /\b(ph\.?\s?d|doctorate|d\.?phil)\b/i],
  ['Post-graduate', /\b(m\.?\s?tech|m\.?\s?e\b|m\.?\s?sc|m\.?\s?com|m\.?\s?a\b|mba|pgdm|mca|m\.?\s?ed|ll\.?m|m\.?\s?pharm|master'?s?|post[\s-]?graduat\w*|pg\s+diploma)/i],
  ['Graduate', /\b(b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|bba|bca|b\.?\s?ed|ll\.?b|mbbs|bds|b\.?\s?pharm|b\.?\s?arch|bachelor'?s?|graduat\w*|degree)/i],
  ['Diploma', /\b(diploma|polytechnic)\b/i],
  ['ITI', /\b(iti|industrial training institute|ncvt|scvt)\b/i],
  ['12th pass', /\b(12th|xii|hsc|higher secondary|intermediate|puc|class 12|senior secondary)\b/i],
  ['10th pass', /\b(10th|sslc|ssc|matriculation|high school|class 10|secondary school certificate)\b/i],
];
const INSTITUTION = /\b(university|college|institute|institution|school|academy|vidyalaya|iit|nit|iiit|iim|polytechnic|iti)\b/i;
function educationOf(lines) {
  const out = [];
  for (let i = 0; i < lines.length && out.length < 6; i++) {
    const line = lines[i];
    const level = LEVEL_PATTERNS.find(([, re]) => re.test(line));
    if (!level) continue;
    const years = [...line.matchAll(/\b(19[6-9]\d|20\d\d)\b/g)].map((m) => +m[1]).filter(okYear);
    const near = [line, lines[i + 1] || ''].join(' | ');
    const nextYears = years.length ? years : [...(lines[i + 1] || '').matchAll(/\b(19[6-9]\d|20\d\d)\b/g)].map((m) => +m[1]).filter(okYear);
    let institution = '';
    for (const part of near.split(/\s*[|,–—]\s*|\s+-\s+/)) if (INSTITUTION.test(part)) { institution = clean(part.replace(/\b(19[6-9]\d|20\d\d)\b/g, ''), 160); break; }
    const course = clean(line.split(/\s*[|,–—]\s*|\s+-\s+/).find((x) => level[1].test(x)) || line, 120).replace(/\b(19[6-9]\d|20\d\d)\b/g, '').trim();
    out.push({ level: level[0], course: clean(course, 120), institution, year: nextYears.length ? String(Math.max(...nextYears)) : '' });
  }
  // The same qualification listed twice keeps its first mention.
  const seen = new Set();
  return out.filter((e) => { const k = `${e.level}|${e.course.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// The profile details a resume suggests: skills, experience level, jobs and
// education. Nothing here is saved; the candidate reviews it first.
function profileFromText(text, knownSkills = []) {
  const basic = analyze(text, knownSkills);
  const parts = sections(text || '');
  // Resumes without headings: look through everything.
  const expLines = parts.experience.length ? parts.experience : [...parts.top, ...parts.other];
  const eduLines = parts.education.length ? parts.education : [...parts.top, ...parts.other];
  const experiences = text ? experiencesOf(expLines) : [];
  const education = text ? educationOf(eduLines) : [];
  return { ...basic, experiences, education };
}

module.exports = { extractText, analyze, profileFromText, experiencesOf, educationOf, sections, rangeOf, COMMON_SKILLS, MAX_TEXT };
