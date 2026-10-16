// Starts the real server on a spare port with its own throwaway database,
// uploads folder and email outbox, so tests never touch data/.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const ADMIN_PASS = 'test-owner-password';

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-test-'));
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const paths = { dir, db: path.join(dir, 'test.db'), uploads: path.join(dir, 'uploads'), outbox: path.join(dir, 'outbox') };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: paths.db, UPLOADS_DIR: paths.uploads, OUTBOX_DIR: paths.outbox,
      ADMIN_PASS, SITE_URL: '', SMTP_HOST: '', NODE_ENV: 'test', TRUST_PROXY: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch (e) { /* not listening yet */ }
    if (child.exitCode !== null || i > 100) throw new Error(`Server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const server = {
    base,
    paths,
    output: () => output,
    // Requests a browser would make from this site (forms pass the same-origin check).
    async request(urlPath, { method = 'GET', form, body, cookie, headers = {} } = {}) {
      const h = { origin: base, ...headers };
      if (cookie) h.cookie = cookie;
      if (form) {
        h['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      }
      const res = await fetch(base + urlPath, { method, body, headers: h, redirect: 'manual' });
      return res;
    },
    cookieFrom: (res) => (res.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; '),
    // Read-only peek at what the app stored.
    records(collection) {
      const db = new DatabaseSync(paths.db, { readOnly: true });
      try {
        return db.prepare('SELECT data FROM records WHERE collection = ? ORDER BY pos').all(collection).map((r) => JSON.parse(r.data));
      } finally {
        db.close();
      }
    },
    emails() {
      if (!fs.existsSync(paths.outbox)) return [];
      return fs.readdirSync(paths.outbox).sort().map((f) => fs.readFileSync(path.join(paths.outbox, f), 'utf8'));
    },
    // Emails are written in the background after the response is sent.
    async waitForEmail(match, timeoutMs = 5000) {
      for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
        const found = server.emails().find(match);
        if (found) return found;
      }
      throw new Error('expected email was not sent');
    },
    async adminLogin() {
      const res = await server.request('/admin/login', { method: 'POST', form: { login: 'admin', password: ADMIN_PASS, next: '/admin' } });
      if (res.status !== 302) throw new Error(`admin login failed: ${res.status}`);
      return server.cookieFrom(res);
    },
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return server;
}

// A tiny file with a resume's extension. It has no readable text, which the
// app handles like a scanned PDF.
function resumeForm(fields, filename = 'resume.pdf') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('resume', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), filename);
  return fd;
}

// Decode a quoted-printable .eml body enough to find links in it.
const decodeEmail = (eml) => eml.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

module.exports = { startServer, resumeForm, decodeEmail, ADMIN_PASS };
