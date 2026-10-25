// The AI assistant panels (Step 66): job drafts on the job form, match
// explanations, resume summaries and interview questions on an applicant,
// and the candidate's career assistant. Everything the AI wrote is shown as
// plain text, never as HTML.
(() => {
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data.ok) throw new Error((data.errors || [])[0] || 'Something went wrong. Please try again.');
    return data;
  };
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const listOf = (title, items) => {
    if (!items || !items.length) return null;
    const box = el('div');
    box.append(el('h3', title, 'h4'));
    const ul = el('ul');
    items.forEach((x) => ul.append(el('li', x)));
    box.append(ul);
    return box;
  };
  // Notes, warnings and the feedback buttons every answer gets.
  function frame(result, data) {
    result.replaceChildren();
    result.hidden = false;
    result.append(el('p', data.aiGenerated ? 'Written with AI assistance. Check it before you rely on it.' : 'Made by rules, without AI.', 'small muted'));
    (data.warnings || []).forEach((w) => result.append(el('p', w, 'notice small')));
  }
  function feedbackRow(result, generationId) {
    const row = el('div', undefined, 'row-actions ai-feedback');
    const status = el('span', '', 'small muted');
    status.setAttribute('role', 'status');
    row.append(el('span', 'Was this useful?', 'small'));
    [['helpful', 'Yes'], ['not-helpful', 'No'], ['wrong', 'Wrong'], ['biased', 'Unfair']].forEach(([rating, label]) => {
      const b = el('button', label, 'btn btn-outline btn-sm');
      b.type = 'button';
      b.addEventListener('click', async () => {
        try { await post('/api/ai/feedback', { generationId, rating }); status.textContent = 'Thanks for the feedback.'; row.querySelectorAll('button').forEach((x) => { x.disabled = true; }); } catch (e) { status.textContent = e.message; }
      });
      row.append(b);
    });
    row.append(status);
    result.append(row);
  }

  // ---------- job drafts ----------
  const draftBox = document.querySelector('[data-ai-draft]');
  if (draftBox) {
    const form = draftBox.nextElementSibling && draftBox.nextElementSibling.tagName === 'FORM' ? draftBox.nextElementSibling : document.querySelector('form.form-card');
    const val = (name) => { const f = form && form.elements[name]; return f ? String(f.value || '').trim() : ''; };
    const status = draftBox.querySelector('[data-ai-status]');
    const result = draftBox.querySelector('[data-ai-result]');
    draftBox.querySelector('[data-ai-draft-go]').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const pay = [val('salaryMin') && `₹${val('salaryMin')}`, val('salaryMax') && `₹${val('salaryMax')}`].filter(Boolean).join(' to ');
      const body = {
        title: val('title'), category: val('category'), location: val('location'), type: val('type'), mode: val('mode'), experience: val('experience'), skills: val('skills'),
        shift: val('shift'), hours: val('hours'), pay: [pay && `${pay} a ${val('salaryPeriod') || 'month'}`, val('payNote')].filter(Boolean).join('; '), benefits: val('benefits'),
        notes: draftBox.querySelector('[name="aiNotes"]').value,
      };
      btn.disabled = true;
      status.textContent = 'Writing a draft…';
      try {
        const data = await post('/api/ai/job-description/draft', body);
        const d = data.result;
        status.textContent = '';
        frame(result, data);
        result.append(el('h3', 'About the role', 'h4'), el('p', d.description));
        [listOf('Responsibilities', d.responsibilities), listOf('Requirements', d.qualifications), listOf('Key skills', d.skills), listOf('Worth adding yourself', d.questions_for_employer)].forEach((x) => x && result.append(x));
        const row = el('div', undefined, 'row-actions');
        const use = el('button', 'Use this draft', 'btn btn-primary btn-sm');
        use.type = 'button';
        use.addEventListener('click', async () => {
          const set = (name, v) => { if (form.elements[name] && v) form.elements[name].value = v; };
          set('description', d.description);
          set('responsibilities', (d.responsibilities || []).join('\n'));
          set('qualifications', (d.qualifications || []).join('\n'));
          if (!val('skills')) set('skills', (d.skills || []).join(', '));
          try { await post(`/api/ai/generations/${data.generationId}/review`, { decision: 'used' }); } catch (e) { /* the form still has the text */ }
          status.textContent = 'Copied into the form. Read and edit it, then save.';
          form.elements.description.focus();
        });
        const drop = el('button', 'Discard', 'btn btn-outline btn-sm');
        drop.type = 'button';
        drop.addEventListener('click', async () => {
          try { await post(`/api/ai/generations/${data.generationId}/review`, { decision: 'discarded' }); } catch (e) { /* nothing to undo */ }
          result.hidden = true;
          status.textContent = 'Draft discarded.';
        });
        row.append(use, drop);
        result.append(row);
        feedbackRow(result, data.generationId);
      } catch (e) {
        status.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- an applicant ----------
  const applicant = document.querySelector('[data-ai-applicant]');
  if (applicant) {
    const status = applicant.querySelector('[data-ai-status]');
    const result = applicant.querySelector('[data-ai-result]');
    applicant.querySelectorAll('[data-ai-run]').forEach((btn) => btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-ai-run');
      btn.disabled = true;
      status.textContent = 'Working…';
      try {
        const data = await post(url, { applicationId: applicant.dataset.application, jobId: applicant.dataset.job });
        const r = data.result;
        status.textContent = '';
        frame(result, data);
        if (data.match) result.append(el('p', `Match by Hireriv's rules: ${data.match.score === null ? 'not enough details' : `${data.match.score}/100`} (${data.match.label}). ${data.match.note}`, 'small'));
        if (r.summary) result.append(el('p', r.summary));
        if (r.questions) {
          const ol = el('ol');
          r.questions.forEach((q) => { const li = el('li'); li.append(el('b', q.question)); if (q.listenFor) li.append(el('span', ` Listen for: ${q.listenFor}`, 'small muted')); ol.append(li); });
          result.append(el('h3', 'Questions to ask', 'h4'), ol, el('p', 'Ask everyone for this job the same questions, so candidates are compared fairly.', 'small muted'));
        }
        [listOf('Strengths', r.strengths), listOf('Gaps or unknowns', r.gaps), listOf('To ask', r.questions_to_ask), listOf('Experience', r.experience), listOf('Skills', r.skills), listOf('Education', r.education), listOf('Points to check', r.points_to_check)].forEach((x) => x && result.append(x));
        feedbackRow(result, data.generationId);
      } catch (e) {
        status.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    }));
  }

  // ---------- the career assistant ----------
  const chat = document.querySelector('[data-ai-chat]');
  if (chat) {
    const consentBox = chat.querySelector('[data-ai-consent]');
    const body = chat.querySelector('[data-ai-chat-body]');
    const log = chat.querySelector('[data-ai-log]');
    const status = chat.querySelector('[data-ai-status]');
    const form = chat.querySelector('[data-ai-ask]');
    const add = (role, text) => {
      const li = el('li', undefined, `ai-msg ai-${role}`);
      li.append(el('span', role === 'user' ? 'You said:' : 'Assistant:', 'sr-only'), el('p', text));
      log.append(li);
      li.scrollIntoView({ block: 'nearest' });
      return li;
    };
    chat.querySelector('[data-ai-consent-yes]').addEventListener('click', async () => {
      try { await post('/api/ai/career-assistant/consent', { agree: true }); consentBox.hidden = true; body.hidden = false; form.elements.message.focus(); } catch (e) { status.textContent = e.message; }
    });
    chat.querySelector('[data-ai-consent-no]').addEventListener('click', async () => {
      try { await post('/api/ai/career-assistant/consent', { agree: false }); log.replaceChildren(); body.hidden = true; consentBox.hidden = false; } catch (e) { status.textContent = e.message; }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = form.elements.message.value.trim();
      if (!text) return;
      add('user', text);
      form.elements.message.value = '';
      status.textContent = 'Thinking…';
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const data = await post('/api/ai/career-assistant/message', { message: text });
        status.textContent = data.aiGenerated ? '' : (data.warnings || [])[0] || '';
        const li = add('assistant', data.reply);
        feedbackRow(li, data.generationId);
      } catch (e) {
        status.textContent = e.message;
      } finally {
        btn.disabled = false;
        form.elements.message.focus();
      }
    });
  }
})();
