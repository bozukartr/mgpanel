/* StayOS service worker — makes the app installable (PWA) and serves an
 * offline fallback for the app shell. App data stays live via Firestore;
 * we intentionally do NOT cache HTML/JS so deploys are picked up immediately.
 *
 * Web Push (FCM) hooks are stubbed below and will be wired once the sender
 * Cloud Function can be deployed.
 */
const CACHE = 'stayos-shell-v3';
const SHELL = ['logo.png', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Only handle same-origin static IMAGES; never intercept HTML/JS/CSS so a
    // plain refresh always picks up new deploys (CSS used to be cache-first
    // here, which served stale styles after releases).
    if (url.origin !== self.location.origin) return;
    if (/\.(png|jpg|jpeg|svg|ico|webmanifest)$/i.test(url.pathname)) {
        event.respondWith(
            caches.match(req).then(hit => hit || fetch(req).then(res => {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
                return res;
            }).catch(() => hit))
        );
    }
});

// ── Web Push (placeholder until FCM sender function is deployable) ──
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
    const title = data.title || 'StayOS';
    const options = {
        body: data.body || 'Yeni bir bildiriminiz var.',
        icon: 'logo.png',
        badge: 'logo.png',
        data: { url: data.url || '/panel.html' },
        vibrate: [60, 40, 60]
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/panel.html';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
            if (self.clients.openWindow) return self.clients.openWindow(url);
        })
    );
});
