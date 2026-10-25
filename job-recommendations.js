// For signed-in candidates: recommended jobs with an explanation of each match,
// saved searches with job alerts (as they happen, daily or weekly), and filling
// the profile from a resume after checking and correcting what was read.
//
// Saved searches are the job alerts (`job-alerts`) of a signed-in candidate,
// with a name, the full set of search filters, an on/off switch and a
// frequency. Alerts set up without an account keep working as before (one
// category and city, confirmed by email, sent as jobs go live).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jm = require('./job-match');
const cp = require('./candidate-profile');

const FREQUENCIES = ['instant', 'daily', 'weekly'];
const FREQUENCY_TEXT = { instant: 'As soon as a job is posted', daily: 'Once a day', weekly: 'Once a week' };
const PERIOD_MS = { daily: 86400000, weekly: 7 * 86400000 };
const MAX_SAVED_SEARCHES = 20;
const MAX_PENDING = 50; // jobs waiting for a daily or weekly email
const DIGEST_JOBS = 10; // jobs listed in one daily or weekly email
const RECOMMEND_MIN_SCORE = 40;
const FILTER_KEYS = ['q', 'location', 'categories', 'type', 'mode', 'work', 'group', 'experience', 'minPay', 'skills', 'company', 'shift'];
const INPUT_KEYS = ['name', 'filters', 'alertEnabled', 'frequency'];

const lower = (s) => String(s || '').trim().toLowerCase();
const bool = (v) => (v === true || v === 'true' || v === '1' || v === 'on' ? true : v === false || v === 'false' || v === '0' || v === '' ? false : null);
// Only the filters that are set, in a fixed order, so equal searches compare equal.
const compact = (f) => Object.fromEntries(FILTER_KEYS.map((k) => [k, f[k]]).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
// Letter case doesn't make a search different: "forklift" is "Forklift".
const sameFilters = (a, b) => JSON.stringify(compact(a)).toLowerCase() === JSON.stringify(compact(b)).toLowerCase();

function register(app, deps) {
  const { readSubmissions, writeSubmissions, saveSubmission, sameOrigin, limit, site, getJobs, isLive, isSample, jobPath } = deps;
  const { parseFilters, matchesFilters, searchHref, describeFilters, events, upload, vetUpload, resumes, allJobSkills, uploadsDir } = deps;
  const C = deps.candidates;
  const nowIso = () => new Date().toISOString();

  // ---------- the candidate's facts for matching ----------
  function factsFor(email) {
    const c = C.ensureCandidate(email);
    const flat = C.profileFor(email);
    return jm.facts(c.profile, { skills: flat.skills, resumeSkills: flat.resumeSkills, experience: flat.experience, location: flat.location, noticePeriod: flat.noticePeriod });
  }
  const weights = () => jm.weightsOf(site);
  const publicJobs = () => getJobs().filter((j) => isLive(j) && !isSample(j));
  const matchFor = (email, job) => jm.explain(factsFor(email), job, weights());

  // ---------- saved searches ----------
  const subsOf = (email) => readSubmissions('job-alerts').filter((s) => s.email === email && s.confirmed);
  // Alerts from before saved searches had one category and city.
  const filtersOf = (sub) => (sub.filters ? sub.filters : compact({ categories: sub.category ? [sub.category] : [], location: sub.location || '' }));
  const frequencyOf = (sub) => (FREQUENCIES.includes(sub.frequency) ? sub.frequency : 'instant');
  // Those older alerts also include remote jobs, as they always did.
  const matchesSub = (sub, job) => (sub.filters
    ? matchesFilters(job, sub.filters)
    : (!sub.category || sub.category === job.category) && (!sub.location || sub.location === job.location || job.mode === 'Remote'));
  function view(sub) {
    const filters = filtersOf(sub);
    return {
      id: sub.id, name: sub.name || describeFilters(filters), filters, description: describeFilters(filters),
      alertEnabled: sub.alertEnabled !== false, frequency: frequencyOf(sub), frequencyText: FREQUENCY_TEXT[frequencyOf(sub)],
      href: searchHref(filters), createdAt: sub.createdAt, updatedAt: sub.updatedAt || sub.createdAt,
    };
  }

  // Checks a new or changed saved search. `existing` is the stored one when
  // changing it; only the parts sent are changed then.
  function parseInput(body, existing = null, { strict = false } = {}) {
    const errors = [];
    const out = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: ['send the saved search as an object'], out };
    if (strict) for (const k of Object.keys(body)) if (!INPUT_KEYS.includes(k)) errors.push(`${k} is not a saved search field`);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    if (has('name')) {
      const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length > 150) errors.push('name must be 150 characters or fewer');
      out.name = name.slice(0, 150);
    }
    if (has('filters') || !existing) {
      const raw = has('filters') ? body.filters : {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('filters must be an object of search filters');
      else {
        const known = ['q', 'keyword', 'location', 'city', 'state', 'category', 'categories', 'type', 'employmentType', 'mode', 'workArrangement', 'work', 'group', 'experience', 'minPay', 'skill', 'skills', 'company', 'shift'];
        if (strict) for (const k of Object.keys(raw)) if (!known.includes(k)) errors.push(`filters.${k} is not a search filter`);
        const r = parseFilters(raw);
        errors.push(...r.errors);
        out.filters = compact(r.filters);
      }
    }
    if (has('alertEnabled')) {
      const v = bool(body.alertEnabled);
      if (v === null) errors.push('alertEnabled must be true or false');
      else out.alertEnabled = v;
    }
    if (has('frequency')) {
      if (!FREQUENCIES.includes(body.frequency)) errors.push(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
      else out.frequency = body.frequency;
    }
    return { errors: [...new Set(errors)], out };
  }

  function createSearch(email, input, opts = {}) {
    const { errors, out } = parseInput(input, null, opts);
    if (errors.length) return { status: 400, errors };
    const mine = subsOf(email);
    const same = mine.find((s) => sameFilters(filtersOf(s), out.filters));
    if (same) return { status: 200, existed: true, sub: same };
    if (mine.length >= MAX_SAVED_SEARCHES) return { status: 409, errors: [`you can keep up to ${MAX_SAVED_SEARCHES} saved searches; delete one first`] };
    const now = nowIso();
    const sub = saveSubmission('job-alerts', {
      email, name: out.name || describeFilters(out.filters), filters: out.filters, alertEnabled: out.alertEnabled !== false, frequency: out.frequency || 'daily',
      confirmed: true, confirmedAt: now, updatedAt: now, pending: [], lastDigestAt: null, token: crypto.randomBytes(24).toString('hex'),
    });
    C.activity(email, 'saved-search-added', sub.name);
    return { status: 201, sub };
  }
  function updateSearch(email, id, input, opts) {
    const list = readSubmissions('job-alerts');
    const sub = list.find((s) => s.id === id && s.email === email && s.confirmed);
    if (!sub) return { status: 404, errors: ['saved search not found'] };
    const { errors, out } = parseInput(input, sub, opts);
    if (errors.length) return { status: 400, errors };
    if (out.filters && !sameFilters(out.filters, filtersOf(sub)) && list.some((s) => s !== sub && s.email === email && s.confirmed && sameFilters(filtersOf(s), out.filters))) {
      return { status: 409, errors: ['you already have a saved search with these filters'] };
    }
    // An older alert becomes a full saved search the first time it's changed.
    if (!sub.filters) { sub.filters = filtersOf(sub); delete sub.category; delete sub.location; }
    Object.assign(sub, out, { updatedAt: nowIso() });
    if (!sub.name) sub.name = describeFilters(sub.filters);
    if (sub.alertEnabled === false || out.filters) sub.pending = [];
    writeSubmissions('job-alerts', list);
    return { status: 200, sub };
  }
  function deleteSearch(email, id) {
    const list = readSubmissions('job-alerts');
    const rest = list.filter((s) => !(s.id === id && s.email === email));
    if (rest.length === list.length) return false;
    writeSubmissions('job-alerts', rest);
    return true;
  }

  // A job has just gone live: instant alerts go now (one per person, however
  // many of their searches match); daily and weekly ones wait for their email.
  function dispatch(job) {
    const list = readSubmissions('job-alerts');
    const subs = list.filter((s) => s.confirmed && s.alertEnabled !== false && matchesSub(s, job));
    const instant = subs.filter((s) => frequencyOf(s) === 'instant');
    const later = subs.filter((s) => frequencyOf(s) !== 'instant');
    if (later.length) {
      for (const s of later) {
        s.pending = [...new Set([...(s.pending || []), job.id])].slice(-MAX_PENDING);
      }
      writeSubmissions('job-alerts', list);
    }
    if (instant.length) events.jobAlerts(job, instant);
    return new Set(subs.map((s) => s.email)).size;
  }

  // Daily and weekly emails that are due (run every hour).
  function digestScan(now = Date.now()) {
    const list = readSubmissions('job-alerts');
    const byId = new Map(getJobs().map((j) => [j.id, j]));
    const due = [];
    let changed = false;
    for (const s of list) {
      const f = frequencyOf(s);
      if (f === 'instant' || !s.confirmed || s.alertEnabled === false || !(s.pending || []).length) continue;
      const last = Date.parse(s.lastDigestAt || s.confirmedAt || s.createdAt);
      // A few minutes' slack so an hourly check doesn't slip a whole hour.
      if (now - last < PERIOD_MS[f] - 10 * 60000) continue;
      const jobs = s.pending.map((id) => byId.get(id)).filter((j) => j && isLive(j) && !isSample(j) && matchesSub(s, j));
      s.pending = [];
      s.lastDigestAt = new Date(now).toISOString();
      changed = true;
      if (jobs.length) due.push([s, jobs]);
    }
    if (!changed) return 0;
    writeSubmissions('job-alerts', list);
    let sent = 0;
    for (const [s, jobs] of due) sent += events.jobDigest(s, jobs.slice(0, DIGEST_JOBS), view(s)) ? 1 : 0;
    return sent;
  }

  // ---------- recommendations ----------
  const words = (s) => lower(s).split(/[^\p{L}\p{N}+#.]+/u).filter((w) => w.length >= 3);
  // Open jobs for this person, best first, each with why: the match itself, a
  // saved search it fits, a category they chose, the roles they want, and
  // likeness to jobs they saved. Jobs they applied to or saved are left out.
  function recommend(email, { limit: max = 20 } = {}) {
    const f = factsFor(email);
    const w = weights();
    const applied = new Set(C.mine(email).filter((a) => !a.withdrawnAt).map((a) => a.jobId));
    const savedIds = new Set(C.savedOf(email).map((s) => s.jobId));
    const all = getJobs();
    const savedJobs = all.filter((j) => savedIds.has(j.id));
    const savedCats = new Set(savedJobs.map((j) => j.category));
    const savedSkills = new Set(savedJobs.flatMap((j) => j.skills || []).map(lower));
    const searches = subsOf(email);
    const roleWords = words(f.roles);
    const newest = (a, b) => String(b.job.posted || '').localeCompare(String(a.job.posted || '')) || String(a.job.id).localeCompare(String(b.job.id));
    return all
      .filter((j) => isLive(j) && !isSample(j) && !applied.has(j.id) && !savedIds.has(j.id))
      .map((job) => {
        const match = jm.explain(f, job, w);
        const reasons = [];
        let boost = 0;
        const search = searches.find((s) => matchesSub(s, job));
        if (search) { reasons.push(`Fits your saved search “${view(search).name}”`); boost += 10; }
        if (f.categories.includes(job.category)) { reasons.push(`In ${job.category}, a category you chose`); boost += 8; }
        if (roleWords.some((x) => lower(job.title).includes(x))) { reasons.push('Close to the roles you want'); boost += 8; }
        if (savedCats.has(job.category) || (job.skills || []).some((s) => savedSkills.has(lower(s)))) { reasons.push('Like jobs you saved'); boost += 6; }
        return { job, match, reasons, rank: (match.score ?? 0) + boost };
      })
      // A good overall score is not enough when the job's skills are known and
      // the person has none of them; another reason (a saved search…) still counts.
      .filter((x) => x.reasons.length || (x.match.score !== null && x.match.score >= RECOMMEND_MIN_SCORE && x.match.factors[0].status !== 'unmet'))
      .sort((a, b) => b.rank - a.rank || newest(a, b))
      .slice(0, max);
  }

  // ---------- JSON shapes ----------
  const jobBrief = (j) => ({ id: j.id, title: j.title, company: j.company, location: j.location, workArrangement: j.mode, employmentType: j.type, payText: j.salary || null, url: jobPath(j) });
  const matchJson = (m) => ({
    score: m.score, level: m.level, label: m.label, version: m.version, note: m.note,
    factors: m.factors.map(({ key, label, weight, status, detail }) => ({ key, label, weight, status, detail })),
    matchedSkills: m.skills.matched, missingSkills: m.skills.missing,
    requirements: m.requirements.map(({ label, met, detail }) => ({ label, met, detail })),
  });
  const searchJson = (sub) => {
    const v = view(sub);
    return { id: v.id, name: v.name, filters: v.filters, description: v.description, alertEnabled: v.alertEnabled, frequency: v.frequency, url: v.href, createdAt: v.createdAt, updatedAt: v.updatedAt };
  };
  const jsonErrors = (res, status, errors) => res.status(status).json({ ok: false, errors: [].concat(errors) });

  // ---------- pages ----------
  app.get('/account/recommendations', C.requireCandidate, (req, res) => {
    const s = C.shell(req.candidateEmail, 'recommendations');
    C.page(res, 'account-recommendations', { title: 'Recommended jobs', ...s, items: recommend(req.candidateEmail, { limit: 30 }), msg: String(req.query.msg || '').slice(0, 200) });
  });

  app.get('/account/saved-searches', C.requireCandidate, (req, res) => {
    const s = C.shell(req.candidateEmail, 'saved-searches');
    const live = publicJobs();
    const searches = subsOf(req.candidateEmail).map((sub) => ({ ...view(sub), count: live.filter((j) => matchesSub(sub, j)).length }));
    C.page(res, 'account-saved-searches', { title: 'Saved searches', ...s, searches, frequencies: FREQUENCY_TEXT, max: MAX_SAVED_SEARCHES, msg: String(req.query.msg || '').slice(0, 200) });
  });
  // From the Find Jobs page: the current filters arrive as form fields.
  app.post('/account/saved-searches', C.requireCandidate, limit('saved-searches', 30), sameOrigin, (req, res) => {
    const { name, frequency, alertEnabled, ...filters } = req.body || {};
    const r = createSearch(req.candidateEmail, { name: name ?? '', filters, frequency: frequency || 'daily', alertEnabled: alertEnabled === undefined ? true : alertEnabled });
    if (r.errors) return C.back(res, r.errors.join(' '), '/account/saved-searches');
    C.back(res, r.existed ? 'You already saved this search.' : 'Search saved. We\'ll email you new jobs that match.', '/account/saved-searches');
  });
  app.post('/account/saved-searches/:id', C.requireCandidate, limit('saved-searches', 60), sameOrigin, (req, res, next) => {
    const b = req.body || {};
    const r = updateSearch(req.candidateEmail, req.params.id, { name: b.name ?? '', alertEnabled: b.alertEnabled === '1', ...(b.frequency ? { frequency: b.frequency } : {}) });
    if (r.status === 404) return next();
    if (r.errors) return C.back(res, r.errors.join(' '), '/account/saved-searches');
    C.back(res, 'Saved search updated.', '/account/saved-searches');
  });
  app.post('/account/saved-searches/:id/delete', C.requireCandidate, limit('saved-searches', 60), sameOrigin, (req, res, next) => {
    if (!deleteSearch(req.candidateEmail, req.params.id)) return next();
    C.back(res, 'Saved search deleted.', '/account/saved-searches');
  });

  // ---------- JSON API ----------
  app.get('/api/candidate/recommendations', C.requireCandidateApi, limit('recommendations', 60, 60 * 1000), (req, res) => {
    const raw = req.query.limit;
    if (raw !== undefined && !(/^\d{1,2}$/.test(String(raw)) && +raw >= 1 && +raw <= 50)) return jsonErrors(res, 400, 'limit must be a whole number from 1 to 50');
    const items = recommend(req.candidateEmail, { limit: raw ? +raw : 20 });
    res.json({ ok: true, recommendations: items.map((x) => ({ job: jobBrief(x.job), reasons: x.reasons, match: matchJson(x.match) })) });
  });
  app.get('/api/jobs/:id/match', C.requireCandidateApi, limit('job-match', 120, 60 * 1000), (req, res) => {
    const job = getJobs().find((j) => j.id === req.params.id);
    if (!job || !isLive(job) || isSample(job)) return jsonErrors(res, 404, 'job not found or no longer open');
    res.json({ ok: true, job: jobBrief(job), match: matchJson(matchFor(req.candidateEmail, job)) });
  });
  app.get('/api/candidate/saved-searches', C.requireCandidateApi, (req, res) => {
    res.json({ ok: true, savedSearches: subsOf(req.candidateEmail).map(searchJson), max: MAX_SAVED_SEARCHES });
  });
  app.post('/api/candidate/saved-searches', C.requireCandidateApi, limit('saved-searches', 30), sameOrigin, (req, res) => {
    const r = createSearch(req.candidateEmail, req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : { filters: null }, { strict: true });
    if (r.errors) return jsonErrors(res, r.status, r.errors);
    res.status(r.status).json({ ok: true, existed: Boolean(r.existed), savedSearch: searchJson(r.sub) });
  });
  app.patch('/api/candidate/saved-searches/:id', C.requireCandidateApi, limit('saved-searches', 60), sameOrigin, (req, res) => {
    const r = updateSearch(req.candidateEmail, req.params.id, req.body, { strict: true });
    if (r.errors) return jsonErrors(res, r.status, r.errors);
    res.json({ ok: true, savedSearch: searchJson(r.sub) });
  });
  app.delete('/api/candidate/saved-searches/:id', C.requireCandidateApi, limit('saved-searches', 60), sameOrigin, (req, res) => {
    if (!deleteSearch(req.candidateEmail, req.params.id)) return jsonErrors(res, 404, 'saved search not found');
    res.json({ ok: true });
  });

  // ---------- filling the profile from a resume ----------
  // What a resume suggests that the profile doesn't have yet. Nothing is saved.
  async function readResume(file, originalName, profile) {
    const text = await resumes.extractText(file, originalName);
    if (!text) return null;
    const found = resumes.profileFromText(text, allJobSkills());
    const have = new Set((profile.skills || []).map(lower));
    const known = (list, key) => new Set(list.map(key));
    const expKey = (e) => `${lower(e.title)}|${lower(e.company)}`;
    const eduKey = (e) => `${e.level}|${lower(e.course)}`;
    const haveExp = known(profile.experiences || [], expKey);
    const haveEdu = known(profile.education || [], eduKey);
    return {
      skills: found.skills.filter((s) => !have.has(lower(s))),
      experienceLevel: cp.EXPERIENCE.includes(found.experience) ? found.experience : '',
      years: found.years,
      experiences: found.experiences.filter((e) => !haveExp.has(expKey(e))),
      education: found.education.filter((e) => !haveEdu.has(eduKey(e))).filter((e) => cp.EDUCATION_LEVELS.includes(e.level)),
    };
  }
  const storedResume = (email, id) => {
    const c = C.candidateOf(email);
    return (c && c.resumes.find((r) => r.id === id)) || null;
  };
  const resumePath = (r) => path.join(uploadsDir, path.basename(r.file));

  // The review form: everything read from the resume, ready to correct.
  app.get('/account/resumes/:id/review', C.requireCandidate, limit('resume-parse', 20), async (req, res, next) => {
    const r = storedResume(req.candidateEmail, req.params.id);
    if (!r) return next();
    const c = C.ensureCandidate(req.candidateEmail);
    const found = await readResume(resumePath(r), r.file, c.profile);
    C.page(res, 'account-resume-review', { title: 'Check what we read from your resume', ...C.shell(req.candidateEmail, 'profile'), resume: r, found, opts: cp, values: null });
  });
  // Saves only what the candidate kept, after checking it like any profile change.
  app.post('/account/resumes/:id/review', C.requireCandidate, limit('account-profile', 40), sameOrigin, (req, res, next) => {
    const r = storedResume(req.candidateEmail, req.params.id);
    if (!r) return next();
    const b = req.body || {};
    const c = C.ensureCandidate(req.candidateEmail);
    const p = c.profile;
    const list = (v) => [].concat(v ?? []).map(String);
    const rows = (prefix, fields) => {
      const out = [];
      for (let i = 0; i < 10; i++) {
        if (b[`${prefix}${i}_keep`] !== '1') continue;
        out.push(Object.fromEntries(fields.map((f) => [f, b[`${prefix}${i}_${f}`] ?? ''])));
      }
      return out;
    };
    const input = {};
    const skills = list(b.skills).map((s) => s.trim()).filter(Boolean);
    const extra = String(b.moreSkills || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (skills.length || extra.length) input.skills = [...p.skills, ...skills, ...extra];
    if (b.experienceLevel) input.experienceLevel = b.experienceLevel;
    const jobs = rows('exp', ['title', 'company', 'from', 'to', 'current']);
    if (jobs.length) input.experiences = [...jobs, ...p.experiences];
    const edu = rows('edu', ['level', 'course', 'institution', 'year']);
    if (edu.length) input.education = [...p.education, ...edu];
    if (!Object.keys(input).length) return C.back(res, 'Nothing was added to your profile.', '/account/profile');
    const { patch, errors } = cp.parsePatch(input, C.profileContext());
    if (errors.length) {
      return C.page(res, 'account-resume-review', { title: 'Check what we read from your resume', ...C.shell(req.candidateEmail, 'profile'), resume: r, found: null, opts: cp, values: b, errors }, 400);
    }
    C.updateProfile(req.candidateEmail, patch);
    C.back(res, 'Your profile was updated from your resume. Your resume itself is unchanged.', '/account/profile');
  });

  // JSON: a stored resume ({ "resumeId": "…" }) or a file sent as multipart
  // "resume". The file is checked (type by its first bytes, size, virus scan)
  // and, when only sent for reading, deleted straight after.
  app.post('/api/candidate/resumes/parse', C.requireCandidateApi, limit('resume-parse', 20), sameOrigin, (req, res) => {
    const c = C.ensureCandidate(req.candidateEmail);
    const reply = (found) => {
      if (!found) return jsonErrors(res, 422, "We couldn't read text from this resume (it may be a scan or an old .doc file). You can fill in your profile yourself.");
      res.json({ ok: true, saved: false, extracted: found, note: 'Nothing has been saved. Send the details you want to keep, corrected, to PATCH /api/candidate/profile.' });
    };
    if (req.is('application/json')) {
      const id = String((req.body || {}).resumeId || '');
      const r = storedResume(req.candidateEmail, id);
      if (!r) return jsonErrors(res, 404, 'resume not found');
      return readResume(resumePath(r), r.file, c.profile).then(reply).catch(() => jsonErrors(res, 500, 'Could not read the resume. Please try again.'));
    }
    upload.single('resume')(req, res, (err) => {
      if (err) return jsonErrors(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB.' : err.message);
      if (!req.file) return jsonErrors(res, 400, 'send a resume file as "resume", or { "resumeId" } as JSON');
      const drop = () => fs.unlink(req.file.path, () => {});
      vetUpload(req.file).then(async (bad) => {
        if (bad) return jsonErrors(res, 400, bad);
        try {
          reply(await readResume(req.file.path, req.file.originalname, c.profile));
        } finally {
          drop();
        }
      }).catch(() => { drop(); jsonErrors(res, 500, 'Could not read the resume. Please try again.'); });
    });
  });

  return { recommend, matchFor, dispatch, digestScan, subsOf, view, filtersOf, matchesSub, FREQUENCIES, FREQUENCY_TEXT };
}

module.exports = { register, FREQUENCIES, FREQUENCY_TEXT, MAX_SAVED_SEARCHES, DIGEST_JOBS, compact };
