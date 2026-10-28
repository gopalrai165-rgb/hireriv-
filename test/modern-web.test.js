// Faster on slow connections: pages and files sent compressed with zstd,
// Brotli or gzip (whichever the browser takes), versioned CSS and JS kept by
// browsers for a year, and 103 Early Hints so the stylesheet starts loading
// while the page is being made.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const compress = require('../compress');
const { startServer } = require('./helpers');

const decode = { gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, zstd: (b) => zlib.zstdDecompressSync(b) };
// A raw request, so the bytes and 1xx answers are seen as sent.
function get(srv, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const hints = [];
    const req = http.get(new URL(path, srv.base), { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), hints }));
    });
    req.on('information', (info) => hints.push(info));
    req.on('error', reject);
  });
}

test('the encoding is the first allowed one, honouring q=0', () => {
  assert.equal(compress.pick('gzip, deflate, br, zstd', ['zstd', 'br', 'gzip']), 'zstd');
  assert.equal(compress.pick('gzip, br;q=0.5', ['zstd', 'br', 'gzip']), 'br');
  assert.equal(compress.pick('br;q=0, gzip', ['br', 'gzip']), 'gzip');
  assert.equal(compress.pick('identity', ['br', 'gzip']), '');
  assert.equal(compress.pick('', ['br', 'gzip']), '');
});

let srv;
before(async () => {
  srv = await startServer({}, {});
});
after(() => srv && srv.stop());

test('pages and JSON are compressed with what the browser accepts', async () => {
  const plain = await get(srv, '/jobs');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.match(plain.headers.vary || '', /Accept-Encoding/);
  const html = plain.body.toString();
  for (const enc of ['gzip', 'br', ...(compress.HAS_ZSTD ? ['zstd'] : [])]) {
    const r = await get(srv, '/jobs', { 'accept-encoding': enc });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], enc, enc);
    assert.match(r.headers['content-type'], /^text\/html; charset=utf-8/);
    assert.ok(r.body.length < html.length / 3, `${enc}: ${r.body.length} of ${html.length}`);
    assert.match(decode[enc](r.body).toString(), /<h1/);
  }
  const api = await get(srv, '/api/jobs', { 'accept-encoding': 'gzip' });
  assert.equal(api.headers['content-encoding'], 'gzip');
  assert.ok(Array.isArray(JSON.parse(decode.gzip(api.body)).jobs));
  // Small answers go as they are.
  const tiny = await get(srv, '/healthz', { 'accept-encoding': 'gzip' });
  assert.equal(tiny.headers['content-encoding'], undefined);
  // A repeat visit still gets "not changed".
  const again = await get(srv, '/api/jobs', { 'accept-encoding': 'gzip', 'if-none-match': api.headers.etag });
  assert.equal(again.status, 304);
});

test('the stylesheet and script are compressed once at the best level, and versioned copies kept a year', async () => {
  const page = (await get(srv, '/')).body.toString();
  const css = page.match(/href="(\/css\/style\.css\?v=[^"]+)"/)[1];
  const raw = await get(srv, css);
  assert.match(raw.headers['cache-control'], /max-age=31536000, immutable/);
  const br = await get(srv, css, { 'accept-encoding': 'gzip, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(br.headers['content-type'], /^text\/css/);
  assert.match(br.headers['cache-control'], /immutable/);
  assert.ok(br.body.length < raw.body.length / 4, `${br.body.length} of ${raw.body.length}`);
  assert.equal(decode.br(br.body).toString(), raw.body.toString());
  const js = await get(srv, '/js/main.js', { 'accept-encoding': 'gzip' });
  assert.equal(js.headers['content-encoding'], 'gzip');
  assert.equal(js.headers['cache-control'], 'public, max-age=3600', 'without a version, an hour');
  assert.equal((await get(srv, '/css/nope.css', { 'accept-encoding': 'br' })).status, 404);
});

test('103 Early Hints point the browser at the stylesheet', async () => {
  const r = await get(srv, '/jobs', { accept: 'text/html' });
  const hint = r.hints.find((h) => h.statusCode === 103);
  assert.ok(hint, 'a 103 answer came first');
  assert.match(String(hint.headers.link), /<\/css\/style\.css\?v=\w+>; rel=preload; as=style/);
  assert.equal((await get(srv, '/api/jobs', { accept: 'text/html' })).hints.length, 0, 'not for the API');
});
