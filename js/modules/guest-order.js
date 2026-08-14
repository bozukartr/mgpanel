/* Hotizy — Misafir Hizmetleri (guest-order.html)
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

    // MAX_MOD_QTY: bir ekstranın en fazla kaç kez eklenebileceği. firestore.rules
    // validModifier'daki qty sınırıyla AYNI olmalı.
    const MAX_DISTINCT = 20, MAX_QTY = 10, MAX_MOD_QTY = 10, COOLDOWN_MS = 60 * 1000;

    // ── Config ─────────────────────────────────────────────────
    const DEFAULT_CONFIG = {
        hotelName: '', showPrices: false, currency: '₺',
        welcome: '', phone: '', wifiName: '', wifiPass: '', checkoutTime: '', breakfast: '', address: '', heroImage: ''
    };
    const DEMO_CONFIG = {
        hotelName: 'Grand Demo Otel', showPrices: true, currency: '₺',
        heroImage: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1100&q=80',
        welcome: t('guest.home.subtitle'),
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
        { category: 'Oda Servisi', name: 'Su', icon: '💧', eta: '15 dk', department: 'Yiyecek & İçecek' },
        { category: 'Oda Servisi', name: 'Çay / Kahve', icon: '☕', eta: '15-20 dk', price: 60, department: 'Yiyecek & İçecek' },
        { category: 'Oda Servisi', name: 'Meyve Tabağı', icon: '🍎', eta: '20-30 dk', price: 120, department: 'Yiyecek & İçecek' },
        { category: 'Oda Servisi', name: 'Atıştırmalık', icon: '🍫', eta: '20 dk', price: 80, department: 'Yiyecek & İçecek' },
        // Oda servisi akışının tamamını gösteren demo kalemi: seçenek (pişirme
        // derecesi) + gruplu içerikler (ekstra/çıkart) + adetli ekstra.
        {
            category: 'Oda Servisi', name: 'Cheeseburger', icon: '🍔', etaMin: 20, etaMax: 30, eta: '20-30 dk',
            price: 320, department: 'Yiyecek & İçecek',
            description: 'Dana köfte, cheddar, marul, domates, soğan · patates kızartması ile',
            options: [{ name: 'Az pişmiş', priceDelta: 0 }, { name: 'Orta', priceDelta: 0 }, { name: 'İyi pişmiş', priceDelta: 0 }],
            modifiers: [
                { name: 'Ekstra Cheddar', type: 'extra', priceDelta: 40, maxQty: 3 },
                { name: 'Ekstra Köfte', type: 'extra', priceDelta: 120, maxQty: 2 },
                { name: 'Barbekü Sos', type: 'extra', priceDelta: 25, group: 'Soslar', maxQty: 2 },
                { name: 'Ranch Sos', type: 'extra', priceDelta: 25, group: 'Soslar', maxQty: 2 },
                { name: 'Soğansız', type: 'remove', priceDelta: 0 },
                { name: 'Domatessiz', type: 'remove', priceDelta: 0 },
                { name: 'Marulsuz', type: 'remove', priceDelta: 0 }
            ]
        },
        { category: 'Teknik', name: 'Klima Sorunu', icon: '❄️', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'TV Sorunu', icon: '📺', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Wi-Fi Sorunu', icon: '📶', eta: '20 dk', department: 'Engineering' },
        { category: 'Resepsiyon', name: 'Uyandırma Servisi', icon: '⏰', eta: '—', department: 'Front Office' },
        { category: 'Resepsiyon', name: 'Taksi Çağır', icon: '🚕', eta: '10 dk', department: 'Front Office' },
        { category: 'Concierge', name: 'Havalimanı Transferi', icon: '🚐', eta: '—', department: 'Concierge' },
        { category: 'Concierge', name: 'Restoran Rezervasyonu', icon: '🍽️', eta: '—', department: 'Concierge' }
    ].map((d, i) => Object.assign({ id: 'demo-' + i, active: true, sortOrder: (i + 1) * 10 }, d));

    const DEMO_MENUS = [
        { name: 'Restoran Menüsü', pdfUrl: 'https://www.orimi.com/pdf-test.pdf' },
        { name: 'Oda Servisi Menüsü', pdfUrl: 'https://www.orimi.com/pdf-test.pdf' },
        { name: 'Spa & Wellness', pdfUrl: 'https://www.orimi.com/pdf-test.pdf' }
    ];
    // Para birimi başına ayrı grup (gerçek getGuestStay yanıtıyla aynı şekil) —
    // TRY (restoran) ve EUR (concierge) kalemlerinin ASLA karışmadığını
    // demo modunda da göstermek için bilerek iki farklı para birimi var.
    const DEMO_STAY = {
        checkIn: '2026-06-28', checkOut: '2026-07-04',
        folio: [
            {
                currency: 'TRY', total: 420, count: 2,
                items: [
                    { amount: 240, source: 'restaurant', tableName: 'Masa 12', createdAt: Date.now() - 3600000 },
                    { amount: 180, source: 'restaurant', tableName: 'Masa 4', createdAt: Date.now() - 90000000 }
                ]
            },
            {
                currency: 'EUR', total: 60, count: 1,
                items: [
                    { amount: 60, source: 'concierge', tableName: '', createdAt: Date.now() - 7200000 }
                ]
            }
        ],
        reservations: [
            { type: 'Restaurant', date: '2026-07-01', time: '20:00', status: 'Confirmed', resName: 'Lobi Restoran', pax: '2' },
            { type: 'Transfer', date: '2026-07-04', time: '11:00', status: 'Pending', from: 'Otel', to: 'Havalimanı', vehicle: 'VIP Araç' }
        ]
    };

    // Durum etiketleri artık ÇEVİRİ ANAHTARI taşır. `label`/`sub` birer
    // GETTER: mevcut tüm çağrı yerleri (st.label, st.sub) hiç değişmeden
    // çalışır, ama metin OKUNDUĞU AN aktif dilden çözülür. Emoji dilden
    // bağımsızdır, olduğu gibi kalır.
    function statusEntry(key, emoji) {
        return { emoji: emoji, get label() { return t(key); }, get sub() { return t(key + 'Sub'); } };
    }
    const STATUS = {
        pending:     statusEntry('guest.status.pending', '⏳'),
        confirmed:   statusEntry('guest.status.confirmed', '✅'),
        in_progress: statusEntry('guest.status.inProgress', '🛎️'),
        completed:   statusEntry('guest.status.completed', '🎉'),
        cancelled:   statusEntry('guest.status.cancelled', '✖️')
    };
    const FLOW = ['pending', 'confirmed', 'in_progress', 'completed'];

    // ── State ──────────────────────────────────────────────────
    let catalog = [], cart = [], sessionUid = null;
    let myOrders = [], ordersUnsub = null, lastStatusMap = {};
    // Kalem-seviyesi tamamlanma tespiti (değerlendirme modalı tetikleyicisi)
    // — lastStatusMap sipariş-seviyesindeydi, kalem geçişlerini hiç izlemiyordu.
    let activeCat = 'all', activeDept = '', searchTerm = '', currentTab = 'home';
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

    // Ad normalizasyonu — arama (renderItems) için kullanılır.
    function norm(s) {
        return String(s == null ? '' : s).trim().toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's')
            .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o')
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
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
        temiz: t('guest.dept.housekeeping'),
        konfor: t('guest.dept.concierge'),
        food: 'Yiyecek ve içecek siparişleriniz.',
        teknik: t('guest.dept.engineering')
    };
    const catBlurb = cat => CAT_BLURB[catKind(cat)] || '';

    // ── Departman → görsel/ad (ana ekran kartları) ───────────────
    // BİLİNÇLİ OLARAK catKind()'dan AYRI: services sekmesindeki kategori
    // serbest metindir (admin istediğini yazabilir — ör. "Transfer"), bu
    // yüzden ana ekranın 3 büyük kartı için görsel eşlemesini kategoriye göre
    // yapmak hep eksik/yanlış kalıyordu (regex hiçbirine uymayan bir kategori
    // görselsiz düz renkte kalıyordu). Departman SABİT bir kümedir
    // (Housekeeping/Front Desk/Engineering/Yiyecek & İçecek/Concierge) —
    // ana ekran kartları bu yüzden kategori değil DEPARTMAN'a göre gruplanır.
    const DEPT_KIND_DEFS = {
        housekeeping: { label: 'Kat Hizmetleri', img: 'housekeeping_button.webp', color: '#33574a' },
        frontdesk: { label: 'Ön Büro', img: 'frontoffice_button.webp', color: '#1f3a5c' },
        concierge: { label: 'Concierge', img: 'vip_transfer_button.webp', color: '#5c5470' },
        engineering: { label: 'Teknik Servis', img: '', color: '#33485c' },
        fnb: { label: 'Yiyecek & İçecek', img: 'fnb_button.webp', color: '#7a5a44' }
    };
    // Kalemin departmanını çözer: açık `department` alanı varsa o, yoksa
    // (admin panelinde "Otomatik") kategoriden tahmin — order-bridge.js'teki
    // DEPT_BY_CAT ile aynı ruhta, sunucu tarafıyla tutarlı.
    const CAT_DEPT_GUESS = {
        'Temizlik': 'Housekeeping', 'Konfor': 'Housekeeping', 'Kat Hizmetleri': 'Housekeeping',
        'Yiyecek & İçecek': 'Yiyecek & İçecek', 'Yiyecek-İçecek': 'Yiyecek & İçecek', 'Oda Servisi': 'Yiyecek & İçecek',
        'Teknik': 'Engineering', 'Teknik Servis': 'Engineering',
        'Resepsiyon': 'Front Desk', 'Front Office': 'Front Desk', 'Concierge': 'Concierge'
    };
    function deptOf(item) {
        const explicit = String((item && item.department) || '').trim();
        if (explicit) return explicit;
        return CAT_DEPT_GUESS[String((item && item.category) || '').trim()] || '';
    }
    // Departman metnini SABİT 5 anahtardan birine indirger (F&B için Turkish-
    // locale güvenli isFnbDept/firebase-config.js kullanılır; diğerleri
    // ASCII olduğundan düz alt string eşleşmesi yeterli ve güvenlidir).
    function deptKindKey(dept) {
        const d = String(dept || '').trim();
        if (!d) return '';
        if (typeof isFnbDept === 'function' && isFnbDept(d)) return 'fnb';
        const low = d.toLowerCase();
        if (low.indexOf('housekeep') !== -1 || low.indexOf('kat hizmet') !== -1) return 'housekeeping';
        if (low.indexOf('concierge') !== -1 || low.indexOf('konsiyerj') !== -1) return 'concierge';
        if (low.indexOf('front') !== -1 || low.indexOf('resepsiyon') !== -1) return 'frontdesk';
        if (low.indexOf('engineer') !== -1 || low.indexOf('teknik') !== -1) return 'engineering';
        return '';
    }
    function itemDeptKey(item) { return deptKindKey(deptOf(item)); }

    // ── Cart persistence ───────────────────────────────────────
    function loadCart() {
        try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
        if (!Array.isArray(cart)) cart = [];
    }
    function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {} }
    const cartCount = () => cart.reduce((n, l) => n + (l.qty || 0), 0);

    // ── Verification / guest name ──────────────────────────────
    // Doğrulamanın SUNUCUDAKİ kanıtı `verifiedGuestSessions/{uid}` dokümanıdır
    // (bkz. functions/index.js:verifyGuestIdentity) — yani anonim oturumun
    // UID'sine bağlıdır. Buradaki yerel bayrak ise yalnızca "kapıyı tekrar
    // açma" kararı için tutulur; eskiden SADECE bir son-kullanma zamanıydı ve
    // UID ile hiç bağlanmamıştı. Anonim UID döndüğünde (iOS Safari/ITP depolama
    // tahliyesi, QR'ın uygulama-içi tarayıcıda açılması, oturumun düşmesi)
    // istemci hâlâ "doğrulandım" sanıyor, ama sunucudaki oturum dokümanı yeni
    // UID için YOK — sipariş yazımı firestore.rules tarafından reddediliyor ve
    // misafir "Gönderilemedi" döngüsünde kilitleniyordu. Bayrak artık UID ile
    // birlikte saklanır; UID değişmişse doğrulama geçersiz sayılır.
    function currentUid() {
        if (DEMO) return sessionUid || '';
        try { return (auth.currentUser && auth.currentUser.uid) || sessionUid || ''; } catch (e) { return sessionUid || ''; }
    }
    function readVerify() {
        let raw = '';
        try { raw = localStorage.getItem(VERIFY_KEY) || ''; } catch (e) { return null; }
        if (!raw) return null;
        if (raw.charAt(0) === '{') { try { return JSON.parse(raw); } catch (e) { return null; } }
        // Eski biçim (düz zaman damgası): UID bilgisi yok. Geçerliyse mevcut
        // UID'ye damgalanır — bu dağıtımda hâlâ doğrulanmış olan misafirler
        // gereksiz yere tekrar sorgulanmasın. UID gerçekten döndüyse sipariş
        // yazımı reddedilir ve aşağıdaki kurtarma yolu kapıyı yeniden açar.
        const exp = parseInt(raw, 10) || 0;
        return exp > Date.now() ? { u: currentUid(), e: exp } : null;
    }
    function isVerified() {
        if (!ROOM) return false;
        const v = readVerify();
        if (!v || !(v.e > Date.now())) return false;
        const uid = currentUid();
        // UID henüz bilinmiyorsa (anonim giriş tamamlanmadı) engelleme —
        // submitOrder zaten sessionUid olmadan çalışmaz.
        if (!uid || !v.u) return true;
        return v.u === uid;
    }
    function setVerified() {
        try { localStorage.setItem(VERIFY_KEY, JSON.stringify({ u: currentUid(), e: Date.now() + 12 * 3600 * 1000 })); } catch (e) {}
    }
    function clearVerified() { try { localStorage.removeItem(VERIFY_KEY); } catch (e) {} }
    function loadGuestName() { try { guestName = localStorage.getItem(GUEST_KEY) || ''; } catch (e) { guestName = ''; } }
    function setGuestName(n) {
        guestName = String(n || '').trim();
        try { guestName ? localStorage.setItem(GUEST_KEY, guestName) : localStorage.removeItem(GUEST_KEY); } catch (e) {}
    }
    // Doğrulamada girilen soyadı saklanır — Konaklama sekmesi gibi sonradan
    // sunucu-taraflı yeniden doğrulama gerektiren çağrılarda (getGuestStay)
    // tekrar kullanılır.
    function loadSurname() { try { return localStorage.getItem(SURNAME_KEY) || ''; } catch (e) { return ''; } }
    function setSurname(s) {
        s = String(s || '').trim();
        try { s ? localStorage.setItem(SURNAME_KEY, s) : localStorage.removeItem(SURNAME_KEY); } catch (e) {}
    }

    // ── Price ──────────────────────────────────────────────────
    function priceOf(it) { const p = Number(it && it.price) || 0; return p > 0 ? p : 0; }
    function pricesOn() { return !!config.showPrices; }
    function fmtPrice(n) { return config.currency + Number(n || 0).toLocaleString('tr-TR'); }
    function fmtDelta(n) { n = Number(n) || 0; return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtPrice(Math.abs(n)); }
    function cartTotal() { return cart.reduce((s, l) => s + priceOf(l) * (l.qty || 0), 0); }

    // Eski katalog kayıtları options: string[] idi (fiyat farkı yoktu); yeni
    // kayıtlar options: {name,priceDelta}[] — request-catalog.js'teki
    // normalizeOption ile AYNI mantık, ikisi birbirinden bağımsız (admin ve
    // misafir ayrı JS paketleri) ama şema hep tutarlı kalmalı.
    function normalizeOption(o) {
        return (o && typeof o === 'object')
            ? { name: String(o.name || '').trim(), priceDelta: Number(o.priceDelta) || 0 }
            : { name: String(o || '').trim(), priceDelta: 0 };
    }
    function optionsOf(item) { return Array.isArray(item && item.options) ? item.options.map(normalizeOption) : []; }
    function optionDelta(item, name) {
        if (!name) return 0;
        const o = optionsOf(item).find(x => x.name === name);
        return o ? o.priceDelta : 0;
    }

    // Çıkarılabilir/ekstra ürün bileşenleri (ör. "Soğansız", "Ekstra Peynir")
    // — options'tan farkı: misafir BİRDEN FAZLASINI seçebilir. request-
    // catalog.js'teki normalizeModifier ile AYNI şema.
    //   group  : aynı başlık altında toplanan bileşenler (ör. "Soslar").
    //            Boşsa tipe göre varsayılan başlığa düşer — grupsuz eski
    //            kayıtlar hiçbir değişiklik olmadan çalışmaya devam eder.
    //   maxQty : yalnızca 'extra' için anlamlı (2× Ekstra Peynir); yoksa 1,
    //            yani bugünkü aç/kapa davranışı.
    function normalizeModifier(m) {
        const type = (m && m.type) === 'extra' ? 'extra' : 'remove';
        const mx = Math.max(1, Math.min(MAX_MOD_QTY, Number(m && m.maxQty) || 1));
        return {
            name: String((m && m.name) || '').trim(),
            type: type,
            priceDelta: Number(m && m.priceDelta) || 0,
            group: String((m && m.group) || '').trim(),
            maxQty: type === 'extra' ? mx : 1
        };
    }
    function modifiersOf(item) { return Array.isArray(item && item.modifiers) ? item.modifiers.map(normalizeModifier) : []; }
    function hasModifiers(item) { return modifiersOf(item).length > 0; }
    // Seçim listesi iki biçimde gelebilir: ['Ad'] (eski sepet/sipariş kayıtları)
    // veya [{name, qty}] (yeni). Tek bir normalize edilmiş biçime indirgenir ki
    // fiyat hesabı her iki veriyle de doğru çalışsın.
    function selList(sel) {
        if (!Array.isArray(sel)) return [];
        return sel.map(s => (s && typeof s === 'object')
            ? { name: String(s.name || '').trim(), qty: Math.max(1, Number(s.qty) || 1) }
            : { name: String(s || '').trim(), qty: 1 }).filter(s => s.name);
    }
    function selQty(sel, name) { const f = selList(sel).find(s => s.name === name); return f ? f.qty : 0; }
    function modifiersDelta(item, sel) {
        const chosen = selList(sel); if (!chosen.length) return 0;
        const all = modifiersOf(item);
        return chosen.reduce((s, c) => { const m = all.find(x => x.name === c.name); return s + (m ? m.priceDelta * c.qty : 0); }, 0);
    }
    // Başlıklı bölümler: özel grup adı varsa o, yoksa tipe göre varsayılan.
    // Sıra katalogdaki sırayı korur (admin'in dizdiği gibi görünür).
    function modifierGroups(item) {
        const groups = [];
        modifiersOf(item).forEach(m => {
            if (!m.name) return;
            const key = m.group || (m.type === 'extra' ? t('guest.item.groupExtras') : t('guest.item.groupRemovals'));
            let g = groups.find(x => x.key === key);
            if (!g) { g = { key: key, items: [] }; groups.push(g); }
            g.items.push(m);
        });
        return groups;
    }
    // Kalem metninde ekstra adedi: "+ Ekstra Peynir ×2".
    function modLabel(m, qty) {
        return (m.type === 'extra' ? '+ ' : '− ') + m.name + (qty > 1 ? ' ×' + qty : '');
    }

    // ══ Tahmini teslim (EDT) ══════════════════════════════════════════
    // Katalogda süre ESKİDEN serbest metindi ('15-30 dk'); artık etaMin/etaMax
    // DAKİKA olarak tutulur. Eski metin okunurken ayrıştırıldığı için admin
    // hiçbir kayda dokunmadan da EDT çalışır (bkz. request-catalog.js).
    // Hesap tamamen istemci tarafında: yeni yazım, yeni koleksiyon, yeni
    // Cloud Function YOK — pencere siparişin createdAt'ından türetilir.
    const EDT_SLIDE_GRACE_MS = 2 * 60000;   // pencere sonuna bu kadar kala kayar
    const EDT_SLIDE_STEP_MS = 5 * 60000;    // kaydığında yeni pencerenin genişliği
    function parseEtaText(txt) {
        const nums = String(txt == null ? '' : txt).match(/\d+/g);
        if (!nums || !nums.length) return null;
        const a = parseInt(nums[0], 10);
        const b = nums.length > 1 ? parseInt(nums[1], 10) : a;
        if (!isFinite(a) || a <= 0) return null;
        return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    // Katalog kalemi ya da (gönderim anında damgalanmış) sipariş kalemi için
    // dakika cinsinden süre aralığı.
    function etaMinutes(src) {
        const lo = Number(src && src.etaMin) || 0, hi = Number(src && src.etaMax) || 0;
        if (lo > 0) return { min: lo, max: Math.max(lo, hi || lo) };
        return parseEtaText(src && src.eta);
    }
    // Pencerenin SONUNA EDT_SLIDE_GRACE_MS kala bir sonraki kademeye kayar:
    // 14:00–14:10 penceresinde saat 14:08'i geçince 14:10–14:15 olur. Döngü
    // tekrarlanabilir (çok geciken talepte kademe kademe ilerler); guard,
    // bozuk bir base değerinde sonsuz döngüyü engeller.
    function slideWindow(start, end, now) {
        let guard = 0;
        while (now >= end - EDT_SLIDE_GRACE_MS && guard++ < 500) {
            start = end; end = start + EDT_SLIDE_STEP_MS;
        }
        return { start: start, end: end };
    }
    function etaWindow(baseMs, src, now) {
        const m = etaMinutes(src);
        if (!baseMs || !m) return null;
        return slideWindow(baseMs + m.min * 60000, baseMs + m.max * 60000, now == null ? Date.now() : now);
    }
    function fmtWindow(w) { return w ? clock(w.start) + ' – ' + clock(w.end) : ''; }
    // Pencerenin bitişine kalan süre ("8 dk"). Pencere içindeyken bile
    // pozitiftir (slideWindow bitişe 2 dk kala kaydırdığı için 0'a düşmez).
    function etaRemainText(w, now) {
        if (!w) return '';
        const left = Math.round((w.end - (now == null ? Date.now() : now)) / 60000);
        return left > 0 ? t('guest.eta.remaining', { n: left }) : t('guest.eta.soon');
    }
    // Kalemin teslim bilgisi: tamamlandıysa GERÇEK saat, iptalse yok,
    // aksi halde kayan EDT penceresi.
    function itemEta(order, it, now) {
        const st = (it && it.status) || 'pending';
        if (st === 'cancelled') return null;
        if (st === 'completed') {
            const log = (order.statusLog || []).filter(l => l.status === 'completed').pop();
            return { done: true, at: log ? log.at : 0 };
        }
        return etaWindow(tsMs(order), it, now);
    }
    // Sipariş penceresi = AÇIK kalemlerin birleşimi (en erken başlangıç,
    // en geç bitiş). Hepsi kapandıysa null.
    function orderEta(order, now) {
        let start = 0, end = 0;
        (order.items || []).forEach(it => {
            const s = it.status || 'pending';
            if (s === 'cancelled' || s === 'completed') return;
            const w = etaWindow(tsMs(order), it, now);
            if (!w) return;
            start = start ? Math.min(start, w.start) : w.start;
            end = Math.max(end, w.end);
        });
        return end ? { start: start, end: end } : null;
    }
    // Sepet için göreli aralık ("~20–30 dk") — henüz bir sipariş yok, mutlak
    // saat gösterilemez.
    function cartEtaText() {
        let lo = 0, hi = 0;
        cart.forEach(l => {
            const m = etaMinutes(l) || etaMinutes(catalog.find(i => i.id === l.catalogId));
            if (!m) return;
            lo = lo ? Math.min(lo, m.min) : m.min;
            hi = Math.max(hi, m.max);
        });
        if (!hi) return '';
        return lo === hi ? t('guest.eta.approxOne', { n: hi }) : t('guest.eta.approx', { a: lo, b: hi });
    }

    function categories() {
        const seen = [];
        catalog.forEach(i => { const c = (i.category || t('common.other')).trim(); if (!seen.includes(c)) seen.push(c); });
        return seen;
    }
    function catCount(c) { return catalog.filter(i => (i.category || t('common.other')) === c).length; }

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
        auth.onAuthStateChanged(u => {
            // UID DEĞİŞİMİ İZLENİR: eskiden sessionUid yalnızca ilk oturumda
            // atanıyordu (`started` bayrağı ikinci çağrıyı tamamen yutuyordu).
            // Anonim oturum yenilenip UID değiştiğinde sipariş, ARTIK GEÇERSİZ
            // olan eski UID ile yazılıyor, firestore.rules'un
            // `sessionUid == request.auth.uid` koşulu düşüyor ve misafir
            // "Gönderilemedi" hatasından çıkamıyordu (özellikle mobilde).
            if (!u) {
                // Oturum düştü — anonim girişi tekrar dene; UID muhtemelen değişecek.
                auth.signInAnonymously().catch(() => {});
                return;
            }
            const changed = sessionUid && sessionUid !== u.uid;
            sessionUid = u.uid;
            if (!started) {
                started = true;
                mintTenantClaim(); // best-effort, arka planda — sonucu beklenmez
                loadData(); listenOrders();
                return;
            }
            if (changed) {
                // Yeni UID = sunucudaki doğrulanmış oturum dokümanı YOK →
                // yerel doğrulama bayrağı geçersiz; kapı tekrar açılır ve
                // dinleyici yeni UID'ye bağlanır.
                mintTenantClaim();
                clearVerified();
                listenOrders();
                maybeGate();
            }
        });
        auth.signInAnonymously().catch(err => {
            console.error('Anon sign-in failed', err);
            toast(t('guest.gate.noConnectionDemo'), true);
        });
    }

    // Cloudflare Worker, gerçek gelen subdomain'i imzalı header'lar olarak
    // iletir (yalnızca aynı origin'den /api/... rewrite'ı üzerinden — bu
    // yüzden fetch('/api/...') kullanılır, fns.httpsCallable() DEĞİL: o
    // doğrudan cloudfunctions.net'e gider ve Worker'ı atlar). Sunucu bu
    // imzayı doğrulayıp anonim oturuma gerçek tenant'ı bir custom claim
    // olarak yazar; firestore.rules bunu kullanarak "bu misafir gerçekten bu
    // otelin subdomain'inden mi geldi" diye teyit eder. Worker'ın önünde
    // olmayan ortamlarda (yerel geliştirme, ?tenant= ile test) imza
    // bulunmaz — istek reddedilir, hata sessizce yutulur, misafir tarafı
    // firestore.rules'daki eski (claim'siz) davranışa düşer.
    function mintTenantClaim() {
        if (!auth || !auth.currentUser) return;
        auth.currentUser.getIdToken().then(idToken => fetch('/api/mint-guest-claim', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + idToken }
        })).then(res => { if (res.ok) return auth.currentUser.getIdToken(true); })
          .catch(() => { /* claim'siz devam — geriye dönük uyumlu */ });
    }

    // guestConfig/requestCatalog daha önce tek seferlik .get() ile
    // önbelleğe alınıyordu: personel bu sekme açıkken hizmet listesini veya
    // hotel ayarlarını değiştirirse misafir sayfayı yenilemeden bunu hiç
    // görmüyordu. onSnapshot ile canlı dinlenir; ilk teslimat loadData()'nın
    // Promise'ini çözer, sonraki her değişiklik otomatik yeniden render eder.
    function loadData() {
        return new Promise(resolve => {
            let pending = 2;
            const first = () => { if (--pending <= 0) resolve(); };
            listenConfig(first);
            listenCatalog(first);
        }).then(() => { applyConfig(); renderAll(); maybeGate(); });
    }
    function listenConfig(onFirst) {
        let first = true;
        db.collection('guestConfig').doc(TENANT).onSnapshot(doc => {
            if (doc.exists) config = Object.assign({}, DEFAULT_CONFIG, doc.data());
            if (first) { first = false; onFirst(); } else { applyConfig(); renderAll(); }
        }, err => { console.error('config listen failed', err); if (first) { first = false; onFirst(); } });
    }
    function listenCatalog(onFirst) {
        let first = true;
        db.collection('requestCatalog').where('tenantId', '==', TENANT).onSnapshot(snap => {
            catalog = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                .filter(i => i.active !== false)
                .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || '', 'tr'));
            if (first) { first = false; onFirst(); } else { renderAll(); }
        }, err => { console.error('catalog listen failed', err); catalog = catalog || []; if (first) { first = false; onFirst(); } });
    }

    // ── Config → görünüm ───────────────────────────────────────
    function prettyTenant(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Hotizy'; }
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
        if (h < 12) return t('guest.home.greetMorning');
        if (h < 18) return 'İyi günler,';
        return t('guest.home.greetEvening');
    }
    function firstName() {
        const n = (guestName || '').trim();
        return n ? n.split(/\s+/)[0] : t('guest.home.guestShort');
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
        renderLive();
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
        temiz: 'housekeeping_button.webp',
        konfor: 'housekeeping_button.webp',
        bell: 'frontoffice_button.webp',
        food: 'fnb_button.webp'
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
    // Ana ekranın 3 büyük kartı: kategoriye göre DEĞİL, departmana göre
    // gruplanır (bkz. deptOf/deptKindKey yukarıdaki not) — aynı departmanın
    // birden fazla kategorisi (ör. Housekeeping: Temizlik + Konfor) tek
    // kartta birleşir, her departman kendi görseliyle görünür.
    function homeDeptGroups() {
        const seen = [];
        catalog.forEach(i => {
            const key = itemDeptKey(i);
            if (!key || seen.some(g => g.key === key)) return;
            seen.push(Object.assign({ key }, DEPT_KIND_DEFS[key]));
        });
        return seen;
    }
    function renderCats() {
        const wrap = $('goCats'); if (!wrap) return;
        const groups = homeDeptGroups();
        if (!groups.length) {
            wrap.innerHTML = `<div class="go-empty" style="grid-column:1/-1"><div class="go-empty-ic">🛎️</div><h3>${esc(t('guest.services.noResult'))}</h3><p>${esc(t('guest.services.notReady'))}</p></div>`;
            return;
        }
        wrap.innerHTML = groups.slice(0, 3).map((g, i) => {
            const color = g.color || CARD_COLORS[i % CARD_COLORS.length];
            const style = g.img
                ? `background-color:${color};background-image:linear-gradient(180deg,rgba(16,24,36,.20),rgba(16,24,36,.66)),url('${g.img}');background-size:cover;background-position:center;`
                : `background:${color};`;
            return `<button class="go-card3" data-dept="${esc(g.key)}" style="${style}">
                <span class="go-card3-tx">${esc(g.label)}</span>
            </button>`;
        }).join('');
        wrap.onclick = e => {
            const b = e.target.closest('[data-dept]'); if (!b) return;
            activeDept = b.dataset.dept; activeCat = 'all'; searchTerm = '';
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
                <h2>${esc(t('guest.services.howCanWeHelp'))}</h2>
                <p>Resepsiyon ekibimiz hizmetinizde. Aşağıdan ulaşın ya da hızlıca bir talep oluşturun.</p>
            </div>
            ${phone ? `<a class="go-cta go-cta-block" href="tel:${esc(phone)}">${svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>', 18)} Resepsiyonu Ara</a>` : ''}
            <button class="go-btn-ghost" id="goChatNew">${esc(t('guest.track.createNew'))}</button>`;
        const nb = $('goChatNew'); if (nb) nb.onclick = () => { activeDept = ''; activeCat = 'all'; showTab('services'); };
    }

    // ── Profil ──────────────────────────────────────────────────
    function renderProfile() {
        const wrap = $('goProfileBody'); if (!wrap) return;
        const hname = (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT);
        const rows = [
            infoRow('phone', t('guest.info.reception'), config.phone, { tel: (config.phone || '').replace(/[^0-9+]/g, '') }),
            infoRow('wifi', t('guest.info.wifiName'), config.wifiName, { copy: config.wifiName }),
            infoRow('wifi', t('guest.info.wifiPass'), config.wifiPass, { copy: config.wifiPass }),
            infoRow('clock', t('guest.info.checkout'), config.checkoutTime),
            infoRow('coffee', t('guest.info.breakfast'), config.breakfast),
            infoRow('pin', t('guest.info.address'), config.address, { map: config.address })
        ].filter(Boolean).join('');
        const initial = (firstName().charAt(0) || 'M').toLocaleUpperCase('tr-TR');
        wrap.innerHTML = `
            <div class="go-prof-card">
                <div class="go-prof-av">${esc(initial)}</div>
                <div class="go-prof-name">${esc(guestName || t('guest.home.guestFallback'))}</div>
                <div class="go-prof-sub">${ROOM ? 'Oda ' + esc(ROOM) + ' · ' : ''}${esc(hname)}${DEMO ? ' · DEMO' : ''}</div>
            </div>
            ${config.welcome && config.welcome.trim() ? `<p class="go-prof-welcome">${esc(config.welcome.trim())}</p>` : ''}
            <div class="go-prof-sec">${esc(t('guest.info.title'))}</div>
            ${rows || `<div class="go-empty"><div class="go-empty-ic">ℹ️</div><h3>${esc(t('guest.info.none'))}</h3><p>${esc(t('guest.info.noneHint'))}</p></div>`}
            <div class="go-prof-sec">${esc(t('guest.lang.switch'))}</div>
            <div class="go-langbar" id="goLangBar">
                ${I18n.supported().map(l => `<button class="go-lang${l === I18n.lang() ? ' active' : ''}" data-lang="${esc(l)}">${l === 'tr' ? '🇹🇷 Türkçe' : '🇬🇧 English'}</button>`).join('')}
            </div>`;
        wrap.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { try { navigator.clipboard.writeText(b.dataset.copy); toast(t('common.copied')); } catch (e) {} });
        // Dil değişimi sayfayı yeniler (bkz. js/core/i18n.js) — bu kadar
        // dinamik DOM'u canlı yeniden çizmekten güvenli.
        const lb = $('goLangBar');
        if (lb) lb.onclick = e => { const b = e.target.closest('[data-lang]'); if (b) I18n.setLang(b.dataset.lang); };
    }

    // ── Otel bilgileri (Otel Bilgileri sheet + Profil sekmesi ortak ikonlar) ──
    const INFO_ICONS = {
        wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
        phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
        clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
        coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
        pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'
    };

    // ── Ana carousel: 3 büyük giriş kartı (Otel Bilgileri / Menüler / Konaklama) ──
    const BIG_CARDS = [
        { key: 'info', title: 'Otel Bilgileri', img: 'info_button.webp', color: '#1f3a5c' },
        { key: 'menus', title: t('guest.menus.title'), img: 'menus_button.webp', color: '#7a5a44' },
        { key: 'stay', title: 'Konaklama', img: 'stay_button.webp', color: '#34703f' }
    ];
    function renderCarousel() {
        const wrap = $('goCarousel'), dots = $('goDots'); if (!wrap) return;
        const sec = $('goInfoSec'); if (sec) sec.style.display = '';
        wrap.innerHTML = BIG_CARDS.map(c => `
            <button class="go-bigcard" data-open="${esc(c.key)}"
                style="background-color:${c.color};background-image:linear-gradient(180deg,rgba(16,24,36,.16),rgba(16,24,36,.62)),url('${esc(c.img)}');background-size:cover;background-position:center;">
                <span class="go-bigcard-tx">${esc(c.title)}</span>
            </button>`).join('');
        if (dots) dots.innerHTML = BIG_CARDS.map((_, i) => `<span class="go-dot ${i === 0 ? 'active' : ''}"></span>`).join('');
        wrap.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
            const key = b.dataset.open;
            if (key === 'info') openInfo();
            else if (key === 'menus') openMenus();
            else if (key === 'stay') openStay();
        });
        wrap.onscroll = () => {
            if (!dots) return;
            const card = wrap.querySelector('.go-bigcard'); if (!card) return;
            const w = card.offsetWidth + 12;
            const idx = Math.round(wrap.scrollLeft / w);
            dots.querySelectorAll('.go-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
        };
    }

    // ── Menüler (admin panelden eklenen PDF bağlantıları) ─────────
    let menusCache = null; // [{name,pdfUrl}] — bir kez çekilip sekme boyunca saklanır
    function menuRow(m) {
        return `<button class="go-menu-row" data-url="${esc(m.pdfUrl || '')}">
            <span class="go-menu-row-ic">${svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', 20)}</span>
            <span class="go-menu-row-tx">${esc(m.name || 'Menü')}</span>
            <span class="go-menu-row-arrow">›</span></button>`;
    }
    function renderMenus(list) {
        const body = $('goMenusBody'); if (!body) return;
        if (!list.length) { body.innerHTML = `<div class="go-empty"><div class="go-empty-ic">📋</div><h3>${esc(t('guest.menus.none'))}</h3><p>${esc(t('guest.menus.noneHint'))}</p></div>`; return; }
        body.innerHTML = list.map(menuRow).join('');
        body.querySelectorAll('[data-url]').forEach(b => b.onclick = () => {
            const url = b.dataset.url;
            if (!url) { toast(t('guest.menus.noLink'), true); return; }
            window.open(url, '_blank', 'noopener');
        });
    }
    function openMenus() {
        $('goMenusBackdrop').classList.add('show');
        $('goMenusSheet').classList.add('show');
        $('goMenusSheet').setAttribute('aria-hidden', 'false');
        if (menusCache) { renderMenus(menusCache); return; }
        $('goMenusBody').innerHTML = '<div class="go-spinner" style="margin:30px auto;"></div>';
        if (DEMO) { menusCache = DEMO_MENUS; renderMenus(menusCache); return; }
        db.collection('guestMenus').where('tenantId', '==', TENANT).get().then(snap => {
            menusCache = snap.docs.map(d => d.data()).filter(m => m.active !== false)
                .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
            renderMenus(menusCache);
        }).catch(() => { menusCache = []; renderMenus([]); });
    }
    function closeMenus() {
        $('goMenusBackdrop').classList.remove('show');
        $('goMenusSheet').classList.remove('show');
        $('goMenusSheet').setAttribute('aria-hidden', 'true');
    }

    // ── Konaklama (tarihler + Oda Hesabım özeti + rezervasyonlar) ─
    // Tek bir sunucu-taraflı doğrulanmış çağrı (getGuestStay) ile gelir; soyadı
    // gate'te girildiğinde saklanır (SURNAME_KEY). Doğrulama hiç yapılmamışsa bu
    // sekme "doğrulama gerekli" gösterir — yeni bir zorunlu akış icat etmek yerine.
    let stayData = null; // { checkIn, checkOut, folio:{total,count,items}, reservations:[...] }
    const RES_TYPE_TR = { Restaurant: 'Restoran', Beach: 'Plaj', Transfer: 'Transfer', Flower: 'Çiçek', Cake: 'Pasta', Boat: 'Tekne', Tour: 'Tur', Other: t('common.other') };
    function resDetailText(r) {
        if (r.type === 'Restaurant' || r.type === 'Beach') return [r.resName, r.pax ? r.pax + ' ' + t('common.people') : ''].filter(Boolean).join(' · ');
        if (r.type === 'Transfer') return [r.from, r.to].filter(Boolean).join(' → ') + (r.vehicle ? ' · ' + r.vehicle : '');
        if (r.type === 'Boat' || r.type === 'Tour') return [r.vessel, r.provider].filter(Boolean).join(' · ');
        // Other + Flower/Cake (+ bilinmeyen tür) — önceden yalnızca 'Other'
        // otherType'a bakıyordu, Flower/Cake her zaman "Detay yok" gösteriyordu
        // (bkz. QR Concierge denetimi — concierge.js'in eşdeğer catch-all'ı).
        return r.otherType || r.resName || '';
    }
    function reservationRow(r, i) {
        const detail = resDetailText(r);
        return `<div class="go-stay-res-row" data-i="${i}">
            <div class="go-stay-res-top">
                <div><b>${esc(RES_TYPE_TR[r.type] || r.type || 'Rezervasyon')}</b><span>${esc(fmtDateTR(r.date))}${r.time ? ' · ' + esc(r.time) : ''}</span></div>
                <span class="go-stay-res-chev">›</span>
            </div>
            <div class="go-stay-res-detail">${detail ? esc(detail) : `<span class="go-ink-mute">${esc(t('guest.stay.noDetail'))}</span>`}</div>
        </div>`;
    }
    function fmtDateTR(iso) {
        if (!iso) return '—';
        const p = String(iso).slice(0, 10).split('-');
        return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
    }
    function renderStay() {
        const body = $('goStayBody'); if (!body || !stayData) return;
        const dateRow = (stayData.checkIn || stayData.checkOut) ? `
            <div class="go-stay-dates">
                <div><b>${esc(t('guest.stay.checkIn'))}</b><span>${esc(fmtDateTR(stayData.checkIn))}</span></div>
                <div><b>${esc(t('guest.stay.checkOut'))}</b><span>${esc(fmtDateTR(stayData.checkOut))}</span></div>
            </div>` : '';
        // Oda hesabı, PARA BİRİMİ BAŞINA ayrı bir buton olarak gösterilir —
        // ör. Concierge'in €150'lik ekstrası ile restoranın ₺2.400'lük
        // adisyonu ASLA tek bir tutarda toplanmaz (kaynağı farklı para
        // birimleri olduğundan bu yanlış bir tutar gösterir).
        const folioGroups = stayData.folio || [];
        const folioRowsHtml = folioGroups.length
            ? folioGroups.map((g, i) => `<button class="go-stay-folio" data-folio-i="${i}">
                <span><b>${esc(t('guest.stay.folio'))}</b><span>${g.count} kalem · ${esc(g.currency)}</span></span>
                <span class="go-stay-folio-amt">${esc(fmtCur(g.total, g.currency))}</span></button>`).join('')
            : `<button class="go-stay-folio off" disabled><span><b>${esc(t('guest.stay.folio'))}</b><span>Ekstra yok</span></span></button>`;
        const resList = (stayData.reservations || []);
        const resHtml = resList.length
            ? `<div class="go-prof-sec">${esc(t('guest.stay.reservations'))}</div>${resList.map(reservationRow).join('')}`
            : `<div class="go-prof-sec">${esc(t('guest.stay.reservations'))}</div><div class="go-empty" style="padding:24px 10px;"><p>${esc(t('guest.stay.noReservations'))}</p></div>`;
        const langHtml = `<div class="go-prof-sec">${esc(t('guest.lang.switch'))}</div>
            <div class="go-langbar" id="goStayLangBar">${I18n.supported().map(l =>
                `<button class="go-lang${l === I18n.lang() ? ' active' : ''}" data-lang="${esc(l)}">${l === 'tr' ? '🇹🇷 Türkçe' : '🇬🇧 English'}</button>`).join('')}</div>`;
        body.innerHTML = `${dateRow}${folioRowsHtml}${resHtml}${langHtml}`;
        const slb = $('goStayLangBar');
        if (slb) slb.onclick = e => { const b = e.target.closest('[data-lang]'); if (b) I18n.setLang(b.dataset.lang); };
        body.querySelectorAll('[data-folio-i]').forEach(btn => btn.onclick = () => { closeStay(); openFolio(folioGroups[+btn.dataset.folioI]); });
        body.querySelectorAll('.go-stay-res-row').forEach(row => row.onclick = () => row.classList.toggle('open'));
    }
    function openStay() {
        $('goStayBackdrop').classList.add('show');
        $('goStaySheet').classList.add('show');
        $('goStaySheet').setAttribute('aria-hidden', 'false');
        if (DEMO) { stayData = DEMO_STAY; renderStay(); return; }
        const surname = loadSurname();
        if (!fns || !ROOM || !surname) {
            $('goStayBody').innerHTML = `<div class="go-empty"><div class="go-empty-ic">🔒</div><h3>${esc(t('guest.gate.required'))}</h3><p>${esc(t('guest.gate.requiredHint'))}</p></div>`;
            return;
        }
        if (stayData) { renderStay(); return; }
        $('goStayBody').innerHTML = '<div class="go-spinner" style="margin:30px auto;"></div>';
        fns.httpsCallable('getGuestStay')({ tenant: TENANT, room: ROOM, surname }).then(res => {
            if (res && res.data && res.data.ok) { stayData = res.data; renderStay(); }
            else $('goStayBody').innerHTML = `<div class="go-empty"><div class="go-empty-ic">⚠️</div><h3>${esc(t('guest.stay.loadFailed'))}</h3><p>${esc(t('common.retry'))}</p></div>`;
        }).catch(() => { $('goStayBody').innerHTML = `<div class="go-empty"><div class="go-empty-ic">⚠️</div><h3>${esc(t('guest.stay.loadFailed'))}</h3><p>${esc(t('common.retry'))}</p></div>`; });
    }
    function closeStay() {
        $('goStayBackdrop').classList.remove('show');
        $('goStaySheet').classList.remove('show');
        $('goStaySheet').setAttribute('aria-hidden', 'true');
    }

    // ── Oda Hesabım detayı (Konaklama'dan drill-down) ─────────────
    // NOT: burada HER ZAMAN kalemin/grubun KENDİ para birimi (curr) kullanılır,
    // fmtPrice() (guestConfig.currency, ör. ₺) değil — Concierge kalemleri
    // EUR olabilir, restoran kalemleri TRY; ikisini aynı sembolle göstermek
    // yanlış tutar izlenimi verir.
    const CUR_SYM_MAP = { EUR: '€', TRY: '₺', USD: '$' };
    function fmtCur(amount, currency) { return (CUR_SYM_MAP[currency] || config.currency) + Number(amount || 0).toLocaleString('tr-TR'); }
    const FOLIO_SOURCE_LABEL = { restaurant: 'Restoran / Bar', concierge: 'Concierge Rezervasyonu' };
    function folioRow(it, currency) {
        const meta = [it.tableName || '', it.createdAt ? new Date(it.createdAt).toLocaleDateString('tr-TR') : ''].filter(Boolean).join(' · ');
        return `<div class="go-folio-row">
            <div class="go-folio-row-tx"><div class="go-folio-row-src">${esc(FOLIO_SOURCE_LABEL[it.source] || it.source || t('guest.stay.folioShort'))}</div>${meta ? `<div class="go-folio-row-meta">${esc(meta)}</div>` : ''}</div>
            <div class="go-folio-row-amt">${esc(fmtCur(it.amount, currency))}</div></div>`;
    }
    function openFolio(group) {
        const body = $('goFolioBody'); if (!body || !group) return;
        const rows = (group.items || []).map(it => folioRow(it, group.currency)).join('');
        body.innerHTML = `${rows || `<div class="go-empty"><div class="go-empty-ic">🧾</div><h3>${esc(t('guest.stay.noItems'))}</h3></div>`}
            <div class="go-folio-total"><b>Toplam (${esc(group.currency)})</b><span>${esc(fmtCur(group.total || 0, group.currency))}</span></div>`;
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
    // Kategoriye özel hero bandı: başlık ana ekrandaki kartla aynı görsel
    // dili taşır (renk + görsel + tanıtım cümlesi) — jenerik "Hizmetler"
    // listesi yerine kategori sayfası hissi verir.
    const HERO_COLORS = { temiz: '#33574a', konfor: '#4d6155', food: '#7a5a44', teknik: '#33485c', bell: '#1f3a5c', other: '#5c5470' };
    function renderCatHero() {
        const hero = $('goCatHero'), title = $('goServicesTitle'); if (!hero) return;
        // Ana ekrandan bir DEPARTMAN kartıyla gelindiyse (activeDept), o
        // departmanın tüm kategorilerini kapsayan tek bir bant gösterilir —
        // tek kategori seçiliyken (activeCat) aşağıdaki eski davranış sürer.
        if (activeDept) {
            const def = DEPT_KIND_DEFS[activeDept];
            if (!def) { activeDept = ''; }
            else {
                const style = def.img
                    ? `background-color:${def.color};background-image:linear-gradient(100deg,rgba(16,24,36,.72),rgba(16,24,36,.38)),url('${def.img}');background-size:cover;background-position:center;`
                    : `background:${def.color};`;
                const n = filteredItems().length;
                hero.hidden = false;
                hero.innerHTML = `<div class="go-cathero-in" style="${style}">
                    <span class="go-cathero-tx">
                        <b>${esc(def.label)}</b>
                        <span>${n} hizmet</span>
                    </span>
                    <span class="go-cathero-n">${n}</span>
                </div>`;
                if (title) title.textContent = def.label;
                return;
            }
        }
        if (activeCat === 'all') {
            hero.hidden = true;
            if (title) title.textContent = 'Hizmetler';
            return;
        }
        const kind = catKind(activeCat);
        const img = CARD_IMG[kind];
        const color = HERO_COLORS[kind] || HERO_COLORS.other;
        const style = img
            ? `background-color:${color};background-image:linear-gradient(100deg,rgba(16,24,36,.72),rgba(16,24,36,.38)),url('${img}');background-size:cover;background-position:center;`
            : `background:${color};`;
        hero.hidden = false;
        hero.innerHTML = `<div class="go-cathero-in" style="${style}">
            <span class="go-cathero-ic">${catIcon(activeCat, 26)}</span>
            <span class="go-cathero-tx">
                <b>${esc(activeCat)}</b>
                <span>${esc(catBlurb(activeCat) || catCount(activeCat) + ' hizmet')}</span>
            </span>
            <span class="go-cathero-n">${catCount(activeCat)}</span>
        </div>`;
        if (title) title.textContent = activeCat;
    }
    function renderServices() {
        const chips = $('goChips'); if (!chips) return;
        const cats = categories();
        if (activeCat !== 'all' && !cats.includes(activeCat)) activeCat = 'all';
        renderCatHero();
        const allActive = !activeDept && activeCat === 'all';
        chips.innerHTML = [`<button class="go-chip ${allActive ? 'active' : ''}" data-chip="all">${esc(t('common.all'))}<i>${catalog.length}</i></button>`]
            .concat(cats.map(c => `<button class="go-chip ${(!activeDept && activeCat === c) ? 'active' : ''}" data-chip="${esc(c)}"><span class="go-chip-ic">${catIcon(c, 18)}</span>${esc(c)}<i>${catCount(c)}</i></button>`)).join('');
        // Herhangi bir kategori çipine (Tümü dahil) tıklamak departman
        // modundan çıkar — kullanıcı artık tek kategori/tüm liste görünümünde.
        chips.onclick = e => { const b = e.target.closest('[data-chip]'); if (!b) return; activeDept = ''; activeCat = b.dataset.chip; renderServices(); const a = chips.querySelector('.go-chip.active'); if (a) a.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); };
        renderItems();
    }
    function filteredItems() {
        const term = norm(searchTerm);
        return catalog.filter(i => {
            if (activeDept) { if (itemDeptKey(i) !== activeDept) return false; }
            else if (activeCat !== 'all' && (i.category || t('common.other')) !== activeCat) return false;
            if (term) { const hay = norm((i.name || '') + ' ' + (i.category || '') + ' ' + (i.description || '')); if (!hay.includes(term)) return false; }
            return true;
        });
    }
    function renderItems() {
        const wrap = $('goItems'); if (!wrap) return;
        const items = filteredItems();
        if (!items.length) {
            wrap.innerHTML = `<div class="go-empty"><div class="go-empty-ic">🔍</div><h3>${esc(t('guest.services.noResult'))}</h3><p>${esc(searchTerm ? t('guest.services.noMatch') : t('guest.services.emptyCategory'))}</p></div>`;
            return;
        }
        // group by category when showing "all", or a whole department's
        // multiple categories, and there's no active search term
        let html = '';
        if ((activeDept || activeCat === 'all') && !searchTerm) {
            categories().forEach(c => {
                const sub = items.filter(i => (i.category || t('common.other')) === c);
                if (!sub.length) return;
                html += `<div class="go-cat-head">${esc(c)}</div>` + sub.map(itemHtml).join('');
            });
        } else {
            html = items.map(itemHtml).join('');
        }
        wrap.innerHTML = html;
        bindItemEvents(wrap);
    }
    // Seçenekli kalemler (ör. VIP Transfer → Vito/Sprinter/S Class) satırda
    // doğrudan "+" ile eklenemez — misafirin ÖNCE bir seçenek seçmesi gerekir,
    // bu yüzden henüz sepette yoksa satırdaki aksiyon "Seç"e döner (detay
    // sheet'ini açar); sepette bir satır varsa (seçim zaten yapılmış) normal
    // adet +/- kontrolüne dönülür — seçim değiştirmek için sheet'e girilir.
    const hasOptions = item => Array.isArray(item && item.options) && item.options.length > 0;
    function itemAction(item, av, line) {
        if (!av.available) return `<span class="go-unavail">${esc(t('guest.services.offHours'))}</span>`;
        // Tek-adetlik talepler (maxQty=1: oda temizliği, çarşaf değişimi…)
        // adet kontrolü GÖSTERMEZ — "2 kez oda temizliği" anlamsız. Sepetteyken
        // aç/kapa bir onay rozetine döner.
        if (line && line.qty > 0) {
            return lineMax(item) === 1
                ? `<button class="go-add go-add-on" data-dec="${esc(item.id)}" aria-label="${esc(t('guest.item.removeFromCart'))}">✓</button>`
                : stepHtml(item.id, line.qty);
        }
        if (hasOptions(item) || hasModifiers(item) || isTransferItem(item) || isConciergeItem(item)) return `<button class="go-add go-add-choose" data-choose="${esc(item.id)}" aria-label="Seç">${esc(t('common.select'))}</button>`;
        return `<button class="go-add" data-add="${esc(item.id)}" aria-label="Ekle">+</button>`;
    }
    function itemHtml(item) {
        const av = availInfo(item);
        const tags = [];
        if (item.eta && item.eta !== '—') tags.push(`<span class="go-tag">${svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 13)}${esc(item.eta)}</span>`);
        if (av.limited) tags.push(`<span class="go-tag ${av.available ? '' : 'off'}">🕒 ${esc(av.window)}</span>`);
        if (pricesOn() && priceOf(item)) tags.push(`<span class="go-tag price">${esc(fmtPrice(priceOf(item)))}</span>`);
        const line = cart.find(l => l.catalogId === item.id);
        const action = itemAction(item, av, line);
        return `<div class="go-item ${av.available ? '' : 'go-item-unavail'}" data-id="${esc(item.id)}" data-open-item="${esc(item.id)}">
            <div class="go-item-emoji go-k-${catKind(item.category)}">${esc(item.icon || '🛎️')}</div>
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
            const choose = e.target.closest('[data-choose]'); if (choose) return openItemSheet(choose.dataset.choose);
            const add = e.target.closest('[data-add]'); if (add) return changeQty(add.dataset.add, +1);
            const inc = e.target.closest('[data-inc]'); if (inc) return changeQty(inc.dataset.inc, +1);
            const dec = e.target.closest('[data-dec]'); if (dec) return changeQty(dec.dataset.dec, -1);
            // Satırın kendisine dokunma → detay sheet'i (not / saat / adet birlikte)
            const row = e.target.closest('[data-open-item]'); if (row) openItemSheet(row.dataset.openItem);
        };
    }

    // ── Hizmet detayı sheet ─────────────────────────────────────
    // Satıra dokununca açılır: açıklama + adet + not + tercih saati (+ varsa
    // seçenek) tek yerde. Sepette satır varsa mevcut değerlerle gelir ve
    // günceller.
    let sheetItemId = null, sheetQty = 1, sheetOption = '', sheetModifiers = [];
    function optPillsHtml(item, selected) {
        return `<div class="go-fld"><label>Seçenek</label>
            <div class="go-opt-pills" id="goShOptPills">
                ${optionsOf(item).map(o => `<button type="button" class="go-opt-pill ${o.name === selected ? 'active' : ''}" data-opt="${esc(o.name)}">${esc(o.name)}${(pricesOn() && o.priceDelta) ? ` <span class="go-opt-pill-delta">${esc(fmtDelta(o.priceDelta))}</span>` : ''}</button>`).join('')}
            </div></div>`;
    }
    // Çıkarılabilir/ekstra bileşenler — options'tan farklı olarak ÇOKLU seçim.
    // Yemek sipariş uygulamalarındaki gibi BAŞLIKLI bölümler halinde çizilir
    // (özel grup adı varsa o, yoksa "Ekstralar"/"Çıkarılacaklar"). maxQty > 1
    // olan ekstralar satır içi adet kontrolü alır (2× Ekstra Peynir).
    // DİKKAT: dış kapsayıcı <div>'dir, <button> DEĞİL. Adetli ekstralarda
    // satırın içinde − / + butonları var; HTML'de buton içine buton
    // yerleştirilemez (tarayıcı ayrıştırıcısı dış butonu erkenden kapatır ve
    // stepper satırın DIŞINA düşer, tıklama hiç ulaşmaz). Dokunma hedefi
    // olarak içteki .go-modrow-tap butonu kullanılır.
    function modRowHtml(m, qty) {
        const on = qty > 0;
        const delta = (pricesOn() && m.priceDelta) ? `<span class="go-modrow-delta">${esc(fmtDelta(m.priceDelta))}</span>` : '';
        const ctrl = (m.maxQty > 1)
            ? `<span class="go-modrow-step">
                   <button type="button" data-moddec="${esc(m.name)}" aria-label="Azalt" ${on ? '' : 'disabled'}>−</button>
                   <b data-modqty="${esc(m.name)}">${qty}</b>
                   <button type="button" data-modinc="${esc(m.name)}" aria-label="Artır" ${qty >= m.maxQty ? 'disabled' : ''}>+</button>
               </span>`
            : `<span class="go-modrow-check" aria-hidden="true">${on ? '✓' : ''}</span>`;
        return `<div class="go-modrow ${on ? 'active' : ''} ${m.type === 'extra' ? 'is-extra' : 'is-remove'}" data-mod="${esc(m.name)}">
            <button type="button" class="go-modrow-tap" data-modtoggle="${esc(m.name)}" aria-pressed="${on ? 'true' : 'false'}">
                <span class="go-modrow-sign">${m.type === 'extra' ? '+' : '−'}</span>
                <span class="go-modrow-name">${esc(m.name)}</span>
                ${delta}
            </button>
            ${ctrl}
        </div>`;
    }
    function modChipsHtml(item, sel) {
        const groups = modifierGroups(item);
        if (!groups.length) return '';
        return `<div class="go-modsec" id="goShModPills">
            ${groups.map(g => `<div class="go-modgrp">
                <div class="go-modgrp-h">${esc(g.key)}</div>
                ${g.items.map(m => modRowHtml(m, selQty(sel, m.name))).join('')}
            </div>`).join('')}
        </div>`;
    }
    function openItemSheet(id) {
        const item = catalog.find(i => i.id === id); if (!item) return;
        const av = availInfo(item);
        const line = cart.find(l => l.catalogId === id);
        sheetItemId = id;
        sheetQty = line && line.qty > 0 ? line.qty : 1;
        sheetOption = line ? (line.option || '') : '';
        // selList: eski sepet satırları modifiers'ı adetsiz tuttuğu için
        // ikisini de kabul eden normalize edici.
        sheetModifiers = line ? selList(line.modifiers) : [];
        const withOpts = hasOptions(item);
        const withMods = hasModifiers(item);
        const maxq = lineMax(item);
        const isTransfer = isTransferItem(item);
        // Concierge (transfer OLMAYAN: restoran rezervasyonu, spa, tur…)
        // kalemleri de TARİH ister. Eskiden yalnızca transfer'e tarih alanı
        // vardı; diğerleri order-bridge'de koşulsuz BUGÜNE sabitleniyordu —
        // "Cuma akşamı için masa" isteyen misafirin talebi bugünün
        // ajandasına düşüyordu (bkz. QR↔Concierge operasyon denetimi).
        const isConcierge = !isTransfer && isConciergeItem(item);
        const tmb = (isTransfer || isConcierge) ? transferMinBound() : null;
        const tags = [];
        if (item.eta && item.eta !== '—') tags.push(`<span class="go-tag">${svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 13)}${esc(item.eta)}</span>`);
        if (av.limited) tags.push(`<span class="go-tag ${av.available ? '' : 'off'}">🕒 ${esc(av.window)}</span>`);
        if (pricesOn() && priceOf(item)) tags.push(`<span class="go-tag price">${esc(fmtPrice(priceOf(item)))}${(withOpts || withMods) ? ' +' : ''}</span>`);
        const addDisabled = withOpts && !sheetOption;
        const sheetUnitPrice = () => priceOf(item) + optionDelta(item, sheetOption) + modifiersDelta(item, sheetModifiers);
        $('goItemSheetBody').innerHTML = `
            <div class="go-isheet-head">
                <div class="go-item-emoji go-k-${catKind(item.category)}" style="width:56px;height:56px;font-size:28px;">${esc(item.icon || '🛎️')}</div>
                <div class="go-isheet-tx">
                    <h2>${esc(item.name)}</h2>
                    <span class="go-isheet-cat">${esc(item.category || t('common.other'))}</span>
                </div>
                <button class="go-sheet-close" id="goItemClose" aria-label="Kapat">✕</button>
            </div>
            ${item.description ? `<p class="go-isheet-desc">${esc(item.description)}</p>` : ''}
            ${tags.length ? `<div class="go-item-meta" style="margin:0 0 14px;">${tags.join('')}</div>` : ''}
            ${av.available ? `
            ${withOpts ? optPillsHtml(item, sheetOption) : ''}
            ${withMods ? modChipsHtml(item, sheetModifiers) : ''}
            ${maxq > 1 ? `
            <div class="go-isheet-qty" style="${(withOpts || withMods) ? 'margin-top:12px;' : ''}">
                <span>${esc(t('guest.item.quantity'))}</span>
                <div class="go-step go-step-lg"><button id="goShDec">−</button><b id="goShQty">${sheetQty}</b><button id="goShInc">+</button></div>
            </div>` : ''}
            <div class="go-fld"><label>${esc(t('guest.item.note'))}</label><input type="text" id="goShNote" maxlength="160" placeholder="${esc(t('guest.item.notePlaceholder'))}" value="${esc(line ? line.note || '' : '')}"></div>
            ${isTransfer ? `
            <div class="go-fld"><label>${esc(t('guest.transfer.from'))}</label><input type="text" id="goShFrom" maxlength="80" placeholder="${esc(t('guest.transfer.fromPlaceholder'))}" value="${esc(line ? line.transferFrom || '' : '')}"></div>
            <div class="go-fld"><label>${esc(t('guest.transfer.to'))}</label><input type="text" id="goShTo" maxlength="80" placeholder="${esc(t('guest.transfer.toPlaceholder'))}" value="${esc(line ? line.transferTo || '' : '')}"></div>
            <div class="go-fld-2">
                <div class="go-fld"><label>${esc(t('guest.transfer.date'))}</label><input type="date" id="goShDate" min="${tmb.dateIso}" value="${esc(line && line.transferDate || tmb.dateIso)}"></div>
                <div class="go-fld"><label>${esc(t('guest.transfer.time'))}</label><input type="time" id="goShTime" min="${tmb.timeHHMM}" value="${esc(line && line.transferTime || tmb.timeHHMM)}"></div>
            </div>
            ${!withOpts ? `<div class="go-fld"><label>${esc(t('guest.transfer.vehicle'))}</label><input type="text" id="goShVehicle" maxlength="80" placeholder="${esc(t('guest.transfer.vehiclePlaceholder'))}" value="${esc(line ? line.option || '' : '')}"></div>` : ''}
            ` : (isConcierge ? `
            <div class="go-fld-2">
                <div class="go-fld"><label>${esc(t('guest.transfer.date'))}</label><input type="date" id="goShDate" min="${tmb.dateIso}" value="${esc(line && line.transferDate || tmb.dateIso)}"></div>
                <div class="go-fld"><label>${esc(t('guest.transfer.time'))}</label><input type="time" id="goShTime" value="${esc(line && line.transferTime || '')}"></div>
            </div>
            ` : `
            <div class="go-fld"><label>${esc(t('guest.item.preferredTime'))}</label><input type="time" id="goShTime" value="${esc(line ? line.preferredTime || '' : '')}"></div>
            `)}
            <button class="go-cta go-cta-block" id="goShAdd" style="margin-top:16px;" ${addDisabled ? 'disabled' : ''}>
                <span id="goShAddLbl">${addDisabled ? t('guest.item.pickOption') : (line ? t('guest.item.updateCart') : t('guest.item.addToCart'))}</span>
                ${pricesOn() ? `<span class="go-isheet-amt" id="goShAmt">${esc(addDisabled ? '' : (sheetUnitPrice() ? fmtPrice(sheetUnitPrice() * sheetQty) : ''))}</span>` : ''}
            </button>
            ${line ? `<button class="go-btn-ghost go-btn-danger" id="goShRemove" style="margin-top:10px;">${esc(t('guest.item.removeFromCart'))}</button>` : ''}`
            : `<div class="go-unavail" style="display:block;text-align:center;padding:14px;margin-top:6px;">${esc(t('guest.services.unavailableWindow', { window: av.window }))}</div>`}
        `;
        const addB = $('goShAdd');
        const upd = () => {
            const q = $('goShQty'); if (q) q.textContent = sheetQty;
            const a = $('goShAmt');
            // Seçenek zorunluyken ve henüz seçilmemişken tutar GÖSTERİLMEZ
            // (seçenek fiyatı değiştirebilir), ama eleman DOM'da durur —
            // eskiden hiç render edilmediği için seçim yapıldığında fiyat
            // asla görünmüyordu.
            if (a) a.textContent = (withOpts && !sheetOption) ? '' : (sheetUnitPrice() ? fmtPrice(sheetUnitPrice() * sheetQty) : '');
        };
        const syncAddState = () => {
            if (!addB || !withOpts) return;
            const disabled = !sheetOption;
            addB.disabled = disabled;
            const lbl = $('goShAddLbl'); if (lbl) lbl.textContent = disabled ? t('guest.item.pickOption') : (line ? t('guest.item.updateCart') : t('guest.item.addToCart'));
            upd();
        };
        const pills = $('goShOptPills');
        if (pills) pills.onclick = e => {
            const b = e.target.closest('[data-opt]'); if (!b) return;
            sheetOption = b.dataset.opt;
            pills.querySelectorAll('.go-opt-pill').forEach(p => p.classList.toggle('active', p.dataset.opt === sheetOption));
            syncAddState(); upd();
        };
        const modPills = $('goShModPills');
        if (modPills) modPills.onclick = e => {
            const row = e.target.closest('[data-mod]'); if (!row) return;
            const name = row.dataset.mod;
            const def = modifiersOf(item).find(x => x.name === name); if (!def) return;
            // Adetli ekstralarda − / + satır içi kontrolü; diğerlerinde satırın
            // tamamı aç/kapa. e.target'a bakılır ki stepper'a basmak kalemi
            // sıfırlamasın.
            const dec = e.target.closest('[data-moddec]'), inc = e.target.closest('[data-modinc]');
            let q = selQty(sheetModifiers, name);
            if (def.maxQty > 1 && (dec || inc)) {
                q = inc ? Math.min(def.maxQty, q + 1) : Math.max(0, q - 1);
            } else {
                q = q > 0 ? 0 : 1;
            }
            sheetModifiers = selList(sheetModifiers).filter(s => s.name !== name);
            if (q > 0) sheetModifiers.push({ name: name, qty: q });
            // Sadece dokunulan satırı yeniden çiz — tüm sheet'i yeniden
            // kurmak açık klavyeyi/kaydırma konumunu bozardı.
            row.outerHTML = modRowHtml(def, q);
            upd();
        };
        const dec = $('goShDec'); if (dec) dec.onclick = () => { if (sheetQty > 1) { sheetQty--; upd(); } };
        const inc = $('goShInc'); if (inc) inc.onclick = () => { if (sheetQty >= maxq) { toast(capMsg(item), true); return; } sheetQty++; upd(); };
        // Yalnızca UX cilası — asıl "en yakın yarım saat" doğrulaması
        // confirmItemSheet()'te yapılır. Bugünden farklı bir tarih
        // seçildiğinde saat alanı serbest bırakılır.
        if (isTransfer) {
            const dateEl = $('goShDate'), timeEl = $('goShTime');
            if (dateEl && timeEl) dateEl.onchange = () => { timeEl.min = dateEl.value === tmb.dateIso ? tmb.timeHHMM : ''; };
        }
        if (addB) addB.onclick = () => confirmItemSheet(item);
        const rmB = $('goShRemove'); if (rmB) rmB.onclick = () => {
            cart = cart.filter(l => l.catalogId !== id);
            saveCart(); renderCartUI(); refreshItemRow(id); closeItemSheet(); toast(t('guest.item.removed'));
        };
        const cl = $('goItemClose'); if (cl) cl.onclick = closeItemSheet;
        $('goItemBackdrop').classList.add('show');
        $('goItemSheet').classList.add('show');
        $('goItemSheet').setAttribute('aria-hidden', 'false');
    }
    function confirmItemSheet(item) {
        if (hasOptions(item) && !sheetOption) { toast(t('guest.item.pickOptionToast'), true); return; }
        const isTransfer = isTransferItem(item);
        let transferFrom = '', transferTo = '', transferDate = '', transferTime = '';
        if (isTransfer) {
            if (!hasOptions(item)) {
                const veh = ($('goShVehicle') && $('goShVehicle').value || '').trim().slice(0, 80);
                if (!veh) { toast(t('guest.transfer.needVehicle'), true); return; }
                sheetOption = veh;
            }
            transferFrom = ($('goShFrom') && $('goShFrom').value || '').trim().slice(0, 80);
            transferTo = ($('goShTo') && $('goShTo').value || '').trim().slice(0, 80);
            transferDate = ($('goShDate') && $('goShDate').value || '').slice(0, 10);
            transferTime = ($('goShTime') && $('goShTime').value || '').slice(0, 5);
            if (!transferFrom) { toast(t('guest.transfer.needFrom'), true); return; }
            if (!transferTo) { toast(t('guest.transfer.needTo'), true); return; }
            if (!transferDate) { toast(t('guest.transfer.needDate'), true); return; }
            if (!transferTime) { toast(t('guest.transfer.needTime'), true); return; }
            const picked = new Date(transferDate + 'T' + transferTime + ':00');
            const b = transferMinBound();
            if (isNaN(picked.getTime()) || picked.getTime() < b.ms) {
                toast(t('guest.transfer.tooEarly', { time: b.timeHHMM, date: b.dateIso.split('-').reverse().join('.') }), true);
                return;
            }
        } else if (isConciergeItem(item)) {
            // Transfer olmayan Concierge kalemi: TARİH zorunlu (hangi gün için
            // istendiği bilinmezse kayıt bugüne düşer), saat opsiyoneldir
            // (ör. "yarın için spa" — saat personel ile netleşebilir).
            transferDate = ($('goShDate') && $('goShDate').value || '').slice(0, 10);
            transferTime = ($('goShTime') && $('goShTime').value || '').slice(0, 5);
            if (!transferDate) { toast(t('guest.transfer.needDate'), true); return; }
        }
        const note = ($('goShNote') && $('goShNote').value || '').slice(0, 160);
        // Transfer kalemlerinde preferredTime kullanılmaz (mutually exclusive
        // — bkz. transferDate/transferTime).
        const time = isTransfer ? '' : ($('goShTime') && $('goShTime').value || '').slice(0, 10);
        let line = cart.find(l => l.catalogId === item.id);
        if (!line) {
            if (cart.length >= MAX_DISTINCT) { toast(t('guest.item.maxDistinct', { n: MAX_DISTINCT }), true); return; }
            line = { catalogId: item.id, name: item.name, category: item.category || t('common.other'), icon: item.icon || '🛎️',
                department: item.department || '', price: priceOf(item), maxQty: Number(item.maxQty) || 0, qty: 0, note: '', preferredTime: '', option: '',
                // Süre sepete eklendiği ANDA damgalanır (price ile aynı gerekçe):
                // katalog sonradan değişse bile misafire verilen söz sabit kalır.
                etaMin: (etaMinutes(item) || {}).min || 0, etaMax: (etaMinutes(item) || {}).max || 0,
                transferFrom: '', transferTo: '', transferDate: '', transferTime: '' };
            cart.push(line);
        }
        line.qty = Math.min(lineMax(line), Math.max(1, sheetQty));
        line.note = note; line.preferredTime = time; line.option = sheetOption || '';
        // Seçilen bileşenler adetleriyle birlikte saklanır; sıra katalogdaki
        // sıradır (misafirin dokunma sırası değil) — sepet ve personel metni
        // her zaman aynı düzende okunur.
        line.modifiers = modifiersOf(item)
            .map(m => ({ m: m, q: selQty(sheetModifiers, m.name) }))
            .filter(x => x.q > 0)
            .map(x => ({ name: x.m.name, type: x.m.type, priceDelta: x.m.priceDelta, qty: x.q }));
        line.transferFrom = transferFrom; line.transferTo = transferTo; line.transferDate = transferDate; line.transferTime = transferTime;
        // Seçilen seçenek/özelleştirmelerin fiyat farkı BURADA satır fiyatına
        // gömülür (bakılan an itibarıyla) — priceOf(line) her yerde tek bir
        // toplam birim fiyat olarak okunur, sepet/gönderim ayrıca delta
        // hesaplamaz.
        line.price = priceOf(item) + optionDelta(item, sheetOption) + modifiersDelta(item, sheetModifiers);
        saveCart(); renderCartUI(); refreshItemRow(item.id);
        if (currentTab === 'cart') renderCart();
        closeItemSheet(); buzz(10); toast(t('guest.item.added'));
    }
    function closeItemSheet() {
        sheetItemId = null; sheetOption = ''; sheetModifiers = [];
        $('goItemBackdrop').classList.remove('show');
        $('goItemSheet').classList.remove('show');
        $('goItemSheet').setAttribute('aria-hidden', 'true');
    }
    function refreshItemRow(id) {
        const row = document.querySelector(`#goItems .go-item-act[data-act="${CSS.escape(id)}"]`);
        if (!row) return;
        const item = catalog.find(i => i.id === id); if (!item) return;
        const av = availInfo(item);
        const line = cart.find(l => l.catalogId === id);
        row.innerHTML = itemAction(item, av, line);
    }

    // ── Cart mutations ─────────────────────────────────────────
    function lineMax(l) { const m = Number(l && l.maxQty) || 0; return m > 0 ? Math.min(m, MAX_QTY) : MAX_QTY; }
    function capMsg(l) { return (Number(l && l.maxQty) || 0) > 0 ? t('guest.item.maxQtyItem', { n: l.maxQty }) : t('guest.item.maxQtyGeneric', { n: MAX_QTY }); }
    function changeQty(catalogId, delta) {
        const item = catalog.find(i => i.id === catalogId); if (!item) return;
        if (delta > 0) { const av = availInfo(item); if (!av.available) { toast(t('guest.services.onlyBetween', { window: av.window }), true); return; } }
        let line = cart.find(l => l.catalogId === catalogId);
        // Seçenekli bir kalem sepette henüz yoksa doğrudan eklenemez — önce
        // seçim yapılmalı (ör. ana ekrandaki "Hızlı İşlemler" kısayolu bu
        // yoldan geçer). Sepette zaten bir satır varsa (seçim yapılmış)
        // normal adet artırma/azaltma burada devam eder.
        // Transfer kalemleri Nereden/Nereye/Tarih/Saat zorunlu olduğundan
        // seçenek/modifier'ı olmasa bile HER ZAMAN sheet'ten geçer — aksi
        // halde "Hızlı İşlemler" kısayolu bu zorunlu alanları hiç sormadan
        // sepete ekleyebilirdi.
        if (!line && delta > 0 && (hasOptions(item) || hasModifiers(item) || isTransferItem(item) || isConciergeItem(item))) { openItemSheet(catalogId); return; }
        if (!line && delta > 0) {
            if (cart.length >= MAX_DISTINCT) { toast(t('guest.item.maxDistinct', { n: MAX_DISTINCT }), true); return; }
            line = { catalogId, name: item.name, category: item.category || t('common.other'), icon: item.icon || '🛎️',
                department: item.department || '', price: priceOf(item), maxQty: Number(item.maxQty) || 0, qty: 0, note: '', preferredTime: '', option: '',
                // Süre sepete eklendiği ANDA damgalanır (price ile aynı gerekçe):
                // katalog sonradan değişse bile misafire verilen söz sabit kalır.
                etaMin: (etaMinutes(item) || {}).min || 0, etaMax: (etaMinutes(item) || {}).max || 0,
                transferFrom: '', transferTo: '', transferDate: '', transferTime: '' };
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
        if (delta > 0) { buzz(10); if (cartCount() === 1) toast(t('guest.item.addedShort')); }
    }

    // Sepet satırındaki fiyat dökümü (taban + seçenek farkı + özelleştirme
    // farkları) — l.price zaten toplamı taşır, bu yalnızca GÖRSEL bir
    // döküm; kalemin katalogdaki güncel hâli bulunamazsa (ör. o hizmet
    // sonradan silindi) sessizce hiçbir şey göstermez.
    function lineBreakdownHtml(l) {
        if (!pricesOn()) return '';
        const item = catalog.find(i => i.id === l.catalogId); if (!item) return '';
        const base = priceOf(item);
        const optD = optionDelta(item, l.option);
        // Nesneler doğrudan geçilir: modifiersDelta adetle çarpar (2× ekstra
        // iki kez sayılır) — eskiden yalnızca adlar geçildiği için adet
        // dökümde kaybolurdu.
        const modD = modifiersDelta(item, l.modifiers);
        if (!optD && !modD) return '';
        const parts = [fmtPrice(base)];
        if (optD) parts.push(fmtDelta(optD));
        if (modD) parts.push(fmtDelta(modD));
        return `<div class="go-cline-breakdown">${esc(parts.join(' '))} = ${esc(fmtPrice(base + optD + modD))}</div>`;
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
            wrap.innerHTML = `<div class="go-empty"><div class="go-empty-ic">🛒</div><h3>${esc(t('guest.cart.empty'))}</h3><p>${esc(t('guest.cart.emptyHint'))}</p><button class="go-cta" data-go="services">${esc(t('guest.cart.browse'))}</button></div>`;
            wrap.querySelector('[data-go]').onclick = () => showTab('services');
            return;
        }
        foot.hidden = false;
        $('goCartCountLbl').textContent = cart.length + ' talep · ' + cartCount() + ' adet';
        // DİKKAT: yerel değişken `t` OLAMAZ — global `t()` çeviri fonksiyonunu
        // bu fonksiyonun tamamında gölgelerdi (aşağıdaki satır/grup metinleri
        // onu çağırıyor).
        const tt = $('goCartTotal'); const total = cartTotal();
        tt.style.display = (pricesOn() && total) ? '' : 'none'; tt.textContent = fmtPrice(total);
        // Sepet alt barında göreli teslim tahmini ("~20–30 dk") — sipariş
        // henüz yok, mutlak saat verilemez.
        const etaEl = $('goCartEta');
        if (etaEl) { const txt = cartEtaText(); etaEl.textContent = txt; etaEl.hidden = !txt; }
        // Sepet kartı KOMPAKT tutulur: not/tercih saati için ayrı, her zaman
        // açık giriş alanları yerine (eski tasarım — kart başına 4 dikey blok)
        // hepsi tek bir etiket (chip) satırında özetlenir; kart artık uçtan
        // uca dokunulabilir ve openItemSheet()'i açar (o sheet zaten
        // seçenek/modifier/not/saati önceden dolduruyor ve geri yazıyor —
        // bkz. openItemSheet/confirmItemSheet). "Adet" için ayrıca salt-okunur
        // bir kutu YOKTUR — bir satır üstteki stepper zaten aynı bilgiyi taşır.
        // Sepet satırı. Tek-adetlik kalemlerde (maxQty=1) adet kontrolü HİÇ
        // çizilmez — "2 kez çarşaf değişimi" anlamsız; kaldırmak için çöp
        // kutusu zaten var.
        const lineHtml = (l, i) => {
            const chips = [];
            if (l.option) chips.push(`<span class="go-cline-opt">${esc(l.option)}</span>`);
            selList(l.modifiers).forEach(sm => {
                const def = (l.modifiers || []).find(m => m && m.name === sm.name) || { name: sm.name, type: 'extra' };
                chips.push(`<span class="go-cline-mod">${esc(modLabel(normalizeModifier(def), sm.qty))}</span>`);
            });
            if (l.preferredTime) chips.push(`<span class="go-cline-mod">🕒 ${esc(l.preferredTime)}</span>`);
            // Transfer'e özel alanlar — preferredTime bu kalemlerde zaten
            // boş kalır (mutually exclusive), o yüzden çakışma olmaz.
            if (l.transferFrom || l.transferTo) chips.push(`<span class="go-cline-mod">${esc((l.transferFrom || '?') + ' → ' + (l.transferTo || '?'))}</span>`);
            if (l.transferDate || l.transferTime) chips.push(`<span class="go-cline-mod">🕒 ${esc([l.transferDate ? String(l.transferDate).split('-').reverse().join('.') : '', l.transferTime].filter(Boolean).join(' '))}</span>`);
            if (l.note) chips.push(`<span class="go-cline-mod go-cline-notechip">📝 ${esc(l.note)}</span>`);
            const chipsHtml = chips.length ? `<div class="go-cline-chips">${chips.join('')}</div>` : '';
            const single = lineMax(l) === 1;
            const qtyHtml = single
                ? `<span class="go-cline-single">${esc(t('guest.item.singleOnly'))}</span>`
                : stepHtml('c' + i, l.qty).replace('data-dec="c' + i + '"', 'data-cdec="' + i + '"').replace('data-inc="c' + i + '"', 'data-cinc="' + i + '"');
            return `
            <div class="go-cline" data-i="${i}">
                <div class="go-cline-top">
                    <div class="go-cline-emoji">${esc(l.icon || '🛎️')}</div>
                    <div class="go-cline-main" data-editline="${i}">
                        <div class="go-cline-name">${esc(l.name)}</div>
                        <div class="go-cline-cat">${esc(l.category || '')}<span class="go-cline-editic" aria-hidden="true">✎</span></div>
                        ${chipsHtml}
                        ${lineBreakdownHtml(l)}
                    </div>
                    <button class="go-cline-del" data-del="${i}" aria-label="Sil">🗑</button>
                </div>
                <div class="go-cline-row">
                    ${qtyHtml}
                    ${(pricesOn() && priceOf(l)) ? `<span class="go-cline-price">${esc(fmtPrice(priceOf(l) * l.qty))}</span>` : ''}
                </div>
            </div>`;
        };
        // Satırlar DEPARTMANA göre gruplanır: birden fazla departmana giden
        // sepette neyin nereye gittiği görünür olsun (kat hizmetleri ile oda
        // servisi aynı listede karışmasın). Tek departman varsa başlık
        // gösterilmez — gereksiz krom.
        const groups = [];
        cart.forEach((l, i) => {
            // canonicalDept (js/core/firebase-config.js): eş adları tek başlığa
            // indirger — "Housekeeping" ve "Kat Hizmetleri" sepette iki ayrı
            // grup olarak görünmesin (geçiş dönemi verisi).
            const raw = String(l.department || l.category || '').trim();
            const key = (raw && typeof canonicalDept === 'function' ? canonicalDept(raw) : raw) || t('common.other');
            let g = groups.find(x => x.key === key);
            if (!g) { g = { key: key, rows: [] }; groups.push(g); }
            g.rows.push(lineHtml(l, i));
        });
        wrap.innerHTML = groups.length === 1
            ? groups[0].rows.join('')
            : groups.map(g => `<div class="go-cart-grp">${esc(g.key)}</div>` + g.rows.join('')).join('');
        wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { cart.splice(+b.dataset.del, 1); saveCart(); renderCartUI(); renderCart(); refreshAllItemRows(); });
        wrap.querySelectorAll('[data-cinc]').forEach(b => b.onclick = () => bumpLine(+b.dataset.cinc, +1));
        wrap.querySelectorAll('[data-cdec]').forEach(b => b.onclick = () => bumpLine(+b.dataset.cdec, -1));
        // Kartın tamamına (isim/kategori/etiketler alanı) dokununca o kalemin
        // ürün detay sheet'i açılır — seçenek/modifier/not/saat değiştirmek
        // için sepetten ayrı bir yere gitmeye gerek kalmaz.
        wrap.querySelectorAll('[data-editline]').forEach(el => el.onclick = () => {
            const l = cart[+el.dataset.editline]; if (l) openItemSheet(l.catalogId);
        });
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
        if (cd > 0) { toast(t('guest.cart.tooFast', { n: Math.ceil(cd / 1000) }), true); return; }
        if (hasPending()) { toast(t('guest.cart.pendingExists'), true); showTab('orders'); return; }
        if (!isVerified()) { openGate(); return; }
        if (!ROOM) { openGate(); return; }

        // Sepette beklerken transfer için seçilen tarih/saat, "en yakın yarım
        // saat" penceresini geçmiş olabilir — göndermeden hemen önce taze bir
        // sınıra karşı yeniden doğrula; geçersizse kalemin sheet'ini açıp
        // durdur (bkz. Transfer alanları — operasyonel denetim).
        const tb = transferMinBound();
        for (const l of cart) {
            if (!l.transferDate || !l.transferTime) continue;
            const picked = new Date(l.transferDate + 'T' + l.transferTime + ':00');
            if (isNaN(picked.getTime()) || picked.getTime() < tb.ms) {
                toast(t('guest.transfer.stale', { name: l.name }), true);
                openItemSheet(l.catalogId);
                return;
            }
        }

        const btn = $('goSubmit'); btn.disabled = true; $('goSubmitLabel').textContent = t('common.sending');
        const items = cart.map((l, idx) => ({
            id: 'i' + idx + '_' + Date.now().toString(36),
            catalogId: l.catalogId || '', name: String(l.name || '').slice(0, 120), category: String(l.category || '').slice(0, 60),
            icon: String(l.icon || '🛎️').slice(0, 8), department: String(l.department || '').slice(0, 60),
            price: priceOf(l), qty: Math.min(lineMax(l), Math.max(1, l.qty || 1)),
            note: String(l.note || '').slice(0, 160), preferredTime: String(l.preferredTime || '').slice(0, 10),
            option: String(l.option || '').slice(0, 60),
            // Süre ve tek-adet sınırı price ile AYNI gerekçeyle damgalanır:
            // takip ekranı EDT'yi ve adet kontrolünün görünüp görünmeyeceğini
            // katalog sonradan değişse (ya da kalem silinse) bile doğru bilir.
            etaMin: Math.max(0, Math.min(1440, Number(l.etaMin) || 0)),
            etaMax: Math.max(0, Math.min(1440, Number(l.etaMax) || 0)),
            maxQty: Math.max(0, Math.min(MAX_QTY, Number(l.maxQty) || 0)),
            modifiers: (Array.isArray(l.modifiers) ? l.modifiers : []).slice(0, 10)
                .map(m => ({ name: String((m && m.name) || '').slice(0, 60), type: (m && m.type) === 'extra' ? 'extra' : 'remove', priceDelta: Number(m && m.priceDelta) || 0, qty: Math.max(1, Math.min(MAX_MOD_QTY, Number(m && m.qty) || 1)) })),
            transferFrom: String(l.transferFrom || '').slice(0, 80), transferTo: String(l.transferTo || '').slice(0, 80),
            transferDate: String(l.transferDate || '').slice(0, 10), transferTime: String(l.transferTime || '').slice(0, 5),
            status: 'pending'
        }));
        const total = items.reduce((s, it) => s + (Number(it.price) || 0) * it.qty, 0);
        const done = (id) => {
            try { localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS)); } catch (e) {}
            cart = []; saveCart(); renderCartUI();
            btn.disabled = false; $('goSubmitLabel').textContent = t('guest.cart.submit');
            toast((DEMO ? t('guest.cart.submittedDemo') : t('guest.cart.submitted'))); buzz([40, 30, 40]);
            trackingId = id; showTab('orders'); openTracking(id);
        };
        const fail = (err) => {
            const code = (err && err.code) || '';
            console.error('submit failed', code, err);
            btn.disabled = false; $('goSubmitLabel').textContent = t('guest.cart.submit');
            // permission-denied = sunucudaki doğrulanmış oturum artık bu anonim
            // UID'ye ait değil (UID döndü ya da misafir çıkış yaptı). Genel
            // "tekrar deneyin" mesajı burada ÇIKMAZ SOKAK: tekrar denemek asla
            // çalışmaz. Doğrulamayı sıfırlayıp kapıyı açarız — sepet korunur.
            if (code === 'permission-denied') {
                clearVerified();
                toast(t('guest.gate.expired'), true);
                openGate();
                return;
            }
            toast(t('guest.cart.failed'), true);
        };

        if (DEMO) { const id = 'demo' + Date.now().toString(36); saveDemoOrder({ id, room: ROOM, guestName, items, itemCount: items.length, total, currency: config.currency, showPrices: pricesOn(), createdAtMs: Date.now() }); loadDemoOrders(); done(id); return; }

        db.collection('guestOrders').add({
            // sessionUid CANLI oturumdan okunur (önbelleğe alınmış değişkenden
            // değil): firestore.rules `sessionUid == request.auth.uid` şartını
            // koşuyor, dolayısıyla yazımın tam o andaki UID ile eşleşmesi
            // gerekir — arada anonim oturum yenilenmiş olabilir.
            tenantId: TENANT, room: ROOM, guestName: guestName || '', sessionUid: currentUid(),
            status: 'pending', items, itemCount: items.length, total, currency: config.currency || '₺', showPrices: pricesOn(),
            statusLog: [{ status: 'pending', at: Date.now(), by: 'guest' }],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            // tsMs() serverTimestamp henüz çözülmemişken (yerel pending-write
            // snapshot'ında createdAt null gelir) createdAtMs'e düşer — bu alan
            // olmadan yeni sipariş epoch(1970) sayılıp listenin EN ESKİSİ gibi
            // sıralanıyordu, ta ki sunucu zaman damgası gelene kadar.
            createdAtMs: Date.now(),
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
        // tenantId filtresi KRİTİK: sessionUid tek başına aynı cihaz/tarayıcıda
        // ?tenant= değişse bile sabit kalır (anonim auth origin bazlı LOCAL
        // persistence) — tenantId olmadan bir otelin siparişleri başka bir
        // otelin QR'ını okutan aynı misafire sızabilirdi.
        ordersUnsub = db.collection('guestOrders').where('sessionUid', '==', sessionUid).where('tenantId', '==', TENANT).onSnapshot(snap => {
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
        renderLive();
        if (currentTab === 'orders') {
            if (trackingId && !$('goTrack').classList.contains('go-hidden')) renderTracking();
            else showOrderList();
        }
    }

    // ── Canlı durum widget'ı ────────────────────────────────────
    // Aktif (tamamlanmamış/iptal edilmemiş) talep varken nav bar'ın üzerinde
    // minimize bir özet bar durur — hangi sekmede olursanız olun (Taleplerim
    // hariç) talebin anlık durumu görünür ve onSnapshot ile kendiliğinden
    // güncellenir. Bara dokununca yukarı doğru genişleyen float panelde her
    // aktif talep ayrı satırdır; satıra dokunmak takip ekranını açar.
    const activeOrdersList = () => myOrders.filter(o => o.status !== 'completed' && o.status !== 'cancelled');
    function liveProgress(status) {
        const idx = Math.max(0, FLOW.indexOf(status));
        return `<span class="go-live-prog">${FLOW.map((s, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</span>`;
    }
    // Ana sayfadaki canlı takip şeridi — TEK SATIR, katlanmaz.
    // Eski tasarım açılıp kapanan bir paneldi: ekranın altında yer kaplıyor,
    // sepet pill'i ile çakışıyor ve iki dokunuş istiyordu (aç → satır seç).
    // Artık en yakın teslimli aktif talep doğrudan gösterilir ve tek dokunuşla
    // onun takip ekranı açılır; birden fazla aktif talep varsa sağda sayı
    // rozeti çıkar.
    function nearestActive() {
        const act = activeOrdersList();
        if (act.length < 2) return act[0] || null;
        let best = act[0], bestEnd = Infinity;
        act.forEach(o => {
            const w = orderEta(o);
            const e = w ? w.end : Infinity;
            if (e < bestEnd) { bestEnd = e; best = o; }
        });
        return best;
    }
    function renderLive() {
        const wrap = $('goLive'); if (!wrap) return;
        const act = activeOrdersList();
        const show = act.length > 0 && currentTab !== 'orders';
        wrap.hidden = !show;
        document.body.classList.toggle('go-has-live', show);
        if (!show) return;
        const o = nearestActive();
        const st = STATUS[o.status] || STATUS.pending;
        const names = (o.items || []).map(it => it.name).join(', ');
        const title = names.length > 30 ? names.slice(0, 29) + '…' : (names || ((o.items || []).length + ' talep'));
        const w = orderEta(o);
        const sub = w ? fmtWindow(w) + ' · ' + etaRemainText(w) : relTime(tsMs(o));
        $('goLiveBar').dataset.track = o.id;
        $('goLiveBar').innerHTML = `
            <span class="go-live-dot go-st-${esc(o.status)}"></span>
            <span class="go-live-main">
                <span class="go-live-tl"><b>${esc(title)}</b><span class="go-statepill go-st-${esc(o.status)}">${esc(st.label)}</span></span>
                <span class="go-live-sub">${esc(sub)}</span>
                ${liveProgress(o.status)}
            </span>
            ${act.length > 1 ? `<span class="go-live-more">+${act.length - 1}</span>` : ''}
            <span class="go-live-chev">${svg('<polyline points="9 18 15 12 9 6"/>', 17)}</span>`;
    }
    // Geçen süre metni ("5 dk önce") Firestore'dan yeni bir güncelleme
    // gelmeden de eskiyeceğinden, widget aktif talep varken periyodik olarak
    // yeniden çizilir — onSnapshot yalnızca VERİ değiştiğinde tetiklenir,
    // saatin ilerlemesiyle değil.
    setInterval(() => { if (activeOrdersList().length) renderLive(); }, 30000);

    // Concierge kalemi: departman/kategori Concierge'i işaret eder — bu
    // talepler rezervasyon akışında işler ve ayrı sekmede gösterilir.
    function isConciergeItem(it) {
        const s = (String(it && it.department || '') + ' ' + String(it && it.category || '')).toLocaleLowerCase('tr-TR');
        return s.indexOf('concierge') !== -1 || s.indexOf('konsiyerj') !== -1;
    }
    // Transfer tespiti: functions/order-bridge.js'teki AYNI ada-dayalı
    // sezgi (katalog şemasına yeni bir alan eklemek yerine mevcut,
    // kanıtlanmış deseni client-side'da da kullanır) — "Nereden/Nereye/
    // Tarih/Saat zorunlu" özel formunu yalnızca adı "transfer" içeren
    // kalemlerde gösterir (operasyonel denetim).
    function isTransferItem(item) {
        return /transfer/.test(String((item && item.name) || '').toLocaleLowerCase('tr-TR'));
    }
    // En yakın yarım saate yuvarlar — misafir bir transferi geçmişte veya
    // birkaç dakika sonrasına talep edemesin diye (bu bir zamanlama UX
    // kılavuzu, güvenlik sınırı değil — yalnızca client-side uygulanır,
    // bkz. Transfer alanları planı).
    function nextHalfHourFrom(d) {
        const ms = 30 * 60 * 1000;
        return new Date(Math.ceil(d.getTime() / ms) * ms);
    }
    function transferMinBound() {
        const min = nextHalfHourFrom(new Date());
        const p = n => String(n).padStart(2, '0');
        return {
            dateIso: min.getFullYear() + '-' + p(min.getMonth() + 1) + '-' + p(min.getDate()),
            timeHHMM: p(min.getHours()) + ':' + p(min.getMinutes()),
            ms: min.getTime()
        };
    }
    const orderHasConcierge = o => (o.items || []).some(isConciergeItem);
    const orderHasNormal = o => (o.items || []).some(it => !isConciergeItem(it));
    let ordersTab = 'req'; // 'req' (normal talepler) | 'con' (concierge)

    function showOrderList() {
        trackingId = null;
        $('goTrack').classList.add('go-hidden');
        $('goOrders').classList.remove('go-hidden');
        $('goTrackBack').hidden = true;
        $('goOrdersTitle').textContent = 'Taleplerim';
        const wrap = $('goOrders');
        if (!myOrders.length) {
            wrap.innerHTML = `<div class="go-empty"><div class="go-empty-ic">📋</div><h3>${esc(t('guest.track.none'))}</h3><p>${esc(t('guest.track.noneHint'))}</p><button class="go-cta" data-go="services">${esc(t('guest.track.create'))}</button></div>`;
            wrap.querySelector('[data-go]').onclick = () => showTab('services');
            return;
        }
        // Concierge talepleri ayrı sekmede — hiç concierge siparişi yoksa
        // sekme çubuğu hiç görünmez (mevcut davranış birebir korunur).
        const anyCon = myOrders.some(orderHasConcierge);
        let tabsHtml = '';
        let list = myOrders;
        if (anyCon) {
            if (ordersTab === 'con') list = myOrders.filter(orderHasConcierge);
            else list = myOrders.filter(o => orderHasNormal(o) || !orderHasConcierge(o));
            const nReq = myOrders.filter(o => orderHasNormal(o) || !orderHasConcierge(o)).length;
            const nCon = myOrders.filter(orderHasConcierge).length;
            tabsHtml = `<div class="go-otabs">
                <button class="go-otab ${ordersTab === 'req' ? 'active' : ''}" data-otab="req">Talepler<i>${nReq}</i></button>
                <button class="go-otab ${ordersTab === 'con' ? 'active' : ''}" data-otab="con">🛎️ Concierge<i>${nCon}</i></button>
            </div>`;
            if (!list.length) {
                wrap.innerHTML = tabsHtml + `<div class="go-empty"><div class="go-empty-ic">📋</div><h3>${esc(t('guest.track.noneInTab'))}</h3></div>`;
                wrap.querySelectorAll('[data-otab]').forEach(b => b.onclick = () => { ordersTab = b.dataset.otab; showOrderList(); });
                return;
            }
        }
        wrap.innerHTML = tabsHtml + list.map(o => {
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
        wrap.onclick = e => {
            const t = e.target.closest('[data-otab]');
            if (t) { ordersTab = t.dataset.otab; showOrderList(); return; }
            const b = e.target.closest('[data-open]'); if (b) openTracking(b.dataset.open);
        };
    }

    function openTracking(id) {
        trackingId = id;
        trackEditItemId = null;
        showTab('orders', { keepTrack: true });
        $('goOrders').classList.add('go-hidden');
        $('goTrack').classList.remove('go-hidden');
        $('goTrackBack').hidden = false;
        $('goOrdersTitle').textContent = 'Talep Takibi';
        renderTracking();
        $('goTrack').scrollTop = 0;
    }
    function currentTracked() { return myOrders.find(o => o.id === trackingId) || null; }
    // Kalem hâlâ 'pending' (personel henüz üstlenmedi) olduğu sürece misafir
    // o kalemi düzenleyebilir/iptal edebilir — sunucuda updateGuestOrderItem/
    // cancelGuestOrderItem AYNI şartı (item.status + guestLogs durumu) tekrar
    // kontrol eder (bkz. functions/index.js), burası yalnızca UI kapısı.
    let trackEditItemId = null, trackEditQty = 1;
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
            // Transfer kalemleri: Nereden→Nereye + tarih/saat ayrı gösterilir;
            // preferredTime bu kalemlerde zaten boş kalır (mutually exclusive
            // — bkz. Transfer alanları), o yüzden yalnızca transfer bilgisi
            // YOKSA gösterilir.
            const transferMeta = (it.transferFrom || it.transferTo) ? (it.transferFrom || '?') + ' → ' + (it.transferTo || '?') : '';
            const transferWhen = (it.transferDate || it.transferTime)
                ? [it.transferDate ? String(it.transferDate).split('-').reverse().join('.') : '', it.transferTime].filter(Boolean).join(' ') : '';
            const bits = [it.option || '', it.qty > 1 ? it.qty + ' adet' : '', transferMeta, transferWhen,
                (!transferWhen && it.preferredTime) ? '🕐 ' + it.preferredTime : '', it.note];
            if (Array.isArray(it.modifiers) && it.modifiers.length) bits.push(it.modifiers.map(m => modLabel(normalizeModifier(m), Number(m.qty) || 1)).join(', '));
            if (showP && Number(it.price) > 0) bits.push(money(Number(it.price) * (it.qty || 1)));
            const meta = bits.filter(Boolean).join(' · ');
            // Tahmini teslim: tamamlandıysa gerçek saat, iptalse hiç, aksi
            // halde kayan EDT penceresi (bkz. etaWindow/slideWindow).
            const ie = itemEta(o, it);
            const etaHtml = !ie ? ''
                : (ie.done
                    ? `<div class="go-titem-eta done">${esc(ie.at ? t('guest.eta.deliveredAt', { time: clock(ie.at) }) : t('guest.eta.delivered'))}</div>`
                    : `<div class="go-titem-eta">${esc(t('guest.eta.item', { window: fmtWindow(ie) }))}</div>`);
            // Düzenleme/iptal, personel işi ÜSTLENENE kadar açık: kalem
            // 'pending' ya da 'confirmed' iken. Asıl operasyonel güvence
            // sunucudaki canCancelItem() (bağlı guestLogs hâlâ 'Following' mi)
            // — burası yalnızca arayüz kapısı, onunla aynı sınırı çizer.
            const editable = (it.status || 'pending') === 'pending' || it.status === 'confirmed';
            const canAct = !DEMO && !cancelled && editable;
            if (canAct && trackEditItemId === it.id) {
                return `<div class="go-titem go-titem-editing">
                    <div class="go-titem-emoji">${esc(it.icon || '🛎️')}</div>
                    <div class="go-titem-main" style="width:100%;">
                        <div class="go-titem-name">${esc(it.name)}</div>
                        ${lineMax(it) > 1 ? `<div class="go-fld-2" style="margin-top:8px;">
                            <div class="go-fld"><label>${esc(t('guest.item.quantity'))}</label><div class="go-step"><button id="goTEDec">−</button><b id="goTEQty">${trackEditQty}</b><button id="goTEInc">+</button></div></div>
                        </div>` : ''}
                        <div class="go-fld" style="margin-top:8px;"><label>Not</label><input type="text" id="goTENote" maxlength="160" value="${esc(it.note || '')}"></div>
                        <div class="go-track-btns" style="margin-top:10px;">
                            <button class="go-btn-ghost" id="goTECancel">${esc(t('common.cancel'))}</button>
                            <button class="go-cta" id="goTESave">Kaydet</button>
                        </div>
                    </div>
                </div>`;
            }
            return `<div class="go-titem"><div class="go-titem-emoji">${esc(it.icon || '🛎️')}</div>
                <div class="go-titem-main"><div class="go-titem-name">${esc(it.name)}</div>${meta ? `<div class="go-titem-meta">${esc(meta)}</div>` : ''}
                ${etaHtml}
                ${it.status === 'cancelled' && it.cancelReason ? `<div class="go-titem-cancel-reason">${esc(it.cancelReason)}</div>` : ''}
                ${canAct ? `<div class="go-titem-acts"><button class="go-titem-act" data-item-edit="${esc(it.id)}">${esc(t('common.edit'))}</button><button class="go-titem-act danger" data-item-cancel="${esc(it.id)}">${esc(t('guest.track.cancelItem'))}</button></div>` : ''}</div>
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
                ${(() => { const w = orderEta(o); return w ? `<div class="go-track-eta">${esc(t('guest.eta.order', { window: fmtWindow(w) }))}<span>${esc(etaRemainText(w))}</span></div>` : ''; })()}
            </div>
            ${cancelled && o.cancelReason ? `<div class="go-cancel-reason">
                <div class="go-cancel-reason-h">İptal Nedeni</div>
                <div class="go-cancel-reason-b">${esc(o.cancelReason)}</div>
            </div>` : ''}
            ${steps}
            <div class="go-track-sec">Talepleriniz</div>
            ${items}
            <div class="go-track-btns">
                ${(o.status === 'pending' || o.status === 'confirmed') ? `<button class="go-btn-ghost go-btn-danger" id="goCancelBtn">${esc(t('guest.track.cancelOrder'))}</button>` : ''}
                <button class="go-btn-ghost" id="goNewBtn">${esc(t('guest.track.createNew'))}</button>
            </div>`;
        const cb = $('goCancelBtn'); if (cb) cb.onclick = () => cancelOrder(o.id);
        $('goNewBtn').onclick = () => showTab('services');
        wrap.querySelectorAll('[data-item-edit]').forEach(b => b.onclick = () => {
            const it = (o.items || []).find(x => x.id === b.dataset.itemEdit); if (!it) return;
            trackEditItemId = it.id; trackEditQty = Math.max(1, it.qty || 1);
            renderTracking();
        });
        wrap.querySelectorAll('[data-item-cancel]').forEach(b => b.onclick = () => cancelOrderItem(o.id, b.dataset.itemCancel));
        const teDec = $('goTEDec'), teInc = $('goTEInc'), teQty = $('goTEQty');
        if (teDec) teDec.onclick = () => { if (trackEditQty > 1) { trackEditQty--; teQty.textContent = trackEditQty; } };
        if (teInc) teInc.onclick = () => { if (trackEditQty < MAX_QTY) { trackEditQty++; teQty.textContent = trackEditQty; } };
        const teCancel = $('goTECancel'); if (teCancel) teCancel.onclick = () => { trackEditItemId = null; renderTracking(); };
        const teSave = $('goTESave'); if (teSave) teSave.onclick = () => saveTrackItemEdit(o.id, trackEditItemId);
    }
    async function saveTrackItemEdit(orderId, itemId) {
        if (!fns) { toast(t('common.noConnection'), true); return; }
        const note = ($('goTENote') && $('goTENote').value || '').slice(0, 160);
        const btn = $('goTESave'); if (btn) { btn.disabled = true; btn.textContent = 'Kaydediliyor…'; }
        try {
            const res = await fns.httpsCallable('updateGuestOrderItem')({ orderId, itemId, patch: { qty: trackEditQty, note } });
            if (!res || !res.data || !res.data.ok) throw new Error('fail');
            trackEditItemId = null; toast(t('guest.track.itemUpdated')); renderTracking();
        } catch (e) {
            console.error('update item failed', e);
            toast(t('guest.track.updateFailedTaken'), true);
            if (btn) { btn.disabled = false; btn.textContent = 'Kaydet'; }
        }
    }
    async function cancelOrderItem(orderId, itemId) {
        if (!confirm(t('guest.track.confirmCancelItem'))) return;
        if (!fns) { toast(t('common.noConnection'), true); return; }
        try {
            const res = await fns.httpsCallable('cancelGuestOrderItem')({ orderId, itemId });
            if (!res || !res.data || !res.data.ok) throw new Error('fail');
            toast(t('guest.track.itemCancelled'));
        } catch (e) {
            console.error('cancel item failed', e);
            toast(t('guest.track.cancelFailedTaken'), true);
        }
    }
    function cancelOrder(id) {
        if (!confirm(t('guest.track.confirmCancelOrder'))) return;
        if (DEMO) { const o = loadDemoOrder(id); if (o) { o.cancelled = true; saveDemoOrder(o); } if (demoTimer) { clearInterval(demoTimer); } loadDemoOrders(); return; }
        if (!fns) { toast(t('common.noConnection'), true); return; }
        // Eskiden çıplak bir client .update({status:'cancelled'}) idi — hiçbir
        // bağlı guestLogs/reservations dokümanına dokunmuyordu (misafir
        // iptal etti gibi görünüyordu ama personel Concierge panelinde
        // hiç haberdar olmuyordu). Artık tek transaction'da bağlı tüm
        // dokümanları senkronize eden Cloud Function'ı çağırıyor.
        fns.httpsCallable('cancelGuestOrder')({ orderId: id })
            .then(res => { if (!res || !res.data || !res.data.ok) throw new Error('fail'); toast(t('guest.track.orderCancelled')); })
            .catch(err => { console.error(err); toast(t('guest.track.cancelFailed'), true); });
    }

    // ── Zaman ──────────────────────────────────────────────────
    function clock(ms) { if (!ms) return ''; try { return new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
    function relTime(ms) {
        if (!ms) return '';
        const diff = Date.now() - ms;
        if (diff < 60000) return t('common.justNow');
        if (diff < 3600000) return t('common.minAgo', { n: Math.floor(diff / 60000) });
        if (diff < 86400000) return t('common.hourAgo', { n: Math.floor(diff / 3600000) });
        // Tarih biçimi aktif dile göre (bkz. I18n.locale()).
        try { return new Date(ms).toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'short' }); } catch (e) { return ''; }
    }

    // ════════════════════════════════════════════════════════════
    //  DOĞRULAMA (soyadı + oda) + güvenli ad
    // ════════════════════════════════════════════════════════════
    function maybeGate() { if (!isVerified()) openGate(); }
    function openGate() {
        $('goGateBackdrop').classList.add('show');
        $('goGate').classList.add('show');
        $('goGate').setAttribute('aria-hidden', 'false');
        setTimeout(() => { const el = $('goGateSurname'); if (el) el.focus(); }, 250);
    }
    function closeGate() {
        $('goGateBackdrop').classList.remove('show');
        $('goGate').classList.remove('show');
        $('goGate').setAttribute('aria-hidden', 'true');
    }
    async function doVerify() {
        const surname = ($('goGateSurname').value || '').trim();
        const byRaw = ($('goGateBirthYear').value || '').trim();
        const birthYear = parseInt(byRaw, 10);
        const err = $('goGateErr'); const setErr = m => err.textContent = m || '';
        if (surname.length < 2) { setErr(t('guest.gate.needSurname')); return; }
        const thisYear = new Date().getFullYear();
        if (!byRaw || !isFinite(birthYear) || birthYear < 1900 || birthYear > thisYear) { setErr(t('guest.gate.needBirthYear')); return; }
        setErr('');
        const btn = $('goGateBtn'), lbl = $('goGateBtnLabel');
        btn.disabled = true; lbl.textContent = 'Kontrol ediliyor…';
        const fail = m => { btn.disabled = false; lbl.textContent = t('guest.gate.submit'); setErr(m); buzz(70); };
        // room ARTIK istemciden gelmiyor — sunucu (verifyGuestIdentity),
        // soyad+doğum yılını guestDirectory ile eşleştirip misafirin GERÇEK
        // odasını döner. QR'ın URL'sindeki eski room= değeri (varsa) yalnızca
        // ilk yüklemede sepet anahtarı bağlamı için kullanılmıştı; güvenlik
        // açısından hiç güvenilmiyordu ve burada tamamen göz ardı edilir.
        const ok = (room, name) => {
            // ROOM ilk kez atanıyorsa (önceden boştu, genel 'x' anahtarı
            // altında bir sepet olabilir) bu sepeti yeni oda-bazlı anahtara
            // TAŞI — aksi halde recomputeKeys()+loadCart() doğrulama öncesi
            // eklenen ürünleri sessizce sıfırlıyordu. Gerçek bir oda
            // DEĞİŞİMİNDE (ROOM zaten doluydu) her odanın kendi sepeti
            // korunur — bu durum bilinçli bir tasarım, hata değil.
            const wasFirstAssignment = !ROOM;
            const cartBeforeSwitch = cart.slice();
            ROOM = room; recomputeKeys();
            if (wasFirstAssignment && cartBeforeSwitch.length) { cart = cartBeforeSwitch; saveCart(); }
            else { loadCart(); }
            setVerified(); setSurname(surname);
            if (name) setGuestName(name);
            btn.disabled = false; lbl.textContent = t('guest.gate.submit');
            closeGate(); applyConfig(); renderAll();
            toast(guestName ? (t('guest.home.welcome') + ' ' + guestName.split(' ')[0] + ' 👋') : t('guest.gate.verified'));
        };
        try {
            if (DEMO) { await new Promise(r => setTimeout(r, 500)); ok(ROOM || '101', titleCase(surname)); return; }
            if (!fns) { fail(t('guest.gate.noConnectionRetry')); return; }
            const res = await fns.httpsCallable('verifyGuestIdentity')({ tenant: TENANT, surname, birthYear });
            if (!res || !res.data || !res.data.ok) {
                // Sunucu artık RED NEDENİNİ dönüyor. Eskiden hepsi tek mesaja
                // ("bilgiler eşleşmedi") iniyordu: hız sınırına takılan ya da
                // kaydında belirsizlik olan misafir, doğru bilgiyi girmiş
                // olmasına rağmen ne yapacağını bilemiyordu.
                const REASON = {
                    rate_limited: 'guest.gate.tooMany',
                    ambiguous: 'guest.gate.ambiguous',
                    no_room: 'guest.gate.noRoom',
                    unavailable: 'guest.gate.failed'
                };
                fail(t(REASON[(res && res.data && res.data.reason) || ''] || 'guest.gate.mismatch'));
                return;
            }
            ok(res.data.room, res.data.guestName || '');
        } catch (e) { console.error('verify failed', e); fail(t('guest.gate.failed')); }
    }
    function titleCase(s) { return String(s || '').toLocaleLowerCase('tr-TR').replace(/(^|\s)\S/g, c => c.toLocaleUpperCase('tr-TR')); }

    // ── Otel bilgileri sheet ───────────────────────────────────
    function infoRow(ic, label, value, opts) {
        opts = opts || {}; const val = String(value == null ? '' : value).trim(); if (!val) return '';
        let act = '';
        if (opts.tel) act = `<a class="go-inforow-act" href="tel:${esc(opts.tel)}">Ara</a>`;
        else if (opts.map) act = `<a class="go-inforow-act" href="https://maps.google.com/?q=${encodeURIComponent(opts.map)}" target="_blank" rel="noopener">Harita</a>`;
        else if (opts.copy) act = `<button class="go-inforow-act" data-copy="${esc(opts.copy)}">${esc(t('guest.info.copy'))}</button>`;
        return `<div class="go-inforow"><span class="go-inforow-ic">${svg(INFO_ICONS[ic] || INFO_ICONS.pin, 22)}</span>
            <div class="go-inforow-tx"><div class="go-inforow-lbl">${esc(label)}</div><div class="go-inforow-val">${esc(val)}</div></div>${act}</div>`;
    }
    function openInfo() {
        const body = $('goInfoBody');
        const hname = (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT);
        const rows = [
            infoRow('phone', t('guest.info.reception'), config.phone, { tel: (config.phone || '').replace(/[^0-9+]/g, '') }),
            infoRow('wifi', t('guest.info.wifiName'), config.wifiName, { copy: config.wifiName }),
            infoRow('wifi', t('guest.info.wifiPass'), config.wifiPass, { copy: config.wifiPass }),
            infoRow('clock', t('guest.info.checkout'), config.checkoutTime),
            infoRow('coffee', t('guest.info.breakfast'), config.breakfast),
            infoRow('pin', t('guest.info.address'), config.address, { map: config.address })
        ].filter(Boolean).join('');
        body.innerHTML = `<div class="go-info-hero"><h3>${esc(hname)}</h3>${config.welcome && config.welcome.trim() ? `<p>${esc(config.welcome.trim())}</p>` : ''}</div>${rows || `<div class="go-empty"><div class="go-empty-ic">ℹ️</div><h3>${esc(t('guest.info.none'))}</h3><p>${esc(t('guest.info.noneHint'))}</p></div>`}`;
        body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { try { navigator.clipboard.writeText(b.dataset.copy); toast(t('common.copied')); } catch (e) {} });
        $('goInfoBackdrop').classList.add('show');
        $('goInfoSheet').classList.add('show');
        $('goInfoSheet').setAttribute('aria-hidden', 'false');
    }
    function closeInfo() { $('goInfoBackdrop').classList.remove('show'); $('goInfoSheet').classList.remove('show'); $('goInfoSheet').setAttribute('aria-hidden', 'true'); }

    // ════════════════════════════════════════════════════════════
    //  DEMO backend
    // ════════════════════════════════════════════════════════════
    const DEMO_STEPS = [[0, 'pending'], [25000, 'confirmed'], [60000, 'in_progress'], [110000, 'completed']];
    // CART_KEY/VERIFY_KEY gibi diğer localStorage anahtarlarının aksine bunlar
    // TENANT ile önekli değildi — aynı tarayıcıda ?tenant= değiştirilerek demo
    // modu farklı bir "otel" için açıldığında önceki otelin demo sipariş
    // geçmişi sızıyordu.
    function saveDemoOrder(o) { try { localStorage.setItem('go2_demo_' + TENANT + '_' + o.id, JSON.stringify(o)); const ids = demoIds(); if (!ids.includes(o.id)) { ids.push(o.id); localStorage.setItem('go2_demo_ids_' + TENANT, JSON.stringify(ids)); } } catch (e) {} }
    function loadDemoOrder(id) { try { return JSON.parse(localStorage.getItem('go2_demo_' + TENANT + '_' + id)); } catch (e) { return null; } }
    function demoIds() { try { return JSON.parse(localStorage.getItem('go2_demo_ids_' + TENANT)) || []; } catch (e) { return []; } }
    function demoView(o) {
        if (o.cancelled) return Object.assign({}, o, { status: 'cancelled', items: (o.items || []).map(it => Object.assign({}, it, { status: 'cancelled' })) });
        const e = Date.now() - (o.createdAtMs || Date.now());
        let status = 'pending'; const log = [];
        DEMO_STEPS.forEach(([t, s]) => { if (e >= t) { status = s; log.push({ status: s, at: (o.createdAtMs || 0) + t, by: t === 0 ? 'guest' : 'Personel' }); } });
        return Object.assign({}, o, {
            status, statusLog: log,
            items: (o.items || []).map(it => Object.assign({}, it, { status }))
        });
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
        // "Profil" (alt nav + üst avatar) artık ayrı bir sekme değil — Konaklama
        // sheet'ini açar (giriş/çıkış, Oda Hesabım, rezervasyonlar zaten orada).
        document.querySelectorAll('.go-nav-b').forEach(b => b.onclick = () => { if (b.dataset.go === 'profile') openStay(); else showTab(b.dataset.go); });
        // Dil düğmesi (ana ekran üst çubuğu). İki dil olduğu için tek dokunuş
        // diğerine geçirir; etiket HEDEF dili gösterir ki misafir ne olacağını
        // önceden bilsin.
        const lgb = $('goLangBtn');
        if (lgb) {
            const other = I18n.lang() === 'tr' ? 'en' : 'tr';
            lgb.textContent = other === 'en' ? 'EN' : 'TR';
            lgb.onclick = () => I18n.setLang(other);
        }
        document.querySelectorAll('[data-go]').forEach(el => { if (!el.classList.contains('go-nav-b')) el.addEventListener('click', () => showTab(el.dataset.go)); });
        $('goCartPill').onclick = () => showTab('cart');
        const lb = $('goLiveBar'); if (lb) lb.onclick = () => { const id = lb.dataset.track; if (id) openTracking(id); };
        const ibk = $('goItemBackdrop'); if (ibk) ibk.onclick = closeItemSheet;
        $('goBell').onclick = () => showTab('orders');
        const av = $('goAvatar'); if (av) av.onclick = openStay;
        const sb = $('goServicesBack'); if (sb) sb.onclick = () => showTab('home');
        const cbk = $('goCartBack'); if (cbk) cbk.onclick = () => showTab('home');
        $('goTrackBack').onclick = showOrderList;
        $('goCartClear').onclick = () => { if (cart.length && confirm('Sepeti temizlemek istiyor musunuz?')) { cart = []; saveCart(); renderCartUI(); renderCart(); refreshAllItemRows(); } };
        $('goSubmit').onclick = submitOrder;
        $('goGateBtn').onclick = doVerify;
        $('goGateBackdrop').onclick = () => { if (isVerified()) closeGate(); };
        const fc = $('goFolioClose'); if (fc) fc.onclick = closeFolio;
        const fb = $('goFolioBackdrop'); if (fb) fb.onclick = closeFolio;
        const ic = $('goInfoClose'); if (ic) ic.onclick = closeInfo;
        const ib = $('goInfoBackdrop'); if (ib) ib.onclick = closeInfo;
        const mc = $('goMenusClose'); if (mc) mc.onclick = closeMenus;
        const mb = $('goMenusBackdrop'); if (mb) mb.onclick = closeMenus;
        const sc2 = $('goStayClose'); if (sc2) sc2.onclick = closeStay;
        const sb2 = $('goStayBackdrop'); if (sb2) sb2.onclick = closeStay;
        // Arama
        const s = $('goSearch');
        if (s) s.addEventListener('input', () => { searchTerm = s.value; $('goSearchX').hidden = !s.value; renderItems(); });
        $('goSearchX').onclick = () => { searchTerm = ''; $('goSearch').value = ''; $('goSearchX').hidden = true; renderItems(); $('goSearch').focus(); };
        // Soyadı otomatik büyük harfe çevrilir.
        //
        // DÜZELTME: filtre eskiden `[^A-ZÇĞİÖŞÜ \-']` idi — yani YALNIZCA
        // Türkçe harfler. Yabancı misafirlerin soyadındaki Ø/Ñ/Å/Æ gibi
        // harfler ve Kiril/Yunan alfabesi tamamen SİLİNİYOR, misafir adını
        // yazamadığı için kimlik doğrulamasını hiç geçemiyordu. Artık her
        // Unicode HARF kabul edilir (rakam/simge hâlâ engellenir). Sunucu
        // zaten diyakritikleri katlayarak karşılaştırıyor
        // (functions/index.js:_normTr), bu yüzden eşleşme bozulmaz.
        const su = $('goGateSurname');
        if (su) su.addEventListener('input', () => {
            const p = su.selectionStart;
            var v = su.value.toLocaleUpperCase('tr-TR');
            try { v = v.replace(/[^\p{L} \-']/gu, ''); }
            catch (e) { v = v.replace(/[^A-ZÇĞİÖŞÜ \-']/g, ''); } // \p{L} desteklemeyen eski tarayıcı
            su.value = v;
            try { su.setSelectionRange(p, p); } catch (e) {}
        });
        ['goGateSurname', 'goGateBirthYear'].forEach(id => { const el = $(id); if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); }); });
    }

    // ── Go ─────────────────────────────────────────────────────
    // DEMO modu Firebase'e hiç dokunmaz (boot()'un DEMO dalına bakın) — bu
    // guard yine de db/auth'u şart koşuyordu, bu yüzden Firebase SDK script'i
    // (ör. ağ engeli, gstatic.com erişilemez) yüklenemediğinde ?demo bile
    // "Yapılandırma hatası" gösterip hiç boot olmuyordu.
    if (!DEMO && (typeof db === 'undefined' || typeof auth === 'undefined' || !db || !auth)) {
        const el = document.getElementById('goCats');
        if (el) el.innerHTML = `<div class="go-empty"><div class="go-empty-ic">⚠️</div><h3>${esc(t('guest.stay.configError'))}</h3><p>${esc(t('common.noConnection'))}</p></div>`;
        return;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
