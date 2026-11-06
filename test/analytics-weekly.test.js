// Step 182: the weekly analytics email. People turn it on from the analytics
// page (team or employer); every Monday from 9 am IST they get the last 7
// India days against the 7 before, once; "Email me now" sends it at once.
// Someone whose role no longer includes analytics gets nothing.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notifyModule = require('../notify');
const notifyEvents = require('../notify-events');
const { open } = require('../db');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

// ---------- the Monday check and the email, with stand-ins ----------
const sent = [];
const mailer = { notice: async (who, content) => { sent.push({ who, content }); return true; } };
function setup(subs, weekly) {
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-aw-')), 'n.db'));
  const notify = notifyModule.create({ db, log: { error() {} } });
  const members = [{ id: 'u-a', name: 'Asha', email: 'asha@hireriv.in', role: 'Admin', active: true }, { id: 'u-b', name: 'Bo', email: 'bo@hireriv.in', role: 'Recruiter', active: true }];
  const events = notifyEvents.create({
    notify, mailer, site: { name: 'Hireriv', email: 'hello@hireriv.in' }, baseUrl: 'http://x', db: null,
    readSubmissions: (c) => (c === 'analytics-reports' ? subs : []), getJobs: () => [], formatIst: (d) => String(d), interviewIcs: () => '', appOwner: () => '',
    team: { byId: (id) => members.find((m) => m.id === id) || null, members: () => members }, hasAccount: () => true, jobPath: () => '/', clients: () => ({ read: () => [], team: {} }),
    analyticsWeekly: () => weekly,
  });
  return { notify, events };
}
const KPIS = [
  { id: 'applications', label: 'Applications received', value: 12, change: { previous: 8, by: 50, kind: 'percent', better: 'better', from0: false } },
  { id: 'interviewRate', label: 'Interview rate', value: 25, unit: '%', change: { previous: 30, by: -5, kind: 'points', better: 'worse' } },
  { id: 'timeToHire', label: 'Time to hire', value: null, unit: 'days', change: null },
  { id: 'revenueCollected', label: 'Revenue collected', value: 1250000, unit: 'paise', change: null },
];
const weekly = (to) => (to.userId === 'u-a' ? { f: { from: '2026-10-26', to: '2026-11-01' }, kpis: KPIS, link: '/admin/analytics', company: '' } : null);

test('Monday from 9 am IST, once, only to people whose role still allows it', async () => {
  const { notify, events } = setup([{ id: 'ar-1', as: 'team', userId: 'u-a' }, { id: 'ar-2', as: 'team', userId: 'u-b' }], weekly);
  sent.length = 0;
  assert.equal(events.analyticsWeeklyScan(Date.parse('2026-11-01T05:00:00Z')), 0, 'not on Sunday');
  assert.equal(events.analyticsWeeklyScan(Date.parse('2026-11-02T02:00:00Z')), 0, 'not before 9 am IST');
  const now = Date.parse('2026-11-02T05:00:00Z'); // Monday 10:30 am IST
  assert.equal(events.analyticsWeeklyScan(now), 1, 'Bo lost analytics: only Asha');
  assert.equal(events.analyticsWeeklyScan(now + 3600000), 0, 'once a week');
  await notify.work();
  assert.equal(sent.length, 1);
  const { who, content } = sent[0];
  assert.equal(who.email, 'asha@hireriv.in');
  assert.equal(content.subject, 'your week in numbers, 12 applications');
  assert.match(content.intro, /2026-10-26 to 2026-11-01 \(India dates\), compared with the 7 days before/);
  assert.deepEqual(content.rows, [['Applications received', '12 (up 50%)'], ['Interview rate', '25% (down 5 points)'], ['Time to hire', 'Not enough data'], ['Revenue collected', 'Rs 12,500']]);
  assert.equal(content.link, 'http://x/admin/analytics');
  assert.equal(notify.list({ rk: 't:u-a' }).items.length, 0, 'email only, no notification');
});

test('"Email me now" sends at once, and nothing to someone without analytics', async () => {
  const { notify, events } = setup([], weekly);
  sent.length = 0;
  assert.equal(events.analyticsWeeklyNow({ kind: 'team', userId: 'u-a' }), 1);
  assert.equal(events.analyticsWeeklyNow({ kind: 'team', userId: 'u-b' }), 0);
  await notify.work();
  assert.equal(sent.length, 1);
});

// ---------- the page and the switch, on the real server ----------
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const EMP = { id: 'emp-w', company: 'Week Co', name: 'Wasim Ali', email: 'wasim@weekco.in', phone: '9800000006', passwordHash: hashPassword('wasim long password 1'), passwordSetAt: iso(86400000), active: true, approvedAt: iso(86400000), createdAt: iso(86400000) };
let srv;
let emp;
before(async () => {
  srv = await startServer({}, { employers: [EMP] });
  emp = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: EMP.email, password: 'wasim long password 1' } }));
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('an employer turns the Monday email on and off from analytics, and can have it now', async () => {
  let html = await (await srv.request('/employer/analytics', { cookie: emp })).text();
  assert.match(html, /<section class="weekly-email" id="weekly"/);
  assert.match(html, /Email me every Monday/);
  let r = await srv.request('/employer/analytics/weekly', { method: 'POST', form: { weekly: 'on' }, cookie: emp });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/employer/analytics?weekly=on#weekly');
  assert.equal(srv.records('analytics-reports').length, 1);
  assert.equal(srv.records('analytics-reports')[0].employerId, EMP.id);
  html = await (await srv.request('/employer/analytics?weekly=on', { cookie: emp })).text();
  assert.match(html, /You will get these numbers by email every Monday\./);
  assert.match(html, />Turn off</);
  // Turning it on twice keeps one record.
  await srv.request('/employer/analytics/weekly', { method: 'POST', form: { weekly: 'on' }, cookie: emp });
  assert.equal(srv.records('analytics-reports').length, 1);

  r = await srv.request('/employer/analytics/weekly', { method: 'POST', form: { action: 'now' }, cookie: emp });
  assert.equal(r.headers.get('location'), '/employer/analytics?weekly=sent#weekly');
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${EMP.email}`) && decodeEmail(e).includes('Your weekly hiring numbers')));
  assert.match(mail, /Week Co: your week in numbers, 0 applications/);
  assert.match(mail, /Applications received/);

  await srv.request('/employer/analytics/weekly', { method: 'POST', form: { weekly: 'off' }, cookie: emp });
  assert.equal(srv.records('analytics-reports').length, 0);
  // Signed out: no switch.
  const anon = await srv.request('/employer/analytics/weekly', { method: 'POST', form: { weekly: 'on' } });
  assert.notEqual(anon.headers.get('location'), '/employer/analytics?weekly=on#weekly');
  assert.equal(srv.records('analytics-reports').length, 0);
});
