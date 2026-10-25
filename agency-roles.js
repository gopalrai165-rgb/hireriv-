// Roles of the Hireriv team (the agency) and what each may do. Checked on the
// server for every page and API call, from the signed-in person's role, never
// from anything the browser sends. Client employers and candidates have their
// own sign-ins and never reach these pages.
const ROLES = ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Staffing Manager', 'Finance Manager', 'Sales Manager', 'Business Development'];

const ROLE_INFO = {
  Admin: { label: 'Super Admin', text: 'Everything, including settings, the team, billing, backups and deleting records' },
  'Recruitment Manager': { label: 'Recruitment Manager', text: 'Runs requisitions: creates them, assigns recruiters and watches workload, plus everything a recruiter does' },
  Recruiter: { label: 'Recruiter', text: 'Works jobs, candidates and the requisitions assigned to them; no billing' },
  'Account Manager': { label: 'Account Manager', text: 'Looks after clients: contracts, requisitions and staffing for the clients they manage, plus everything a recruiter does' },
  'Staffing Manager': { label: 'Staffing Manager', text: 'Runs the workforce: onboarding and documents, assignments, shifts, attendance and timesheets, plus everything a recruiter does' },
  'Finance Manager': { label: 'Finance Manager', text: 'Billing only: invoices, payments, credit notes and money reports. No candidate details beyond names on invoices' },
  'Sales Manager': { label: 'Sales Manager', text: 'Runs the sales CRM: every lead and opportunity, assignment, imports, approving proposals and converting won clients. No candidate details' },
  'Business Development': { label: 'Business Development Representative', text: 'Works the leads and opportunities assigned to them: activities, follow-ups and proposals. No candidate details' },
};

// Everyone on the recruitment side; the sales roles have only the CRM.
const ALL = ROLES.filter((r) => !['Sales Manager', 'Business Development'].includes(r));
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
  'audit.view': ['Admin', 'Recruitment Manager', 'Finance Manager'],
  // Hireriv's own sales CRM (crm.js). Representatives see the leads and
  // opportunities they own; managers see all of them.
  'crm.view': ['Admin', 'Sales Manager', 'Business Development'],
  'crm.manage': ['Admin', 'Sales Manager'],
  'crm.import': ['Admin', 'Sales Manager'],
  'crm.approve': ['Admin', 'Sales Manager'],
  'crm.convert': ['Admin', 'Sales Manager'],
  'crm.reports': ['Admin', 'Sales Manager', 'Business Development', 'Finance Manager'],
  // Revenue from paid invoices in the CRM reports.
  'crm.revenue': ['Admin', 'Sales Manager', 'Finance Manager'],
};

const can = (user, action) => Boolean(user && user.active !== false && (PERMS[action] || []).includes(user.role));
// Who may issue invoices and record payments (the existing billing pages).
const canBill = (user) => can(user, 'invoices.issue');

// A Finance Manager works only on billing pages: candidates, jobs and the
// rest of the back office stay closed to them.
const FINANCE_PAGES = [
  /^\/admin\/?$/, /^\/admin\/(login|logout|security)(\/|$)/, /^\/admin\/placements\/[^/]+\/(invoice|bill|payments|refunds|remind|credit-notes)(\/|$)/,
  /^\/admin\/invoice-drafts(\/|$)/, /^\/admin\/workforce\/(payroll|payroll\.csv)$/, /^\/admin\/crm\/reports\/?$/, /^\/admin\/clients\/[^/]+$/, /^\/admin\/recruitment-reports\/?$/, /^\/admin\/staffing\/?$/, /^\/admin\/agency-audit\/?$/,
];
const FINANCE_TABS = ['placements', 'clients', 'reports'];
// Sales roles work in the CRM only: no candidates, jobs or billing pages.
const SALES_ROLES = ['Sales Manager', 'Business Development'];
const SALES_PAGES = [/^\/admin\/?$/, /^\/admin\/(login|logout|security)(\/|$)/, /^\/admin\/crm(\/|$)/];
const SALES_TABS = [];
function pathAllowed(user, path) {
  if (user && SALES_ROLES.includes(user.role)) return SALES_PAGES.some((re) => re.test(path));
  if (!user || user.role !== 'Finance Manager') return true;
  return FINANCE_PAGES.some((re) => re.test(path));
}
function tabsAllowed(user, tabs) {
  if (user && user.role === 'Finance Manager') return tabs.filter((t) => FINANCE_TABS.includes(t));
  if (user && SALES_ROLES.includes(user.role)) return tabs.filter((t) => SALES_TABS.includes(t));
  return tabs;
}

module.exports = { ROLES, ROLE_INFO, PERMS, SALES_ROLES, can, canBill, pathAllowed, tabsAllowed };
