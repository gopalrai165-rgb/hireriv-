// Take-home pay calculator: the arithmetic (PF, ESI, professional tax,
// new-regime income tax with the rebate and marginal relief) and the page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../salary-calc');
const { startServer } = require('./helpers');
const starter = require('./fixtures/jobs.json');

const run = (q) => calc.compute(calc.parse(q).input);

test('income tax: nothing up to ₹12 lakh taxable, marginal relief just above, slabs and cess beyond', () => {
  assert.equal(calc.incomeTax(1275000).tax, 0, '₹12.75 lakh salary pays no tax');
  assert.equal(calc.incomeTax(1300000).tax, 26000, 'tax limited to the income above ₹12 lakh, plus cess');
  assert.equal(calc.incomeTax(1500000).tax, Math.round((20000 + 40000 + 0.15 * 225000) * 1.04));
  assert.equal(calc.incomeTax(2000000).tax, 192400);
});

test('monthly pay: PF on basic, ESI up to ₹21,000, professional tax', () => {
  const r = run({ amount: '18,000', per: 'month' });
  assert.deepEqual([r.grossMonth, r.pf, r.esi, r.pt, r.taxMonth, r.inHandMonth], [18000, 1080, 135, 200, 0, 16585]);
  const big = run({ amount: '40000', per: 'month' });
  assert.equal(big.esi, 0);
  assert.equal(big.pf, 1800, 'capped at ₹15,000 basic');
  assert.equal(run({ amount: '40000', per: 'month', pf: 'full' }).pf, 2400);
  assert.equal(run({ amount: '40000', per: 'month', pf: 'none', pt: '0' }).inHandMonth, 40000);
});

test('a yearly CTC takes out the employer\'s PF first, unless told it is not included', () => {
  const r = run({ amount: '600000', per: 'year' });
  assert.equal(r.employerPfYear, 21600);
  assert.equal(r.grossMonth, 48200);
  assert.equal(run({ amount: '600000', per: 'year', ctcIncludesPf: '0' }).grossMonth, 50000);
  assert.deepEqual(calc.parse({ amount: '0' }).errors, ['enter the salary in rupees']);
  assert.match(calc.parse({ amount: '20000', pt: '900' }).errors.join(), /at most ₹300/);
});

let srv;
before(async () => { srv = await startServer({}, { jobs: [{ ...starter[0], id: 'hr-950', status: 'open', sample: false, pay: { min: 20000, max: 25000, period: 'month', currency: 'INR' }, salary: '' }] }); });
after(() => srv && srv.stop());
const page = async (p) => (await srv.request(p)).text();

test('the page: a form that works without JavaScript, the result, and links to it', async () => {
  const empty = await page('/salary-calculator');
  assert.match(empty, /<h1>What will I take home\?<\/h1>/);
  assert.match(empty, /name="amount"/);
  assert.match(empty, /Examples/);
  assert.doesNotMatch(empty, /noindex/);
  const html = await page('/salary-calculator?amount=18000&per=month');
  assert.match(html, /<p class="calc-big">₹16,585<\/p>/);
  assert.match(html, /none: taxable income up to ₹12 lakh/);
  assert.match(html, /noindex/, 'results are not indexed');
  assert.match(html, /href="\/jobs\?minPay=18000"/);
  assert.match(await page('/salary-calculator?amount=abc'), /Enter the salary in rupees/);
  assert.match(await page('/jobs/hr-950'), /href="\/salary-calculator\?amount=25000&amp;per=month#result">What you take home<\/a>/);
  assert.match(await page('/salaries'), /href="\/salary-calculator"/);
  assert.match(await page('/'), /href="\/salary-calculator">Salary calculator<\/a>/, 'in the footer');
  assert.match(await page('/sitemap.xml'), /\/salary-calculator<\/loc>/);
});
