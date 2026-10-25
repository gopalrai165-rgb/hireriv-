// Reads every route straight from the source files and works out who may use it
// from its middleware, so docs/ACCESS.md and the access tests can't drift from the code.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Route paths built in a loop; listed here so each real path is checked.
const EXPAND = {
  route: ['/employer/setup/:token', '/employer/reset/:token'],
  resumePath: ['/account/resume', '/account/resumes'],
  '`/employer/jobs/:id/${action}`': ['/employer/jobs/:id/publish', '/employer/jobs/:id/pause', '/employer/jobs/:id/resume', '/employer/jobs/:id/close'],
  '`/account/interviews/:appId/:ivId/${answer}`': ['/account/interviews/:appId/:ivId/confirm', '/account/interviews/:appId/:ivId/reschedule'],
  '`/api/ats/offers/:offerId/${path}`': ['/api/ats/offers/:offerId/approve', '/api/ats/offers/:offerId/response'],
  from: ['/employers', '/employers/register', '/employers/login', '/employers/dashboard', '/employers/company-profile', '/employers/jobs', '/employers/jobs/create', '/employers/applicants', '/employers/ats', '/employers/interviews', '/employers/team', '/employers/settings'],
  '`/candidate${from}`': ['/candidate', '/candidate/dashboard', '/candidate/register', '/candidate/login', '/candidate/forgot-password', '/candidate/profile', '/candidate/resumes', '/candidate/applications', '/candidate/saved-jobs', '/candidate/alerts', '/candidate/interviews', '/candidate/settings'],
};

function policyOf(args, p) {
  if (args.includes('requireAdmin')) return 'admin';
  if (args.includes('adminAuth')) return 'team';
  if (args.includes('requireCandidate')) return 'candidate';
  if (args.includes('requireEmployer')) return 'employer';
  // Any signed-in account (candidate, employer or team): the notification center.
  if (args.includes('anyAccount')) return 'account';
  if (p.includes(':token')) return 'link';
  return 'public';
}

function sourceRoutes() {
  const out = [];
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)) {
      const m = /app\.(get|post|put|patch|delete)\((.+?)(?:, (?:async )?\(req, res)/.exec(line);
      if (!m) continue;
      const method = m[1].toUpperCase();
      const first = m[2].split(',')[0].trim();
      let paths;
      if (EXPAND[first]) paths = EXPAND[first];
      else {
        const raw = first.replace(/^['`]|['`]$/g, '');
        paths = raw.includes('${action}') ? ['approve', 'reject'].map((a) => raw.replace('${action}', a)) : [raw];
      }
      for (const p of paths) out.push({ method, path: p, policy: policyOf(m[2], p), file });
    }
  }
  return out;
}

// Rows of the table in docs/ACCESS.md: | METHOD | `path` | policy | notes |
function documentedRoutes() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'ACCESS.md'), 'utf8');
  return [...md.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \| (\w+) \|/gm)].map((m) => ({ method: m[1], path: m[2], policy: m[3] }));
}

module.exports = { sourceRoutes, documentedRoutes };
