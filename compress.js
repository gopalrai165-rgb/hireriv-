// Smaller pages on slow phone connections. HTML, JSON, XML and other text
// answers are sent compressed with the best encoding the browser accepts:
// zstd, Brotli or gzip, all built into Node, so no library is needed. The
// site's CSS and JS are compressed once, at the best level, and kept in
// memory; versioned copies (?v=) are cached by browsers for a year.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Below this, compressing saves less than it costs.
const MIN_BYTES = 1024;
const COMPRESSIBLE = /^(text\/|application\/([\w.+-]*json|javascript|[\w.+-]*xml)|image\/svg\+xml)/i;
const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const YEAR = 'public, max-age=31536000, immutable';

// Fast settings for pages made on each request; the smallest for files
// compressed once.
const FAST = {
  zstd: (b) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }),
  br: (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }),
  gzip: (b) => zlib.gzipSync(b, { level: 6 }),
};
const BEST = {
  br: (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }),
  zstd: (b) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }),
  gzip: (b) => zlib.gzipSync(b, { level: 9 }),
};
// Each page: zstd is fastest at a similar size. Files made once: Brotli at
// its best is smallest.
const PAGE_ORDER = HAS_ZSTD ? ['zstd', 'br', 'gzip'] : ['br', 'gzip'];
const FILE_ORDER = HAS_ZSTD ? ['br', 'zstd', 'gzip'] : ['br', 'gzip'];

// The first encoding in `order` that Accept-Encoding allows (q above 0).
function pick(header, order) {
  const allowed = new Map();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    allowed.set(name.trim(), q ? Number(q.slice(2)) : 1);
  }
  return order.find((e) => allowed.get(e) > 0) || '';
}

// Compresses what res.send sends (rendered pages, res.json, sitemaps …).
function pages({ disabled = false } = {}) {
  return (req, res, next) => {
    if (disabled) return next();
    const send = res.send;
    res.send = function compressedSend(body) {
      const text = typeof body === 'string';
      if (!(text || Buffer.isBuffer(body)) || this.get('Content-Encoding') || this.statusCode < 200 || this.statusCode === 204 || this.statusCode === 304) return send.call(this, body);
      if (/no-transform/i.test(String(this.get('Cache-Control') || ''))) return send.call(this, body);
      const type = this.get('Content-Type') || (text ? 'text/html' : '');
      if (!COMPRESSIBLE.test(type)) return send.call(this, body);
      const buf = text ? Buffer.from(body, 'utf8') : body;
      if (buf.length < MIN_BYTES) return send.call(this, body);
      this.vary('Accept-Encoding');
      const enc = pick(req.get('Accept-Encoding'), PAGE_ORDER);
      if (!enc) return send.call(this, body);
      if (!this.get('Content-Type')) this.type('html');
      if (text && !/charset=/i.test(this.get('Content-Type'))) this.set('Content-Type', `${this.get('Content-Type')}; charset=utf-8`);
      this.set('Content-Encoding', enc);
      return send.call(this, FAST[enc](buf));
    };
    next();
  };
}

// The site's CSS and JS, compressed once per encoding and kept in memory.
// Anything else (and browsers accepting no encoding) goes on to
// express.static.
function assets(publicDir, dirs = ['css', 'js']) {
  const files = new Map();
  for (const d of dirs) {
    const full = path.join(publicDir, d);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      const ext = path.extname(name);
      if (!['.css', '.js'].includes(ext)) continue;
      const file = path.join(full, name);
      const raw = fs.readFileSync(file);
      if (raw.length < MIN_BYTES) continue;
      files.set(`/${d}/${name}`, { raw, type: ext === '.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', modified: fs.statSync(file).mtime.toUTCString(), encoded: {} });
    }
  }
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const f = files.get(req.path);
    if (!f) return next();
    res.vary('Accept-Encoding');
    const enc = pick(req.get('Accept-Encoding'), FILE_ORDER);
    if (!enc) return next();
    if (!f.encoded[enc]) f.encoded[enc] = BEST[enc](f.raw);
    res.set({ 'Content-Type': f.type, 'Content-Encoding': enc, 'Last-Modified': f.modified, 'Cache-Control': req.query.v ? YEAR : 'public, max-age=3600' });
    return res.send(f.encoded[enc]);
  };
}

module.exports = { pick, pages, assets, MIN_BYTES, HAS_ZSTD, YEAR };
