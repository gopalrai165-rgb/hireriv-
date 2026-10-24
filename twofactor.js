// Two-step sign-in for team logins: 6-digit codes from an authenticator app
// (TOTP, RFC 6238, the same scheme Google Authenticator, Microsoft
// Authenticator and Authy use) plus single-use recovery codes for a lost phone.
const crypto = require('crypto');
const qrcode = require('qrcode-generator');

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // accept the code before and after, for phone clocks a little off
const RECOVERY_COUNT = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Recovery codes skip look-alike characters (0/o, 1/l/i) so they can be typed from paper.
const RECOVERY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));
const stepAt = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

function codeFor(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

// Returns the time step the code belongs to, or null. A code at or before
// `lastStep` was already used, so a code seen over someone's shoulder can't be replayed.
function verifyCode(secret, code, { now = Date.now(), lastStep = -1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const current = stepAt(now);
  for (let s = current - WINDOW; s <= current + WINDOW; s++) {
    if (s > lastStep && crypto.timingSafeEqual(Buffer.from(codeFor(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

// ---------- recovery codes ----------
const normalizeRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(normalizeRecovery(code)).digest('hex');

function newRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const chars = Array.from(crypto.randomBytes(8), (b) => RECOVERY_CHARS[b % RECOVERY_CHARS.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
  return { codes, hashes: codes.map(hashRecovery) };
}

// The index of the matching unused code, or -1.
function findRecovery(hashes, code) {
  if (normalizeRecovery(code).length !== 8) return -1;
  const h = hashRecovery(code);
  return (hashes || []).findIndex((x) => x && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
}

// ---------- setup ----------
function otpauthUrl({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// An inline SVG QR code (always dark on white, which every phone camera reads).
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true, alt: 'QR code for your authenticator app' });
}

// "JBSW Y3DP ..." is easier to type into an app than one long run of letters.
const groupSecret = (secret) => secret.replace(/(.{4})/g, '$1 ').trim();

module.exports = { base32Encode, base32Decode, newSecret, stepAt, codeFor, verifyCode, newRecoveryCodes, findRecovery, otpauthUrl, qrSvg, groupSecret, RECOVERY_COUNT };
