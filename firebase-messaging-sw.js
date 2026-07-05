/* Hotizy — Firebase Cloud Messaging background worker.
 * Receives web push when the PWA/tab is closed or backgrounded and shows a
 * system notification. Must live at the site root with this exact filename. */
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-messaging.js');

firebase.initializeApp({
    apiKey: 'AIzaSyA9gr0enNzAxFNVcWAn9oiLLMJn5DfgCac',
    projectId: 'panel-d25c9',
    messagingSenderId: '201774041360',
    appId: '1:201774041360:web:b7725c119584a03c643d95'
});

const messaging = firebase.messaging();

// Data-only messages (or extra handling) — FCM auto-displays messages that
// already carry a `notification` payload, so this is a safety net.
messaging.setBackgroundMessageHandler(function (payload) {
    const n = payload.notification || {};
    const d = payload.data || {};
    return self.registration.showNotification(n.title || 'Hotizy', {
        body: n.body || '',
        icon: 'logo.png',
        badge: 'logo.png',
        // functions/index.js her zaman App Shell rotası (app#...) gönderir
        // — bu yalnızca url hiç gelmezse devreye giren bir yedek. Eski bağımsız
        // /panel.html sabit header/nav'ı olmayan bir sayfaya düşürüyordu;
        // functions/index.js:304-308'deki aynı App Shell varsayılanına hizalandı.
        data: { url: d.url || '/app#kayitlar' },
        vibrate: [60, 40, 60]
    });
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/app#kayitlar';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
            for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
            if (self.clients.openWindow) return self.clients.openWindow(url);
        })
    );
});
