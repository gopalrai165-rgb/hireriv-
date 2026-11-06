// Government job notices (Step 195): information about recruitment by government
// bodies, with a link to the official notice. Hireriv is not part of any of them
// and takes no applications or money for these posts.
//
// Rules: nothing is public until a person on the team has read the official notice
// and says so. The source must be an https link, and one outside the usual
// government addresses needs a second tick. Changing a published notice takes it
// down until it is checked again, and a notice leaves the list after its last day.
// Each page carries the non-affiliation notice and a warning about fees. These are
// not vacancies Hireriv handles, so they get no job data for search engines. With
// nothing published, the section isn't linked or listed anywhere.
const crypto = require('crypto');

const NOTICES = 'gov-notices';
// Government, public-institution and defence addresses in India.
const OFFICIAL_HOST = /(^|\.)(gov\.in|nic\.in|ac\.in|res\.in|edu\.in|mil\.in)$/i;
const iso = () => new Date().toISOString();
const line = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const istDay = (ms = Date.now()) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
const realDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

function sourceHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password ? u.hostname : '';
  } catch (e) {
    return '';
  }
}
const isOfficialHost = (host) => OFFICIAL_HOST.test(host);

function register(app, deps) {
  const { db, team, adminAuth, requireAdmin, sameOrigin, limit, site } = deps;
  const find = (id) => db.where(NOTICES, 'id', String(id))[0] || null;
  const all = () => [...db.all(NOTICES)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const open = (n, today = istDay()) => n.status === 'published' && n.lastDate >= today;
  const live = () => db.all(NOTICES).filter((n) => open(n)).sort((a, b) => String(a.lastDate).localeCompare(String(b.lastDate)));

  function readForm(body) {
    const values = {
      title: line(body.title, 140),
      organisation: line(body.organisation, 120),
      posts: line(body.posts, 60),
      qualification: line(body.qualification, 200),
      location: line(body.location, 120),
      lastDate: line(body.lastDate, 10),
      sourceUrl: line(body.sourceUrl, 500),
      summary: String(body.summary == null ? '' : body.summary).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000),
    };
    const errors = [];
    if (values.title.length < 5) errors.push('Write the post or exam name.');
    if (values.organisation.length < 2) errors.push('Say which government body is recruiting.');
    if (!realDate(values.lastDate)) errors.push('Enter the last date to apply from the official notice.');
    if (!sourceHost(values.sourceUrl)) errors.push('The official notice link must be a full https:// address.');
    return { values, errors };
  }

  // ---------- the team's pages ----------
  const view = (req, res, section, locals = {}, status = 200) => {
    res.status(status).set('Cache-Control', 'no-store').render('admin-gov-jobs', {
      title: 'Government jobs', page: 'admin', noindex: true, section, msg: line(req.query.msg, 200), errors: [], notice: null, values: {}, list: [], today: istDay(), official: false, ...locals,
    });
  };
  const back = (res, id, msg) => res.redirect(303, `/admin/government-jobs${id ? `/${id}` : ''}?msg=${encodeURIComponent(msg)}`);
  const one = (req, res, n, locals = {}, status = 200) => view(req, res, 'one', { notice: n, values: n, official: isOfficialHost(sourceHost(n.sourceUrl)), ...locals }, status);

  app.get('/admin/government-jobs', adminAuth, requireAdmin, (req, res) => view(req, res, 'list', { list: all() }));
  app.get('/admin/government-jobs/new', adminAuth, requireAdmin, (req, res) => view(req, res, 'new'));
  app.post('/admin/government-jobs', adminAuth, requireAdmin, limit('gov-notices', 60), sameOrigin, (req, res) => {
    const { values, errors } = readForm(req.body);
    if (errors.length) return view(req, res, 'new', { errors, values }, 400);
    const n = { id: crypto.randomUUID(), ...values, status: 'draft', createdAt: iso(), createdBy: req.admin.name, updatedAt: iso(), checkedAt: null, checkedBy: null };
    db.prepend(NOTICES, n);
    team.log(req.admin, 'Added a government job notice', n.title);
    back(res, n.id, 'Saved as a draft. Read the official notice, then publish it.');
  });
  app.get('/admin/government-jobs/:id', adminAuth, requireAdmin, (req, res, next) => {
    const n = find(req.params.id);
    if (!n) return next();
    one(req, res, n);
  });
  app.post('/admin/government-jobs/:id', adminAuth, requireAdmin, limit('gov-notices', 60), sameOrigin, (req, res, next) => {
    const n = find(req.params.id);
    if (!n) return next();
    const { values, errors } = readForm(req.body);
    if (errors.length) return one(req, res, n, { errors, values }, 400);
    const changed = Object.keys(values).some((k) => (n[k] || '') !== values[k]);
    if (!changed) return back(res, n.id, 'No changes.');
    // New words have not been checked against the notice.
    const wasLive = n.status === 'published';
    db.update(NOTICES, { ...n, ...values, status: wasLive ? 'draft' : n.status, checkedAt: null, checkedBy: null, updatedAt: iso() });
    team.log(req.admin, 'Changed a government job notice', values.title);
    back(res, n.id, wasLive ? 'Saved and taken off the site until it is checked again.' : 'Saved.');
  });
  app.post('/admin/government-jobs/:id/publish', adminAuth, requireAdmin, limit('gov-notices', 60), sameOrigin, (req, res, next) => {
    const n = find(req.params.id);
    if (!n) return next();
    const errors = [];
    if (n.status === 'published') errors.push('This notice is already published.');
    if (n.lastDate < istDay()) errors.push('The last date has passed, so there is nothing to publish.');
    if (req.body.checked !== '1') errors.push('Tick that you read the official notice and the details match it.');
    if (!isOfficialHost(sourceHost(n.sourceUrl)) && req.body.otherSource !== '1') errors.push(`${sourceHost(n.sourceUrl)} is not a usual government address. Tick that you are sure it is this body's official site.`);
    if (errors.length) return one(req, res, n, { errors }, 400);
    db.update(NOTICES, { ...n, status: 'published', checkedAt: iso(), checkedBy: req.admin.name, updatedAt: iso() });
    team.log(req.admin, 'Published a government job notice', `${n.title} (${n.sourceUrl})`);
    back(res, n.id, 'Published.');
  });
  app.post('/admin/government-jobs/:id/withdraw', adminAuth, requireAdmin, limit('gov-notices', 60), sameOrigin, (req, res, next) => {
    const n = find(req.params.id);
    if (!n) return next();
    if (n.status !== 'published') return back(res, n.id, 'This notice is not published.');
    db.update(NOTICES, { ...n, status: 'withdrawn', checkedAt: null, checkedBy: null, updatedAt: iso() });
    team.log(req.admin, 'Took down a government job notice', n.title);
    back(res, n.id, 'Taken off the site.');
  });
  app.post('/admin/government-jobs/:id/delete', adminAuth, requireAdmin, limit('gov-notices', 60), sameOrigin, (req, res, next) => {
    const n = find(req.params.id);
    if (!n) return next();
    if (n.status === 'published') return back(res, n.id, 'Take it off the site before deleting it.');
    db.remove(NOTICES, [n.id]);
    team.log(req.admin, 'Deleted a government job notice', n.title);
    back(res, '', 'Deleted.');
  });

  // ---------- the public pages ----------
  const publicView = (n) => ({ ...n, host: sourceHost(n.sourceUrl) });
  app.get('/government-jobs', (req, res) => {
    const list = live();
    res.render('gov-jobs', {
      title: 'Government job notices', page: 'jobs', noindex: !list.length,
      description: `Government recruitment notices checked against the official source, with links to apply on the official site. ${site.name} is not part of the government.`,
      list: list.map(publicView), canonical: '/government-jobs',
    });
  });
  app.get('/government-jobs/:id', (req, res, next) => {
    const n = find(req.params.id);
    if (!n || !['published', 'withdrawn'].includes(n.status)) return next();
    // Past its last day, or taken down: the address stays useful but says so, out of search.
    const isOpen = open(n);
    res.status(isOpen ? 200 : 410).render('gov-job', {
      title: `${n.title}, ${n.organisation}`, page: 'jobs', noindex: !isOpen,
      description: `${n.title} at ${n.organisation}. Last date in the official notice. ${site.name} is not part of the government: apply only on the official site.`,
      notice: publicView(n), isOpen, canonical: `/government-jobs/${n.id}`,
    });
  });

  const sitemapPaths = () => { const list = live(); return list.length ? ['/government-jobs', ...list.map((n) => `/government-jobs/${n.id}`)] : []; };
  return { live, sitemapPaths };
}

module.exports = { register, isOfficialHost, sourceHost };
