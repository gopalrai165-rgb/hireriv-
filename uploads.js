// Resume safety: the file must really be a PDF, Word or old Word document (by
// its first bytes, not just its name), it is scanned for malware when a ClamAV
// daemon is configured, files that pass are encrypted on disk (vault.js), and
// resumes are downloaded only through signed links that expire after a few minutes.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const vault = require('./vault');

// The first bytes of each allowed type.
const SIGNATURES = {
  '.pdf': [Buffer.from('%PDF-')],
  '.docx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])], // a ZIP container
  '.doc': [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], // OLE2
  // Photos and scans of onboarding documents (never resumes).
  '.jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
};
const RESUME_TYPES = ['.pdf', '.doc', '.docx'];
const DOCUMENT_TYPES = ['.pdf', '.jpg', '.jpeg', '.png'];

function hasValidSignature(file, originalname) {
  const want = SIGNATURES[path.extname(originalname || file).toLowerCase()];
  if (!want) return false;
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  return want.some((sig) => head.subarray(0, sig.length).equals(sig));
}

// ClamAV's clamd INSTREAM command: the file in length-prefixed chunks, then a
// zero-length chunk; clamd answers "stream: OK" or "stream: <name> FOUND".
function clamScan(file, { host, port = 3310, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let reply = '';
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeoutMs, () => fail(new Error('virus scanner timed out')));
    socket.on('error', fail);
    socket.on('data', (d) => { reply += d.toString('utf8'); });
    socket.on('end', () => {
      const text = reply.replace(/\0/g, '').trim();
      const found = text.match(/:\s*(.+)\s+FOUND$/);
      if (found) return resolve({ clean: false, threat: found[1] });
      if (/:\s*OK$/.test(text)) return resolve({ clean: true });
      reject(new Error(`virus scanner error: ${text || 'no reply'}`));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      });
      stream.on('end', () => socket.write(Buffer.alloc(4)));
      stream.on('error', fail);
    });
  });
}

// Checks an uploaded resume. Resolves to an error message for the person, or
// '' when the file is fine. A file that fails is deleted. When a scanner is
// configured but can't be reached, the upload is refused (fail closed).
function create({ clamHost = process.env.CLAMAV_HOST, clamPort = Number(process.env.CLAMAV_PORT) || 3310, log = console } = {}) {
  async function vet(file, { types = RESUME_TYPES, what = 'resume' } = {}) {
    if (!file) return '';
    // Deleted before the reply goes out, so a refused file is never left behind.
    const drop = () => { try { fs.unlinkSync(file.path); } catch { /* already gone */ } };
    if (!types.includes(path.extname(file.originalname || '').toLowerCase()) || !hasValidSignature(file.path, file.originalname)) {
      drop();
      return what === 'resume'
        ? "That file doesn't look like a real PDF or Word document. Please upload your resume as a PDF, DOC or DOCX."
        : "That file doesn't look like a real PDF, JPG or PNG. Please upload a photo or scan of the document.";
    }
    // A file that passed is encrypted on disk straight away (vault.js).
    const keep = () => {
      try {
        vault.seal(file.path);
        return '';
      } catch (err) {
        log.error(`Upload not encrypted: ${err.message}`);
        drop();
        return "We couldn't store your file safely just now. Please try again in a few minutes.";
      }
    };
    if (!clamHost) return keep();
    try {
      const result = await clamScan(file.path, { host: clamHost, port: clamPort });
      if (result.clean) return keep();
      log.warn(`Blocked an infected upload (${result.threat})`);
      drop();
      return `Your file was blocked by our virus scanner. Please upload a clean copy of your ${what}.`;
    } catch (err) {
      log.error(`Resume not scanned: ${err.message}`);
      drop();
      return "We couldn't check your file for viruses just now. Please try again in a few minutes.";
    }
  }
  // Onboarding documents: PDF or a photo, same checks and scan.
  const vetDocument = (file) => vet(file, { types: DOCUMENT_TYPES, what: 'document' });
  return { vet, vetDocument, scanning: Boolean(clamHost) };
}

// ---------- signed, expiring download links ----------
const LINK_MINUTES = 15;
// `secret` may be a function, so rotating it (an incident) cancels every link issued so far.
function links(secret) {
  const key = () => (typeof secret === 'function' ? secret() : secret);
  const sign = (url, exp) => crypto.createHmac('sha256', key()).update(`${url}|${exp}`).digest('base64url');
  return {
    // Adds ?exp=…&sig=… to a download path (the page must be fresh to download).
    signed(url, minutes = LINK_MINUTES) {
      const exp = Date.now() + minutes * 60000;
      return `${url}${url.includes('?') ? '&' : '?'}exp=${exp}&sig=${sign(url, exp)}`;
    },
    // Checks a request's link: the path it was signed for, not expired.
    valid(req) {
      const exp = Number(req.query.exp);
      const sig = String(req.query.sig || '');
      if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
      const want = Buffer.from(sign(req.path, exp));
      const got = Buffer.from(sig);
      return want.length === got.length && crypto.timingSafeEqual(want, got);
    },
  };
}

module.exports = { create, links, hasValidSignature, clamScan, LINK_MINUTES, RESUME_TYPES, DOCUMENT_TYPES };
