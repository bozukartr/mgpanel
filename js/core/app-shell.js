/* StayOS — app-shell.js
 * Tek kalıcı header + iframe içerik kabuğunun yönlendiricisi.
 * Paneller iframe içinde gömülü (?embed=1) çalışır; header sabit kalır,
 * yalnızca iframe içeriği değişir. Admin paneli kabuğun DIŞINDADIR (üst pencere). */
(function () {
    'use strict';
    if (typeof auth === 'undefined') return;
    var $ = function (id) { return document.getElementById(id); };

    var USERNAME = localStorage.getItem('hotelUsername') || '';
    var ROLE = (localStorage.getItem('hotelRole') || '').toLowerCase();

    // Oturum yoksa girişe (üst pencere).
    if (!USERNAME) { location.replace('login.html'); return; }
    auth.onAuthStateChanged(function (u) { if (!u) location.replace('login.html'); });

    var ROUTES = {
        dashboard: { page: 'dashboard.html', module: null },
        concierge: { page: 'concierge.html', module: 'concierge' },
        kayitlar:  { page: 'panel.html',      module: 'guestIssues' },
        raporlar:  { page: 'reports.html',     module: 'reports' },
        crm:       { page: 'crm.html',         module: 'crm' },
        restoran:  { page: 'restaurant.html',  module: 'restaurant' }
    };
    function moduleOn(key) {
        if (!key) return true;
        return (typeof moduleEnabled === 'function') ? moduleEnabled(key) : true;
    }

    // Giriş bağlamı: 'hotel' (otel modülleri) veya 'fnb' (yalnızca Restoran + Raporlar).
    var CTX = (localStorage.getItem('loginContext') || 'hotel');
    function ctxAllows(route) {
        if (CTX === 'fnb') return (route === 'restoran' || route === 'raporlar');
        return route !== 'restoran';   // hotel: Restoran F&B'ye özel
    }
    function defaultRoute() { return CTX === 'fnb' ? 'restoran' : 'dashboard'; }
    function applyContext() {
        document.querySelectorAll('[data-ctx]').forEach(function (el) {
            var c = el.getAttribute('data-ctx');
            if (c && c !== CTX) el.style.display = 'none';
        });
        if (CTX === 'fnb') {
            var brand = document.querySelector('.sh-logo span');
            if (brand) brand.textContent = 'StayOS F&B';
        }
    }

    var frame = $('shFrame');
    var loading = $('shLoading');
    var currentRoute = null;
    // Per-session cache-buster: ensures the iframe always loads the freshly
    // deployed page and never an entry left in a stale (legacy) cache under the
    // plain "?embed=1" URL. Stable within a session; new on each app load.
    var SHELL_V = Date.now().toString(36);

    function setActive(route) {
        document.querySelectorAll('.sh-tab[data-route], .sh-bn[data-route]').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('data-route') === route);
        });
    }

    // route: hedef görünüm · query: iframe'e geçirilecek ek parametre · force: aynı route olsa da yeniden yükle
    function loadRoute(route, query, force) {
        var def = ROUTES[route];
        if (!def || !moduleOn(def.module) || !ctxAllows(route)) { route = defaultRoute(); def = ROUTES[route]; }
        var src = def.page + '?embed=1&v=' + SHELL_V + (query ? '&' + query : '');
        if (force || query || route !== currentRoute) {
            if (loading) loading.classList.add('show');
            frame.src = src;
        }
        currentRoute = route;
        setActive(route);
    }

    // Hash değişimi → görünüm yükle
    function fromHash() {
        var h = (location.hash || '').replace('#', '').split('?')[0];
        loadRoute(h || defaultRoute());
    }
    window.addEventListener('hashchange', fromHash);

    // Nav tıklamaları → hash güncelle
    document.querySelectorAll('.sh-tab[data-route], .sh-bn[data-route]').forEach(function (el) {
        el.addEventListener('click', function () {
            var r = el.getAttribute('data-route');
            if (('#' + r) === location.hash) loadRoute(r); else location.hash = '#' + r;
        });
    });

    // "Talepler" — misafir QR talep/sipariş çekmecesini açar (Concierge/Kayıtlar'da
    // gömülü guest-orders.js çalışır). Başka görünümdeysek Concierge'e geçip açar.
    function openOrders() {
        if (currentRoute === 'concierge' || currentRoute === 'kayitlar') {
            try { frame.contentWindow.postMessage({ __mgShell: 1, type: 'openOrders' }, '*'); } catch (e) {}
        } else {
            location.hash = '#concierge';
            loadRoute('concierge', 'orders=1', true);
        }
    }
    document.querySelectorAll('[data-action="orders"]').forEach(function (el) {
        el.addEventListener('click', openOrders);
    });

    // iframe kendi içinde başka panele giderse (ör. hızlı aksiyon) → aktif sekmeyi senkronla
    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || !d.__mgShell || d.type !== 'route' || !d.route) return;
        if (d.route === currentRoute) { setActive(d.route); return; }
        currentRoute = d.route;          // iframe zaten o sayfada; yeniden yükleme
        setActive(d.route);
        try { history.replaceState(null, '', '#' + d.route); } catch (err) {}
    });

    frame.addEventListener('load', function () { if (loading) loading.classList.remove('show'); });

    // Bildirim (zil) tıklamaları kabuk içinde doğru görünüme yönlensin.
    if (window.RT) {
        RT.onOpen = function (recordId) {
            location.hash = '#kayitlar';
            loadRoute('kayitlar', recordId ? 'open=' + encodeURIComponent(recordId) : '', true);
        };
        if (RT.registerOpener) RT.registerOpener('guestOrder', function (orderId) {
            location.hash = '#concierge';
            loadRoute('concierge', orderId ? 'order=' + encodeURIComponent(orderId) : '', true);
        });
    }

    // Header
    function init() {
        applyContext();
        var name = USERNAME ? (USERNAME.charAt(0).toUpperCase() + USERNAME.slice(1)) : 'Ekip';
        $('shUser').textContent = name;
        $('shRole').textContent = ROLE ? (ROLE.charAt(0).toUpperCase() + ROLE.slice(1)) : 'Personel';
        $('shAvatar').textContent = (USERNAME.slice(0, 2) || '··').toUpperCase();
        if (ROLE === 'admin' || USERNAME.toLowerCase() === 'admin') { var a = $('shAdmin'); if (a) a.style.display = ''; }
        if (typeof moduleEnabled === 'function' && !moduleEnabled('guestOrders')) {
            document.querySelectorAll('.sh-orders').forEach(function (el) { el.style.display = 'none'; });
        }
        $('shLogout').onclick = function () { try { auth.signOut(); } catch (e) {} location.href = 'login.html'; };
        fromHash();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
