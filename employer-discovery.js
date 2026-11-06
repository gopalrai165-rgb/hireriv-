// Finding candidates, for verified employers. Only candidates who switched on
// "Let verified employers find my profile" appear, and only the parts of the
// profile that describe their work: no name beyond an initial, no email, phone,
// resume, employers they worked for or anything personal. An employer can sort
// them by how well they fit one of its own open jobs (the same explainable
// match candidates see) and invite them to apply; the candidate decides, and
// the employer sees their details only if they apply. Nothing is rejected or
// hidden because of a score.
//
// Every request checks the person's company membership and role on the server
// (employer-team.js can(), "candidates.search"), and the company must be
// verified by the team. Invitations are recorded in the company's activity log.
//
// Candidates who also chose "Show my mobile number to verified employers who
// unlock my profile" can be unlocked (Step 85, contact-credits.js): the
// company then sees their full name and mobile number to call or WhatsApp
// them, using a free unlock from its plan or a contact credit. Still never
// their email, resume or employers. The candidate is told who unlocked them,
// and switching the choice off hides the number again at once.
const { can } = require('./employer-team');
const jm = require('./job-match');
const cp = require('./candidate-profile');

const PAGE_SIZE = 20;
const INVITES_PER_DAY = 30; // per company
const MAX_SKILLS = 5;
const MAX_SAVED = 1000; // per company
const DAY = 86400000;

// Indian mobile numbers as 10 digits, or ''.
function mobileOf(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}
// Someone who agreed to show their number, and has one.
const shares = (c) => Boolean(c && c.privacy && c.privacy.shareContact === true && mobileOf(c.profile && c.profile.phone));

const lower = (s) => String(s || '').trim().toLowerCase();
const shortName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Candidate';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};
const EDUCATION_RANK = Object.fromEntries(cp.EDUCATION_LEVELS.map((l, i) => [l, i]));

function register(app, deps) {
  const { readSubmissions, writeSubmissions, saveSubmission, sameOrigin, limit, site, getJobs, isLive, isSample, jobPath, clients, events, paginate, stateOf, jobTypes, contacts } = deps;
  const { requireEmployer, requireEmployerApi, team } = clients;
  const selfManaged = (job) => Boolean(job) && job.createdBy === 'employer';

  const verified = (req) => clients.isApproved(req.employer) && clients.verificationOf(req.employer) === 'verified';
  // Candidates who agreed to be found, with a confirmed email and something to show.
  const findable = () => readSubmissions('candidates').filter((c) => c.privacy && c.privacy.discoverable === true && c.emailVerifiedAt && c.profile
    && ((c.profile.skills || []).length || c.profile.headline || (c.profile.experiences || []).length));

  // The company's own open jobs this person works on, to sort and invite by.
  const jobsFor = (req) => getJobs().filter((j) => selfManaged(j) && j.employerId === req.employer.id && isLive(j) && !isSample(j) && can(req.member, 'applicants.view', j));

  // What an employer may see of a candidate.
  function card(c) {
    const p = { ...cp.emptyProfile(), ...c.profile };
    const prefs = { ...cp.emptyProfile().preferences, ...p.preferences };
    const top = (p.education || []).map((e) => e.level).sort((a, b) => (EDUCATION_RANK[b] ?? -1) - (EDUCATION_RANK[a] ?? -1))[0] || '';
    return {
      id: c.id, displayName: shortName(p.name), headline: p.headline || '', city: p.city || '', state: p.state || stateOf(p.city) || '',
      experienceLevel: p.experienceLevel || '', skills: (p.skills || []).slice(0, 15), certifications: (p.certifications || []).map((x) => x.name).slice(0, 10),
      languages: (p.languages || []).map((l) => l.name).slice(0, 6), education: top, recentRoles: (p.experiences || []).map((e) => e.title).filter(Boolean).slice(0, 3),
      wants: { types: prefs.types || [], arrangements: prefs.arrangements || [], shifts: prefs.shifts || [], locations: prefs.locations || [], relocate: Boolean(prefs.relocate) },
      availability: { noticePeriod: (p.availability || {}).noticePeriod || '', availableFrom: (p.availability || {}).availableFrom || '' },
      updatedOn: String(c.updatedAt || c.createdAt || '').slice(0, 10), sharesContact: shares(c),
    };
  }

  // Filters from the query string. Bad values are listed in `errors`.
  function filtersOf(query, req) {
    const errors = [];
    const one = (k, max = 100) => String((Array.isArray(query[k]) ? query[k][0] : query[k]) ?? '').trim().slice(0, max);
    const f = {
      q: one('q'), location: one('location', 80), experience: one('experience', 20), type: one('type', 40), shift: one('shift', 20),
      available: one('available', 10), contact: one('contact', 10), job: one('job', 40), sort: one('sort', 10), saved: one('saved', 5), skills: [],
    };
    for (const sk of [].concat(query.skill ?? [], String([].concat(query.skills ?? []).join(',')).split(',')).map((x) => String(x).trim()).filter(Boolean)) {
      if (sk.length > 40) errors.push('each skill must be 40 characters or fewer');
      else if (!f.skills.some((x) => lower(x) === lower(sk))) f.skills.push(sk);
    }
    if (f.skills.length > MAX_SKILLS) { errors.push(`choose up to ${MAX_SKILLS} skills`); f.skills = f.skills.slice(0, MAX_SKILLS); }
    if (f.experience && !cp.EXPERIENCE.includes(f.experience)) { errors.push('experience is invalid'); f.experience = ''; }
    if (f.type && !jobTypes.includes(f.type)) { errors.push('type is invalid'); f.type = ''; }
    if (f.shift && !cp.SHIFTS.includes(f.shift)) { errors.push('shift is invalid'); f.shift = ''; }
    if (f.available && f.available !== 'now') { errors.push('available must be "now"'); f.available = ''; }
    if (f.saved && f.saved !== '1') { errors.push('saved must be 1'); f.saved = ''; }
    if (f.contact && !['shared', 'unlocked'].includes(f.contact)) { errors.push('contact must be shared or unlocked'); f.contact = ''; }
    if (f.sort && !['match', 'recent'].includes(f.sort)) { errors.push('sort must be match or recent'); f.sort = ''; }
    // Only the company's own jobs: anything else is refused, never looked up.
    const job = f.job ? jobsFor(req).find((j) => j.id === f.job) : null;
    if (f.job && !job) { errors.push('job must be one of your open jobs'); f.job = ''; }
    if (!f.sort) f.sort = job ? 'match' : 'recent';
    if (f.sort === 'match' && !job) { errors.push('choose one of your jobs to sort by match'); f.sort = 'recent'; }
    return { f, job, errors };
  }

  const soon = () => new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
  function search(f, job, unlocked = new Set(), saved = new Set()) {
    const terms = lower(f.q).split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
    const weights = jm.weightsOf(site);
    const list = [];
    for (const c of findable()) {
      if (f.saved && !saved.has(c.id)) continue;
      const v = card(c);
      if (f.skills.length) {
        const have = [...v.skills, ...v.certifications].map(lower);
        if (!f.skills.every((s) => have.includes(lower(s)))) continue;
      }
      if (f.location && !(lower(v.city) === lower(f.location) || lower(v.state) === lower(f.location) || v.wants.locations.some((l) => lower(l) === lower(f.location)))) continue;
      if (f.experience && v.experienceLevel !== f.experience) continue;
      if (f.type && !v.wants.types.includes(f.type)) continue;
      if (f.shift && !(v.wants.shifts.includes(f.shift) || v.wants.shifts.includes('Flexible'))) continue;
      if (f.contact === 'shared' && !v.sharesContact) continue;
      if (f.contact === 'unlocked' && !(v.sharesContact && unlocked.has(c.id))) continue;
      if (f.available === 'now' && !(v.availability.noticePeriod === 'Immediate' || (v.availability.availableFrom && v.availability.availableFrom <= soon()))) continue;
      if (terms.length) {
        const hay = lower([v.headline, v.skills.join(' '), v.certifications.join(' '), v.recentRoles.join(' '), (c.profile.preferences || {}).roles].join(' '));
        if (!terms.every((t) => hay.includes(t))) continue;
      }
      list.push({ c, card: v, match: job ? jm.explain(jm.facts(c.profile), job, weights) : null });
    }
    const recent = (a, b) => String(b.c.updatedAt || b.c.createdAt).localeCompare(String(a.c.updatedAt || a.c.createdAt));
    list.sort(f.sort === 'match' ? (a, b) => (b.match.score ?? -1) - (a.match.score ?? -1) || recent(a, b) : recent);
    return list;
  }

  // ---------- saved candidates ----------
  // A list the whole company shares, so people can come back to someone. Just
  // who was saved: no notes about the person. It only ever shows people who still
  // choose to be found, the same way as the search. They aren't told, but it is
  // in their data download, and it goes when they delete their account.
  const savesOf = (employerId) => readSubmissions('candidate-saves').filter((s) => s.employerId === employerId);
  const savedIds = (employerId) => new Set(savesOf(employerId).map((s) => s.candidateId));
  function setSaved(req, candidateId, want) {
    const mine = savesOf(req.employer.id);
    const has = mine.some((s) => s.candidateId === candidateId);
    if (!want) {
      if (!has) return { status: 200, changed: false };
      writeSubmissions('candidate-saves', readSubmissions('candidate-saves').filter((s) => !(s.employerId === req.employer.id && s.candidateId === candidateId)));
      team.audit(req.employer.id, req.employerUser, 'candidate-unsaved', 'Removed a candidate from the saved list');
      return { status: 200, changed: true };
    }
    if (has) return { status: 200, changed: false };
    if (!findable().some((c) => c.id === candidateId)) return { status: 404, error: 'this candidate is not available' };
    if (mine.length >= MAX_SAVED) return { status: 409, error: `your saved list is full (${MAX_SAVED}). Remove someone first` };
    saveSubmission('candidate-saves', { candidateId, employerId: req.employer.id, savedBy: req.employerUser.id });
    team.audit(req.employer.id, req.employerUser, 'candidate-saved', 'Saved a candidate');
    return { status: 201, changed: true };
  }

  const invitesOf = (employerId) => readSubmissions('candidate-invites').filter((i) => i.employerId === employerId);
  // One invitation per candidate and job; a company sends at most INVITES_PER_DAY a day.
  function invite(req, candidateId, jobId) {
    const c = findable().find((x) => x.id === candidateId);
    if (!c) return { status: 404, error: 'candidate not found' };
    const job = jobsFor(req).find((j) => j.id === jobId);
    if (!job) return { status: 400, error: 'choose one of your open jobs' };
    const mine = invitesOf(req.employer.id);
    if (mine.some((i) => i.candidateId === c.id && i.jobId === job.id)) return { status: 200, existed: true, job, c };
    const since = new Date(Date.now() - DAY).toISOString();
    if (mine.filter((i) => i.createdAt >= since).length >= INVITES_PER_DAY) return { status: 429, error: `your company can send up to ${INVITES_PER_DAY} invitations a day` };
    if (readSubmissions('applications').some((a) => a.jobId === job.id && lower(a.email) === c.email && !a.withdrawnAt)) return { status: 409, error: 'this candidate has already applied for that job' };
    saveSubmission('candidate-invites', { candidateId: c.id, employerId: req.employer.id, jobId: job.id, invitedBy: req.employerUser.id });
    events.jobInvite(c, job);
    team.audit(req.employer.id, req.employerUser, 'candidate-invited', `${shortName(c.profile.name)} to apply for ${job.title}`);
    return { status: 201, job, c };
  }

  // Unlocking a candidate's number: a free unlock this month, else a credit.
  function unlockContact(req, candidateId) {
    const c = findable().find((x) => x.id === candidateId);
    if (!c) return { status: 404, error: 'candidate not found' };
    if (!shares(c)) return { status: 409, error: 'this candidate has not chosen to show their mobile number; invite them to apply instead' };
    const r = contacts().unlock(req.employer, req.employerUser, c.id);
    if (r.error) return { status: r.status, error: r.error };
    if (!r.existed) {
      team.audit(req.employer.id, req.employerUser, 'contact-unlocked', `${shortName(c.profile.name)}${r.source === 'credit' ? ' (1 contact credit)' : ' (free this month)'}`);
      events.contactUnlocked(c, req.employer);
    }
    return { status: r.existed ? 200 : 201, existed: Boolean(r.existed), source: r.source || r.unlock.source, c };
  }

  // The number, only for a company that unlocked someone who still shares it.
  const contactOf = (c) => {
    const phone = mobileOf(c.profile.phone);
    return { name: String(c.profile.name || '').trim() || shortName(c.profile.name), phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, tel: `+91${phone}`, whatsapp: `https://wa.me/91${phone}`,
      confirmed: Boolean(c.phoneVerified && c.phoneVerified.phone === phone) };
  };
  const cardJson = (x, invited, unlocked = new Set(), saved = new Set()) => ({
    ...x.card, saved: saved.has(x.c.id), invitedTo: invited.filter((i) => i.candidateId === x.c.id).map((i) => i.jobId),
    unlocked: unlocked.has(x.c.id) && x.card.sharesContact, contact: unlocked.has(x.c.id) && x.card.sharesContact ? contactOf(x.c) : null,
    match: x.match ? { score: x.match.score, level: x.match.level, label: x.match.label, factors: x.match.factors.map(({ key, label, weight, status, detail }) => ({ key, label, weight, status, detail })), requirements: x.match.requirements.map(({ label, met }) => ({ label, met })) } : null,
  });

  // ---------- page ----------
  app.get('/employer/candidates', requireEmployer, limit('candidate-search', 60, 60 * 1000), (req, res) => {
    const base = { title: 'Find candidates', tab: 'candidates', noindex: true, page: 'employer', msg: String(req.query.msg || '').slice(0, 200) };
    const allowed = can(req.member, 'candidates.search');
    if (!allowed || !verified(req)) return res.render('employer-candidates', { ...base, allowed, verified: verified(req), rows: [], pager: null, f: {}, jobs: [], errors: [] });
    const { f, job, errors } = filtersOf(req.query, req);
    const saved = savedIds(req.employer.id);
    const found = search(f, job, contacts().unlockedIds(req.employer.id), saved);
    const query = { q: f.q, skill: f.skills, location: f.location, experience: f.experience, type: f.type, shift: f.shift, available: f.available, contact: f.contact, job: f.job, sort: f.sort, saved: f.saved };
    const findableIds = new Set(findable().map((c) => c.id));
    const savedNow = [...saved].filter((id) => findableIds.has(id)).length;
    const { rows, pager } = paginate(found, { page: req.query.page, size: PAGE_SIZE, query, path: '/employer/candidates' });
    const invited = invitesOf(req.employer.id);
    const unlocked = contacts().unlockedIds(req.employer.id);
    res.render('employer-candidates', {
      ...base, allowed, verified: true, rows: rows.map((x) => cardJson(x, invited, unlocked, saved)), credits: contacts().status(req.employer), pager, f, job, savedCount: savedNow, savedHidden: saved.size - savedNow, backQuery: new URLSearchParams(Object.entries(req.query).filter(([k, v]) => k !== 'msg' && typeof v === 'string' && v)).toString(), jobs: jobsFor(req), errors,
      experienceOptions: cp.EXPERIENCE, shifts: cp.SHIFTS, jobTypes, invitesLeft: Math.max(0, INVITES_PER_DAY - invited.filter((i) => i.createdAt >= new Date(Date.now() - DAY).toISOString()).length),
    });
  });
  app.post('/employer/candidates/:id/invite', requireEmployer, limit('candidate-invite', 60), sameOrigin, (req, res) => {
    const back = (msg) => res.redirect(`/employer/candidates?${new URLSearchParams({ job: String(req.body.jobId || '').slice(0, 40), msg })}`);
    if (!can(req.member, 'candidates.search')) return clients.forbid(req, res);
    if (!verified(req)) return back('Finding candidates opens once your company is verified.');
    const r = invite(req, req.params.id, String(req.body.jobId || ''));
    if (r.error) return back(r.error.charAt(0).toUpperCase() + r.error.slice(1) + '.');
    back(r.existed ? `You already invited them to apply for ${r.job.title}.` : `Invitation sent for ${r.job.title}. They'll decide whether to apply.`);
  });

  // ---------- invitations sent ----------
  // Every invitation the company sent (from the candidate search, and after an
  // application, Step 207) on jobs this person may see applicants for, and
  // whether the person applied. Someone who put one aside reads as "Not yet":
  // the company is never told.
  const OUTCOMES = { applied: 'Applied', waiting: 'Not yet', closed: 'Job closed' };
  function sentInvitations(req) {
    const jobs = new Map(getJobs().filter((j) => j.employerId === req.employer.id && selfManaged(j) && can(req.member, 'applicants.view', j)).map((j) => [j.id, j]));
    const candidates = new Map(readSubmissions('candidates').map((c) => [c.id, c]));
    const apps = readSubmissions('applications').filter((a) => !a.duplicateOf);
    const appById = new Map(apps.map((a) => [a.id, a]));
    return invitesOf(req.employer.id).filter((i) => jobs.has(i.jobId)).map((i) => {
      const job = jobs.get(i.jobId);
      const c = i.candidateId ? candidates.get(i.candidateId) : null;
      const from = i.applicationId ? appById.get(i.applicationId) : null;
      const email = lower(c ? c.email : i.email);
      const applied = email && apps.find((a) => a.jobId === job.id && lower(a.email) === email && a.createdAt >= i.createdAt);
      const outcome = applied ? 'applied' : isLive(job) ? 'waiting' : 'closed';
      const fromJob = from ? jobs.get(from.jobId) : null;
      return {
        id: i.id, at: i.createdAt, job: { id: job.id, title: job.title },
        // Before they apply, people from the search are shown as on their card.
        person: applied ? applied.name : from ? from.name : c ? shortName(c.profile && c.profile.name) : 'Candidate',
        link: applied ? `/employer/applicants/${applied.id}` : fromJob ? `/employer/applicants/${from.id}` : '',
        via: from ? (fromJob ? `After applying for ${fromJob.title}` : 'After applying for another of your jobs') : 'Candidate search',
        by: (team.userById(i.invitedBy) || {}).name || 'Someone who left the team',
        outcome, outcomeLabel: OUTCOMES[outcome],
      };
    }).sort((x, y) => String(y.at).localeCompare(String(x.at)));
  }
  app.get('/employer/invitations', requireEmployer, (req, res) => {
    const all = sentInvitations(req);
    const jobIds = new Set(all.map((r) => r.job.id));
    const job = jobIds.has(req.query.job) ? req.query.job : '';
    const outcome = OUTCOMES[req.query.outcome] ? req.query.outcome : '';
    const list = all.filter((r) => (!job || r.job.id === job) && (!outcome || r.outcome === outcome));
    const { rows, pager } = paginate(list, { page: req.query.page, size: 50, query: { job, outcome }, path: '/employer/invitations' });
    const since = new Date(Date.now() - DAY).toISOString();
    const jobs = [...new Map(all.map((r) => [r.job.id, r.job])).values()];
    res.render('employer-invitations', {
      title: 'Invitations sent', tab: 'invitations', noindex: true, page: 'employer', rows, pager, job, outcome, jobs, outcomes: OUTCOMES,
      counts: { sent: list.length, applied: list.filter((r) => r.outcome === 'applied').length },
      invitesLeft: Math.max(0, INVITES_PER_DAY - invitesOf(req.employer.id).filter((i) => i.createdAt >= since).length),
      canSearch: can(req.member, 'candidates.search'),
    });
  });

  // Back to the same search and the same person.
  const KEEP = ['q', 'skills', 'skill', 'location', 'experience', 'type', 'shift', 'available', 'contact', 'job', 'sort', 'saved', 'page'];
  app.post('/employer/candidates/:id/save', requireEmployer, limit('candidate-save', 120), sameOrigin, (req, res) => {
    const from = new URLSearchParams(String(req.body.back || '').slice(0, 600));
    const kept = new URLSearchParams([...from].filter(([k]) => KEEP.includes(k)));
    const back = (msg, anchor = '') => { kept.set('msg', msg); res.redirect(303, `/employer/candidates?${kept}${anchor}`); };
    if (!can(req.member, 'candidates.search')) return clients.forbid(req, res);
    if (!verified(req)) return back('Finding candidates opens once your company is verified.');
    const want = req.body.saved !== '0';
    const r = setSaved(req, req.params.id, want);
    if (r.error) return back(r.error.charAt(0).toUpperCase() + r.error.slice(1) + '.');
    back(want ? 'Saved. Everyone in your company who finds candidates can see this list.' : 'Removed from your saved list.', `#cand-${encodeURIComponent(req.params.id)}`);
  });

  app.post('/employer/candidates/:id/unlock', requireEmployer, limit('candidate-unlock', 120), sameOrigin, (req, res) => {
    const back = (msg) => res.redirect(`/employer/candidates?${new URLSearchParams({ ...(req.body.back === 'unlocked' ? { contact: 'unlocked' } : {}), msg })}`);
    if (!can(req.member, 'candidates.search')) return clients.forbid(req, res);
    if (!verified(req)) return back('Finding candidates opens once your company is verified.');
    const r = unlockContact(req, req.params.id);
    if (r.error) return back(r.error.charAt(0).toUpperCase() + r.error.slice(1) + '.');
    back(r.existed ? 'You unlocked this number before; it is free to see again.' : `Number unlocked${r.source === 'credit' ? ' with 1 contact credit' : ''}. Be clear about the job and never ask for money.`);
  });

  // ---------- JSON ----------
  const gate = (req, res) => {
    if (!can(req.member, 'candidates.search')) { res.status(403).json({ ok: false, errors: ['your role in this company does not allow searching candidates'] }); return false; }
    if (!verified(req)) { res.status(403).json({ ok: false, errors: ['finding candidates opens once your company is verified'] }); return false; }
    return true;
  };
  app.get('/api/employers/candidates', requireEmployerApi, limit('candidate-search', 60, 60 * 1000), (req, res) => {
    if (!gate(req, res)) return;
    const { f, job, errors } = filtersOf(req.query, req);
    const raw = req.query.page;
    if (raw !== undefined && !(/^\d{1,4}$/.test(String(raw)) && +raw >= 1)) errors.push('page must be a whole number from 1');
    if (errors.length) return res.status(400).json({ ok: false, errors });
    const unlocked = contacts().unlockedIds(req.employer.id);
    const saved = savedIds(req.employer.id);
    const found = search(f, job, unlocked, saved);
    const page = raw ? +raw : 1;
    const invited = invitesOf(req.employer.id);
    res.json({
      ok: true, total: found.length, page, limit: PAGE_SIZE, pages: Math.max(1, Math.ceil(found.length / PAGE_SIZE)), sort: f.sort, job: job ? { id: job.id, title: job.title } : null,
      note: jm.NOTE, contacts: contacts().status(req.employer), candidates: found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((x) => cardJson(x, invited, unlocked, saved)),
    });
  });
  app.post('/api/employers/candidates/:id/invites', requireEmployerApi, limit('candidate-invite', 60), sameOrigin, (req, res) => {
    if (!gate(req, res)) return;
    const r = invite(req, req.params.id, String((req.body || {}).jobId || ''));
    if (r.error) return res.status(r.status).json({ ok: false, errors: [r.error] });
    res.status(r.status).json({ ok: true, existed: Boolean(r.existed), invitation: { candidateId: r.c.id, jobId: r.job.id, jobUrl: jobPath(r.job) } });
  });

  app.post('/api/employers/candidates/:id/save', requireEmployerApi, limit('candidate-save', 120), sameOrigin, (req, res) => {
    if (!gate(req, res)) return;
    const want = (req.body || {}).saved !== false;
    const r = setSaved(req, req.params.id, want);
    if (r.error) return res.status(r.status).json({ ok: false, errors: [r.error] });
    res.status(r.status).json({ ok: true, saved: want, changed: r.changed });
  });

  app.post('/api/employers/candidates/:id/unlock', requireEmployerApi, limit('candidate-unlock', 120), sameOrigin, (req, res) => {
    if (!gate(req, res)) return;
    const r = unlockContact(req, req.params.id);
    if (r.error) return res.status(r.status).json({ ok: false, errors: [r.error] });
    res.status(r.status).json({ ok: true, existed: r.existed, used: r.existed ? null : r.source, contact: contactOf(r.c), contacts: contacts().status(req.employer) });
  });

  return { findable, card, shortName };
}

module.exports = { register, shortName, INVITES_PER_DAY };
