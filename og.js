// Share preview images (Open Graph). WhatsApp, LinkedIn and Facebook only show
// PNG/JPEG previews, so a branded SVG is drawn here and rendered to PNG with
// resvg (WebAssembly, so it runs the same on Windows, Linux and Alpine). The
// fonts are bundled, so text looks the same on every server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');

const W = 1200;
const H = 630;
const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const FONTS = ['PlusJakartaSans_500Medium.ttf', 'PlusJakartaSans_800ExtraBold.ttf'].map((f) => fs.readFileSync(path.join(FONT_DIR, f)));

let ready = null;
const init = () => (ready ||= initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rough text width: Plus Jakarta Sans averages a little over half an em per character.
const widthOf = (text, size, bold) => text.length * size * (bold ? 0.6 : 0.54);

// Greedy word wrap into at most `maxLines`; the last line gets an ellipsis if cut.
function wrap(text, size, maxWidth, maxLines, bold = true) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (widthOf(next, size, bold) <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) {
      line = '';
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s,.;:–-]+$/, '')}…`;
      break;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => (widthOf(l, size, bold) > maxWidth ? `${l.slice(0, Math.floor(maxWidth / (size * 0.6)) - 1)}…` : l));
}

// The largest size (down to `min`) at which the text fits in `maxLines`.
function fit(text, maxWidth, maxLines, sizes) {
  for (const size of sizes) {
    const lines = wrap(text, size, maxWidth, maxLines + 1);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrap(text, size, maxWidth, maxLines) };
}

function frame(inner, footer) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#123B70"/><stop offset="1" stop-color="#2878D4"/></linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#2878D4" stop-opacity="0.45"/><stop offset="1" stop-color="#2878D4" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0B2547"/>
  <circle cx="1060" cy="90" r="420" fill="url(#glow)"/>
  <rect x="0" y="0" width="${W}" height="10" fill="url(#brand)"/>
  <g transform="translate(72 64) scale(1.25)">
    <rect width="48" height="48" rx="13" fill="url(#brand)"/>
    <path d="M16 10v20M32 10v20M16 20h16" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M8 38c4 0 4-3 8-3s4 3 8 3 4-3 8-3 4 3 8 3" fill="none" stroke="#8EC1F5" stroke-width="3" stroke-linecap="round"/>
  </g>
  <text x="152" y="108" font-family="Plus Jakarta Sans" font-weight="800" font-size="40" fill="#ffffff">Hire<tspan fill="#8EC1F5">riv</tspan></text>
  ${inner}
  <path d="M72 560c26 0 26-18 52-18s26 18 52 18 26-18 52-18 26 18 52 18" fill="none" stroke="#8EC1F5" stroke-width="5" stroke-linecap="round"/>
  <text x="${W - 72}" y="570" text-anchor="end" font-family="Plus Jakarta Sans" font-weight="500" font-size="28" fill="#b9c6dd">${esc(footer)}</text>
</svg>`;
}

const lineText = (lines, x, y, size, gap, attrs) =>
  lines.map((l, i) => `<text x="${x}" y="${y + i * Math.round(size * gap)}" ${attrs} font-size="${size}">${esc(l)}</text>`).join('\n  ');

// Pills laid out left to right, sized from their text.
function chips(items, x, y) {
  let cx = x;
  return items
    .filter(Boolean)
    .map((t) => {
      const w = Math.round(widthOf(t, 26, false) + 44);
      if (cx + w > W - 72) return ''; // no room left on the line
      const out =`<rect x="${cx}" y="${y}" width="${w}" height="50" rx="25" fill="#ffffff" fill-opacity="0.1" stroke="#ffffff" stroke-opacity="0.18"/><text x="${cx + w / 2}" y="${y + 34}" text-anchor="middle" font-family="Plus Jakarta Sans" font-weight="500" font-size="26" fill="#e6edf8">${esc(t)}</text>`;
      cx += w + 14;
      return out;
    })
    .join('\n  ');
}

function jobSvg(job, site, host) {
  const title = fit(job.title, W - 144, 3, [68, 60, 54, 48]);
  const titleY = 204 + Math.round(title.size * 0.9); // clears the eyebrow at any size
  const titleEnd = titleY + (title.lines.length - 1) * Math.round(title.size * 1.15);
  const sub = [job.company, job.location].filter(Boolean).join(' · ');
  const inner = [
    `<text x="72" y="182" font-family="Plus Jakarta Sans" font-weight="800" font-size="24" letter-spacing="3" fill="#8EC1F5">NOW HIRING</text>`,
    lineText(title.lines, 72, titleY, title.size, 1.15, 'font-family="Plus Jakarta Sans" font-weight="800" fill="#ffffff"'),
    `<text x="72" y="${titleEnd + 58}" font-family="Plus Jakarta Sans" font-weight="500" font-size="32" fill="#b9c6dd">${esc(wrap(sub, 32, W - 144, 1, false)[0] || '')}</text>`,
    chips([job.mode, job.type, job.experience, job.salary], 72, titleEnd + 92),
  ].join('\n  ');
  return frame(inner, `Apply at ${host}`);
}

function siteSvg(site, host) {
  const tag = fit(site.tagline || 'Staffing & recruitment', W - 144, 3, [64, 56, 50]);
  const inner = [
    lineText(tag.lines, 72, 250, tag.size, 1.15, 'font-family="Plus Jakarta Sans" font-weight="800" fill="#ffffff"'),
    chips(['Find work', 'Hire a team', 'Permanent & contract staffing'], 72, 250 + (tag.lines.length - 1) * Math.round(tag.size * 1.15) + 48),
  ].join('\n  ');
  return frame(inner, host);
}

async function toPng(svg) {
  await init();
  return Buffer.from(new Resvg(svg, { font: { fontBuffers: FONTS, defaultFontFamily: 'Plus Jakarta Sans', loadSystemFonts: false } }).render().asPng());
}

// Rendering takes ~100 ms, so images are cached by the text they show.
function create({ baseUrl }) {
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const cache = new Map();
  const MAX = 300;
  async function cached(key, svg) {
    if (cache.has(key)) return cache.get(key);
    const png = toPng(svg());
    cache.set(key, png);
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    png.catch(() => cache.delete(key));
    return png;
  }
  // Changes whenever the image would; used in the URL so apps that cache
  // previews (WhatsApp, LinkedIn) pick up an edited title.
  const versionOf = (...parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 10);
  const jobFields = (j) => [j.title, j.company, j.location, j.mode, j.type, j.experience, j.salary];
  return {
    jobVersion: (job) => versionOf(jobFields(job), host),
    siteVersion: (site) => versionOf(site.tagline, host),
    job: (job, site) => cached(`job:${versionOf(jobFields(job), host)}`, () => jobSvg(job, site, host)),
    site: (site) => cached(`site:${versionOf(site.tagline, host)}`, () => siteSvg(site, host)),
  };
}

module.exports = { create, wrap, fit, jobSvg, siteSvg, toPng, W, H };
