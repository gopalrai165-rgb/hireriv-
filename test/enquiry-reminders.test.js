// Employer enquiries still "New" after a working day: one reminder to the
// lead owner, or to the admins, or to the team inbox when there are none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notifyModule = require('../notify');
const notifyEvents = require('../notify-events');
const { open } = require('../db');

const sent = [];
const mailer = { notice: async (who, content) => { sent.push({ who, content }); return true; } };
function setup(members, requests) {
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-enq-')), 'n.db'));
  const notify = notifyModule.create({ db, log: { error() {} } });
  const byId = (id) => members.find((m) => m.id === id) || null;
  const events = notifyEvents.create({
    notify, mailer, site: { name: 'Hireriv', email: 'hello@hireriv.in' }, baseUrl: 'http://x', db: null,
    readSubmissions: (c) => (c === 'hire-requests' ? requests : []), getJobs: () => [], formatIst: (d) => String(d), interviewIcs: () => '', appOwner: () => '',
    team: { byId, members: () => members }, hasAccount: () => true, jobPath: () => '/', clients: () => ({ read: () => [], team: {} }),
  });
  return { notify, events, db };
}
const overdue = (h) => (h.followUp || 'New') === 'New' && h.old;
const titles = (notify, userId) => notify.list({ rk: `t:${userId}` }).items.map((n) => n.title);

test('the owner is reminded once; requests already contacted or still fresh are left alone', () => {
  const members = [{ id: 'u-admin', name: 'Admin', email: 'admin@hireriv.in', role: 'Admin', active: true }, { id: 'u-rec', name: 'Rec', email: 'rec@hireriv.in', role: 'Recruiter', active: true }];
  const requests = [
    { id: 'h1', company: 'Owned Co', name: 'A', phone: '9800000001', roles: 'Drivers', followUp: 'New', ownerId: 'u-rec', old: true },
    { id: 'h2', company: 'Called Co', name: 'B', roles: 'Cooks', followUp: 'Contacted', old: true },
    { id: 'h3', company: 'Fresh Co', name: 'C', roles: 'Guards', followUp: 'New', old: false },
    { id: 'h4', company: 'Nobody Co', name: 'D', roles: 'Packers', followUp: 'New', old: true },
  ];
  const { notify, events } = setup(members, requests);
  assert.equal(events.hireOverdueScan(overdue), 2);
  assert.equal(events.hireOverdueScan(overdue), 0, 'only once per enquiry');
  assert.deepEqual(titles(notify, 'u-rec'), ['Not yet contacted: Owned Co'], 'the owner hears about their own enquiry');
  assert.deepEqual(titles(notify, 'u-admin'), ['Not yet contacted: Nobody Co'], 'admins hear about enquiries without an owner');
});

test('with no team accounts the reminder goes to the team inbox by email', () => {
  const { events, db } = setup([], [{ id: 'h9', company: 'Solo Co', name: 'E', roles: 'Helpers', followUp: 'New', old: true }]);
  assert.equal(events.hireOverdueScan(overdue), 1);
  assert.ok(db.all('notification-deliveries').some((d) => d.type === 'hire-request-overdue' && d.rk === 'inbox'));
});

test('the reminder email names the company, contact and phone', async () => {
  const members = [{ id: 'u-o', name: 'Owner', email: 'owner@hireriv.in', role: 'Recruiter', active: true }];
  const { notify, events } = setup(members, [{ id: 'h5', company: 'Mail Co', name: 'Meena', phone: '9800000005', roles: 'Tailors', followUp: 'New', ownerId: 'u-o', old: true }]);
  sent.length = 0;
  events.hireOverdueScan(overdue);
  await notify.work();
  const mail = sent.find((m) => m.who.email === 'owner@hireriv.in');
  assert.ok(mail, 'the email is sent');
  assert.match(mail.content.subject, /Call Mail Co today/);
  assert.match(mail.content.intro, /Meena on 9800000005/);
});

test('the weekly summary goes to admins on Monday morning once, with sources, pages and statuses', async () => {
  const now = Date.parse('2026-11-02T05:00:00Z'); // Monday 10:30 am IST
  const ago = (d) => new Date(now - d * 86400000).toISOString();
  const members = [{ id: 'u-a', name: 'Admin', email: 'admin@hireriv.in', role: 'Admin', active: true }, { id: 'u-r', name: 'Rec', email: 'rec@hireriv.in', role: 'Recruiter', active: true }];
  const requests = [
    { id: 'w1', company: 'A', createdAt: ago(1), source: 'linkedin', fromPage: 'Employers page', followUp: 'New', old: true },
    { id: 'w2', company: 'B', createdAt: ago(2), source: 'linkedin', fromPage: 'Contact page', followUp: 'Contacted' },
    { id: 'w3', company: 'C', createdAt: ago(3), followUp: 'Closed', followUpAt: ago(1) },
    { id: 'w4', company: 'D', createdAt: ago(20), followUp: 'Candidates shared' },
  ];
  const { notify, events } = setup(members, requests);
  assert.equal(events.leadSummaryScan(overdue, Date.parse('2026-11-01T05:00:00Z')), 0, 'not on Sunday');
  assert.equal(events.leadSummaryScan(overdue, Date.parse('2026-11-02T02:00:00Z')), 0, 'not before 9 am IST');
  sent.length = 0;
  assert.equal(events.leadSummaryScan(overdue, now), 1);
  assert.equal(events.leadSummaryScan(overdue, now + 3600000), 0, 'once a week');
  await notify.work();
  assert.deepEqual(sent.map((m) => m.who.email), ['admin@hireriv.in'], 'admins only');
  const c = sent[0].content;
  assert.match(c.subject, /3 new, 1 waiting for a call/);
  const rows = Object.fromEntries(c.rows);
  assert.equal(rows['Where they came from'], 'LinkedIn: 2, Not tracked: 1');
  assert.match(rows['Which page'], /Employers page: 1/);
  assert.match(rows['Open by status'], /New: 1/);
  assert.match(rows['Open by status'], /Candidates shared: 1/);
  assert.equal(rows['Closed this week'], '1');
  assert.deepEqual(titles(notify, 'u-a'), ['This week: 3 new employer enquiries']);
});
