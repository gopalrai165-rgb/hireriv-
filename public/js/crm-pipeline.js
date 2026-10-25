// Drag-and-drop on the sales pipeline (/admin/crm/pipeline). Each card also
// has a plain form, so the board works with a keyboard and without scripts.
(function () {
  var board = document.querySelector('[data-crm-board]');
  if (!board) return;
  var status = document.querySelector('[data-crm-status]');
  var dragged = null;
  var say = function (text) { if (status) status.textContent = text; };

  board.addEventListener('dragstart', function (e) {
    var card = e.target.closest && e.target.closest('.crm-card');
    if (!card || card.getAttribute('draggable') !== 'true') return;
    dragged = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  board.addEventListener('dragend', function () {
    if (dragged) dragged.classList.remove('dragging');
    dragged = null;
    board.querySelectorAll('.crm-col.over').forEach(function (c) { c.classList.remove('over'); });
  });
  board.addEventListener('dragover', function (e) {
    var col = e.target.closest && e.target.closest('.crm-col');
    if (!col || !dragged) return;
    var moves = (dragged.dataset.moves || '').split('|');
    if (moves.indexOf(col.dataset.stage) === -1) return;
    e.preventDefault();
    col.classList.add('over');
  });
  board.addEventListener('dragleave', function (e) {
    var col = e.target.closest && e.target.closest('.crm-col');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('over');
  });
  board.addEventListener('drop', function (e) {
    var col = e.target.closest && e.target.closest('.crm-col');
    if (!col || !dragged) return;
    e.preventDefault();
    col.classList.remove('over');
    var card = dragged;
    var stage = col.dataset.stage;
    var form = card.querySelector('form.crm-move');
    // A lost opportunity needs a reason: use the card's form.
    if (stage === 'Lost') {
      if (form) {
        form.querySelector('[name=stage]').value = 'Lost';
        form.querySelector('[name=reason]').focus();
      }
      say('Choose why it was lost on the card, then press Move.');
      return;
    }
    say('Moving…');
    fetch('/api/crm/opportunities/' + encodeURIComponent(card.dataset.id) + '/stage', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ stage: stage }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j.ok) { col.appendChild(card); say('Moved to ' + stage + '.'); window.location.reload(); }
        else say((res.j.errors || ['Could not move it.']).join(' '));
      })
      .catch(function () { say('Could not move it: check your connection and try again.'); });
  });
})();
