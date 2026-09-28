// Reports & analytics: hiring speed, pipeline conversion, source of hire, and
// results by recruiter, category and client for a chosen period. Money figures
// are only built for Admins.
const DAY_MS = 86400000;
const round2 = (n) => Math.round(n * 100) / 100;
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const monthKey = (d) => dayKey(d).slice(0, 7);
const sum = (list, f) => round2(list.reduce((n, x) => n + (Number(f(x)) || 0), 0));
const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// Indian financial year start (1 April) for a date.
function fyStart(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
}

const PERIODS = [
  ['30d', 'Last 30 days'],
  ['90d', 'Last 90 days'],
  ['fy', 'This financial year'],
  ['lastfy', 'Last financial year'],
  ['12m', 'Last 12 months'],
  ['all', 'All time'],
];

function periodRange(key) {
  const today = dayKey(Date.now());
  const back = (days) => dayKey(Date.now() - days * DAY_MS);
  const fy = fyStart(today);
  const lastFy = `${Number(fy.slice(0, 4)) - 1}-04-01`;
  const dayBefore = (ymd) => dayKey(Date.parse(`${ymd}T12:00:00Z`) - DAY_MS);
  const ranges = {
    '30d': [back(29), today],
    '90d': [back(89), today],
    fy: [fy, today],
    lastfy: [lastFy, dayBefore(fy)],
    '12m': [back(364), today],
    all: ['0000-01-01', '9999-12-31'],
  };
  const k = ranges[key] ? key : '90d';
  return { key: k, label: PERIODS.find((p) => p[0] === k)[1], from: ranges[k][0], to: ranges[k][1] };
}

// Where an application came from, as captured on the apply form.
const SOURCE_NAMES = {
  whatsapp: 'WhatsApp share', linkedin: 'LinkedIn', 'job-alert': 'Job alert email', share: 'Shared link',
  google: 'Google', facebook: 'Facebook', instagram: 'Instagram', naukri: 'Naukri', indeed: 'Indeed',
  direct: 'Direct / typed in', website: 'Our website',
};
const sourceName = (s) => (!s ? 'Not tracked (older)' : SOURCE_NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1));

function create({ readSubmissions, getJobs, getPlacements, team, appOwner }) {
  const invoicesOf = (p) => [p.invoice, ...(p.monthlyInvoices || [])].filter(Boolean);

  function build({ period: periodKey, isAdmin }) {
    const period = periodRange(periodKey);
    const inPeriod = (d) => {
      if (!d) return false;
      const k = d.length === 10 ? d : dayKey(d);
      return k >= period.from && k <= period.to;
    };
    const jobs = getJobs();
    const jobOf = (id) => jobs.find((j) => j.id === id);
    const apps = readSubmissions('applications');
    const appsById = Object.fromEntries(apps.map((a) => [a.id, a]));
    const placements = getPlacements();
    const members = team.list();
    const nameOf = (id) => (id ? (members.find((u) => u.id === id) || {}).name || 'Former member' : 'Unassigned');
    const ownerOfPlacement = (p) => (appsById[p.appId] ? appOwner(appsById[p.appId]) : (jobOf(p.jobId) || {}).ownerId || '');

    const periodApps = apps.filter((a) => inPeriod(a.createdAt));
    const periodPlacements = placements.filter((p) => inPeriod(p.createdAt) && !p.replacementFor);
    const periodInterviews = apps.flatMap((a) => (a.interviews || []).filter((iv) => inPeriod(iv.createdAt)).map((iv) => ({ ...iv, app: a })));

    // Days from application to offer accepted (placement recorded).
    const hireDays = (p) => {
      const a = appsById[p.appId];
      return a ? Math.max(0, Math.round((Date.parse(p.createdAt) - Date.parse(a.createdAt)) / DAY_MS)) : null;
    };
    const daysList = periodPlacements.map(hireDays).filter((d) => d !== null);

    // ----- money (Admins) -----
    const allInvoices = placements.flatMap((p) => invoicesOf(p).map((inv) => ({ p, inv })));
    const billedIn = (list) => sum(list.filter(({ inv }) => inPeriod(inv.date)), ({ inv }) => inv.total)
      - sum(list.flatMap(({ inv }) => (inv.creditNotes || []).filter((c) => inPeriod(c.date))), (c) => c.total);
    const collectedIn = (list) => sum(list.flatMap(({ inv }) => (inv.payments || []).filter((x) => inPeriod(x.date))), (x) => x.amount + x.tds)
      - sum(list.flatMap(({ inv }) => (inv.refunds || []).filter((x) => inPeriod(x.date))), (x) => x.amount);

    const kpis = [
      { label: 'Applications', value: periodApps.length, note: `${periodInterviews.length} interviews booked` },
      { label: 'Placements', value: periodPlacements.length, note: `${pct(periodPlacements.length, periodApps.length)}% of applications` },
      { label: 'Median time to hire', value: median(daysList), unit: 'days', note: daysList.length ? `application → offer accepted, ${daysList.length} hire${daysList.length === 1 ? '' : 's'}` : 'no hires yet' },
    ];
    if (isAdmin) {
      kpis.push({ label: 'Billed', money: round2(billedIn(allInvoices)), note: 'invoices incl. GST, net of credit notes' });
      kpis.push({ label: 'Collected', money: round2(collectedIn(allInvoices)), note: 'received + TDS, less refunds' });
    }

    // ----- last 12 months (always the trailing year, whatever the period) -----
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15));
      const key = d.toISOString().slice(0, 7);
      months.push({ key, label: d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }), full: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }), placements: 0, billed: 0 });
    }
    const byMonth = Object.fromEntries(months.map((m) => [m.key, m]));
    for (const p of placements) if (!p.replacementFor && byMonth[monthKey(p.createdAt)]) byMonth[monthKey(p.createdAt)].placements++;
    if (isAdmin) {
      for (const { inv } of allInvoices) {
        if (byMonth[inv.date.slice(0, 7)]) byMonth[inv.date.slice(0, 7)].billed += inv.total;
        for (const c of inv.creditNotes || []) if (byMonth[c.date.slice(0, 7)]) byMonth[c.date.slice(0, 7)].billed -= c.total;
      }
      for (const m of months) m.billed = Math.max(0, round2(m.billed));
    }

    // ----- conversion: how far applications received in the period got -----
    // Stage history isn't stored, so "reached" is inferred from the current stage
    // and interviews: e.g. a Rejected candidate who was interviewed counts at Interview.
    const reached = (a, stage) => {
      const s = a.status || 'New';
      const placed = placements.some((p) => p.appId === a.id);
      if (stage === 'Applied') return true;
      if (stage === 'Screened') return s !== 'New';
      if (stage === 'Interviewed') return (a.interviews || []).length > 0 || ['Interview', 'Offered', 'Hired'].includes(s) || placed;
      if (stage === 'Offered') return ['Offered', 'Hired'].includes(s) || placed;
      return s === 'Hired' || placed;
    };
    const conversion = ['Applied', 'Screened', 'Interviewed', 'Offered', 'Hired'].map((stage) => {
      const count = periodApps.filter((a) => reached(a, stage)).length;
      return { stage, count, pct: pct(count, periodApps.length) };
    });

    // ----- source of hire -----
    const sourceMap = {};
    for (const a of periodApps) {
      const k = sourceName(a.source);
      (sourceMap[k] = sourceMap[k] || { name: k, applications: 0, placements: 0 }).applications++;
    }
    for (const p of periodPlacements) {
      const a = appsById[p.appId];
      const k = sourceName(a && a.source);
      (sourceMap[k] = sourceMap[k] || { name: k, applications: 0, placements: 0 }).placements++;
    }
    const sources = Object.values(sourceMap).map((s) => ({ ...s, rate: pct(s.placements, s.applications) })).sort((a, b) => b.applications - a.applications || b.placements - a.placements);

    // ----- by recruiter -----
    const recMap = {};
    const rec = (id) => (recMap[id] = recMap[id] || { id, name: nameOf(id), applications: 0, interviews: 0, placements: 0, billed: 0, days: [] });
    for (const a of periodApps) rec(appOwner(a)).applications++;
    for (const iv of periodInterviews) rec(appOwner(iv.app)).interviews++;
    for (const p of periodPlacements) {
      const r = rec(ownerOfPlacement(p));
      r.placements++;
      const d = hireDays(p);
      if (d !== null) r.days.push(d);
    }
    if (isAdmin) for (const x of allInvoices) rec(ownerOfPlacement(x.p)).billed = round2(rec(ownerOfPlacement(x.p)).billed + billedIn([x]));
    const recruiters = Object.values(recMap)
      .map(({ days, ...r }) => ({ ...r, medianDays: median(days) }))
      .filter((r) => r.applications || r.interviews || r.placements || r.billed)
      .sort((a, b) => b.placements - a.placements || b.billed - a.billed || b.applications - a.applications);

    // ----- by category -----
    const catMap = {};
    const cat = (name) => (catMap[name] = catMap[name] || { name, applications: 0, placements: 0, days: [] });
    for (const a of periodApps) cat((jobOf(a.jobId) || {}).category || 'General applications').applications++;
    for (const p of periodPlacements) {
      const c = cat((jobOf(p.jobId) || {}).category || 'General applications');
      c.placements++;
      const d = hireDays(p);
      if (d !== null) c.days.push(d);
    }
    const categories = Object.values(catMap)
      .map(({ days, ...c }) => ({ ...c, rate: pct(c.placements, c.applications), medianDays: median(days) }))
      .sort((a, b) => b.applications - a.applications);

    // ----- by client (Admins) -----
    let clients = [];
    if (isAdmin) {
      const cliMap = {};
      for (const p of placements) {
        const c = (cliMap[p.company] = cliMap[p.company] || { name: p.company, placements: 0, billed: 0, collected: 0 });
        if (inPeriod(p.createdAt) && !p.replacementFor) c.placements++;
        const list = invoicesOf(p).map((inv) => ({ p, inv }));
        c.billed = round2(c.billed + billedIn(list));
        c.collected = round2(c.collected + collectedIn(list));
      }
      clients = Object.values(cliMap).filter((c) => c.placements || c.billed || c.collected).sort((a, b) => b.billed - a.billed || b.placements - a.placements).slice(0, 15);
    }

    return { period, periods: PERIODS, kpis, months, conversion, sources, recruiters, categories, clients, isAdmin };
  }

  // Flat rows for the CSV download of each report section.
  function csv(section, report) {
    const map = {
      months: () => report.months.map((m) => ({ month: m.full, placements: m.placements, ...(report.isAdmin ? { billed: m.billed } : {}) })),
      conversion: () => report.conversion.map((c) => ({ stage: c.stage, applications: c.count, percent: c.pct })),
      sources: () => report.sources.map((s) => ({ source: s.name, applications: s.applications, placements: s.placements, placementRate: s.rate })),
      recruiters: () => report.recruiters.map((r) => ({ recruiter: r.name, applications: r.applications, interviews: r.interviews, placements: r.placements, medianDaysToHire: r.medianDays ?? '', ...(report.isAdmin ? { billed: r.billed } : {}) })),
      categories: () => report.categories.map((c) => ({ category: c.name, applications: c.applications, placements: c.placements, placementRate: c.rate, medianDaysToHire: c.medianDays ?? '' })),
      clients: () => report.clients.map((c) => ({ client: c.name, placements: c.placements, billed: c.billed, collected: c.collected })),
    };
    return map[section] ? map[section]() : null;
  }

  return { build, csv, PERIODS };
}

// Normalise the source sent by the apply form: a short lowercase slug.
const cleanSource = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 40);

module.exports = { create, cleanSource, sourceName };
