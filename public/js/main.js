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

// Saved jobs: ids kept in this browser (newest first). Storage can be blocked
// (private mode, strict settings), so every access is guarded.
const SAVED_KEY = 'hireriv:saved-jobs';

function readSaved() {
  try {
    const ids = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeSaved(ids) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

function paintSaved() {
  const ids = readSaved();
  document.querySelectorAll('[data-save-job]').forEach((btn) => {
    const saved = ids.includes(btn.dataset.saveJob);
    btn.classList.toggle('saved', saved);
    btn.setAttribute('aria-pressed', String(saved));
    btn.title = saved ? 'Remove from saved jobs' : 'Save job';
    const label = btn.querySelector('.save-label');
    if (label) label.textContent = saved ? 'Saved' : 'Save job';
  });
  document.querySelectorAll('.saved-count').forEach((el) => {
    el.textContent = ids.length;
    el.hidden = !ids.length;
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-save-job]');
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.saveJob;
  const ids = readSaved();
  const wasSaved = ids.includes(id);
  const next = wasSaved ? ids.filter((x) => x !== id) : [id, ...ids];
  if (!writeSaved(next)) return toast('Your browser is blocking saved jobs on this site.', true);
  paintSaved();
  toast(wasSaved ? 'Removed from saved jobs' : 'Saved! Find it any time under "Saved".');
  if (wasSaved && savedList) {
    btn.closest('.job-card')?.remove();
    renderSavedSummary(next.length);
  }
});

// Keep several open tabs in sync.
window.addEventListener('storage', (e) => { if (e.key === SAVED_KEY) paintSaved(); });

const savedList = document.getElementById('saved-list');

function renderSavedSummary(count) {
  document.getElementById('saved-summary').innerHTML = count ? `<b>${count}</b> saved ${count === 1 ? 'job' : 'jobs'}` : '';
  document.getElementById('saved-empty').hidden = count > 0;
  document.getElementById('saved-clear').hidden = count === 0;
}

async function loadSavedPage() {
  const ids = readSaved();
  if (!ids.length) return renderSavedSummary(0);
  try {
    const res = await fetch(`/saved/cards?ids=${encodeURIComponent(ids.join(','))}`);
    savedList.innerHTML = await res.text();
    // Jobs deleted by the site owner disappear from the list for good.
    const found = [...savedList.querySelectorAll('[data-save-job]')].map((b) => b.dataset.saveJob);
    if (found.length !== ids.length) writeSaved(ids.filter((id) => found.includes(id)));
    savedList.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
    renderSavedSummary(found.length);
    paintSaved();
  } catch {
    document.getElementById('saved-summary').textContent = 'Could not load your saved jobs. Please refresh the page.';
  }
}

if (savedList) {
  loadSavedPage();
  document.getElementById('saved-clear').addEventListener('click', () => {
    if (!confirm('Remove all saved jobs?')) return;
    writeSaved([]);
    savedList.innerHTML = '';
    renderSavedSummary(0);
    paintSaved();
  });
}
paintSaved();

// Share a job: copy link, and the phone's native share sheet when available.
const shareRow = document.querySelector('.share-row');
if (shareRow) {
  const url = shareRow.dataset.shareUrl;
  const title = shareRow.dataset.shareTitle;
  shareRow.querySelector('[data-copy-link]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied. Paste it anywhere to share this job.');
    } catch {
      window.prompt('Copy this link:', url);
    }
  });
  const nativeBtn = shareRow.querySelector('[data-native-share]');
  if (navigator.share) {
    nativeBtn.hidden = false;
    nativeBtn.addEventListener('click', () => navigator.share({ title, url }).catch(() => {}));
  }
}
