/* StayOS — Guest Self-Service ordering (guest-order.html)
 *
 * A QR-opened, login-free page where a guest browses an admin-managed catalog
 * of requests, builds a cart (quantity / note / preferred time) and places an
 * order, then watches it move through Bekliyor → Onaylandı → İşlemde → Tamamlandı
 * live.
 *
 * Isolation: the guest is signed in with Firebase Anonymous Auth, so every
 * order is bound to their session uid and the security rules let them read ONLY
 * their own orders. Tenant + room come from the QR link
 * (e.g. guest-order.html?tenant=mgallery&room=101 or {tenant}.stayos.org/...).
 *
 * NOTE: Anonymous sign-in must be enabled in Firebase Console
 *       (Authentication → Sign-in method → Anonymous).
 */
(function () {
    'use strict';

    // ── Tenant + room from the QR link ─────────────────────────
    const TENANT = (typeof resolveTenant === 'function' ? resolveTenant() : 'mgallery');
    const params = new URLSearchParams(window.location.search);
    let ROOM = (params.get('room') || params.get('oda') || '').trim().slice(0, 40);

    const CART_KEY = `go_cart_${TENANT}_${ROOM || 'x'}`;
    const ORDER_KEY = `go_order_${TENANT}_${ROOM || 'x'}`;

    // Demo mode (?demo or ?demo=1): runs entirely client-side with a built-in
    // catalog + localStorage orders + a simulated live status flow, so the guest
    // experience can be tested anywhere (e.g. github.io) with NO Firebase deploy
    // and NO Anonymous Auth. Staff/admin sides still need the real backend.
    const DEMO = params.has('demo');
    let demoTimer = null;

    // Built-in catalog used in demo mode (mirrors the default admin menu).
    const DEMO_CATALOG = [
        { category: 'Temizlik', catIcon: '🧹', name: 'Oda Temizliği', icon: '🧹', department: 'Housekeeping', description: 'Odanızın temizlenmesini isteyin' },
        { category: 'Temizlik', name: 'Havlu Değişimi', icon: '🧺', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Çarşaf Değişimi', icon: '🛏️', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Çöp Toplama', icon: '🗑️', department: 'Housekeeping' },
        { category: 'Konfor', catIcon: '🛏️', name: 'Ekstra Yastık', icon: '🛏️', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Ekstra Battaniye', icon: '🧣', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Terlik', icon: '🥿', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Bornoz', icon: '🥼', department: 'Housekeeping' },
        { category: 'Yiyecek & İçecek', catIcon: '🍽️', name: 'Su', icon: '💧', department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Çay / Kahve', icon: '☕', department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Meyve Tabağı', icon: '🍎', department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Atıştırmalık', icon: '🍫', department: 'Food & Beverage' },
        { category: 'Teknik Servis', catIcon: '🔧', name: 'Klima Sorunu', icon: '❄️', department: 'Engineering' },
        { category: 'Teknik Servis', name: 'TV Sorunu', icon: '📺', department: 'Engineering' },
        { category: 'Teknik Servis', name: 'Sıcak Su Yok', icon: '🚿', department: 'Engineering' },
        { category: 'Teknik Servis', name: 'Wi-Fi Sorunu', icon: '📶', department: 'Engineering' },
        { category: 'Teknik Servis', name: 'Ampul Değişimi', icon: '💡', department: 'Engineering' },
        { category: 'Resepsiyon', catIcon: '🛎️', name: 'Geç Çıkış Talebi', icon: '🕐', department: 'Front Desk' },
        { category: 'Resepsiyon', name: 'Uyandırma Servisi', icon: '⏰', department: 'Front Desk' },
        { category: 'Resepsiyon', name: 'Taksi Çağır', icon: '🚕', department: 'Front Desk' }
    ].map((d, i) => Object.assign({ id: 'demo-' + i, active: true, sortOrder: (i + 1) * 10 }, d));

    // ── Status metadata ────────────────────────────────────────
    const STATUS = {
        pending:     { label: 'Bekliyor',       emoji: '⏳' },
        confirmed:   { label: 'Onaylandı',      emoji: '✅' },
        in_progress: { label: 'İşlemde',        emoji: '🛎️' },
        completed:   { label: 'Tamamlandı',     emoji: '🎉' },
        cancelled:   { label: 'İptal Edildi',   emoji: '✖️' }
    };
    const FLOW = ['pending', 'confirmed', 'in_progress', 'completed'];

    // ── State ──────────────────────────────────────────────────
    let catalog = [];          // [{id, name, category, icon, department, ...}]
    let cart = [];             // [{catalogId, name, category, icon, department, qty, note, preferredTime}]
    let activeCat = null;
    let sessionUid = null;
    let orderUnsub = null;
    let currentOrderId = null;

    // ── Tiny helpers ───────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const $ = id => document.getElementById(id);
    let toastTimer = null;
    function toast(msg, isError) {
        const t = $('goToast');
        t.textContent = msg;
        t.className = 'go-toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.className = 'go-toast'; }, 2600);
        if (isError) { try { navigator.vibrate && navigator.vibrate(80); } catch (e) {} }
    }
    // ── Cart persistence ───────────────────────────────────────
    function loadCart() {
        try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; }
        catch (e) { cart = []; }
        if (!Array.isArray(cart)) cart = [];
    }
    function saveCart() {
        try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {}
    }
    const cartCount = () => cart.reduce((n, l) => n + (l.qty || 0), 0);

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        $('goHotelName').textContent = prettyTenant(TENANT) + (DEMO ? ' · DEMO' : '');
        if (ROOM) {
            $('goRoomChip').style.display = 'inline-flex';
            $('goRoomLabel').textContent = 'Oda ' + ROOM;
        }
        loadCart();
        wireEvents();
        renderCartBar();

        // Demo mode: no backend, no auth — just run.
        if (DEMO) {
            sessionUid = 'demo';
            loadCatalog();
            resumeOrder();
            return;
        }

        // Anonymous sign-in → then load data (once).
        let started = false;
        auth.onAuthStateChanged(u => {
            if (u && !started) {
                started = true;
                sessionUid = u.uid;
                loadCatalog();
                resumeOrder();
            }
        });
        auth.signInAnonymously().catch(err => {
            console.error('Anon sign-in failed', err);
            $('goBody').innerHTML = stateHtml('⚠️', 'Bağlantı kurulamadı',
                'Anonim giriş kapalı olabilir. Test için bağlantıya ?demo=1 ekleyin.');
        });
    }

    function prettyTenant(t) {
        if (!t) return 'StayOS';
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    // ── Catalog ────────────────────────────────────────────────
    function loadCatalog() {
        if (DEMO) {
            catalog = DEMO_CATALOG.slice();
            renderCatalog();
            return;
        }
        db.collection('requestCatalog').where('tenantId', '==', TENANT).get()
            .then(snap => {
                catalog = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                    .filter(i => i.active !== false)
                    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
                        || (a.name || '').localeCompare(b.name || '', 'tr'));
                renderCatalog();
            })
            .catch(err => {
                console.error('catalog load failed', err);
                $('goBody').innerHTML = stateHtml('😕', 'Talepler yüklenemedi',
                    'Bir sorun oluştu. Sayfayı yenileyip tekrar deneyin.');
            });
    }

    // Categories preserve first-seen (sortOrder) order.
    function categories() {
        const seen = [];
        catalog.forEach(i => {
            const c = (i.category || 'Diğer').trim();
            if (!seen.includes(c)) seen.push(c);
        });
        return seen;
    }
    function catEmoji(cat) {
        const item = catalog.find(i => (i.category || '') === cat && i.catIcon);
        if (item) return item.catIcon;
        const map = { 'Temizlik': '🧹', 'Konfor': '🛏️', 'Yiyecek & İçecek': '🍽️',
            'Yiyecek-İçecek': '🍽️', 'Teknik Servis': '🔧', 'Resepsiyon': '🛎️' };
        return map[cat] || '📋';
    }

    function renderCatalog() {
        const cats = categories();
        if (!catalog.length) {
            $('goCats').innerHTML = '';
            $('goBody').innerHTML = stateHtml('🛎️', 'Henüz talep tanımlanmamış',
                'Bu otel için hizmet talepleri henüz hazır değil. Lütfen resepsiyon ile iletişime geçin.');
            return;
        }
        if (!activeCat || !cats.includes(activeCat)) activeCat = cats[0];

        // Category pills
        $('goCats').innerHTML = cats.map(c =>
            `<button class="go-cat ${c === activeCat ? 'active' : ''}" data-cat="${esc(c)}">
                <span class="go-cat-emoji">${esc(catEmoji(c))}</span>${esc(c)}
            </button>`).join('');

        // Product blocks
        $('goBody').innerHTML = cats.map(c => {
            const items = catalog.filter(i => (i.category || 'Diğer') === c);
            return `<div class="go-cat-block" id="cat-${cssId(c)}">
                <h2><span>${esc(catEmoji(c))}</span> ${esc(c)}</h2>
                <div class="go-grid">${items.map(cardHtml).join('')}</div>
            </div>`;
        }).join('');

        refreshStepControls();
        bindCatalogEvents();
    }

    function cardHtml(item) {
        return `<div class="go-card" data-id="${esc(item.id)}">
            <div class="go-emoji">${esc(item.icon || '🛎️')}</div>
            <div class="go-info">
                <div class="go-name">${esc(item.name)}</div>
                ${item.description ? `<div class="go-desc">${esc(item.description)}</div>` : ''}
            </div>
            <div class="go-card-action" data-action-for="${esc(item.id)}"></div>
        </div>`;
    }

    // Render either a "+" add button or a qty stepper depending on cart state.
    function refreshStepControls() {
        document.querySelectorAll('.go-card-action').forEach(slot => {
            const id = slot.dataset.actionFor;
            const line = cart.find(l => l.catalogId === id);
            if (line && line.qty > 0) {
                slot.innerHTML = `<div class="go-stepper">
                    <button data-dec="${esc(id)}">−</button>
                    <span class="go-qty">${line.qty}</span>
                    <button data-inc="${esc(id)}">+</button>
                </div>`;
            } else {
                slot.innerHTML = `<button class="go-add" data-add="${esc(id)}" aria-label="Ekle">+</button>`;
            }
        });
    }

    function bindCatalogEvents() {
        $('goBody').onclick = (e) => {
            const add = e.target.closest('[data-add]');
            const inc = e.target.closest('[data-inc]');
            const dec = e.target.closest('[data-dec]');
            if (add) return changeQty(add.dataset.add, +1);
            if (inc) return changeQty(inc.dataset.inc, +1);
            if (dec) return changeQty(dec.dataset.dec, -1);
        };
        $('goCats').onclick = (e) => {
            const pill = e.target.closest('.go-cat');
            if (!pill) return;
            activeCat = pill.dataset.cat;
            document.querySelectorAll('.go-cat').forEach(p => p.classList.toggle('active', p === pill));
            const block = $('cat-' + cssId(activeCat));
            if (block) block.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
    }
    function cssId(s) { return String(s).replace(/[^a-z0-9]/gi, '_'); }

    // ── Cart mutations ─────────────────────────────────────────
    function changeQty(catalogId, delta) {
        const item = catalog.find(i => i.id === catalogId);
        if (!item) return;
        let line = cart.find(l => l.catalogId === catalogId);
        if (!line && delta > 0) {
            line = { catalogId, name: item.name, category: item.category || 'Diğer',
                icon: item.icon || '🛎️', department: item.department || '',
                qty: 0, note: '', preferredTime: '' };
            cart.push(line);
        }
        if (!line) return;
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
        const bar = $('goCartBar');
        bar.classList.toggle('show', n > 0 && $('goTrackView').classList.contains('go-hidden'));
        $('goCbCount').textContent = n;
        $('goCbSub').textContent = cart.length + ' farklı talep';
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

    function renderCart() {
        const wrap = $('goCartList');
        if (!cart.length) {
            wrap.innerHTML = stateHtml('🛒', 'Sepetiniz boş', 'Listeden talep ekleyin.');
            $('goSubmit').disabled = true;
            return;
        }
        $('goSubmit').disabled = false;
        wrap.innerHTML = cart.map((l, i) => `
            <div class="go-line" data-i="${i}">
                <div class="go-line-top">
                    <div class="go-line-emoji">${esc(l.icon || '🛎️')}</div>
                    <div class="go-line-main">
                        <div class="go-line-name">${esc(l.name)}</div>
                        <div class="go-line-cat">${esc(l.category || '')}</div>
                    </div>
                    <button class="go-line-del" data-del="${i}" aria-label="Sil">🗑</button>
                </div>
                <div class="go-line-controls">
                    <div class="go-stepper">
                        <button data-cdec="${i}">−</button>
                        <span class="go-qty">${l.qty}</span>
                        <button data-cinc="${i}">+</button>
                    </div>
                </div>
                <div class="go-line-fields">
                    <div class="go-row2">
                        <div class="go-field">
                            <label>Tercih edilen saat</label>
                            <input type="time" data-time="${i}" value="${esc(l.preferredTime || '')}">
                        </div>
                    </div>
                    <div class="go-field">
                        <label>Not (opsiyonel)</label>
                        <input type="text" data-note="${i}" maxlength="160" placeholder="Örn. 2 büyük havlu" value="${esc(l.note || '')}">
                    </div>
                </div>
            </div>`).join('');

        wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
            cart.splice(+b.dataset.del, 1); saveCart(); refreshStepControls(); renderCartBar(); renderCart();
        });
        wrap.querySelectorAll('[data-cinc]').forEach(b => b.onclick = () => bumpLine(+b.dataset.cinc, +1));
        wrap.querySelectorAll('[data-cdec]').forEach(b => b.onclick = () => bumpLine(+b.dataset.cdec, -1));
        wrap.querySelectorAll('[data-note]').forEach(inp => inp.oninput = () => {
            const l = cart[+inp.dataset.note]; if (l) { l.note = inp.value; saveCart(); }
        });
        wrap.querySelectorAll('[data-time]').forEach(inp => inp.onchange = () => {
            const l = cart[+inp.dataset.time]; if (l) { l.preferredTime = inp.value; saveCart(); }
        });
    }
    function bumpLine(i, delta) {
        const l = cart[i]; if (!l) return;
        l.qty = Math.max(0, l.qty + delta);
        if (l.qty === 0) cart.splice(i, 1);
        saveCart(); refreshStepControls(); renderCartBar();
        if (!cart.length) { closeSheet(); return; }
        renderCart();
    }

    // ── Submit order ───────────────────────────────────────────
    function submitOrder() {
        if (!cart.length || !sessionUid) return;
        if (!ROOM) {
            const r = (prompt('Oda numaranızı girin:') || '').trim().slice(0, 40);
            if (!r) { toast('Oda numarası gerekli.', true); return; }
            ROOM = r;
            $('goRoomChip').style.display = 'inline-flex';
            $('goRoomLabel').textContent = 'Oda ' + ROOM;
        }
        const btn = $('goSubmit');
        btn.disabled = true;
        btn.innerHTML = 'Gönderiliyor...';

        const guestName = ($('goGuestName').value || '').trim().slice(0, 60);
        const items = cart.map((l, idx) => ({
            id: 'i' + idx + '_' + Date.now().toString(36),
            catalogId: l.catalogId || '',
            name: String(l.name || '').slice(0, 120),
            category: String(l.category || '').slice(0, 60),
            icon: String(l.icon || '🛎️').slice(0, 8),
            department: String(l.department || '').slice(0, 60),
            qty: Math.min(99, Math.max(1, l.qty || 1)),
            note: String(l.note || '').slice(0, 160),
            preferredTime: String(l.preferredTime || '').slice(0, 10),
            status: 'pending'
        }));

        // Demo: store locally and simulate the live status flow.
        if (DEMO) {
            const id = 'demo' + Date.now().toString(36);
            const order = { id, tenantId: TENANT, room: ROOM, guestName: guestName,
                sessionUid: 'demo', items: items, itemCount: items.length,
                createdAtMs: Date.now(), cancelled: false };
            saveDemoOrder(order);
            try { localStorage.setItem(ORDER_KEY, id); } catch (e) {}
            cart = []; saveCart();
            closeSheet();
            btn.disabled = false; btn.innerHTML = 'Sipariş Ver';
            $('goGuestName').value = '';
            toast('Talebiniz alındı! 🎉 (demo)');
            subscribeOrder(id);
            return;
        }

        const payload = {
            tenantId: TENANT,
            room: ROOM,
            guestName: guestName,
            sessionUid: sessionUid,
            status: 'pending',
            items: items,
            itemCount: items.length,
            statusLog: [{ status: 'pending', at: Date.now(), by: 'guest' }],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        db.collection('guestOrders').add(payload)
            .then(ref => {
                currentOrderId = ref.id;
                try { localStorage.setItem(ORDER_KEY, ref.id); } catch (e) {}
                cart = []; saveCart();
                closeSheet();
                btn.disabled = false;
                btn.innerHTML = 'Sipariş Ver';
                $('goGuestName').value = '';
                toast('Talebiniz alındı! 🎉');
                subscribeOrder(ref.id);
            })
            .catch(err => {
                console.error('order submit failed', err);
                btn.disabled = false;
                btn.innerHTML = 'Sipariş Ver';
                toast('Gönderilemedi. Tekrar deneyin.', true);
            });
    }

    // ── Order tracking ─────────────────────────────────────────
    function resumeOrder() {
        let saved = null;
        try { saved = localStorage.getItem(ORDER_KEY); } catch (e) {}
        if (saved) subscribeOrder(saved, true);
    }

    function subscribeOrder(orderId, silent) {
        if (orderUnsub) orderUnsub();
        if (DEMO) { subscribeDemo(orderId, silent); return; }
        currentOrderId = orderId;
        orderUnsub = db.collection('guestOrders').doc(orderId).onSnapshot(doc => {
            if (!doc.exists) { if (!silent) showCatalogView(); return; }
            const order = Object.assign({ id: doc.id }, doc.data());
            renderTracking(order);
            // Once finished, stop pinning the tracking view on next visit.
            if (order.status === 'completed' || order.status === 'cancelled') {
                try { localStorage.removeItem(ORDER_KEY); } catch (e) {}
            }
            showTrackingView();
        }, err => {
            console.error('track failed', err);
            if (!silent) showCatalogView();
        });
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

        const steps = cancelled ? '' : `<div class="go-steps">${FLOW.map((s, i) => {
            const cls = i < stepIdx ? 'done' : (i === stepIdx ? 'active' : 'todo');
            const logEntry = (order.statusLog || []).filter(l => l.status === s).pop();
            const time = logEntry ? timeFromMs(logEntry.at) : '';
            return `<div class="go-step ${cls}">
                <div class="go-step-dot">${i < stepIdx ? '✓' : (i + 1)}</div>
                <div class="go-step-body">
                    <div class="go-step-title">${esc(STATUS[s].label)}</div>
                    ${time ? `<div class="go-step-time">${esc(time)}</div>` : ''}
                </div>
            </div>`;
        }).join('')}</div>`;

        const items = (order.items || []).map(it => {
            const ist = STATUS[it.status] || STATUS.pending;
            const meta = [it.qty > 1 ? it.qty + ' adet' : '', it.preferredTime ? '🕐 ' + it.preferredTime : '', it.note]
                .filter(Boolean).join(' · ');
            return `<div class="go-titem">
                <div class="go-emoji">${esc(it.icon || '🛎️')}</div>
                <div class="go-info">
                    <div class="go-name">${esc(it.name)}</div>
                    ${meta ? `<div class="go-meta">${esc(meta)}</div>` : ''}
                </div>
                <span class="go-pill ${esc(it.status || 'pending')}">${esc(ist.label)}</span>
            </div>`;
        }).join('');

        const canCancel = order.status === 'pending';
        $('goTrackBody').innerHTML = `
            <div class="go-track-hero">
                <div class="go-track-emoji">${esc(st.emoji)}</div>
                <h2>${esc(st.label)}</h2>
                <p>${esc(heroSub)}</p>
            </div>
            ${steps}
            <div class="go-track-items">
                <h3>Talepleriniz (${(order.items || []).length})</h3>
                ${items}
            </div>
            <div class="go-track-actions">
                ${canCancel ? `<button class="go-btn-ghost go-btn-danger" id="goCancel">Talebi İptal Et</button>` : ''}
                <button class="go-btn-ghost" id="goNew">＋ Yeni Talep Oluştur</button>
            </div>`;

        const cancelBtn = $('goCancel');
        if (cancelBtn) cancelBtn.onclick = () => cancelOrder(order.id);
        $('goNew').onclick = () => { showCatalogView(); };
    }

    function timeFromMs(ms) {
        if (!ms) return '';
        try { return new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return ''; }
    }

    function cancelOrder(orderId) {
        if (!confirm('Talebinizi iptal etmek istediğinize emin misiniz?')) return;
        if (DEMO) {
            const o = loadDemoOrder(orderId);
            if (o) { o.cancelled = true; saveDemoOrder(o); renderTracking(demoView(o)); }
            if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
            try { localStorage.removeItem(ORDER_KEY); } catch (e) {}
            toast('Talep iptal edildi.');
            return;
        }
        db.collection('guestOrders').doc(orderId).update({
            status: 'cancelled',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then(() => toast('Talep iptal edildi.'))
          .catch(err => { console.error(err); toast('İptal edilemedi.', true); });
    }

    // ── Demo backend (localStorage + simulated status flow) ────
    // Status timeline after submit: 0s Bekliyor → 4s Onaylandı → 9s İşlemde → 15s Tamamlandı.
    const DEMO_STEPS = [[0, 'pending'], [4000, 'confirmed'], [9000, 'in_progress'], [15000, 'completed']];
    function saveDemoOrder(o) { try { localStorage.setItem('go_demo_' + o.id, JSON.stringify(o)); } catch (e) {} }
    function loadDemoOrder(id) {
        try { return JSON.parse(localStorage.getItem('go_demo_' + id)); } catch (e) { return null; }
    }
    // Build a tracking-ready view (status + per-item status + statusLog) from elapsed time.
    function demoView(o) {
        if (o.cancelled) {
            return Object.assign({}, o, { status: 'cancelled',
                items: (o.items || []).map(it => Object.assign({}, it, { status: 'cancelled' })) });
        }
        const e = Date.now() - (o.createdAtMs || Date.now());
        let status = 'pending';
        const log = [];
        DEMO_STEPS.forEach(([t, s]) => { if (e >= t) { status = s; log.push({ status: s, at: (o.createdAtMs || 0) + t, by: t === 0 ? 'guest' : 'Personel' }); } });
        return Object.assign({}, o, { status,
            items: (o.items || []).map(it => Object.assign({}, it, { status })),
            statusLog: log });
    }
    function subscribeDemo(orderId, silent) {
        if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
        currentOrderId = orderId;
        const tick = () => {
            const o = loadDemoOrder(orderId);
            if (!o) { if (!silent) showCatalogView(); if (demoTimer) clearInterval(demoTimer); return; }
            const view = demoView(o);
            renderTracking(view);
            showTrackingView();
            if (view.status === 'completed' || view.status === 'cancelled') {
                if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
                try { localStorage.removeItem(ORDER_KEY); } catch (e) {}
            }
        };
        tick();
        demoTimer = setInterval(tick, 1000);
    }

    // ── Misc UI ────────────────────────────────────────────────
    function stateHtml(emoji, title, body) {
        return `<div class="go-state">
            <div class="go-state-emoji">${esc(emoji)}</div>
            <h3>${esc(title)}</h3>
            <p>${esc(body)}</p>
        </div>`;
    }

    function wireEvents() {
        $('goCartBar').onclick = openSheet;
        $('goSheetClose').onclick = closeSheet;
        $('goBackdrop').onclick = closeSheet;
        $('goSubmit').onclick = submitOrder;
    }

    // ── Go ─────────────────────────────────────────────────────
    if (typeof db === 'undefined' || typeof auth === 'undefined') {
        document.getElementById('goBody').innerHTML =
            '<div class="go-state"><div class="go-state-emoji">⚠️</div><h3>Yapılandırma hatası</h3></div>';
        return;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
