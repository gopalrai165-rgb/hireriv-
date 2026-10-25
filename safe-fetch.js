// Outbound requests to addresses other people give us (webhook URLs), with
// protection against server-side request forgery: only http(s) to public
// addresses, the name resolved by us and the connection made to the address
// we checked (so a second DNS answer can't point it somewhere else), every
// redirect target checked again, short timeouts and a small response limit.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;
const MAX_RESPONSE = 4096;

// IPv4 ranges that are private, shared, reserved, documentation or not routable.
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = (ip) => ip.split('.').reduce((n, x) => (n * 256) + Number(x), 0);
function blockedV4(ip) {
  const n = v4num(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4num(base);
    return n >= start && n < start + size;
  });
}
// Expands an IPv6 address to its eight 16-bit groups.
function v6groups(ip) {
  let s = ip.toLowerCase().split('%')[0];
  // An embedded IPv4 tail (::ffff:1.2.3.4).
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4num(tail[1]);
    s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = s.includes('::') ? Array(8 - a.length - b.length).fill('0') : [];
  return [...a, ...fill, ...b].map((g) => parseInt(g || '0', 16));
}
function blockedV6(ip) {
  const g = v6groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96): check the IPv4 inside.
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(v4);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}
const isBlockedAddress = (ip) => (net.isIPv4(ip) ? blockedV4(ip) : net.isIPv6(ip) ? blockedV6(ip) : true);

// The URL itself, before any lookup: { url } or { error }.
function checkUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return { error: 'enter a full address starting with https://' }; }
  if (String(raw).length > 500) return { error: 'the address is too long' };
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) return { error: 'webhook addresses must use https://' };
  if (u.username || u.password) return { error: 'the address must not contain a user name or password' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate) {
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host) || !host.includes('.') && !net.isIP(host)) return { error: 'the address must be a public internet address' };
    if (net.isIP(host) && isBlockedAddress(host)) return { error: 'the address must be a public internet address' };
    if (u.port && !['443', '8443'].includes(u.port)) return { error: 'use port 443 or 8443' };
  }
  return { url: u };
}

// Resolves the host and checks every address it gives: { address, family } or { error }.
async function resolveSafe(u, { allowPrivate = false, lookup = dns.promises.lookup } = {}) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let list;
  if (net.isIP(host)) list = [{ address: host, family: net.isIP(host) }];
  else {
    try { list = await lookup(host, { all: true, verbatim: true }); } catch (e) { return { error: 'the address could not be found' }; }
  }
  if (!list.length) return { error: 'the address could not be found' };
  // Every answer must be public, or a later lookup could pick a private one.
  if (!allowPrivate && list.some((a) => isBlockedAddress(a.address))) return { error: 'the address points to a private or reserved network' };
  return { address: list[0].address, family: list[0].family };
}

// One request to an address we checked; follows 307 and 308 redirects (which
// keep the method and body), checking each new target. { status, body, url } or { error }.
// `checkHop(url, n)` can loosen the check for one hop (only the tests use it).
async function safeRequest(raw, { method = 'POST', headers = {}, body = '', allowPrivate = false, lookup, timeoutMs = TIMEOUT_MS, checkHop } = {}) {
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const opts = { allowPrivate, ...(checkHop ? checkHop(target, hop) : {}) };
    const c = checkUrl(target, opts);
    if (c.error) return { error: c.error };
    const r = await resolveSafe(c.url, { ...opts, lookup });
    if (r.error) return { error: r.error };
    const res = await once(c.url, r, { method, headers, body, timeoutMs });
    if (res.error) return res;
    if ([307, 308].includes(res.status) && res.location) {
      target = new URL(res.location, c.url).toString();
      continue;
    }
    if (res.status >= 300 && res.status < 400) return { status: res.status, body: res.body, url: c.url.toString(), error: 'redirects other than 307 and 308 are not followed' };
    return { status: res.status, body: res.body, url: c.url.toString() };
  }
  return { error: 'too many redirects' };
}

function once(u, { address, family }, { method, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`, method,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      // Connect to the address we checked, whatever DNS says now.
      lookup: (h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      servername: net.isIP(u.hostname) ? undefined : u.hostname, timeout: timeoutMs,
    }, (res) => {
      let got = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (got.length < MAX_RESPONSE) got += d.slice(0, MAX_RESPONSE - got.length); });
      res.on('end', () => resolve({ status: res.statusCode, body: got, location: res.headers.location }));
      res.on('error', () => resolve({ error: 'the response was interrupted' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: `no answer within ${Math.round(timeoutMs / 1000)} seconds` }); });
    req.on('error', (e) => resolve({ error: e.code === 'ECONNREFUSED' ? 'the connection was refused' : e.code === 'CERT_HAS_EXPIRED' ? 'the certificate has expired' : /certificate|SSL|TLS/i.test(e.message) ? 'the TLS certificate was not accepted' : 'the connection failed' }));
    req.end(body);
  });
}

module.exports = { checkUrl, resolveSafe, safeRequest, isBlockedAddress };
