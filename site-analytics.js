// Website conversion counts without tracking people: each event adds one to a
// count for its day, its name and a short label (a kind of work, a service, a
// lead source). No cookies, no IP addresses, no user agents, no ids of
// candidates or clients, and nothing from forms is kept. Search-engine bots
// are not counted, and neither are browsers that ask not to be tracked
// (Global Privacy Control or Do Not Track), so no consent banner is needed.
const EVENTS = {
  'job-search': 'Job searches',
  'job-search-empty': 'Job searches with no results',
  'job-view': 'Job pages viewed',
  'application-started': 'Applications started',
  'application-submitted': 'Applications submitted',
  'candidate-registration': 'Candidate accounts created',
  'candidate-verified': 'Candidate accounts confirmed',
  'service-view': 'Service pages viewed',
  'industry-view': 'Industry pages viewed',
  'landing-view': 'Job landing pages viewed',
  'employer-inquiry': 'Employer inquiries submitted',
  'inquiry-qualified': 'Employer inquiries qualified by sales',
  'form-rejected': 'Public forms sent back with errors',
  'server-error': 'Server errors',
  'app-launch': 'Opened from the installed app',
  'app-installed': 'App installed',
  'push-enabled': 'Phone notifications turned on',
  'offline-page': 'Offline page shown',
};
// What a visitor's browser may report itself; everything else is counted on the server.
const CLIENT_EVENTS = ['application-started', 'app-installed', 'offline-page'];
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|whatsapp|linkedinbot|embedly|preview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|node-fetch|axios/i;
const KEEP_DAYS = 400;
const LABEL_RE = /[^A-Za-z0-9 &,./()-]/g;

function create({ db, now = () => new Date() }) {
  const COLLECTION = 'site-analytics';
  const pending = new Map();
  const day = () => now().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const cleanLabel = (s) => String(s || '').replace(LABEL_RE, '').trim().slice(0, 60);
  // Whether this request should be counted at all.
  const countable = (req) => {
    if (!req) return true;
    const ua = String(req.get('User-Agent') || '');
    if (!ua || BOT_RE.test(ua)) return false;
    if (req.get('Sec-GPC') === '1' || req.get('DNT') === '1') return false;
    return true;
  };
  function track(event, label = '', req = null) {
    if (!EVENTS[event] || !countable(req)) return false;
    const key = `${day()}|${event}|${cleanLabel(label)}`;
    pending.set(key, (pending.get(key) || 0) + 1);
    return true;
  }
  function flush() {
    if (!pending.size) return 0;
    const rows = db.all(COLLECTION);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [id, n] of pending) {
      const r = byId.get(id);
      if (r) r.count += n;
      else {
        const [d, event, label] = id.split('|');
        const row = { id, day: d, event, label, count: n };
        rows.push(row);
        byId.set(id, row);
      }
    }
    const cutoff = new Date(now().getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    const kept = rows.filter((r) => r.day >= cutoff);
    db.replaceAll(COLLECTION, kept);
    const n = pending.size;
    pending.clear();
    return n;
  }
  // Totals for a period: per event, per label, per day, and the conversion rates.
  function report({ from, to } = {}) {
    flush();
    const today = day();
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : today;
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from : new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    const rows = db.all(COLLECTION).filter((r) => r.day >= start && r.day <= end);
    const total = (e) => rows.filter((r) => r.event === e).reduce((n, r) => n + r.count, 0);
    const events = Object.entries(EVENTS).map(([key, label]) => {
      const mine = rows.filter((r) => r.event === key);
      const labels = {};
      for (const r of mine) if (r.label) labels[r.label] = (labels[r.label] || 0) + r.count;
      return { key, label, count: mine.reduce((n, r) => n + r.count, 0), labels: Object.entries(labels).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
    });
    const rate = (a, b) => (total(b) ? Number(((total(a) / total(b)) * 100).toFixed(1)) : null);
    const days = [...new Set(rows.map((r) => r.day))].sort().map((d) => ({ day: d, ...Object.fromEntries(Object.keys(EVENTS).map((e) => [e, rows.filter((r) => r.day === d && r.event === e).reduce((n, r) => n + r.count, 0)])) }));
    return {
      period: { from: start, to: end },
      events,
      rates: {
        viewToApplicationPercent: rate('application-submitted', 'job-view'),
        startedToSubmittedPercent: rate('application-submitted', 'application-started'),
        serviceViewToInquiryPercent: rate('employer-inquiry', 'service-view'),
        inquiryToQualifiedPercent: rate('inquiry-qualified', 'employer-inquiry'),
        searchesWithNoResultsPercent: rate('job-search-empty', 'job-search'),
      },
      days,
    };
  }
  return { track, flush, report, countable, EVENTS, CLIENT_EVENTS };
}

module.exports = { create, EVENTS, CLIENT_EVENTS, BOT_RE };
