document.documentElement.classList.add('js');

// Sticky header shadow
const header = document.querySelector('.site-header');
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Mobile menu
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('main-nav');
toggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});
nav.addEventListener('click', (e) => {
  if (e.target.closest('a')) nav.classList.remove('open');
});

// Reveal-on-scroll and animated counters
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateCounter(el) {
  const target = Number(el.dataset.target);
  if (reducedMotion) { el.textContent = target.toLocaleString('en-IN'); return; }
  const start = performance.now();
  const duration = 1600;
  const step = (now) => {
    const p = Math.min((now - start) / duration, 1);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString('en-IN');
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      if (entry.target.classList.contains('counter')) animateCounter(entry.target);
      else entry.target.classList.add('in');
      io.unobserve(entry.target);
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal, .counter').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
  document.querySelectorAll('.counter').forEach(animateCounter);
}

// Industry tabs
const tabs = document.querySelectorAll('[role="tab"]');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    });
  });
});

// Toast
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', !!isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 5000);
}

// Progressive enhancement: submit forms with fetch and show a toast
document.querySelectorAll('form.js-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const multipart = form.enctype === 'multipart/form-data';
      const body = multipart ? new FormData(form) : new URLSearchParams(new FormData(form));
      const res = await fetch(form.action, { method: 'POST', body, headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (data.ok) {
        form.reset();
        toast(data.message);
      } else {
        toast(data.errors.join(', '), true);
      }
    } catch {
      toast('Could not send right now. Please try again.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
});

// Admin: ask before destructive actions.
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!confirm(form.dataset.confirm)) e.preventDefault();
  });
});
