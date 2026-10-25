// Roles of the Hireriv team (the agency) and what each may do. Checked on the
// server for every page and API call, from the signed-in person's role, never
// from anything the browser sends. Client employers and candidates have their
// own sign-ins and never reach these pages.
const ROLES = ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Finance Manager'];

const ROLE_INFO = {
  Admin: { label: 'Super Admin', text: 'Everything, including settings, the team, billing, backups and deleting records' },
  'Recruitment Manager': { label: 'Recruitment Manager', text: 'Runs requisitions: creates them, assigns recruiters and watches workload, plus everything a recruiter does' },
  Recruiter: { label: 'Recruiter', text: 'Works jobs, candidates and the requisitions assigned to them; no billing' },
  'Account Manager': { label: 'Account Manager', text: 'Looks after clients: contracts, requisitions and staffing for the clients they manage, plus everything a recruiter does' },
  'Finance Manager': { label: 'Finance Manager', text: 'Billing only: invoices, payments, credit notes and money reports. No candidate details beyond names on invoices' },
};

const ALL = ROLES;
const PERMS = {
  'clients.view': ALL,
  // Assigning account managers and changing contracts.
  'clients.manage': ['Admin', 'Account Manager'],
  'contracts.view': ['Admin', 'Recruitment Manager', 'Account Manager', 'Finance Manager'],
  'requisitions.view': ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager'],
  'requisitions.manage': ['Admin', 'Recruitment Manager', 'Account Manager'],
  'requisitions.assign': ['Admin', 'Recruitment Manager'],
  'placements.view': ALL,
  'staffing.view': ['Admin', 'Recruitment Manager', 'Recruiter', 'Account Manager', 'Finance Manager'],
  'staffing.manage': ['Admin', 'Recruitment Manager', 'Account Manager', 'Recruiter'],
  // Asking for an invoice (a draft) is separate from issuing it and from recording payment.
  'invoices.draft': ['Admin', 'Recruitment Manager', 'Account Manager', 'Finance Manager'],
  'invoices.issue': ['Admin', 'Finance Manager'],
  // Fees, rates, budgets and revenue.
  'money.view': ['Admin', 'Account Manager', 'Finance Manager'],
  'reports.view': ['Admin', 'Recruitment Manager', 'Account Manager', 'Finance Manager'],
  'workload.view': ['Admin', 'Recruitment Manager'],
  'audit.view': ['Admin', 'Recruitment Manager', 'Finance Manager'],
};

const can = (user, action) => Boolean(user && user.active !== false && (PERMS[action] || []).includes(user.role));
// Who may issue invoices and record payments (the existing billing pages).
const canBill = (user) => can(user, 'invoices.issue');

// A Finance Manager works only on billing pages: candidates, jobs and the
// rest of the back office stay closed to them.
const FINANCE_PAGES = [
  /^\/admin\/?$/, /^\/admin\/(login|logout|security)(\/|$)/, /^\/admin\/placements\/[^/]+\/(invoice|bill|payments|refunds|remind|credit-notes)(\/|$)/,
  /^\/admin\/invoice-drafts(\/|$)/, /^\/admin\/clients\/[^/]+$/, /^\/admin\/recruitment-reports\/?$/, /^\/admin\/staffing\/?$/, /^\/admin\/agency-audit\/?$/,
];
const FINANCE_TABS = ['placements', 'clients', 'reports'];
function pathAllowed(user, path) {
  if (!user || user.role !== 'Finance Manager') return true;
  return FINANCE_PAGES.some((re) => re.test(path));
}
const tabsAllowed = (user, tabs) => (user && user.role === 'Finance Manager' ? tabs.filter((t) => FINANCE_TABS.includes(t)) : tabs);

module.exports = { ROLES, ROLE_INFO, PERMS, can, canBill, pathAllowed, tabsAllowed };
