// Interview scheduling: book, list and cancel interviews on applications.
// Interviews live on the application record (application.interviews[]).
const crypto = require('crypto');
const { interviewIcs, istToDate, formatIst } = require('./ics');
const { moveStage } = require('./history');

const MODES = ['Video call', 'Phone', 'In person'];
const DURATIONS = [30, 45, 60, 90];

// Every interview across all applications, joined with its candidate.
function allInterviews(applications) {
  const list = [];
  for (const a of applications) for (const iv of a.interviews || []) list.push({ ...iv, app: a });
  return list;
}

function upcoming(applications, limit = Infinity) {
  const now = Date.now();
  return allInterviews(applications)
    .filter((iv) => iv.status === 'scheduled' && new Date(iv.at).getTime() + iv.duration * 60000 > now)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, limit);
}

function parseInterview(body, candidate) {
  const get = (k, max = 300) => String(body[k] ?? '').trim().slice(0, max);
  const f = { date: get('date', 10), time: get('time', 5), duration: Number(get('duration', 3)), mode: get('mode', 20), where: get('where'), interviewer: get('interviewer', 120), message: get('message', 1000) };
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || !/^\d{2}:\d{2}$/.test(f.time)) errors.push('pick a date and time');
  const at = istToDate(f.date, f.time);
  if (Number.isNaN(at.getTime())) errors.push('date or time is invalid');
  else if (at.getTime() < Date.now() - 5 * 60000) errors.push('the interview time is in the past');
  if (!DURATIONS.includes(f.duration)) errors.push('duration is invalid');
  if (!MODES.includes(f.mode)) errors.push('format is invalid');
  if (f.mode === 'Video call' && !/^https:\/\/[^\s"'<>]+$/i.test(f.where)) errors.push('add the video meeting link (starting with https://)');
  if (f.mode === 'In person' && !f.where) errors.push('add the interview address');
  if (f.mode === 'Phone' && !f.where) f.where = candidate.phone || '';
  return { f, at, errors };
}

function register(app, { adminAuth, sameOrigin, readSubmissions, writeSubmissions, mailer, site, adminUrl }) {
  const icsFor = (method, iv, a) => interviewIcs({ method, interview: iv, candidate: a, jobTitle: a.jobTitle, site });

  const formPage = (res, a, f, errors, status = 200) =>
    res.status(status).render('admin-interview', { title: 'Schedule interview', page: 'admin', a, f, errors, modes: MODES, durations: DURATIONS, noindex: true });

  app.get('/admin/applications/:id/interview', adminAuth, (req, res, next) => {
    const a = readSubmissions('applications').find((x) => x.id === req.params.id);
    if (!a) return next();
    // Default: tomorrow at 11:00 India time.
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    formPage(res, a, { date: tomorrow, time: '11:00', duration: 45, mode: 'Video call', where: '', interviewer: '', message: '' }, []);
  });

  app.post('/admin/applications/:id/interview', adminAuth, sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id);
    if (!a) return next();
    const { f, at, errors } = parseInterview(req.body, a);
    if (errors.length) return formPage(res, a, f, errors, 400);

    const iv = {
      id: crypto.randomUUID(),
      at: at.toISOString(),
      duration: f.duration,
      mode: f.mode,
      where: f.where,
      interviewer: f.interviewer,
      message: f.message,
      status: 'scheduled',
      sequence: 0,
      createdAt: new Date().toISOString(),
    };
    a.interviews = [...(a.interviews || []), iv];
    // Booking an interview moves early-stage candidates forward automatically.
    if (['New', 'Screening', undefined, ''].includes(a.status)) moveStage(a, 'Interview', `${req.admin.name} (interview booked)`, iv.createdAt);
    a.updatedAt = iv.createdAt;
    writeSubmissions('applications', list);
    mailer.interviewScheduled(a, iv, icsFor('REQUEST', iv, a), formatIst(at));
    res.redirect(adminUrl('interviews', `Interview booked with ${a.name} for ${formatIst(at)} · invite emailed`));
  });

  app.post('/admin/interviews/:appId/:ivId/cancel', adminAuth, sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.appId);
    const iv = a && (a.interviews || []).find((x) => x.id === req.params.ivId);
    if (!iv) return next();
    if (iv.status === 'scheduled') {
      iv.status = 'cancelled';
      iv.sequence = (iv.sequence || 0) + 1;
      iv.cancelledAt = new Date().toISOString();
      writeSubmissions('applications', list);
      mailer.interviewCancelled(a, iv, icsFor('CANCEL', iv, a), formatIst(iv.at));
    }
    res.redirect(adminUrl('interviews', `Cancelled the interview with ${a.name} · candidate notified`));
  });

  // Download the invite (e.g. to forward to the interviewer's calendar).
  app.get('/admin/interviews/:appId/:ivId.ics', adminAuth, (req, res, next) => {
    const a = readSubmissions('applications').find((x) => x.id === req.params.appId);
    const iv = a && (a.interviews || []).find((x) => x.id === req.params.ivId);
    if (!iv) return next();
    res.type('text/calendar').attachment(`interview-${a.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics`).send(icsFor(iv.status === 'cancelled' ? 'CANCEL' : 'REQUEST', iv, a));
  });
}

module.exports = { register, allInterviews, upcoming, formatIst };
