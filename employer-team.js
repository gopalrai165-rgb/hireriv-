// Employer workspaces: people (employer users) and the companies they work
// for (memberships with a role). One sign-in per person; a company can have
// several team members, and one person can work with several companies.
// Every employer action is checked here on the server with can(), from the
// signed-in person's membership, never from a company id the browser sends.
const crypto = require('crypto');

const ROLES = {
  owner: { label: 'Company owner', text: 'Everything: company profile, team, billing, all jobs and applicants' },
  manager: { label: 'Hiring manager', text: 'Posts jobs and manages the jobs and applicants assigned to them' },
  recruiter: { label: 'Recruiter', text: 'Reviews applicants and books interviews for assigned jobs' },
  viewer: { label: 'Viewer', text: 'Sees all jobs and applicant progress, without contact details or changes' },
};
const ROLE_KEYS = Object.keys(ROLES);

// Is this job one the member works on: assigned to them, or one they created?
const assigned = (m, job) => Boolean(job) && ((m.jobIds || []).includes(job.id) || job.createdByUser === m.userId);

// What a member may do. `job` is needed for job-level actions.
function can(m, action, job = null) {
  if (!m) return false;
  if (job && job.employerId !== m.employerId) return false;
  const { role } = m;
  if (role === 'owner') return true;
  switch (action) {
    case 'jobs.create': case 'requirements.send': case 'timesheets.review': return role === 'manager';
    case 'job.edit': return role === 'manager' && assigned(m, job);
    case 'job.view': case 'applicants.view': return role === 'viewer' || assigned(m, job);
    // Contact details, resumes, status changes and interviews.
    case 'applicants.contact': case 'applicants.manage': case 'interviews.manage':
    // Internal notes, offers and interview scorecards (seeing and writing them).
    case 'applicants.notes': case 'offers.create': case 'offers.respond': case 'feedback.view': case 'feedback.submit':
      return ['manager', 'recruiter'].includes(role) && assigned(m, job);
    case 'applicants.assign': case 'offers.approve': return role === 'manager' && assigned(m, job);
    case 'shortlist.feedback': return ['manager', 'recruiter'].includes(role);
    case 'workload.view': return role === 'manager';
    case 'dashboard.view': case 'analytics.view': return true;
    // company.edit, team.manage, billing.view, company.verify and stage.correct
    // (moving an application outside the workflow): owners only.
    default: return false;
  }
}

function create({ readSubmissions, writeSubmissions, saveSubmission }) {
  const users = () => readSubmissions('employer-users');
  const members = () => readSubmissions('employer-members');
  const userById = (id) => users().find((u) => u.id === id) || null;
  const userByEmail = (email) => users().find((u) => u.email === String(email || '').toLowerCase()) || null;
  function saveUser(u) {
    const list = users();
    const i = list.findIndex((x) => x.id === u.id);
    if (i === -1) saveSubmission('employer-users', u);
    else { list[i] = u; writeSubmissions('employer-users', list); }
    return u;
  }
  function newUser({ email, name, phone = '', passwordHash = null, emailVerifiedAt = null }) {
    return saveUser({ id: crypto.randomUUID(), email: String(email).toLowerCase(), name, phone, passwordHash, emailVerifiedAt, phoneVerifiedAt: null, createdAt: new Date().toISOString(), active: true, link: null });
  }

  const membershipsOf = (userId) => members().filter((m) => m.userId === userId);
  const membersOf = (employerId) => members().filter((m) => m.employerId === employerId);
  const membership = (userId, employerId) => members().find((m) => m.userId === userId && m.employerId === employerId) || null;
  function addMember(employerId, userId, role, { jobIds = [], by = '' } = {}) {
    const existing = membership(userId, employerId);
    if (existing) return existing;
    return saveSubmission('employer-members', { employerId, userId, role, jobIds, addedBy: by });
  }
  function updateMember(id, patch) {
    const list = members();
    const m = list.find((x) => x.id === id);
    if (!m) return null;
    Object.assign(m, patch, { updatedAt: new Date().toISOString() });
    writeSubmissions('employer-members', list);
    return m;
  }
  function removeMember(id) {
    const list = members();
    const rest = list.filter((x) => x.id !== id);
    if (rest.length !== list.length) writeSubmissions('employer-members', rest);
  }
  const owners = (employerId) => membersOf(employerId).filter((m) => m.role === 'owner');

  // ---------- audit log ----------
  // Who did what in a company's workspace: job publication, candidate access,
  // status changes, team and profile changes. Kept for 2 years.
  function audit(employerId, actor, event, detail = '') {
    saveSubmission('employer-audit', { employerId, userId: actor ? actor.id : null, actor: actor ? actor.name : 'Hireriv team', event, detail: String(detail).slice(0, 300) });
  }
  const auditOf = (employerId, n = 50) => readSubmissions('employer-audit').filter((e) => e.employerId === employerId).slice(0, n);
  function pruneAudit() {
    const cutoff = new Date(Date.now() - 730 * 86400000).toISOString();
    const list = readSubmissions('employer-audit');
    const keep = list.filter((e) => e.createdAt >= cutoff);
    if (keep.length !== list.length) writeSubmissions('employer-audit', keep);
  }

  // ---------- one-time move from "one login per company" ----------
  // Each company's login becomes a person who owns that company. Their
  // password, confirmation and pending link move with them.
  function migrate(companies) {
    let moved = 0;
    for (const c of companies) {
      if (!c.email || membersOf(c.id).length) continue;
      let u = userByEmail(c.email);
      if (!u) {
        u = newUser({ email: c.email, name: c.name, phone: c.phone || '', passwordHash: c.passwordHash || null, emailVerifiedAt: c.selfSignup ? c.emailVerifiedAt || null : c.passwordHash ? c.passwordSetAt || c.createdAt : null });
        if (c.link) { u.link = c.link; saveUser(u); }
      }
      addMember(c.id, u.id, 'owner', { by: 'upgrade' });
      delete c.passwordHash;
      delete c.link;
      moved++;
    }
    return moved;
  }

  return { users, members, userById, userByEmail, saveUser, newUser, membershipsOf, membersOf, membership, addMember, updateMember, removeMember, owners, audit, auditOf, pruneAudit, migrate };
}

module.exports = { create, can, ROLES, ROLE_KEYS, assigned };
