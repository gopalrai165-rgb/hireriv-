// Messages about one application, between the people hiring for the job and
// the person who applied. Kept on the application (`messages`), so they follow
// it into the candidate's data download and go when the application is deleted.
//
// Rules:
// - the hiring side starts a conversation; a candidate can only reply, so
//   nobody can message companies out of the blue;
// - no new messages once the candidate withdraws;
// - the hiring side can't ask for money, codes or passwords: those are how job
//   scams work, so the message is refused (screening.js has the same words);
// - emails only say there is a message, never what it says, so the full
//   conversation stays where it can be reported.
const crypto = require('crypto');
const { MONEY_RE, SECRET_RE } = require('./screening');

const MAX_TEXT = 2000;
const MAX_MESSAGES = 200;

const listOf = (a) => (a && Array.isArray(a.messages) ? a.messages : []);
const started = (a) => listOf(a).some((m) => m.from !== 'candidate');

// What the hiring side can't write. Also checked when a saved reply is kept.
function contentProblem(t) {
  if (MONEY_RE.test(t)) return 'messages can’t ask candidates to pay. Job seekers must never pay for a job';
  if (SECRET_RE.test(t)) return 'messages can’t ask for a code, PIN or password';
  return '';
}

function check(a, text, from) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return { error: 'write a message first' };
  if (t.length > MAX_TEXT) return { error: `keep it under ${MAX_TEXT} characters` };
  if (!a) return { error: 'application not found' };
  if (a.withdrawnAt) return { error: 'the candidate withdrew this application, so it can no longer get messages' };
  if (from === 'candidate' && !started(a)) return { error: 'you can reply once the hiring team writes to you' };
  if (from !== 'candidate' && contentProblem(t)) return { error: contentProblem(t) };
  if (listOf(a).length >= MAX_MESSAGES) return { error: 'this conversation is full. Please call or email instead' };
  return { text: t };
}

// Adds a message (after check()). `by` is the sender's name, as the other side sees it.
function add(a, { from, by, userId = '', text }) {
  const m = { id: crypto.randomUUID(), at: new Date().toISOString(), from, by: String(by || '').slice(0, 120), ...(userId ? { userId } : {}), text, readAt: null };
  a.messages = [...listOf(a), m];
  return m;
}

// Marks what the other side wrote as read by `reader` ('candidate' or 'hiring').
function markRead(a, reader) {
  let changed = false;
  const at = new Date().toISOString();
  for (const m of listOf(a)) {
    const theirs = reader === 'candidate' ? m.from !== 'candidate' : m.from === 'candidate';
    if (theirs && !m.readAt) { m.readAt = at; changed = true; }
  }
  return changed;
}

const unreadFor = (a, reader) => listOf(a).filter((m) => !m.readAt && (reader === 'candidate' ? m.from !== 'candidate' : m.from === 'candidate')).length;
const lastOf = (a) => listOf(a).at(-1) || null;

module.exports = { contentProblem, MAX_TEXT, MAX_MESSAGES, listOf, started, check, add, markRead, unreadFor, lastOf };
