// The site is in English only: no language selector, no Hindi versions for
// search engines, and asking for Hindi (address, cookie or the old
// LANGUAGES=en,hi setting) still shows English.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => {
  const env = { LANGUAGES: 'en,hi,te' };
  srv = await startServer(env);
});
after(() => srv && srv.stop());

test('only English is offered', async () => {
  const home = await (await srv.request('/')).text();
  assert.doesNotMatch(home, /class="lang-switch"/);
  assert.doesNotMatch(home, /hreflang="hi"/);
  assert.match(home, /<html lang="en"/);
  const asked = await (await srv.request('/?lang=hi')).text();
  assert.match(asked, /<html lang="en"/);
  assert.doesNotMatch(asked, /अपने पास नौकरी खोजें/);
  // A language cookie left from before shows English too.
  const cookie = await (await srv.request('/jobs', { cookie: 'hr_lang=hi' })).text();
  assert.match(cookie, /<html lang="en"/);
  const i18n = require('../i18n');
  assert.deepEqual(Object.keys(i18n.LOCALES), ['en'], 'only the English locale file');
  assert.deepEqual(i18n.offered({ LANGUAGES: 'en,hi,te' }), ['en']);
});
