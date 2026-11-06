// Screening questions: up to five short questions an employer or the team asks
// when someone applies ("Do you have a two-wheeler licence?", "Can you work
// nights?"). Answers are kept on the application with a copy of the question, so
// later edits to the job never change what someone was asked.
//
// A question can name the answer the job needs. That only marks the application
// for a person to read: nothing here rejects, hides or ranks anyone, and the
// needed answer is never shown to the person applying.
const crypto = require('crypto');

const MAX_QUESTIONS = 5;
const MAX_TEXT = 200;
const MAX_ANSWER = 300;
const TYPES = ['yesno', 'text'];
const FORM_KEY = /^q(Text|Type|MustBe)[0-4]$/;

// Things an employer should not ask to decide on a job.
const PERSONAL_RE = /\b(your age|how old|date of birth|d\.?o\.?b|birthday|married|marital|marriage|spouse|husband|wife|pregnan\w*|family plans?|religio\w*|caste|gotra|horoscope|blood group|nationality|native place|father'?s name|mother'?s name|political|union member\w*|sexual\w*|gender|male or female|disabilit\w*|medical history|health (condition|problem|issue)s?|photo(graph)?|(have|got) (any )?(children|kids))\b/i;
// Money up front, and secrets, are how job scams work.
const MONEY_RE = /\b(registration|processing|security|joining|training|application)\s+(fee|fees|deposit|charges?)\b|\b(pay|paying|deposit)\s+(a |an |the |any |some )?(fee|fees|deposit|money|amount)\b/i;
const SECRET_RE = /\b(otp|password|pin|cvv)\b/i;
// A typed answer must not be an ID or bank number. "Do you have a PAN card?" as Yes or No is fine.
const ID_RE = /\b(aadhaa?r|pan (card|number|no)|passport|bank (account|details)|ifsc|upi|credit card|debit card)\b/i;
// The questions stay on Hireriv: no links or contact details to send people elsewhere.
const OFFSITE_RE = /https?:\/\/|\bwww\.|[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}|\b[6-9]\d{4}[\s-]?\d{5}\b/i;

const idOf = (text) => `q${crypto.createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 10)}`;
const fieldName = (q) => `answer_${q.id}`;
const tidy = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

function problemWith(q, n) {
  const label = `question ${n}`;
  if (PERSONAL_RE.test(q.text)) return `${label} asks about something personal (such as age, family, religion, caste, gender or health). Ask only about what the work needs`;
  if (MONEY_RE.test(q.text)) return `${label} asks about paying money. Job seekers must never be asked to pay for a job`;
  if (SECRET_RE.test(q.text)) return `${label} asks for a code or password. Please remove it`;
  if (OFFSITE_RE.test(q.text)) return `${label} has a link, email or phone number. Questions can't send people elsewhere`;
  if (q.type === 'text' && ID_RE.test(q.text)) return `${label} asks someone to type an ID or bank detail. Ask it as a Yes or No question instead`;
  return '';
}

// From the job forms (qText0, qType0, qMustBe0 ...) or the API (screeningQuestions: [...]).
function parse(body) {
  const src = body || {};
  const fromForm = Object.keys(src).some((k) => FORM_KEY.test(k));
  let raw = [];
  const errors = [];
  if (fromForm) {
    for (let i = 0; i < MAX_QUESTIONS; i++) raw.push({ text: src[`qText${i}`], type: src[`qType${i}`], mustBe: src[`qMustBe${i}`] });
  } else if (Array.isArray(src.screeningQuestions)) {
    raw = src.screeningQuestions;
    if (raw.length > MAX_QUESTIONS) errors.push(`ask up to ${MAX_QUESTIONS} questions`);
    raw = raw.slice(0, MAX_QUESTIONS);
  } else if (src.screeningQuestions !== undefined && src.screeningQuestions !== null && src.screeningQuestions !== '') {
    errors.push('screeningQuestions must be a list');
  }
  const questions = [];
  const seen = new Set();
  for (const item of raw) {
    const q = item && typeof item === 'object' ? item : { text: item };
    const text = tidy(q.text).slice(0, MAX_TEXT);
    if (!text) continue;
    const n = questions.length + 1;
    const type = tidy(q.type) || 'yesno';
    const mustBe = tidy(q.mustBe).toLowerCase();
    if (!TYPES.includes(type)) errors.push(`question ${n}: the answer type must be yesno or text`);
    if (mustBe && !['yes', 'no'].includes(mustBe)) errors.push(`question ${n}: the answer the job needs must be yes or no`);
    if (mustBe && type === 'text') errors.push(`question ${n}: a needed answer only works with a Yes or No question`);
    const clean = { id: idOf(text), text, type: TYPES.includes(type) ? type : 'yesno', mustBe: ['yes', 'no'].includes(mustBe) ? mustBe : '' };
    if (seen.has(clean.id)) errors.push(`question ${n} is the same as an earlier one`);
    seen.add(clean.id);
    const problem = problemWith(clean, n);
    if (problem) errors.push(problem);
    questions.push(clean);
  }
  return { questions, errors };
}

const questionsOf = (job) => (job && Array.isArray(job.screeningQuestions) ? job.screeningQuestions : []);
const hasQuestions = (job) => questionsOf(job).length > 0;
// For job seekers and the public API: never the needed answer.
const publicQuestions = (job) => questionsOf(job).map((q) => ({ id: q.id, text: q.text, type: q.type }));
const employerQuestions = (job) => questionsOf(job).map((q) => ({ id: q.id, text: q.text, type: q.type, mustBe: q.mustBe || null }));

// What was sent on an application form. Saved with a copy of each question.
function answersFrom(job, body) {
  const answers = [];
  const errors = [];
  for (const q of questionsOf(job)) {
    let answer = tidy((body || {})[fieldName(q)]);
    if (q.type === 'yesno') {
      answer = answer.toLowerCase();
      if (!['yes', 'no'].includes(answer)) { errors.push(`please answer: ${q.text}`); continue; }
    } else {
      if (!answer) { errors.push(`please answer: ${q.text}`); continue; }
      answer = answer.slice(0, MAX_ANSWER);
    }
    answers.push({ id: q.id, text: q.text, type: q.type, mustBe: q.mustBe || '', answer });
  }
  return { answers, errors };
}

const answersOf = (a) => (a && Array.isArray(a.screening) ? a.screening : []);
const missedOf = (a) => answersOf(a).filter((x) => x.mustBe && x.answer !== x.mustBe);
// 'meets', 'misses', or null when no question named a needed answer.
function outcome(a) {
  if (!answersOf(a).some((x) => x.mustBe)) return null;
  return missedOf(a).length ? 'misses' : 'meets';
}
const outcomeLabel = (a) => {
  const o = outcome(a);
  if (!o) return '';
  if (o === 'meets') return 'Has the needed answers';
  const n = missedOf(a).length;
  return `${n} answer${n === 1 ? '' : 's'} to check`;
};
const answerWords = (x) => (x.type === 'yesno' ? (x.answer === 'yes' ? 'Yes' : 'No') : x.answer);

// For the hiring team. A typed answer can hold anything, even a phone number, so
// it follows the same rule as contact details: `showTyped` is whether this person
// may see those. A Yes or No is shown to everyone who can see the applicant.
function view(a, { showTyped = true } = {}) {
  return answersOf(a).map((x) => {
    const hidden = x.type !== 'yesno' && !showTyped;
    return { text: x.text, type: x.type, answer: hidden ? null : answerWords(x), hidden, mustBe: x.mustBe || null, met: x.mustBe ? x.answer === x.mustBe : null };
  });
}
// One line for spreadsheets.
const csvText = (a) => answersOf(a).map((x) => `${x.text}: ${answerWords(x)}`).join(' | ');

module.exports = { MONEY_RE, SECRET_RE, MAX_QUESTIONS, MAX_TEXT, MAX_ANSWER, FORM_KEY, parse, questionsOf, hasQuestions, publicQuestions, employerQuestions, fieldName, answersFrom, answersOf, outcome, outcomeLabel, view, csvText, answerWords };
