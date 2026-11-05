// "Fill from a job post" on the job forms (Step 173): sends the pasted text to
// the server's rules (job-parse.js) and fills only the fields that are still
// empty, or still on their starting choice. Nothing is saved here.
(() => {
  const box = document.querySelector('[data-job-paste]');
  if (!box) return;
  const form = box.parentElement.querySelector('form.form-card[method="post"]') || document.querySelector('form.form-card[method="post"]');
  if (!form) return;
  const status = box.querySelector('[data-job-paste-status]');
  const text = box.querySelector('textarea');
  const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt !== undefined) e.textContent = txt; if (cls) e.className = cls; return e; };

  // A select counts as empty while it is still on the option the page started with.
  const untouched = (f) => {
    if (f.tagName === 'SELECT') { const first = [...f.options].find((o) => o.defaultSelected) || f.options[0]; return !f.value || (first && f.value === first.value); }
    return !String(f.value || '').trim();
  };
  const mark = (f) => {
    f.classList.add('is-filled');
    const d = f.closest('details');
    if (d && d !== box) d.open = true;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => f.classList.remove('is-filled'), 4000);
  };

  box.querySelector('[data-job-paste-go]').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!text.value.trim()) { status.textContent = 'Paste the job post first.'; text.focus(); return; }
    btn.disabled = true;
    status.textContent = 'Reading the post…';
    let data = {};
    try {
      const res = await fetch(box.dataset.endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text: text.value }) });
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (!res.ok || !data.ok) throw new Error((data.errors || [])[0] || 'Something went wrong. Please try again.');
    } catch (e) {
      status.textContent = e.message;
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    const filled = [];
    const kept = [];
    for (const [name, value] of Object.entries(data.fields || {})) {
      const f = form.elements[name];
      if (!f || f instanceof RadioNodeList || f.type === 'hidden') continue;
      if (f.tagName === 'SELECT' && ![...f.options].some((o) => o.value === value)) continue;
      if (!untouched(f)) { kept.push(name); continue; }
      f.value = value;
      filled.push(name);
      mark(f);
    }
    // Tick boxes: perks and things the worker must have are only ever added.
    const tick = (name, value) => {
      const boxes = [...form.querySelectorAll(`input[type="checkbox"][name="${name}"]`)].filter((c) => value === undefined || c.value === value);
      boxes.forEach((c) => { if (!c.checked) { c.checked = true; mark(c); filled.push(name); } });
    };
    const c = data.checks || {};
    (c.perks || []).forEach((k) => tick('perks', k));
    (c.bring || []).forEach((k) => tick('bring', k));
    if (c.walkIn) tick('walkIn');
    if (c.immediate) tick('immediate');

    status.replaceChildren();
    if (!data.found || !data.found.length) {
      status.append(el('p', 'Nothing in that post matched the form. Fill the fields below yourself.', 'notice'));
      return;
    }
    // Name what changed and what was kept, once each (pay is three fields, one label).
    const names = (list) => [...new Set(list.map((n) => (data.labels || {})[n]).filter(Boolean))];
    const changed = names(filled);
    const left = names(kept).filter((l) => !changed.includes(l));
    status.append(el('p', changed.length ? `Filled from the post: ${changed.join(', ')}. Check every field, then save.` : 'The fields this post covers are already filled, so nothing was changed.', 'notice notice-ok'));
    if (left.length) status.append(el('p', `Kept what you had already entered: ${left.join(', ')}.`, 'small muted'));
    (data.notes || []).forEach((n) => status.append(el('p', n, 'notice small')));
    const first = form.querySelector('.is-filled');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
})();
