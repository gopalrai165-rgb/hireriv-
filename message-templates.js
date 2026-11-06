// Saved replies: words a hiring team sends often, kept once and picked when
// writing to an applicant. Each company has its own list and the Hireriv team has
// one. Picking a reply only fills the box: a person reads it and presses Send, and
// messages.check() still runs on what is sent. Replies that ask for money, codes
// or passwords can't be saved either.
const crypto = require('crypto');
const { can } = require('./employer-team');
const agencyRoles = require('./agency-roles');
const { MAX_TEXT, contentProblem } = require('./messages');

const COLLECTION = 'message-templates';
const MAX_PER_LIST = 30;
const MAX_NAME = 60;
const FIELDS = ['name', 'job', 'company'];

// Checks a reply before it is saved. `others` are the rest of the list.
function parse(body, others) {
  const name = String((body || {}).name ?? '').trim().replace(/\s+/g, ' ');
  const text = String((body || {}).text ?? '').replace(/\r\n/g, '\n').trim();
  if (!name) return { error: 'give the reply a short name' };
  if (name.length > MAX_NAME) return { error: `keep the name under ${MAX_NAME} characters` };
  if (!text) return { error: 'write the reply first' };
  if (text.length > MAX_TEXT) return { error: `keep the reply under ${MAX_TEXT} characters` };
  const problem = contentProblem(text);
  if (problem) return { error: problem };
  const unknown = (text.match(/\{[^{}]*\}/g) || []).find((x) => !FIELDS.includes(x.slice(1, -1)));
  if (unknown) return { error: `${unknown} isn't something we can fill in. Use {name}, {job} or {company}` };
  if (others.some((x) => x.name.toLowerCase() === name.toLowerCase())) return { error: 'you already have a reply with that name' };
  return { name, text };
}

// The words for one applicant. {name} is the first name.
function fill(text, { name = '', job = '', company = '' } = {}) {
  const values = { name: String(name).trim().split(/\s+/)[0] || '', job, company };
  return String(text).replace(/\{(name|job|company)\}/g, (_, k) => values[k]);
}

function register(app, { readSubmissions, writeSubmissions, saveSubmission, sameOrigin, limit, adminAuth, clients, teamLog }) {
  const { requireEmployer } = clients;
  const listOf = (owner) => readSubmissions(COLLECTION).filter((x) => x.owner === owner).sort((a, b) => a.name.localeCompare(b.name));
  const employerList = (employerId) => listOf(`employer:${employerId}`);
  const teamList = () => listOf('team');

  function create(owner, by, body) {
    const mine = listOf(owner);
    if (mine.length >= MAX_PER_LIST) return { error: `your list is full (${MAX_PER_LIST}). Delete one first` };
    const r = parse(body, mine);
    if (r.error) return r;
    saveSubmission(COLLECTION, { id: crypto.randomUUID(), owner, name: r.name, text: r.text, createdBy: by });
    return { name: r.name };
  }
  function update(owner, id, by, body) {
    const all = readSubmissions(COLLECTION);
    const t = all.find((x) => x.id === id && x.owner === owner);
    if (!t) return { missing: true };
    const r = parse(body, all.filter((x) => x.owner === owner && x.id !== id));
    if (r.error) return r;
    Object.assign(t, { name: r.name, text: r.text, updatedBy: by, updatedAt: new Date().toISOString() });
    writeSubmissions(COLLECTION, all);
    return { name: r.name };
  }
  function remove(owner, id) {
    const all = readSubmissions(COLLECTION);
    const t = all.find((x) => x.id === id && x.owner === owner);
    if (!t) return { missing: true };
    writeSubmissions(COLLECTION, all.filter((x) => x !== t));
    return { name: t.name };
  }
  const redirectTo = (res, base, msg) => res.redirect(303, `${base}?msg=${encodeURIComponent(msg)}`);
  const said = (r, done) => (r.error ? `Not saved: ${r.error}.` : done);
  const view = (res, locals) => res.render('message-templates', { title: 'Saved replies', noindex: true, max: MAX_PER_LIST, maxName: MAX_NAME, maxText: MAX_TEXT, ...locals });

  // ---------- employer portal ----------
  const EMP = '/employer/message-templates';
  const mayWrite = (req) => can(req.member, 'templates.manage');
  app.get('/employer/message-templates', requireEmployer, (req, res) => {
    if (!mayWrite(req)) return clients.forbid(req, res);
    view(res, { page: 'employer', side: 'employer', base: EMP, items: employerList(req.employer.id), msg: String(req.query.msg || '') });
  });
  app.post('/employer/message-templates', requireEmployer, limit('message-templates', 60), sameOrigin, (req, res) => {
    if (!mayWrite(req)) return clients.forbid(req, res);
    const r = create(`employer:${req.employer.id}`, req.employerUser.id, req.body);
    if (!r.error) clients.team.audit(req.employer.id, req.employerUser, 'saved-reply-added', r.name);
    redirectTo(res, EMP, said(r, 'Saved.'));
  });
  app.post('/employer/message-templates/:id', requireEmployer, limit('message-templates', 60), sameOrigin, (req, res) => {
    if (!mayWrite(req)) return clients.forbid(req, res);
    const r = update(`employer:${req.employer.id}`, req.params.id, req.employerUser.id, req.body);
    if (r.missing) return redirectTo(res, EMP, 'That reply is no longer here.');
    if (!r.error) clients.team.audit(req.employer.id, req.employerUser, 'saved-reply-changed', r.name);
    redirectTo(res, EMP, said(r, 'Saved.'));
  });
  app.post('/employer/message-templates/:id/delete', requireEmployer, limit('message-templates', 60), sameOrigin, (req, res) => {
    if (!mayWrite(req)) return clients.forbid(req, res);
    const r = remove(`employer:${req.employer.id}`, req.params.id);
    if (r.missing) return redirectTo(res, EMP, 'That reply is no longer here.');
    clients.team.audit(req.employer.id, req.employerUser, 'saved-reply-deleted', r.name);
    redirectTo(res, EMP, 'Deleted.');
  });

  // ---------- the Hireriv team ----------
  const TEAM = '/admin/message-templates';
  const teamMay = (req) => agencyRoles.can(req.admin, 'candidates.message');
  const teamNo = (res) => res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include writing to candidates.' });
  app.get('/admin/message-templates', adminAuth, (req, res) => {
    if (!teamMay(req)) return teamNo(res);
    view(res, { page: 'admin', side: 'team', base: TEAM, items: teamList(), msg: String(req.query.msg || '') });
  });
  app.post('/admin/message-templates', adminAuth, limit('message-templates', 60), sameOrigin, (req, res) => {
    if (!teamMay(req)) return teamNo(res);
    const r = create('team', req.admin.id, req.body);
    if (!r.error) teamLog(req.admin, 'Added a saved reply', r.name);
    redirectTo(res, TEAM, said(r, 'Saved.'));
  });
  app.post('/admin/message-templates/:id', adminAuth, limit('message-templates', 60), sameOrigin, (req, res) => {
    if (!teamMay(req)) return teamNo(res);
    const r = update('team', req.params.id, req.admin.id, req.body);
    if (r.missing) return redirectTo(res, TEAM, 'That reply is no longer here.');
    if (!r.error) teamLog(req.admin, 'Changed a saved reply', r.name);
    redirectTo(res, TEAM, said(r, 'Saved.'));
  });
  app.post('/admin/message-templates/:id/delete', adminAuth, limit('message-templates', 60), sameOrigin, (req, res) => {
    if (!teamMay(req)) return teamNo(res);
    const r = remove('team', req.params.id);
    if (r.missing) return redirectTo(res, TEAM, 'That reply is no longer here.');
    teamLog(req.admin, 'Deleted a saved reply', r.name);
    redirectTo(res, TEAM, 'Deleted.');
  });

  return { employerList, teamList };
}

module.exports = { register, parse, fill, MAX_PER_LIST };
