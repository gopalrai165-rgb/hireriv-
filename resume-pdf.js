// A resume made from a job seeker's profile, as a small PDF with no extra
// library: A4, the built-in Helvetica fonts, text that wraps and flows onto
// more pages. The PDF fonts every reader has cover English and most accented
// Latin letters; anything else (Hindi, Telugu, emoji) can't be drawn with
// them, so it is left out and reported, and the page asks for that text in
// English letters.
const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 50;

// Character widths (1/1000 em) for codes 32–126, from the standard Adobe metrics.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Characters outside Latin-1 that WinAnsi still has, by their byte there.
const WIN_ANSI = { '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '…': 0x85, '€': 0x80, '™': 0x99 };
const SWAPS = { '₹': 'Rs. ', ' ': ' ', '‐': '-', '‑': '-', '−': '-' };

// Text as WinAnsi bytes (one char per byte); `dropped` collects what can't be drawn.
function encode(text, dropped) {
  let out = '';
  for (const ch of String(text ?? '').normalize('NFC')) {
    const c = SWAPS[ch] ?? ch;
    if (c.length > 1) { out += c; continue; }
    const code = c.codePointAt(0);
    if (code === 9 || code === 10) out += ' ';
    else if (code >= 32 && code <= 126) out += c;
    else if (code >= 160 && code <= 255) out += c;
    else if (WIN_ANSI[c]) out += String.fromCharCode(WIN_ANSI[c]);
    else if (code > 31) dropped.add(c);
  }
  return out.replace(/ {2,}/g, ' ');
}

const widthOf = (s, size, bold) => {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    w += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (w * size) / 1000;
};

// Breaks encoded text into lines no wider than `max` points.
function wrap(s, size, bold, max) {
  const lines = [];
  let line = '';
  for (const word of s.split(' ').filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (widthOf(next, size, bold) <= max) { line = next; continue; }
    if (line) lines.push(line);
    // A single word longer than the line is cut where it fills it.
    let rest = word;
    while (widthOf(rest, size, bold) > max) {
      let n = rest.length;
      while (n > 1 && widthOf(rest.slice(0, n), size, bold) > max) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

const pdfString = (s) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
const num = (n) => (Math.round(n * 100) / 100).toString();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` : '');

// The sections of a resume from a profile (candidate-profile.js), in order.
function sections(profile, { summary = '' } = {}) {
  const p = profile || {};
  const out = [];
  if (String(summary).trim()) out.push({ heading: 'About me', blocks: [{ text: summary }] });
  if ((p.experiences || []).length) {
    out.push({
      heading: 'Experience',
      blocks: p.experiences.map((e) => ({
        title: [e.title, e.company].filter(Boolean).join(', '),
        note: [month(e.from), e.current ? 'Present' : month(e.to)].filter(Boolean).join(' to '),
        text: e.summary || '',
      })),
    });
  }
  if ((p.skills || []).length) out.push({ heading: 'Skills', blocks: [{ text: p.skills.join(', ') }] });
  if ((p.education || []).length) {
    out.push({ heading: 'Education', blocks: p.education.map((e) => ({ title: [e.course || e.level, e.institution].filter(Boolean).join(', '), note: [e.course ? e.level : '', e.year].filter(Boolean).join(', ') })) });
  }
  if ((p.certifications || []).length) {
    out.push({ heading: 'Certifications', blocks: p.certifications.map((c) => ({ text: [c.name, c.issuer, c.year].filter(Boolean).join(', ') })) });
  }
  if ((p.languages || []).length) out.push({ heading: 'Languages', blocks: [{ text: p.languages.map((l) => `${l.name} (${String(l.level || '').toLowerCase()})`).join(', ') }] });
  return out;
}

// What a resume made now would be missing, worst first, for the builder page.
function gaps(profile) {
  const p = profile || {};
  const out = [];
  if (!p.name) out.push({ what: 'Your name', href: '/account/profile#basics' });
  if (!p.phone) out.push({ what: 'A mobile number', href: '/account/profile#basics' });
  if (!(p.experiences || []).length) out.push({ what: 'Work experience (or say you are a fresher in a short "About me")', href: '/account/profile#experience' });
  if (!(p.skills || []).length) out.push({ what: 'Skills', href: '/account/profile#skills' });
  if (!(p.education || []).length) out.push({ what: 'Education', href: '/account/profile#education' });
  return out;
}

// Builds the PDF. `contact` is the line under the name (city, phone, email).
// Returns { pdf: Buffer, pages, dropped: [characters left out] }.
function build(profile, { summary = '', contact = [], title = 'Resume', now = new Date() } = {}) {
  const p = profile || {};
  const dropped = new Set();
  const pages = [];
  let ops = [];
  let y = A4.h - MARGIN;
  const width = A4.w - 2 * MARGIN;
  const newPage = () => { pages.push(ops); ops = []; y = A4.h - MARGIN; };
  const room = (h) => { if (y - h < MARGIN) newPage(); };
  const text = (s, { size = 10, bold = false, x = MARGIN, gray = false } = {}) => {
    ops.push(`BT ${gray ? '0.35 0.4 0.47 rg' : '0.06 0.16 0.3 rg'} /${bold ? 'F2' : 'F1'} ${size} Tf ${num(x)} ${num(y)} Td ${pdfString(s)} Tj ET`);
  };
  const para = (raw, opts = {}) => {
    const size = opts.size || 10;
    const lead = size * 1.35;
    for (const line of wrap(encode(raw, dropped), size, opts.bold, width - ((opts.x || MARGIN) - MARGIN))) {
      room(lead);
      y -= lead;
      text(line, { ...opts, size });
    }
  };

  // Name, headline and contact line.
  para(p.name || 'Your name', { size: 20, bold: true });
  if (p.headline) { y -= 2; para(p.headline, { size: 12 }); }
  const contactLine = contact.filter(Boolean).join('  |  ');
  if (contactLine) { y -= 2; para(contactLine, { size: 9.5, gray: true }); }
  y -= 6;

  for (const sec of sections(p, { summary })) {
    room(40);
    y -= 18;
    text(encode(sec.heading.toUpperCase(), dropped), { size: 10.5, bold: true });
    y -= 5;
    ops.push(`0.12 0.42 0.76 RG 0.8 w ${num(MARGIN)} ${num(y)} m ${num(A4.w - MARGIN)} ${num(y)} l S`);
    y -= 2;
    for (const b of sec.blocks) {
      if (b.title) { y -= 3; para(b.title, { size: 10.5, bold: true }); }
      if (b.note) para(b.note, { size: 9, gray: true });
      if (b.text) para(b.text, { size: 10 });
      y -= 3;
    }
  }
  pages.push(ops);

  // ---------- the file ----------
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const pageOps of pages) {
    const stream = pageOps.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const info = add(`<< /Title ${pdfString(encode(title, dropped))} /Producer (Hireriv) /CreationDate (D:${stamp}Z) >>`);

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { pdf: Buffer.from(out, 'latin1'), pages: pages.length, dropped: [...dropped] };
}

module.exports = { build, sections, gaps, encode, wrap };
