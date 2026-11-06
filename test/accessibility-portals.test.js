// Step 193: the employer portal and the team's pages meet the same automated rules
// as the public pages, and the colours measured in a browser stay readable (text
// 4.5:1 against its background, large text 3:1, WCAG 2.2 AA).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const { problems } = require('./a11y-rules');

const DAY = 864e5;
const iso = (d = 0) => new Date(Date.now() - d * DAY).toISOString();
const job = (id, status) => ({ id, title: `Sales Executive ${id}`, company: 'Sunrise Retail', employerId: 'e', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '1-3 years', posted: iso(2).slice(0, 10), skills: ['Sales'], description: 'A good job with clear duties for the right person.', responsibilities: ['Serve customers'], pay: { min: 18000, max: 25000, per: 'month' }, status, closesOn: null, sample: false, createdBy: 'employer' });
const EMPLOYER = ['/employer', '/employer/jobs', '/employer/jobs/new', '/employer/jobs/j1/edit', '/employer/jobs/import', '/employer/applicants', '/employer/analytics', '/employer/integrations', '/employer/team', '/employer/settings', '/employer/billing', '/employer/contracts'];
const TEAM = ['/admin', '/admin?tab=applications', '/admin?tab=jobs', '/admin?tab=hire-requests', '/admin?tab=settings', '/admin/analytics', '/admin/billing', '/admin/integrations', '/admin/crm', '/admin/system-health', '/admin/recruitment-reports', '/admin/requisitions', '/admin/jobs/new', '/admin/export-requests'];

let srv;
const h = { 'x-forwarded-for': '10.193.0.1' };
before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    jobs: [job('j1', 'open'), job('j2', 'draft'), job('j3', 'closed'), job('j4', 'pending')],
    employers: [{ id: 'e', company: 'Sunrise Retail', name: 'Ann', email: 'ann@s.in', active: true, approvedAt: iso(9), createdAt: iso(30) }],
    'employer-users': [{ id: 'u', email: 'ann@s.in', name: 'Ann', phone: '9800000001', passwordHash: hashPassword('Ann long password'), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null }],
    'employer-members': [{ id: 'm', employerId: 'e', userId: 'u', role: 'owner', jobIds: [], createdAt: iso(1) }],
    applications: ['New', 'Screening', 'Interview', 'Hired'].map((status, i) => ({ id: `a${i}`, jobId: 'j1', jobTitle: 'Sales Executive', name: `Cand ${i}`, email: `a${i}@ex.in`, phone: '9811111111', status, createdAt: iso(3), history: [] })),
  });
}, { timeout: 60000 });
after(() => srv && srv.stop());

async function check(pages, cookie) {
  const found = {};
  for (const url of pages) {
    const res = await srv.request(url, { cookie, headers: h });
    assert.equal(res.status, 200, url);
    const p = problems(await res.text());
    if (p.length) found[url] = p;
  }
  assert.deepEqual(found, {});
}

test('employer pages pass the automated checks', async () => {
  const cookie = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'ann@s.in', password: 'Ann long password' }, headers: h }));
  await check(EMPLOYER, cookie);
});

test('team pages pass the automated checks', async () => {
  await check(TEAM, await srv.adminLogin());
});

test('the colours that failed in a browser stay readable', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  const vars = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  const hex = (decl, prop) => {
    const m = decl.match(new RegExp(`(?:^|[\\s;{])${prop}:\\s*(#[0-9A-Fa-f]{6}|#fff|var\\(--([a-z0-9-]+)\\))`));
    assert.ok(m, `${prop} in ${decl}`);
    if (m[1] === '#fff') return '#ffffff';
    return m[2] ? vars[m[2]] : m[1];
  };
  const lum = (c) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const selector of ['.eyebrow', '.st-screening', '.tag-hybrid', '.btn-whatsapp']) {
    const d = rule(selector);
    const r = ratio(hex(d, 'color'), hex(d, 'background'));
    assert.ok(r >= 4.5, `${selector}: ${r.toFixed(2)}:1`);
  }
  assert.ok(ratio(hex(rule('.service-link .card-link'), 'color'), '#ffffff') >= 4.5);
  assert.ok(ratio(vars.muted, '#ffffff') >= 4.5);
  assert.match(rule(':is(.admin-console, .portal) .admin-nav-label'), /color: var\(--muted\)/);
});

test('the search boxes show where the keyboard is', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /\.hero-search input:focus-visible, \.hero-search select:focus-visible, \.newsletter-form input:focus-visible \{ outline: 3px solid/);
  assert.doesNotMatch(css, /\.hero-search (input|select) \{[^}]*outline: 0/);
  assert.doesNotMatch(css, /\.newsletter-form input \{[^}]*outline: 0/);
});
