// Job seekers who sign up with only a mobile number. Accounts, applications,
// sessions and privacy records are all keyed by an email address, so a
// mobile-only account gets a placeholder address on the reserved ".invalid"
// domain (it can never receive mail). Nothing is ever emailed to it (mailer.js
// and notify.js skip it), and pages show the mobile number instead.
const MOBILE_DOMAIN = 'mobile.hireriv.invalid';
const PLACEHOLDER_RE = /@mobile\.hireriv\.invalid\b/i;

const mobileEmail = (mobile) => `${mobile}@${MOBILE_DOMAIN}`;
const isMobileOnly = (email) => PLACEHOLDER_RE.test(String(email || ''));
// The address to show or email: '' for a mobile-only account.
const realEmail = (email) => (isMobileOnly(email) ? '' : String(email || ''));
// How to name the account on its own pages: the email, or "+91 98765 43210".
function contactLabel(email) {
  if (!isMobileOnly(email)) return String(email || '');
  const m = String(email).split('@')[0];
  return `+91 ${m.slice(0, 5)} ${m.slice(5)}`;
}

module.exports = { MOBILE_DOMAIN, mobileEmail, isMobileOnly, realEmail, contactLabel };
