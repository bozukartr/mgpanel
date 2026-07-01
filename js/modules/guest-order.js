/* StayOS — Misafir Hizmetleri (guest-order.html)
 *
 * QR ile açılan, giriş gerektirmeyen mobil-uygulama deneyimi:
 *   Ana Sayfa (selamlama + otel bilgi carousel'i + hizmet kategorileri),
 *   Hizmetler (arama + kategori + sepete ekleme),
 *   Sepet (not/saat + gönderim),
 *   Taleplerim (canlı durum takibi).
 *
 * İzolasyon: misafir, AYRI bir Firebase app ('guest') ile anonim oturum açar;
 * bu app ad bazında ayrıldığından personelin paylaşılan oturumuna dokunmaz,
 * LOCAL persistence sayesinde anonim uid yeniden yüklemede sabit kalır (talep
 * geçmişi korunur). Misafir adı, soyadı doğrulandıktan sonra güvenli bir
 * Cloud Function (getGuestName) ile getirilir; guestDirectory anonim okunmaz.
 *
 * DEMO modu (?demo): tamamen istemci tarafında, Firebase'siz çalışır.
 */
(function () {
    'use strict';

    // ── İzole Firebase app ─────────────────────────────────────
    let auth, db, fns;
    (function initGuestApp() {
        if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') return;
        try {
            let app;
            try { app = firebase.app('guest'); }
            catch (e) { app = firebase.initializeApp(firebaseConfig, 'guest'); }
            auth = app.auth();
            try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) {}
            db = app.firestore();
            try { fns = app.functions('us-central1'); } catch (e) { fns = null; }
        } catch (e) { /* firebase yüklenemedi → aşağıdaki guard */ }
    })();

    // ── Tenant + oda ───────────────────────────────────────────
    const TENANT = (typeof resolveTenant === 'function' ? resolveTenant() : 'mgallery');
    const params = new URLSearchParams(location.search);
    let ROOM = (params.get('room') || params.get('oda') || '').trim().slice(0, 40);
    const DEMO = params.has('demo');

    let CART_KEY, VERIFY_KEY, GUEST_KEY, SURNAME_KEY, COOLDOWN_KEY;
    function recomputeKeys() {
        const r = ROOM || 'x';
        CART_KEY = `go2_cart_${TENANT}_${r}`;
        VERIFY_KEY = `go2_verify_${TENANT}_${r}`;
        GUEST_KEY = `go2_guest_${TENANT}_${r}`;
        SURNAME_KEY = `go2_surname_${TENANT}_${r}`;
        COOLDOWN_KEY = `go2_cd_${TENANT}_${r}`;
    }
    recomputeKeys();

    const MAX_DISTINCT = 20, MAX_QTY = 10, COOLDOWN_MS = 60 * 1000;

    // ── Config ─────────────────────────────────────────────────
    const DEFAULT_CONFIG = {
        hotelName: '', showPrices: false, currency: '₺', requireVerification: false,
        welcome: '', phone: '', wifiName: '', wifiPass: '', checkoutTime: '', breakfast: '', address: '', heroImage: ''
    };
    const DEMO_CONFIG = {
        hotelName: 'Grand Demo Otel', showPrices: true, currency: '₺', requireVerification: true,
        heroImage: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1100&q=80',
        welcome: 'Konaklamanızın keyfini çıkarın — ihtiyacınız olan her şey bir dokunuş uzağınızda.',
        phone: '0 (212) 000 00 00', wifiName: 'GrandDemo-Guest', wifiPass: 'demo2024',
        checkoutTime: '12:00', breakfast: '07:00 – 10:30 · Lobi Restoran', address: 'Sahil Cad. No:1, İstanbul'
    };
    let config = Object.assign({}, DEFAULT_CONFIG);

    const DEMO_CATALOG = [
        { category: 'Kat Hizmetleri', name: 'Oda Temizliği', icon: '🧹', eta: '30-45 dk', maxQty: 1, department: 'Housekeeping', availFrom: '09:00', availTo: '16:00' },
        { category: 'Kat Hizmetleri', name: 'Havlu Değişimi', icon: '🧺', eta: '15-30 dk', department: 'Housekeeping' },
        { category: 'Kat Hizmetleri', name: 'Çarşaf Değişimi', icon: '🛏️', eta: '30-45 dk', maxQty: 1, department: 'Housekeeping' },
        { category: 'Kat Hizmetleri', name: 'Banyo Malzemeleri', icon: '🧴', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Ekstra Yastık', icon: '🛏️', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Ekstra Battaniye', icon: '🧣', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Terlik', icon: '🥿', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Oda Servisi', name: 'Su', icon: '💧', eta: '15 dk', department: 'Food & Beverage' },
        { category: 'Oda Servisi', name: 'Çay / Kahve', icon: '☕', eta: '15-20 dk', price: 60, department: 'Food & Beverage' },
        { category: 'Oda Servisi', name: 'Meyve Tabağı', icon: '🍎', eta: '20-30 dk', price: 120, department: 'Food & Beverage' },
        { category: 'Oda Servisi', name: 'Atıştırmalık', icon: '🍫', eta: '20 dk', price: 80, department: 'Food & Beverage' },
        { category: 'Teknik', name: 'Klima Sorunu', icon: '❄️', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'TV Sorunu', icon: '📺', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Wi-Fi Sorunu', icon: '📶', eta: '20 dk', department: 'Engineering' },
        { category: 'Resepsiyon', name: 'Uyandırma Servisi', icon: '⏰', eta: '—', department: 'Front Office' },
        { category: 'Resepsiyon', name: 'Taksi Çağır', icon: '🚕', eta: '10 dk', department: 'Front Office' }
    ].map((d, i) => Object.assign({ id: 'demo-' + i, active: true, sortOrder: (i + 1) * 10 }, d));

    const STATUS = {
        pending:     { label: 'Bekliyor',     emoji: '⏳', sub: 'Talebiniz personelimize iletildi.' },
        confirmed:   { label: 'Onaylandı',    emoji: '✅', sub: 'Talebiniz onaylandı, hazırlanıyor.' },
        in_progress: { label: 'İşlemde',      emoji: '🛎️', sub: 'Ekibimiz talebinizi hazırlıyor.' },
        completed:   { label: 'Tamamlandı',   emoji: '🎉', sub: 'Talebiniz tamamlandı. Teşekkürler!' },
        cancelled:   { label: 'İptal Edildi', emoji: '✖️', sub: 'Bu talep iptal edildi.' }
    };
    const FLOW = ['pending', 'confirmed', 'in_progress', 'completed'];

    // ── State ──────────────────────────────────────────────────
    let catalog = [], cart = [], sessionUid = null;
    let myOrders = [], ordersUnsub = null, lastStatusMap = {};
    let activeCat = 'all', searchTerm = '', currentTab = 'home';
    let trackingId = null, guestName = '';
    let demoTimer = null;

    // ── Helpers ────────────────────────────────────────────────
    const $ = id => document.getElementById(id);
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function svg(inner, size) {
        return `<svg viewBox="0 0 24 24" width="${size || 22}" height="${size || 22}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    }
    let toastTimer = null;
    function toast(msg, isError) {
        const t = $('goToast');
        t.textContent = msg;
        t.className = 'go-toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.className = 'go-toast'; }, 2800);
        try { if (isError) navigator.vibrate && navigator.vibrate(70); } catch (e) {}
    }
    function buzz(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }

    // Ad normalizasyonu — room-access.js ile birebir aynı kalmalı.
    function norm(s) {
        return String(s == null ? '' : s).trim().toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's')
            .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o')
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
    }
    function nameTokens(name) { return norm(name).split(/\s+/).filter(t => t.length >= 2); }
    async function sha16(str) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }

    // ── Kategori → ikon / renk ─────────────────────────────────
    function catKind(cat) {
        const c = String(cat || '').toLowerCase();
        if (/temiz|housekeep|clean|kat hizmet|oda temiz/.test(c)) return 'temiz';
        if (/konfor|comfort|amenit|buklet/.test(c)) return 'konfor';
        if (/yiyecek|içecek|icecek|food|beverage|restoran|minibar|mini bar|oda servis|room service|kahvalt|bar/.test(c)) return 'food';
        if (/teknik|tech|engineer|ariza|arıza|maintenance|tamir/.test(c)) return 'teknik';
        if (/resepsiyon|front|concierge|konsiyerj|karşılama|danışma/.test(c)) return 'bell';
        return 'other';
    }
    const CAT_ICON = {
        temiz: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
        konfor: '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
        food: '<path d="M3 2v7c0 1.1.9 2 2 2a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
        teknik: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
        bell: '<path d="M3 20h18"/><path d="M6 20a6 6 0 0 1 12 0"/><path d="M12 4v3"/><path d="M10 4h4"/>',
        other: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>'
    };
    const catIcon = (cat, size) => svg(CAT_ICON[catKind(cat)] || CAT_ICON.other, size);
    const CARD_PALETTE = [
        'linear-gradient(150deg,#33574a,#244236)',
        'linear-gradient(150deg,#8a7d63,#6f6450)',
        'linear-gradient(150deg,#33485c,#283848)',
        'linear-gradient(150deg,#7a5a44,#5b4332)',
        'linear-gradient(150deg,#4d6155,#3a4940)',
        'linear-gradient(150deg,#5c5470,#433f57)'
    ];
    const CAT_BLURB = {
        bell: 'İhtiyacınız olan her konuda yanınızdayız.',
        temiz: 'Temizlik, havlu, buklet ve daha fazlası.',
        konfor: 'Konaklamanızı keyifli kılan detaylar.',
        food: 'Yiyecek ve içecek siparişleriniz.',
        teknik: 'Teknik sorunları hızla çözelim.'
    };
    const catBlurb = cat => CAT_BLURB[catKind(cat)] || '';

    // ── Cart persistence ───────────────────────────────────────
    function loadCart() {
        try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
        if (!Array.isArray(cart)) cart = [];
    }
    function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {} }
    const cartCount = () => cart.reduce((n, l) => n + (l.qty || 0), 0);

    // ── Verification / guest name ──────────────────────────────
    function isVerified() {
        if (!ROOM) return false;
        try { return (parseInt(localStorage.getItem(VERIFY_KEY) || '0', 10)) > Date.now(); } catch (e) { return false; }
    }
    function setVerified() { try { localStorage.setItem(VERIFY_KEY, String(Date.now() + 12 * 3600 * 1000)); } catch (e) {} }
    function loadGuestName() { try { guestName = localStorage.getItem(GUEST_KEY) || ''; } catch (e) { guestName = ''; } }
    function setGuestName(n) {
        guestName = String(n || '').trim();
        try { guestName ? localStorage.setItem(GUEST_KEY, guestName) : localStorage.removeItem(GUEST_KEY); } catch (e) {}
    }
    // Doğrulamada girilen soyadı saklanır — Folio gibi sonradan sunucu-taraflı
    // yeniden doğrulama gerektiren çağrılarda (getRoomFolio) tekrar kullanılır.
    function loadSurname() { try { return localStorage.getItem(SURNAME_KEY) || ''; } catch (e) { return ''; } }
    function setSurname(s) {
        s = String(s || '').trim();
        try { s ? localStorage.setItem(SURNAME_KEY, s) : localStorage.removeItem(SURNAME_KEY); } catch (e) {}
    }

    // ── Price ──────────────────────────────────────────────────
    function priceOf(it) { const p = Number(it && it.price) || 0; return p > 0 ? p : 0; }
    function pricesOn() { return !!config.showPrices; }
    function fmtPrice(n) { return config.currency + Number(n || 0).toLocaleString('tr-TR'); }
    function cartTotal() { return cart.reduce((s, l) => s + priceOf(l) * (l.qty || 0), 0); }

    function categories() {
        const seen = [];
        catalog.forEach(i => { const c = (i.category || 'Diğer').trim(); if (!seen.includes(c)) seen.push(c); });
        return seen;
    }
    function catCount(c) { return catalog.filter(i => (i.category || 'Diğer') === c).length; }

    // Availability window (HH:MM). Empty = always available.
    function availInfo(item) {
        const f = (item && item.availFrom || '').trim(), t = (item && item.availTo || '').trim();
        if (!f || !t) return { limited: false, available: true, window: '' };
        const toMin = s => { const p = String(s).split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); };
        const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
        const fm = toMin(f), tm = toMin(t);
        const ok = (fm <= tm) ? (nm >= fm && nm < tm) : (nm >= fm || nm < tm);
        return { limited: true, available: ok, window: f + '–' + t };
    }

    // ════════════════════════════════════════════════════════════
    //  BOOT
    // ════════════════════════════════════════════════════════════
    function boot() {
        loadCart(); loadGuestName();
        wireShell();
        renderCartUI();

        if (DEMO) {
            sessionUid = 'demo-' + (localStorage.getItem('go2_demo_uid') || (function () { const v = Math.random().toString(36).slice(2); try { localStorage.setItem('go2_demo_uid', v); } catch (e) {} return v; })());
            config = Object.assign({}, DEFAULT_CONFIG, DEMO_CONFIG);
            catalog = DEMO_CATALOG.slice();
            applyConfig();
            renderAll();
            loadDemoOrders();
            maybeGate();
            return;
        }

        applyConfig();
        let started = false;
        auth.onAuthStateChanged(u => { if (u && !started) { started = true; sessionUid = u.uid; loadData(); listenOrders(); } });
        auth.signInAnonymously().catch(err => {
            console.error('Anon sign-in failed', err);
            toast('Bağlantı kurulamadı. ?demo ile test edebilirsiniz.', true);
        });
    }

    function loadData() {
        Promise.all([fetchConfig(), fetchCatalog()]).then(() => { applyConfig(); renderAll(); maybeGate(); });
    }
    function fetchConfig() {
        return db.collection('guestConfig').doc(TENANT).get()
            .then(doc => { if (doc.exists) config = Object.assign({}, DEFAULT_CONFIG, doc.data()); })
            .catch(() => {});
    }
    function fetchCatalog() {
        return db.collection('requestCatalog').where('tenantId', '==', TENANT).get()
            .then(snap => {
                catalog = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                    .filter(i => i.active !== false)
                    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || '', 'tr'));
            })
            .catch(err => { console.error('catalog load failed', err); catalog = []; });
    }

    // ── Config → görünüm ───────────────────────────────────────
    function prettyTenant(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'StayOS'; }
    function applyConfig() {
        $('goApp').setAttribute('aria-busy', 'false');
        renderGreeting();
        renderHome();
        renderProfile();
        renderChat();
    }
    function timeGreeting() {
        const h = new Date().getHours();
        if (h < 6) return 'İyi geceler,';
        if (h < 12) return 'Günaydın,';
        if (h < 18) return 'İyi günler,';
        return 'İyi akşamlar,';
    }
    function firstName() {
        const n = (guestName || '').trim();
        return n ? n.split(/\s+/)[0] : 'Misafirimiz';
    }
    function renderGreeting() {
        const t = $('goGreetTime'); if (t) t.textContent = timeGreeting();
        const gn = $('goGuestName'); if (gn) gn.textContent = firstName();
    }

    // ════════════════════════════════════════════════════════════
    //  TAB NAV
    // ════════════════════════════════════════════════════════════
    const SCREENS = { home: 'scHome', services: 'scServices', cart: 'scCart', orders: 'scOrders', chat: 'scChat', profile: 'scProfile' };
    function showTab(name, opts) {
        opts = opts || {};
        currentTab = name;
        Object.keys(SCREENS).forEach(k => { const el = $(SCREENS[k]); if (el) el.classList.toggle('go-hidden', k !== name); });
        // services/cart alt akışları "home" sekmesini vurgular.
        const navName = (name === 'services' || name === 'cart') ? 'home' : name;
        document.querySelectorAll('.go-nav-b').forEach(b => b.classList.toggle('active', b.dataset.go === navName));
        if (name === 'home') renderHome();
        if (name === 'services') renderServices();
        if (name === 'cart') renderCart();
        if (name === 'orders' && !opts.keepTrack) showOrderList();
        if (name === 'chat') renderChat();
        if (name === 'profile') renderProfile();
        updateCartPill();
        const sc = $(SCREENS[name]);
        if (sc && !opts.keepScroll) { sc.scrollTop = 0; const inner = sc.querySelector('.go-scroll'); if (inner) inner.scrollTop = 0; }
    }

    // ════════════════════════════════════════════════════════════
    //  ANA SAYFA
    // ════════════════════════════════════════════════════════════
    function renderAll() { renderHome(); renderProfile(); renderChat(); renderCartUI(); }

    function renderHome() {
        renderGreeting();
        renderCarousel();
        renderCats();
        renderQuick();
        const dot = $('goBellDot'); if (dot) dot.hidden = !activeOrder();
    }

    // Konum bazlı renkler (görsel yoksa fallback) + kategori türüne göre ikon.
    const CARD_COLORS = ['#1f3a5c', '#34703f', '#bf8b2e', '#5c5470', '#7a5a44'];
    // Kategori türüne göre arka plan görseli (otel kökünden servis edilir).
    // Görsel yüklenemezse altındaki renk + karartma görünür (graceful fallback).
    const CARD_IMG = {
        temiz: 'housekeeping_button.png',
        konfor: 'housekeeping_button.png',
        bell: 'frontoffice_button.png',
        food: 'fnb_button.png'
    };
    const CARD_KIND_ICON = {
        bell: '<path d="M4 12a8 8 0 0 1 16 0"/><line x1="2.5" y1="12" x2="21.5" y2="12"/><line x1="12" y1="5.4" x2="12" y2="3.2"/>',
        temiz: '<path d="M3 10.6 12 3l9 7.6"/><path d="M5.6 9.3V20a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V9.3"/>',
        konfor: '<path d="M2 7v11"/><path d="M2 11h15a4 4 0 0 1 4 4v3"/><path d="M2 18h20"/><path d="M6.5 11V9"/>',
        food: '<path d="M3 18h18"/><path d="M5.2 18a6.8 6.8 0 0 1 13.6 0"/><line x1="12" y1="4.6" x2="12" y2="7.4"/>',
        teknik: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.3 6.3a2.1 2.1 0 0 1-3-3l6.3-6.3a6 6 0 0 1 7.9-7.9l-3.1 3.1z"/>',
        other: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>'
    };
    function card3Icon(cat, size) { return svg(CARD_KIND_ICON[catKind(cat)] || CARD_KIND_ICON.other, size); }
    function renderCats() {
        const wrap = $('goCats'); if (!wrap) return;
        const cats = categories();
        if (!cats.length) {
            wrap.innerHTML = `<div class="go-empty" style="grid-column:1/-1"><div class="go-empty-ic">🛎️</div><h3>Hizmet yok</h3><p>Bu otel için talepler henüz hazır değil.</p></div>`;
            return;
        }
        wrap.innerHTML = cats.slice(0, 3).map((c, i) => {
            const color = CARD_COLORS[i % CARD_COLORS.length];
            const img = CARD_IMG[catKind(c)];
            const style = img
                ? `background-color:${color};background-image:linear-gradient(180deg,rgba(16,24,36,.20),rgba(16,24,36,.66)),url('${img}');background-size:cover;background-position:center;`
                : `background:${color};`;
            return `<button class="go-card3" data-cat="${esc(c)}" style="${style}">
                <span class="go-card3-tx">${esc(c)}</span>
            </button>`;
        }).join('');
        wrap.onclick = e => {
            const b = e.target.closest('[data-cat]'); if (!b) return;
            activeCat = b.dataset.cat; searchTerm = '';
            const sx = $('goSearch'); if (sx) sx.value = '';
            const xx = $('goSearchX'); if (xx) xx.hidden = true;
            showTab('services');
        };
    }
    function renderQuick() {
        const wrap = $('goQuick'), sec = $('goQaSec'); if (!wrap) return;
        const items = catalog.slice(0, 2);
        if (!items.length) { if (sec) sec.style.display = 'none'; wrap.innerHTML = ''; return; }
        if (sec) sec.style.display = '';
        wrap.innerHTML = items.map(it => `
            <button class="go-qtile" data-quick="${esc(it.id)}">
                <span class="go-qtile-ic">${catIcon(it.category, 32)}</span>
                <span class="go-qtile-tx">${esc(it.name)}</span>
            </button>`).join('');
        wrap.onclick = e => { const b = e.target.closest('[data-quick]'); if (b) changeQty(b.dataset.quick, +1); };
    }
    function renderActiveBanner() { /* ana sayfada banner kaldırıldı; zil noktası + Taleplerim rozeti kullanılıyor */ }

    // ── Sohbet (Chat) ───────────────────────────────────────────
    function renderChat() {
        const wrap = $('goChatBody'); if (!wrap) return;
        const phone = (config.phone || '').replace(/[^0-9+]/g, '');
        wrap.innerHTML = `
            <div class="go-chat-hero">
                <div class="go-chat-emoji">💬</div>
                <h2>Size nasıl yardımcı olabiliriz?</h2>
                <p>Resepsiyon ekibimiz hizmetinizde. Aşağıdan ulaşın ya da hızlıca bir talep oluşturun.</p>
            </div>
            ${phone ? `<a class="go-cta go-cta-block" href="tel:${esc(phone)}">${svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>', 18)} Resepsiyonu Ara</a>` : ''}
            <button class="go-btn-ghost" id="goChatNew">Yeni Talep Oluştur</button>`;
        const nb = $('goChatNew'); if (nb) nb.onclick = () => { activeCat = 'all'; showTab('services'); };
    }

    // ── Profil ──────────────────────────────────────────────────
    function renderProfile() {
        const wrap = $('goProfileBody'); if (!wrap) return;
        const hname = (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT);
        const rows = [
            infoRow('phone', 'Resepsiyon', config.phone, { tel: (config.phone || '').replace(/[^0-9+]/g, '') }),
            infoRow('wifi', 'Wi-Fi ağı', config.wifiName, { copy: config.wifiName }),
            infoRow('wifi', 'Wi-Fi şifresi', config.wifiPass, { copy: config.wifiPass }),
            infoRow('clock', 'Check-out', config.checkoutTime),
            infoRow('coffee', 'Kahvaltı', config.breakfast),
            infoRow('pin', 'Adres', config.address, { map: config.address })
        ].filter(Boolean).join('');
        const initial = (firstName().charAt(0) || 'M').toLocaleUpperCase('tr-TR');
        wrap.innerHTML = `
            <div class="go-prof-card">
                <div class="go-prof-av">${esc(initial)}</div>
                <div class="go-prof-name">${esc(guestName || 'Değerli Misafirimiz')}</div>
                <div class="go-prof-sub">${ROOM ? 'Oda ' + esc(ROOM) + ' · ' : ''}${esc(hname)}${DEMO ? ' · DEMO' : ''}</div>
            </div>
            ${config.welcome && config.welcome.trim() ? `<p class="go-prof-welcome">${esc(config.welcome.trim())}</p>` : ''}
            <div class="go-prof-sec">Otel Bilgileri</div>
            ${rows || '<div class="go-empty"><div class="go-empty-ic">ℹ️</div><h3>Bilgi yok</h3><p>Henüz otel bilgisi eklenmemiş.</p></div>'}`;
        wrap.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { try { navigator.clipboard.writeText(b.dataset.copy); toast('Kopyalandı'); } catch (e) {} });
    }

    // ── Otel bilgileri carousel ────────────────────────────────
    const INFO_ICONS = {
        wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
        phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
        clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
        coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
        pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
        food: '<path d="M3 2v7c0 1.1.9 2 2 2a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
        folio: '<path d="M6 2h9l3 3v17l-3-2-3 2-3-2-3 2V5a3 3 0 0 1 3-3z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/>'
    };
    const INFO_GRAD = ['linear-gradient(145deg,#2f5346,#1f3a30)', 'linear-gradient(145deg,#33485c,#26384a)', 'linear-gradient(145deg,#7a5a44,#5a4131)', 'linear-gradient(145deg,#8a7d63,#6c6049)', 'linear-gradient(145deg,#4f6155,#39473e)', 'linear-gradient(145deg,#5c5470,#433f57)'];
    let folioData = null;      // { total, count, items } — son başarılı getRoomFolio yanıtı
    let folioFetchedAt = 0;    // throttle: Home sekmesine her dönüşte yeniden sorgulamamak için

    // Katalogda F&B/oda servisi niteliğindeki ilk kategoriyi bulur (catKind ile
    // esnek eşleşir: "Oda Servisi", "Yiyecek & İçecek", "Room Service" vb.).
    function roomServiceCategory() {
        const cats = [...new Set((catalog || []).map(i => i.category || '').filter(Boolean))];
        return cats.find(c => catKind(c) === 'food') || '';
    }
    function infoCards() {
        const cards = [];
        if (config.wifiName || config.wifiPass)
            cards.push({ ic: 'wifi', kicker: 'Wi-Fi', val: config.wifiName || 'Wi-Fi', sub: config.wifiPass ? 'Şifre: ' + config.wifiPass : '', copy: config.wifiPass || config.wifiName });
        if (config.breakfast)
            cards.push({ ic: 'coffee', kicker: 'Kahvaltı', val: config.breakfast });
        const roomSvcCat = roomServiceCategory();
        if (roomSvcCat)
            cards.push({ ic: 'food', kicker: 'Oda Servisi', val: roomSvcCat, sub: 'Menüyü görüntüleyin', nav: roomSvcCat });
        if (config.checkoutTime)
            cards.push({ ic: 'clock', kicker: 'Check-out', val: config.checkoutTime, sub: 'Çıkış saati' });
        if (config.phone)
            cards.push({ ic: 'phone', kicker: 'Resepsiyon', val: config.phone, tel: config.phone.replace(/[^0-9+]/g, '') });
        if (config.address)
            cards.push({ ic: 'pin', kicker: 'Adres', val: config.address, map: config.address });
        if (folioData && folioData.total > 0)
            cards.push({ ic: 'folio', kicker: 'Oda Hesabım', val: fmtPrice(folioData.total), sub: folioData.count + ' kalem · detay için dokunun', folio: true });
        return cards;
    }
    function renderCarouselCards(cards) {
        const wrap = $('goCarousel'), dots = $('goDots'); if (!wrap) return;
        const sec = $('goInfoSec');
        const showInfo = cards.length > 0;
        if (sec) sec.style.display = showInfo ? '' : 'none';
        if (!showInfo) { wrap.innerHTML = ''; if (dots) dots.innerHTML = ''; return; }
        wrap.innerHTML = cards.map((c, i) => {
            let act = '';
            if (c.tel) act = `<a class="go-info-act" href="tel:${esc(c.tel)}">Ara</a>`;
            else if (c.map) act = `<a class="go-info-act" href="https://maps.google.com/?q=${encodeURIComponent(c.map)}" target="_blank" rel="noopener">Haritada Aç</a>`;
            else if (c.copy) act = `<button class="go-info-act" data-copy="${esc(c.copy)}">Kopyala</button>`;
            else if (c.nav) act = `<button class="go-info-act" data-nav="${esc(c.nav)}">Menüyü Gör</button>`;
            else if (c.folio) act = `<button class="go-info-act" data-folio="1">Detayı Gör</button>`;
            return `<div class="go-info-card" style="background:${INFO_GRAD[i % INFO_GRAD.length]}">
                <div class="go-info-top"><span class="go-info-ic">${svg(INFO_ICONS[c.ic] || INFO_ICONS.pin, 23)}</span><span class="go-info-kicker">${esc(c.kicker)}</span></div>
                <div class="go-info-main"><div class="go-info-val">${esc(c.val)}</div>${c.sub ? `<div class="go-info-sub">${esc(c.sub)}</div>` : ''}</div>
                ${act}</div>`;
        }).join('');
        if (dots) dots.innerHTML = cards.map((_, i) => `<span class="go-dot ${i === 0 ? 'active' : ''}"></span>`).join('');
        wrap.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { try { navigator.clipboard.writeText(b.dataset.copy); toast('Kopyalandı'); } catch (e) {} });
        wrap.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
            activeCat = b.dataset.nav; searchTerm = ''; showTab('services');
            const a = document.querySelector('#goChips .go-chip.active');
            if (a) a.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        });
        wrap.querySelectorAll('[data-folio]').forEach(b => b.onclick = openFolio);
        wrap.onscroll = () => {
            if (!dots) return;
            const card = wrap.querySelector('.go-info-card'); if (!card) return;
            const w = card.offsetWidth + 14;
            const idx = Math.round(wrap.scrollLeft / w);
            dots.querySelectorAll('.go-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
        };
    }
    // Senkron kartlar hemen çizilir (WiFi/kahvaltı/oda servisi/checkout/telefon/
    // adres — hiçbiri ağ çağrısı gerektirmez). Folio, misafir daha önce soyadı ile
    // doğrulandıysa (SURNAME_KEY dolu) sunucu üzerinden ayrıca sorgulanır; sonuç
    // gelince kart listesine eklenip carousel yeniden çizilir. 30 sn throttle ile
    // Home sekmesine her dönüşte gereksiz Cloud Function çağrısı önlenir.
    async function renderCarousel() {
        renderCarouselCards(infoCards());
        const surname = loadSurname();
        if (!fns || !ROOM || !surname) return;
        if (Date.now() - folioFetchedAt < 30000) return;
        folioFetchedAt = Date.now();
        try {
            const res = await fns.httpsCallable('getRoomFolio')({ tenant: TENANT, room: ROOM, surname });
            folioData = (res && res.data && res.data.ok) ? res.data : null;
        } catch (e) { folioData = null; }
        renderCarouselCards(infoCards());
    }
    function folioRow(it) {
        const meta = [it.tableName || '', it.createdAt ? new Date(it.createdAt).toLocaleDateString('tr-TR') : ''].filter(Boolean).join(' · ');
        return `<div class="go-folio-row">
            <div class="go-folio-row-tx"><div class="go-folio-row-src">${esc(it.source === 'restaurant' ? 'Restoran / Bar' : (it.source || 'Oda Hesabı'))}</div>${meta ? `<div class="go-folio-row-meta">${esc(meta)}</div>` : ''}</div>
            <div class="go-folio-row-amt">${esc(fmtPrice(it.amount))}</div></div>`;
    }
    function openFolio() {
        const body = $('goFolioBody'); if (!body || !folioData) return;
        const rows = (folioData.items || []).map(folioRow).join('');
        body.innerHTML = `${rows || '<div class="go-empty"><div class="go-empty-ic">🧾</div><h3>Kalem yok</h3></div>'}
            <div class="go-folio-total"><b>Toplam</b><span>${esc(fmtPrice(folioData.total))}</span></div>`;
        $('goFolioBackdrop').classList.add('show');
        $('goFolioSheet').classList.add('show');
        $('goFolioSheet').setAttribute('aria-hidden', 'false');
    }
    function closeFolio() {
        $('goFolioBackdrop').classList.remove('show');
        $('goFolioSheet').classList.remove('show');
        $('goFolioSheet').setAttribute('aria-hidden', 'true');
    }

    // ════════════════════════════════════════════════════════════
    //  HİZMETLER
    // ════════════════════════════════════════════════════════════
    function renderServices() {
        const chips = $('goChips'); if (!chips) return;
        const cats = categories();
        if (activeCat !== 'all' && !cats.includes(activeCat)) activeCat = 'all';
        chips.innerHTML = [`<button class="go-chip ${activeCat === 'all' ? 'active' : ''}" data-chip="all">Tümü</button>`]
            .concat(cats.map(c => `<button class="go-chip ${activeCat === c ? 'active' : ''}" data-chip="${esc(c)}"><span class="go-chip-ic">${catIcon(c, 18)}</span>${esc(c)}</button>`)).join('');
        chips.onclick = e => { const b = e.target.closest('[data-chip]'); if (!b) return; activeCat = b.dataset.chip; renderServices(); const a = chips.querySelector('.go-chip.active'); if (a) a.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); };
        renderItems();
    }
    function filteredItems() {
        const term = norm(searchTerm);
        return catalog.filter(i => {
            if (activeCat !== 'all' && (i.category || 'Diğer') !== activeCat) return false;
            if (term) { const hay = norm((i.name || '') + ' ' + (i.category || '') + ' ' + (i.description || '')); if (!hay.includes(term)) return false; }
            return true;
        });
    }
    function renderItems() {
        const wrap = $('goItems'); if (!wrap) return;
        const items = filteredItems();
        if (!items.length) {
            wrap.innerHTML = `<div class="go-empty"><div class="go-empty-ic">🔍</div><h3>Sonuç yok</h3><p>${searchTerm ? 'Aramanızla eşleşen hizmet bulunamadı.' : 'Bu kategoride hizmet yok.'}</p></div>`;
            return;
        }
        // group by category when "all" and no search
        let html = '';
        if (activeCat === 'all' && !searchTerm) {
            categories().forEach(c => {
                const sub = items.filter(i => (i.category || 'Diğer') === c);
                if (!sub.length) return;
                html += `<div class="go-cat-head">${esc(c)}</div>` + sub.map(itemHtml).join('');
            });
        } else {
            html = items.map(itemHtml).join('');
        }
        wrap.innerHTML = html;
        bindItemEvents(wrap);
    }
    function itemHtml(item) {
        const av = availInfo(item);
        const tags = [];
        if (item.eta && item.eta !== '—') tags.push(`<span class="go-tag">${svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 13)}${esc(item.eta)}</span>`);
        if (av.limited) tags.push(`<span class="go-tag ${av.available ? '' : 'off'}">🕒 ${esc(av.window)}</span>`);
        if (pricesOn() && priceOf(item)) tags.push(`<span class="go-tag price">${esc(fmtPrice(priceOf(item)))}</span>`);
        const line = cart.find(l => l.catalogId === item.id);
        let action;
        if (!av.available) action = `<span class="go-unavail">Saat dışı</span>`;
        else if (line && line.qty > 0) action = stepHtml(item.id, line.qty);
        else action = `<button class="go-add" data-add="${esc(item.id)}" aria-label="Ekle">+</button>`;
        return `<div class="go-item ${av.available ? '' : 'go-item-unavail'}" data-id="${esc(item.id)}">
            <div class="go-item-emoji">${esc(item.icon || '🛎️')}</div>
            <div class="go-item-main">
                <div class="go-item-name">${esc(item.name)}</div>
                ${item.description ? `<div class="go-item-desc">${esc(item.description)}</div>` : ''}
                ${tags.length ? `<div class="go-item-meta">${tags.join('')}</div>` : ''}
            </div>
            <div class="go-item-act" data-act="${esc(item.id)}">${action}</div>
        </div>`;
    }
    const stepHtml = (id, qty) => `<div class="go-step"><button data-dec="${esc(id)}">−</button><b>${qty}</b><button data-inc="${esc(id)}">+</button></div>`;
    function bindItemEvents(wrap) {
        wrap.onclick = e => {
            const add = e.target.closest('[data-add]'); if (add) return changeQty(add.dataset.add, +1);
            const inc = e.target.closest('[data-inc]'); if (inc) return changeQty(inc.dataset.inc, +1);
            const dec = e.target.closest('[data-dec]'); if (dec) return changeQty(dec.dataset.dec, -1);
        };
    }
    function refreshItemRow(id) {
        const row = document.querySelector(`#goItems .go-item-act[data-act="${CSS.escape(id)}"]`);
        if (!row) return;
        const item = catalog.find(i => i.id === id); if (!item) return;
        const av = availInfo(item);
        const line = cart.find(l => l.catalogId === id);
        if (!av.available) row.innerHTML = `<span class="go-unavail">Saat dışı</span>`;
        else if (line && line.qty > 0) row.innerHTML = stepHtml(id, line.qty);
        else row.innerHTML = `<button class="go-add" data-add="${esc(id)}" aria-label="Ekle">+</button>`;
    }

    // ── Cart mutations ─────────────────────────────────────────
    function lineMax(l) { const m = Number(l && l.maxQty) || 0; return m > 0 ? Math.min(m, MAX_QTY) : MAX_QTY; }
    function capMsg(l) { return (Number(l && l.maxQty) || 0) > 0 ? `Bu talepten en fazla ${l.maxQty} adet verilebilir.` : `Bir talepten en fazla ${MAX_QTY} adet.`; }
    function changeQty(catalogId, delta) {
        const item = catalog.find(i => i.id === catalogId); if (!item) return;
        if (delta > 0) { const av = availInfo(item); if (!av.available) { toast('Bu talep yalnızca ' + av.window + ' saatleri arasında verilebilir.', true); return; } }
        let line = cart.find(l => l.catalogId === catalogId);
        if (!line && delta > 0) {
            if (cart.length >= MAX_DISTINCT) { toast(`En fazla ${MAX_DISTINCT} farklı talep ekleyebilirsiniz.`, true); return; }
            line = { catalogId, name: item.name, category: item.category || 'Diğer', icon: item.icon || '🛎️',
                department: item.department || '', price: priceOf(item), maxQty: Number(item.maxQty) || 0, qty: 0, note: '', preferredTime: '' };
            cart.push(line);
        }
        if (!line) return;
        if (delta > 0 && line.qty >= lineMax(line)) { toast(capMsg(line), true); return; }
        line.qty = Math.max(0, (line.qty || 0) + delta);
        if (line.qty === 0) cart = cart.filter(l => l !== line);
        saveCart();
        refreshItemRow(catalogId);
        renderCartUI();
        if (currentTab === 'cart') renderCart();
        if (delta > 0) { buzz(10); if (cartCount() === 1) toast('Sepete eklendi'); }
    }

    // ── Sepet ekranı + pill + badge ────────────────────────────
    function renderCartUI() { updateCartPill(); }
    function updateCartPill() {
        const pill = $('goCartPill'); if (!pill) return;
        const n = cartCount();
        const show = n > 0 && (currentTab === 'home' || currentTab === 'services');
        pill.hidden = !show;
        if (show) {
            $('goPillBadge').textContent = n;
            const tp = $('goPillTotal'); const t = cartTotal();
            tp.style.display = (pricesOn() && t) ? '' : 'none';
            tp.textContent = fmtPrice(t);
        }
    }
    function renderCart() {
        const wrap = $('goCartList'), foot = $('goCartFoot'); if (!wrap) return;
        $('goCartClear').hidden = !cart.length;
        if (!cart.length) {
            foot.hidden = true;
            wrap.innerHTML = `<div class="go-empty"><div class="go-empty-ic">🛒</div><h3>Sepetiniz boş</h3><p>Hizmetler sekmesinden talep ekleyin.</p><button class="go-cta" data-go="services">Hizmetlere Göz At</button></div>`;
            wrap.querySelector('[data-go]').onclick = () => showTab('services');
            return;
        }
        foot.hidden = false;
        $('goCartCountLbl').textContent = cart.length + ' talep · ' + cartCount() + ' adet';
        const tt = $('goCartTotal'); const t = cartTotal();
        tt.style.display = (pricesOn() && t) ? '' : 'none'; tt.textContent = fmtPrice(t);
        wrap.innerHTML = cart.map((l, i) => `
            <div class="go-cline" data-i="${i}">
                <div class="go-cline-top">
                    <div class="go-cline-emoji">${esc(l.icon || '🛎️')}</div>
                    <div class="go-cline-main">
                        <div class="go-cline-name">${esc(l.name)}</div>
                        <div class="go-cline-cat">${esc(l.category || '')}${(pricesOn() && priceOf(l)) ? ' · ' + esc(fmtPrice(priceOf(l))) : ''}</div>
                    </div>
                    <button class="go-cline-del" data-del="${i}" aria-label="Sil">🗑</button>
                </div>
                <div class="go-cline-row">
                    ${stepHtml('c' + i, l.qty).replace('data-dec="c' + i + '"', 'data-cdec="' + i + '"').replace('data-inc="c' + i + '"', 'data-cinc="' + i + '"')}
                    ${(pricesOn() && priceOf(l)) ? `<span class="go-cline-price">${esc(fmtPrice(priceOf(l) * l.qty))}</span>` : ''}
                </div>
                <div class="go-cline-fields">
                    <div class="go-fld-2">
                        <div class="go-fld"><label>Tercih saati</label><input type="time" data-time="${i}" value="${esc(l.preferredTime || '')}"></div>
                        <div class="go-fld"><label>Adet</label><input type="text" value="${l.qty} adet" readonly style="text-align:center"></div>
                    </div>
                    <div class="go-fld"><label>Not (opsiyonel)</label><input type="text" data-note="${i}" maxlength="160" placeholder="Örn. 2 büyük havlu" value="${esc(l.note || '')}"></div>
                </div>
            </div>`).join('');
        wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { cart.splice(+b.dataset.del, 1); saveCart(); renderCartUI(); renderCart(); refreshAllItemRows(); });
        wrap.querySelectorAll('[data-cinc]').forEach(b => b.onclick = () => bumpLine(+b.dataset.cinc, +1));
        wrap.querySelectorAll('[data-cdec]').forEach(b => b.onclick = () => bumpLine(+b.dataset.cdec, -1));
        wrap.querySelectorAll('[data-note]').forEach(inp => inp.oninput = () => { const l = cart[+inp.dataset.note]; if (l) { l.note = inp.value; saveCart(); } });
        wrap.querySelectorAll('[data-time]').forEach(inp => inp.onchange = () => { const l = cart[+inp.dataset.time]; if (l) { l.preferredTime = inp.value; saveCart(); } });
    }
    function bumpLine(i, delta) {
        const l = cart[i]; if (!l) return;
        if (delta > 0 && l.qty >= lineMax(l)) { toast(capMsg(l), true); return; }
        l.qty = Math.max(0, l.qty + delta);
        if (l.qty === 0) cart.splice(i, 1);
        saveCart(); renderCartUI(); refreshAllItemRows();
        renderCart();
    }
    function refreshAllItemRows() { if (currentTab === 'services') (catalog || []).forEach(it => refreshItemRow(it.id)); }

    // ════════════════════════════════════════════════════════════
    //  GÖNDERİM
    // ════════════════════════════════════════════════════════════
    function cooldownLeft() {
        let until = 0; try { until = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10); } catch (e) {}
        return Math.max(0, until - Date.now());
    }
    function hasPending() { return myOrders.some(o => o.status === 'pending'); }

    function submitOrder() {
        if (!cart.length || !sessionUid) return;
        const cd = cooldownLeft();
        if (cd > 0) { toast(`Çok hızlı! Lütfen ${Math.ceil(cd / 1000)} sn sonra deneyin.`, true); return; }
        if (hasPending()) { toast('Zaten onay bekleyen bir talebiniz var. Önce o sonuçlansın 🙏', true); showTab('orders'); return; }
        if (config.requireVerification && !isVerified()) { openGate(); return; }
        if (!ROOM) { openGate(); return; }

        const btn = $('goSubmit'); btn.disabled = true; $('goSubmitLabel').textContent = 'Gönderiliyor…';
        const items = cart.map((l, idx) => ({
            id: 'i' + idx + '_' + Date.now().toString(36),
            catalogId: l.catalogId || '', name: String(l.name || '').slice(0, 120), category: String(l.category || '').slice(0, 60),
            icon: String(l.icon || '🛎️').slice(0, 8), department: String(l.department || '').slice(0, 60),
            price: priceOf(l), qty: Math.min(lineMax(l), Math.max(1, l.qty || 1)),
            note: String(l.note || '').slice(0, 160), preferredTime: String(l.preferredTime || '').slice(0, 10), status: 'pending'
        }));
        const total = items.reduce((s, it) => s + (Number(it.price) || 0) * it.qty, 0);
        const done = (id) => {
            try { localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS)); } catch (e) {}
            cart = []; saveCart(); renderCartUI();
            btn.disabled = false; $('goSubmitLabel').textContent = 'Talebi Gönder';
            toast('Talebiniz alındı! 🎉' + (DEMO ? ' (demo)' : '')); buzz([40, 30, 40]);
            trackingId = id; showTab('orders'); openTracking(id);
        };
        const fail = (err) => { console.error('submit failed', err); btn.disabled = false; $('goSubmitLabel').textContent = 'Talebi Gönder'; toast('Gönderilemedi. Tekrar deneyin.', true); };

        if (DEMO) { const id = 'demo' + Date.now().toString(36); saveDemoOrder({ id, room: ROOM, guestName, items, itemCount: items.length, total, currency: config.currency, showPrices: pricesOn(), createdAtMs: Date.now() }); loadDemoOrders(); done(id); return; }

        db.collection('guestOrders').add({
            tenantId: TENANT, room: ROOM, guestName: guestName || '', sessionUid,
            status: 'pending', items, itemCount: items.length, total, currency: config.currency || '₺', showPrices: pricesOn(),
            statusLog: [{ status: 'pending', at: Date.now(), by: 'guest' }],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then(ref => done(ref.id)).catch(fail);
    }

    // ════════════════════════════════════════════════════════════
    //  TALEPLERİM (canlı)
    // ════════════════════════════════════════════════════════════
    function tsMs(o) { const c = o.createdAt; return (c && c.toMillis) ? c.toMillis() : (o.createdAtMs || 0); }
    function activeOrder() { return myOrders.filter(o => o.status !== 'completed' && o.status !== 'cancelled')[0] || null; }

    function listenOrders() {
        if (ordersUnsub) { ordersUnsub(); ordersUnsub = null; }
        ordersUnsub = db.collection('guestOrders').where('sessionUid', '==', sessionUid).onSnapshot(snap => {
            myOrders = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => tsMs(b) - tsMs(a));
            onOrdersChanged();
        }, err => console.error('orders listen', err));
    }
    function onOrdersChanged() {
        // status değişimi → toast
        myOrders.forEach(o => {
            const prev = lastStatusMap[o.id];
            if (prev && prev !== o.status && STATUS[o.status]) toast(STATUS[o.status].sub);
            lastStatusMap[o.id] = o.status;
        });
        const active = myOrders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;
        const bell = $('goBellDot'); if (bell) bell.hidden = active === 0;
        const nb = $('goNavBadge'); if (nb) { nb.hidden = active === 0; nb.textContent = active; }
        if (currentTab === 'orders') {
            if (trackingId && !$('goTrack').classList.contains('go-hidden')) renderTracking();
            else showOrderList();
        }
    }

    function showOrderList() {
        trackingId = null;
        $('goTrack').classList.add('go-hidden');
        $('goOrders').classList.remove('go-hidden');
        $('goTrackBack').hidden = true;
        $('goOrdersTitle').textContent = 'Taleplerim';
        const wrap = $('goOrders');
        if (!myOrders.length) {
            wrap.innerHTML = `<div class="go-empty"><div class="go-empty-ic">📋</div><h3>Henüz talep yok</h3><p>Oluşturduğunuz talepleri buradan canlı takip edebilirsiniz.</p><button class="go-cta" data-go="services">Talep Oluştur</button></div>`;
            wrap.querySelector('[data-go]').onclick = () => showTab('services');
            return;
        }
        wrap.innerHTML = myOrders.map(o => {
            const st = STATUS[o.status] || STATUS.pending;
            const names = (o.items || []).map(it => it.name).join(', ');
            const when = relTime(tsMs(o));
            return `<button class="go-ocard" data-open="${esc(o.id)}">
                <span class="go-ocard-ic go-st-${esc(o.status)}" style="background:transparent">${esc(st.emoji)}</span>
                <span class="go-ocard-main">
                    <span class="go-ocard-tl">${(o.items || []).length} talep · <span class="go-statepill go-st-${esc(o.status)}">${esc(st.label)}</span></span>
                    <span class="go-ocard-sub">${esc(names)}${when ? ' · ' + esc(when) : ''}</span>
                </span>
                <span class="go-ocard-chev">${svg('<polyline points="9 18 15 12 9 6"/>', 20)}</span>
            </button>`;
        }).join('');
        wrap.onclick = e => { const b = e.target.closest('[data-open]'); if (b) openTracking(b.dataset.open); };
    }

    function openTracking(id) {
        trackingId = id;
        showTab('orders', { keepTrack: true });
        $('goOrders').classList.add('go-hidden');
        $('goTrack').classList.remove('go-hidden');
        $('goTrackBack').hidden = false;
        $('goOrdersTitle').textContent = 'Talep Takibi';
        renderTracking();
        $('goTrack').scrollTop = 0;
    }
    function currentTracked() { return myOrders.find(o => o.id === trackingId) || null; }
    function renderTracking() {
        const o = currentTracked(); const wrap = $('goTrack'); if (!wrap) return;
        if (!o) { showOrderList(); return; }
        const st = STATUS[o.status] || STATUS.pending;
        const cancelled = o.status === 'cancelled';
        const stepIdx = FLOW.indexOf(o.status);
        const showP = !!o.showPrices && Number(o.total) > 0;
        const cur = o.currency || '₺';
        const money = n => cur + Number(n || 0).toLocaleString('tr-TR');
        const steps = cancelled ? '' : `<div class="go-steps">${FLOW.map((s, i) => {
            const cls = i < stepIdx ? 'done' : (i === stepIdx ? 'active' : '');
            const log = (o.statusLog || []).filter(l => l.status === s).pop();
            const tm = log ? clock(log.at) : '';
            return `<div class="go-stp ${cls}"><div class="go-stp-dot">${i < stepIdx ? '✓' : (i + 1)}</div>
                <div class="go-stp-body"><div class="go-stp-tl">${esc(STATUS[s].label)}</div>${tm ? `<div class="go-stp-tm">${esc(tm)}</div>` : ''}</div></div>`;
        }).join('')}</div>`;
        const items = (o.items || []).map(it => {
            const ist = STATUS[it.status] || STATUS.pending;
            const bits = [it.qty > 1 ? it.qty + ' adet' : '', it.preferredTime ? '🕐 ' + it.preferredTime : '', it.note];
            if (showP && Number(it.price) > 0) bits.push(money(Number(it.price) * (it.qty || 1)));
            const meta = bits.filter(Boolean).join(' · ');
            return `<div class="go-titem"><div class="go-titem-emoji">${esc(it.icon || '🛎️')}</div>
                <div class="go-titem-main"><div class="go-titem-name">${esc(it.name)}</div>${meta ? `<div class="go-titem-meta">${esc(meta)}</div>` : ''}</div>
                <span class="go-statepill go-st-${esc(it.status || 'pending')}">${esc(ist.label)}</span></div>`;
        }).join('');
        wrap.innerHTML = `
            <div class="go-track-hero">
                <div class="go-track-emoji">${esc(st.emoji)}</div>
                <h2>${esc(st.label)}</h2>
                <p>${esc(st.sub)}</p>
                <div class="go-track-meta">
                    ${o.room ? `<span class="go-track-tag">Oda ${esc(o.room)}</span>` : ''}
                    <span class="go-track-tag">${(o.items || []).length} talep</span>
                    ${showP ? `<span class="go-track-tag">Toplam ${esc(money(o.total))}</span>` : ''}
                </div>
            </div>
            ${cancelled && o.cancelReason ? `<div class="go-cancel-reason">
                <div class="go-cancel-reason-h">İptal Nedeni</div>
                <div class="go-cancel-reason-b">${esc(o.cancelReason)}</div>
            </div>` : ''}
            ${steps}
            <div class="go-track-sec">Talepleriniz</div>
            ${items}
            <div class="go-track-btns">
                ${o.status === 'pending' ? `<button class="go-btn-ghost go-btn-danger" id="goCancelBtn">Talebi İptal Et</button>` : ''}
                <button class="go-btn-ghost" id="goNewBtn">Yeni Talep Oluştur</button>
            </div>`;
        const cb = $('goCancelBtn'); if (cb) cb.onclick = () => cancelOrder(o.id);
        $('goNewBtn').onclick = () => showTab('services');
    }
    function cancelOrder(id) {
        if (!confirm('Talebinizi iptal etmek istediğinize emin misiniz?')) return;
        if (DEMO) { const o = loadDemoOrder(id); if (o) { o.cancelled = true; saveDemoOrder(o); } if (demoTimer) { clearInterval(demoTimer); } loadDemoOrders(); return; }
        db.collection('guestOrders').doc(id).update({ status: 'cancelled', updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
            .catch(err => { console.error(err); toast('İptal edilemedi.', true); });
    }

    // ── Zaman ──────────────────────────────────────────────────
    function clock(ms) { if (!ms) return ''; try { return new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
    function relTime(ms) {
        if (!ms) return '';
        const diff = Date.now() - ms;
        if (diff < 60000) return 'az önce';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' dk önce';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' sa önce';
        try { return new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }); } catch (e) { return ''; }
    }

    // ════════════════════════════════════════════════════════════
    //  DOĞRULAMA (soyadı + oda) + güvenli ad
    // ════════════════════════════════════════════════════════════
    function maybeGate() { if (config.requireVerification && !isVerified()) openGate(); }
    function openGate() {
        $('goGateBackdrop').classList.add('show');
        $('goGate').classList.add('show');
        $('goGate').setAttribute('aria-hidden', 'false');
        const r = $('goGateRoom'); if (r && ROOM) r.value = ROOM;
        setTimeout(() => { const s = $('goGateSurname'); if (s) s.focus(); }, 250);
    }
    function closeGate() {
        $('goGateBackdrop').classList.remove('show');
        $('goGate').classList.remove('show');
        $('goGate').setAttribute('aria-hidden', 'true');
    }
    async function doVerify() {
        const surname = ($('goGateSurname').value || '').trim();
        const room = ($('goGateRoom').value || '').trim().slice(0, 40);
        const err = $('goGateErr'); const setErr = m => err.textContent = m || '';
        if (surname.length < 2) { setErr('Lütfen soyadınızı girin.'); return; }
        if (!room) { setErr('Lütfen oda numaranızı girin.'); return; }
        setErr('');
        const btn = $('goGateBtn'), lbl = $('goGateBtnLabel');
        btn.disabled = true; lbl.textContent = 'Kontrol ediliyor…';
        const fail = m => { btn.disabled = false; lbl.textContent = 'Doğrula ve Devam Et'; setErr(m); buzz(70); };
        const ok = (name) => {
            ROOM = room; recomputeKeys(); loadCart(); setVerified(); setSurname(surname);
            if (name) setGuestName(name);
            btn.disabled = false; lbl.textContent = 'Doğrula ve Devam Et';
            closeGate(); applyConfig(); renderAll();
            toast(guestName ? ('Hoş geldiniz, ' + guestName.split(' ')[0] + ' 👋') : 'Doğrulandı 👋');
        };
        try {
            if (DEMO) { await new Promise(r => setTimeout(r, 500)); ok(titleCase(surname)); return; }
            const doc = await db.collection('roomAccess').doc(TENANT + '__' + room).get();
            if (!doc.exists || doc.data().open !== true) { fail('Bu oda şu anda talebe kapalı görünüyor. Aktif konaklamanız yoksa resepsiyona başvurun.'); return; }
            const keys = doc.data().nameKeys || [];
            let matched = false;
            for (const t of nameTokens(surname)) { const h = await sha16(TENANT + '|' + room + '|' + t); if (keys.indexOf(h) !== -1) { matched = true; break; } }
            if (!matched) { fail('Soyadı bu oda ile eşleşmedi. Lütfen rezervasyondaki soyadınızı girin.'); return; }
            // Güvenli ad çözümleme (best-effort)
            let fullName = '';
            try {
                if (fns) { const res = await fns.httpsCallable('getGuestName')({ tenant: TENANT, room, surname }); if (res && res.data && res.data.ok) fullName = res.data.name || ''; }
            } catch (e) { /* ad alınamazsa sorun değil */ }
            ok(fullName);
        } catch (e) { console.error('verify failed', e); fail('Doğrulama yapılamadı. Lütfen tekrar deneyin.'); }
    }
    function titleCase(s) { return String(s || '').toLocaleLowerCase('tr-TR').replace(/(^|\s)\S/g, c => c.toLocaleUpperCase('tr-TR')); }

    // ── Otel bilgileri sheet ───────────────────────────────────
    function infoRow(ic, label, value, opts) {
        opts = opts || {}; const val = String(value == null ? '' : value).trim(); if (!val) return '';
        let act = '';
        if (opts.tel) act = `<a class="go-inforow-act" href="tel:${esc(opts.tel)}">Ara</a>`;
        else if (opts.map) act = `<a class="go-inforow-act" href="https://maps.google.com/?q=${encodeURIComponent(opts.map)}" target="_blank" rel="noopener">Harita</a>`;
        else if (opts.copy) act = `<button class="go-inforow-act" data-copy="${esc(opts.copy)}">Kopyala</button>`;
        return `<div class="go-inforow"><span class="go-inforow-ic">${svg(INFO_ICONS[ic] || INFO_ICONS.pin, 22)}</span>
            <div class="go-inforow-tx"><div class="go-inforow-lbl">${esc(label)}</div><div class="go-inforow-val">${esc(val)}</div></div>${act}</div>`;
    }
    function openInfo() {
        const body = $('goInfoBody');
        const hname = (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT);
        const rows = [
            infoRow('phone', 'Resepsiyon', config.phone, { tel: (config.phone || '').replace(/[^0-9+]/g, '') }),
            infoRow('wifi', 'Wi-Fi ağı', config.wifiName, { copy: config.wifiName }),
            infoRow('wifi', 'Wi-Fi şifresi', config.wifiPass, { copy: config.wifiPass }),
            infoRow('clock', 'Check-out', config.checkoutTime),
            infoRow('coffee', 'Kahvaltı', config.breakfast),
            infoRow('pin', 'Adres', config.address, { map: config.address })
        ].filter(Boolean).join('');
        body.innerHTML = `<div class="go-info-hero"><h3>${esc(hname)}</h3>${config.welcome && config.welcome.trim() ? `<p>${esc(config.welcome.trim())}</p>` : ''}</div>${rows || '<div class="go-empty"><div class="go-empty-ic">ℹ️</div><h3>Bilgi yok</h3><p>Henüz otel bilgisi eklenmemiş.</p></div>'}`;
        body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { try { navigator.clipboard.writeText(b.dataset.copy); toast('Kopyalandı'); } catch (e) {} });
        $('goInfoBackdrop').classList.add('show');
        $('goInfoSheet').classList.add('show');
        $('goInfoSheet').setAttribute('aria-hidden', 'false');
    }
    function closeInfo() { $('goInfoBackdrop').classList.remove('show'); $('goInfoSheet').classList.remove('show'); $('goInfoSheet').setAttribute('aria-hidden', 'true'); }

    // ════════════════════════════════════════════════════════════
    //  DEMO backend
    // ════════════════════════════════════════════════════════════
    const DEMO_STEPS = [[0, 'pending'], [25000, 'confirmed'], [60000, 'in_progress'], [110000, 'completed']];
    function saveDemoOrder(o) { try { localStorage.setItem('go2_demo_' + o.id, JSON.stringify(o)); const ids = demoIds(); if (!ids.includes(o.id)) { ids.push(o.id); localStorage.setItem('go2_demo_ids', JSON.stringify(ids)); } } catch (e) {} }
    function loadDemoOrder(id) { try { return JSON.parse(localStorage.getItem('go2_demo_' + id)); } catch (e) { return null; } }
    function demoIds() { try { return JSON.parse(localStorage.getItem('go2_demo_ids')) || []; } catch (e) { return []; } }
    function demoView(o) {
        if (o.cancelled) return Object.assign({}, o, { status: 'cancelled', items: (o.items || []).map(it => Object.assign({}, it, { status: 'cancelled' })) });
        const e = Date.now() - (o.createdAtMs || Date.now());
        let status = 'pending'; const log = [];
        DEMO_STEPS.forEach(([t, s]) => { if (e >= t) { status = s; log.push({ status: s, at: (o.createdAtMs || 0) + t, by: t === 0 ? 'guest' : 'Personel' }); } });
        return Object.assign({}, o, { status, items: (o.items || []).map(it => Object.assign({}, it, { status })), statusLog: log });
    }
    function loadDemoOrders() {
        myOrders = demoIds().map(loadDemoOrder).filter(Boolean).map(demoView).sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        onOrdersChanged();
        if (demoTimer) clearInterval(demoTimer);
        if (myOrders.some(o => o.status !== 'completed' && o.status !== 'cancelled')) demoTimer = setInterval(loadDemoOrders, 1000);
    }

    // ════════════════════════════════════════════════════════════
    //  WIRING
    // ════════════════════════════════════════════════════════════
    function wireShell() {
        document.querySelectorAll('.go-nav-b').forEach(b => b.onclick = () => showTab(b.dataset.go));
        document.querySelectorAll('[data-go]').forEach(el => { if (!el.classList.contains('go-nav-b')) el.addEventListener('click', () => showTab(el.dataset.go)); });
        $('goCartPill').onclick = () => showTab('cart');
        $('goBell').onclick = () => showTab('orders');
        const av = $('goAvatar'); if (av) av.onclick = () => showTab('profile');
        const sb = $('goServicesBack'); if (sb) sb.onclick = () => showTab('home');
        const cbk = $('goCartBack'); if (cbk) cbk.onclick = () => showTab('home');
        $('goTrackBack').onclick = showOrderList;
        $('goCartClear').onclick = () => { if (cart.length && confirm('Sepeti temizlemek istiyor musunuz?')) { cart = []; saveCart(); renderCartUI(); renderCart(); refreshAllItemRows(); } };
        $('goSubmit').onclick = submitOrder;
        $('goGateBtn').onclick = doVerify;
        $('goGateBackdrop').onclick = () => { if (!(config.requireVerification && !isVerified())) closeGate(); };
        const fc = $('goFolioClose'); if (fc) fc.onclick = closeFolio;
        const fb = $('goFolioBackdrop'); if (fb) fb.onclick = closeFolio;
        // Arama
        const s = $('goSearch');
        if (s) s.addEventListener('input', () => { searchTerm = s.value; $('goSearchX').hidden = !s.value; renderItems(); });
        $('goSearchX').onclick = () => { searchTerm = ''; $('goSearch').value = ''; $('goSearchX').hidden = true; renderItems(); $('goSearch').focus(); };
        // Soyadı büyük harf (TR)
        const su = $('goGateSurname');
        if (su) su.addEventListener('input', () => { const p = su.selectionStart; su.value = su.value.toLocaleUpperCase('tr-TR').replace(/[^A-ZÇĞİÖŞÜ \-']/g, ''); try { su.setSelectionRange(p, p); } catch (e) {} });
        ['goGateSurname', 'goGateRoom'].forEach(id => { const el = $(id); if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); }); });
    }

    // ── Go ─────────────────────────────────────────────────────
    if (typeof db === 'undefined' || typeof auth === 'undefined' || !db || !auth) {
        const el = document.getElementById('goCats');
        if (el) el.innerHTML = '<div class="go-empty"><div class="go-empty-ic">⚠️</div><h3>Yapılandırma hatası</h3><p>Bağlantı kurulamadı.</p></div>';
        return;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
