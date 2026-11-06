// The automated accessibility rules for a page's HTML, shared by the public,
// candidate, employer and team page tests.
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '<svg></svg>');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, 'x').trim();

function problems(raw) {
  const html = strip(raw);
  const out = [];
  if (!/<html lang="[a-z]{2}"/.test(raw)) out.push('no page language');
  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) out.push(`${h1} h1 headings`);
  if (!/<main[\s>]/.test(html)) out.push('no main landmark');
  if (!/class="skip-link"|href="#main"/.test(html)) out.push('no skip link');
  for (const m of html.matchAll(/tabindex="(\d+)"/g)) if (Number(m[1]) > 0) out.push(`positive tabindex ${m[1]}`);
  for (const m of html.matchAll(/<img\b[^>]*>/g)) if (attr(m[0], 'alt') === null) out.push(`image without alt: ${m[0].slice(0, 80)}`);
  // Every form field has a name a screen reader can read.
  const labelled = new Set([...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]));
  const labelSpans = [];
  for (const m of html.matchAll(/<label\b[\s\S]*?<\/label>/g)) labelSpans.push([m.index, m.index + m[0].length]);
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    const type = attr(tag, 'type') || '';
    if (['hidden', 'submit', 'button'].includes(type)) continue;
    if (attr(tag, 'name') === 'website' || /\shidden[\s>]/.test(tag)) continue; // the anti-spam field, and fields never shown
    const inLabel = labelSpans.some(([a, b]) => m.index > a && m.index < b);
    if (inLabel || labelled.has(attr(tag, 'id')) || attr(tag, 'aria-label') || attr(tag, 'aria-labelledby') || attr(tag, 'title')) continue;
    out.push(`field without a label: ${tag.slice(0, 100)}`);
  }
  // Every button and link says what it does.
  for (const m of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, kind, attrs, inner] = m;
    if (kind === 'a' && !/\shref=/.test(attrs)) continue;
    if (text(inner) || /aria-label="[^"]+"|aria-labelledby=|title="[^"]+"/.test(attrs)) continue;
    out.push(`${kind} without a name: ${m[0].slice(0, 100)}`);
  }
  // Status is never colour alone: pills always carry words.
  for (const m of html.matchAll(/<span class="pill[^"]*"[^>]*>([\s\S]*?)<\/span>/g)) if (!text(m[1])) out.push('empty status pill');
  return out;
}

module.exports = { problems };
