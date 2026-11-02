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

function setup(members, requests) {
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-enq-')), 'n.db'));
  const notify = notifyModule.create({ db, log: { error() {} } });
  const byId = (id) => members.find((m) => m.id === id) || null;
  const events = notifyEvents.create({
    notify, mailer: {}, site: { name: 'Hireriv', email: 'hello@hireriv.in' }, baseUrl: 'http://x', db: null,
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
