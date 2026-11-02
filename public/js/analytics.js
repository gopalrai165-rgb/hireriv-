// Google Analytics 4, only after the visitor allows it. Loaded on public pages
// when GA_MEASUREMENT_ID is set; nothing from Google loads until "Allow" is
// pressed, and the choice is kept in this browser (hireriv:analytics).
(() => {
  const me = document.currentScript;
  const id = me && me.dataset.ga;
  if (!id || !/^G-[A-Z0-9]{4,12}$/.test(id)) return;
  const KEY = 'hireriv:analytics';
  const choice = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const remember = (v) => { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } };

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); } // eslint-disable-line prefer-rest-params
  window.gtag = gtag;

  let started = false;
  function start() {
    if (started) return;
    started = true;
    gtag('js', new Date());
    gtag('config', id, { anonymize_ip: true });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);
  }

  // Forms sent successfully (main.js): employer enquiries, applications, contact, alerts.
  const EVENTS = { '/api/hire': 'generate_lead', '/api/apply': 'apply_job', '/api/contact': 'contact', '/api/job-alerts': 'job_alert', '/account/register': 'sign_up' };
  document.addEventListener('hireriv:sent', (e) => {
    if (!started) return;
    const name = EVENTS[e.detail && e.detail.action];
    if (name) gtag('event', name);
  });

  if (choice() === 'yes') return start();
  if (choice() === 'no') return;
  const bar = document.createElement('div');
  bar.className = 'consent-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Cookie choice');
  bar.innerHTML = '<p>May we use Google Analytics cookies to count visits and improve the site? No adverts. <a href="/privacy#cookies">Privacy Policy</a></p>'
    + '<div><button type="button" class="btn btn-primary btn-sm" data-consent="yes">Allow</button> <button type="button" class="btn btn-outline btn-sm" data-consent="no">No thanks</button></div>';
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-consent]');
    if (!b) return;
    remember(b.dataset.consent);
    bar.remove();
    if (b.dataset.consent === 'yes') start();
  });
  document.body.appendChild(bar);
})();
