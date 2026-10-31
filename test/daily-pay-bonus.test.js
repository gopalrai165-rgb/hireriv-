// Joining bonus and daily / weekly payment: perks ticked on the form or read
// from the benefits and pay note, a filter, card tags and their own pages.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const needs = require('../job-needs');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-951', title: 'Loading Helper', benefits: ['Paid daily in cash or UPI'] },
  { ...base, id: 'hr-952', title: 'Delivery Rider', perks: ['joiningbonus'], payNote: 'plus incentives' },
  { ...base, id: 'hr-953', title: 'Office Assistant' },
];
let srv;
before(async () => { srv = await startServer({}, { jobs: seedJobs }); });
after(() => srv && srv.stop());

test('the new perks are read from the benefits; a joining bonus is not an incentive', () => {
  assert.deepEqual(needs.perksOf({ benefits: ['Joining bonus ₹2,000', 'Weekly payout'] }), ['joiningbonus', 'dailypay']);
  assert.deepEqual(needs.perksOf({ payNote: '+ performance bonus' }), ['incentives']);
  assert.deepEqual(needs.perksOf({ benefits: ['Same-day payment'] }), ['dailypay']);
  assert.deepEqual(needs.perksOf({ benefits: ['Monthly salary on the 7th'] }), []);
  assert.deepEqual(needs.parseExtras({ perks: 'dailypay, joiningbonus' }).perks, ['joiningbonus', 'dailypay']);
});

test('the filter, card tags and the two pages', async () => {
  const ids = async (q) => (await (await srv.request(`/api/jobs?${q}`)).json()).jobs.map((j) => j.id).sort();
  assert.deepEqual(await ids('perk=dailypay'), ['hr-951']);
  assert.deepEqual(await ids('perk=joiningbonus'), ['hr-952']);
  const list = await (await srv.request('/jobs')).text();
  assert.match(list, /<span class="tag tag-perk">Daily \/ weekly pay<\/span>/);
  assert.match(list, /<span class="tag tag-perk">Joining bonus<\/span>/);
  const daily = await (await srv.request('/jobs/daily-payment')).text();
  assert.match(daily, /Jobs with daily or weekly payment/);
  assert.match(daily, /Loading Helper/);
  assert.doesNotMatch(daily, /Office Assistant|Delivery Rider/);
  assert.match(await (await srv.request('/jobs/joining-bonus/in/pune')).text(), /Delivery Rider/);
});
