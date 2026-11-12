/* Hotizy — app-shell.js
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
    if (!USERNAME) { location.replace('login'); return; }
    auth.onAuthStateChanged(function (u) { if (!u) location.replace('login'); });

    var ROUTES = {
        dashboard: { page: 'dashboard', module: null },
        concierge: { page: 'concierge', module: 'concierge' },
        kayitlar:  { page: 'panel',      module: 'guestIssues' },
        raporlar:  { page: 'reports',     module: 'reports' },
        crm:       { page: 'crm',         module: 'crm' },
        restoran:  { page: 'restaurant',  module: 'restaurant' }
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
    // Mobil kırılım noktası: kabuk 880px'te mobile geçer (panel sayfaları 768px —
    // fark bilinçlidir, kabuk kromu daha erken sıkışır).
    var MOB = window.matchMedia ? window.matchMedia('(max-width: 880px)') : null;
    function isMobileShell() { return !!(MOB && MOB.matches); }
    // Açılış ekranı role göre: Panel (özet kartları, analiz) yöneticiler
    // içindir. Saha personeli (admin/yönetici değil) ve mobil her zaman
    // "Misafir Kayıtları"nda açılır — orada önce kendi İŞ KUYRUĞU (üzerindeki
    // ve departmanında sırada bekleyen işler) görünür (panel.js renderMyQueue).
    function isManagerRole() { return ROLE === 'admin' || ROLE === 'manager' || USERNAME.toLowerCase() === 'admin'; }
    function defaultRoute() {
        if (CTX === 'fnb') return 'restoran';
        if ((isMobileShell() || !isManagerRole()) && moduleOn('guestIssues')) return 'kayitlar';
        return 'dashboard';
    }
    function applyContext() {
        document.querySelectorAll('[data-ctx]').forEach(function (el) {
            var c = el.getAttribute('data-ctx');
            if (c && c !== CTX) el.style.display = 'none';
        });
        if (CTX === 'fnb') {
            var brand = document.querySelector('.sh-logo span');
            if (brand) brand.textContent = 'Hotizy F&B';
        }
    }

    // ── Modül çerçeveleri: açılan her modül kendi iframe'inde AÇIK kalır ──
    // Önceden tek bir iframe vardı; her sekme tıklaması sayfayı baştan
    // yüklüyor, filtreler / kaydırma konumu / yarım kalan form kayboluyor ve
    // her seferinde yükleniyor simgesi dönüyordu. Artık geçiş anlık: gizli
    // çerçeveler canlı dinleyicileriyle güncel kalır. Bellek için en çok
    // MAX_FRAMES çerçeve tutulur (en uzun süredir bakılmayan kapanır);
    // STALE_MS'ten uzun süre bakılmayan çerçeve gösterilirken tazelenir.
    var host = document.querySelector('.sh-content');
    var loading = $('shLoading');
    var seedFrame = $('shFrame');          // app.html'deki ilk iframe yeniden kullanılır
    var frames = {};                       // route → iframe
    var currentRoute = null;
    var MAX_FRAMES = isMobileShell() ? 3 : 6;
    var STALE_MS = 30 * 60 * 1000;
    // Per-session cache-buster: ensures the iframe always loads the freshly
    // deployed page and never an entry left in a stale (legacy) cache under the
    // plain "?embed=1" URL. Stable within a session; new on each app load.
    var SHELL_V = Date.now().toString(36);

    function setActive(route) {
        document.querySelectorAll('.sh-tab[data-route], .sh-dr[data-route], .sh-bt[data-route]').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('data-route') === route);
        });
    }
    function routeOfWindow(win) {
        for (var r in frames) { if (frames[r].contentWindow === win) return r; }
        return null;
    }
    function createFrame(route, query) {
        var def = ROUTES[route];
        var f = seedFrame || document.createElement('iframe');
        seedFrame = null;
        f.removeAttribute('id');
        f.className = 'sh-frame';
        f.title = 'İçerik';
        f.setAttribute('data-route', route);
        f.__ready = false;
        f.addEventListener('load', function () {
            f.__ready = true;
            if (frames[currentRoute] === f && loading) loading.classList.remove('show');
            // Kısayollar odak çerçevenin içindeyken de çalışsın (aynı köken).
            try { f.contentWindow.addEventListener('keydown', onKey, true); } catch (e) {}
            // Kullanıcı etkinliği (ekran kilidi boşta kalma sayacı) çerçevede de sayılır.
            try { ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (t) { f.contentWindow.addEventListener(t, activity, { passive: true, capture: true }); }); } catch (e) {}
        });
        if (!f.parentNode) host.insertBefore(f, loading);
        f.src = def.page + '?embed=1&v=' + SHELL_V + (query ? '&' + query : '');
        frames[route] = f;
        return f;
    }
    function dropFrame(route) {
        var f = frames[route];
        if (!f) return;
        delete frames[route];
        try { f.src = 'about:blank'; } catch (e) {}
        if (f.parentNode) f.parentNode.removeChild(f);
    }
    function showFrame(route) {
        Object.keys(frames).forEach(function (r) {
            var f = frames[r], on = (r === route);
            if (!on && f.classList.contains('on')) f.__hiddenAt = Date.now();
            f.classList.toggle('on', on);
            if (on) { f.removeAttribute('inert'); f.removeAttribute('aria-hidden'); f.__hiddenAt = 0; }
            else { f.setAttribute('inert', ''); f.setAttribute('aria-hidden', 'true'); }
        });
        if (loading) loading.classList.toggle('show', !!(frames[route] && !frames[route].__ready));
    }
    function evict() {
        var keys = Object.keys(frames).filter(function (r) { return r !== currentRoute; });
        var extra = Object.keys(frames).length - MAX_FRAMES;
        if (extra <= 0) return;
        keys.sort(function (a, b) { return (frames[a].__hiddenAt || 0) - (frames[b].__hiddenAt || 0); })
            .slice(0, extra).forEach(dropFrame);
    }

    // route: hedef görünüm · query: modüle iletilecek derin bağlantı (ör.
    // open=ID) · reload: çerçeveyi baştan yükle.
    function loadRoute(route, query, reload) {
        var def = ROUTES[route];
        if (!def || !moduleOn(def.module) || !ctxAllows(route)) { route = defaultRoute(); query = ''; }
        var f = frames[route];
        var stale = f && route !== currentRoute && f.__hiddenAt && (Date.now() - f.__hiddenAt > STALE_MS);
        if (f && (reload || stale || (query && !f.__ready))) { dropFrame(route); f = null; }
        if (!f) {
            createFrame(route, query);
        } else if (query) {
            // Modül zaten açık: yeniden yüklemeden derin bağlantıyı ilet.
            try { f.contentWindow.postMessage({ __mgShell: 1, type: 'deepLink', query: query }, '*'); } catch (e) {}
        }
        currentRoute = route;
        setActive(route);
        showFrame(route);
        evict();
    }
    // Görünüme git: adres çubuğundaki hash'i günceller (geri tuşu çalışsın)
    // ve görünümü yükler — hashchange'i beklemeden, çift yükleme olmadan.
    function navigate(route, query) {
        if (location.hash !== '#' + route) {
            try { history.pushState(null, '', '#' + route); } catch (e) { /* yok say */ }
        }
        loadRoute(route, query || '');
    }

    // Hash değişimi (geri/ileri tuşu, dışarıdan gelen bağlantı) → görünüm
    // yükle. Hash'te bir sorgu olabilir (ör. app#concierge?order=ID veya
    // #kayitlar?open=ID); bunu modüle ilet ki bildirimle gelen kayıt odaklansın.
    function fromHash() {
        var raw = (location.hash || '').replace(/^#/, '');
        var qi = raw.indexOf('?');
        var h = qi >= 0 ? raw.slice(0, qi) : raw;
        var q = qi >= 0 ? raw.slice(qi + 1) : '';
        loadRoute(h || defaultRoute(), q);
        // Sorgu bir kez iletildi; adres çubuğunda kalırsa yenilemede kayıt tekrar açılırdı.
        if (q) { try { history.replaceState(null, '', '#' + currentRoute); } catch (e) {} }
    }
    window.addEventListener('hashchange', fromHash);

    // Nav tıklamaları
    document.querySelectorAll('.sh-tab[data-route], .sh-dr[data-route]').forEach(function (el) {
        el.addEventListener('click', function () { navigate(el.getAttribute('data-route')); });
    });

    // "Talepler" — misafir QR talep/sipariş çekmecesini açar (Concierge/Kayıtlar'da
    // gömülü guest-orders.js çalışır). Başka görünümdeysek Concierge'e geçip açar.
    function openOrders() {
        var f = frames[currentRoute];
        if ((currentRoute === 'concierge' || currentRoute === 'kayitlar') && f && f.__ready) {
            try { f.contentWindow.postMessage({ __mgShell: 1, type: 'openOrders' }, '*'); } catch (e) {}
        } else {
            navigate('concierge', 'orders=1');
        }
    }
    document.querySelectorAll('[data-action="orders"]').forEach(function (el) {
        el.addEventListener('click', openOrders);
    });

    // ── Mobil modül çekmecesi ──────────────────────────────────────
    // Alt nav bar kaldırıldığı için tüm rotalar buradan açılır. Satırlar
    // sekmelerle aynı data-route/data-action niteliklerini taşıdığından
    // yönlendirme mantığı yukarıdaki tek delegasyonla paylaşılır; burada
    // yalnızca çekmecenin açılıp kapanması yönetilir.
    var drawer = $('shDrawer'), scrim = $('shScrim'), menuBtn = $('shMenuBtn');
    function setDrawer(open) {
        if (!drawer) return;
        drawer.classList.toggle('show', open);
        if (scrim) scrim.classList.toggle('show', open);
        if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        var bm = document.querySelector('.sh-bt[data-bt="menu"]');
        if (bm) { bm.setAttribute('aria-expanded', open ? 'true' : 'false'); bm.classList.toggle('open', open); }
    }
    if (menuBtn) menuBtn.addEventListener('click', function () { setDrawer(!drawer.classList.contains('show')); });
    if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });
    if (drawer) drawer.addEventListener('click', function (e) {
        if (e.target.closest('.sh-dr')) setDrawer(false);   // seçim yapıldı → kapat
    });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape') setDrawer(false); });
    // Rota değişince (bildirim/derin bağlantı dâhil) çekmece açık kalmasın.
    window.addEventListener('hashchange', function () { setDrawer(false); });

    // Bir çerçeve kendi içinde başka bir modüle geçerse (ör. hızlı aksiyon ya
    // da kapalı modülden yönlendirme) o çerçeve artık o modülündür: yeniden
    // yüklemeden yeni rotaya taşınır, aktif sekme senkronlanır.
    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || !d.__mgShell || d.type !== 'route' || !d.route) return;
        var owner = routeOfWindow(e.source);
        if (!owner || owner === d.route || !ROUTES[d.route]) return;
        var f = frames[owner];
        if (frames[d.route]) dropFrame(d.route);
        delete frames[owner];
        frames[d.route] = f;
        f.setAttribute('data-route', d.route);
        if (currentRoute === owner) {
            currentRoute = d.route;
            setActive(d.route);
            try { history.replaceState(null, '', '#' + d.route); } catch (err) {}
        }
    });

    // Bildirim (zil) tıklamaları kabuk içinde doğru görünüme yönlensin.
    if (window.RT) {
        RT.onOpen = function (recordId) {
            navigate('kayitlar', recordId ? 'open=' + encodeURIComponent(recordId) : '');
        };
        if (RT.registerOpener) RT.registerOpener('guestOrder', function (orderId) {
            navigate('concierge', orderId ? 'order=' + encodeURIComponent(orderId) : '');
        });
    }

    // ── Klavye kısayolları ────────────────────────────────────────
    // Odak çoğu zaman bir modül çerçevesinin içindedir; keydown üst pencereye
    // kabarmaz. Bu yüzden her çerçevenin penceresine de bağlanır (createFrame).
    // İşleyici true dönerse olay tüketilir.
    var keyHandlers = [];
    function isTyping(t) {
        if (!t || !t.tagName) return false;
        var tag = t.tagName.toLowerCase();
        if (tag === 'textarea' || tag === 'select' || t.isContentEditable) return true;
        if (tag !== 'input') return false;
        var ty = (t.type || 'text').toLowerCase();
        return ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].indexOf(ty) === -1;
    }
    function onKey(e) {
        if (e.defaultPrevented || e.isComposing) return;
        if (document.documentElement.classList.contains('hz-locked')) return;   // kilitliyken kısayol yok
        var typing = isTyping(e.target);
        for (var i = 0; i < keyHandlers.length; i++) {
            if (keyHandlers[i](e, typing) === true) { e.preventDefault(); e.stopPropagation(); return; }
        }
    }
    window.addEventListener('keydown', onKey, true);

    // Kullanıcı etkinliği (dokunuş, tuş, kaydırma) — ekran kilidi bunu dinler.
    var activityFns = [];
    function activity() { for (var i = 0; i < activityFns.length; i++) { try { activityFns[i](); } catch (e) {} } }
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (t) { window.addEventListener(t, activity, { passive: true, capture: true }); });

    // Diğer kabuk betikleri (genel arama, kısayollar…) için küçük arayüz.
    window.Shell = {
        onActivity: function (fn) { activityFns.push(fn); },
        frames: function () { return Object.keys(frames).map(function (r) { return frames[r]; }); },
        navigate: navigate,
        route: function () { return currentRoute; },
        frame: function (r) { return frames[r || currentRoute] || null; },
        ctx: CTX,
        addKeyHandler: function (fn) { keyHandlers.push(fn); }
    };

    // ── Mobil alt sekme çubuğu ────────────────────────────────────
    // Hamburger çekmecesinde en sık gidilen yerler iki dokunuş uzakta ve
    // ekranın üstündeydi; personel telefonda tek elle çalışıyor. Başparmak
    // bölgesine role göre en sık 4 hedef + "Menü" (çekmeceyi açar; Ayarlar
    // vb. orada). Kapalı modüller atlanır. Klavye açıkken gizlenir. F&B
    // girişinde (yalnızca Restoran + Raporlar, POS ekranı) gösterilmez.
    var BT_LABEL = { dashboard: 'Panel', kayitlar: 'Kayıtlar', concierge: 'Concierge', crm: 'CRM', raporlar: 'Raporlar', '@orders': 'QR Talepler', '@search': 'Ara' };
    function buildBottomBar() {
        var bar = $('shBottom');
        if (!bar || CTX === 'fnb') return;
        var order = isManagerRole()
            ? ['dashboard', 'kayitlar', 'concierge', '@orders', '@search', 'crm', 'raporlar']
            : ['kayitlar', '@orders', '@search', 'concierge', 'crm', 'raporlar', 'dashboard'];
        var ordersOn = typeof moduleEnabled !== 'function' || moduleEnabled('guestOrders');
        var picks = order.filter(function (k) {
            if (k === '@orders') return ordersOn && (moduleOn('concierge') || moduleOn('guestIssues'));
            if (k === '@search') return true;
            var d = ROUTES[k];
            return d && moduleOn(d.module) && ctxAllows(k);
        }).slice(0, 4);
        function svgOf(sel) { var el = document.querySelector(sel + ' svg'); return el ? el.outerHTML : ''; }
        var html = picks.map(function (k) {
            var svg = k === '@orders' ? svgOf('.sh-dr.sh-orders') : (k === '@search' ? svgOf('#shSearchBtn') : svgOf('.sh-dr[data-route="' + k + '"]'));
            var attr = k.charAt(0) === '@' ? 'data-bt="' + k.slice(1) + '"' : 'data-route="' + k + '"';
            return '<button class="sh-bt" ' + attr + '>' + svg + '<span>' + BT_LABEL[k] + '</span></button>';
        }).join('') + '<button class="sh-bt" data-bt="menu" aria-expanded="false">' + svgOf('#shMenuBtn') + '<span>Menü</span></button>';
        bar.innerHTML = html;
        document.querySelector('.sh-app').classList.add('has-bottom');
        // Başlıktaki arama simgesi yalnızca çubukta "Ara" varsa gizlenir
        // (yönetici çubuğunda yok — arama başlıkta kalmalı).
        document.querySelector('.sh-app').classList.toggle('has-bottom-search', picks.indexOf('@search') !== -1);
        bar.addEventListener('click', function (e) {
            var b = e.target.closest('.sh-bt');
            if (!b) return;
            var r = b.getAttribute('data-route'), a = b.getAttribute('data-bt');
            if (r) { setDrawer(false); navigate(r); }
            else if (a === 'orders') { setDrawer(false); openOrders(); }
            else if (a === 'search') { setDrawer(false); if (window.ShellSearch) ShellSearch.open(''); }
            else if (a === 'menu') setDrawer(!drawer.classList.contains('show'));
        });
        // Klavye açıkken (yazı alanı odakta) çubuk içeriğin önüne geçmesin.
        if (window.visualViewport) {
            var kb = function () {
                var open = window.visualViewport.height < window.innerHeight * 0.78;
                document.querySelector('.sh-app').classList.toggle('kb-open', open);
            };
            window.visualViewport.addEventListener('resize', kb);
        }
        if (currentRoute) setActive(currentRoute);
    }

    // Header
    function init() {
        applyContext();
        var name = USERNAME ? (USERNAME.charAt(0).toUpperCase() + USERNAME.slice(1)) : 'Ekip';
        $('shUser').textContent = name;
        $('shRole').textContent = ROLE ? (ROLE.charAt(0).toUpperCase() + ROLE.slice(1)) : 'Personel';
        $('shAvatar').textContent = (USERNAME.slice(0, 2) || '··').toUpperCase();
        if (ROLE === 'admin' || USERNAME.toLowerCase() === 'admin') {
            var a = $('shAdmin'); if (a) a.style.display = '';
            var am = $('shAdminMob'); if (am) am.style.display = '';   // mobil çekmecedeki karşılığı
        }
        if (typeof moduleEnabled === 'function' && !moduleEnabled('guestOrders')) {
            document.querySelectorAll('.sh-orders').forEach(function (el) { el.style.display = 'none'; });
        }
        // Çıkış artık profil menüsünde (yanlışlıkla basılan başlık düğmesi kalktı).
        $('shLogout').onclick = function () { this.disabled = true; hotelSignOut('login'); };
        buildBottomBar();
        fromHash();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
