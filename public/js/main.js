document.documentElement.classList.add('js');

  // The installed app's icon shows the unread notifications (Badging API).
  try {
    var bells = document.querySelectorAll('.nav-bell[data-unread]');
    if (bells.length && 'setAppBadge' in navigator) {
      var unread = 0;
      bells.forEach(function (b) { unread = Math.max(unread, Number(b.getAttribute('data-unread')) || 0); });
      (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(function () {});
    }
  } catch (e) { /* not available */ }

// Words the script shows, in the page's language (from the page itself; see
// partials/foot.ejs). English when they are missing.
const L = (() => {
  try { return JSON.parse(document.getElementById('i18n-strings').textContent) || {}; } catch { return {}; }
})();
const say = (key, fallback) => L[key] || fallback;

// Sticky header shadow
const header = document.querySelector('.site-header');
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Mobile menu: the button says whether it opens or closes, and Escape closes
// the menu (and the Login list) and returns to the button.
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('main-nav');
const setMenu = (open) => {
  nav.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? say('menuClose', 'Close menu') : say('menuOpen', 'Open menu'));
};
toggle.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
nav.addEventListener('click', (e) => {
  if (e.target.closest('a')) setMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const login = document.querySelector('details.nav-login[open]');
  if (login) { login.open = false; login.querySelector('summary').focus(); return; }
  if (nav.classList.contains('open')) { setMenu(false); toggle.focus(); }
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
  // The real figures are in the HTML for search engines and no-JS visitors;
  // start from zero only when they will be animated.
  if (!reducedMotion) document.querySelectorAll('.counter').forEach((el) => { el.textContent = '0'; });
  document.querySelectorAll('.reveal, .counter').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
  document.querySelectorAll('.counter').forEach(animateCounter);
}

// Industry tabs: click, or the arrow keys, Home and End (only the chosen tab
// is in the Tab order, as screen readers expect).
const tabs = [...document.querySelectorAll('[role="tab"]')];
const chooseTab = (tab) => {
  tabs.forEach((t) => {
    const active = t === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
};
tabs.forEach((tab, i) => {
  tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
  tab.addEventListener('click', () => chooseTab(tab));
  tab.addEventListener('keydown', (e) => {
    const n = tabs.length;
    const to = { ArrowRight: (i + 1) % n, ArrowDown: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, ArrowUp: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    tabs[to].focus();
    chooseTab(tabs[to]);
  });
});
if (tabs.length && !tabs.some((t) => t.tabIndex === 0)) tabs[0].tabIndex = 0;

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

// Tab rows wider than the screen (account and employer portals): the current
// tab is scrolled into view, and the edges fade where there are more tabs.
document.querySelectorAll('.account-tabs').forEach((nav) => {
  const active = nav.querySelector('a.active');
  if (active && active.offsetLeft + active.offsetWidth > nav.clientWidth) nav.scrollLeft = active.offsetLeft - 16;
  const mark = () => {
    const left = nav.scrollLeft > 4;
    const right = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4;
    if (left || right) nav.dataset.more = left && right ? 'both' : left ? 'left' : 'right';
    else delete nav.dataset.more;
  };
  mark();
  nav.addEventListener('scroll', mark, { passive: true });
  window.addEventListener('resize', mark);
});

// A field marked wrong stops showing red as soon as the person changes it.
document.addEventListener('input', (e) => { if (e.target.getAttribute && e.target.getAttribute('aria-invalid') === 'true') e.target.removeAttribute('aria-invalid'); });

// Errors stay on the form until it is sent again: a list at the top (read out
// by screen readers and focused), and each field named in it marked invalid.
function showErrors(form, errors, fields = []) {
  clearErrors(form);
  const box = document.createElement('div');
  box.className = 'notice notice-err form-errors';
  box.setAttribute('role', 'alert');
  box.tabIndex = -1;
  const title = document.createElement('p');
  title.textContent = say('errorsTitle', 'Please fix these and try again:');
  const list = document.createElement('ul');
  errors.forEach((msg, i) => {
    const li = document.createElement('li');
    const field = fields[i] && form.elements[fields[i]];
    if (field && field.id) {
      const a = document.createElement('a');
      a.href = `#${field.id}`;
      a.textContent = msg;
      li.append(a);
    } else li.textContent = msg;
    list.append(li);
  });
  box.append(title, list);
  form.prepend(box);
  fields.forEach((name) => {
    const field = form.elements[name];
    if (field && field.setAttribute) field.setAttribute('aria-invalid', 'true');
  });
  box.focus();
}
function clearErrors(form) {
  form.querySelectorAll('.form-errors').forEach((x) => x.remove());
  form.querySelectorAll('[aria-invalid="true"]').forEach((x) => x.removeAttribute('aria-invalid'));
}

// Progressive enhancement: submit forms with fetch and show a toast
document.querySelectorAll('form.js-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // The apply form shows everything entered before it is sent (below).
    if (form.dataset.applyForm !== undefined && !form.dataset.reviewed) return showReview(form);
    const btn = form.querySelector('[type="submit"]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = say('sending', 'Sending…');
    try {
      const multipart = form.enctype === 'multipart/form-data';
      const body = multipart ? new FormData(form) : new URLSearchParams(new FormData(form));
      const res = await fetch(form.action, { method: 'POST', body, headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (data.ok) {
        clearErrors(form);
        form.reset();
        forgetDraft(form);
        resetReview(form);
        toast(data.message);
        // After applying: point to similar jobs on the same page (job.ejs).
        const similar = form.dataset.applyForm !== undefined && document.querySelector('[data-similar-prompt]');
        if (similar) { similar.hidden = false; similar.focus(); }
        // A report's reference and private tracking link stay on the page.
        const receipt = form.parentElement.querySelector('[data-receipt]');
        if (receipt && data.reference && data.trackUrl) {
          receipt.querySelector('[data-ref]').textContent = data.reference;
          receipt.querySelector('a[data-track]').href = data.trackUrl;
          receipt.hidden = false;
          receipt.focus();
        }
      } else {
        resetReview(form);
        showErrors(form, data.errors || [], (data.errors || []).map((x, i) => (data.fields || [])[i] || ''));
        toast(data.errors.join(', '), true);
      }
    } catch {
      // Offline or the connection dropped: what was typed stays on the page.
      const msg = navigator.onLine === false ? say('offline', 'You are offline. Your answers are kept on this page: try again when you\'re connected.') : say('sendFailed', 'Could not send right now. Please try again.');
      resetReview(form);
      showErrors(form, [msg]);
      toast(msg, true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
});

// Before an application is sent: everything entered, to check. "Edit details"
// goes back to the form; sending again submits it.
function showReview(form) {
  const panel = form.querySelector('[data-apply-review]');
  if (!panel) { form.dataset.reviewed = '1'; return form.requestSubmit(); }
  const list = panel.querySelector('[data-review-list]');
  list.replaceChildren();
  const seen = new Set();
  form.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.type === 'hidden' || el.name === 'website' || !el.name || seen.has(el.name) || el.closest('.hp')) return;
    seen.add(el.name);
    const label = el.closest('label') || form.querySelector(`label[for="${el.id}"]`);
    const name = label ? [...label.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\*/g, '').trim() : el.name;
    let value = el.type === 'file' ? (el.files[0] ? el.files[0].name : say('noFile', 'No resume attached')) : el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).textContent || '' : el.value.trim();
    if (!value) value = say('notGiven', 'Not given');
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  });
  panel.hidden = false;
  form.dataset.reviewed = '1';
  const btn = form.querySelector('[type="submit"]');
  btn.textContent = btn.dataset.submitLabel || btn.textContent;
  panel.focus();
  panel.scrollIntoView({ block: 'nearest' });
}
function resetReview(form) {
  const panel = form.querySelector('[data-apply-review]');
  if (!panel) return;
  panel.hidden = true;
  delete form.dataset.reviewed;
  const btn = form.querySelector('[type="submit"]');
  if (btn.dataset.reviewLabel) btn.textContent = btn.dataset.reviewLabel;
}
document.querySelectorAll('form[data-apply-form]').forEach((form) => {
  const btn = form.querySelector('[type="submit"]');
  if (btn.dataset.reviewLabel) btn.textContent = btn.dataset.reviewLabel;
  const edit = form.querySelector('[data-review-edit]');
  if (edit) edit.addEventListener('click', () => {
    resetReview(form);
    const first = form.querySelector('input:not([type="hidden"]):not([name="website"]), select, textarea');
    if (first) first.focus();
  });
  // Changing anything after checking means checking again.
  form.addEventListener('input', () => { if (form.dataset.reviewed) resetReview(form); });
  restoreDraft(form);
});

// What was typed into an application stays in this tab (sessionStorage) until
// it is sent or the person signs out, so a dropped connection or a reload
// loses nothing. Files are never kept.
function draftKey(form) { return form.dataset.draftKey ? `hireriv:draft:${form.dataset.draftKey}` : ''; }
function forgetDraft(form) {
  const key = draftKey(form);
  if (key) try { sessionStorage.removeItem(key); } catch { /* storage blocked */ }
}
function restoreDraft(form) {
  const key = draftKey(form);
  if (!key) return;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { saved = null; }
  if (saved && typeof saved === 'object') {
    let any = false;
    Object.entries(saved).forEach(([name, value]) => {
      const el = form.elements[name];
      if (el && el.type !== 'file' && el.type !== 'hidden' && typeof value === 'string' && value && !el.value) { el.value = value; any = true; }
    });
    if (any) {
      const note = document.createElement('p');
      note.className = 'small muted draft-note';
      note.setAttribute('role', 'status');
      note.textContent = say('restored', 'We kept what you typed on this device until you send it or sign out.');
      form.prepend(note);
    }
  }
  let timer;
  form.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const out = {};
      form.querySelectorAll('input, select, textarea').forEach((el) => {
        if (el.name && el.type !== 'file' && el.type !== 'hidden' && el.name !== 'website' && el.type !== 'password') out[el.name] = el.value.slice(0, 2000);
      });
      try { sessionStorage.setItem(key, JSON.stringify(out)); } catch { /* storage full or blocked */ }
    }, 400);
  });
}

// Website analytics: count an application form once it is first used (no
// personal data: only that it happened, and for which job).
document.querySelectorAll('form[action="/api/apply"]').forEach((form) => {
  form.addEventListener('focusin', () => {
    const jobId = (form.querySelector('[name="jobId"]') || {}).value || '';
    const body = JSON.stringify({ event: 'application-started', jobId });
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/public/events', new Blob([body], { type: 'application/json' })))) {
        fetch('/api/public/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
      }
    } catch { /* counting is best-effort */ }
  }, { once: true });
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
    btn.title = saved ? say('removeSaved', 'Remove from saved jobs') : say('saveJob', 'Save job');
    const label = btn.querySelector('.save-label');
    if (label) label.textContent = saved ? say('savedLabel', 'Saved') : say('saveJob', 'Save job');
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
  if (!writeSaved(next) && !signedIn) return toast(say('storageBlocked', 'Your browser is blocking saved jobs on this site.'), true);
  if (signedIn) fetch(`/api/candidate/saved-jobs/${encodeURIComponent(id)}`, { method: wasSaved ? 'DELETE' : 'PUT' }).catch(() => {});
  paintSaved();
  toast(wasSaved ? say('removed', 'Removed from saved jobs') : say('saved', 'Saved! Find it any time under "Saved".'));
  if (wasSaved && savedList) {
    btn.closest('.job-card')?.remove();
    renderSavedSummary(next.length);
  }
});

// Signed in to a job-seeker account: saved jobs are kept in the account too,
// so they follow the candidate to other devices. Both lists are merged once.
const signedIn = document.body.dataset.account === '1';
async function syncSaved() {
  try {
    const res = await fetch('/api/candidate/saved-jobs');
    if (!res.ok) return;
    const { jobIds } = await res.json();
    const local = readSaved();
    for (const id of local.filter((x) => !jobIds.includes(x))) fetch(`/api/candidate/saved-jobs/${encodeURIComponent(id)}`, { method: 'PUT' }).catch(() => {});
    const merged = [...local, ...jobIds.filter((x) => !local.includes(x))];
    if (merged.length !== local.length) {
      writeSaved(merged);
      paintSaved();
      if (savedList) loadSavedPage();
    }
  } catch { /* offline: the browser's list still works */ }
}

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

// Tables shown as one card per row on phones (style.css .cards-on-phone):
// each cell is labelled with its column's heading unless it has its own label.
document.querySelectorAll('table.cards-on-phone').forEach((table) => {
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((td, i) => {
      if (i > 0 && heads[i] && !td.hasAttribute('data-label') && !td.classList.contains('row-actions')) td.dataset.label = heads[i];
    });
  });
});

// Recently viewed jobs: the last 10 open jobs looked at, newest first, kept
// only in this browser (never sent anywhere until the Saved page asks for their cards).
const VIEWED_KEY = 'hireriv:viewed-jobs';
const VIEWED_MAX = 10;
function readViewed() {
  try {
    const ids = JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id)).slice(0, VIEWED_MAX) : [];
  } catch { return []; }
}
function writeViewed(ids) {
  try { if (ids.length) localStorage.setItem(VIEWED_KEY, JSON.stringify(ids.slice(0, VIEWED_MAX))); else localStorage.removeItem(VIEWED_KEY); } catch { /* private mode: nothing kept */ }
}
const viewedHere = document.querySelector('[data-viewed-job]');
if (viewedHere) {
  const id = viewedHere.dataset.viewedJob;
  writeViewed([id, ...readViewed().filter((x) => x !== id)]);
}
const recentLink = document.querySelector('[data-recent-link]');
if (recentLink && readViewed().length) recentLink.hidden = false;
const recentList = document.getElementById('recent-list');
async function loadRecent() {
  const ids = readViewed();
  const box = document.getElementById('recent');
  if (!ids.length) { box.hidden = true; return; }
  try {
    const res = await fetch(`/saved/cards?ids=${encodeURIComponent(ids.join(','))}`);
    recentList.innerHTML = await res.text();
    // Jobs that are gone (or no longer open) drop off the list.
    const open = [...recentList.querySelectorAll('.job-card:not(.is-closed) [data-save-job]')].map((b) => b.dataset.saveJob);
    recentList.querySelectorAll('.job-card.is-closed').forEach((el) => el.remove());
    if (open.length !== ids.length) writeViewed(ids.filter((id) => open.includes(id)));
    recentList.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
    box.hidden = open.length === 0;
    paintSaved();
    if (open.length && location.hash === '#recent') box.scrollIntoView();
  } catch { box.hidden = true; }
}
if (recentList) {
  loadRecent();
  document.getElementById('recent-clear').addEventListener('click', () => {
    writeViewed([]);
    recentList.innerHTML = '';
    document.getElementById('recent').hidden = true;
  });
}

if (signedIn) syncSaved();
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
      toast(say('linkCopied', 'Link copied. Paste it anywhere to share this job.'));
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

// Copy a block of text, e.g. recovery codes on Sign-in security.
document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    toast('Copied. Paste them somewhere safe.');
  } catch {
    window.prompt('Copy these:', btn.dataset.copy);
  }
}));

// Admin: selects that save as soon as they change (e.g. placement status).
document.querySelectorAll('select[data-autosubmit]').forEach((sel) => sel.addEventListener('change', () => sel.form.submit()));

// Bill a month: preview the invoice as days and adjustments change.
const monthForm = document.querySelector('form[data-month-calc]');
if (monthForm) {
  const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
  const num = (el) => Number(String(el.value).replace(/[,₹\s]/g, '')) || 0;
  const update = () => {
    const basis = monthForm.querySelector('[data-month-basis]').value === 'working' ? monthForm.dataset.workingDays : monthForm.dataset.calendarDays;
    const base = (Number(monthForm.dataset.rate) * num(monthForm.querySelector('[data-month-days]'))) / Number(basis);
    monthForm.querySelector('[data-month-out]').textContent = money.format(Math.round((base + num(monthForm.querySelector('[data-month-adj]'))) * 100) / 100);
  };
  monthForm.addEventListener('input', update);
  monthForm.addEventListener('change', update);
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
    if (mode === 'assignment') { $('[data-fee-out]').textContent = 'Billed from each staffing assignment'; return; }
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

// Source of hire: remember where this visit came from (utm_source, or the
// referring site) for the rest of the session, and send it with applications.
(() => {
  const KEY = 'hireriv:source';
  let source = '';
  try { source = sessionStorage.getItem(KEY) || ''; } catch (e) { /* storage blocked */ }
  if (!source) {
    const utm = new URLSearchParams(location.search).get('utm_source');
    let ref = '';
    try { ref = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (e) { ref = ''; }
    const known = { 'linkedin.com': 'linkedin', 'lnkd.in': 'linkedin', 'google.': 'google', 'facebook.com': 'facebook', 'instagram.com': 'instagram', 'naukri.com': 'naukri', 'indeed.': 'indeed', 'whatsapp.com': 'whatsapp' };
    const fromRef = ref && ref !== location.hostname ? Object.keys(known).find((k) => ref.includes(k)) : null;
    source = (utm || (fromRef ? known[fromRef] : ref && ref !== location.hostname ? ref : 'direct')).toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 40);
    try { sessionStorage.setItem(KEY, source); } catch (e) { /* storage blocked */ }
  }
  document.querySelectorAll('input[data-source]').forEach((el) => { el.value = source; });
})();

// Apply form: read the resume as soon as it's picked and fill in any empty
// fields (never overwriting what the candidate typed). Works without it too.
document.querySelectorAll('input[data-resume-autofill]').forEach((input) => {
  const form = input.form;
  const status = form.querySelector('[data-resume-status]');
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file || !/\.(pdf|docx)$/i.test(file.name)) { status.textContent = ''; return; }
    status.textContent = 'Reading your resume…';
    try {
      const body = new FormData();
      body.append('resume', file);
      const res = await fetch('/api/resume-parse', { method: 'POST', body, headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!data.ok) { status.textContent = data.message || ''; return; }
      const filled = [];
      for (const [name, value] of Object.entries(data.fields)) {
        const el = form.elements[name];
        if (!el || !value) continue;
        if (el.tagName === 'SELECT') {
          // Experience: only if the candidate hasn't changed it from the default.
          if (el.selectedIndex === 0 && [...el.options].some((o) => o.value === value)) { el.value = value; filled.push(name); }
        } else if (!el.value.trim()) { el.value = value; filled.push(name); }
      }
      status.textContent = filled.length ? `Filled in ${filled.length} field${filled.length === 1 ? '' : 's'} from your resume. Please check them.` : '';
    } catch (e) {
      status.textContent = '';
    }
  });
});

// ---------- installable app ----------
// Counts an app event (no personal data), like the application counter above.
function countEvent(event) {
  const body = JSON.stringify({ event });
  try {
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/public/events', new Blob([body], { type: 'application/json' })))) {
      fetch('/api/public/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  } catch { /* counting is best-effort */ }
}

// The service worker keeps public files for slow connections and shows the
// offline page; a new version waits until the visitor chooses to reload.
if ('serviceWorker' in navigator) {
  const bar = document.getElementById('app-update');
  let reloading = false;
  const offer = (worker) => {
    if (!bar || !worker) return;
    bar.hidden = false;
    bar.querySelector('[data-app-reload]').onclick = () => { reloading = true; worker.postMessage({ type: 'SKIP_WAITING' }); };
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
    }).catch(() => { /* the site works without it */ });
  });
}

// Job page on a phone: an Apply bar while neither the top Apply button nor the
// form is on screen, so applying never needs a long scroll back.
(() => {
  const bar = document.querySelector('[data-sticky-apply]');
  const top = document.querySelector('.job-actions');
  const form = document.getElementById('apply');
  if (!bar || !top || !form || !('IntersectionObserver' in window)) return;
  const phone = window.matchMedia('(max-width: 760px)');
  const onScreen = new Map([[top, true], [form, false]]);
  const update = () => { bar.hidden = !phone.matches || [...onScreen.values()].some(Boolean); };
  const io = new IntersectionObserver((entries) => { entries.forEach((e) => onScreen.set(e.target, e.isIntersecting)); update(); });
  io.observe(top);
  io.observe(form);
  phone.addEventListener('change', update);
})();

// "Add to home screen", only where the browser offers it, not again for 30
// days after "Not now", and the banner only from the third page someone
// opens, so it never covers the first thing they came to see.
(() => {
  const KEY = 'hireriv:install-dismissed';
  const VIEWS = 'hireriv:pages-seen';
  let deferred = null;
  const bar = document.getElementById('app-install');
  let seen = 0;
  try { seen = Number(sessionStorage.getItem(VIEWS) || 0) + 1; sessionStorage.setItem(VIEWS, String(seen)); } catch { seen = 3; }
  const dismissed = () => { try { return seen < 3 || Date.now() - Number(localStorage.getItem(KEY) || 0) < 30 * 86400000; } catch { return false; } };
  const buttons = () => document.querySelectorAll('[data-install-app]');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    buttons().forEach((b) => { b.hidden = false; });
    if (bar && !dismissed()) bar.hidden = false;
  });
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-install-dismiss]')) {
      try { localStorage.setItem(KEY, String(Date.now())); } catch { /* storage blocked */ }
      if (bar) bar.hidden = true;
      return;
    }
    if (!e.target.closest('[data-install-app]') || !deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null;
    buttons().forEach((b) => { b.hidden = true; });
    if (bar) bar.hidden = true;
  });
  window.addEventListener('appinstalled', () => countEvent('app-installed'));
})();

// The offline page: try again by hand, or as soon as the connection is back.
document.querySelectorAll('[data-offline-page]').forEach((page) => {
  page.querySelector('[data-retry]').addEventListener('click', () => location.reload());
  window.addEventListener('online', () => { countEvent('offline-page'); location.reload(); }, { once: true });
});

// Signing out: stop phone notifications on this device and forget what this
// tab kept about the visit (the server also asks the browser to clear its cache).
document.querySelectorAll('form[action$="/logout"]').forEach((form) => {
  form.addEventListener('submit', () => {
    try { sessionStorage.clear(); } catch { /* storage blocked */ }
    try { localStorage.removeItem('hireriv:push-device'); } catch { /* storage blocked */ }
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => reg.pushManager && reg.pushManager.getSubscription()).then((s) => s && s.unsubscribe()).catch(() => {});
    }
  });
});

// Phone notifications (Notification settings): only when the person presses
// the button, never asked on page load.
document.querySelectorAll('[data-push]').forEach((box) => {
  const status = box.querySelector('[data-push-status]');
  const on = box.querySelector('[data-push-on]');
  const off = box.querySelector('[data-push-off]');
  const asQuery = box.dataset.as ? `?as=${encodeURIComponent(box.dataset.as)}` : '';
  const DEVICE = 'hireriv:push-device';
  const say = (t) => { status.textContent = t; };
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) {
    say(/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone and iPad, add Hireriv to your Home Screen first (Share, then Add to Home Screen) and open it from there to turn on notifications.' : 'This browser does not support phone notifications.');
    return;
  }
  const key = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };
  const paint = async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    on.hidden = Boolean(sub);
    off.hidden = !sub;
    if (Notification.permission === 'denied') {
      on.hidden = true;
      say('Notifications are blocked for this site in your browser settings. Allow them there, then reload this page.');
    } else say(sub ? 'Phone notifications are on for this device.' : 'Phone notifications are off for this device.');
  };
  on.addEventListener('click', async () => {
    on.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { say('Notifications were not allowed, so nothing was turned on.'); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(box.dataset.key) });
      const res = await fetch(`/api/devices/push-subscriptions${asQuery}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(sub.toJSON()) });
      const data = await res.json();
      if (!data.ok) { await sub.unsubscribe(); say(data.errors.join(', ')); return; }
      try { localStorage.setItem(DEVICE, data.device.id); } catch { /* storage blocked */ }
      location.reload();
    } catch {
      say('Could not turn on notifications right now. Please try again.');
    } finally {
      on.disabled = false;
    }
  });
  off.addEventListener('click', async () => {
    off.disabled = true;
    try {
      let id = '';
      try { id = localStorage.getItem(DEVICE) || ''; } catch { /* storage blocked */ }
      if (id) await fetch(`/api/devices/push-subscriptions/${encodeURIComponent(id)}${asQuery}`, { method: 'DELETE', headers: { Accept: 'application/json' } });
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      try { localStorage.removeItem(DEVICE); } catch { /* storage blocked */ }
      location.reload();
    } catch {
      say('Could not turn off notifications right now. Please try again.');
    } finally {
      off.disabled = false;
    }
  });
  paint().catch(() => {});
});

// Find Jobs on a phone: the extra filters fold away until asked for, unless
// one of them is in use.
document.querySelectorAll('details[data-more-filters]').forEach((d) => {
  if (d.dataset.moreFilters === '0' && window.matchMedia('(max-width: 700px)').matches) d.open = false;
});

// Read-aloud and speaking instead of typing (voice.js) load only on pages that
// offer them, and only in browsers that support them. Typing always works.
if (document.querySelector('[data-voice-for], [data-read-aloud]') && ('speechSynthesis' in window || 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
  const script = document.createElement('script');
  script.src = `/js/voice.js?v=${(document.querySelector('script[src*="/js/main.js"]') || { src: '' }).src.split('v=')[1] || ''}`;
  script.defer = true;
  document.body.append(script);
}

// ---------- jobs near me ----------
// The browser's position is asked for only when a "near me" button or link is
// pressed, rounded to about a kilometre (2 decimals) and sent only in the
// search address; it is never stored. A PIN code or city works without it.
function searchNearMe(params, report) {
  report(say('nearFinding', 'Finding your location…'));
  navigator.geolocation.getCurrentPosition((pos) => {
    params.set('near', `${pos.coords.latitude.toFixed(2)},${pos.coords.longitude.toFixed(2)}`);
    params.set('sort', 'distance');
    for (const k of ['location', 'page']) params.delete(k);
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    window.location.href = `/jobs?${params}`;
  }, (err) => {
    report(err.code === 1 ? say('nearDenied', 'Location is off for this site. Type a PIN code or choose a city instead.') : say('nearFailed', 'We couldn’t find your location. Type a PIN code or choose a city instead.'), true);
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
}
if ('geolocation' in navigator) {
  document.querySelectorAll('[data-near-me]').forEach((btn) => {
    btn.hidden = false;
    btn.addEventListener('click', () => {
      const form = btn.dataset.nearForm ? document.querySelector(btn.dataset.nearForm) : btn.closest('form');
      const status = (btn.parentElement && btn.parentElement.querySelector('[data-near-status]')) || (form && form.querySelector('[data-near-status]'));
      btn.disabled = true;
      searchNearMe(new URLSearchParams(form ? new FormData(form) : undefined), (text, failed) => {
        if (status) status.textContent = text;
        if (failed) btn.disabled = false;
      });
    });
  });
  document.querySelectorAll('[data-near-me-link]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    searchNearMe(new URLSearchParams(), (text) => toast(text));
  }));
}

// ---------- search suggestions ----------
// While typing in a job search box: words from live jobs (GET /api/suggest)
// in a list under the box. Arrow keys move, Enter opens the highlighted one,
// Escape closes. Searching works the same without it.
const SUGGEST_TYPES = { title: say('suggestTitle', 'Job'), skill: say('suggestSkill', 'Skill'), city: say('suggestCity', 'City'), category: say('suggestCategory', 'Category') };
document.querySelectorAll('input[data-suggest]').forEach((input) => {
  const list = document.createElement('ul');
  list.className = 'suggest-list';
  list.id = `${input.id}-suggest`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', say('suggestLabel', 'Suggestions'));
  list.hidden = true;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.parentElement.classList.add('has-suggest');
  input.parentElement.append(list);
  let items = [];
  let active = -1;
  let timer;
  let asked = '';
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${i}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const paint = () => {
    list.replaceChildren(...items.map((it, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const b = document.createElement('span');
      b.textContent = it.text;
      const kind = document.createElement('span');
      kind.className = 'suggest-kind';
      kind.textContent = SUGGEST_TYPES[it.type] || '';
      li.append(b, kind);
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => { window.location.href = it.href; });
      return li;
    }));
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(Boolean(items.length)));
    highlight(-1);
  };
  const ask = async () => {
    const q = input.value.trim();
    if (q.length < 2) { items = []; paint(); return; }
    if (q === asked) return;
    asked = q;
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
      if (!res.ok || input.value.trim() !== q) return;
      items = (await res.json()).items || [];
      paint();
    } catch { /* offline: just type */ }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(ask, 150); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active <= 0 ? items.length - 1 : active - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); window.location.href = items[active].href; }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
});
