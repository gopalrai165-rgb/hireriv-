// "Not interested": open job cards have a button; main.js keeps the hidden
// ids on this device only, hides those cards in job lists (never in Saved or
// Recently viewed) and offers "Show them again".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
let srv;
before(async () => { srv = await startServer({}, { jobs: [{ ...base, id: 'hr-1', title: 'Packer' }, { ...base, id: 'hr-2', title: 'Loader', status: 'closed' }] }); });
after(() => srv && srv.stop());

test('open job cards have "Not interested"; closed ones don\'t', async () => {
  assert.match(await (await srv.request('/jobs')).text(), /<button type="button" class="link-btn small hide-btn" data-hide-job="hr-1">Not interested<span class="sr-only">: Packer<\/span><\/button>/);
  assert.doesNotMatch(await (await srv.request('/saved/cards?ids=hr-2')).text(), /data-hide-job/);
});

test('main.js keeps hidden jobs on this device, never hides them in Saved or Recently viewed, and can show them again', () => {
  assert.match(js, /const HIDDEN_KEY = 'hireriv:hidden-jobs';/);
  assert.match(js, /const inOwnLists = \(el\) => el\.closest\('#saved-list, #recent-list'\);/);
  assert.match(js, /say\('showHidden', 'Show them again'\)/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /\.hide-btn \{ display: none;/, 'without the script there is no button that does nothing');
});
