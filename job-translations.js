// Reviewed translations of job listings (Step 67). The original listing stays
// the record: pay, place, dates, job type, shift and the other job details are
// always shown from it, in every language. A translation covers the words
// only (title, description, responsibilities, requirements, benefits).
//
//   1. A draft is made: by the AI assistant when it's on (ai-assistant.js,
//      feature "job-translation"), otherwise a copy of the original for the
//      employer to write over.
//   2. Checks flag what needs a person: every number in the original must
//      still be there and none added (pay, hours, dates, counts, phone
//      numbers), no new email addresses or links, nothing left empty, and text
//      left untranslated or that the AI marked as unclear.
//   3. The employer (or the Hireriv team, for jobs the team posted) edits and
//      approves it. Each approved version is kept with who approved it and when.
//   4. Candidates see it when the page is in that language, with the original
//      one click away. If the job is edited later, the translation is hidden
//      until someone approves it again.
// Moderators can withdraw any translation.
const crypto = require('crypto');
const i18n = require('./i18n');

const C = 'job-translations';
const LISTS = ['responsibilities', 'qualifications', 'benefits'];
const MAX = { title: 140, description: 4000, item: 300, items: 20 };
const iso = () => new Date().toISOString();
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const lines = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((x) => clip(x, MAX.item)).filter(Boolean).slice(0, MAX.items);

// The words of a job that a translation covers.
function sourceOf(job) {
  return {
    title: clip(job.title, MAX.title), description: clip(job.description, MAX.description),
    responsibilities: lines(job.responsibilities), qualifications: lines(job.qualifications), benefits: lines(job.benefits),
  };
}
const hashOf = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 32);
const sourceHash = (job) => hashOf(sourceOf(job));
const allText = (f) => [f.title, f.description, ...LISTS.flatMap((k) => f[k] || [])].join('\n');

// Numbers as digits (Hindi and Telugu digits become 0-9; 22,000 = 22000).
function numbersIn(text) {
  const s = i18n.normalise(text).replace(/(\d),(?=\d{2,3}\b)/g, '$1');
  return (s.match(/\d+(?:\.\d+)?/g) || []).map((n) => n.replace(/^0+(?=\d)/, ''));
}
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/gi;
const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());

// What a person must look at before approving. `blocking` ones stop approval.
function check(source, draft, unclear = []) {
  const flags = [];
  const want = count(numbersIn(allText(source)));
  const got = count(numbersIn(allText(draft)));
  const missing = [...want].filter(([n, k]) => (got.get(n) || 0) < k).map(([n]) => n);
  const added = [...got].filter(([n, k]) => (want.get(n) || 0) < k).map(([n]) => n);
  if (missing.length) flags.push({ kind: 'number-missing', blocking: true, text: `Numbers in the original that are missing: ${missing.join(', ')}. Pay, hours, dates and counts must stay exactly as in the original.` });
  if (added.length) flags.push({ kind: 'number-added', blocking: true, text: `Numbers that are not in the original: ${added.join(', ')}. A translation must not add pay, fees, dates, counts or phone numbers.` });
  const links = (t) => new Set((t.match(LINK_RE) || []).map((x) => x.toLowerCase()));
  const srcLinks = links(allText(source));
  const newLinks = [...links(allText(draft))].filter((l) => !srcLinks.has(l));
  if (newLinks.length) flags.push({ kind: 'link-added', blocking: true, text: `Links or email addresses that are not in the original: ${newLinks.join(', ')}.` });
  if (!draft.title) flags.push({ kind: 'empty', blocking: true, text: 'The title is empty.' });
  if (source.description && !draft.description) flags.push({ kind: 'empty', blocking: true, text: 'The description is empty.' });
  for (const k of LISTS) {
    if ((source[k] || []).length && (draft[k] || []).length !== source[k].length) flags.push({ kind: 'count', blocking: false, text: `The original has ${source[k].length} ${k === 'qualifications' ? 'requirements' : k}; the translation has ${(draft[k] || []).length}. Check nothing was dropped or added.` });
  }
  const same = [['title', draft.title === source.title && /[a-z]{3}/i.test(source.title)], ['description', draft.description && draft.description === source.description]].filter((x) => x[1]).map((x) => x[0]);
  if (same.length) flags.push({ kind: 'untranslated', blocking: false, text: `Still the same as the original: ${same.join(', ')}. Translate it, or keep it only if that's how candidates say it.` });
  for (const u of unclear.slice(0, 10)) flags.push({ kind: 'unclear', blocking: false, text: `Check this: ${clip(u, 200)}` });
  return flags;
}

function create(deps) {
  const { db, app, getJobs, hiring, clients, adminAuth, roles, sameOrigin, limit, site, jobPath, ai, record } = deps;
  const targets = () => i18n.offered().filter((c) => c !== i18n.DEFAULT);
  const find = (jobId, lang) => db.where(C, 'jobId', jobId).find((r) => r.lang === lang) || null;
  const save = (r) => {
    r.updatedAt = iso();
    if (!db.update(C, r)) db.prepend(C, r);
    return r;
  };
  const fresh = (job, lang) => ({
    id: `jt_${crypto.randomBytes(8).toString('hex')}`, jobId: job.id, employerId: job.employerId || '', lang, status: 'none', draft: null, flags: [], unclear: [],
    method: '', generationId: '', published: null, versions: [], history: [], createdAt: iso(), updatedAt: iso(),
  });
  const note = (r, by, action, detail = '') => r.history.unshift({ at: iso(), by, action, detail: clip(detail, 300) });

  // ---------- what candidates see ----------
  // The approved translation of a live job in this language, if it still
  // matches the listing.
  function publicFor(job, lang) {
    if (!job || !lang || lang === i18n.DEFAULT) return null;
    const r = find(job.id, lang);
    if (!r || !r.published || r.published.sourceHash !== sourceHash(job)) return null;
    return { ...r.published.fields, lang, approvedAt: r.published.approvedAt, byCompany: Boolean(r.employerId), version: r.published.version };
  }
  // Text of every approved, current translation, for search.
  const searchCache = new Map();
  // Jobs with a published translation, refreshed when translations change.
  let translated = null;
  if (db.onChange) db.onChange((c) => { if (c === C) translated = null; });
  const hasPublished = (jobId) => {
    if (!translated || !db.onChange) translated = new Set(db.all(C).filter((r) => r.published).map((r) => r.jobId));
    return translated.has(jobId);
  };
  function searchText(job) {
    if (!hasPublished(job.id)) return '';
    const key = `${job.id}|${sourceHash(job)}`;
    if (!searchCache.has(key)) {
      const txt = db.where(C, 'jobId', job.id).filter((r) => r.published && r.published.sourceHash === sourceHash(job)).map((r) => allText(r.published.fields)).join('\n');
      searchCache.set(key, txt);
    }
    return searchCache.get(key);
  }
  const forget = (jobId) => { for (const k of searchCache.keys()) if (k.startsWith(`${jobId}|`)) searchCache.delete(k); };

  // ---------- making and approving ----------
  async function makeDraft(job, lang, actor) {
    const r = find(job.id, lang) || fresh(job, lang);
    const source = sourceOf(job);
    const out = ai ? await ai.translateJob({ actorKey: actor.key, actorType: actor.type, employerId: job.employerId || '', job, source, lang, language: i18n.LANGUAGES[lang].name }) : null;
    const usedAi = Boolean(out && out.aiGenerated);
    const fields = usedAi ? out.result : source;
    r.draft = { ...fields, sourceHash: sourceHash(job) };
    r.unclear = usedAi ? out.result.unclear || [] : [];
    r.flags = check(source, r.draft, r.unclear);
    if (!usedAi) r.flags.unshift({ kind: 'manual', blocking: false, text: (out && out.warnings && out.warnings[0]) || 'The AI assistant is off, so the original is copied here: write the translation over it.' });
    r.method = usedAi ? 'ai' : 'manual';
    r.generationId = out ? out.generationId : '';
    r.status = 'draft';
    note(r, actor.name, usedAi ? 'draft-ai' : 'draft-copy');
    return save(r);
  }
  function saveDraft(job, lang, input, actor) {
    const r = find(job.id, lang) || fresh(job, lang);
    const draft = {
      title: clip(input.title, MAX.title), description: clip(input.description, MAX.description),
      responsibilities: lines(input.responsibilities), qualifications: lines(input.qualifications), benefits: lines(input.benefits), sourceHash: sourceHash(job),
    };
    r.draft = draft;
    r.flags = check(sourceOf(job), draft, r.unclear || []);
    if (!r.method) r.method = 'manual';
    else if (r.method === 'ai') r.method = 'ai-edited';
    r.status = 'draft';
    note(r, actor.name, 'edited');
    return save(r);
  }
  function approve(job, lang, actor, confirmed) {
    const r = find(job.id, lang);
    if (!r || !r.draft) return { errors: ['there is no draft to approve'] };
    if (!confirmed) return { errors: ['confirm that you checked the translation against the original'] };
    if (r.draft.sourceHash !== sourceHash(job)) return { errors: ['the job changed after this draft was made: check the draft against the new original and save it again'] };
    r.flags = check(sourceOf(job), r.draft, r.unclear || []);
    const blocking = r.flags.filter((f) => f.blocking);
    if (blocking.length) { save(r); return { errors: blocking.map((f) => f.text) }; }
    const fields = { title: r.draft.title, description: r.draft.description, responsibilities: r.draft.responsibilities, qualifications: r.draft.qualifications, benefits: r.draft.benefits };
    const version = (r.versions.length ? r.versions[0].version : 0) + 1;
    r.published = { fields, sourceHash: r.draft.sourceHash, approvedAt: iso(), approvedBy: actor.name, approvedById: actor.id, version, method: r.method };
    r.versions.unshift({ version, approvedAt: r.published.approvedAt, approvedBy: actor.name, hash: hashOf(fields), sourceHash: r.draft.sourceHash, fields });
    r.versions = r.versions.slice(0, 20);
    r.status = 'approved';
    note(r, actor.name, 'approved', `version ${version}`);
    if (r.generationId && ai && ai.markReviewed) ai.markReviewed(r.generationId, actor.key, 'used');
    save(r);
    forget(job.id);
    return { errors: [], record: r };
  }
  function withdraw(job, lang, actor, reason) {
    const r = find(job.id, lang);
    if (!r || !r.published) return { errors: ['nothing is published in this language'] };
    r.published = null;
    r.status = r.draft ? 'draft' : 'none';
    r.withdrawnAt = iso();
    note(r, actor.name, 'withdrawn', reason);
    save(r);
    forget(job.id);
    return { errors: [] };
  }
  // Removed with the job (and with an employer's data).
  const removeFor = (jobId) => { db.remove(C, db.where(C, 'jobId', jobId).map((r) => r.id)); forget(jobId); };

  // ---------- the pages ----------
  function view(req, res, { job, lang, ctx, base, back, canEdit, canWithdraw, errors = [], status = 200 }) {
    const r = find(job.id, lang);
    const current = sourceHash(job);
    res.set('Cache-Control', 'no-store');
    res.status(status).render('job-translation', {
      title: `Translate: ${job.title}`, page: ctx === 'employer' ? 'employer' : 'admin', noindex: true, tab: 'jobs', ctx, job, lang, language: i18n.LANGUAGES[lang], targets: targets().map((c) => ({ code: c, ...i18n.LANGUAGES[c], status: (find(job.id, c) || {}).status || 'none' })),
      source: sourceOf(job), rec: r, draft: r && r.draft ? r.draft : null, stale: Boolean(r && r.published && r.published.sourceHash !== current), draftStale: Boolean(r && r.draft && r.draft.sourceHash !== current),
      base, back, canEdit, canWithdraw, errors, msg: clip(req.query.msg, 300), publicUrl: `${jobPath(job)}?lang=${lang}`, aiOn: Boolean(ai && ai.translationAvailable && ai.translationAvailable()),
      ...(ctx === 'admin' ? deps.adminNav(req) : {}), admin: req.admin,
    });
  }
  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const validLang = (req, res, next) => (targets().includes(req.params.lang) ? next() : next('route'));
  const go = (res, base, msg) => res.redirect(303, `${base}?msg=${encodeURIComponent(msg)}`);

  // The employer's own jobs: members who may edit the job (employer-hiring.js).
  const empActor = (req) => ({ type: 'employer', key: `emp-user:${req.employerUser.id}`, id: req.employerUser.id, name: `${req.employerUser.name} (${req.employer.company})` });
  const empBase = (req) => `/employer/jobs/${req.job.id}/translations/${req.params.lang}`;
  const audit = (req, action, detail) => clients.team.audit(req.employer.id, req.employerUser, action, detail);
  const emp = [validLang, hiring.withJob('job.edit')];
  const empView = (req, res, extra = {}) => view(req, res, { job: req.job, lang: req.params.lang, ctx: 'employer', base: empBase(req), back: '/employer/jobs', canEdit: true, canWithdraw: true, ...extra });
  app.get('/employer/jobs/:id/translations/:lang', clients.requireEmployer, ...emp, (req, res) => empView(req, res));
  app.post('/employer/jobs/:id/translations/:lang/draft', clients.requireEmployer, ...emp, limit('job-translation', 20), sameOrigin, route(async (req, res) => {
    const r = await makeDraft(req.job, req.params.lang, empActor(req));
    audit(req, 'job-translation-drafted', `${req.job.title} (${req.job.id}) → ${req.params.lang}`);
    go(res, empBase(req), r.method === 'ai' ? 'A draft is ready. Check it against the original, edit it and approve it.' : 'The original is copied below: write the translation over it, then approve it.');
  }));
  app.post('/employer/jobs/:id/translations/:lang', clients.requireEmployer, ...emp, limit('job-translation', 60), sameOrigin, (req, res) => {
    saveDraft(req.job, req.params.lang, req.body || {}, empActor(req));
    go(res, empBase(req), 'Draft saved. It is not shown to candidates until you approve it.');
  });
  app.post('/employer/jobs/:id/translations/:lang/approve', clients.requireEmployer, ...emp, limit('job-translation', 30), sameOrigin, (req, res) => {
    const out = approve(req.job, req.params.lang, empActor(req), (req.body || {}).confirm === '1');
    if (out.errors.length) return empView(req, res, { errors: out.errors, status: 400 });
    audit(req, 'job-translation-approved', `${req.job.title} (${req.job.id}) → ${req.params.lang}, version ${out.record.published.version}`);
    go(res, empBase(req), 'Approved. Candidates who use this language now see the translation, with the original one click away.');
  });
  app.post('/employer/jobs/:id/translations/:lang/withdraw', clients.requireEmployer, ...emp, limit('job-translation', 30), sameOrigin, (req, res) => {
    const out = withdraw(req.job, req.params.lang, empActor(req), 'withdrawn by the employer');
    if (!out.errors.length) audit(req, 'job-translation-withdrawn', `${req.job.title} (${req.job.id}) → ${req.params.lang}`);
    go(res, empBase(req), out.errors.length ? out.errors[0] : 'Withdrawn. Candidates see the original listing.');
  });

  // The team: translations of jobs the team posted, and withdrawing any
  // translation (moderators), with a reason in the audit history.
  const teamJob = (req, res, next) => {
    const job = getJobs().find((j) => j.id === req.params.id);
    if (!job) return next('route');
    req.job = job;
    next();
  };
  const ownedByTeam = (job) => job.createdBy !== 'employer';
  const teamActor = (req) => ({ type: 'team', key: `team:${req.admin.id}`, id: req.admin.id, name: `${req.admin.name || req.admin.email} (${site.name})` });
  const teamBase = (req) => `/admin/jobs/${req.job.id}/translations/${req.params.lang}`;
  const teamFlags = (req) => ({ canEdit: ownedByTeam(req.job), canWithdraw: ownedByTeam(req.job) || roles.can(req.admin, 'jobs.moderate') });
  const team = [validLang, teamJob];
  const teamView = (req, res, extra = {}) => view(req, res, { job: req.job, lang: req.params.lang, ctx: 'admin', base: teamBase(req), back: `/admin/jobs/${req.job.id}/edit`, ...teamFlags(req), ...extra });
  const teamEdit = (req, res, next) => (ownedByTeam(req.job) ? next() : res.status(403).send('This job belongs to an employer: they translate it. Moderators can withdraw a translation.'));
  app.get('/admin/jobs/:id/translations/:lang', adminAuth, ...team, (req, res) => teamView(req, res));
  app.post('/admin/jobs/:id/translations/:lang/draft', adminAuth, ...team, teamEdit, limit('job-translation', 20), sameOrigin, route(async (req, res) => {
    const r = await makeDraft(req.job, req.params.lang, teamActor(req));
    go(res, teamBase(req), r.method === 'ai' ? 'A draft is ready. Check it, edit it and approve it.' : 'The original is copied below: write the translation over it.');
  }));
  app.post('/admin/jobs/:id/translations/:lang', adminAuth, ...team, teamEdit, limit('job-translation', 60), sameOrigin, (req, res) => {
    saveDraft(req.job, req.params.lang, req.body || {}, teamActor(req));
    go(res, teamBase(req), 'Draft saved.');
  });
  app.post('/admin/jobs/:id/translations/:lang/approve', adminAuth, ...team, teamEdit, limit('job-translation', 30), sameOrigin, (req, res) => {
    const out = approve(req.job, req.params.lang, teamActor(req), (req.body || {}).confirm === '1');
    if (out.errors.length) return teamView(req, res, { errors: out.errors, status: 400 });
    record(req.admin, 'job-translation-approved', { entityType: 'job', entityId: req.job.id, detail: `${req.params.lang}, version ${out.record.published.version}` });
    go(res, teamBase(req), 'Approved and shown to candidates in this language.');
  });
  app.post('/admin/jobs/:id/translations/:lang/withdraw', adminAuth, ...team, limit('job-translation', 30), sameOrigin, (req, res) => {
    const { canWithdraw } = teamFlags(req);
    if (!canWithdraw) return res.status(403).send('Only moderators can withdraw an employer\'s translation.');
    const reason = clip((req.body || {}).reason, 300);
    if (reason.length < 5) return teamView(req, res, { errors: ['give a reason (at least 5 characters)'], status: 400 });
    const out = withdraw(req.job, req.params.lang, teamActor(req), reason);
    if (!out.errors.length) record(req.admin, 'job-translation-withdrawn', { entityType: 'job', entityId: req.job.id, reason, detail: req.params.lang });
    go(res, teamBase(req), out.errors.length ? out.errors[0] : 'Withdrawn.');
  });

  // Status of each language for a list of jobs (the jobs pages link here).
  function statusFor(job) {
    return targets().map((code) => {
      const r = find(job.id, code);
      const live = Boolean(r && r.published && r.published.sourceHash === sourceHash(job));
      return { code, native: i18n.LANGUAGES[code].native, state: live ? 'approved' : r && r.published ? 'outdated' : r && r.draft ? 'draft' : 'none' };
    });
  }

  return { publicFor, searchText, statusFor, makeDraft, saveDraft, approve, withdraw, removeFor, sourceOf, sourceHash, targets };
}

module.exports = { create, check, numbersIn, sourceOf, sourceHash, COLLECTION: C };
