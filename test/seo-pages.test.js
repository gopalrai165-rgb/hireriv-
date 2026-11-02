// SEO: every page in the sitemap has its own title, a description and a
// canonical address; robots.txt points to the sitemap; the homepage has the
// agreed title and description; Search Console and Google Analytics (after
// consent only) are switched on by settings.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');
const check = require('../config-check');

let srv;
before(async () => { srv = await startServer({ GA_MEASUREMENT_ID: 'G-TEST12345', GOOGLE_SITE_VERIFICATION: 'abcDEF123_-xyz' }); });
after(() => srv && srv.stop());
const page = async (p) => (await srv.request(p)).text();
const first = (html, re) => ((html.match(re) || [])[1] || '').trim();

test('the homepage title and description', async () => {
  const home = await page('/');
  assert.equal(first(home, /<title>([^<]*)<\/title>/), 'Hireriv – Find Jobs &amp; Recruitment Staffing Services in India');
  assert.equal(first(home, /<meta name="description" content="([^"]*)"/), 'Find IT and non-IT jobs across India. Hireriv by Raigozen offers recruitment, permanent hiring, bulk hiring and contract staffing solutions.');
  assert.match(home, /<meta name="google-site-verification" content="abcDEF123_-xyz">/);
  assert.doesNotMatch(await page('/jobs'), /google-site-verification/, 'the tag is needed on the homepage only');
});

test('every page in the sitemap has a unique title, a description and its canonical address', async () => {
  const xml = await page('/sitemap.xml');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  assert.ok(urls.length > 40, `${urls.length} pages`);
  const titles = new Map();
  const problems = [];
  for (const p of urls) {
    const html = await page(p);
    const title = first(html, /<title>([^<]*)<\/title>/);
    const desc = first(html, /<meta name="description" content="([^"]*)"/);
    const canonical = first(html, /<link rel="canonical" href="([^"]*)"/);
    if (!title) problems.push(`${p}: no title`);
    if (desc.length < 50) problems.push(`${p}: description too short`);
    if (!canonical || new URL(canonical).pathname !== p) problems.push(`${p}: canonical ${canonical}`);
    if (titles.has(title)) problems.push(`${p}: same title as ${titles.get(title)}`);
    titles.set(title, p);
  }
  assert.deepEqual(problems, []);
});

test('robots.txt allows the public site and points to the sitemap', async () => {
  const robots = await page('/robots.txt');
  assert.match(robots, /Sitemap: http:\/\/localhost:\d+\/sitemap\.xml/);
  assert.match(robots, /Disallow: \/admin/);
  assert.doesNotMatch(robots, /Disallow: \/jobs/);
});

test('Google Analytics: allowed by the CSP, loaded on public pages only, nothing from Google before consent', async () => {
  const res = await srv.request('/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/www\.googletagmanager\.com/);
  assert.match(csp, /connect-src 'self' [^;]*google-analytics\.com/);
  const home = await res.text();
  assert.match(home, /<script src="\/js\/analytics\.js\?v=[^"]+" data-ga="G-TEST12345" defer><\/script>/);
  assert.doesNotMatch(home, /googletagmanager\.com\/gtag/, 'the Google script itself is added by analytics.js after "Allow"');
  assert.doesNotMatch(await page('/account/login'), /analytics\.js/, 'not in signed-in areas');
  assert.match(await page('/privacy'), /Only if you press "Allow" on the cookie notice/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');
  assert.match(js, /if \(choice\(\) === 'yes'\) return start\(\);/);
  assert.match(js, /'\/api\/hire': 'generate_lead'/);
});

test('without the settings there is no analytics script and no Google host in the CSP', async () => {
  const plain = await startServer();
  try {
    const res = await plain.request('/');
    assert.doesNotMatch(res.headers.get('content-security-policy'), /googletagmanager|google-analytics/);
    const html = await res.text();
    assert.doesNotMatch(html, /analytics\.js|google-site-verification/);
    assert.doesNotMatch(await (await plain.request('/privacy')).text(), /Google Analytics\./);
  } finally { plain.stop(); }
});

test('config check: badly copied Google settings stop a production start', () => {
  const base = { NODE_ENV: 'production' };
  const errs = (env) => check.check ? check.check({ ...base, ...env }).errors : [];
  if (!check.check) return;
  assert.ok(errs({ GA_MEASUREMENT_ID: 'UA-1234-1' }).some((e) => /GA_MEASUREMENT_ID/.test(e)));
  assert.ok(errs({ GOOGLE_SITE_VERIFICATION: '<meta name="google-site-verification" content="x">' }).some((e) => /GOOGLE_SITE_VERIFICATION/.test(e)));
});
