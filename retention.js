// Data retention: when switched on in Admin → Settings, candidates whose last
// activity is older than the chosen period are deleted with their resumes, and
// contact messages and hiring requests older than the period go too, as do job
// alerts never confirmed within 30 days. It is off
// by default and never touches placements or invoices (tax records), confirmed
// job alerts or newsletter subscriptions (people remove those themselves with
// the unsubscribe link).
const fs = require('fs');
const path = require('path');

const PERIODS = [0, 12, 24, 36]; // months; 0 = keep until deleted by hand
// Candidates linked to a placement in one of these states are always kept.
const ACTIVE_PLACEMENT = ['Awaiting joining', 'Joined'];
// Unconfirmed job alerts are someone's half-finished sign-up; they go after this long.
const UNCONFIRMED_ALERT_DAYS = 30;

const monthsBefore = (now, months) => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
};

// The latest moment anything happened to an application.
function lastActivity(a) {
  const times = [a.createdAt, a.updatedAt, a.withdrawnAt, a.lastEmailedAt];
  for (const h of a.history || []) times.push(h.at);
  for (const m of a.emails || []) times.push(m.at);
  for (const iv of a.interviews || []) {
    times.push(iv.createdAt, iv.at, iv.cancelledAt);
    for (const f of iv.feedback || []) times.push(f.at);
  }
  if (a.shared) times.push(a.shared.sharedAt, a.shared.feedback && a.shared.feedback.at);
  return times.filter((t) => typeof t === 'string' && t).sort().pop() || '';
}

// Who would be deleted now: one entry per candidate (by email), only when every
// one of their applications is past the cut-off.
function candidatesDue(applications, placements, { months, now = new Date() }) {
  if (!months) return [];
  const cutoff = monthsBefore(now, months);
  const nowIso = new Date(now).toISOString();
  const keepEmails = new Set(placements.filter((p) => ACTIVE_PLACEMENT.includes(p.status)).map((p) => String(p.candidateEmail || '').toLowerCase()));
  const byEmail = new Map();
  for (const a of applications) {
    const email = String(a.email || '').toLowerCase();
    const c = byEmail.get(email) || { email, name: a.name, last: '', appIds: [], upcoming: false };
    const last = lastActivity(a);
    if (last > c.last) c.last = last;
    c.appIds.push(a.id);
    if ((a.interviews || []).some((iv) => iv.status === 'scheduled' && iv.at > nowIso)) c.upcoming = true;
    byEmail.set(email, c);
  }
  return [...byEmail.values()].filter((c) => c.last < cutoff && !c.upcoming && !keepEmails.has(c.email));
}

// Old messages and requests, and stale unconfirmed alerts.
function entriesDue(list, { months, now = new Date() }) {
  if (!months) return [];
  const cutoff = monthsBefore(now, months);
  return list.filter((s) => (s.createdAt || '') < cutoff);
}
const unconfirmedAlertsDue = (alerts, now = new Date()) => {
  const cutoff = new Date(new Date(now).getTime() - UNCONFIRMED_ALERT_DAYS * 86400000).toISOString();
  return alerts.filter((s) => !s.confirmed && (s.createdAt || '') < cutoff);
};

function create({ db, site, uploadsDir, readSubmissions, writeSubmissions, log }) {
  const months = () => (PERIODS.includes(site.retentionMonths) ? site.retentionMonths : 0);

  function preview(m = months()) {
    const apps = readSubmissions('applications');
    const candidates = candidatesDue(apps, db.all('placements'), { months: m });
    return {
      months: m,
      candidates: candidates.length,
      applications: candidates.reduce((n, c) => n + c.appIds.length, 0),
      messages: entriesDue(readSubmissions('contacts'), { months: m }).length,
      requests: entriesDue(readSubmissions('hire-requests'), { months: m }).length,
      alerts: m ? unconfirmedAlertsDue(readSubmissions('job-alerts')).length : 0,
    };
  }

  function run() {
    const m = months();
    const done = { candidates: 0, applications: 0, messages: 0, requests: 0, alerts: 0 };
    if (m) {
      const alerts = readSubmissions('job-alerts');
      const staleAlerts = new Set(unconfirmedAlertsDue(alerts).map((s) => s.id));
      if (staleAlerts.size) {
        writeSubmissions('job-alerts', alerts.filter((s) => !staleAlerts.has(s.id)));
        done.alerts = staleAlerts.size;
      }
      const apps = readSubmissions('applications');
      const due = candidatesDue(apps, db.all('placements'), { months: m });
      const ids = new Set(due.flatMap((c) => c.appIds));
      if (ids.size) {
        for (const a of apps) if (ids.has(a.id) && a.resume) fs.unlink(path.join(uploadsDir, path.basename(a.resume)), () => {});
        writeSubmissions('applications', apps.filter((a) => !ids.has(a.id)));
        for (const c of due) db.sessions.deleteSubject('candidate', c.email);
        done.candidates = due.length;
        done.applications = ids.size;
      }
      for (const [type, key] of [['contacts', 'messages'], ['hire-requests', 'requests']]) {
        const list = readSubmissions(type);
        const old = new Set(entriesDue(list, { months: m }).map((s) => s.id));
        if (old.size) {
          writeSubmissions(type, list.filter((s) => !old.has(s.id)));
          done[key] = old.size;
        }
      }
    }
    if (done.candidates || done.messages || done.requests || done.alerts) {
      log(null, 'Data retention clean-up', `${done.candidates} candidates (${done.applications} applications), ${done.messages} messages, ${done.requests} hiring requests, ${done.alerts} unconfirmed job alerts`);
    }
    return done;
  }

  return { run, preview, months };
}

module.exports = { create, candidatesDue, entriesDue, unconfirmedAlertsDue, lastActivity, PERIODS };
