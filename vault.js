// Encryption at rest for uploaded documents: resumes, onboarding and identity
// documents, and complaint evidence. A file is sealed with AES-256-GCM as soon
// as it passes the type check and virus scan, and every download and resume
// reader opens it through here, so nothing outside the app can read the
// uploads folder (a copied disk, a synced folder, a stray backup).
//
// Sealed file: "HRVENC1\0" | key id (4 bytes) | IV (12) | tag (16) | ciphertext.
// The key comes from FILE_ENCRYPTION_KEY (32 bytes, hex or base64). Older keys
// listed in FILE_ENCRYPTION_KEYS_OLD still open files after a rotation, and
// `sweep` re-seals them with the current key. Files from before encryption
// are plain and still open; the sweep seals them too.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('HRVENC1\0');
const HEADER = MAGIC.length + 4 + 12 + 16;
const TMP = '.sealing';

let keys = []; // [{ id, key }], the first one seals

function parseKey(text) {
  const s = String(text || '').trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error('a file encryption key must be 32 bytes, as 64 hex characters or base64');
  return buf;
}
const idOf = (key) => crypto.createHash('sha256').update(key).digest().subarray(0, 4);

// keys: current first, then old ones (strings or Buffers).
function configure(list) {
  keys = list.filter(Boolean).map((k) => (Buffer.isBuffer(k) ? k : parseKey(k))).map((key) => ({ id: idOf(key), key }));
  if (!keys.length) throw new Error('no file encryption key');
}
const configured = () => keys.length > 0;
const newKey = () => crypto.randomBytes(32).toString('hex');
const currentKeyId = () => (keys[0] ? keys[0].id.toString('hex') : '');

const isSealed = (buf) => buf.length >= HEADER && buf.subarray(0, MAGIC.length).equals(MAGIC);
const sealedWithCurrent = (buf) => isSealed(buf) && buf.subarray(MAGIC.length, MAGIC.length + 4).equals(keys[0].id);

function encrypt(plain) {
  const { id, key } = keys[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(id);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, id, iv, cipher.getAuthTag(), body]);
}

// The file's real contents. Throws when it was sealed with an unknown key or changed.
function open(buf) {
  if (!isSealed(buf)) return buf;
  const id = buf.subarray(MAGIC.length, MAGIC.length + 4);
  const k = keys.find((x) => x.id.equals(id));
  if (!k) throw new Error('this file was encrypted with a key the server no longer has');
  const iv = buf.subarray(MAGIC.length + 4, MAGIC.length + 16);
  const tag = buf.subarray(MAGIC.length + 16, HEADER);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k.key, iv);
  decipher.setAAD(id);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(HEADER)), decipher.final()]);
}

// Seals a file in place (written next to it, then renamed over it). Returns
// true when it changed. Files already sealed with the current key are left.
function seal(file) {
  if (!configured()) return false;
  const buf = fs.readFileSync(file);
  if (sealedWithCurrent(buf)) return false;
  const tmp = `${file}${TMP}`;
  fs.writeFileSync(tmp, encrypt(open(buf)), { mode: 0o600 });
  // Windows refuses to replace a file another process still has open (a
  // virus scanner looking at a new upload, say): try again briefly, then copy over it.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) { fs.rmSync(tmp, { force: true }); throw err; }
      if (attempt < 5) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); continue; }
      try {
        fs.copyFileSync(tmp, file);
        return true;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  }
}

const readSync = (file) => open(fs.readFileSync(file));
const read = async (file) => open(await fs.promises.readFile(file));

// Sends a stored document as a download: never shown inline in the browser,
// never sniffed as another type, and run in a sandbox if a browser tries.
// `what` names the kind of document for the security log (security.js sets
// module.exports.onAccess to record who opened it).
function send(res, file, downloadName, what = 'Document') {
  const logged = (ok) => {
    if (typeof module.exports.onAccess === 'function') {
      try { module.exports.onAccess(res.req, what, ok); } catch (e) { console.error('Document access log failed:', e.message); }
    }
  };
  let data;
  try {
    data = readSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR') console.error(`Could not open ${path.basename(file)}: ${err.message}`);
    logged(false);
    return res.status(404).end();
  }
  logged(true);
  res.set({ 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' });
  res.attachment(downloadName);
  res.send(data);
}

// Seals every file under `dir` that is still plain or uses an old key.
// Leftovers from an interrupted seal are removed. Returns how many changed.
function sweep(dir) {
  if (!configured() || !fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { n += sweep(full); continue; }
    // Uploads always get generated names; dotfiles such as .gitkeep are not uploads.
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (entry.name.endsWith(TMP)) { fs.rmSync(full, { force: true }); continue; }
    try {
      if (seal(full)) n++;
    } catch (err) {
      console.error(`Could not encrypt ${entry.name}: ${err.message}`);
    }
  }
  return n;
}

module.exports = { onAccess: null, configure, configured, newKey, parseKey, currentKeyId, seal, open, read, readSync, send, sweep, isSealed };
