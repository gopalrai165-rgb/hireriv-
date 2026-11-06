// Second-person approval for bulk exports (the full database, backup copies and
// CSV exports with personal data). The owner chooses whether to use it
// (Admin → Export approvals). It only applies while the team has two or more
// active Admins, so a business with a single Admin can never be locked out of
// its own backups. An approval is for one person and one download, given by a
// different Admin, and lasts 24 hours; asking, approving, declining and using
// it are all in the team activity log and the security log.
const crypto = require('crypto');

const COLLECTION = 'export-requests';
const SETTING = 'export-approval:on';
const VALID_MS = 24 * 3600000;
const PENDING_MS = 7 * 24 * 3600000;
const clip = (s, n) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

function register(app, deps) {
  const { db, team, adminAuth, requireAdmin, requireConfirmed, sameOrigin, limit, events, security } = deps;
  const all = () => db.all(COLLECTION);
  const save = (list) => db.replaceAll(COLLECTION, list);
  // Admins who can sign in (an invitation not yet accepted cannot approve anything).
  const admins = () => team.members().filter((u) => u.role === 'Admin' && u.active !== false && !u.pending);
  const turnedOn = () => db.metaGet(SETTING) === '1';
  const inForce = () => turnedOn() && admins().length >= 2;
  const now = () => Date.now();
  // Requests that ran out are shown as expired.
  const statusOf = (r) => {
    if (r.status === 'pending' && now() - Date.parse(r.createdAt) > PENDING_MS) return 'expired';
    if (r.status === 'approved' && now() - Date.parse(r.decidedAt) > VALID_MS) return 'expired';
    return r.status;
  };
  const pathOf = (req) => req.originalUrl.split('?')[0];
  const mineFor = (req, target) => all().filter((r) => r.requesterId === req.admin.id && r.target === target);

  // Middleware for the export routes: lets the download through with an
  // approval (used up on the way), otherwise asks for one.
  function requireApproval(label) {
    return (req, res, next) => {
      if (!inForce()) return next();
      const target = pathOf(req);
      const name = typeof label === 'function' ? label(req) : label;
      const list = all();
      const ok = list.find((r) => r.requesterId === req.admin.id && r.target === target && statusOf(r) === 'approved');
      if (ok) {
        ok.status = 'used';
        ok.usedAt = new Date().toISOString();
        save(list);
        team.log(req.admin, `Used an approved export: ${name}`, target);
        return next();
      }
      const pending = mineFor(req, target).find((r) => statusOf(r) === 'pending');
      res.status(403).set('Cache-Control', 'no-store').render('admin-export-approval', {
        title: 'Approval needed', page: 'admin', noindex: true, section: 'ask', target, name, pending, others: admins().filter((u) => u.id !== req.admin.id), msg: '', errors: [],
      });
    };
  }

  // Ask another Admin.
  app.post('/admin/export-requests', adminAuth, sameOrigin, limit('export-request', 10, 3600000), (req, res) => {
    const target = clip(req.body.target, 200);
    const name = clip(req.body.name, 120) || target;
    const reason = clip(req.body.reason, 300);
    // Only the export addresses can be asked for.
    if (!/^\/admin\/(backup|backups\/[\w.-]+|export\/[\w-]+\.csv)$/.test(target)) return res.status(400).render('thanks', { title: 'Not an export', page: '', ok: false, message: 'Only database, backup and CSV exports need approval.', noindex: true });
    if (!inForce()) return res.redirect(303, target);
    if (!reason) {
      return res.status(400).render('admin-export-approval', { title: 'Approval needed', page: 'admin', noindex: true, section: 'ask', target, name, pending: null, others: admins().filter((u) => u.id !== req.admin.id), msg: '', errors: ['Say why you need this export, so the other Admin can decide.'] });
    }
    const list = all();
    if (!list.some((r) => r.requesterId === req.admin.id && r.target === target && statusOf(r) === 'pending')) {
      const r = { id: `xr-${crypto.randomUUID()}`, requesterId: req.admin.id, requesterName: req.admin.name, target, name, reason, status: 'pending', createdAt: new Date().toISOString() };
      save([r, ...list]);
      team.log(req.admin, `Asked for approval to export ${name}`, reason);
      security.record('export-requested', { req, target: name, detail: reason });
      events().exportRequested(r, admins().filter((u) => u.id !== req.admin.id).map((u) => u.id));
    }
    res.redirect(303, `/admin/export-requests?msg=${encodeURIComponent('Asked. You will get a notification when another Admin answers.')}`);
  });

  // The list: requests waiting for me, my own, and the setting.
  app.get('/admin/export-requests', adminAuth, (req, res) => {
    const list = all().map((r) => ({ ...r, status: statusOf(r) }));
    res.set('Cache-Control', 'no-store').render('admin-export-approval', {
      title: 'Export approvals', page: 'admin', noindex: true, section: 'list', msg: clip(req.query.msg, 200), errors: [],
      waiting: req.admin.role === 'Admin' ? list.filter((r) => r.status === 'pending' && r.requesterId !== req.admin.id) : [],
      mine: list.filter((r) => r.requesterId === req.admin.id).slice(0, 20),
      history: req.admin.role === 'Admin' ? list.filter((r) => r.status !== 'pending').slice(0, 30) : [],
      on: turnedOn(), inForce: inForce(), adminCount: admins().length, isAdmin: req.admin.role === 'Admin',
    });
  });

  // Approve or decline: an Admin who is not the one asking, after confirming it's them.
  const decide = (answer) => (req, res, next) => {
      const list = all();
      const r = list.find((x) => x.id === req.params.id);
      if (!r) return next();
      if (r.requesterId === req.admin.id) return res.status(403).render('thanks', { title: 'Someone else has to answer', page: '', ok: false, message: 'You cannot approve your own export. Another Admin has to.', noindex: true });
      if (statusOf(r) !== 'pending') return res.redirect(303, `/admin/export-requests?msg=${encodeURIComponent('That request was already answered or has run out.')}`);
      Object.assign(r, { status: answer === 'approve' ? 'approved' : 'declined', decidedBy: req.admin.id, decidedByName: req.admin.name, decidedAt: new Date().toISOString() });
      save(list);
      team.log(req.admin, `${answer === 'approve' ? 'Approved' : 'Declined'} ${r.requesterName}'s export of ${r.name}`, r.reason);
      security.record('export-decided', { req, target: r.name, detail: `${answer}d for ${r.requesterName}` });
      events().exportDecided(r);
      res.redirect(303, `/admin/export-requests?msg=${encodeURIComponent(answer === 'approve' ? `Approved. ${r.requesterName} can download ${r.name} once in the next 24 hours.` : 'Declined.')}`);
  };
  app.post('/admin/export-requests/:id/approve', adminAuth, requireAdmin, sameOrigin, limit('export-decision', 30, 3600000), requireConfirmed, (req, res, next) => decide('approve')(req, res, next));
  app.post('/admin/export-requests/:id/decline', adminAuth, requireAdmin, sameOrigin, limit('export-decision', 30, 3600000), requireConfirmed, (req, res, next) => decide('decline')(req, res, next));

  // Turn the rule on or off (Admins, after confirming it's them).
  app.post('/admin/export-requests/settings', adminAuth, requireAdmin, sameOrigin, limit('export-setting', 10, 3600000), requireConfirmed, (req, res) => {
    const on = req.body.on === '1';
    db.metaSet(SETTING, on ? '1' : '');
    team.log(req.admin, on ? 'Turned on second-Admin approval for exports' : 'Turned off second-Admin approval for exports');
    security.record('privileged-change', { req, target: 'Export approvals', detail: on ? 'on' : 'off' });
    res.redirect(303, `/admin/export-requests?msg=${encodeURIComponent(on ? (admins().length >= 2 ? 'Exports now need a second Admin.' : 'Turned on. It starts when the team has a second Admin.') : 'Exports no longer need a second Admin.')}`);
  });

  return { requireApproval, inForce, turnedOn };
}

module.exports = { register, COLLECTION, SETTING, VALID_MS };
