// The installable app (PWA): the web app manifest, the service worker, the
// offline page, and clearing what the browser kept when someone signs out.
//
// What the service worker keeps on the device is limited to public files:
// the stylesheet, the script, images and icons, and the offline page. Pages,
// API answers, resumes and anything under /account, /employer, /admin,
// /client or /uploads are never stored by it; pages always come from the
// network, and the offline page is shown only when there is none. The cache
// carries the asset version, so a new release replaces it.
const MANIFEST_VERSION = 1;
const SIGN_OUT = ['/account/logout', '/employer/logout', '/admin/logout'];
// The only paths the service worker may store (checked again in tests).
const CACHEABLE = /^\/(?:css|js|img)\//;

function manifest(site) {
  const icons = [
    { src: '/img/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/img/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/img/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  return {
    id: '/?source=pwa',
    name: `${site.name} by Raigozen`,
    short_name: site.name,
    description: 'Find jobs across India, apply in a few taps and follow your applications. Employers can review applicants and schedule interviews.',
    lang: 'en-IN',
    dir: 'ltr',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#ffffff',
    theme_color: '#123B70',
    categories: ['business', 'productivity'],
    icons,
    shortcuts: [
      { name: 'Find jobs', url: '/jobs?source=pwa', icons: [icons[0]] },
      { name: 'My applications', short_name: 'Applications', url: '/account?source=pwa#applications', icons: [icons[0]] },
      { name: 'Saved jobs', short_name: 'Saved', url: '/saved?source=pwa', icons: [icons[0]] },
      { name: 'Employer dashboard', short_name: 'Employer', url: '/employer?source=pwa', icons: [icons[0]] },
    ],
    version: MANIFEST_VERSION,
  };
}

// The service worker, stamped with the asset version.
function serviceWorker(version) {
  return `// Hireriv service worker ${version} (manifest ${MANIFEST_VERSION}).
// Stores public files only: never pages, API answers, resumes or account data.
const VERSION = ${JSON.stringify(version)};
const CACHE = 'hireriv-static-' + VERSION;
const PRECACHE = ['/offline', '/css/style.css?v=' + VERSION, '/js/main.js?v=' + VERSION, '/img/logo.svg', '/img/favicon.svg', '/img/icons/icon-192.png'];
const CACHEABLE = ${CACHEABLE.toString()};
const MAX_ENTRIES = 80;

self.addEventListener('install', (event) => {
  // Fetched without cookies, so nothing about the person can end up in the cache.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { credentials: 'omit' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hireriv-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A new version waits until the page asks it to take over ("Reload" banner).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const storable = (res) => {
  if (!res || !res.ok || res.type !== 'basic') return false;
  const cc = res.headers.get('Cache-Control') || '';
  return !/no-store|private/i.test(cc) && !res.headers.has('Set-Cookie');
};

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Pages always come from the network; the offline page only when it fails.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline').then((r) => r || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
    return;
  }
  // Public files: from the cache, else the network (and kept for next time).
  if (!CACHEABLE.test(url.pathname)) return;
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (storable(res)) cache.put(req, res.clone()).then(() => trim(cache));
      return res;
    })))
  );
});

// Pushes say only that something is new; the details open after signing in.
self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = {}; }
  const url = typeof m.url === 'string' && /^\\/(?!\\/)/.test(m.url) ? m.url : '/notifications';
  event.waitUntil(self.registration.showNotification(String(m.title || 'Hireriv').slice(0, 60), {
    body: String(m.body || 'You have a new notification').slice(0, 120),
    icon: '/img/icons/icon-192.png',
    badge: '/img/icons/icon-192.png',
    tag: String(m.tag || 'hireriv').slice(0, 40),
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/notifications', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === url.origin && 'focus' in c);
    if (open) return open.navigate(url.href).then((c) => (c || open).focus());
    return self.clients.openWindow(url.href);
  }));
});
`;
}

function register(app, { site, assetVersion, sameOrigin, push }) {
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify(manifest(site)));
  });
  app.get('/sw.js', (req, res) => {
    // Always checked for a new version.
    res.type('application/javascript').set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).send(serviceWorker(assetVersion()));
  });
  // Shown by the service worker when there is no connection. The same for
  // everyone: it never shows who is signed in.
  app.get('/offline', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.locals.candidateSignedIn = false;
    res.locals.unread = {};
    res.render('offline', { title: 'You are offline', page: 'offline', noindex: true });
  });
  // Signing out also removes this sign-in's phone notifications and asks the
  // browser to clear what it cached for this site.
  // (Runs before the sign-out routes themselves, after the same-origin check.)
  app.use((req, res, next) => {
    if (req.method !== 'POST' || !SIGN_OUT.includes(req.path)) return next();
    sameOrigin(req, res, () => {
      push.forgetSession(req);
      res.set('Clear-Site-Data', '"cache"');
      next();
    });
  });
}

module.exports = { register, manifest, serviceWorker, CACHEABLE, SIGN_OUT, MANIFEST_VERSION };
