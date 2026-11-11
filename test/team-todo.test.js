// Step 215: "What needs you" on the team dashboard. Only jobs the team runs;
// managers see everything, others their own work and work nobody owns.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const member = (id, name, role) => ({ id, name, email: `${id}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'Client Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450215${id.slice(1).padStart(2, '0')}`, status: 'Interview', createdAt: iso(1), history: [], ...extra });
const reply = (id) => ({ id, from: 'candidate', by: 'Them', text: 'Hello', at: iso(1) });

let srv;
let boss;
let rita;
let omar;
let fin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.215.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const block = (page) => { const i = page.indexOf('id="todo"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const line = (n, words) => new RegExp(`<span class="todo-count">${n}</span><span class="todo-text">${words}`);
const names = (page) => [...new Set([...page.matchAll(/Person (a\d+)/g)].map((m) => m[1]))].sort();

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    team: [member('t-rita', 'Rita', 'Recruiter'), member('t-omar', 'Omar', 'Recruiter'), member('t-fin', 'Farah', 'Finance Manager')],
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    jobs: [job('j1', { ownerId: 't-rita' }), job('j2', { ownerId: 't-omar' }), job('j3'), job('e1', { employerId: 'emp-a', createdBy: 'employer' })],
    applications: [
      app('a1', 'j1', { messages: [reply('m1')] }),
      app('a2', 'j2', { messages: [reply('m2')] }),
      app('a3', 'j3', { status: 'New', createdAt: iso(10) }),
      app('a4', 'j1', { status: 'New', createdAt: iso(10) }),
      app('a5', 'j2', { status: 'New', createdAt: iso(10) }),
      app('a6', 'j1', { status: 'New', createdAt: iso(2) }),
      app('a7', 'j1', { status: 'New', createdAt: iso(10), withdrawnAt: iso(1), messages: [reply('m7')] }),
      app('a8', 'general', { status: 'New', createdAt: iso(10), jobTitle: 'General application' }),
      app('a9', 'e1', { status: 'New', createdAt: iso(10), messages: [reply('m9')] }),
      app('a10', 'j1', { interviews: [{ id: 'v1', at: iso(2), duration: 30, mode: 'Phone', status: 'scheduled', feedback: [] }] }),
      app('a11', 'e1', { interviews: [{ id: 'v2', at: iso(2), duration: 30, mode: 'Phone', status: 'scheduled', feedback: [] }] }),
      app('a12', 'j3', { interviews: [{ id: 'v3', at: iso(2), duration: 30, mode: 'Phone', status: 'scheduled', feedback: [] }] }),
    ],
    'hire-requests': [{ id: 'h1', company: 'New Co', name: 'Nia', email: 'nia@new.in', phone: '9845021599', roles: 'Drivers', status: 'New', createdAt: iso(5) }, { id: 'h2', company: 'Next Co', name: 'Noor', email: 'noor@next.in', phone: '9845021598', roles: 'Cooks', status: 'New', ownerId: 't-omar', createdAt: iso(5) }],
  });
  const login = async (id, name) => srv.cookieFrom(await post('/admin/login', { login: `${id}@hireriv.test`, password: `${name} long password` }));
  boss = await srv.adminLogin();
  rita = await login('t-rita', 'Rita');
  omar = await login('t-omar', 'Omar');
  fin = await login('t-fin', 'Farah');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('an Admin sees every kind, on the jobs the team runs', async () => {
  const b = block(await text('/admin', boss));
  assert.match(b, /What needs you/);
  assert.match(b, line(2, 'candidates wrote back'), 'not withdrawn people or a company\'s applicants');
  assert.match(b, line(3, 'candidates have waited over 7 days'), 'not general resumes or newer applications');
  assert.match(b, line(2, 'interviews finished with no feedback'), "not the one on a company's job");
  assert.match(b, /href="\/admin\?tab=interviews&amp;todo=feedback"/);
  assert.match(b, line(2, 'company enquiries'));
  assert.match(b, /href="\/admin\?tab=hire-requests&amp;waiting=1"/);
});

test('a recruiter sees their own work and work nobody owns', async () => {
  const b = block(await text('/admin', rita));
  assert.match(b, line(1, 'candidate wrote back'));
  assert.match(b, /href="\/admin\/applications\/a1#messages"/, 'one person goes straight to them');
  assert.match(b, line(2, 'candidates have waited'), 'j1 and the unowned j3, not Omar\'s j2');
  assert.match(b, line(2, 'interviews finished'));
  assert.match(b, line(1, 'company enquiry'), 'Nia, not the one Omar owns');
  assert.match(b, /href="\/admin\?tab=hire-requests&amp;waiting=1&amp;owner=open"/, 'the link opens the same enquiries');
  assert.match(b, /href="\/admin\?tab=interviews&amp;todo=feedback"/);
  const other = block(await text('/admin', omar));
  assert.match(other, /href="\/admin\/applications\/a2#messages"/);
  assert.match(other, line(1, 'interview finished'), 'the unowned one, not the one on the job Rita owns');
  assert.ok(other.includes('href="/admin/interviews/a12/v3/feedback"'), 'one interview goes straight to its feedback form');
  assert.equal((await get('/admin/interviews/a12/v3/feedback', omar)).status, 200);
});

test('a role that doesn\'t write to candidates gets no candidate lines', async () => {
  assert.doesNotMatch(block(await text('/admin', fin)), /wrote back|waited over|interview finished/);
});

test('the lists behind the links show the same people', async () => {
  const all = await text('/admin?tab=applications&todo=waiting', boss);
  assert.deepEqual(names(all), ['a3', 'a4', 'a5']);
  assert.match(all, /Showing: <b>Waiting over 7 days with no move<\/b>/);
  assert.deepEqual(names(await text('/admin?tab=applications&todo=waiting', rita)), ['a3', 'a4']);
  assert.deepEqual(names(await text('/admin?tab=applications&todo=unread', boss)), ['a1', 'a2']);
  assert.ok(names(await text('/admin?tab=applications&todo=nonsense', boss)).length > 3, 'unknown values are ignored');
});

// Step 218: the Interviews and enquiries lists behind the links show what was counted.
const ivBlock = (page) => { const i = page.indexOf('<main'); return page.slice(i, page.indexOf('</main>', i)); };
test('the feedback link opens just the interviews that were counted', async () => {
  const mine = ivBlock(await text('/admin?tab=interviews&todo=feedback', rita));
  assert.match(mine, /Showing: <b>Finished interviews with no feedback yet<\/b>/);
  assert.deepEqual(names(mine), ['a10', 'a12']);
  assert.doesNotMatch(mine, /Upcoming <span/);
  assert.deepEqual(names(ivBlock(await text('/admin?tab=interviews&todo=feedback', omar))), ['a12'], 'not the one on the job Rita owns');
  assert.deepEqual(names(ivBlock(await text('/admin?tab=interviews&todo=feedback', boss))), ['a10', 'a12'], "a manager sees all, still not a company's");
  assert.match(ivBlock(await text('/admin?tab=interviews', omar)), /Person a10/, 'the plain tab is unchanged');
});

test('the enquiries link opens mine and those nobody owns', async () => {
  const page = await text('/admin?tab=hire-requests&waiting=1&owner=open', rita);
  assert.match(page, /New Co/);
  assert.doesNotMatch(page, /Next Co/);
  assert.match(page, /<option value="open" selected>Mine and no owner yet<\/option>/);
  const omars = await text('/admin?tab=hire-requests&waiting=1&owner=open', omar);
  assert.match(omars, /New Co/);
  assert.match(omars, /Next Co/);
});

test('reading a reply clears it, and opening the dashboard changes nothing', async () => {
  const was = JSON.stringify(srv.records('applications'));
  await text('/admin', boss);
  assert.equal(JSON.stringify(srv.records('applications')), was);
  await text('/admin/applications/a1', rita);
  assert.doesNotMatch(block(await text('/admin', rita)), /wrote back/);
});
