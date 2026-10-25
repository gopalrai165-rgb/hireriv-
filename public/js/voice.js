// Read-aloud and speaking instead of typing, with the browser's own speech
// features. Loaded by main.js only on pages that offer them. Nothing is
// recorded or sent to Hireriv: the words simply appear in the text box, where
// the person can check and change them before sending. Typing always works.
(() => {
  let L = {};
  try { L = JSON.parse(document.getElementById('i18n-strings').textContent) || {}; } catch { L = {}; }
  const say = (key, fallback) => L[key] || fallback;
  const pageLang = document.documentElement.lang || 'en';
  const tagFor = (code) => ({ en: 'en-IN', hi: 'hi-IN', te: 'te-IN', ta: 'ta-IN', bn: 'bn-IN', mr: 'mr-IN' }[code] || code);

  // A short message for screen readers and sighted people alike.
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  document.body.append(live);
  const announce = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 50); };

  // ---------- read aloud ----------
  if ('speechSynthesis' in window) {
    document.querySelectorAll('[data-read-aloud]').forEach((btn) => {
      const target = document.querySelector(btn.dataset.readAloud);
      if (!target) return;
      const label = btn.querySelector('[data-read-label]');
      const listenText = label ? label.textContent : '';
      const set = (on) => {
        btn.setAttribute('aria-pressed', String(on));
        if (label) label.textContent = on ? say('stop', 'Stop') : listenText;
      };
      btn.hidden = false;
      btn.addEventListener('click', () => {
        if (btn.getAttribute('aria-pressed') === 'true') { speechSynthesis.cancel(); set(false); return; }
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(target.innerText.slice(0, 12000));
        u.lang = btn.dataset.readLang || tagFor(pageLang);
        u.rate = 0.95;
        u.onend = () => set(false);
        u.onerror = () => set(false);
        set(true);
        speechSynthesis.speak(u);
      });
    });
    // Leaving the page stops reading.
    window.addEventListener('pagehide', () => speechSynthesis.cancel());
  }

  // ---------- speak instead of typing ----------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const buttons = document.querySelectorAll('[data-voice-for]');
  if (!Recognition || !buttons.length) return;

  // The person agrees once (on this device) after being told where the audio goes.
  const KEY = 'hireriv:voice-ok';
  const agreed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
  const ask = () => new Promise((resolve) => {
    if (agreed()) return resolve(true);
    const dialog = document.createElement('dialog');
    dialog.className = 'voice-dialog';
    dialog.setAttribute('aria-labelledby', 'voice-dialog-title');
    const h = document.createElement('h2');
    h.id = 'voice-dialog-title';
    h.className = 'h3';
    h.textContent = say('voiceTitle', 'Use your voice?');
    const p = document.createElement('p');
    p.textContent = say('voiceText', 'Your browser turns what you say into text using its own speech service. Hireriv does not record or keep it. You can type instead at any time.');
    const row = document.createElement('div');
    row.className = 'hero-ctas';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn-primary btn-sm';
    yes.textContent = say('voiceAllow', 'Use my voice');
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-outline btn-sm';
    no.textContent = say('voiceCancel', 'Type instead');
    row.append(yes, no);
    dialog.append(h, p, row);
    document.body.append(dialog);
    const done = (ok) => {
      if (ok) try { localStorage.setItem(KEY, '1'); } catch { /* not remembered */ }
      dialog.close();
      dialog.remove();
      resolve(ok);
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    dialog.showModal();
    no.focus();
  });

  let active = null;
  buttons.forEach((btn) => {
    const field = document.getElementById(btn.dataset.voiceFor);
    if (!field) return;
    btn.hidden = false;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', async () => {
      if (active) { active.stop(); return; }
      if (!(await ask())) { field.focus(); return; }
      const rec = new Recognition();
      rec.lang = tagFor(field.closest('[lang]') ? field.closest('[lang]').lang : pageLang);
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      const start = field.value;
      rec.onresult = (e) => {
        const words = [...e.results].map((r) => r[0].transcript).join(' ').trim();
        if (words) {
          field.value = (start ? `${start.replace(/\s+$/, '')} ` : '') + words;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
      rec.onerror = (e) => {
        announce(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? say('voiceDenied', 'Microphone permission was not given. You can type instead.') : say('voiceFailed', 'Your voice could not be heard. Please type instead.'));
      };
      rec.onend = () => {
        active = null;
        btn.setAttribute('aria-pressed', 'false');
        btn.classList.remove('listening');
        field.focus();
      };
      try {
        rec.start();
        active = rec;
        btn.setAttribute('aria-pressed', 'true');
        btn.classList.add('listening');
        announce(say('listening', 'Listening… speak now.'));
      } catch {
        announce(say('voiceFailed', 'Your voice could not be heard. Please type instead.'));
      }
    });
  });
})();
