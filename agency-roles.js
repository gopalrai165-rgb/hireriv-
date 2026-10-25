// Roles of the Hireriv team (the agency) and what each may do. Checked on the
// server for every page and API call, from the signed-in person's role, never
// from anything the browser sends. Client employers and candidates have their
// own sign-ins and never reach these pages.
// Platform trust & safety (trust.js): verification, moderation, complaints,
// operations and audit. They work only on those pages.
const TRUST_ROLES = ['Verification Reviewer', 'Job Moderator', 'Support Agent', 'Trust & Safety Manager', 'Operations Admin', 'Auditor'];
const ROLES = ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Staffing Manager', 'Finance Manager', 'Sales Manager', 'Business Development', ...TRUST_ROLES];

const ROLE_INFO = {
  Admin: { label: 'Super Admin', text: 'Everything, including settings, the team, billing, backups and deleting records' },
  'Recruitment Manager': { label: 'Recruitment Manager', text: 'Runs requisitions: creates them, assigns recruiters and watches workload, plus everything a recruiter does' },
  Recruiter: { label: 'Recruiter', text: 'Works jobs, candidates and the requisitions assigned to them; no billing' },
  'Account Manager': { label: 'Account Manager', text: 'Looks after clients: contracts, requisitions and staffing for the clients they manage, plus everything a recruiter does' },
  'Staffing Manager': { label: 'Staffing Manager', text: 'Runs the workforce: onboarding and documents, assignments, shifts, attendance and timesheets, plus everything a recruiter does' },
  'Finance Manager': { label: 'Finance Manager', text: 'Billing only: invoices, payments, credit notes and money reports. No candidate details beyond names on invoices' },
  'Sales Manager': { label: 'Sales Manager', text: 'Runs the sales CRM: every lead and opportunity, assignment, imports, approving proposals and converting won clients. No candidate details' },
  'Business Development': { label: 'Business Development Representative', text: 'Works the leads and opportunities assigned to them: activities, follow-ups and proposals. No candidate details' },
  'Verification Reviewer': { label: 'Verification Reviewer', text: 'Checks employer companies: verifies, declines or asks for more information, and handles complaints about employers' },
  'Job Moderator': { label: 'Job Moderator', text: 'Reviews jobs sent in and flagged listings: approves, asks for corrections, restricts or removes, and handles complaints about jobs' },
  'Support Agent': { label: 'Support Agent', text: 'Works the complaint cases assigned to them: notes, evidence, asking for information and resolving' },
  'Trust & Safety Manager': { label: 'Trust & Safety Manager', text: 'Every case and escalation: assigns reviewers, suspends accounts (closing one needs a second person), decides appeals and reads the audit history' },
  'Operations Admin': { label: 'Operations Admin', text: 'Service health, background jobs and email delivery. No complaint details or candidate records' },
  Auditor: { label: 'Auditor', text: 'Read-only: the audit history and who may do what. Nothing can be changed' },
};

// Everyone on the recruitment side; the sales and platform roles have only their own pages.
const ALL = ROLES.filter((r) => !['Sales Manager', 'Business Development', ...TRUST_ROLES].includes(r));
const PERMS = {
  'clients.view': ALL,
  // Assigning account managers and changing contracts.
  'clients.manage': ['Admin', 'Account Manager'],
  'contracts.view': ['Admin', 'Recruitment Manager', 'Account Manager', 'Finance Manager'],
  'requisitions.view': ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager'],
  'requisitions.manage': ['Admin', 'Recruitment Manager', 'Account Manager'],
  'requisitions.assign': ['Admin', 'Recruitment Manager'],
  'placements.view': ALL,
  'staffing.view': ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Staffing Manager', 'Finance Manager'],
  'staffing.manage': ['Admin', 'Recruitment Manager', 'Account Manager', 'Staffing Manager', 'Recruiter'],
  // Workers after placement: onboarding status (recruiters see it), running the
  // workforce, reading onboarding documents, and payroll data.
  'workforce.view': ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Staffing Manager'],
  'workforce.manage': ['Admin', 'Staffing Manager', 'Account Manager'],
  'workforce.documents': ['Admin', 'Staffing Manager'],
  'workforce.payroll': ['Admin', 'Finance Manager'],
  // Asking for an invoice (a draft) is separate from issuing it and from recording payment.
  'invoices.draft': ['Admin', 'Recruitment Manager', 'Account Manager', 'Staffing Manager', 'Finance Manager'],
  'invoices.issue': ['Admin', 'Finance Manager'],
  // Fees, rates, budgets and revenue.
  'money.view': ['Admin', 'Account Manager', 'Finance Manager'],
  'reports.view': ['Admin', 'Recruitment Manager', 'Account Manager', 'Staffing Manager', 'Finance Manager'],
  'workload.view': ['Admin', 'Recruitment Manager'],
  // The analytics dashboards (analytics.js): recruiters see their own work,
  // Admins and Recruitment Managers everyone's; money needs money.view.
  'analytics.view': ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Staffing Manager', 'Finance Manager'],
  // Platform-wide figures: registrations, verification, failed background jobs and the moderation backlog.
  'analytics.platform': ['Admin'],
  'audit.view': ['Admin', 'Recruitment Manager', 'Finance Manager'],
  // Hireriv's own sales CRM (crm.js). Representatives see the leads and
  // opportunities they own; managers see all of them.
  'crm.view': ['Admin', 'Sales Manager', 'Business Development'],
  'crm.manage': ['Admin', 'Sales Manager'],
  'crm.import': ['Admin', 'Sales Manager'],
  'crm.approve': ['Admin', 'Sales Manager'],
  'crm.convert': ['Admin', 'Sales Manager'],
  'crm.reports': ['Admin', 'Sales Manager', 'Business Development', 'Finance Manager'],
  // Website conversion counts (site-analytics.js): no personal data.
  'site.analytics': ['Admin', 'Recruitment Manager', 'Account Manager', 'Sales Manager', 'Business Development'],
  // Revenue from paid invoices in the CRM reports.
  'crm.revenue': ['Admin', 'Sales Manager', 'Finance Manager'],
  // Platform trust & safety (trust.js).
  'trust.overview': ['Admin', ...TRUST_ROLES],
  // Verifying, declining or asking a company for more information.
  'verify.review': ['Admin', 'Recruitment Manager', 'Account Manager', 'Verification Reviewer', 'Trust & Safety Manager'],
  // Approving jobs sent for review, or sending them back with instructions.
  'jobs.review': ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Job Moderator', 'Trust & Safety Manager'],
  // Restricting, removing or asking for corrections to live listings.
  'jobs.moderate': ['Admin', 'Job Moderator', 'Trust & Safety Manager'],
  // Complaint cases: Support Agents see those assigned to them, moderators
  // and verification reviewers also those about jobs or employers.
  'cases.view': ['Admin', 'Trust & Safety Manager', 'Support Agent', 'Job Moderator', 'Verification Reviewer'],
  'cases.manage': ['Admin', 'Trust & Safety Manager'],
  'accounts.restrict': ['Admin', 'Trust & Safety Manager'],
  'appeals.decide': ['Admin', 'Trust & Safety Manager'],
  'audit.platform': ['Admin', 'Trust & Safety Manager', 'Auditor'],
  'ops.health': ['Admin', 'Operations Admin'],
  'access.view': ['Admin', 'Auditor'],
  'trust.policy': ['Admin'],
  // Security and privacy (security.js, privacy.js).
  'security.view': ['Admin', 'Trust & Safety Manager', 'Operations Admin', 'Auditor'],
  'incidents.view': ['Admin', 'Trust & Safety Manager', 'Operations Admin', 'Auditor'],
  'incidents.manage': ['Admin', 'Trust & Safety Manager', 'Operations Admin'],
  'privacy.requests': ['Admin', 'Trust & Safety Manager', 'Support Agent'],
  // Deleting an account to complete a request.
  'privacy.erase': ['Admin', 'Trust & Safety Manager'],
  'retention.view': ['Admin', 'Trust & Safety Manager', 'Auditor'],
  'retention.manage': ['Admin'],
  // Employer plans and online payments (subscriptions.js, billing-routes.js).
  'subscriptions.view': ['Admin', 'Account Manager', 'Finance Manager'],
  // Setting a company's plan by hand (an agreed Enterprise quote).
  'subscriptions.manage': ['Admin', 'Finance Manager'],
  // Prices, limits, features, tax rates and renewal settings of plans.
  'plans.manage': ['Admin'],
  // Asking for and approving refunds: two different people.
  'billing.refund': ['Admin', 'Finance Manager'],
  // Companies' API integrations and webhooks (integrations.js): seeing them,
  // and revoking one (a leaked key, abuse).
  'integrations.view': ['Admin', 'Operations Admin', 'Trust & Safety Manager'],
  'integrations.manage': ['Admin', 'Trust & Safety Manager'],
  // The AI assistant (ai-assistant.js): usage, cost and feedback figures, and
  // its settings (switches and limits; Admins only).
  'ai.view': ['Admin', 'Operations Admin'],
  'ai.manage': ['Admin'],
};

const can = (user, action) => Boolean(user && user.active !== false && (PERMS[action] || []).includes(user.role));
// Who may issue invoices and record payments (the existing billing pages).
const canBill = (user) => can(user, 'invoices.issue');

// A Finance Manager works only on billing pages: candidates, jobs and the
// rest of the back office stay closed to them.
const FINANCE_PAGES = [
  /^\/admin\/?$/, /^\/admin\/(login|logout|security|confirm)(\/|$)/, /^\/admin\/placements\/[^/]+\/(invoice|bill|payments|refunds|remind|credit-notes)(\/|$)/,
  /^\/admin\/invoice-drafts(\/|$)/, /^\/admin\/workforce\/(payroll|payroll\.csv)$/, /^\/admin\/crm\/reports\/?$/, /^\/admin\/clients\/[^/]+$/, /^\/admin\/recruitment-reports\/?$/, /^\/admin\/analytics\/?$/, /^\/admin\/staffing\/?$/, /^\/admin\/agency-audit\/?$/,
  /^\/admin\/billing(\/|$|\.)/, /^\/api\/admin\/billing(\/|$)/,
];
const FINANCE_TABS = ['placements', 'clients', 'reports'];
// Sales roles work in the CRM only: no candidates, jobs or billing pages.
const SALES_ROLES = ['Sales Manager', 'Business Development'];
const SALES_PAGES = [/^\/admin\/?$/, /^\/admin\/(login|logout|security|confirm)(\/|$)/, /^\/admin\/crm(\/|$)/, /^\/admin\/site-analytics\/?$/];
const SALES_TABS = [];
const TRUST_PAGES = [/^\/admin\/?$/, /^\/admin\/(login|logout|security|confirm)(\/|$)/, /^\/admin\/(overview|verifications|job-moderation|reports|cases|appeals|audit-logs|system-health|access-control|security-events|incidents|data-requests|retention|integrations|ai)(\/|$)/, /^\/api\/admin\/(security-events|incidents|data-requests)(\/|$)/];
// Roles that must use two-step sign-in before opening any of their pages.
const STRONG_AUTH_ROLES = [...TRUST_ROLES];
function pathAllowed(user, path) {
  if (user && SALES_ROLES.includes(user.role)) return SALES_PAGES.some((re) => re.test(path));
  if (user && TRUST_ROLES.includes(user.role)) return TRUST_PAGES.some((re) => re.test(path));
  if (!user || user.role !== 'Finance Manager') return true;
  return FINANCE_PAGES.some((re) => re.test(path));
}
function tabsAllowed(user, tabs) {
  if (user && user.role === 'Finance Manager') return tabs.filter((t) => FINANCE_TABS.includes(t));
  if (user && (SALES_ROLES.includes(user.role) || TRUST_ROLES.includes(user.role))) return tabs.filter((t) => SALES_TABS.includes(t));
  return tabs;
}

module.exports = { ROLES, ROLE_INFO, PERMS, SALES_ROLES, TRUST_ROLES, STRONG_AUTH_ROLES, can, canBill, pathAllowed, tabsAllowed };
