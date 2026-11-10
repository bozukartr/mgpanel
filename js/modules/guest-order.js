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
    // Durum ikonları (emoji yerine çizgi ikon; renk .go-st-* sınıfından gelir).
    const STATUS_IC = { pending: 'clock', confirmed: 'check', in_progress: 'spark', completed: 'check', cancelled: 'x' };
    const statusIcon = (st, size) => icon(STATUS_IC[st] || 'clock', size || 20, 2);

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
        return `<svg viewBox="0 0 24 24" width="${size || 22}" height="${size || 22}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    }
    // Arayüz ikonları — emoji yerine tutarlı çizgi ikonlar (minimal tasarım).
    // Katalog kalemlerinin emojileri OTELE ait içeriktir, onlar olduğu gibi kalır.
    const IC = {
        plus: '<path d="M12 5v14M5 12h14"/>',
        minus: '<path d="M5 12h14"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
        chev: '<polyline points="9 18 15 12 9 6"/>',
        clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
        doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/>',
        bed: '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
        receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
        bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
        list: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
        lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
        spark: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
        bell: '<path d="M3 18h18"/><path d="M5 18a7 7 0 0 1 14 0"/><path d="M12 11V8.5"/><path d="M10 8.5h4"/><path d="M2 21h20"/>',
        compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z"/>',
        wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.3 6.3a2.1 2.1 0 0 1-3-3l6.3-6.3a6 6 0 0 1 7.9-7.9z"/>',
        utensils: '<path d="M3 2v7c0 1.1.9 2 2 2a2 2 0 0 0 2-2V2"/><path d="M5 11v11"/><path d="M19 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
        grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>'
    };
    function icon(k, size, sw) {
        return `<svg viewBox="0 0 24 24" width="${size || 20}" height="${size || 20}" fill="none" stroke="currentColor" stroke-width="${sw || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[k] || ''}</svg>`;
    }
    // Boş/hata durumu: emoji yerine ikonlu tek tip blok.
    function emptyHtml(ic, title, text, cta) {
        return `<div class="go-empty"><div class="go-empty-ic">${icon(ic, 28, 1.8)}</div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${cta || ''}</div>`;
    }
    let toastTimer = null;
    function toast(msg, isError) {
        const el = $('goToast');
        el.innerHTML = icon(isError ? 'alert' : 'check', 18, 2.2) + `<span>${esc(msg)}</span>`;
        el.className = 'go-toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'go-toast'; }, 2800);
        try { if (isError) navigator.vibrate && navigator.vibrate(70); } catch (e) {}
    }
    // Uygulama içi onay (tarayıcının confirm() penceresi yerine — o pencere
    // sayfanın adresini gösteriyor, karanlık temaya uymuyor ve mobilde
    // uygulama hissini bozuyordu). Promise<boolean> döner.
    function confirmSheet(opts) {
        return new Promise(resolve => {
            const sh = $('goConfirm'), bd = $('goConfirmBackdrop'), yes = $('goConfirmYes'), no = $('goConfirmNo');
            if (!sh) { resolve(window.confirm(opts.message || '')); return; }
            $('goConfirmTitle').textContent = opts.title || '';
            $('goConfirmMsg').textContent = opts.message || '';
            yes.textContent = opts.confirmText || t('common.ok');
            no.textContent = opts.cancelText || t('common.dismiss');
            yes.className = 'go-btn ' + (opts.danger ? 'go-btn-danger' : 'go-btn-primary');
            const done = v => {
                sh.classList.remove('show'); bd.classList.remove('show'); sh.setAttribute('aria-hidden', 'true');
                yes.onclick = null; no.onclick = null; bd.onclick = null;
                resolve(v);
            };
            yes.onclick = () => done(true); no.onclick = () => done(false); bd.onclick = () => done(false);
            bd.classList.add('show'); sh.classList.add('show'); sh.setAttribute('aria-hidden', 'false');
            setTimeout(() => { try { no.focus(); } catch (e) {} }, 60);
        });
    }
    // Ortak sheet aç/kapa.
    function openSheet(id, bdId) { $(bdId).classList.add('show'); $(id).classList.add('show'); $(id).setAttribute('aria-hidden', 'false'); }
    function closeSheet(id, bdId) { $(bdId).classList.remove('show'); $(id).classList.remove('show'); $(id).setAttribute('aria-hidden', 'true'); }
    function buzz(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }

    // Ad normalizasyonu — arama (renderItems) için kullanılır.
    function norm(s) {
        return String(s == null ? '' : s).trim().toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's')
            .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o')
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    // ── Departman → ad/ikon (ana ekran kutucukları + hizmet başlığı) ─────
    // BİLİNÇLİ OLARAK kategoriye göre DEĞİL departmana göre: kategori serbest
    // metindir (admin istediğini yazabilir), departman ise sabit bir kümedir
    // (Housekeeping/Front Desk/Engineering/Yiyecek & İçecek/Concierge). Bu
    // kümeye uymayan departmanlar (ör. otelin eklediği "Spa") 'other'
    // kutucuğunda toplanır — eskiden ana ekranda hiç görünmüyorlardı.
    // Etiketler GETTER: okunduğu an aktif dilden çözülür.
    function deptDef(key, icn) { return { icon: icn, get label() { return t('guest.dept.name.' + key); } }; }
    const DEPT_KIND_DEFS = {
        housekeeping: deptDef('housekeeping', 'spark'),
        fnb: deptDef('fnb', 'utensils'),
        engineering: deptDef('engineering', 'wrench'),
        frontdesk: deptDef('frontdesk', 'bell'),
        concierge: deptDef('concierge', 'compass'),
        other: deptDef('other', 'grid')
    };
    const DEPT_ORDER = ['housekeeping', 'fnb', 'engineering', 'frontdesk', 'concierge', 'other'];
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
        const ref = now == null ? Date.now() : now;
        const w = slideWindow(baseMs + m.min * 60000, baseMs + m.max * 60000, ref);
        w.ref = ref;
        return w;
    }
    // Kalemin PLANLI zamanı (ms) — yoksa 0. Transfer: seçilen tarih + saat.
    // Tercih edilen saat (ör. "Oda temizliği 15:00"): siparişin verildiği
    // gün; o saat 30 dk'dan fazla geçmişse ertesi gün (gece verilen "09:00"
    // sabahı kasteder). Önceden EDT her zaman siparişin verildiği andan
    // hesaplanıyordu: yarın 10:00'a istenen transfer bugün "14:15 – 14:30"
    // gösteriyor, sonra 5'er dk kayarak sürekli gecikiyormuş gibi görünüyordu.
    function scheduledAt(baseMs, it) {
        if (!it) return 0;
        if (it.transferDate && it.transferTime) {
            const d = new Date(String(it.transferDate).slice(0, 10) + 'T' + String(it.transferTime).slice(0, 5) + ':00').getTime();
            return isFinite(d) ? d : 0;
        }
        const pm = String(it.preferredTime || '').trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!pm || !baseMs) return 0;
        const d = new Date(baseMs);
        d.setHours(parseInt(pm[1], 10), parseInt(pm[2], 10), 0, 0);
        let ms = d.getTime();
        if (ms < baseMs - 30 * 60000) ms += 86400000;
        return ms;
    }
    // Kalemin teslim penceresi: planlı zaman, hazırlık süresinden SONRAYA
    // düşüyorsa pencere planlı zamandan başlar ve süre aralığı kadar (en az
    // bir kademe) sürer; aksi halde normal EDT. Kayma kuralı aynı.
    function itemWindow(baseMs, it, now) {
        const S = scheduledAt(baseMs, it);
        const m = etaMinutes(it);
        if (S && (!m || S > baseMs + m.min * 60000)) {
            const ref = now == null ? Date.now() : now;
            const span = Math.max(EDT_SLIDE_STEP_MS, m ? (m.max - m.min) * 60000 : 0);
            const w = slideWindow(S, S + span, ref);
            w.ref = ref; w.scheduled = true;
            return w;
        }
        return etaWindow(baseMs, it, now);
    }
    // Pencere bugünün dışındaysa saate tarih eklenir ("11.11 10:00").
    function dayTag(ms, ref) {
        const a = new Date(ms), b = new Date(ref == null ? Date.now() : ref);
        if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()) return '';
        return String(a.getDate()).padStart(2, '0') + '.' + String(a.getMonth() + 1).padStart(2, '0') + ' ';
    }
    function fmtWindow(w) { return w ? dayTag(w.start, w.ref) + clock(w.start) + ' – ' + (dayTag(w.end, w.start) ? dayTag(w.end, w.ref) : '') + clock(w.end) : ''; }
    // Pencerenin bitişine kalan süre ("8 dk"). Pencere içindeyken bile
    // pozitiftir (slideWindow bitişe 2 dk kala kaydırdığı için 0'a düşmez).
    function etaRemainText(w, now) {
        if (!w) return '';
        const left = Math.round((w.end - (now == null ? Date.now() : now)) / 60000);
        if (left <= 0) return t('guest.eta.soon');
        // Planlı (saatler/günler sonrası) teslimde "1080 dk kaldı" yazmasın.
        if (left >= 1440) return t('guest.eta.remainingD', { n: Math.round(left / 1440) });
        if (left >= 90) return t('guest.eta.remainingH', { h: Math.floor(left / 60), m: left % 60 });
        return t('guest.eta.remaining', { n: left });
    }
    // Pencere etiketi: planlı teslimde "Planlanan …", aksi halde verilen anahtar.
    function etaLabelText(w, key) {
        return t(w && w.scheduled ? 'guest.eta.scheduled' : key, { window: fmtWindow(w) });
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
        return itemWindow(tsMs(order), it, now);
    }
    // Sipariş penceresi = AÇIK ve PLANSIZ kalemlerin birleşimi (en erken
    // başlangıç, en geç bitiş — hepsi aynı andan hesaplandığı için dar bir
    // aralık). Yalnızca planlı kalemler kaldıysa EN YAKIN planlı pencere:
    // "şimdi" ile "yarın 10:00"ı tek aralıkta birleştirmek anlamsız olurdu.
    // Hepsi kapandıysa null.
    function orderEta(order, now) {
        let start = 0, end = 0, ref = null, next = null;
        (order.items || []).forEach(it => {
            const s = it.status || 'pending';
            if (s === 'cancelled' || s === 'completed') return;
            const w = itemWindow(tsMs(order), it, now);
            if (!w) return;
            if (w.scheduled) { if (!next || w.start < next.start) next = w; return; }
            start = start ? Math.min(start, w.start) : w.start;
            end = Math.max(end, w.end);
            ref = w.ref;
        });
        if (end) return { start: start, end: end, ref: ref };
        return next;
    }
    // Sepet için göreli aralık ("~20–30 dk") — henüz bir sipariş yok, mutlak
    // saat gösterilemez.
    function cartEtaText() {
        let lo = 0, hi = 0;
        cart.forEach(l => {
            // Planlı kalemler (transfer tarihi / tercih edilen saat) "~20 dk"
            // göreli tahminine katılmaz — teslimleri seçilen saatte.
            if (scheduledAt(Date.now(), l)) return;
            const m = etaMinutes(l) || etaMinutes(catalog.find(i => i.id === l.catalogId));
            if (!m) return;
            lo = lo ? Math.min(lo, m.min) : m.min;
            hi = Math.max(hi, m.max);
        });
        if (!hi) return '';
        return lo === hi ? t('guest.eta.cartOne', { n: hi }) : t('guest.eta.cartRange', { a: lo, b: hi });
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
    function prettyTenant(tn) { return tn ? tn.charAt(0).toUpperCase() + tn.slice(1) : 'Hotizy'; }
    function hotelName() { return (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT); }
    const phoneDigits = () => (config.phone || '').replace(/[^0-9+]/g, '');
    function applyConfig() {
        $('goApp').setAttribute('aria-busy', 'false');
        renderHome();
        renderProfile();
    }
    function timeGreeting() {
        const h = new Date().getHours();
        if (h < 5) return t('guest.home.greetNight');
        if (h < 12) return t('guest.home.greetMorning');
        if (h < 18) return t('guest.home.greetDay');
        return t('guest.home.greetEvening');
    }
    function firstName() {
        const n = (guestName || '').trim();
        return n ? n.split(/\s+/)[0] : t('guest.home.guestShort');
    }
    function renderGreeting() {
        const g = $('goGreetTime'); if (g) g.textContent = timeGreeting();
        const gn = $('goGuestName'); if (gn) gn.textContent = firstName();
    }
    // Üst çubuk + doğrulama kapısı: otel adı, oda, resepsiyon telefonu.
    function renderHeader() {
        const hn = $('goHotelName'); if (hn) hn.textContent = hotelName();
        const rl = $('goRoomLabel');
        if (rl) { rl.hidden = !ROOM; rl.textContent = ROOM ? t('guest.home.room', { room: ROOM }) : ''; }
        const gh = $('goGateHotel'); if (gh) gh.textContent = hotelName();
        const gc = $('goGateCall'), ph = phoneDigits();
        if (gc) { gc.hidden = !ph; if (ph) gc.href = 'tel:' + ph; }
    }

    // ════════════════════════════════════════════════════════════
    //  TAB NAV
    // ════════════════════════════════════════════════════════════
    // Sohbet sekmesi kaldırıldı (gerçek bir sohbet değildi): resepsiyonu
    // arama ana sayfadaki "Oteliniz" kartına ve Profil'e taşındı.
    const SCREENS = { home: 'scHome', services: 'scServices', cart: 'scCart', orders: 'scOrders', profile: 'scProfile' };
    function showTab(name, opts) {
        opts = opts || {};
        if (!SCREENS[name]) name = 'home';
        currentTab = name;
        Object.keys(SCREENS).forEach(k => { const el = $(SCREENS[k]); if (el) el.classList.toggle('go-hidden', k !== name); });
        // services/cart alt akışları "home" sekmesini vurgular.
        const navName = (name === 'services' || name === 'cart') ? 'home' : name;
        document.querySelectorAll('.go-nav-b').forEach(b => {
            const on = b.dataset.go === navName;
            b.classList.toggle('active', on);
            if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
        // Sepet bir akış ekranı: alt menü gizlenir, alan gönder çubuğuna kalır.
        document.body.classList.toggle('go-flow', name === 'cart');
        if (name === 'home') renderHome();
        if (name === 'services') renderServices();
        if (name === 'cart') renderCart();
        if (name === 'orders' && !opts.keepTrack) showOrderList();
        if (name === 'profile') { renderProfile(); loadStay(); }
        updateCartPill();
        renderLive();
        const sc = $(SCREENS[name]);
        if (sc && !opts.keepScroll) { sc.scrollTop = 0; const inner = sc.querySelector('.go-scroll'); if (inner) inner.scrollTop = 0; }
    }
    function openServices(dept, focusSearch) {
        activeDept = dept || ''; activeCat = 'all'; searchTerm = '';
        const sx = $('goSearch'); if (sx) sx.value = '';
        const xx = $('goSearchX'); if (xx) xx.hidden = true;
        showTab('services');
        if (focusSearch && sx) setTimeout(() => { try { sx.focus(); } catch (e) {} }, 80);
    }

    // ════════════════════════════════════════════════════════════
    //  ANA SAYFA
    // ════════════════════════════════════════════════════════════
    function renderAll() { renderHome(); renderProfile(); renderCartUI(); if (currentTab === 'services') renderServices(); }

    function renderHome() {
        renderHeader();
        renderGreeting();
        renderCats();
        renderQuick();
        renderHotelCard();
        const dot = $('goBellDot'); if (dot) dot.hidden = !activeOrder();
    }

    // Departman kutucukları: katalogdaki her departman (Spa gibi özel
    // departmanlar "Diğer hizmetler"de) — eskiden ilk 3 departman dışındakiler
    // ana ekranda hiç görünmüyordu.
    function homeDeptGroups() {
        const map = {};
        catalog.forEach(i => { const k = itemDeptKey(i) || 'other'; map[k] = (map[k] || 0) + 1; });
        return DEPT_ORDER.filter(k => map[k]).map(k => ({ key: k, def: DEPT_KIND_DEFS[k], n: map[k] }));
    }
    function renderCats() {
        const wrap = $('goCats'); if (!wrap) return;
        const groups = homeDeptGroups();
        if (!groups.length) {
            wrap.innerHTML = `<div style="grid-column:1/-1">${emptyHtml('grid', t('guest.services.noResult'), t('guest.services.notReady'))}</div>`;
            return;
        }
        wrap.innerHTML = groups.map(g => `<button class="go-dept" data-dept="${esc(g.key)}">
                <span class="go-dept-ic">${icon(g.def.icon, 22, 1.8)}</span>
                <span class="go-dept-tx"><b>${esc(g.def.label)}</b><span>${esc(t('guest.home.serviceCount', { n: g.n }))}</span></span>
            </button>`).join('');
        wrap.onclick = e => { const b = e.target.closest('[data-dept]'); if (b) openServices(b.dataset.dept); };
    }
    // Hızlı talepler: misafirin daha önce istedikleri önce, sonra her
    // departmandan sırayla birer kalem (yalnızca ilk 2 kalem değil — eskiden
    // hep aynı departmanın kalemleri çıkıyordu). Satırlar hizmet listesiyle
    // AYNI bileşen: + / adet / Seç davranışı birebir aynı.
    function quickItems() {
        const out = [];
        const push = it => { if (it && out.length < 4 && out.indexOf(it) === -1) out.push(it); };
        myOrders.forEach(o => (o.items || []).forEach(it => push(catalog.find(c => c.id === it.catalogId))));
        const byDept = {};
        catalog.forEach(i => { const k = itemDeptKey(i) || 'other'; (byDept[k] = byDept[k] || []).push(i); });
        for (let round = 0; out.length < 4 && round < 6; round++) {
            DEPT_ORDER.forEach(k => { const list = byDept[k]; if (list && list[round]) push(list[round]); });
        }
        return out;
    }
    function renderQuick() {
        const wrap = $('goQuick'), sec = $('goQaSec'); if (!wrap) return;
        const items = quickItems();
        if (!items.length) { if (sec) sec.hidden = true; wrap.innerHTML = ''; return; }
        if (sec) sec.hidden = false;
        wrap.innerHTML = items.map(itemHtml).join('');
        bindItemEvents(wrap);
    }

    // "Oteliniz" kartı: otelin kapak görseli (varsa) + bilgi/menü/konaklama
    // kısayolları + resepsiyonu ara.
    function rowBtnHtml(attr, ic, title, sub) {
        return `<button class="go-row" ${attr}><span class="go-row-ic">${ic}</span><span class="go-row-main"><span class="go-row-tl">${esc(title)}</span>${sub ? `<span class="go-row-sub">${esc(sub)}</span>` : ''}</span><span class="go-row-end">${icon('chev', 18)}</span></button>`;
    }
    function callRowHtml() {
        const ph = phoneDigits(); if (!ph) return '';
        return `<a class="go-row" href="tel:${esc(ph)}"><span class="go-row-ic">${svg(INFO_ICONS.phone, 18)}</span><span class="go-row-main"><span class="go-row-tl">${esc(t('guest.home.callReception'))}</span><span class="go-row-sub">${esc(config.phone)}</span></span><span class="go-row-end">${icon('chev', 18)}</span></a>`;
    }
    function renderHotelCard() {
        const wrap = $('goHotelCard'); if (!wrap) return;
        const img = String(config.heroImage || '').trim();
        const welcome = String(config.welcome || '').trim();
        wrap.innerHTML = (img ? `<div class="go-hotelcard-img">${welcome ? `<p>${esc(welcome)}</p>` : ''}</div>` : '')
            + `<div class="go-listcard">
                ${rowBtnHtml('data-open="info"', icon('info', 18, 1.9), t('guest.info.title'), '')}
                ${rowBtnHtml('data-open="menus"', icon('doc', 18, 1.9), t('guest.menus.title'), '')}
                ${rowBtnHtml('data-open="stay"', icon('bed', 18, 1.9), t('guest.stay.myStay'), '')}
                ${callRowHtml()}
            </div>`;
        // Görsel adresi stil özelliğine METİN olarak gömülmez (tırnak
        // kaçışıyla CSS enjeksiyonu riski) — DOM üzerinden atanır.
        const im = wrap.querySelector('.go-hotelcard-img');
        if (im) im.style.backgroundImage = 'url(' + JSON.stringify(img) + ')';
        wrap.onclick = e => {
            const b = e.target.closest('[data-open]'); if (!b) return;
            const k = b.dataset.open;
            if (k === 'info') openInfo(); else if (k === 'menus') openMenus(); else if (k === 'stay') openStay();
        };
    }
    function renderActiveBanner() { /* ana sayfada banner yok; canlı şerit + Taleplerim rozeti kullanılıyor */ }

    // ── Profil: misafir kartı + konaklama + tercihler + yardım ──────
    function renderProfile() {
        const wrap = $('goProfileBody'); if (!wrap) return;
        const initial = (firstName().charAt(0) || 'M').toLocaleUpperCase('tr-TR');
        const sub = [ROOM ? t('guest.home.room', { room: ROOM }) : '', hotelName()].filter(Boolean).join(' · ') + (DEMO ? ' · DEMO' : '');
        wrap.innerHTML = `
            <div class="go-prof-head">
                <div class="go-prof-av" aria-hidden="true">${esc(initial)}</div>
                <div><div class="go-prof-name">${esc(guestName || t('guest.home.guestFallback'))}</div><div class="go-prof-sub">${esc(sub)}</div></div>
            </div>
            <div class="go-caption">${esc(t('guest.stay.myStay'))}</div>
            <div id="goStayBody"></div>
            <div class="go-caption">${esc(t('guest.lang.switch'))}</div>
            <div class="go-seg go-langseg" id="goLangBar" role="group">
                ${I18n.supported().map(l => `<button class="${l === I18n.lang() ? 'active' : ''}" data-lang="${esc(l)}" aria-pressed="${l === I18n.lang()}">${l === 'tr' ? 'Türkçe' : 'English'}</button>`).join('')}
            </div>
            <div class="go-caption">${esc(t('guest.profile.help'))}</div>
            <div class="go-listcard" id="goProfHelp">
                ${callRowHtml()}
                ${rowBtnHtml('data-open="info"', icon('info', 18, 1.9), t('guest.info.title'), '')}
                <a class="go-row" href="legal/kvkk-aydinlatma" target="_blank" rel="noopener"><span class="go-row-ic">${icon('shield', 18, 1.9)}</span><span class="go-row-main"><span class="go-row-tl">${esc(t('guest.home.legal'))}</span></span><span class="go-row-end">${icon('chev', 18)}</span></a>
            </div>`;
        // Dil değişimi sayfayı yeniler (bkz. js/core/i18n.js).
        const lb = $('goLangBar');
        if (lb) lb.onclick = e => { const b = e.target.closest('[data-lang]'); if (b && b.dataset.lang !== I18n.lang()) I18n.setLang(b.dataset.lang); };
        const hp = $('goProfHelp');
        if (hp) hp.onclick = e => { const b = e.target.closest('[data-open="info"]'); if (b) openInfo(); };
        renderStay();
    }

    // ── Otel bilgileri ikonları (Otel Bilgileri sheet + kısayollar) ──
    const INFO_ICONS = {
        wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
        phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
        clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
        coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
        pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'
    };

    // ── Menüler (admin panelden eklenen PDF bağlantıları) ─────────
    let menusCache = null; // [{name,pdfUrl}] — bir kez çekilip sekme boyunca saklanır
    function menuRow(m) {
        return rowBtnHtml(`data-url="${esc(m.pdfUrl || '')}"`, icon('doc', 18, 1.9), m.name || t('guest.menus.title'), '');
    }
    function renderMenus(list) {
        const body = $('goMenusBody'); if (!body) return;
        if (!list.length) { body.innerHTML = emptyHtml('doc', t('guest.menus.none'), t('guest.menus.noneHint')); return; }
        body.innerHTML = `<div class="go-listcard">${list.map(menuRow).join('')}</div>`;
        body.querySelectorAll('[data-url]').forEach(b => b.onclick = () => {
            const url = b.dataset.url;
            if (!url) { toast(t('guest.menus.noLink'), true); return; }
            window.open(url, '_blank', 'noopener');
        });
    }
    function openMenus() {
        openSheet('goMenusSheet', 'goMenusBackdrop');
        if (menusCache) { renderMenus(menusCache); return; }
        $('goMenusBody').innerHTML = '<div class="go-spinner"></div>';
        if (DEMO) { menusCache = DEMO_MENUS; renderMenus(menusCache); return; }
        db.collection('guestMenus').where('tenantId', '==', TENANT).get().then(snap => {
            menusCache = snap.docs.map(d => d.data()).filter(m => m.active !== false)
                .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
            renderMenus(menusCache);
        }).catch(() => { menusCache = []; renderMenus([]); });
    }
    function closeMenus() { closeSheet('goMenusSheet', 'goMenusBackdrop'); }

    // ── Konaklama (Profil içinde: tarihler + Oda Hesabım + rezervasyonlar) ─
    // Tek bir sunucu-taraflı doğrulanmış çağrı (getGuestStay) ile gelir; soyadı
    // gate'te girildiğinde saklanır (SURNAME_KEY). Doğrulama yoksa "doğrulama
    // gerekli" gösterilir ve tek dokunuşla kapı açılır.
    let stayData = null, stayState = 'idle'; // idle | loading | error
    const RES_TYPE_KEY = { Restaurant: 'restaurant', Beach: 'beach', Transfer: 'transfer', Flower: 'flower', Cake: 'cake', Boat: 'boat', Tour: 'tour' };
    function resTypeLabel(type) { const k = RES_TYPE_KEY[type]; return k ? t('guest.res.' + k) : (type === 'Other' ? t('common.other') : (type || t('guest.res.generic'))); }
    function resDetailText(r) {
        if (r.type === 'Restaurant' || r.type === 'Beach') return [r.resName, r.pax ? r.pax + ' ' + t('common.people') : ''].filter(Boolean).join(' · ');
        if (r.type === 'Transfer') return [r.from, r.to].filter(Boolean).join(' → ') + (r.vehicle ? ' · ' + r.vehicle : '');
        if (r.type === 'Boat' || r.type === 'Tour') return [r.vessel, r.provider].filter(Boolean).join(' · ');
        // Other + Flower/Cake (+ bilinmeyen tür)
        return r.otherType || r.resName || '';
    }
    function reservationRow(r, i) {
        const detail = resDetailText(r);
        return `<button class="go-row go-stay-res" data-i="${i}" aria-expanded="false">
            <span class="go-row-ic">${icon('clock', 18, 1.9)}</span>
            <span class="go-row-main">
                <span class="go-row-tl">${esc(resTypeLabel(r.type))}</span>
                <span class="go-row-sub go-num">${esc(fmtDateTR(r.date))}${r.time ? ' · ' + esc(r.time) : ''}</span>
                <span class="go-stay-res-detail">${detail ? esc(detail) : esc(t('guest.stay.noDetail'))}</span>
            </span>
            <span class="go-chev">${icon('chev', 18)}</span>
        </button>`;
    }
    function fmtDateTR(iso) {
        if (!iso) return '—';
        const p = String(iso).slice(0, 10).split('-');
        return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
    }
    function nightsBetween(a, b) {
        const da = new Date(String(a).slice(0, 10) + 'T12:00:00'), db2 = new Date(String(b).slice(0, 10) + 'T12:00:00');
        const n = Math.round((db2 - da) / 86400000);
        return isFinite(n) && n > 0 ? n : 0;
    }
    function canLoadStay() { return DEMO || (!!fns && !!ROOM && !!loadSurname()); }
    function renderStay() {
        const body = $('goStayBody'); if (!body) return;
        if (DEMO && !stayData) stayData = DEMO_STAY;
        if (!stayData) {
            if (!canLoadStay()) {
                body.innerHTML = `<div class="go-listcard">${rowBtnHtml('data-stay="verify"', icon('lock', 18, 1.9), t('guest.gate.required'), t('guest.gate.requiredHint'))}</div>`;
            } else if (stayState === 'error') {
                body.innerHTML = `<div class="go-listcard">${rowBtnHtml('data-stay="retry"', icon('alert', 18, 1.9), t('guest.stay.loadFailed'), t('common.tapRetry'))}</div>`;
            } else {
                body.innerHTML = '<div class="go-spinner"></div>';
            }
            body.onclick = e => {
                const b = e.target.closest('[data-stay]'); if (!b) return;
                if (b.dataset.stay === 'verify') openGate();
                else { stayState = 'idle'; loadStay(); }
            };
            return;
        }
        const nights = (stayData.checkIn && stayData.checkOut) ? nightsBetween(stayData.checkIn, stayData.checkOut) : 0;
        const dateRow = (stayData.checkIn || stayData.checkOut) ? `
            <div class="go-stay-dates">
                <div class="go-stay-date"><small>${esc(t('guest.stay.checkIn'))}</small><b>${esc(fmtDateTR(stayData.checkIn))}</b></div>
                <div class="go-stay-date"><small>${esc(t('guest.stay.checkOut'))}</small><b>${esc(fmtDateTR(stayData.checkOut))}</b></div>
            </div>
            ${nights ? `<div class="go-stay-nights">${esc(t('guest.stay.nights', { n: nights }))}</div>` : ''}` : '';
        // Oda hesabı PARA BİRİMİ BAŞINA ayrı satır — ör. Concierge'in €150'lik
        // ekstrası ile restoranın ₺2.400'lük adisyonu ASLA tek tutarda toplanmaz.
        const folioGroups = stayData.folio || [];
        const folioRows = folioGroups.length
            ? folioGroups.map((g, i) => `<button class="go-row" data-folio-i="${i}">
                <span class="go-row-ic">${icon('receipt', 18, 1.9)}</span>
                <span class="go-row-main"><span class="go-row-tl">${esc(t('guest.stay.folio'))}</span><span class="go-row-sub">${esc(t('guest.stay.folioCount', { n: g.count, cur: g.currency }))}</span></span>
                <span class="go-row-val go-num">${esc(fmtCur(g.total, g.currency))}</span>
                <span class="go-chev">${icon('chev', 18)}</span></button>`).join('')
            : `<div class="go-row"><span class="go-row-ic">${icon('receipt', 18, 1.9)}</span><span class="go-row-main"><span class="go-row-tl">${esc(t('guest.stay.folio'))}</span><span class="go-row-sub">${esc(t('guest.stay.noExtras'))}</span></span></div>`;
        const resList = stayData.reservations || [];
        const resHtml = `<div class="go-caption">${esc(t('guest.stay.reservations'))}</div>` + (resList.length
            ? `<div class="go-listcard">${resList.map(reservationRow).join('')}</div>`
            : `<div class="go-listcard"><div class="go-row"><span class="go-row-main"><span class="go-row-sub">${esc(t('guest.stay.noReservations'))}</span></span></div></div>`);
        body.innerHTML = `${dateRow}<div class="go-listcard" style="margin-top:12px">${folioRows}</div>${resHtml}`;
        body.onclick = e => {
            const f = e.target.closest('[data-folio-i]'); if (f) { openFolio(folioGroups[+f.dataset.folioI]); return; }
            const r = e.target.closest('.go-stay-res');
            if (r) { const open = !r.classList.contains('open'); r.classList.toggle('open', open); r.setAttribute('aria-expanded', String(open)); }
        };
    }
    function loadStay() {
        if (DEMO) { stayData = DEMO_STAY; renderStay(); return; }
        if (stayData || stayState === 'loading' || !canLoadStay()) { renderStay(); return; }
        stayState = 'loading'; renderStay();
        fns.httpsCallable('getGuestStay')({ tenant: TENANT, room: ROOM, surname: loadSurname() }).then(res => {
            if (res && res.data && res.data.ok) { stayData = res.data; stayState = 'idle'; }
            else stayState = 'error';
            renderStay();
        }).catch(() => { stayState = 'error'; renderStay(); });
    }
    // Ana sayfadaki "Konaklamam" kısayolu Profil sekmesine götürür (konaklama
    // bilgileri artık ayrı bir sheet değil, Profil'in bir bölümü).
    function openStay() { showTab('profile'); }

    // ── Oda Hesabım detayı (Profil'den drill-down) ─────────────
    // NOT: burada HER ZAMAN grubun KENDİ para birimi kullanılır, fmtPrice()
    // (guestConfig.currency) değil — Concierge kalemleri EUR olabilir.
    const CUR_SYM_MAP = { EUR: '€', TRY: '₺', USD: '$' };
    function fmtCur(amount, currency) { return (CUR_SYM_MAP[currency] || config.currency) + Number(amount || 0).toLocaleString('tr-TR'); }
    function folioSourceLabel(src) { return src === 'restaurant' || src === 'concierge' ? t('guest.stay.src.' + src) : (src || t('guest.stay.folioShort')); }
    function folioRow(it, currency) {
        const meta = [it.tableName || '', it.createdAt ? new Date(it.createdAt).toLocaleDateString(I18n.locale()) : ''].filter(Boolean).join(' · ');
        return `<div class="go-folio-row">
            <div><div class="go-folio-row-src">${esc(folioSourceLabel(it.source))}</div>${meta ? `<div class="go-folio-row-meta">${esc(meta)}</div>` : ''}</div>
            <div class="go-folio-row-amt">${esc(fmtCur(it.amount, currency))}</div></div>`;
    }
    function openFolio(group) {
        const body = $('goFolioBody'); if (!body || !group) return;
        const rows = (group.items || []).map(it => folioRow(it, group.currency)).join('');
        body.innerHTML = `${rows || emptyHtml('receipt', t('guest.stay.noItems'), '')}
            <div class="go-folio-total"><b>${esc(t('guest.stay.total', { cur: group.currency }))}</b><span>${esc(fmtCur(group.total || 0, group.currency))}</span></div>`;
        openSheet('goFolioSheet', 'goFolioBackdrop');
    }
    function closeFolio() { closeSheet('goFolioSheet', 'goFolioBackdrop'); }

    // ════════════════════════════════════════════════════════════
    //  HİZMETLER
    // ════════════════════════════════════════════════════════════
    // Başlık departman adını taşır; eskiden başlığın altında AYNI adı
    // tekrarlayan fotoğraflı bir "hero" bandı vardı (kaldırıldı). Kategori
    // çipleri artık yalnızca SEÇİLİ DEPARTMANIN kategorilerini gösterir —
    // eskiden F&B ekranında "Tümü 19 · Kat Hizmetleri · Konfor…" görünüyordu.
    const catOf = i => String((i && i.category) || t('common.other')).trim();
    function scopeItems() { return activeDept ? catalog.filter(i => (itemDeptKey(i) || 'other') === activeDept) : catalog; }
    function scopeCats(scope) { const seen = []; scope.forEach(i => { const c = catOf(i); if (seen.indexOf(c) === -1) seen.push(c); }); return seen; }
    function renderServices() {
        const chips = $('goChips'); if (!chips) return;
        const scope = scopeItems();
        const cats = scopeCats(scope);
        if (activeCat !== 'all' && cats.indexOf(activeCat) === -1) activeCat = 'all';
        const title = $('goServicesTitle');
        if (title) title.textContent = (activeDept && DEPT_KIND_DEFS[activeDept]) ? DEPT_KIND_DEFS[activeDept].label : t('guest.services.title');
        chips.innerHTML = cats.length > 1
            ? [`<button class="go-chip ${activeCat === 'all' ? 'active' : ''}" data-chip="all">${esc(t('common.all'))}<i>${scope.length}</i></button>`]
                .concat(cats.map(c => `<button class="go-chip ${activeCat === c ? 'active' : ''}" data-chip="${esc(c)}">${esc(c)}<i>${scope.filter(i => catOf(i) === c).length}</i></button>`)).join('')
            : '';
        chips.onclick = e => {
            const b = e.target.closest('[data-chip]'); if (!b) return;
            activeCat = b.dataset.chip; renderServices();
            const a = chips.querySelector('.go-chip.active'); if (a) a.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
            const list = $('goItems'); if (list) list.scrollTop = 0;
        };
        renderItems();
    }
    function filteredItems() {
        const term = norm(searchTerm);
        return catalog.filter(i => {
            // Arama yapılırken departman/kategori sınırı kalkar: misafir
            // "havlu" yazdığında bulunduğu departmandan bağımsız bulmalı.
            if (!term) {
                if (activeDept && (itemDeptKey(i) || 'other') !== activeDept) return false;
                if (activeCat !== 'all' && catOf(i) !== activeCat) return false;
                return true;
            }
            const hay = norm((i.name || '') + ' ' + (i.category || '') + ' ' + (i.description || ''));
            return hay.includes(term);
        });
    }
    function renderItems() {
        const wrap = $('goItems'); if (!wrap) return;
        const items = filteredItems();
        if (!items.length) {
            wrap.innerHTML = emptyHtml('search', t('guest.services.noResult'), searchTerm ? t('guest.services.noMatch') : t('guest.services.emptyCategory'));
            return;
        }
        let html;
        const cats = scopeCats(items);
        if (activeCat === 'all' && !searchTerm && cats.length > 1) {
            html = cats.map(c => `<div class="go-caption">${esc(c)}</div><div class="go-listcard">${items.filter(i => catOf(i) === c).map(itemHtml).join('')}</div>`).join('');
        } else {
            html = `<div class="go-listcard">${items.map(itemHtml).join('')}</div>`;
        }
        wrap.innerHTML = html;
        bindItemEvents(wrap);
    }
    // Süre etiketi dakikadan, aktif dilde üretilir ("15–30 dk" / "15–30 min");
    // dakika yoksa otelin girdiği serbest metin olduğu gibi gösterilir.
    function etaShort(src) {
        const m = etaMinutes(src);
        if (m) return m.min === m.max ? t('guest.item.etaOne', { n: m.min }) : t('guest.item.etaRange', { a: m.min, b: m.max });
        const raw = String((src && src.eta) || '').trim();
        return raw && raw !== '—' ? raw : '';
    }
    // Seçenekli/özelleştirmeli/transfer/concierge kalemler satırda doğrudan
    // eklenemez — önce detay sayfası açılır ("Seç"). Sepetteyse adet kontrolü;
    // tek-adetlik kalemlerde (oda temizliği…) yalnızca onay işareti.
    const hasOptions = item => Array.isArray(item && item.options) && item.options.length > 0;
    const needsSheet = item => hasOptions(item) || hasModifiers(item) || isTransferItem(item) || isConciergeItem(item);
    function itemAction(item, av, line) {
        if (!av.available) return `<span class="go-unavail">${esc(t('guest.services.offHours'))}</span>`;
        if (line && line.qty > 0) {
            return lineMax(item) === 1
                ? `<button class="go-add go-add-on" data-dec="${esc(item.id)}" aria-label="${esc(t('guest.item.removeFromCart'))}">${icon('check', 18, 2.6)}</button>`
                : stepHtml(item.id, line.qty);
        }
        if (needsSheet(item)) return `<button class="go-add go-add-choose" data-choose="${esc(item.id)}">${esc(t('common.select'))}</button>`;
        return `<button class="go-add" data-add="${esc(item.id)}" aria-label="${esc(t('guest.item.add'))}: ${esc(item.name)}">${icon('plus', 20, 2.4)}</button>`;
    }
    function itemTags(item, av, withPlus) {
        const tags = [];
        const eta = etaShort(item);
        if (eta) tags.push(`<span class="go-tag">${icon('clock', 13, 2.2)}${esc(eta)}</span>`);
        if (av.limited) tags.push(`<span class="go-tag ${av.available ? '' : 'off'}">${esc(av.available ? av.window : t('guest.services.hoursWindow', { window: av.window }))}</span>`);
        if (pricesOn() && priceOf(item)) tags.push(`<span class="go-tag price">${esc(fmtPrice(priceOf(item)))}${withPlus ? '+' : ''}</span>`);
        return tags;
    }
    function itemHtml(item) {
        const av = availInfo(item);
        const tags = itemTags(item, av, false);
        const line = cart.find(l => l.catalogId === item.id);
        return `<div class="go-item ${av.available ? '' : 'go-item-unavail'}" data-id="${esc(item.id)}" data-open-item="${esc(item.id)}">
            <div class="go-item-emoji" aria-hidden="true">${esc(item.icon || '🛎️')}</div>
            <div class="go-item-main">
                <div class="go-item-name">${esc(item.name)}</div>
                ${item.description ? `<div class="go-item-desc">${esc(item.description)}</div>` : ''}
                ${tags.length ? `<div class="go-item-meta">${tags.join('')}</div>` : ''}
            </div>
            <div class="go-item-act" data-act="${esc(item.id)}">${itemAction(item, av, line)}</div>
        </div>`;
    }
    const stepHtml = (id, qty) => `<div class="go-step"><button data-dec="${esc(id)}" aria-label="${esc(t('guest.item.decrease'))}">${icon('minus', 17, 2.4)}</button><b>${qty}</b><button data-inc="${esc(id)}" aria-label="${esc(t('guest.item.increase'))}">${icon('plus', 17, 2.4)}</button></div>`;
    function bindItemEvents(wrap) {
        wrap.onclick = e => {
            const choose = e.target.closest('[data-choose]'); if (choose) return openItemSheet(choose.dataset.choose);
            const add = e.target.closest('[data-add]'); if (add) return changeQty(add.dataset.add, +1);
            const inc = e.target.closest('[data-inc]'); if (inc) return changeQty(inc.dataset.inc, +1);
            const dec = e.target.closest('[data-dec]'); if (dec) return changeQty(dec.dataset.dec, -1);
            // Satırın kendisine dokunma → detay (not / saat / adet birlikte)
            const row = e.target.closest('[data-open-item]'); if (row) openItemSheet(row.dataset.openItem);
        };
    }

    // ── Hizmet detayı sheet ─────────────────────────────────────
    // Gövde kayar, "Sepete ekle" butonu ALTTA SABİT durur (uzun özelleştirme
    // listelerinde kaydırmadan eklenebilir). Sepette satır varsa mevcut
    // değerlerle açılır ve günceller.
    let sheetItemId = null, sheetQty = 1, sheetOption = '', sheetModifiers = [], sheetWhen = 'now';
    function optPillsHtml(item, selected) {
        return `<div class="go-fsec">
            <div class="go-fsec-h"><b>${esc(t('guest.item.option'))}</b><span class="req">${esc(t('guest.item.optionReq'))}</span></div>
            <div class="go-opt-pills" id="goShOptPills" role="radiogroup">
                ${optionsOf(item).map(o => `<button type="button" role="radio" aria-checked="${o.name === selected}" class="go-opt-pill ${o.name === selected ? 'active' : ''}" data-opt="${esc(o.name)}">${esc(o.name)}${(pricesOn() && o.priceDelta) ? ` <span class="go-opt-pill-delta">${esc(fmtDelta(o.priceDelta))}</span>` : ''}</button>`).join('')}
            </div></div>`;
    }
    // Çıkarılabilir/ekstra bileşenler — ÇOKLU seçim, başlıklı gruplar
    // (özel grup adı yoksa "Ekstralar"/"Çıkarılacaklar"). maxQty > 1 olan
    // ekstralar satır içi adet kontrolü alır (2× Ekstra Peynir).
    // DİKKAT: dış kapsayıcı <div>'dir, <button> DEĞİL — buton içine buton
    // konamaz (stepper satırın dışına düşer). Dokunma hedefi .go-modrow-tap.
    function modRowHtml(m, qty) {
        const on = qty > 0;
        const delta = (pricesOn() && m.priceDelta) ? `<span class="go-modrow-delta">${esc(fmtDelta(m.priceDelta))}</span>` : '';
        // Adet kontrolü yalnızca SEÇİLİ adetli ekstrada görünür — seçilmemiş
        // satırlarda "0" sayaçları gürültüydü; satıra dokunmak 1 ekler.
        const ctrl = (m.maxQty > 1 && on)
            ? `<span class="go-modrow-step">
                   <button type="button" data-moddec="${esc(m.name)}" aria-label="${esc(t('guest.item.decrease'))}" ${on ? '' : 'disabled'}>${icon('minus', 15, 2.4)}</button>
                   <b data-modqty="${esc(m.name)}">${qty}</b>
                   <button type="button" data-modinc="${esc(m.name)}" aria-label="${esc(t('guest.item.increase'))}" ${qty >= m.maxQty ? 'disabled' : ''}>${icon('plus', 15, 2.4)}</button>
               </span>`
            : '';
        return `<div class="go-modrow ${on ? 'active' : ''} ${m.type === 'extra' ? 'is-extra' : 'is-remove'}" data-mod="${esc(m.name)}">
            <button type="button" class="go-modrow-tap" data-modtoggle="${esc(m.name)}" role="checkbox" aria-checked="${on ? 'true' : 'false'}">
                <span class="go-modrow-box">${icon('check', 14, 3)}</span>
                <span class="go-modrow-name">${esc(m.name)}</span>
                ${delta}
            </button>
            ${ctrl}
        </div>`;
    }
    function modChipsHtml(item, sel) {
        const groups = modifierGroups(item);
        if (!groups.length) return '';
        return `<div class="go-fsec"><div class="go-modsec" id="goShModPills">
            ${groups.map(g => `<div class="go-modgrp">
                <div class="go-modgrp-h">${esc(g.key)}</div>
                <div class="go-modgrp-list">${g.items.map(m => modRowHtml(m, selQty(sel, m.name))).join('')}</div>
            </div>`).join('')}
        </div></div>`;
    }
    function openItemSheet(id) {
        const item = catalog.find(i => i.id === id); if (!item) return;
        const av = availInfo(item);
        const line = cart.find(l => l.catalogId === id);
        sheetItemId = id;
        sheetQty = line && line.qty > 0 ? line.qty : 1;
        sheetOption = line ? (line.option || '') : '';
        sheetModifiers = line ? selList(line.modifiers) : [];
        sheetWhen = (line && line.preferredTime) ? 'later' : 'now';
        const withOpts = hasOptions(item);
        const withMods = hasModifiers(item);
        const maxq = lineMax(item);
        const isTransfer = isTransferItem(item);
        // Concierge (transfer OLMAYAN: restoran rezervasyonu, spa, tur…)
        // kalemleri TARİH ister — yoksa talep bugünün ajandasına düşerdi.
        const isConcierge = !isTransfer && isConciergeItem(item);
        const tmb = (isTransfer || isConcierge) ? transferMinBound() : null;
        const tags = itemTags(item, av, withOpts || withMods);
        const sheetUnitPrice = () => priceOf(item) + optionDelta(item, sheetOption) + modifiersDelta(item, sheetModifiers);
        const field = (id2, label, inner) => `<div class="go-fld"><label for="${id2}">${esc(label)}</label>${inner}</div>`;
        let whenHtml = '';
        if (isTransfer) {
            whenHtml = `<div class="go-fsec">
                ${field('goShFrom', t('guest.transfer.from'), `<input type="text" id="goShFrom" maxlength="80" placeholder="${esc(t('guest.transfer.fromPlaceholder'))}" value="${esc(line ? line.transferFrom || '' : '')}">`)}
                ${field('goShTo', t('guest.transfer.to'), `<input type="text" id="goShTo" maxlength="80" placeholder="${esc(t('guest.transfer.toPlaceholder'))}" value="${esc(line ? line.transferTo || '' : '')}">`)}
                <div class="go-fld-2">
                    ${field('goShDate', t('guest.transfer.date'), `<input type="date" id="goShDate" min="${tmb.dateIso}" value="${esc(line && line.transferDate || tmb.dateIso)}">`)}
                    ${field('goShTime', t('guest.transfer.time'), `<input type="time" id="goShTime" min="${tmb.timeHHMM}" value="${esc(line && line.transferTime || tmb.timeHHMM)}">`)}
                </div>
                ${!withOpts ? field('goShVehicle', t('guest.transfer.vehicle'), `<input type="text" id="goShVehicle" maxlength="80" placeholder="${esc(t('guest.transfer.vehiclePlaceholder'))}" value="${esc(line ? line.option || '' : '')}">`) : ''}
            </div>`;
        } else if (isConcierge) {
            whenHtml = `<div class="go-fsec"><div class="go-fld-2">
                ${field('goShDate', t('guest.transfer.date'), `<input type="date" id="goShDate" min="${tmb.dateIso}" value="${esc(line && line.transferDate || tmb.dateIso)}">`)}
                ${field('goShTime', t('guest.transfer.time'), `<input type="time" id="goShTime" value="${esc(line && line.transferTime || '')}">`)}
            </div></div>`;
        } else {
            // "Ne zaman?" — çoğu talep hemen istenir; saat seçmek ikinci adım.
            // Eskiden her kalemde boş, tarayıcıya göre "--:-- --" görünen ham
            // bir saat alanı vardı.
            whenHtml = `<div class="go-fsec">
                <div class="go-fsec-h"><b>${esc(t('guest.item.when'))}</b></div>
                <div class="go-seg" id="goShWhen" role="group">
                    <button type="button" data-when="now" class="${sheetWhen === 'now' ? 'active' : ''}" aria-pressed="${sheetWhen === 'now'}">${esc(t('guest.item.whenNow'))}</button>
                    <button type="button" data-when="later" class="${sheetWhen === 'later' ? 'active' : ''}" aria-pressed="${sheetWhen === 'later'}">${esc(t('guest.item.whenLater'))}</button>
                </div>
                <div class="go-timefld" id="goShTimeWrap" ${sheetWhen === 'later' ? '' : 'hidden'}>
                    <input type="time" class="go-input" id="goShTime" aria-label="${esc(t('guest.item.whenLater'))}" value="${esc(line ? line.preferredTime || '' : '')}">
                </div>
            </div>`;
        }
        $('goItemSheetBody').innerHTML = `
            <div class="go-isheet-head">
                <div class="go-item-emoji" aria-hidden="true">${esc(item.icon || '🛎️')}</div>
                <div class="go-isheet-tx">
                    <h2 id="goItemTitle">${esc(item.name)}</h2>
                    <span class="go-isheet-cat">${esc(catOf(item))}</span>
                </div>
                <button class="go-sheet-close" id="goItemClose" aria-label="${esc(t('common.close'))}">${icon('x', 16, 2.4)}</button>
            </div>
            ${item.description ? `<p class="go-isheet-desc">${esc(item.description)}</p>` : ''}
            ${tags.length ? `<div class="go-item-meta go-isheet-meta">${tags.join('')}</div>` : ''}
            ${av.available ? `
                ${withOpts ? optPillsHtml(item, sheetOption) : ''}
                ${withMods ? modChipsHtml(item, sheetModifiers) : ''}
                ${maxq > 1 ? `<div class="go-isheet-qty"><span>${esc(t('guest.item.quantity'))}</span>
                    <div class="go-step go-step-lg"><button id="goShDec" aria-label="${esc(t('guest.item.decrease'))}">${icon('minus', 18, 2.4)}</button><b id="goShQty">${sheetQty}</b><button id="goShInc" aria-label="${esc(t('guest.item.increase'))}">${icon('plus', 18, 2.4)}</button></div>
                </div>` : ''}
                ${whenHtml}
                <div class="go-fsec">
                    <div class="go-fsec-h"><b>${esc(t('guest.item.noteTitle'))}</b><span>${esc(t('common.optional'))}</span></div>
                    <input type="text" class="go-input" id="goShNote" maxlength="160" aria-label="${esc(t('guest.item.noteTitle'))}" placeholder="${esc(t('guest.item.notePlaceholder'))}" value="${esc(line ? line.note || '' : '')}">
                </div>`
            : `<div class="go-cancel-reason" style="margin-top:18px"><div class="go-cancel-reason-b">${esc(t('guest.services.unavailableWindow', { window: av.window }))}</div></div>`}
        `;
        const addDisabled = withOpts && !sheetOption;
        $('goItemSheetFoot').innerHTML = av.available
            ? `<button class="go-cta go-cta-block" id="goShAdd" ${addDisabled ? 'disabled' : ''}>
                    <span id="goShAddLbl">${esc(addDisabled ? t('guest.item.pickOption') : (line ? t('guest.item.updateCart') : t('guest.item.addToCart')))}</span>
                    <span class="go-cta-amt" id="goShAmt"></span>
               </button>
               ${line ? `<button class="go-btn-text danger" id="goShRemove">${esc(t('guest.item.removeFromCart'))}</button>` : ''}`
            : `<button class="go-btn" id="goShDismiss">${esc(t('common.close'))}</button>`;
        $('goItemSheet').setAttribute('aria-labelledby', 'goItemTitle');
        const addB = $('goShAdd');
        const upd = () => {
            const q = $('goShQty'); if (q) q.textContent = sheetQty;
            const dB = $('goShDec'); if (dB) dB.disabled = sheetQty <= 1;
            const a = $('goShAmt'); if (!a) return;
            // Seçenek zorunluyken ve seçilmemişken tutar gösterilmez (seçenek
            // fiyatı değiştirebilir); eleman DOM'da durur ki seçimle görünsün.
            const unit = sheetUnitPrice();
            a.textContent = (pricesOn() && !(withOpts && !sheetOption) && unit) ? fmtPrice(unit * sheetQty) : '';
            if (addB) addB.classList.toggle('has-amt', !!a.textContent);
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
            pills.querySelectorAll('.go-opt-pill').forEach(p => { const on = p.dataset.opt === sheetOption; p.classList.toggle('active', on); p.setAttribute('aria-checked', String(on)); });
            syncAddState();
        };
        const modPills = $('goShModPills');
        if (modPills) modPills.onclick = e => {
            const row = e.target.closest('[data-mod]'); if (!row) return;
            const name = row.dataset.mod;
            const def = modifiersOf(item).find(x => x.name === name); if (!def) return;
            // Adetli ekstralarda − / + satır içi; diğer her yer aç/kapa.
            const dec = e.target.closest('[data-moddec]'), inc = e.target.closest('[data-modinc]');
            let q = selQty(sheetModifiers, name);
            if (def.maxQty > 1 && (dec || inc)) q = inc ? Math.min(def.maxQty, q + 1) : Math.max(0, q - 1);
            else q = q > 0 ? 0 : 1;
            sheetModifiers = selList(sheetModifiers).filter(s => s.name !== name);
            if (q > 0) sheetModifiers.push({ name: name, qty: q });
            // Yalnızca dokunulan satır yeniden çizilir (klavye/kaydırma korunur).
            row.outerHTML = modRowHtml(def, q);
            upd();
        };
        const whenSeg = $('goShWhen');
        if (whenSeg) whenSeg.onclick = e => {
            const b = e.target.closest('[data-when]'); if (!b) return;
            sheetWhen = b.dataset.when;
            whenSeg.querySelectorAll('[data-when]').forEach(x => { const on = x.dataset.when === sheetWhen; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
            const wrapT = $('goShTimeWrap'); if (wrapT) wrapT.hidden = sheetWhen !== 'later';
            // Boş saat alanı yerine en yakın yarım saat önerilir (değiştirilebilir).
            if (sheetWhen === 'later') { const ti = $('goShTime'); if (ti && !ti.value) ti.value = transferMinBound().timeHHMM; }
        };
        const dec = $('goShDec'); if (dec) dec.onclick = () => { if (sheetQty > 1) { sheetQty--; upd(); } };
        const inc = $('goShInc'); if (inc) inc.onclick = () => { if (sheetQty >= maxq) { toast(capMsg(item), true); return; } sheetQty++; upd(); };
        // Yalnızca UX cilası — asıl "en yakın yarım saat" doğrulaması
        // confirmItemSheet()'te. Bugünden farklı tarihte saat serbest kalır.
        if (isTransfer) {
            const dateEl = $('goShDate'), timeEl = $('goShTime');
            if (dateEl && timeEl) dateEl.onchange = () => { timeEl.min = dateEl.value === tmb.dateIso ? tmb.timeHHMM : ''; };
        }
        if (addB) addB.onclick = () => confirmItemSheet(item);
        const rmB = $('goShRemove'); if (rmB) rmB.onclick = () => {
            cart = cart.filter(l => l.catalogId !== id);
            saveCart(); renderCartUI(); refreshItemRow(id); if (currentTab === 'cart') renderCart(); closeItemSheet(); toast(t('guest.item.removed'));
        };
        const dm = $('goShDismiss'); if (dm) dm.onclick = closeItemSheet;
        const cl = $('goItemClose'); if (cl) cl.onclick = closeItemSheet;
        upd();
        const body = $('goItemSheetBody'); if (body) body.scrollTop = 0;
        openSheet('goItemSheet', 'goItemBackdrop');
    }
    function confirmItemSheet(item) {
        if (hasOptions(item) && !sheetOption) { toast(t('guest.item.pickOptionToast'), true); return; }
        const isTransfer = isTransferItem(item);
        const isConcierge = !isTransfer && isConciergeItem(item);
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
        } else if (isConcierge) {
            // Transfer olmayan Concierge kalemi: TARİH zorunlu, saat opsiyonel.
            transferDate = ($('goShDate') && $('goShDate').value || '').slice(0, 10);
            transferTime = ($('goShTime') && $('goShTime').value || '').slice(0, 5);
            if (!transferDate) { toast(t('guest.transfer.needDate'), true); return; }
        }
        const note = ($('goShNote') && $('goShNote').value || '').slice(0, 160);
        // Transfer kalemlerinde preferredTime kullanılmaz (transferDate/Time).
        // Normal kalemde saat yalnızca "Saat seç" işaretliyse alınır.
        let time = '';
        if (isConcierge) time = ($('goShTime') && $('goShTime').value || '').slice(0, 10);
        else if (!isTransfer && sheetWhen === 'later') {
            time = ($('goShTime') && $('goShTime').value || '').slice(0, 10);
            if (!time) { toast(t('guest.item.pickTime'), true); return; }
        }
        let line = cart.find(l => l.catalogId === item.id);
        if (!line) {
            if (cart.length >= MAX_DISTINCT) { toast(t('guest.item.maxDistinct', { n: MAX_DISTINCT }), true); return; }
            line = { catalogId: item.id, name: item.name, category: item.category || t('common.other'), icon: item.icon || '🛎️',
                department: item.department || '', price: priceOf(item), maxQty: Number(item.maxQty) || 0, qty: 0, note: '', preferredTime: '', option: '',
                // Süre sepete eklendiği ANDA damgalanır (price ile aynı gerekçe).
                etaMin: (etaMinutes(item) || {}).min || 0, etaMax: (etaMinutes(item) || {}).max || 0,
                transferFrom: '', transferTo: '', transferDate: '', transferTime: '' };
            cart.push(line);
        }
        line.qty = Math.min(lineMax(line), Math.max(1, sheetQty));
        line.note = note; line.preferredTime = time; line.option = sheetOption || '';
        // Seçilen bileşenler adetleriyle, KATALOG sırasıyla saklanır.
        line.modifiers = modifiersOf(item)
            .map(m => ({ m: m, q: selQty(sheetModifiers, m.name) }))
            .filter(x => x.q > 0)
            .map(x => ({ name: x.m.name, type: x.m.type, priceDelta: x.m.priceDelta, qty: x.q }));
        line.transferFrom = transferFrom; line.transferTo = transferTo; line.transferDate = transferDate; line.transferTime = transferTime;
        // Seçenek/özelleştirme farkı satır fiyatına gömülür (tek birim fiyat).
        line.price = priceOf(item) + optionDelta(item, sheetOption) + modifiersDelta(item, sheetModifiers);
        saveCart(); renderCartUI(); refreshItemRow(item.id);
        if (currentTab === 'cart') renderCart();
        closeItemSheet(); buzz(10); toast(t('guest.item.added'));
    }
    function closeItemSheet() {
        sheetItemId = null; sheetOption = ''; sheetModifiers = []; sheetWhen = 'now';
        closeSheet('goItemSheet', 'goItemBackdrop');
    }
    // Aynı kalem hem hizmet listesinde hem ana sayfadaki "Hızlı talepler"de
    // olabilir — tüm kopyalar birlikte güncellenir.
    function refreshItemRow(id) {
        const rows = document.querySelectorAll(`.go-item-act[data-act="${CSS.escape(id)}"]`);
        if (!rows.length) return;
        const item = catalog.find(i => i.id === id); if (!item) return;
        const av = availInfo(item);
        const line = cart.find(l => l.catalogId === id);
        rows.forEach(r => { r.innerHTML = itemAction(item, av, line); });
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

    // ── Sepet ekranı + yüzen sepet çubuğu ──────────────────────
    function renderCartUI() { updateCartPill(); }
    function updateCartPill() {
        const pill = $('goCartPill'); if (!pill) return;
        const n = cartCount();
        const show = n > 0 && (currentTab === 'home' || currentTab === 'services');
        pill.hidden = !show;
        if (show) {
            $('goPillBadge').textContent = n;
            const tp = $('goPillTotal'); const tot = cartTotal();
            tp.textContent = (pricesOn() && tot) ? fmtPrice(tot) : '';
            pill.setAttribute('aria-label', t('guest.cart.view') + ' · ' + t('guest.cart.countLabel', { n: n }));
        }
    }
    // Sepet satırının ayrıntıları TEK okunur satırda: seçenek · ekstralar ·
    // saat · not. (Eskiden her biri ayrı bir renkli çipti — kalabalıktı.)
    function lineDetails(l) {
        const det = [];
        if (l.option) det.push(l.option);
        selList(l.modifiers).forEach(sm => {
            const def = (l.modifiers || []).find(m => m && m.name === sm.name) || { name: sm.name, type: 'extra' };
            det.push(modLabel(normalizeModifier(def), sm.qty));
        });
        if (l.transferFrom || l.transferTo) det.push((l.transferFrom || '?') + ' → ' + (l.transferTo || '?'));
        if (l.transferDate || l.transferTime) det.push([l.transferDate ? String(l.transferDate).split('-').reverse().join('.') : '', l.transferTime].filter(Boolean).join(' '));
        else if (l.preferredTime) det.push(t('guest.cart.at', { time: l.preferredTime }));
        if (l.note) det.push('“' + l.note + '”');
        return det;
    }
    function renderCart() {
        const wrap = $('goCartList'), foot = $('goCartFoot'); if (!wrap) return;
        $('goCartClear').hidden = !cart.length;
        if (!cart.length) {
            foot.hidden = true;
            wrap.innerHTML = emptyHtml('bag', t('guest.cart.empty'), t('guest.cart.emptyHint'), `<button class="go-cta" id="goCartBrowse">${esc(t('guest.cart.browse'))}</button>`);
            $('goCartBrowse').onclick = () => openServices('');
            return;
        }
        foot.hidden = false;
        // DİKKAT: yerel değişken `t` OLAMAZ — global `t()` çeviri fonksiyonunu
        // gölgeler.
        const total = cartTotal();
        const amt = $('goSubmitAmt');
        if (amt) amt.textContent = (pricesOn() && total) ? fmtPrice(total) : '';
        $('goSubmit').classList.toggle('has-amt', !!(amt && amt.textContent));
        const lineHtml = (l, i) => {
            const det = lineDetails(l);
            const single = lineMax(l) === 1;
            const side = single
                ? `<button class="go-cline-del" data-del="${i}" aria-label="${esc(t('guest.item.removeFromCart'))}: ${esc(l.name)}">${icon('trash', 17, 2)}</button>`
                : `<div class="go-step"><button data-cdec="${i}" aria-label="${esc(l.qty === 1 ? t('guest.item.removeFromCart') : t('guest.item.decrease'))}">${icon(l.qty === 1 ? 'trash' : 'minus', 17, 2.2)}</button><b>${l.qty}</b><button data-cinc="${i}" aria-label="${esc(t('guest.item.increase'))}">${icon('plus', 17, 2.4)}</button></div>`;
            return `<div class="go-cline" data-i="${i}">
                <div class="go-item-emoji" aria-hidden="true">${esc(l.icon || '🛎️')}</div>
                <div class="go-cline-main" data-editline="${i}" role="button" tabindex="0">
                    <div class="go-cline-name">${esc(l.name)}</div>
                    ${det.length ? `<div class="go-cline-det">${esc(det.join(' · '))}</div>` : ''}
                    ${(pricesOn() && priceOf(l)) ? `<div class="go-cline-price">${esc(fmtPrice(priceOf(l) * l.qty))}</div>` : ''}
                    ${lineBreakdownHtml(l)}
                    <span class="go-cline-edit">${esc(t('common.edit'))}</span>
                </div>
                <div class="go-cline-side">${side}</div>
            </div>`;
        };
        // Satırlar DEPARTMANA göre gruplanır (canonicalDept eş adları birleştirir)
        // — birden fazla departmana giden sepette neyin nereye gittiği görünür.
        const groups = [];
        cart.forEach((l, i) => {
            const raw = String(l.department || l.category || '').trim();
            // Bilinen departmanlar ana sayfadaki adla ve AKTİF DİLDE başlık olur;
            // bilinmeyenler (otelin özel departmanı) olduğu gibi.
            const kk = deptKindKey(deptOf(l));
            const key = (kk && DEPT_KIND_DEFS[kk]) ? DEPT_KIND_DEFS[kk].label
                : ((raw && typeof canonicalDept === 'function' ? canonicalDept(raw) : raw) || t('common.other'));
            let g = groups.find(x => x.key === key);
            if (!g) { g = { key: key, rows: [] }; groups.push(g); }
            g.rows.push(lineHtml(l, i));
        });
        const lines = groups.length === 1
            ? `<div class="go-listcard">${groups[0].rows.join('')}</div>`
            : groups.map(g => `<div class="go-caption">${esc(g.key)}</div><div class="go-listcard">${g.rows.join('')}</div>`).join('');
        const eta = cartEtaText();
        const sumRow = (tl, val, cls) => `<div class="go-row ${cls || ''}"><span class="go-row-main"><span class="go-row-tl">${esc(tl)}</span></span><span class="go-row-val go-num">${esc(val)}</span></div>`;
        const summary = `<div class="go-listcard go-summary">
                ${ROOM ? sumRow(t('guest.cart.deliverTo'), t('guest.home.room', { room: ROOM })) : ''}
                ${eta ? sumRow(t('guest.cart.etaLabel'), eta) : ''}
                ${(pricesOn() && total) ? sumRow(t('guest.cart.total'), fmtPrice(total), 'total') : ''}
            </div>
            <p class="go-cart-note">${esc(t('guest.cart.note'))}</p>`;
        wrap.innerHTML = lines + summary;
        wrap.onclick = e => {
            const del = e.target.closest('[data-del]'); if (del) { cart.splice(+del.dataset.del, 1); saveCart(); renderCartUI(); renderCart(); refreshAllItemRows(); return; }
            const ci = e.target.closest('[data-cinc]'); if (ci) return bumpLine(+ci.dataset.cinc, +1);
            const cd = e.target.closest('[data-cdec]'); if (cd) return bumpLine(+cd.dataset.cdec, -1);
            // Satırın gövdesine dokunma → o kalemin detayı (seçenek/not/saat).
            const ed = e.target.closest('[data-editline]'); if (ed) { const l = cart[+ed.dataset.editline]; if (l) openItemSheet(l.catalogId); }
        };
        wrap.onkeydown = e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const ed = e.target.closest('[data-editline]'); if (!ed) return;
            e.preventDefault(); const l = cart[+ed.dataset.editline]; if (l) openItemSheet(l.catalogId);
        };
    }
    function bumpLine(i, delta) {
        const l = cart[i]; if (!l) return;
        if (delta > 0 && l.qty >= lineMax(l)) { toast(capMsg(l), true); return; }
        l.qty = Math.max(0, l.qty + delta);
        if (l.qty === 0) cart.splice(i, 1);
        saveCart(); renderCartUI(); refreshAllItemRows();
        renderCart();
    }
    function refreshAllItemRows() { (catalog || []).forEach(it => refreshItemRow(it.id)); }


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
        const title = names.length > 30 ? names.slice(0, 29) + '…' : (names || t('guest.cart.countLabel', { n: (o.items || []).length }));
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
        $('goOrdersBar').classList.add('is-root');
        $('goOrdersTitle').textContent = t('guest.nav.orders');
        const wrap = $('goOrders');
        if (!myOrders.length) {
            wrap.innerHTML = emptyHtml('list', t('guest.track.none'), t('guest.track.noneHint'), `<button class="go-cta" id="goOrdersCreate">${esc(t('guest.track.create'))}</button>`);
            $('goOrdersCreate').onclick = () => openServices('');
            return;
        }
        // Concierge talepleri ayrı sekmede — hiç concierge siparişi yoksa
        // sekme kontrolü hiç görünmez.
        const anyCon = myOrders.some(orderHasConcierge);
        let tabsHtml = '';
        let list = myOrders;
        if (anyCon) {
            const reqList = myOrders.filter(o => orderHasNormal(o) || !orderHasConcierge(o));
            const conList = myOrders.filter(orderHasConcierge);
            list = ordersTab === 'con' ? conList : reqList;
            tabsHtml = `<div class="go-seg go-segtabs" role="tablist">
                <button role="tab" aria-selected="${ordersTab === 'req'}" class="${ordersTab === 'req' ? 'active' : ''}" data-otab="req">${esc(t('guest.track.tabRequests'))} · ${reqList.length}</button>
                <button role="tab" aria-selected="${ordersTab === 'con'}" class="${ordersTab === 'con' ? 'active' : ''}" data-otab="con">${esc(t('guest.track.tabConcierge'))} · ${conList.length}</button>
            </div>`;
        }
        const isOpen = o => o.status !== 'completed' && o.status !== 'cancelled';
        const card = o => {
            const st = STATUS[o.status] || STATUS.pending;
            const names = (o.items || []).map(it => it.name).join(', ') || t('guest.cart.countLabel', { n: (o.items || []).length });
            const when = relTime(tsMs(o));
            const w = isOpen(o) ? orderEta(o) : null;
            return `<button class="go-ocard" data-open="${esc(o.id)}">
                <span class="go-stic go-st-${esc(o.status)}">${statusIcon(o.status, 20)}</span>
                <span class="go-ocard-main">
                    <span class="go-ocard-tl">${esc(names)}</span>
                    <span class="go-ocard-sub"><span class="go-statepill go-st-${esc(o.status)}">${esc(st.label)}</span>${when ? `<span>${esc(when)}</span>` : ''}</span>
                    ${w ? `<span class="go-ocard-eta">${esc(etaLabelText(w, 'guest.eta.order'))}</span>` : ''}
                </span>
                <span class="go-chev">${icon('chev', 18)}</span>
            </button>`;
        };
        const act = list.filter(isOpen), past = list.filter(o => !isOpen(o));
        let body = '';
        if (act.length) body += `<div class="go-caption">${esc(t('guest.track.activeTitle'))}</div><div class="go-listcard">${act.map(card).join('')}</div>`;
        if (past.length) body += `<div class="go-caption">${esc(t('guest.track.pastTitle'))}</div><div class="go-listcard">${past.map(card).join('')}</div>`;
        if (!body) body = emptyHtml('list', t('guest.track.noneInTab'), '');
        wrap.innerHTML = tabsHtml + body;
        wrap.onclick = e => {
            const tb = e.target.closest('[data-otab]');
            if (tb) { ordersTab = tb.dataset.otab; showOrderList(); return; }
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
        $('goOrdersBar').classList.remove('is-root');
        $('goOrdersTitle').textContent = t('guest.track.title');
        renderTracking();
        $('goTrack').scrollTop = 0;
    }
    function currentTracked() { return myOrders.find(o => o.id === trackingId) || null; }
    // Kalem hâlâ 'pending'/'confirmed' (personel henüz üstlenmedi) olduğu
    // sürece misafir düzenleyebilir/iptal edebilir — sunucu
    // (updateGuestOrderItem/cancelGuestOrderItem) aynı şartı tekrar kontrol
    // eder; burası yalnızca arayüz kapısı.
    let trackEditItemId = null, trackEditQty = 1;
    function renderTracking() {
        const o = currentTracked(); const wrap = $('goTrack'); if (!wrap) return;
        if (!o) { showOrderList(); return; }
        const st = STATUS[o.status] || STATUS.pending;
        const cancelled = o.status === 'cancelled';
        const finished = cancelled || o.status === 'completed';
        const stepIdx = FLOW.indexOf(o.status);
        const showP = !!o.showPrices && Number(o.total) > 0;
        const cur = o.currency || '₺';
        const money = n => cur + Number(n || 0).toLocaleString('tr-TR');
        const w = finished ? null : orderEta(o);
        const etaHtml = w ? `<div class="go-trk-eta" role="status">
                <small>${esc(t(w.scheduled ? 'guest.eta.scheduledTitle' : 'guest.eta.title'))}</small>
                <strong>${esc(fmtWindow(w))}</strong>
                <span>${esc(etaRemainText(w))}</span>
            </div>` : '';
        const steps = cancelled ? '' : `<div class="go-trk-steps" aria-label="${esc(st.label)}">${FLOW.map((s, i) => {
            const cls = i < stepIdx ? 'done' : (i === stepIdx ? 'active' : '');
            const log = (o.statusLog || []).filter(l => l.status === s).pop();
            const tm = log ? clock(log.at) : '';
            return `<div class="go-trk-step ${cls}"><i></i><b>${esc(STATUS[s].label)}</b>${tm ? `<span>${esc(tm)}</span>` : ''}</div>`;
        }).join('')}</div>`;
        const metaRow = (tl, val) => `<div class="go-row"><span class="go-row-main"><span class="go-row-tl">${esc(tl)}</span></span><span class="go-row-val go-num">${esc(val)}</span></div>`;
        const meta = `<div class="go-listcard go-trk-meta">
                ${o.room ? metaRow(t('guest.track.metaRoom'), o.room) : ''}
                ${metaRow(t('guest.track.metaCreated'), [relTime(tsMs(o)), clock(tsMs(o))].filter(Boolean).join(' · '))}
                ${showP ? metaRow(t('guest.track.metaTotal'), money(o.total)) : ''}
            </div>`;
        const items = (o.items || []).map(it => {
            const ist = STATUS[it.status] || STATUS.pending;
            const transferMeta = (it.transferFrom || it.transferTo) ? (it.transferFrom || '?') + ' → ' + (it.transferTo || '?') : '';
            const transferWhen = (it.transferDate || it.transferTime)
                ? [it.transferDate ? String(it.transferDate).split('-').reverse().join('.') : '', it.transferTime].filter(Boolean).join(' ') : '';
            const bits = [it.option || '', it.qty > 1 ? t('guest.track.qty', { n: it.qty }) : '', transferMeta, transferWhen,
                (!transferWhen && it.preferredTime) ? t('guest.cart.at', { time: it.preferredTime }) : '', it.note ? '“' + it.note + '”' : ''];
            if (Array.isArray(it.modifiers) && it.modifiers.length) bits.push(it.modifiers.map(m => modLabel(normalizeModifier(m), Number(m.qty) || 1)).join(', '));
            if (showP && Number(it.price) > 0) bits.push(money(Number(it.price) * (it.qty || 1)));
            const metaTxt = bits.filter(Boolean).join(' · ');
            // Tahmini teslim: tamamlandıysa gerçek saat, iptalse yok, aksi
            // halde kayan/planlı EDT penceresi.
            const ie = itemEta(o, it);
            const itemEtaHtml = !ie ? ''
                : (ie.done
                    ? `<div class="go-titem-eta done">${esc(ie.at ? t('guest.eta.deliveredAt', { time: clock(ie.at) }) : t('guest.eta.delivered'))}</div>`
                    : `<div class="go-titem-eta">${esc(etaLabelText(ie, 'guest.eta.item'))}</div>`);
            const editable = (it.status || 'pending') === 'pending' || it.status === 'confirmed';
            const canAct = !DEMO && !cancelled && editable;
            const editing = canAct && trackEditItemId === it.id;
            const editHtml = editing ? `<div class="go-titem-edit">
                    ${lineMax(it) > 1 ? `<div class="go-titem-edit-qty"><span>${esc(t('guest.item.quantity'))}</span><div class="go-step"><button id="goTEDec" aria-label="${esc(t('guest.item.decrease'))}">${icon('minus', 17, 2.4)}</button><b id="goTEQty">${trackEditQty}</b><button id="goTEInc" aria-label="${esc(t('guest.item.increase'))}">${icon('plus', 17, 2.4)}</button></div></div>` : ''}
                    <div class="go-fld"><label for="goTENote">${esc(t('guest.item.noteTitle'))}</label><input type="text" id="goTENote" maxlength="160" value="${esc(it.note || '')}"></div>
                    <div class="go-titem-edit-acts"><button class="go-btn" id="goTECancel">${esc(t('common.dismiss'))}</button><button class="go-cta" id="goTESave">${esc(t('common.save'))}</button></div>
                </div>` : '';
            return `<div class="go-titem">
                <div class="go-item-emoji" aria-hidden="true">${esc(it.icon || '🛎️')}</div>
                <div class="go-titem-main">
                    <div class="go-titem-top"><div class="go-titem-name">${esc(it.name)}</div><span class="go-statepill go-st-${esc(it.status || 'pending')}">${esc(ist.label)}</span></div>
                    ${metaTxt ? `<div class="go-titem-meta">${esc(metaTxt)}</div>` : ''}
                    ${itemEtaHtml}
                    ${it.status === 'cancelled' && it.cancelReason ? `<div class="go-titem-cancel-reason">${esc(it.cancelReason)}</div>` : ''}
                    ${canAct && !editing ? `<div class="go-titem-acts"><button class="go-titem-act" data-item-edit="${esc(it.id)}">${esc(t('common.edit'))}</button><button class="go-titem-act danger" data-item-cancel="${esc(it.id)}">${esc(t('guest.track.cancelItem'))}</button></div>` : ''}
                    ${editHtml}
                </div>
            </div>`;
        }).join('');
        wrap.innerHTML = `
            <div class="go-trk-head">
                <span class="go-stic go-st-${esc(o.status)}">${statusIcon(o.status, 24)}</span>
                <div><h2>${esc(st.label)}</h2><p>${esc(st.sub)}</p></div>
            </div>
            ${etaHtml}
            ${cancelled && o.cancelReason ? `<div class="go-cancel-reason">
                <div class="go-cancel-reason-h">${esc(t('guest.track.cancelReason'))}</div>
                <div class="go-cancel-reason-b">${esc(o.cancelReason)}</div>
            </div>` : ''}
            ${steps}
            <div class="go-caption">${esc(t('guest.track.itemsTitle', { n: (o.items || []).length }))}</div>
            <div class="go-listcard">${items}</div>
            ${meta}
            <div class="go-btns">
                <button class="go-btn" id="goNewBtn">${icon('plus', 18, 2.2)}${esc(t('guest.track.createNew'))}</button>
                ${(o.status === 'pending' || o.status === 'confirmed') ? `<button class="go-btn-text danger" id="goCancelBtn">${esc(t('guest.track.cancelOrder'))}</button>` : ''}
            </div>`;
        const cb = $('goCancelBtn'); if (cb) cb.onclick = () => cancelOrder(o.id);
        $('goNewBtn').onclick = () => openServices('');
        wrap.querySelectorAll('[data-item-edit]').forEach(b => b.onclick = () => {
            const it = (o.items || []).find(x => x.id === b.dataset.itemEdit); if (!it) return;
            trackEditItemId = it.id; trackEditQty = Math.max(1, it.qty || 1);
            renderTracking();
            const n = $('goTENote'); if (n) { try { n.focus(); } catch (e) {} }
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
        const btn = $('goTESave'); if (btn) { btn.disabled = true; btn.textContent = t('common.saving'); }
        try {
            const res = await fns.httpsCallable('updateGuestOrderItem')({ orderId, itemId, patch: { qty: trackEditQty, note } });
            if (!res || !res.data || !res.data.ok) throw new Error('fail');
            trackEditItemId = null; toast(t('guest.track.itemUpdated')); renderTracking();
        } catch (e) {
            console.error('update item failed', e);
            toast(t('guest.track.updateFailedTaken'), true);
            if (btn) { btn.disabled = false; btn.textContent = t('common.save'); }
        }
    }
    async function cancelOrderItem(orderId, itemId) {
        const ok = await confirmSheet({ title: t('guest.track.cancelItemTitle'), message: t('guest.track.confirmCancelItem'), confirmText: t('guest.track.cancelItem'), danger: true });
        if (!ok) return;
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
    async function cancelOrder(id) {
        const ok = await confirmSheet({ title: t('guest.track.cancelOrderTitle'), message: t('guest.track.confirmCancelOrder'), confirmText: t('guest.track.cancelOrder'), danger: true });
        if (!ok) return;
        if (DEMO) { const o = loadDemoOrder(id); if (o) { o.cancelled = true; saveDemoOrder(o); } if (demoTimer) { clearInterval(demoTimer); } loadDemoOrders(); return; }
        if (!fns) { toast(t('common.noConnection'), true); return; }
        // Bağlı guestLogs/reservations dokümanlarını tek transaction'da
        // senkronize eden Cloud Function (çıplak client update DEĞİL).
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
        btn.disabled = true; lbl.textContent = t('guest.gate.checking');
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
        if (opts.tel) act = `<a class="go-row-act" href="tel:${esc(opts.tel)}">${esc(t('guest.info.call'))}</a>`;
        else if (opts.map) act = `<a class="go-row-act" href="https://maps.google.com/?q=${encodeURIComponent(opts.map)}" target="_blank" rel="noopener">${esc(t('guest.info.map'))}</a>`;
        else if (opts.copy) act = `<button class="go-row-act" data-copy="${esc(opts.copy)}">${esc(t('guest.info.copy'))}</button>`;
        return `<div class="go-row"><span class="go-row-ic">${svg(INFO_ICONS[ic] || INFO_ICONS.pin, 18)}</span>
            <span class="go-row-main"><span class="go-row-sub">${esc(label)}</span><span class="go-row-val">${esc(val)}</span></span>${act}</div>`;
    }
    function openInfo() {
        const body = $('goInfoBody');
        const welcome = String(config.welcome || '').trim();
        const rows = [
            infoRow('phone', t('guest.info.reception'), config.phone, { tel: phoneDigits() }),
            infoRow('wifi', t('guest.info.wifiName'), config.wifiName, { copy: config.wifiName }),
            infoRow('wifi', t('guest.info.wifiPass'), config.wifiPass, { copy: config.wifiPass }),
            infoRow('clock', t('guest.info.checkout'), config.checkoutTime),
            infoRow('coffee', t('guest.info.breakfast'), config.breakfast),
            infoRow('pin', t('guest.info.address'), config.address, { map: config.address })
        ].filter(Boolean).join('');
        body.innerHTML = `<div class="go-info-hero"><h3>${esc(hotelName())}</h3>${welcome ? `<p>${esc(welcome)}</p>` : ''}</div>`
            + (rows ? `<div class="go-listcard">${rows}</div>` : emptyHtml('info', t('guest.info.none'), t('guest.info.noneHint')));
        body.onclick = e => {
            const b = e.target.closest('[data-copy]'); if (!b) return;
            try { navigator.clipboard.writeText(b.dataset.copy); toast(t('common.copied')); } catch (err) {}
        };
        openSheet('goInfoSheet', 'goInfoBackdrop');
    }
    function closeInfo() { closeSheet('goInfoSheet', 'goInfoBackdrop'); }


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
        document.querySelectorAll('.go-nav-b').forEach(b => b.onclick = () => showTab(b.dataset.go));
        // Dil düğmesi (ana ekran üst çubuğu). İki dil olduğu için tek dokunuş
        // diğerine geçirir; etiket HEDEF dili gösterir.
        const lgb = $('goLangBtn');
        if (lgb) {
            const other = I18n.lang() === 'tr' ? 'en' : 'tr';
            lgb.textContent = other === 'en' ? 'EN' : 'TR';
            lgb.onclick = () => I18n.setLang(other);
        }
        $('goCartPill').onclick = () => showTab('cart');
        const lb = $('goLiveBar'); if (lb) lb.onclick = () => { const id = lb.dataset.track; if (id) openTracking(id); };
        const ibk = $('goItemBackdrop'); if (ibk) ibk.onclick = closeItemSheet;
        $('goBell').onclick = () => showTab('orders');
        const hs = $('goHomeSearch'); if (hs) hs.onclick = () => openServices('', true);
        const sa = $('goSeeAll'); if (sa) sa.onclick = () => openServices('');
        const sb = $('goServicesBack'); if (sb) sb.onclick = () => showTab('home');
        const cbk = $('goCartBack'); if (cbk) cbk.onclick = () => showTab(activeDept || searchTerm ? 'services' : 'home');
        $('goTrackBack').onclick = showOrderList;
        $('goCartClear').onclick = async () => {
            if (!cart.length) return;
            const ok = await confirmSheet({ title: t('guest.cart.clearTitle'), message: t('guest.cart.clearConfirm'), confirmText: t('guest.cart.clear'), danger: true });
            if (!ok) return;
            cart = []; saveCart(); renderCartUI(); renderCart(); refreshAllItemRows();
        };
        $('goSubmit').onclick = submitOrder;
        $('goGateBtn').onclick = doVerify;
        $('goGateBackdrop').onclick = () => { if (isVerified()) closeGate(); };
        const fc = $('goFolioClose'); if (fc) fc.onclick = closeFolio;
        const fb = $('goFolioBackdrop'); if (fb) fb.onclick = closeFolio;
        const ic = $('goInfoClose'); if (ic) ic.onclick = closeInfo;
        const ib = $('goInfoBackdrop'); if (ib) ib.onclick = closeInfo;
        const mc = $('goMenusClose'); if (mc) mc.onclick = closeMenus;
        const mb = $('goMenusBackdrop'); if (mb) mb.onclick = closeMenus;
        // Escape: en üstteki açık sheet'i kapatır (klavye/erişilebilirlik).
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if ($('goConfirm').classList.contains('show')) { $('goConfirmNo').click(); return; }
            if ($('goItemSheet').classList.contains('show')) { closeItemSheet(); return; }
            if ($('goFolioSheet').classList.contains('show')) { closeFolio(); return; }
            if ($('goInfoSheet').classList.contains('show')) { closeInfo(); return; }
            if ($('goMenusSheet').classList.contains('show')) { closeMenus(); return; }
            if ($('goGate').classList.contains('show') && isVerified()) closeGate();
        });
        // Arama
        const s = $('goSearch');
        if (s) s.addEventListener('input', () => { searchTerm = s.value; $('goSearchX').hidden = !s.value; renderItems(); });
        $('goSearchX').onclick = () => { searchTerm = ''; $('goSearch').value = ''; $('goSearchX').hidden = true; renderItems(); $('goSearch').focus(); };
        // Soyadı otomatik büyük harfe çevrilir; her Unicode HARF kabul edilir
        // (yabancı misafirlerin Ø/Ñ/Å/Kiril soyadları silinmesin). Sunucu
        // diyakritikleri katlayarak karşılaştırır (functions/index.js:_normTr).
        const su = $('goGateSurname');
        if (su) su.addEventListener('input', () => {
            const p = su.selectionStart;
            var v = su.value.toLocaleUpperCase('tr-TR');
            try { v = v.replace(/[^\p{L} \-']/gu, ''); }
            catch (e) { v = v.replace(/[^A-ZÇĞİÖŞÜ \-']/g, ''); } // \p{L} desteklemeyen eski tarayıcı
            su.value = v;
            try { su.setSelectionRange(p, p); } catch (e) {}
        });
        const by = $('goGateBirthYear');
        if (by) by.addEventListener('input', () => { const v = by.value.replace(/\D/g, '').slice(0, 4); if (v !== by.value) by.value = v; });
        ['goGateSurname', 'goGateBirthYear'].forEach(id => { const el = $(id); if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); }); });
    }

    // ── Go ─────────────────────────────────────────────────────
    // DEMO modu Firebase'e hiç dokunmaz (boot()'un DEMO dalına bakın) — bu
    // guard yine de db/auth'u şart koşuyordu, bu yüzden Firebase SDK script'i
    // (ör. ağ engeli, gstatic.com erişilemez) yüklenemediğinde ?demo bile
    // "Yapılandırma hatası" gösterip hiç boot olmuyordu.
    if (!DEMO && (typeof db === 'undefined' || typeof auth === 'undefined' || !db || !auth)) {
        const el = document.getElementById('goCats');
        if (el) el.innerHTML = `<div style="grid-column:1/-1">${emptyHtml('alert', t('guest.stay.configError'), t('common.noConnection'))}</div>`;
        return;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
