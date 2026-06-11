/* StayOS PWA bootstrap — injects the manifest link + theme meta and registers
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
        l.href = 'manifest.webmanifest';
        document.head.appendChild(l);
    }
    meta('theme-color', '#6366f1');
    meta('mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-status-bar-style', 'default');
    meta('apple-mobile-web-app-title', 'StayOS');
    if (!document.head.querySelector('link[rel="apple-touch-icon"]')) {
        const al = document.createElement('link');
        al.rel = 'apple-touch-icon';
        al.href = 'logo.png';
        document.head.appendChild(al);
    }
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(() => { });
        });
    }
})();
