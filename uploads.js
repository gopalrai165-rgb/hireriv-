// Resume safety: the file must really be a PDF, Word or old Word document (by
// its first bytes, not just its name), it is scanned for malware when a ClamAV
// daemon is configured, and resumes are downloaded only through signed links
// that expire after a few minutes.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

// The first bytes of each allowed type.
const SIGNATURES = {
  '.pdf': [Buffer.from('%PDF-')],
  '.docx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])], // a ZIP container
  '.doc': [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], // OLE2
};

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
  async function vet(file) {
    if (!file) return '';
    const drop = () => fs.unlink(file.path, () => {});
    if (!hasValidSignature(file.path, file.originalname)) {
      drop();
      return "That file doesn't look like a real PDF or Word document. Please upload your resume as a PDF, DOC or DOCX.";
    }
    if (!clamHost) return '';
    try {
      const result = await clamScan(file.path, { host: clamHost, port: clamPort });
      if (result.clean) return '';
      log.warn(`Blocked an infected upload (${result.threat})`);
      drop();
      return 'Your file was blocked by our virus scanner. Please upload a clean copy of your resume.';
    } catch (err) {
      log.error(`Resume not scanned: ${err.message}`);
      drop();
      return "We couldn't check your file for viruses just now. Please try again in a few minutes.";
    }
  }
  return { vet, scanning: Boolean(clamHost) };
}

// ---------- signed, expiring download links ----------
const LINK_MINUTES = 15;
function links(secret) {
  const sign = (url, exp) => crypto.createHmac('sha256', secret).update(`${url}|${exp}`).digest('base64url');
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

module.exports = { create, links, hasValidSignature, clamScan, LINK_MINUTES };
