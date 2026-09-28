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

// "Go back and fix" on form error pages.
document.querySelectorAll('[data-history-back]').forEach((a) => {
  a.addEventListener('click', (e) => {
    if (history.length > 1) {
      e.preventDefault();
      history.back();
    }
  });
});

// Admin interview form: adapt the location field to the chosen format.
const ivMode = document.getElementById('iv-mode');
if (ivMode) {
  const where = document.getElementById('iv-where');
  const label = document.getElementById('iv-where-label');
  const copy = {
    'Video call': ['Meeting link*', 'https://meet.google.com/abc-defg-hij'],
    Phone: ["Number we will call (defaults to the candidate's phone)", ivMode.dataset.candidatePhone || ''],
    'In person': ['Office address*', 'e.g. 4th floor, 12 MG Road, Bengaluru'],
  };
  const sync = () => {
    const c = copy[ivMode.value];
    label.textContent = c[0];
    where.placeholder = c[1];
  };
  ivMode.addEventListener('change', sync);
  sync();
}

// Invoices: print (or save as PDF from the print dialog).
document.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => window.print()));

// Admin: selects that save as soon as they change (e.g. placement status).
document.querySelectorAll('select[data-autosubmit]').forEach((sel) => sel.addEventListener('change', () => sel.form.submit()));

// Bill a month: preview the invoice as days and adjustments change.
const monthForm = document.querySelector('form[data-month-calc]');
if (monthForm) {
  const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
  const num = (el) => Number(String(el.value).replace(/[,₹\s]/g, '')) || 0;
  const update = () => {
    const base = (Number(monthForm.dataset.rate) * num(monthForm.querySelector('[data-month-days]'))) / Number(monthForm.dataset.daysInMonth);
    monthForm.querySelector('[data-month-out]').textContent = money.format(Math.round((base + num(monthForm.querySelector('[data-month-adj]'))) * 100) / 100);
  };
  monthForm.addEventListener('input', update);
}

// Placement form: show the right fee field and preview the fee as you type.
const feeForm = document.querySelector('form[data-fee-calc]');
if (feeForm) {
  const $ = (sel) => feeForm.querySelector(sel);
  const num = (el) => Number(String(el.value).replace(/[,₹\s]/g, ''));
  const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
  const update = () => {
    const mode = $('[data-fee-mode]').value;
    $('[data-fee-percent-wrap]').hidden = mode !== 'percent';
    $('[data-fee-flat-wrap]').hidden = mode !== 'flat';
    feeForm.querySelectorAll('[data-fee-monthly-wrap]').forEach((el) => { el.hidden = mode !== 'monthly'; });
    $('[data-fee-label]').textContent = mode === 'monthly' ? 'Billed every month, before GST:' : 'Fee before GST:';
    if (mode === 'free') { $('[data-fee-out]').textContent = 'Free replacement'; return; }
    if (mode === 'monthly') {
      const rate = num($('[data-fee-monthly]'));
      $('[data-fee-out]').textContent = rate > 0 ? `${money.format(rate)} / month` : '—';
      return;
    }
    const fee = mode === 'flat' ? num($('[data-fee-flat]')) : (num($('[data-fee-ctc]')) * num($('[data-fee-percent]'))) / 100;
    $('[data-fee-out]').textContent = fee > 0 ? money.format(Math.round(fee * 100) / 100) : '—';
  };
  feeForm.addEventListener('input', update);
  feeForm.addEventListener('change', update);
  update();
}

// Applications: bulk actions on ticked rows.
const bulkForm = document.querySelector('form[data-bulk]');
if (bulkForm) {
  const checks = () => [...document.querySelectorAll('[data-row-check]')];
  const all = document.querySelector('[data-select-all]');
  const count = bulkForm.querySelector('[data-bulk-count]');
  const action = bulkForm.querySelector('[data-bulk-action]');
  const notify = bulkForm.querySelector('[data-bulk-notify]');
  const refresh = () => {
    const n = checks().filter((c) => c.checked).length;
    count.textContent = n ? `${n} selected` : 'Tick candidates below to act on several at once';
    bulkForm.classList.toggle('has-selection', n > 0);
    if (all) all.checked = n > 0 && n === checks().length;
    notify.hidden = !action.value.startsWith('stage:');
  };
  if (all) all.addEventListener('change', () => { checks().forEach((c) => { c.checked = all.checked; }); refresh(); });
  document.addEventListener('change', (e) => { if (e.target.matches('[data-row-check]')) refresh(); });
  action.addEventListener('change', refresh);
  bulkForm.addEventListener('submit', (e) => {
    const n = checks().filter((c) => c.checked).length;
    if (!n) { e.preventDefault(); count.textContent = 'Tick at least one candidate first'; return; }
    if (action.value === 'delete' && !confirm(`Delete ${n} application${n === 1 ? '' : 's'} and their resumes? This can't be undone.`)) e.preventDefault();
  });
  refresh();
}
