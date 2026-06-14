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

    // ── Tenant + room from the QR link ─────────────────────────
    const TENANT = (typeof resolveTenant === 'function' ? resolveTenant() : 'mgallery');
    const params = new URLSearchParams(window.location.search);
    let ROOM = (params.get('room') || params.get('oda') || '').trim().slice(0, 40);

    const CART_KEY = `go_cart_${TENANT}_${ROOM || 'x'}`;
    const ORDER_KEY = `go_order_${TENANT}_${ROOM || 'x'}`;
    const COOLDOWN_KEY = `go_cd_${TENANT}_${ROOM || 'x'}`;

    // ── Anti-spam limits ───────────────────────────────────────
    const MAX_DISTINCT = 20, MAX_QTY = 10, COOLDOWN_MS = 60 * 1000;

    const DEMO = params.has('demo');
    let demoTimer = null;

    // Built-in DEMO catalog — 4 operational categories only.
    const DEMO_CATALOG = [
        { category: 'Temizlik', name: 'Oda Temizliği', icon: '🧹', eta: '30-45 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Havlu Değişimi', icon: '🧺', eta: '15-30 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Çarşaf Değişimi', icon: '🛏️', eta: '30-45 dk', department: 'Housekeeping' },
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
    const DEFAULT_CONFIG = { hotelName: '', showPrices: false, currency: '₺' };
    const DEMO_CONFIG = { hotelName: 'Grand Demo Otel', showPrices: true, currency: '₺' };
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
    let catalog = [], cart = [], activeCat = null, sessionUid = null;
    let orderUnsub = null, currentOrderId = null, activeOrderStatus = null;

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

    // Category → line icon + gradient (keyword based).
    function catKind(cat) {
        const c = String(cat || '').toLowerCase();
        if (/temiz|housekeep|clean/.test(c)) return 'temiz';
        if (/konfor|comfort|amenit/.test(c)) return 'konfor';
        if (/yiyecek|içecek|icecek|food|beverage|restoran|minibar/.test(c)) return 'food';
        if (/teknik|tech|engineer|ariza|arıza|maintenance/.test(c)) return 'teknik';
        if (/resepsiyon|front|concierge/.test(c)) return 'bell';
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

    // ── Cart persistence ───────────────────────────────────────
    function loadCart() {
        try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { cart = []; }
        if (!Array.isArray(cart)) cart = [];
    }
    function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {} }
    const cartCount = () => cart.reduce((n, l) => n + (l.qty || 0), 0);

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        if (ROOM) { $('goRoomChip').style.display = 'inline-flex'; $('goRoomLabel').textContent = 'Oda ' + ROOM; }
        loadCart();
        wireEvents();
        renderCartBar();

        if (DEMO) {
            sessionUid = 'demo';
            config = Object.assign({}, DEFAULT_CONFIG, DEMO_CONFIG);
            catalog = DEMO_CATALOG.slice();
            applyHotelName();
            renderAll();
            resumeOrder();
            return;
        }

        applyHotelName();
        let started = false;
        auth.onAuthStateChanged(u => {
            if (u && !started) { started = true; sessionUid = u.uid; loadData(); resumeOrder(); }
        });
        auth.signInAnonymously().catch(err => {
            console.error('Anon sign-in failed', err);
            $('goBody').innerHTML = stateHtml('⚠️', 'Bağlantı kurulamadı',
                'Anonim giriş kapalı olabilir. Test için bağlantıya ?demo=1 ekleyin.');
        });
    }
    function prettyTenant(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'StayOS'; }
    function applyHotelName() {
        const name = (config.hotelName && config.hotelName.trim()) || prettyTenant(TENANT);
        $('goHotelName').textContent = name + (DEMO ? ' · DEMO' : '');
    }

    // ── Data (config + catalog) ────────────────────────────────
    function loadData() {
        Promise.all([fetchConfig(), fetchCatalog()]).then(() => { applyHotelName(); renderAll(); });
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
    function renderAll() {
        if (!catalog.length) {
            $('goTiles').innerHTML = '';
            $('goBody').innerHTML = stateHtml('🛎️', 'Henüz hizmet tanımlanmamış',
                'Bu otel için talepler henüz hazır değil. Lütfen resepsiyon ile iletişime geçin.');
            return;
        }
        renderTiles();
        renderItems();
        refreshStepControls();
        renderCartBar();
    }

    function renderTiles() {
        const cats = categories();
        if (!activeCat || !cats.includes(activeCat)) activeCat = cats[0];
        $('goTiles').innerHTML = cats.map(c => {
            const count = catalog.filter(i => (i.category || 'Diğer') === c).length;
            return `<button class="go-tile ${c === activeCat ? 'active' : ''}" data-cat="${esc(c)}" style="background:${catGrad(c)}">
                <span class="go-tile-check">✓</span>
                <span class="go-tile-ico">${catIcon(c, 32)}</span>
                <div><div class="go-tile-name">${esc(c)}</div><div class="go-tile-count">${count} hizmet</div></div>
            </button>`;
        }).join('');
        $('goTiles').onclick = (e) => {
            const t = e.target.closest('.go-tile');
            if (!t || t.dataset.cat === activeCat) return;
            activeCat = t.dataset.cat;
            renderTiles();
            renderItems();
            refreshStepControls();
        };
    }

    function renderItems() {
        const items = catalog.filter(i => (i.category || 'Diğer') === activeCat);
        $('goBody').innerHTML = `
            <div class="go-items-head"><span class="ih-ico" style="background:${catGrad(activeCat)}">${catIcon(activeCat, 20)}</span><h2>${esc(activeCat)}</h2></div>
            <div class="go-grid">${items.map(cardHtml).join('')}</div>`;
        bindBodyEvents();
    }

    function cardHtml(item) {
        const price = priceTag(item);
        const metaBits = [];
        if (item.eta) metaBits.push(`<span class="go-meta">${clockSvg}${esc(item.eta)}</span>`);
        if (price) metaBits.push(price);
        return `<div class="go-card" data-id="${esc(item.id)}">
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
            const add = e.target.closest('[data-add]');
            const inc = e.target.closest('[data-inc]');
            const dec = e.target.closest('[data-dec]');
            if (add) return changeQty(add.dataset.add, +1);
            if (inc) return changeQty(inc.dataset.inc, +1);
            if (dec) return changeQty(dec.dataset.dec, -1);
        };
    }

    // ── Cart mutations (with caps) ─────────────────────────────
    function changeQty(catalogId, delta) {
        const item = catalog.find(i => i.id === catalogId);
        if (!item) return;
        let line = cart.find(l => l.catalogId === catalogId);
        if (!line && delta > 0) {
            if (cart.length >= MAX_DISTINCT) { toast(`En fazla ${MAX_DISTINCT} farklı talep ekleyebilirsiniz.`, true); return; }
            line = { catalogId, name: item.name, category: item.category || 'Diğer', icon: item.icon || '🛎️',
                department: item.department || '', price: priceOf(item), qty: 0, note: '', preferredTime: '' };
            cart.push(line);
        }
        if (!line) return;
        if (delta > 0 && line.qty >= MAX_QTY) { toast(`Bir talepten en fazla ${MAX_QTY} adet.`, true); return; }
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
        if (delta > 0 && l.qty >= MAX_QTY) { toast(`Bir talepten en fazla ${MAX_QTY} adet.`, true); return; }
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
            ROOM = r; $('goRoomChip').style.display = 'inline-flex'; $('goRoomLabel').textContent = 'Oda ' + ROOM;
        }
        const btn = $('goSubmit');
        btn.disabled = true; setSubmitLabel('Gönderiliyor...');

        const guestName = ($('goGuestName').value || '').trim().slice(0, 60);
        const items = cart.map((l, idx) => ({
            id: 'i' + idx + '_' + Date.now().toString(36),
            catalogId: l.catalogId || '',
            name: String(l.name || '').slice(0, 120),
            category: String(l.category || '').slice(0, 60),
            icon: String(l.icon || '🛎️').slice(0, 8),
            department: String(l.department || '').slice(0, 60),
            price: priceOf(l),
            qty: Math.min(MAX_QTY, Math.max(1, l.qty || 1)),
            note: String(l.note || '').slice(0, 160),
            preferredTime: String(l.preferredTime || '').slice(0, 10),
            status: 'pending'
        }));
        const total = items.reduce((s, it) => s + (Number(it.price) || 0) * it.qty, 0);

        const finishOk = (id) => {
            currentOrderId = id;
            try { localStorage.setItem(ORDER_KEY, id); } catch (e) {}
            try { localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS)); } catch (e) {}
            cart = []; saveCart();
            closeSheet();
            btn.disabled = false; setSubmitLabel('Sipariş Ver');
            $('goGuestName').value = '';
            toast('Talebiniz alındı! 🎉' + (DEMO ? ' (demo)' : ''));
            subscribeOrder(id);
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
    function resumeOrder() {
        let saved = null;
        try { saved = localStorage.getItem(ORDER_KEY); } catch (e) {}
        if (saved) subscribeOrder(saved, true);
    }
    function subscribeOrder(orderId, silent) {
        if (orderUnsub) { orderUnsub(); orderUnsub = null; }
        if (DEMO) { subscribeDemo(orderId, silent); return; }
        currentOrderId = orderId;
        orderUnsub = db.collection('guestOrders').doc(orderId).onSnapshot(doc => {
            if (!doc.exists) { activeOrderStatus = null; if (!silent) showCatalogView(); return; }
            const order = Object.assign({ id: doc.id }, doc.data());
            activeOrderStatus = order.status;
            renderTracking(order);
            if (order.status === 'completed' || order.status === 'cancelled') { try { localStorage.removeItem(ORDER_KEY); } catch (e) {} }
            showTrackingView();
        }, err => { console.error('track failed', err); if (!silent) showCatalogView(); });
    }
    function showTrackingView() {
        $('goCatalogView').classList.add('go-hidden');
        $('goTrackView').classList.remove('go-hidden');
        $('goCartBar').classList.remove('show');
        window.scrollTo(0, 0);
    }
    function showCatalogView() {
        $('goTrackView').classList.add('go-hidden');
        $('goCatalogView').classList.remove('go-hidden');
        renderCartBar();
        window.scrollTo(0, 0);
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
        $('goTrackBody').innerHTML = `
            <div class="go-track-hero"><div class="go-track-emoji">${esc(st.emoji)}</div><h2>${esc(st.label)}</h2><p>${esc(heroSub)}</p>
                ${showP ? `<div class="go-track-total">Toplam: <b>${esc(fmtP(order.total))}</b></div>` : ''}</div>
            ${steps}
            <div class="go-track-items"><h3>Talepleriniz (${(order.items || []).length})</h3>${items}</div>
            <div class="go-track-actions">
                ${canCancel ? `<button class="go-btn-ghost go-btn-danger" id="goCancel">Talebi İptal Et</button>` : ''}
                <button class="go-btn-ghost" id="goNew">＋ Yeni Talep Oluştur</button>
            </div>`;
        const cancelBtn = $('goCancel');
        if (cancelBtn) cancelBtn.onclick = () => cancelOrder(order.id);
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
            if (o) { o.cancelled = true; saveDemoOrder(o); activeOrderStatus = 'cancelled'; renderTracking(demoView(o)); }
            if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
            try { localStorage.removeItem(ORDER_KEY); } catch (e) {}
            toast('Talep iptal edildi.');
            return;
        }
        db.collection('guestOrders').doc(orderId).update({ status: 'cancelled', updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
            .then(() => toast('Talep iptal edildi.')).catch(err => { console.error(err); toast('İptal edilemedi.', true); });
    }

    // ── DEMO backend (localStorage + simulated flow) ───────────
    const DEMO_STEPS = [[0, 'pending'], [4000, 'confirmed'], [9000, 'in_progress'], [15000, 'completed']];
    function saveDemoOrder(o) { try { localStorage.setItem('go_demo_' + o.id, JSON.stringify(o)); } catch (e) {} }
    function loadDemoOrder(id) { try { return JSON.parse(localStorage.getItem('go_demo_' + id)); } catch (e) { return null; } }
    function demoView(o) {
        if (o.cancelled) return Object.assign({}, o, { status: 'cancelled', items: (o.items || []).map(it => Object.assign({}, it, { status: 'cancelled' })) });
        const e = Date.now() - (o.createdAtMs || Date.now());
        let status = 'pending'; const log = [];
        DEMO_STEPS.forEach(([t, s]) => { if (e >= t) { status = s; log.push({ status: s, at: (o.createdAtMs || 0) + t, by: t === 0 ? 'guest' : 'Personel' }); } });
        return Object.assign({}, o, { status, items: (o.items || []).map(it => Object.assign({}, it, { status })), statusLog: log });
    }
    function subscribeDemo(orderId, silent) {
        if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
        currentOrderId = orderId;
        const tick = () => {
            const o = loadDemoOrder(orderId);
            if (!o) { activeOrderStatus = null; if (!silent) showCatalogView(); if (demoTimer) clearInterval(demoTimer); return; }
            const view = demoView(o);
            activeOrderStatus = view.status;
            renderTracking(view); showTrackingView();
            if (view.status === 'completed' || view.status === 'cancelled') { if (demoTimer) { clearInterval(demoTimer); demoTimer = null; } try { localStorage.removeItem(ORDER_KEY); } catch (e) {} }
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
        $('goTrackIc').onclick = () => {
            if (currentOrderId) subscribeOrder(currentOrderId);
            else toast('Henüz aktif bir talebiniz yok.');
        };
    }

    // ── Go ─────────────────────────────────────────────────────
    if (typeof db === 'undefined' || typeof auth === 'undefined') {
        document.getElementById('goBody').innerHTML = '<div class="go-state"><div class="go-state-emoji">⚠️</div><h3>Yapılandırma hatası</h3></div>';
        return;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
