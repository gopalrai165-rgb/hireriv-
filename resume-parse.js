// Read uploaded resumes: pull the text out of PDF and Word (.docx) files, then
// spot contact details, years of experience and skills. Used to pre-fill the
// apply form, to search inside resumes in the talent pool, and for skill matching.
// Old binary .doc files can't be read; they're simply skipped.
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

module.exports = { extractText, analyze, COMMON_SKILLS, MAX_TEXT };
