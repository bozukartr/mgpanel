/* StayOS — Guest Self-Service ordering (guest-order.html)
 *
 * QR-opened, login-free page with a simple big-button UI: pick one of a few
 * operational categories, tap large item buttons into a cart (qty / note /
 * preferred time), place the order and watch it move through
 * Bekliyor → Onaylandı → İşlemde → Tamamlandı live.
 *
 * Isolation: the guest signs in with Firebase Anonymous Auth; the rules let
 * them read ONLY their own orders. Tenant + room come from the QR link.
 *
 * Spam guards: 1) one pending order, 2) item/qty caps, 3) post-submit cooldown.
 * DEMO mode (?demo): runs fully client-side, no Firebase.
 */
(function () {
    'use strict';

    // ── Isolated Firebase app (CRITICAL) ───────────────────────
    // The guest signs in ANONYMOUSLY. Firebase Auth syncs the DEFAULT app's
    // current user across every tab of the same origin — and the QR link is on
    // the same origin as the staff app. If we used the shared `auth`, the
    // guest's anonymous sign-in would REPLACE a logged-in staff member's
    // session in their other tab (admin/panel/dashboard), turning every
    // tenant-scoped query into a permission-denied error. We therefore use a
    // dedicated secondary app with in-memory (NONE) persistence: the guest
    // session stays local to this tab and never touches the staff session.
    let auth, db;
    (function initGuestApp() {
        if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') return;
        try {
            let app;
            try { app = firebase.app('guest'); }
            catch (e) { app = firebase.initializeApp(firebaseConfig, 'guest'); }
            auth = app.auth();
            try { auth.setPersistence(firebase.auth.Auth.Persistence.NONE); } catch (e) {}
            db = app.firestore();
        } catch (e) { /* firebase yüklenemedi → aşağıdaki guard ele alır */ }
    })();

    // ── Tenant + room from the QR link ─────────────────────────
    const TENANT = (typeof resolveTenant === 'function' ? resolveTenant() : 'mgallery');
    const params = new URLSearchParams(window.location.search);
    let ROOM = (params.get('room') || params.get('oda') || '').trim().slice(0, 40);

    // Storage keys depend on the room, which may only be known after the
    // verification gate — so they're recomputed once the room is set.
    let CART_KEY, ORDER_KEY, COOLDOWN_KEY, VERIFY_KEY;
    function recomputeKeys() {
        const r = ROOM || 'x';
        CART_KEY = `go_cart_${TENANT}_${r}`;
        ORDER_KEY = `go_order_${TENANT}_${r}`;
        COOLDOWN_KEY = `go_cd_${TENANT}_${r}`;
        VERIFY_KEY = `go_verify_${TENANT}_${r}`;
    }
    recomputeKeys();

    // ── Anti-spam limits ───────────────────────────────────────
    const MAX_DISTINCT = 20, MAX_QTY = 10, COOLDOWN_MS = 60 * 1000;

    const DEMO = params.has('demo');
    let demoTimer = null;

    // Built-in DEMO catalog — 4 operational categories only.
    const DEMO_CATALOG = [
        { category: 'Temizlik', name: 'Oda Temizliği', icon: '🧹', eta: '30-45 dk', maxQty: 1, department: 'Housekeeping', availFrom: '09:00', availTo: '16:00' },
        { category: 'Temizlik', name: 'Havlu Değişimi', icon: '🧺', eta: '15-30 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Çarşaf Değişimi', icon: '🛏️', eta: '30-45 dk', maxQty: 1, department: 'Housekeeping', availFrom: '09:00', availTo: '16:00' },
        { category: 'Temizlik', name: 'Çöp Toplama', icon: '🗑️', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Banyo Malzemeleri', icon: '🧴', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Ekstra Yastık', icon: '🛏️', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Ekstra Battaniye', icon: '🧣', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Terlik', icon: '🥿', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Bornoz', icon: '🥼', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Askı', icon: '🧥', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Yiyecek & İçecek', name: 'Su', icon: '💧', eta: '15 dk', department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Çay / Kahve', icon: '☕', eta: '15-20 dk', price: 60, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Meyve Tabağı', icon: '🍎', eta: '20-30 dk', price: 120, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Atıştırmalık', icon: '🍫', eta: '20 dk', price: 80, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Meşrubat', icon: '🥤', eta: '20 dk', price: 70, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Buz', icon: '🧊', eta: '15 dk', department: 'Food & Beverage' },
        { category: 'Teknik', name: 'Klima Sorunu', icon: '❄️', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'TV Sorunu', icon: '📺', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Sıcak Su Yok', icon: '🚿', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Wi-Fi Sorunu', icon: '📶', eta: '20 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Ampul Değişimi', icon: '💡', eta: '20 dk', department: 'Engineering' }
    ].map((d, i) => Object.assign({ id: 'demo-' + i, active: true, sortOrder: (i + 1) * 10 }, d));

    // Admin-controlled guest-page settings (collection `guestConfig/{tenant}`).
    const DEFAULT_CONFIG = { hotelName: '', showPrices: false, currency: '₺', requireVerification: false,
        welcome: '', phone: '', wifiName: '', wifiPass: '', checkoutTime: '', breakfast: '', address: '', heroImage: '' };
    const DEMO_CONFIG = { hotelName: 'Grand Demo Otel', showPrices: true, currency: '₺', requireVerification: true,
        heroImage: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1000&q=80',
        welcome: 'Konaklamanızın keyfini çıkarın — her şey bir dokunuş uzağınızda.',
        phone: '0 (212) 000 00 00', wifiName: 'GrandDemo-Guest', wifiPass: 'demo2024',
        checkoutTime: '12:00', breakfast: '07:00 – 10:30 · Lobi Restoran', address: 'Sahil Cad. No:1, İstanbul' };
    let config = Object.assign({}, DEFAULT_CONFIG);

    // ── Status metadata ────────────────────────────────────────
    const STATUS = {
        pending:     { label: 'Bekliyor',     emoji: '⏳' },
        confirmed:   { label: 'Onaylandı',    emoji: '✅' },
        in_progress: { label: 'İşlemde',      emoji: '🛎️' },
        completed:   { label: 'Tamamlandı',   emoji: '🎉' },
        cancelled:   { label: 'İptal Edildi', emoji: '✖️' }
    };
    const FLOW = ['pending', 'confirmed', 'in_progress', 'completed'];

    // ── State ──────────────────────────────────────────────────
    let catalog = [], cart = [], activeCat = null, activeSub = 'all', sessionUid = null;
    let orderUnsub = null, currentOrderId = null, activeOrderStatus = null;
    let currentOrder = null, lastStatus = null, miniDismissed = false;

    // ── Helpers ────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const $ = id => document.getElementById(id);
    function svg(inner, size) {
        return `<svg viewBox="0 0 24 24" width="${size || 23}" height="${size || 23}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    }
    const clockSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
    let toastTimer = null;
    function toast(msg, isError) {
        const t = $('goToast');
        t.textContent = msg;
        t.className = 'go-toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.className = 'go-toast'; }, 2800);
        if (isError) { try { navigator.vibrate && navigator.vibrate(80); } catch (e) {} }
    }
    function cssId(s) { return String(s).replace(/[^a-z0-9]/gi, '_'); }

    // Name normalisation + salted hash — MUST stay identical to room-access.js.
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
    function isVerified() {
        if (!ROOM) return false;
        try { return (parseInt(localStorage.getItem(VERIFY_KEY) || '0', 10)) > Date.now(); } catch (e) { return false; }
    }
    function setVerified() {
        try { localStorage.setItem(VERIFY_KEY, String(Date.now() + 12 * 3600 * 1000)); } catch (e) {}
    }

    // Category → line icon + gradient (keyword based).
    function catKind(cat) {
        const c = String(cat || '').toLowerCase();
        if (/temiz|housekeep|clean|kat hizmet|oda temiz/.test(c)) return 'temiz';
        if (/konfor|comfort|amenit|buklet/.test(c)) return 'konfor';
        if (/yiyecek|içecek|icecek|food|beverage|restoran|minibar|mini bar|oda servis|room service|kahvalt/.test(c)) return 'food';
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
    const CAT_GRAD = {
        temiz: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
        konfor: 'linear-gradient(135deg,#0ea5e9,#22d3ee)',
        food: 'linear-gradient(135deg,#f59e0b,#f97316)',
        teknik: 'linear-gradient(135deg,#10b981,#14b8a6)',
        bell: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
        other: 'linear-gradient(135deg,#64748b,#475569)'
    };
    const catIcon = (cat, size) => svg(CAT_ICON[catKind(cat)] || CAT_ICON.other, size);
    const catGrad = cat => CAT_GRAD[catKind(cat)] || CAT_GRAD.other;
    // Friendly two-line blurb under each big card title (reference style); '' → count fallback.
    const CAT_BLURB = {
        bell: 'İhtiyacınız olan her konuda size yardımcı olalım.',
        temiz: 'Temizlik, havlu, buklet ürün ve daha fazlası.',
        konfor: 'Konaklamanızı daha keyifli kılacak detaylar.',
        food: 'Yiyecek ve içecek siparişleriniz için buradayız.',
        teknik: 'Odanızdaki teknik sorunları hızla çözelim.'
    };
    const catBlurb = cat => CAT_BLURB[catKind(cat)] || '';
    // Premium, index-based palette for the home category cards (dark green / taupe
    // / navy / warm-brown / muted-green) — matches the reference hotel-home design.
    const CARD_PALETTE = [
        'linear-gradient(160deg,#3a5644,#2e4636)',
        'linear-gradient(160deg,#928568,#7d7058)',
        'linear-gradient(160deg,#34485c,#293a4b)',
        'linear-gradient(160deg,#7b5a44,#5f4434)',
        'linear-gradient(160deg,#536659,#3e4e44)'
    ];

    // ── Cart persistence ───────────────────────────────────────
    function loadCart() {
        try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
        if (!Array.isArray(cart)) cart = [];
    }
    function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {} }
    const cartCount = () => cart.reduce((n, l) => n + (l.qty || 0), 0);

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        if (ROOM) { const rl = $('goRoomLabel'); if (rl) { rl.style.display = 'inline-block'; rl.textContent = 'Oda ' + ROOM; } }
        loadCart();
        wireEvents();
        renderCartBar();

        if (DEMO) {
            sessionUid = 'demo';
            config = Object.assign({}, DEFAULT_CONFIG, DEMO_CONFIG);
            catalog = DEMO_CATALOG.slice();
            present();
            return;
        }

        applyHotelName();
        let started = false;
        auth.onAuthStateChanged(u => {
            if (u && !started) { started = true; sessionUid = u.uid; loadData(); }
        });
        auth.signInAnonymously().catch(err => {
            console.error('Anon sign-in failed', err);
            $('goBody').innerHTML = stateHtml('⚠️', 'Bağlantı kurulamadı',
                'Anonim giriş kapalı olabilir. Test için bağlantıya ?demo=1 ekleyin.');
        });
    }

    // Decide what to show once config + catalog are ready: the verification gate
    // (surname + room) when the hotel requires it, otherwise the catalog.
    function present() {
        applyHotelName();
        let saved = null;
        try { saved = localStorage.getItem(ORDER_KEY); } catch (e) {}
        if (config.requireVerification && !isVerified() && !saved && (crypto && crypto.subtle)) {
            showGateView();
            return;
        }
        renderAll();
        resumeOrder();
    }
    function prettyTenant(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'StayOS'; }
    function applyHotelName() {
        const name = (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT);
        $('goHotelName').textContent = name + (DEMO ? ' · DEMO' : '');
        // Welcome message replaces the generic subtitle when provided.
        const sub = $('goSub');
        if (sub && config.welcome && config.welcome.trim()) sub.textContent = config.welcome.trim();
        // Show the info button only if there's at least one hotel-info field.
        const hasInfo = ['welcome', 'phone', 'wifiName', 'wifiPass', 'checkoutTime', 'breakfast', 'address']
            .some(k => config[k] && String(config[k]).trim());
        const ic = $('goInfoIc'); if (ic) ic.style.display = hasInfo ? '' : 'none';
        applyHero();
        renderHotelInfo();
    }

    // Optional admin-set hero photo; falls back to the warm CSS gradient.
    function applyHero() {
        const el = $('goHeroImg');
        if (!el) return;
        const url = (config.heroImage || '').trim();
        el.style.backgroundImage = url ? `url("${url.replace(/"/g, '%22')}")` : '';
        el.classList.toggle('has-photo', !!url);
    }

    // ── Hotel info sheet ───────────────────────────────────────
    function infoRow(svg, label, value, opts) {
        opts = opts || {};
        var val = String(value == null ? '' : value).trim();
        if (!val) return '';
        var right = '';
        if (opts.copy) right = `<button class="go-info-copy" data-copy="${esc(val)}">Kopyala</button>`;
        else if (opts.href) right = `<a class="go-info-link" href="${esc(opts.href)}"${opts.blank ? ' target="_blank" rel="noopener"' : ''}>${esc(opts.linkText || 'Aç')}</a>`;
        return `<div class="go-info-row">
            <span class="go-info-ico">${svg}</span>
            <div class="go-info-txt"><span class="go-info-label">${esc(label)}</span><span class="go-info-val">${esc(val)}</span></div>
            ${right}</div>`;
    }
    function renderHotelInfo() {
        const body = $('goInfoBody'); if (!body) return;
        const I = {
            phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
            wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
            key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
            clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
            coffee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>',
            pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>'
        };
        const phoneDigits = (config.phone || '').replace(/[^0-9+]/g, '');
        const rows = [
            infoRow(I.phone, 'Resepsiyon', config.phone, phoneDigits ? { href: 'tel:' + phoneDigits, linkText: 'Ara' } : {}),
            infoRow(I.wifi, 'Wi-Fi ağı', config.wifiName, { copy: true }),
            infoRow(I.key, 'Wi-Fi şifresi', config.wifiPass, { copy: true }),
            infoRow(I.clock, 'Çıkış (check-out)', config.checkoutTime),
            infoRow(I.coffee, 'Kahvaltı', config.breakfast),
            infoRow(I.pin, 'Adres', config.address, config.address ? { href: 'https://maps.google.com/?q=' + encodeURIComponent(config.address), blank: true, linkText: 'Harita' } : {})
        ].filter(Boolean).join('');
        const hname = (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT);
        body.innerHTML = `<div class="go-info-hero"><div class="go-info-h-name">${esc(hname)}</div>${config.welcome && config.welcome.trim() ? `<div class="go-info-h-welcome">${esc(config.welcome.trim())}</div>` : ''}</div>${rows || '<div class="go-info-empty">Henüz otel bilgisi eklenmemiş.</div>'}`;
        body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
            try { navigator.clipboard.writeText(b.dataset.copy); toast('Kopyalandı'); } catch (e) {}
        });
    }
    function openInfoSheet() {
        $('goInfoBackdrop').classList.add('show');
        $('goInfoSheet').classList.add('show');
        $('goInfoSheet').setAttribute('aria-hidden', 'false');
    }
    function closeInfoSheet() {
        $('goInfoBackdrop').classList.remove('show');
        $('goInfoSheet').classList.remove('show');
        $('goInfoSheet').setAttribute('aria-hidden', 'true');
    }

    // ── Data (config + catalog) ────────────────────────────────
    function loadData() {
        Promise.all([fetchConfig(), fetchCatalog()]).then(() => present());
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
            .catch(err => {
                console.error('catalog load failed', err);
                catalog = [];
                $('goBody').innerHTML = stateHtml('😕', 'Talepler yüklenemedi', 'Sayfayı yenileyip tekrar deneyin.');
            });
    }

    // ── Price helpers ──────────────────────────────────────────
    function priceOf(item) { const p = Number(item && item.price) || 0; return p > 0 ? p : 0; }
    function pricesOn() { return !!config.showPrices; }
    function fmtPrice(n) { return config.currency + Number(n || 0).toLocaleString('tr-TR'); }
    function priceTag(item) { const p = priceOf(item); return (pricesOn() && p) ? `<span class="go-price">${esc(fmtPrice(p))}</span>` : ''; }
    function cartTotal() { return cart.reduce((s, l) => s + priceOf(l) * (l.qty || 0), 0); }

    function categories() {
        const seen = [];
        catalog.forEach(i => { const c = (i.category || 'Diğer').trim(); if (!seen.includes(c)) seen.push(c); });
        return seen;
    }

    // ── Render ─────────────────────────────────────────────────
    function catVisible() { const v = $('goCatView'); return v && !v.classList.contains('go-hidden'); }

    function renderAll() {
        renderHome();
        // Keep the open category screen (if any) in sync with catalog/cart changes.
        if (catVisible()) { renderItems(); refreshStepControls(); }
        renderCartBar();
    }

    // Home screen: big colour-coded category cards (+ compact tiles when many).
    function renderHome() {
        const cards = $('goCards');
        if (!cards) return;
        if (!catalog.length) {
            cards.innerHTML = stateHtml('🛎️', 'Henüz hizmet tanımlanmamış',
                'Bu otel için talepler henüz hazır değil. Lütfen resepsiyon ile iletişime geçin.');
            return;
        }
        const cats = categories();
        const subLabel = (c) => catalog.filter(i => (i.category || 'Diğer') === c).length + ' hizmet';
        // ≤4 categories → all as big cards; otherwise first 3 big + the rest as mini tiles.
        const bigCount = cats.length <= 4 ? cats.length : 3;
        const bigCats = cats.slice(0, bigCount), miniCats = cats.slice(bigCount);
        const bigHtml = bigCats.map((c, i) => `
            <button class="go-card-big" data-cat="${esc(c)}" style="background:${CARD_PALETTE[i % CARD_PALETTE.length]}">
                <span class="go-cb-ico">${catIcon(c, 48)}</span>
                <span class="go-cb-txt"><span class="go-cb-title">${esc(c)}</span><span class="go-cb-sub">${esc(catBlurb(c) || subLabel(c))}</span></span>
                <span class="go-cb-chev">${svg('<polyline points="9 18 15 12 9 6"/>', 22)}</span>
            </button>`).join('');
        const miniHtml = miniCats.length ? `<div class="go-cards-mini">${miniCats.map(c => `
            <button class="go-mtile" data-cat="${esc(c)}" aria-label="${esc(c)}">
                <span class="go-mtile-ico">${catIcon(c, 46)}</span>
            </button>`).join('')}</div>` : '';
        cards.innerHTML = bigHtml + miniHtml;
        cards.onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) openCategory(b.dataset.cat); };
    }

    // Drill into one category's items (second screen).
    function openCategory(cat) {
        activeCat = cat;
        activeSub = 'all';
        const title = $('goCatTitle'); if (title) title.textContent = cat;
        renderItems();
        refreshStepControls();
        $('goHome').classList.add('go-hidden');
        $('goCatView').classList.remove('go-hidden');
        renderCartBar();
        window.scrollTo(0, 0);
    }
    function backToHome() {
        $('goCatView').classList.add('go-hidden');
        $('goHome').classList.remove('go-hidden');
        renderHome();
        renderCartBar();
        window.scrollTo(0, 0);
    }

    function subcatsOf(cat) {
        const subs = [];
        catalog.filter(i => (i.category || 'Diğer') === cat).forEach(i => {
            const s = (i.subcategory || '').trim(); if (s && !subs.includes(s)) subs.push(s);
        });
        return subs;
    }

    function renderItems() {
        const items = catalog.filter(i => (i.category || 'Diğer') === activeCat);
        const namedSubs = subcatsOf(activeCat);
        if (activeSub !== 'all' && namedSubs.indexOf(activeSub) < 0) activeSub = 'all';

        // Subcategory filter chips (only when the category actually has them).
        let chips = '';
        if (namedSubs.length) {
            chips = `<div class="go-subchips">
                <button class="go-subchip ${activeSub === 'all' ? 'active' : ''}" data-sub="all">Tümü</button>
                ${namedSubs.map(s => `<button class="go-subchip ${activeSub === s ? 'active' : ''}" data-sub="${esc(s)}">${esc(s)}</button>`).join('')}
            </div>`;
        }

        // Body: when filtered to one sub, show that grid; otherwise group all.
        let body;
        if (activeSub !== 'all') {
            body = `<div class="go-grid">${items.filter(i => (i.subcategory || '').trim() === activeSub).map(cardHtml).join('')}</div>`;
        } else {
            const groups = [];
            items.forEach(i => { const s = (i.subcategory || '').trim(); if (!groups.includes(s)) groups.push(s); });
            body = groups.map(sub => {
                const subItems = items.filter(i => (i.subcategory || '').trim() === sub);
                const head = sub ? `<div class="go-subhead">${esc(sub)}</div>` : '';
                return head + `<div class="go-grid">${subItems.map(cardHtml).join('')}</div>`;
            }).join('');
        }

        $('goBody').innerHTML = `${chips}${body}`;
        bindBodyEvents();
    }

    // Availability window (admin-set HH:MM). Empty = always available.
    function availInfo(item) {
        const f = (item && item.availFrom || '').trim(), t = (item && item.availTo || '').trim();
        if (!f || !t) return { limited: false, available: true, window: '' };
        const toMin = s => { const p = String(s).split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); };
        const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
        const fm = toMin(f), tm = toMin(t);
        const ok = (fm <= tm) ? (nm >= fm && nm < tm) : (nm >= fm || nm < tm); // gece yarısını geçen aralık
        return { limited: true, available: ok, window: f + '–' + t };
    }

    function cardHtml(item) {
        const av = availInfo(item);
        const price = priceTag(item);
        const metaBits = [];
        if (item.eta) metaBits.push(`<span class="go-meta">${clockSvg}${esc(item.eta)}</span>`);
        if (av.limited) metaBits.push(`<span class="go-meta go-avail ${av.available ? '' : 'go-avail-off'}">🕒 ${esc(av.window)}</span>`);
        if (price) metaBits.push(price);
        return `<div class="go-card ${av.available ? '' : 'go-card-unavail'}" data-id="${esc(item.id)}">
            <div class="go-emoji">${esc(item.icon || '🛎️')}</div>
            <div class="go-info">
                <div class="go-name">${esc(item.name)}</div>
                ${item.description ? `<div class="go-desc">${esc(item.description)}</div>` : ''}
                ${metaBits.length ? `<div class="go-meta-row">${metaBits.join('')}</div>` : ''}
            </div>
            <div class="go-card-action" data-action-for="${esc(item.id)}"></div>
        </div>`;
    }

    function refreshStepControls() {
        document.querySelectorAll('.go-card-action').forEach(slot => {
            const id = slot.dataset.actionFor;
            const item = catalog.find(i => i.id === id);
            if (item && !availInfo(item).available) { slot.innerHTML = `<span class="go-unavail-tag">Saat dışı</span>`; return; }
            const line = cart.find(l => l.catalogId === id);
            if (line && line.qty > 0) {
                slot.innerHTML = `<div class="go-stepper"><button data-dec="${esc(id)}">−</button><span class="go-qty">${line.qty}</span><button data-inc="${esc(id)}">+</button></div>`;
            } else {
                slot.innerHTML = `<button class="go-add" data-add="${esc(id)}" aria-label="Ekle">+</button>`;
            }
        });
    }

    function bindBodyEvents() {
        $('goBody').onclick = (e) => {
            const sub = e.target.closest('[data-sub]');
            if (sub) { activeSub = sub.dataset.sub; renderItems(); refreshStepControls(); return; }
            const add = e.target.closest('[data-add]');
            const inc = e.target.closest('[data-inc]');
            const dec = e.target.closest('[data-dec]');
            if (add) return changeQty(add.dataset.add, +1);
            if (inc) return changeQty(inc.dataset.inc, +1);
            if (dec) return changeQty(dec.dataset.dec, -1);
        };
    }

    // Per-item "aynı anda en fazla adet" cap (admin-set), bounded by the global cap.
    function lineMax(l) { const m = Number(l && l.maxQty) || 0; return m > 0 ? Math.min(m, MAX_QTY) : MAX_QTY; }
    function capMsg(l) { return (Number(l && l.maxQty) || 0) > 0 ? `Bu talepten aynı anda en fazla ${l.maxQty} verilebilir.` : `Bir talepten en fazla ${MAX_QTY} adet.`; }

    // ── Cart mutations (with caps) ─────────────────────────────
    function changeQty(catalogId, delta) {
        const item = catalog.find(i => i.id === catalogId);
        if (!item) return;
        if (delta > 0) {
            const av = availInfo(item);
            if (!av.available) { toast('Bu talep yalnızca ' + av.window + ' saatleri arasında verilebilir.', true); return; }
        }
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
        refreshStepControls();
        renderCartBar();
        if ($('goSheet').classList.contains('show')) renderCart();
        if (delta > 0) { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} }
    }

    function renderCartBar() {
        const n = cartCount();
        const onCatalog = $('goTrackView').classList.contains('go-hidden');
        $('goCartBar').classList.toggle('show', n > 0 && onCatalog);
        $('goCbCount').textContent = n;
        $('goCbSub').textContent = cart.length + ' talep eklendi';
    }

    // ── Cart sheet ─────────────────────────────────────────────
    function openSheet() {
        if (!cart.length) return;
        renderCart();
        $('goBackdrop').classList.add('show');
        $('goSheet').classList.add('show');
        $('goSheet').setAttribute('aria-hidden', 'false');
    }
    function closeSheet() {
        $('goBackdrop').classList.remove('show');
        $('goSheet').classList.remove('show');
        $('goSheet').setAttribute('aria-hidden', 'true');
    }
    function setSubmitLabel(text) { const el = $('goSubmitLabel'); if (el) el.textContent = text; }
    function updateSubmitTotal() {
        const total = cartTotal();
        setSubmitLabel('Sipariş Ver' + (pricesOn() && total ? ' · ' + fmtPrice(total) : ''));
    }
    function renderCart() {
        const wrap = $('goCartList');
        if (!cart.length) { wrap.innerHTML = stateHtml('🛒', 'Sepetiniz boş', 'Listeden talep ekleyin.'); $('goSubmit').disabled = true; return; }
        $('goSubmit').disabled = false;
        updateSubmitTotal();
        wrap.innerHTML = cart.map((l, i) => `
            <div class="go-line" data-i="${i}">
                <div class="go-line-top">
                    <div class="go-line-emoji">${esc(l.icon || '🛎️')}</div>
                    <div class="go-line-main">
                        <div class="go-line-name">${esc(l.name)}</div>
                        <div class="go-line-cat">${esc(l.category || '')}${(pricesOn() && priceOf(l)) ? ' · ' + esc(fmtPrice(priceOf(l))) : ''}</div>
                    </div>
                    ${(pricesOn() && priceOf(l)) ? `<div class="go-line-sub">${esc(fmtPrice(priceOf(l) * l.qty))}</div>` : ''}
                    <button class="go-line-del" data-del="${i}" aria-label="Sil">🗑</button>
                </div>
                <div class="go-line-controls">
                    <div class="go-stepper"><button data-cdec="${i}">−</button><span class="go-qty">${l.qty}</span><button data-cinc="${i}">+</button></div>
                </div>
                <div class="go-line-fields">
                    <div class="go-row2">
                        <div class="go-field"><label>Tercih edilen saat (opsiyonel)</label><input type="time" data-time="${i}" value="${esc(l.preferredTime || '')}"></div>
                    </div>
                    <div class="go-field"><label>Not (opsiyonel)</label><input type="text" data-note="${i}" maxlength="160" placeholder="Örn. 2 büyük havlu" value="${esc(l.note || '')}"></div>
                </div>
            </div>`).join('');
        wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { cart.splice(+b.dataset.del, 1); saveCart(); refreshStepControls(); renderCartBar(); renderCart(); });
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
        saveCart(); refreshStepControls(); renderCartBar();
        if (!cart.length) { closeSheet(); return; }
        renderCart();
    }

    // ── Anti-spam gate ─────────────────────────────────────────
    function cooldownLeft() {
        let until = 0;
        try { until = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10); } catch (e) {}
        return Math.max(0, until - Date.now());
    }
    function canSubmit() {
        if (!cart.length) return { ok: false };
        const cd = cooldownLeft();
        if (cd > 0) return { ok: false, msg: `Çok hızlı! Lütfen ${Math.ceil(cd / 1000)} sn sonra tekrar deneyin.` };
        if (activeOrderStatus === 'pending') return { ok: false, route: true, msg: 'Zaten onay bekleyen bir talebiniz var. Önce o sonuçlansın 🙏' };
        return { ok: true };
    }

    // ── Submit ─────────────────────────────────────────────────
    function submitOrder() {
        if (!cart.length || !sessionUid) return;
        const gate = canSubmit();
        if (!gate.ok) {
            if (gate.msg) toast(gate.msg, true);
            if (gate.route) { closeSheet(); if (currentOrderId) subscribeOrder(currentOrderId); }
            return;
        }
        if (!ROOM) {
            const r = (prompt('Oda numaranızı girin:') || '').trim().slice(0, 40);
            if (!r) { toast('Oda numarası gerekli.', true); return; }
            ROOM = r; const rl = $('goRoomLabel'); if (rl) { rl.style.display = 'inline-block'; rl.textContent = 'Oda ' + ROOM; }
        }
        const btn = $('goSubmit');
        btn.disabled = true; setSubmitLabel('Gönderiliyor...');

        // Guest name is resolved staff-side from the in-house guest for the room
        // (CRM/PMS), so the guest never types it here.
        const guestName = '';
        const items = cart.map((l, idx) => ({
            id: 'i' + idx + '_' + Date.now().toString(36),
            catalogId: l.catalogId || '',
            name: String(l.name || '').slice(0, 120),
            category: String(l.category || '').slice(0, 60),
            icon: String(l.icon || '🛎️').slice(0, 8),
            department: String(l.department || '').slice(0, 60),
            price: priceOf(l),
            qty: Math.min(lineMax(l), Math.max(1, l.qty || 1)),
            note: String(l.note || '').slice(0, 160),
            preferredTime: String(l.preferredTime || '').slice(0, 10),
            status: 'pending'
        }));
        const total = items.reduce((s, it) => s + (Number(it.price) || 0) * it.qty, 0);

        const finishOk = (id) => {
            currentOrderId = id;
            lastStatus = null; miniDismissed = false;
            try { localStorage.setItem(ORDER_KEY, id); } catch (e) {}
            try { localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS)); } catch (e) {}
            cart = []; saveCart();
            closeSheet();
            btn.disabled = false; setSubmitLabel('Sipariş Ver');
            toast('Talebiniz alındı! 🎉' + (DEMO ? ' (demo)' : ''));
            subscribeOrder(id, true);
        };
        const finishErr = (err) => {
            console.error('order submit failed', err);
            btn.disabled = false; setSubmitLabel('Sipariş Ver');
            toast('Gönderilemedi. Tekrar deneyin.', true);
        };

        if (DEMO) {
            const id = 'demo' + Date.now().toString(36);
            saveDemoOrder({ id, tenantId: TENANT, room: ROOM, guestName, sessionUid: 'demo', items, itemCount: items.length, total, currency: config.currency, showPrices: pricesOn(), createdAtMs: Date.now(), cancelled: false });
            finishOk(id);
            return;
        }

        db.collection('guestOrders').add({
            tenantId: TENANT, room: ROOM, guestName, sessionUid,
            status: 'pending', items, itemCount: items.length,
            total: total, currency: config.currency || '₺', showPrices: pricesOn(),
            statusLog: [{ status: 'pending', at: Date.now(), by: 'guest' }],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then(ref => finishOk(ref.id)).catch(finishErr);
    }

    // ── Tracking ───────────────────────────────────────────────
    // On reload, resume an active order quietly: stay on the home screen and
    // show the floating mini-tracker (don't hijack into the detail view).
    function resumeOrder() {
        let saved = null;
        try { saved = localStorage.getItem(ORDER_KEY); } catch (e) {}
        if (saved) { lastStatus = null; subscribeOrder(saved, false); }
    }
    // openDetail: open the full detail view on the first update (used right
    // after the guest places an order); otherwise just power the mini-tracker.
    function subscribeOrder(orderId, openDetail) {
        if (orderUnsub) { orderUnsub(); orderUnsub = null; }
        miniDismissed = false;
        if (DEMO) { subscribeDemo(orderId, openDetail); return; }
        currentOrderId = orderId;
        let first = true;
        orderUnsub = db.collection('guestOrders').doc(orderId).onSnapshot(doc => {
            if (!doc.exists) { clearActive(); return; }
            const order = Object.assign({ id: doc.id }, doc.data());
            onOrderUpdate(order, first && openDetail);
            first = false;
        }, err => { console.error('track failed', err); });
    }

    // Header bell + bottom-nav badge mirror whether there's a live order.
    function setBellDot(on) { const d = $('goBellDot'); if (d) d.style.display = on ? '' : 'none'; }

    // Single entry point for every order change (real or demo).
    function onOrderUpdate(order, openDetailNow) {
        const prev = lastStatus;
        currentOrder = order;
        currentOrderId = order.id;
        activeOrderStatus = order.status;
        setBellDot(order.status !== 'completed' && order.status !== 'cancelled');
        if (order.status === 'completed' || order.status === 'cancelled') {
            try { localStorage.removeItem(ORDER_KEY); } catch (e) {}
        }
        if (prev && prev !== order.status) notifyStatus(order.status);
        lastStatus = order.status;
        if (openDetailNow) showTrackingView();
        else if (trackVisible()) renderTracking(order);
        renderMini(order);
    }
    function clearActive() {
        currentOrder = null; activeOrderStatus = null; lastStatus = null;
        setBellDot(false);
        renderMini(null);
        if (trackVisible()) showCatalogView();
    }

    function trackVisible() { return !$('goTrackView').classList.contains('go-hidden'); }
    function setBnav(show) { const n = $('goBnav'); if (n) n.style.display = show ? '' : 'none'; }
    function setNavActive(key) {
        const n = $('goBnav'); if (!n) return;
        n.querySelectorAll('.go-bn').forEach(x => x.classList.toggle('active', x.dataset.nav === key));
    }
    function showTrackingView() {
        if (currentOrder) renderTracking(currentOrder);
        $('goGateView').classList.add('go-hidden');
        $('goCatalogView').classList.add('go-hidden');
        $('goTrackView').classList.remove('go-hidden');
        $('goCartBar').classList.remove('show');
        setBnav(true);
        renderMini(currentOrder);
        window.scrollTo(0, 0);
    }
    function showCatalogView() {
        $('goGateView').classList.add('go-hidden');
        $('goTrackView').classList.add('go-hidden');
        $('goCatalogView').classList.remove('go-hidden');
        setBnav(true);
        setNavActive('home');
        renderCartBar();
        renderMini(currentOrder);
        window.scrollTo(0, 0);
    }

    // ── Verification gate (surname + room) ─────────────────────
    function showGateView() {
        $('goCatalogView').classList.add('go-hidden');
        $('goTrackView').classList.add('go-hidden');
        $('goGateView').classList.remove('go-hidden');
        $('goCartBar').classList.remove('show');
        $('goMini').classList.remove('show');
        setBnav(false);
        const roomInput = $('goGateRoom');
        if (roomInput && ROOM) roomInput.value = ROOM;
        setTimeout(() => { const s = $('goGateSurname'); if (s) s.focus(); }, 120);
    }
    async function doVerify() {
        const surname = ($('goGateSurname').value || '').trim();
        const room = ($('goGateRoom').value || '').trim().slice(0, 40);
        const errEl = $('goGateErr');
        const setErr = (m) => { errEl.textContent = m || ''; };
        if (surname.length < 2) { setErr('Lütfen soyadınızı girin.'); return; }
        if (!room) { setErr('Lütfen oda numaranızı girin.'); return; }
        setErr('');
        const btn = $('goGateBtn'), lbl = $('goGateBtnLabel');
        btn.disabled = true; lbl.textContent = 'Kontrol ediliyor...';
        const fail = (m) => { btn.disabled = false; lbl.textContent = 'Doğrula & Devam Et'; setErr(m); try { navigator.vibrate && navigator.vibrate(80); } catch (e) {} };
        const ok = () => {
            ROOM = room; recomputeKeys(); loadCart(); setVerified();
            const rl = $('goRoomLabel'); if (rl) { rl.style.display = 'inline-block'; rl.textContent = 'Oda ' + ROOM; }
            btn.disabled = false; lbl.textContent = 'Doğrula & Devam Et';
            renderAll(); showCatalogView(); resumeOrder();
        };
        try {
            if (DEMO) { await new Promise(r => setTimeout(r, 450)); ok(); return; }
            const doc = await db.collection('roomAccess').doc(TENANT + '__' + room).get();
            if (!doc.exists || doc.data().open !== true) {
                fail('Bu oda şu anda talebe kapalı görünüyor. Aktif konaklamanız yoksa lütfen resepsiyona başvurun.');
                return;
            }
            const keys = doc.data().nameKeys || [];
            let matched = false;
            for (const t of nameTokens(surname)) {
                const h = await sha16(TENANT + '|' + room + '|' + t);
                if (keys.indexOf(h) !== -1) { matched = true; break; }
            }
            if (!matched) { fail('Soyadı bu oda ile eşleşmedi. Lütfen rezervasyondaki soyadınızı girin.'); return; }
            ok();
        } catch (e) {
            console.error('verify failed', e);
            fail('Doğrulama yapılamadı. Lütfen tekrar deneyin.');
        }
    }

    // Toast + haptic feedback when the status advances (so the guest notices
    // even while browsing the home screen).
    function notifyStatus(status) {
        const map = {
            confirmed: 'Talebiniz onaylandı ✅',
            in_progress: 'Ekibimiz talebinizi hazırlıyor 🛎️',
            completed: 'Talebiniz tamamlandı 🎉',
            cancelled: 'Talebiniz iptal edildi'
        };
        if (map[status]) toast(map[status]);
        try { navigator.vibrate && navigator.vibrate(status === 'completed' ? [60, 40, 60] : 40); } catch (e) {}
    }

    // Compact, dynamic floating status pill shown on the home screen.
    const MINI = {
        pending:     { t: 'Talebiniz alındı',        w: 12, ico: '⏳' },
        confirmed:   { t: 'Onaylandı, hazırlanıyor',  w: 45, ico: '✅' },
        in_progress: { t: 'Ekibimiz hazırlıyor',      w: 78, ico: '🛎️' },
        completed:   { t: 'Talebiniz tamamlandı 🎉',  w: 100, ico: '🎉' }
    };
    function renderMini(order) {
        const el = $('goMini');
        const onCatalog = !trackVisible();
        const visible = !!order && !!MINI[order.status] && order.status !== 'cancelled' && !miniDismissed && onCatalog;
        el.classList.toggle('show', visible);
        el.classList.toggle('is-completed', visible && order.status === 'completed');
        if (!visible) { el.innerHTML = ''; return; }
        const m = MINI[order.status];
        const done = order.status === 'completed';
        // Progress: a continuous creep in demo (so it feels live); step-based otherwise.
        let width = m.w, eta = '';
        if (done) { width = 100; eta = 'Hazır'; }
        else if (DEMO && order.createdAtMs) {
            const elapsed = Date.now() - order.createdAtMs;
            width = Math.min(98, Math.max(8, Math.round(elapsed / DEMO_TOTAL * 100)));
            const left = Math.max(0, DEMO_TOTAL - elapsed);
            eta = left >= 60000 ? '~' + Math.ceil(left / 60000) + ' dk' : '~' + Math.ceil(left / 1000) + ' sn';
        } else eta = (STATUS[order.status] || {}).label || '';
        const n = (order.items || []).length;
        el.innerHTML = `
            <span class="go-mini-ico ${done ? '' : 'pulse'}">${esc(m.ico)}</span>
            <div class="go-mini-body">
                <div class="go-mini-top"><b>${esc(m.t)}</b><span class="go-mini-eta">${esc(eta)}</span></div>
                <div class="go-mini-bar"><span style="width:${width}%"></span></div>
            </div>
            ${done ? `<span class="go-mini-x" id="goMiniX" aria-label="Kapat">✕</span>`
                   : `<span class="go-mini-chev">${svg('<polyline points="9 18 15 12 9 6"/>', 18)}</span>`}`;
        const x = $('goMiniX');
        if (x) x.onclick = (e) => { e.stopPropagation(); miniDismissed = true; renderMini(currentOrder); };
    }

    function renderTracking(order) {
        const st = STATUS[order.status] || STATUS.pending;
        const cancelled = order.status === 'cancelled';
        const stepIdx = FLOW.indexOf(order.status);
        const heroSub = cancelled ? 'Bu talep iptal edildi.'
            : (order.status === 'completed' ? 'Tüm talepleriniz tamamlandı. Teşekkürler!'
            : 'Talebiniz personelimize iletildi. Durumu buradan canlı takip edebilirsiniz.');
        const cur = order.currency || '₺';
        const showP = !!order.showPrices && Number(order.total) > 0;
        const fmtP = n => cur + Number(n || 0).toLocaleString('tr-TR');
        const steps = cancelled ? '' : `<div class="go-steps">${FLOW.map((s, i) => {
            const cls = i < stepIdx ? 'done' : (i === stepIdx ? 'active' : 'todo');
            const logEntry = (order.statusLog || []).filter(l => l.status === s).pop();
            const time = logEntry ? timeFromMs(logEntry.at) : '';
            return `<div class="go-step ${cls}"><div class="go-step-dot">${i < stepIdx ? '✓' : (i + 1)}</div>
                <div class="go-step-body"><div class="go-step-title">${esc(STATUS[s].label)}</div>${time ? `<div class="go-step-time">${esc(time)}</div>` : ''}</div></div>`;
        }).join('')}</div>`;
        const items = (order.items || []).map(it => {
            const ist = STATUS[it.status] || STATUS.pending;
            const bits = [it.qty > 1 ? it.qty + ' adet' : '', it.preferredTime ? '🕐 ' + it.preferredTime : '', it.note];
            if (showP && Number(it.price) > 0) bits.push(fmtP(Number(it.price) * (it.qty || 1)));
            const meta = bits.filter(Boolean).join(' · ');
            return `<div class="go-titem"><div class="go-emoji">${esc(it.icon || '🛎️')}</div>
                <div class="go-info"><div class="go-name">${esc(it.name)}</div>${meta ? `<div class="go-meta">${esc(meta)}</div>` : ''}</div>
                <span class="go-pill ${esc(it.status || 'pending')}">${esc(ist.label)}</span></div>`;
        }).join('');
        const canCancel = order.status === 'pending';
        const roomTxt = order.room ? 'Oda ' + order.room : '';
        $('goTrackBody').innerHTML = `
            <button class="go-back" id="goBack">${svg('<polyline points="15 18 9 12 15 6"/>', 17)} Ana sayfa</button>
            <div class="go-track-hero"><div class="go-track-emoji">${esc(st.emoji)}</div><h2>${esc(st.label)}</h2><p>${esc(heroSub)}</p>
                ${roomTxt ? `<div class="go-track-total">${esc(roomTxt)}</div>` : ''}
                ${showP ? `<div class="go-track-total">Toplam: <b>${esc(fmtP(order.total))}</b></div>` : ''}</div>
            ${steps}
            <div class="go-track-items"><h3>Talepleriniz (${(order.items || []).length})</h3>${items}</div>
            <div class="go-track-actions">
                ${canCancel ? `<button class="go-btn-ghost go-btn-danger" id="goCancel">Talebi İptal Et</button>` : ''}
                <button class="go-btn-ghost" id="goNew">Ana Sayfaya Dön</button>
            </div>`;
        const cancelBtn = $('goCancel');
        if (cancelBtn) cancelBtn.onclick = () => cancelOrder(order.id);
        $('goBack').onclick = () => showCatalogView();
        $('goNew').onclick = () => showCatalogView();
    }
    function timeFromMs(ms) {
        if (!ms) return '';
        try { return new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
    }

    function cancelOrder(orderId) {
        if (!confirm('Talebinizi iptal etmek istediğinize emin misiniz?')) return;
        if (DEMO) {
            const o = loadDemoOrder(orderId);
            if (o) { o.cancelled = true; saveDemoOrder(o); }
            if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
            if (o) onOrderUpdate(demoView(o), false);
            return;
        }
        db.collection('guestOrders').doc(orderId).update({ status: 'cancelled', updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
            .catch(err => { console.error(err); toast('İptal edilemedi.', true); });
    }

    // ── DEMO backend (localStorage + simulated flow ≈ 3 min) ───
    const DEMO_STEPS = [[0, 'pending'], [40000, 'confirmed'], [110000, 'in_progress'], [180000, 'completed']];
    const DEMO_TOTAL = 180000;
    function saveDemoOrder(o) { try { localStorage.setItem('go_demo_' + o.id, JSON.stringify(o)); } catch (e) {} }
    function loadDemoOrder(id) { try { return JSON.parse(localStorage.getItem('go_demo_' + id)); } catch (e) { return null; } }
    function demoView(o) {
        if (o.cancelled) return Object.assign({}, o, { status: 'cancelled', items: (o.items || []).map(it => Object.assign({}, it, { status: 'cancelled' })) });
        const e = Date.now() - (o.createdAtMs || Date.now());
        let status = 'pending'; const log = [];
        DEMO_STEPS.forEach(([t, s]) => { if (e >= t) { status = s; log.push({ status: s, at: (o.createdAtMs || 0) + t, by: t === 0 ? 'guest' : 'Personel' }); } });
        return Object.assign({}, o, { status, items: (o.items || []).map(it => Object.assign({}, it, { status })), statusLog: log });
    }
    function subscribeDemo(orderId, openDetail) {
        if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
        currentOrderId = orderId;
        let first = true;
        const tick = () => {
            const o = loadDemoOrder(orderId);
            if (!o) { clearActive(); if (demoTimer) clearInterval(demoTimer); return; }
            const view = demoView(o);
            onOrderUpdate(view, first && openDetail);
            first = false;
            if (view.status === 'completed' || view.status === 'cancelled') { if (demoTimer) { clearInterval(demoTimer); demoTimer = null; } }
        };
        tick();
        demoTimer = setInterval(tick, 1000);
    }

    // ── Misc ───────────────────────────────────────────────────
    function stateHtml(emoji, title, body) {
        return `<div class="go-state"><div class="go-state-emoji">${esc(emoji)}</div><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
    }
    function wireEvents() {
        $('goCartBar').onclick = openSheet;
        $('goSheetClose').onclick = closeSheet;
        $('goBackdrop').onclick = closeSheet;
        $('goSubmit').onclick = submitOrder;
        const ii = $('goInfoIc'); if (ii) ii.onclick = openInfoSheet;
        $('goInfoClose').onclick = closeInfoSheet;
        $('goInfoBackdrop').onclick = closeInfoSheet;
        $('goMini').onclick = () => { if (currentOrder) showTrackingView(); };
        $('goTrackIc').onclick = () => {
            if (currentOrder) showTrackingView();
            else toast('Henüz aktif bir talebiniz yok.');
        };
        const catBack = $('goCatBack'); if (catBack) catBack.onclick = backToHome;
        // Bottom guest nav: Ana Sayfa/QR → home, Siparişlerim/Bildirimler → tracking, Profil → otel bilgileri.
        const bnav = $('goBnav');
        if (bnav) bnav.onclick = (e) => {
            const b = e.target.closest('[data-nav]'); if (!b) return;
            const nav = b.dataset.nav;
            if (nav === 'home' || nav === 'qr') { showCatalogView(); backToHome(); }
            else if (nav === 'orders' || nav === 'notif') {
                if (currentOrder) { showTrackingView(); setNavActive(nav); }
                else toast('Henüz aktif bir talebiniz yok.');
            } else if (nav === 'profile') openInfoSheet();
        };
        $('goGateBtn').onclick = doVerify;
        // Surname auto-uppercases (Turkish-aware: i→İ, ı→I) and accepts letters only.
        const su = $('goGateSurname');
        if (su) su.addEventListener('input', () => {
            const start = su.selectionStart;
            su.value = su.value.toLocaleUpperCase('tr-TR').replace(/[^A-ZÇĞİÖŞÜ \-']/g, '');
            try { su.setSelectionRange(start, start); } catch (e) {}
        });
        ['goGateSurname', 'goGateRoom'].forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });
        });
    }

    // ── Go ─────────────────────────────────────────────────────
    if (typeof db === 'undefined' || typeof auth === 'undefined') {
        document.getElementById('goBody').innerHTML = '<div class="go-state"><div class="go-state-emoji">⚠️</div><h3>Yapılandırma hatası</h3></div>';
        return;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
