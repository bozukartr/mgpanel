/* Hotizy PWA bootstrap — injects the manifest link + theme meta and registers
 * the service worker. Drop <script src="pwa.js"></script> on any page to make
 * it installable. Safe to include everywhere; no-ops where unsupported. */
(function () {
    'use strict';
    function meta(name, content, attr) {
        attr = attr || 'name';
        if (document.head.querySelector(`meta[${attr}="${name}"]`)) return;
        const m = document.createElement('meta');
        m.setAttribute(attr, name);
        m.setAttribute('content', content);
        document.head.appendChild(m);
    }
    if (!document.head.querySelector('link[rel="manifest"]')) {
        const l = document.createElement('link');
        l.rel = 'manifest';
        // Mutlak yol: her sayfada (login, app, panel…) AYNI manifest referans
        // edilsin ki iOS/Chrome tek bir PWA kimliği (id: "/") görsün — yoksa
        // login ile panel ekranından kurulan ayrı uygulamalar olarak algılanır.
        l.href = '/manifest.webmanifest';
        document.head.appendChild(l);
    }
    meta('theme-color', '#6366f1');
    meta('mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-status-bar-style', 'default');
    meta('apple-mobile-web-app-title', 'Hotizy');
    // iOS ana ekran ikonu OPAK olmalı — iOS şeffaflığı SİYAHA çevirir; eski
    // href (/logo.png) şeffaf zeminliydi, ana ekranda siyah kare görünüyordu.
    // apple-touch-icon.png beyaz zeminli 180x180 (logo-maskable'dan üretildi).
    if (!document.head.querySelector('link[rel="apple-touch-icon"]')) {
        const al = document.createElement('link');
        al.rel = 'apple-touch-icon';
        al.sizes = '180x180';
        al.href = '/apple-touch-icon.png';
        document.head.appendChild(al);
    }
    // Sekme ikonu: sayfaların çoğunda rel="icon" hiç yoktu — tarayıcı
    // /favicon.ico'ya düşüyor, o da yoktu (404 → boş sekme ikonu). pwa.js
    // her sayfada yüklendiğinden burada enjekte etmek hepsini kapsar.
    if (!document.head.querySelector('link[rel="icon"]')) {
        const fi = document.createElement('link');
        fi.rel = 'icon';
        fi.href = '/favicon.ico';
        fi.sizes = '48x48';
        document.head.appendChild(fi);
        const fp = document.createElement('link');
        fp.rel = 'icon';
        fp.type = 'image/png';
        fp.sizes = '192x192';
        fp.href = '/logo-192.png';
        document.head.appendChild(fp);
    }
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(() => { });
        });
    }
})();
