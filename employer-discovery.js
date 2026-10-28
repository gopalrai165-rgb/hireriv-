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
  const { readSubmissions, saveSubmission, sameOrigin, limit, site, getJobs, isLive, isSample, jobPath, clients, events, paginate, stateOf, jobTypes, contacts } = deps;
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
      available: one('available', 10), contact: one('contact', 10), job: one('job', 40), sort: one('sort', 10), skills: [],
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
  function search(f, job, unlocked = new Set()) {
    const terms = lower(f.q).split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
    const weights = jm.weightsOf(site);
    const list = [];
    for (const c of findable()) {
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
  const cardJson = (x, invited, unlocked = new Set()) => ({
    ...x.card, invitedTo: invited.filter((i) => i.candidateId === x.c.id).map((i) => i.jobId),
    unlocked: unlocked.has(x.c.id) && x.card.sharesContact, contact: unlocked.has(x.c.id) && x.card.sharesContact ? contactOf(x.c) : null,
    match: x.match ? { score: x.match.score, level: x.match.level, label: x.match.label, factors: x.match.factors.map(({ key, label, weight, status, detail }) => ({ key, label, weight, status, detail })), requirements: x.match.requirements.map(({ label, met }) => ({ label, met })) } : null,
  });

  // ---------- page ----------
  app.get('/employer/candidates', requireEmployer, limit('candidate-search', 60, 60 * 1000), (req, res) => {
    const base = { title: 'Find candidates', tab: 'candidates', noindex: true, page: 'employer', msg: String(req.query.msg || '').slice(0, 200) };
    const allowed = can(req.member, 'candidates.search');
    if (!allowed || !verified(req)) return res.render('employer-candidates', { ...base, allowed, verified: verified(req), rows: [], pager: null, f: {}, jobs: [], errors: [] });
    const { f, job, errors } = filtersOf(req.query, req);
    const found = search(f, job, contacts().unlockedIds(req.employer.id));
    const query = { q: f.q, skill: f.skills, location: f.location, experience: f.experience, type: f.type, shift: f.shift, available: f.available, contact: f.contact, job: f.job, sort: f.sort };
    const { rows, pager } = paginate(found, { page: req.query.page, size: PAGE_SIZE, query, path: '/employer/candidates' });
    const invited = invitesOf(req.employer.id);
    const unlocked = contacts().unlockedIds(req.employer.id);
    res.render('employer-candidates', {
      ...base, allowed, verified: true, rows: rows.map((x) => cardJson(x, invited, unlocked)), credits: contacts().status(req.employer), pager, f, job, jobs: jobsFor(req), errors,
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
    const found = search(f, job, unlocked);
    const page = raw ? +raw : 1;
    const invited = invitesOf(req.employer.id);
    res.json({
      ok: true, total: found.length, page, limit: PAGE_SIZE, pages: Math.max(1, Math.ceil(found.length / PAGE_SIZE)), sort: f.sort, job: job ? { id: job.id, title: job.title } : null,
      note: jm.NOTE, contacts: contacts().status(req.employer), candidates: found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((x) => cardJson(x, invited, unlocked)),
    });
  });
  app.post('/api/employers/candidates/:id/invites', requireEmployerApi, limit('candidate-invite', 60), sameOrigin, (req, res) => {
    if (!gate(req, res)) return;
    const r = invite(req, req.params.id, String((req.body || {}).jobId || ''));
    if (r.error) return res.status(r.status).json({ ok: false, errors: [r.error] });
    res.status(r.status).json({ ok: true, existed: Boolean(r.existed), invitation: { candidateId: r.c.id, jobId: r.job.id, jobUrl: jobPath(r.job) } });
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
