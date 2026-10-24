// Contractor timesheets for monthly-billed contract placements. Contractors log
// each week (full day / half day / off per date) from their candidate account;
// the client approves or sends it back in the client portal (or an Admin does,
// for clients not on the portal). Approved days pre-fill "Bill a month".
// Timesheets live on the placement: placement.timesheets[].
const crypto = require('crypto');

const DAY_MS = 86400000;
const DAY_VALUES = { 1: 'Full day', 0.5: 'Half day', 0: 'Off' };
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const mondayOf = (ymd) => addDays(ymd, -((weekday(ymd) + 6) % 7));
const weekDates = (monday) => Array.from({ length: 7 }, (_, i) => addDays(monday, i));
const fmt = (ymd, opts) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', ...opts });
const weekLabel = (monday) => `${fmt(monday, { day: 'numeric', month: 'short' })} – ${fmt(addDays(monday, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`;

const isContract = (p) => p.feeMode === 'monthly' && ['Joined', 'Contract ended'].includes(p.status);
// A date the contractor could have worked: within the contract, not in the future.
const inContract = (p, ymd) => ymd >= p.joiningDate && (!p.contractEnd || ymd <= p.contractEnd) && ymd <= todayIst();
const daysOf = (ts) => Object.values(ts.days || {}).reduce((n, v) => n + Number(v || 0), 0);

// Weeks a contractor can log, newest first (joining week to this week or contract end).
function weeksAvailable(p) {
  const last = mondayOf(p.contractEnd && p.contractEnd < todayIst() ? p.contractEnd : todayIst());
  const out = [];
  for (let w = mondayOf(p.joiningDate); w <= last && out.length < 120; w = addDays(w, 7)) out.unshift(w);
  return out;
}

// Mon–Fri in a calendar month: the "full month" for working-day billing.
function workingDaysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= days; d++) if (![0, 6].includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) n++;
  return n;
}

// What the timesheets say about one month: approved days (billable) and what's still open.
function monthSummary(p, ym) {
  const s = { approvedDays: 0, pendingDays: 0, approvedWeeks: 0, pendingWeeks: 0, rejectedWeeks: 0 };
  for (const ts of p.timesheets || []) {
    const inMonth = Object.entries(ts.days || {}).filter(([d]) => d.startsWith(ym));
    if (!inMonth.length) continue;
    const d = inMonth.reduce((n, [, v]) => n + Number(v || 0), 0);
    if (ts.status === 'Approved') { s.approvedDays += d; s.approvedWeeks++; }
    else if (ts.status === 'Submitted') { s.pendingDays += d; s.pendingWeeks++; }
    else s.rejectedWeeks++;
  }
  return s;
}

function register(app, deps) {
  const { db, mailer, baseUrl, sameOrigin, limit, adminAuth, requireAdmin, requireCandidate, requireEmployer, clients } = deps;
  const read = () => db.all('placements');
  const write = (list) => db.replaceAll('placements', list);
  const clientOf = (p) => clients.read().find((c) => c.id === p.employerId && c.active) || null;
  const mineFor = (email) => read().filter((p) => isContract(p) && String(p.candidateEmail || '').toLowerCase() === email);

  // ---------- contractor ----------
  const page = (res, locals, status = 200) =>
    res.status(status).render('account-timesheet', { page: 'account', noindex: true, errors: [], title: 'Timesheets', weekLabel, weekDates, fmt, inContract, DAY_VALUES, daysOf, msg: '', ...locals });

  function showWeek(req, res, p, week, extra = {}, status = 200) {
    const weeks = weeksAvailable(p);
    const chosen = weeks.includes(week) ? week : weeks.find((w) => !(p.timesheets || []).some((t) => t.week === w && t.status === 'Approved')) || weeks[0];
    const existing = (p.timesheets || []).find((t) => t.week === chosen) || null;
    // Default: weekdays worked, weekends off, only inside the contract.
    const defaults = Object.fromEntries(weekDates(chosen).map((d) => [d, inContract(p, d) && ![0, 6].includes(weekday(d)) ? 1 : 0]));
    page(res, {
      p, weeks, week: chosen, existing, days: existing ? existing.days : defaults, note: existing ? existing.note : '',
      history: (p.timesheets || []).slice().sort((a, b) => b.week.localeCompare(a.week)),
      clientName: clientOf(p) ? p.company : '', msg: String(req.query.msg || ''), ...extra,
    }, status);
  }

  app.get('/account/timesheets/:pid', requireCandidate, (req, res, next) => {
    const p = mineFor(req.candidateEmail).find((x) => x.id === req.params.pid);
    if (!p) return next();
    showWeek(req, res, p, String(req.query.week || ''));
  });

  app.post('/account/timesheets/:pid', requireCandidate, limit('timesheet', 40), sameOrigin, (req, res, next) => {
    const list = read();
    const p = list.find((x) => x.id === req.params.pid && isContract(x) && String(x.candidateEmail || '').toLowerCase() === req.candidateEmail);
    if (!p) return next();
    const week = String(req.body.week || '');
    const errors = [];
    if (!weeksAvailable(p).includes(week)) errors.push('choose a week within your contract');
    const existing = (p.timesheets || []).find((t) => t.week === week);
    if (existing && existing.status === 'Approved') errors.push('that week is already approved');
    const days = {};
    for (const d of week && !errors.length ? weekDates(week) : []) {
      const v = Number(req.body[`day_${d}`] ?? 0);
      if (!(v in DAY_VALUES)) errors.push(`invalid entry for ${fmt(d, { weekday: 'short', day: 'numeric', month: 'short' })}`);
      else if (v && !inContract(p, d)) errors.push(`${fmt(d, { weekday: 'short', day: 'numeric', month: 'short' })} is outside your contract dates`);
      else if (v) days[d] = v;
    }
    const note = String(req.body.note || '').trim().slice(0, 300);
    if (errors.length) return showWeek(req, res, p, week, { errors, days: { ...days }, note }, 400);
    const now = new Date().toISOString();
    const ts = existing || { id: crypto.randomUUID(), week };
    Object.assign(ts, { days, note, status: 'Submitted', submittedAt: now, reviewedAt: null, reviewedBy: null, reviewNote: '' });
    if (!existing) p.timesheets = [...(p.timesheets || []), ts];
    write(list);
    // The client approves in their portal; otherwise the team approves in admin.
    const client = clientOf(p);
    mailer.timesheetSubmitted(client, p, ts, daysOf(ts), weekLabel(week), client ? `${baseUrl}/employer#timesheets` : `${baseUrl}/admin/placements/${p.id}/bill`);
    res.redirect(`/account/timesheets/${p.id}?week=${week}&msg=${encodeURIComponent(`Timesheet for ${weekLabel(week)} sent for approval (${daysOf(ts)} day${daysOf(ts) === 1 ? '' : 's'})`)}`);
  });

  // ---------- reviewing (client portal or Admin) ----------
  function review(list, p, tsId, approve, note, by) {
    const ts = (p.timesheets || []).find((t) => t.id === tsId && t.status === 'Submitted');
    if (!ts) return null;
    Object.assign(ts, { status: approve ? 'Approved' : 'Rejected', reviewedAt: new Date().toISOString(), reviewedBy: by, reviewNote: note });
    write(list);
    mailer.timesheetReviewed(p, ts, daysOf(ts), weekLabel(ts.week), `${baseUrl}/account/timesheets/${p.id}?week=${ts.week}`);
    return ts;
  }

  for (const action of ['approve', 'reject']) {
    app.post(`/employer/timesheets/:pid/:tsId/${action}`, requireEmployer, clients.allow('timesheets.review'), limit('timesheet-review', 60), sameOrigin, (req, res, next) => {
      const list = read();
      const p = list.find((x) => x.id === req.params.pid && x.employerId === req.employer.id);
      if (!p) return next();
      const note = String(req.body.note || '').trim().slice(0, 300);
      if (action === 'reject' && !note) return res.redirect('/employer?msg=' + encodeURIComponent('Add a short note saying what needs changing.') + '#timesheets');
      const ts = review(list, p, req.params.tsId, action === 'approve', note, `${(req.employerUser || req.employer).name} (${req.employer.company})`);
      if (!ts) return res.redirect('/employer?msg=' + encodeURIComponent('That timesheet was already reviewed.') + '#timesheets');
      res.redirect('/employer?msg=' + encodeURIComponent(`${action === 'approve' ? 'Approved' : 'Sent back'} ${p.candidateName}'s timesheet for ${weekLabel(ts.week)}`) + '#timesheets');
    });

    app.post(`/admin/placements/:id/timesheets/:tsId/${action}`, adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
      const list = read();
      const p = list.find((x) => x.id === req.params.id);
      if (!p) return next();
      const note = String(req.body.note || '').trim().slice(0, 300);
      const back = (m) => `/admin/placements/${p.id}/bill${req.body.month ? `?month=${encodeURIComponent(req.body.month)}&` : '?'}msg=${encodeURIComponent(m)}`;
      if (action === 'reject' && !note) return res.redirect(back('Add a note saying what needs changing'));
      const ts = review(list, p, req.params.tsId, action === 'approve', note, `${req.admin.name} (on behalf of ${p.company})`);
      res.redirect(back(ts ? `${action === 'approve' ? 'Approved' : 'Sent back'} ${p.candidateName}'s timesheet for ${weekLabel(ts.week)}` : 'That timesheet was already reviewed'));
    });
  }

  // ---------- data for other pages ----------
  // Candidate account: their active contracts and what needs doing.
  const forCandidate = (email) =>
    mineFor(email).map((p) => {
      const weeks = weeksAvailable(p);
      const ts = p.timesheets || [];
      const missing = weeks.filter((w) => w < mondayOf(todayIst()) && !ts.some((t) => t.week === w)).length;
      return { id: p.id, company: p.company, jobTitle: p.jobTitle, contractEnd: p.contractEnd, submitted: ts.filter((t) => t.status === 'Submitted').length, rejected: ts.filter((t) => t.status === 'Rejected').length, missing };
    });

  // Client portal: timesheets waiting for this client's decision.
  const forClient = (emp) =>
    read()
      .filter((p) => p.employerId === emp.id && p.feeMode === 'monthly')
      .flatMap((p) => (p.timesheets || []).filter((t) => t.status === 'Submitted').map((t) => ({ p: { id: p.id, candidateName: p.candidateName, jobTitle: p.jobTitle }, ts: t, total: daysOf(t), label: weekLabel(t.week), dates: weekDates(t.week) })))
      .sort((a, b) => a.ts.week.localeCompare(b.ts.week));

  return { forCandidate, forClient };
}

module.exports = { register, monthSummary, workingDaysInMonth, weekLabel, weekDates, daysOf, mondayOf, DAY_VALUES };
