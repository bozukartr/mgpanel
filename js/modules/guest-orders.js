/* Hotizy — Guest self-service orders, staff side.
 *
 * Drop-in: include AFTER firebase-config.js (and ideally concierge.js) on the
 * Concierge page. Self-contained — injects its own styles, a header button with
 * a live badge, and a right-hand drawer. No markup changes required.
 *
 *   <script src="guest-orders.js"></script>
 *
 * Incoming QR self-service orders (collection `guestOrders`) appear here grouped
 * by order. Staff confirm / progress / complete items one-by-one or in bulk, and
 * may assign an order to a teammate. When an order is confirmed, each item is
 * dropped into the room's history as its own `guestLog` (type 'request'), and
 * later status changes keep that log in sync.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof auth === 'undefined' || typeof firebase === 'undefined') return;

    const TENANT = (typeof TENANT_ID !== 'undefined' && TENANT_ID) || localStorage.getItem('hotelTenantId') || 'mgallery';
    const USERNAME = localStorage.getItem('hotelUsername') || 'Personel';
    const MY_DEPT = (localStorage.getItem('hotelDept') || '').trim();
    const MY_ROLE = (localStorage.getItem('hotelRole') || '').toLowerCase();
    // Yönetici/admin her departmanın talebini yönetebilir — panel.js'in
    // takeBlockReason/completeBlockReason kuralıyla AYNI muafiyet.
    function isManager() {
        return MY_ROLE === 'admin' || MY_ROLE === 'manager' || USERNAME.toLowerCase() === 'admin';
    }

    // Order status flow + labels (mirrors the guest page).
    const FLOW = ['pending', 'confirmed', 'in_progress', 'completed'];
    const LABEL = { pending: 'Bekliyor', confirmed: 'Onaylandı', in_progress: 'İşlemde', completed: 'Tamamlandı', cancelled: 'İptal' };
    // Map an item status to the guestLog status used by Misafir Kayıtları.
    const LOG_STATUS = { confirmed: 'Following', in_progress: 'InProgress', completed: 'Solved' };
    // Kategori → departman yedeği. Kanonik değerler TÜRKÇE (otel personelinin
    // gerçek departman adları) — functions/order-bridge.js:DEPT_BY_CAT ile aynı
    // sözlük. Eskiden burada İngilizce ('Housekeeping'/'Engineering'/'Front
    // Desk') duruyordu; sameDept eşanlamlıları kapsasa da guestLogs kaydına
    // yazılan departman adı otelin kendi listesiyle uyuşmuyordu.
    // Anahtarlar tablodan TÜRETİLİR — elle küçük harfle yazılmaz. 'İ'nin
    // Unicode varsayılan küçük harfi 'i'+U+0307 iken toLocaleLowerCase('tr-TR')
    // düz 'i' üretir; elle yazılan anahtar sessizce hiç eşleşmez.
    // functions/order-bridge.js:CAT_TO_DEPT ile aynı sözlük.
    const CAT_TO_DEPT = [
        ['Kat Hizmetleri', ['Temizlik', 'Konfor', 'Kat Hizmetleri']],
        ['Yiyecek & İçecek', ['Yiyecek & İçecek', 'Yiyecek-İçecek', 'Oda Servisi', 'Mutfak']],
        ['Teknik', ['Teknik', 'Teknik Servis']],
        ['Ön Büro', ['Resepsiyon', 'Ön Büro', 'Front Office', 'Front Desk']]
    ];
    const DEPT_BY_CAT = (function () {
        const m = {};
        CAT_TO_DEPT.forEach(p => p[1].forEach(c => { m[String(c).trim().toLocaleLowerCase('tr-TR')] = p[0]; }));
        return m;
    })();
    function deptByCat(cat) {
        return DEPT_BY_CAT[String(cat == null ? '' : cat).trim().toLocaleLowerCase('tr-TR')] || '';
    }
    // Kalemin sorumlu departmanı: siparişte taşınan değer, yoksa kategoriden.
    function itemDept(it) { return String((it && it.department) || '').trim() || deptByCat(it && it.category); }

    // ── Departman yetkisi ──────────────────────────────────────
    // OPERASYONEL HATA: bu çekmece departman kuralını HİÇ uygulamıyordu —
    // Teknik personeli Kat Hizmetleri'ne düşen bir QR talebini onaylayıp
    // tamamlayabiliyordu (panel.js aynı kaydı `guestLogs` üzerinden katı
    // biçimde kısıtlarken). Kural panel.js:takeBlockReason ile birebir aynı:
    // yönetici/admin serbest; departmanı BOŞ olan kalemi herkes üstlenebilir
    // (yanlış departmana kilitlemektense sahipsiz bırakmak güvenli);
    // aksi halde yalnızca o departmanın personeli.
    // sameDept (js/core/firebase-config.js) eşanlamlıları da çözer
    // ("Kat Hizmetleri" ↔ "Housekeeping" gibi geçiş dönemi verisi).
    function itemBlockReason(it) {
        if (isManager()) return null;
        const dept = itemDept(it);
        if (!dept) return null;
        const same = (typeof sameDept === 'function') ? sameDept(MY_DEPT, dept) : (MY_DEPT === dept);
        if (MY_DEPT && same) return null;
        return '"' + dept + '" departmanına ait — yalnızca o departman personeli veya yönetici işleyebilir.';
    }
    function canActOnItem(it) { return itemBlockReason(it) == null; }
    // Toplu işlem yalnızca personelin YETKİLİ OLDUĞU kalemlere dokunur.
    function actionableItems(o) {
        return (o.items || []).filter(it => !it.resId && it.status !== 'cancelled' && canActOnItem(it));
    }
    function blockedItems(o) {
        return (o.items || []).filter(it => !it.resId && it.status !== 'cancelled' && !canActOnItem(it));
    }

    let orders = [];
    let firstLoad = true;
    let activeUsers = [];
    let drawerOpen = false;
    let directory = {};   // room -> current in-house guest name (from CRM/PMS)
    let pendingFocus = null;   // order id to focus once data loads (?order= deep-link)

    // The order's guest name comes from the in-house guest for that room
    // (guestDirectory), not from anything the guest typed.
    function guestNameForRoom(room, fallback) {
        const r = String(room == null ? '' : room).trim();
        return directory[r] || (fallback && String(fallback).trim()) || ('Oda ' + (r || '—'));
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function timeAgo(ms) {
        if (!ms) return '';
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'az önce';
        const m = Math.floor(s / 60); if (m < 60) return m + ' dk önce';
        const h = Math.floor(m / 60); if (h < 24) return h + ' sa önce';
        return Math.floor(h / 24) + ' g önce';
    }
    const ms = ts => (ts && ts.toMillis ? ts.toMillis() : 0);
    function hhmm() { return new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }
    function today() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // Order status = the least-advanced status among its non-cancelled items.
    function deriveStatus(items) {
        const live = (items || []).filter(i => i.status !== 'cancelled');
        if (!live.length) return 'cancelled';
        let min = FLOW.length - 1;
        live.forEach(i => { const idx = FLOW.indexOf(i.status); if (idx >= 0 && idx < min) min = idx; });
        return FLOW[min];
    }

    // ── Styles ─────────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('go-staff-styles')) return;
        const css = `
        .gos-btn { position: relative; width: 38px; height: 38px; border-radius: 10px; background: #f1f5f9;
            border: none; cursor: pointer; color: #475569; display: inline-flex; align-items: center;
            justify-content: center; transition: background .2s; }
        .gos-btn:hover { background: #e2e8f0; color: #1e293b; }
        .gos-badge { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px;
            background: #f59e0b; color: #fff; border-radius: 9px; font-size: 10px; font-weight: 800;
            display: none; align-items: center; justify-content: center; line-height: 1; font-family: 'Outfit', sans-serif; }
        .gos-badge.show { display: inline-flex; }
        .gos-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.45); opacity: 0; pointer-events: none;
            transition: opacity .25s; z-index: 5000; }
        .gos-backdrop.show { opacity: 1; pointer-events: auto; }
        .gos-drawer { position: fixed; top: 0; right: 0; height: 100%; width: 420px; max-width: 94vw; background: #f4f7f9;
            box-shadow: -18px 0 50px rgba(15,23,42,.18); z-index: 5001; transform: translateX(100%);
            transition: transform .32s cubic-bezier(.2,1,.3,1); display: flex; flex-direction: column; font-family: 'Outfit', sans-serif; }
        .gos-drawer.show { transform: translateX(0); }
        .gos-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 18px 14px;
            background: #fff; border-bottom: 1px solid #e8edf2; flex-shrink: 0; }
        .gos-head h2 { font-size: 17px; font-weight: 800; margin: 0; color: #1e293b; }
        .gos-head p { font-size: 12.5px; color: #64748b; margin: 2px 0 0; }
        .gos-close { width: 34px; height: 34px; border-radius: 50%; background: #eef2f7; border: none; cursor: pointer;
            color: #475569; font-size: 16px; }
        .gos-filters { display: flex; gap: 7px; padding: 12px 16px 6px; flex-shrink: 0; overflow-x: auto; }
        .gos-fchip { flex: 0 0 auto; background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 999px;
            padding: 6px 13px; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .gos-fchip.active { background: #1e293b; color: #fff; border-color: #1e293b; }
        .gos-list { flex: 1; overflow-y: auto; padding: 8px 16px 24px; }
        .gos-empty { text-align: center; color: #94a3b8; padding: 60px 20px; font-size: 14px; }
        .gos-empty .e { font-size: 40px; display: block; margin-bottom: 10px; }
        /* Compact, clickable summary row */
        .gos-card { background: #fff; border: 1px solid #e8edf2; border-radius: 14px; margin-bottom: 9px;
            box-shadow: 0 2px 8px rgba(15,23,42,.04); display: flex; align-items: center; gap: 11px;
            padding: 10px 12px; cursor: pointer; transition: transform .12s, box-shadow .2s, border-color .2s; }
        .gos-card:hover { box-shadow: 0 8px 22px rgba(15,23,42,.10); transform: translateY(-1px); border-color: #dbe3ec; }
        .gos-card:active { transform: translateY(0); }
        .gos-chev { color: #cbd5e1; font-size: 19px; font-weight: 700; flex-shrink: 0; line-height: 1; }
        .gos-card.gos-new { animation: gosPop .4s ease; border-color: #fcd34d; }
        @keyframes gosPop { 0% { transform: scale(.96); box-shadow: 0 0 0 4px #fef3c7; } 100% { transform: scale(1); } }
        .gos-card.gos-flash { animation: gosFlash 1.5s ease; }
        @keyframes gosFlash { 0%,100% { box-shadow: 0 4px 16px rgba(15,23,42,.05); } 30% { box-shadow: 0 0 0 3px #fcd34d, 0 4px 16px rgba(15,23,42,.05); } }
        .gos-card-top { display: flex; align-items: flex-start; gap: 11px; padding: 14px 14px 10px; }
        .gos-room { width: 46px; height: 46px; border-radius: 12px; background: #eef2ff; color: #4f46e5; flex-shrink: 0;
            display: flex; flex-direction: column; align-items: center; justify-content: center; font-weight: 800; line-height: 1; }
        .gos-room small { font-size: 8px; font-weight: 700; opacity: .7; letter-spacing: .5px; }
        .gos-room b { font-size: 15px; }
        .gos-meta { flex: 1; min-width: 0; }
        .gos-meta .gos-guest { font-size: 14.5px; font-weight: 700; color: #1e293b; }
        .gos-meta .gos-sub { font-size: 12px; color: #94a3b8; margin-top: 1px; }
        .gos-ostat { font-size: 11px; font-weight: 800; padding: 5px 10px; border-radius: 999px; white-space: nowrap; }
        .gos-ostat.pending { background: #fff7ed; color: #c2680c; }
        .gos-ostat.confirmed { background: #eff6ff; color: #2563eb; }
        .gos-ostat.in_progress { background: #fefce8; color: #a16207; }
        .gos-ostat.completed { background: #f0fdf4; color: #16a34a; }
        .gos-ostat.cancelled { background: #fef2f2; color: #dc2626; }
        .gos-items { padding: 0 14px; }
        .gos-item { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid #f1f5f9; }
        .gos-item .gos-ico { width: 34px; height: 34px; border-radius: 9px; background: #f4f7f9; display: flex;
            align-items: center; justify-content: center; font-size: 17px; flex-shrink: 0; }
        .gos-item .gos-ibody { flex: 1; min-width: 0; }
        .gos-item .gos-iname { font-size: 13.5px; font-weight: 600; color: #1e293b; }
        .gos-item .gos-imeta { font-size: 11.5px; color: #94a3b8; }
        /* Concierge kalemi: bu çekmece onu YÖNETMEZ, yalnızca gösterir ve
           asıl kaydına (Concierge paneli) yönlendirir. */
        .gos-item.gos-item-res { background: #f8fafc; border-left: 3px solid #6366f1; }
        .gos-item .gos-resbadge { display: inline-block; margin-left: 5px; padding: 1px 6px; border-radius: 5px;
            background: #eef2ff; color: #4f46e5; font-size: 9px; font-weight: 800; vertical-align: middle; }
        .gos-item .gos-reshint { color: #6366f1; font-style: italic; }
        /* Başka departmanın kalemi: görünür ama işlenemez. */
        .gos-item.gos-item-locked { background: #fcfcfd; }
        .gos-item .gos-deptbadge { display: inline-block; margin-left: 5px; padding: 1px 6px; border-radius: 5px;
            background: #f1f5f9; color: #64748b; font-size: 9px; font-weight: 800; vertical-align: middle; }
        .gos-item .gos-blockhint { color: #b45309; }
        .gos-scopehint { flex: 1 0 100%; margin-top: 6px; font-size: 11.5px; line-height: 1.45; color: #b45309; }
        .gos-act[disabled] { opacity: .45; cursor: not-allowed; }
        .gos-item .gos-istat { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 999px; }
        .gos-item .gos-istat.pending { background: #fff7ed; color: #c2680c; }
        .gos-item .gos-istat.confirmed { background: #eff6ff; color: #2563eb; }
        .gos-item .gos-istat.in_progress { background: #fefce8; color: #a16207; }
        .gos-item .gos-istat.completed { background: #f0fdf4; color: #16a34a; }
        .gos-iadv { width: 28px; height: 28px; border-radius: 8px; border: 1px solid #e2e8f0; background: #fff;
            color: #4f46e5; cursor: pointer; font-size: 15px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .gos-iadv:disabled { opacity: .35; cursor: default; }
        .gos-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 14px 14px; border-top: 1px solid #f1f5f9; }
        .gos-act { flex: 1; min-width: 92px; border: none; border-radius: 10px; padding: 10px; font-size: 13px;
            font-weight: 700; cursor: pointer; font-family: inherit; }
        .gos-act.primary { background: #6366f1; color: #fff; }
        .gos-act.ok { background: #16a34a; color: #fff; }
        .gos-act.step { background: #eef2ff; color: #4f46e5; }
        .gos-act.ghost { background: #f1f5f9; color: #64748b; flex: 0 0 auto; min-width: 0; padding: 10px 12px; }
        .gos-assign { display: flex; align-items: center; gap: 8px; padding: 0 14px 12px; }
        .gos-assign select { flex: 1; border: 1px solid #e2e8f0; border-radius: 9px; padding: 8px 10px; font-size: 12.5px;
            font-family: inherit; color: #1e293b; background: #fbfcfe; }
        .gos-assigned { font-size: 11.5px; color: #16a34a; font-weight: 700; padding: 0 14px 10px; }
        /* Compact room badge inside the summary row */
        .gos-card > .gos-room { width: 42px; height: 42px; }
        .gos-card > .gos-meta { flex: 1; min-width: 0; }
        /* Order detail modal */
        .gos-mback { position: fixed; inset: 0; background: rgba(15,23,42,.5); z-index: 5010; display: flex;
            align-items: center; justify-content: center; padding: 18px; opacity: 0; pointer-events: none; transition: opacity .18s; }
        .gos-mback.show { opacity: 1; pointer-events: auto; }
        .gos-modal { background: #fff; border-radius: 18px; width: 440px; max-width: 100%; max-height: 88vh; overflow-y: auto;
            box-shadow: 0 30px 80px rgba(15,23,42,.35); transform: translateY(10px); transition: transform .18s; }
        .gos-mback.show .gos-modal { transform: none; }
        .gos-mhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 15px 15px 4px; }
        .gos-mhead .gos-mtitle { font-size: 13px; font-weight: 700; color: #94a3b8; }
        .gos-mclose { background: #f1f5f9; border: none; width: 32px; height: 32px; border-radius: 9px; cursor: pointer;
            font-size: 14px; color: #64748b; flex-shrink: 0; }
        @media (max-width: 600px) { .gos-drawer { width: 100%; } }`;
        const el = document.createElement('style');
        el.id = 'go-staff-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // ── Button + drawer scaffold ───────────────────────────────
    let badgeEl, listEl, filterState = 'active';
    function buildUI() {
        injectStyles();
        // Place the trigger button next to the notification bell if present.
        const host = document.getElementById('rt-bell');
        const btn = document.createElement('button');
        btn.className = 'gos-btn';
        btn.id = 'gos-trigger';
        btn.title = 'Misafir Talepleri';
        btn.innerHTML = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg><span class="gos-badge" id="gos-badge">0</span>`;
        if (host && host.parentNode) host.parentNode.insertBefore(btn, host);
        else document.body.appendChild(btn);
        badgeEl = btn.querySelector('#gos-badge');
        btn.addEventListener('click', openDrawer);

        const backdrop = document.createElement('div');
        backdrop.className = 'gos-backdrop';
        backdrop.id = 'gos-backdrop';
        backdrop.addEventListener('click', closeDrawer);
        document.body.appendChild(backdrop);

        const drawer = document.createElement('aside');
        drawer.className = 'gos-drawer';
        drawer.id = 'gos-drawer';
        drawer.innerHTML = `
            <div class="gos-head">
                <div><h2>Misafir Talepleri</h2><p>QR self-servis siparişleri</p></div>
                <button class="gos-close" id="gos-close">✕</button>
            </div>
            <div class="gos-filters">
                <button class="gos-fchip active" data-f="active">Aktif</button>
                <button class="gos-fchip" data-f="pending">Bekleyen</button>
                <button class="gos-fchip" data-f="all">Tümü</button>
            </div>
            <div class="gos-list" id="gos-list"></div>`;
        document.body.appendChild(drawer);
        listEl = drawer.querySelector('#gos-list');
        drawer.querySelector('#gos-close').addEventListener('click', closeDrawer);
        drawer.querySelectorAll('.gos-fchip').forEach(c => c.addEventListener('click', () => {
            filterState = c.dataset.f;
            drawer.querySelectorAll('.gos-fchip').forEach(x => x.classList.toggle('active', x === c));
            render();
        }));

        // Order detail modal (opened by tapping a compact card).
        const mback = document.createElement('div');
        mback.className = 'gos-mback';
        mback.id = 'gos-mback';
        mback.innerHTML = `<div class="gos-modal" id="gos-modal"></div>`;
        mback.addEventListener('click', e => { if (e.target === mback) closeOrderModal(); });
        document.body.appendChild(mback);
    }

    let currentModalId = null;
    function openOrderModal(id) {
        const o = findOrder(id); if (!o) return;
        currentModalId = id;
        document.getElementById('gos-modal').innerHTML = orderDetailHtml(o);
        document.getElementById('gos-mback').classList.add('show');
        bindOrderActions(document.getElementById('gos-modal'));
        document.getElementById('gos-mclose').addEventListener('click', closeOrderModal);
    }
    function closeOrderModal() {
        currentModalId = null;
        const m = document.getElementById('gos-mback');
        if (m) m.classList.remove('show');
    }
    function refreshModal() {
        if (!currentModalId) return;
        const o = findOrder(currentModalId);
        if (!o) { closeOrderModal(); return; }
        document.getElementById('gos-modal').innerHTML = orderDetailHtml(o);
        bindOrderActions(document.getElementById('gos-modal'));
        document.getElementById('gos-mclose').addEventListener('click', closeOrderModal);
    }

    function openDrawer() {
        drawerOpen = true;
        document.getElementById('gos-backdrop').classList.add('show');
        document.getElementById('gos-drawer').classList.add('show');
        refreshActiveUsers();
        render();
    }
    function closeDrawer() {
        drawerOpen = false;
        closeOrderModal();
        document.getElementById('gos-backdrop').classList.remove('show');
        document.getElementById('gos-drawer').classList.remove('show');
    }

    function refreshActiveUsers() {
        if (window.RT && RT.getActiveUsers) {
            RT.getActiveUsers(false).then(list => { activeUsers = list || []; if (drawerOpen) render(); }).catch(() => {});
        }
    }

    // ── Render ─────────────────────────────────────────────────
    function renderBadge() {
        const pending = orders.filter(o => o.status === 'pending').length;
        // Panelin mobil ana menüsündeki "QR Talepleri" kartı da aynı sayıyı gösterir
        // (panel.html:#mhCountQr). Yoksa (masaüstü/başka sayfa) sessizce atlanır.
        const card = document.getElementById('mhCountQr');
        if (card) {
            card.textContent = pending > 9 ? '9+' : pending;
            card.style.display = pending > 0 ? '' : 'none';
        }
        if (!badgeEl) return;
        badgeEl.textContent = pending > 9 ? '9+' : pending;
        badgeEl.classList.toggle('show', pending > 0);
    }

    function visibleOrders() {
        if (filterState === 'pending') return orders.filter(o => o.status === 'pending');
        if (filterState === 'active') return orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled');
        return orders;
    }

    function render() {
        if (currentModalId) refreshModal();   // keep an open detail modal in sync
        if (!listEl) return;
        const list = visibleOrders();
        if (!list.length) {
            listEl.innerHTML = `<div class="gos-empty"><span class="e">🛎️</span>Gösterilecek talep yok.</div>`;
            return;
        }
        listEl.innerHTML = list.map(cardHtml).join('');
        bindCardEvents();
    }

    // Compact, clickable summary row → opens the detail modal.
    function cardHtml(o) {
        const created = ms(o.createdAt);
        const cls = ['gos-card', o.status];
        return `<div class="${cls.join(' ')}" data-open="${esc(o.id)}">
            <div class="gos-room"><small>ODA</small><b>${esc(o.room || '—')}</b></div>
            <div class="gos-meta">
                <div class="gos-guest">${esc(guestNameForRoom(o.room, o.guestName))}</div>
                <div class="gos-sub">${(o.items || []).length} kalem · ${esc(timeAgo(created))}</div>
            </div>
            <span class="gos-ostat ${o.status}">${esc(LABEL[o.status] || o.status)}</span>
            <span class="gos-chev">›</span>
        </div>`;
    }

    // Full order detail (rendered inside the modal).
    function orderDetailHtml(o) {
        const created = ms(o.createdAt);
        const items = (o.items || []).map((it, idx) => {
            const sIdx = FLOW.indexOf(it.status);
            // CONCIERGE KALEMİ (resId): bu çekmece onu YÖNETMEZ. Kaydın tek
            // sahibi Concierge panelindeki `reservations` dokümanıdır.
            // Eskiden bu ayrım YOKTU ve buradan ilerletilen bir Concierge
            // kalemi, logId'si olmadığı için commit()'te YENİ bir guestLogs
            // kaydı yaratıyordu: transfer aynı anda hem Concierge ajandasında
            // "Bekliyor" hem oda kayıtlarında ayrı bir talep olarak duruyordu.
            // Toplu "Tamamla"/"İptal" ise siparişi kapatıp rezervasyonu canlı
            // bırakıyordu (bkz. QR↔Concierge operasyon denetimi).
            const isRes = !!it.resId;
            // İptal edilmiş sipariş terminaldir: misafir iptal etmişse personel
            // bir öğeyi ilerletip siparişi yeniden "onaylandı"ya çeviremez.
            // Departman kuralı: kalemi yalnızca sorumlu departmanın personeli
            // (veya yönetici) ilerletebilir. Buton gizlenmez, DEVRE DIŞI +
            // nedeni açıklanmış gösterilir — panel.js'in aynı deseni.
            const block = isRes ? null : itemBlockReason(it);
            const canAdv = !isRes && !block && o.status !== 'cancelled' && it.status !== 'cancelled' && sIdx >= 0 && sIdx < FLOW.length - 1;
            const dept = isRes ? '' : itemDept(it);
            const meta = [it.option || '', it.qty > 1 ? it.qty + ' adet' : '', it.preferredTime ? '🕐 ' + it.preferredTime : '', it.note]
                .filter(Boolean).join(' · ');
            return `<div class="gos-item${isRes ? ' gos-item-res' : ''}${block ? ' gos-item-locked' : ''}">
                <div class="gos-ico">${esc(it.icon || '🛎️')}</div>
                <div class="gos-ibody">
                    <div class="gos-iname">${esc(it.name)}${isRes ? ' <span class="gos-resbadge">CONCIERGE</span>' : ''}${dept ? ` <span class="gos-deptbadge">${esc(dept)}</span>` : ''}</div>
                    ${meta ? `<div class="gos-imeta">${esc(meta)}</div>` : ''}
                    ${isRes ? '<div class="gos-imeta gos-reshint">Bu kayıt Concierge panelinden yönetilir.</div>' : ''}
                    ${block ? `<div class="gos-imeta gos-blockhint">🔒 ${esc(block)}</div>` : ''}
                </div>
                <span class="gos-istat ${esc(it.status)}">${esc(LABEL[it.status] || it.status)}</span>
                ${isRes
                    ? `<button class="gos-iadv" data-res-open="${esc(it.resId)}" title="Concierge panelinde aç">↗</button>`
                    : `<button class="gos-iadv" data-adv="${esc(o.id)}|${esc(it.id)}" title="${esc(block || 'Bir adım ilerlet')}" ${canAdv ? '' : 'disabled'}>›</button>`}
            </div>`;
        }).join('');

        const usersOpts = activeUsers.map(u => `<option value="${esc(u.uid)}|${esc(u.username)}">${esc(u.username)}${u.dept ? ' · ' + esc(u.dept) : ''}</option>`).join('');

        // Toplu işlemler yalnızca personelin YETKİLİ olduğu kalemlere dokunur.
        // Hiç yetkili kalem yoksa buton devre dışı; bir kısmı yetkiliyse
        // işlemin kapsamı açıkça yazılır (sessizce kısmi işlem yapmak
        // personeli "tamamladım" sanısına düşürürdü).
        const mine = actionableItems(o), locked = blockedItems(o);
        const noneMine = mine.length === 0;
        const dis = noneMine ? ' disabled title="Bu talebin kalemleri sizin departmanınıza ait değil."' : '';
        let actions = '';
        if (o.status === 'pending') {
            actions = `<button class="gos-act primary" data-bulk="${esc(o.id)}|confirmed"${dis}>✓ Onayla</button>
                       <button class="gos-act ghost" data-cancel="${esc(o.id)}"${locked.length ? ' disabled title="Başka departmanın kalemleri var — iptali yalnızca yönetici yapabilir."' : ''}>İptal</button>`;
        } else if (o.status === 'confirmed') {
            actions = `<button class="gos-act step" data-bulk="${esc(o.id)}|in_progress"${dis}>İşleme Al</button>
                       <button class="gos-act ok" data-bulk="${esc(o.id)}|completed"${dis}>Tamamla</button>`;
        } else if (o.status === 'in_progress') {
            actions = `<button class="gos-act ok" data-bulk="${esc(o.id)}|completed"${dis}>✓ Tümünü Tamamla</button>`;
        }
        if (actions && locked.length && !noneMine) {
            actions += `<div class="gos-scopehint">Yalnızca departmanınıza ait ${mine.length} kalem işlenecek; ${locked.length} kalem diğer departmanlarda kalacak.</div>`;
        }

        return `<div class="gos-mhead"><span class="gos-mtitle">Talep Detayı</span><button class="gos-mclose" id="gos-mclose">✕</button></div>
            <div class="gos-card-top">
                <div class="gos-room"><small>ODA</small><b>${esc(o.room || '—')}</b></div>
                <div class="gos-meta">
                    <div class="gos-guest">${esc(guestNameForRoom(o.room, o.guestName))}</div>
                    <div class="gos-sub">${(o.items || []).length} kalem · ${esc(timeAgo(created))}</div>
                </div>
                <span class="gos-ostat ${o.status}">${esc(LABEL[o.status] || o.status)}</span>
            </div>
            <div class="gos-items">${items}</div>
            ${o.assignedToName ? `<div class="gos-assigned">👤 Atanan: ${esc(o.assignedToName)}</div>` : ''}
            ${(o.status !== 'completed' && o.status !== 'cancelled' && usersOpts) ? `<div class="gos-assign">
                <select data-assignsel="${esc(o.id)}"><option value="">Personele ata...</option>${usersOpts}</select>
                <button class="gos-act ghost" data-assign="${esc(o.id)}">Ata</button>
            </div>` : ''}
            ${actions ? `<div class="gos-actions">${actions}</div>` : ''}`;
    }

    // List cards are now just summaries → tapping one opens the detail modal.
    function bindCardEvents() {
        listEl.querySelectorAll('[data-open]').forEach(c => c.addEventListener('click', () => openOrderModal(c.dataset.open)));
    }

    // Order actions live inside the detail modal.
    function bindOrderActions(root) {
        if (!root) return;
        root.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => {
            const [id, status] = b.dataset.bulk.split('|');
            bulkSet(id, status);
        });
        root.querySelectorAll('[data-adv]').forEach(b => b.onclick = () => {
            const [id, itemId] = b.dataset.adv.split('|');
            advanceItem(id, itemId);
        });
        root.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => {
            const id = b.dataset.cancel;
            // Personel iptal ediyorsa (onaylamıyorsa) neden zorunlu; misafire gösterilir.
            const raw = prompt('Talebi iptal etme nedeni (misafire gösterilecektir):');
            if (raw === null) return;            // vazgeçildi
            const reason = raw.trim();
            if (!reason) { alert('İptal nedeni belirtmelisiniz.'); return; }
            bulkSet(id, 'cancelled', {
                cancelReason: reason.slice(0, 300),
                cancelledBy: USERNAME,
                cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });
        root.querySelectorAll('[data-assign]').forEach(b => b.onclick = () => {
            const id = b.dataset.assign;
            const sel = root.querySelector(`[data-assignsel="${CSS.escape(id)}"]`);
            if (sel && sel.value) { const [uid, uname] = sel.value.split('|'); assignOrder(id, uid, uname); }
        });
        // Concierge kalemi → asıl kaydına götür. Bu çekmece concierge.html'de
        // de yükleniyor; oradaysak doğrudan detay sayfasını açarız, panel.html
        // gibi başka bir sayfadaysak Concierge rotasına yönlendiririz.
        root.querySelectorAll('[data-res-open]').forEach(b => b.onclick = () => {
            const rid = b.dataset.resOpen;
            if (typeof window.openDetailById === 'function') { window.openDetailById(rid); return; }
            try {
                const target = 'app#concierge?res=' + encodeURIComponent(rid);
                if (window.top && window.top !== window) window.top.location.href = target;
                else location.href = target;
            } catch (e) { location.href = 'concierge'; }
        });
    }

    // ── Mutations ──────────────────────────────────────────────
    function findOrder(id) { return orders.find(o => o.id === id); }

    // Set every live item of an order to a target status (bulk action).
    // `extra` opsiyonel olarak sipariş dokümanına ek alanlar yazar (ör. iptal nedeni).
    function bulkSet(orderId, status, extra) {
        if (!findOrder(orderId)) return; // hızlı UX kontrolü — asıl doğrulama transaction içinde
        commit(orderId, (freshOrder) => {
            // İptal terminaldir: zaten iptal edilmiş bir siparişi başka bir duruma çekme.
            if (freshOrder.status === 'cancelled' && status !== 'cancelled') return null;
            const items = (freshOrder.items || []).map(it => {
                // Concierge kalemi (resId): toplu işlem ona DOKUNMAZ. Aksi
                // halde sipariş "tamamlandı"/"iptal" damgalanırken bağlı
                // rezervasyon Concierge panelinde canlı kalıyordu — misafir
                // talebin kapandığını görürken personel hâlâ bekleyen bir
                // transfer görüyordu (denetimde tespit edilen çelişki).
                // Bu kalemler yalnızca Concierge panelinden yönetilir.
                if (it.resId) return it;
                // Departman kuralı YAZIM ANINDA da uygulanır (yalnızca butonu
                // devre dışı bırakmak yetmez — panel.js:transitionRecordImpl
                // ile aynı "arayüzde engelle + yazımdan önce tekrar doğrula"
                // deseni). Başka departmanın kalemi olduğu gibi bırakılır.
                if (!canActOnItem(it)) return it;
                if (status === 'cancelled') return Object.assign({}, it, { status: 'cancelled' });
                if (it.status === 'cancelled') return it;
                return Object.assign({}, it, { status });
            });
            return { items, extra };
        });
    }

    // Advance a single item by one step.
    function advanceItem(orderId, itemId) {
        if (!findOrder(orderId)) return;
        let blocked = null;
        commit(orderId, (freshOrder) => {
            // İptal edilmiş sipariş terminaldir — ilerletme siparişi yeniden açmamalı.
            if (freshOrder.status === 'cancelled') return null;
            const items = (freshOrder.items || []).map(it => {
                if (it.id !== itemId || it.status === 'cancelled') return it;
                // Departman kuralı yazımdan hemen önce TAZE veriyle tekrar
                // doğrulanır (buton devre dışıydı ama sipariş bu arada başka
                // bir departmana atanmış olabilir).
                if (!canActOnItem(it)) { blocked = itemBlockReason(it); return it; }
                const idx = FLOW.indexOf(it.status);
                if (idx < 0 || idx >= FLOW.length - 1) return it;
                return Object.assign({}, it, { status: FLOW[idx + 1] });
            });
            if (blocked) return null;
            return { items };
        }, () => { if (blocked) alert(blocked); });
    }

    // Persist new item statuses: writes/updates a guestLog per item so each lands
    // in the room's history, recomputes the order status, and appends a log entry.
    //
    // GÜVENLİK/OPERASYONEL DÜZELTMESİ: eskiden bulkSet/advanceItem yeni items[]
    // dizisini yerel (onSnapshot) önbellekteki `order`den hesaplayıp düz bir
    // db.batch() ile yazıyordu — transaction OLMADAN. Mutfak (restaurant.js:
    // qrSyncOrderItem) veya misafirin kendi iptali (Cloud Functions:
    // cancelGuestOrderItem) TAM O ANDA araya girip aynı items[] dizisini
    // güncellerse, bu batch yazımı o değişikliği SESSİZCE ezebiliyordu
    // (kaybolan güncelleme — bkz. operasyonel denetim). `mutate(freshOrder)`
    // artık transaction İÇİNDE tx.get() ile okunan TAZE sunucu verisine
    // uygulanır; panel.js:syncOrderItem ve functions/index.js'teki diğer tüm
    // guestOrders.items yazımlarıyla AYNI transaction deseni.
    // `after` opsiyonel: transaction tamamlandıktan sonra çalışır (ör. mutate
    // içinde tespit edilen bir engelin kullanıcıya bildirilmesi).
    function commit(orderId, mutate, after) {
        const orderRef = db.collection('guestOrders').doc(orderId);
        db.runTransaction(async (tx) => {
            const snap = await tx.get(orderRef);
            if (!snap.exists) return;
            const freshOrder = Object.assign({ id: orderId }, snap.data());
            const result = mutate(freshOrder);
            if (!result) return; // ör. sipariş taze veriye göre zaten iptal edilmiş
            const items = result.items, extra = result.extra;
            const newStatus = deriveStatus(items);

            const oldById = {};
            (freshOrder.items || []).forEach(it => { if (it && it.id) oldById[it.id] = it.status; });
            items.forEach(it => {
                // Concierge kalemi (resId) bu çekmeceye AİT DEĞİL: aynası
                // `reservations` dokümanıdır ve yalnızca Concierge paneli ile
                // sunucu callable'ları onu değiştirir. Buradan geçerse
                // aşağıdaki `if (!it.logId)` dalı ona İKİNCİ bir guestLogs
                // kaydı açardı (aynı transfer iki yerde birden) — denetimde
                // tespit edilen mükerrer-kayıt hatasının kaynağı buydu.
                if (it.resId) return;
                // İptal edilen kalemin kaydı AÇIK bırakılmaz — aksi halde SLA
                // eskalasyonu süresiz tetiklenirdi. Çözüldü olarak kapatılır,
                // çözüm notu iptali belirtir.
                if (it.status === 'cancelled' && it.logId && oldById[it.id] !== 'cancelled') {
                    tx.update(db.collection('guestLogs').doc(it.logId), {
                        status: 'Solved',
                        solution: 'Talep iptal edildi.',
                        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                        completedBy: USERNAME
                    });
                    return;
                }
                const logStatus = LOG_STATUS[it.status];
                if (!logStatus) return; // pending: kayıt Following olarak bekler (sunucu köprüsü açtı)
                if (!it.logId) {
                    // First time this item enters the workflow → create its room log.
                    const logRef = db.collection('guestLogs').doc();
                    it.logId = logRef.id;
                    const parts = [it.name + (it.qty > 1 ? ' x' + it.qty : '')];
                    if (it.option) parts.push('Seçenek: ' + it.option);
                    if (it.preferredTime) parts.push('Saat: ' + it.preferredTime);
                    if (it.note) parts.push('Not: ' + it.note);
                    tx.set(logRef, {
                        date: today(),
                        room: freshOrder.room || '',
                        guestName: guestNameForRoom(freshOrder.room, freshOrder.guestName),
                        department: it.department || DEPT_BY_CAT[it.category] || 'Concierge',
                        complaint: parts.join(' · '),
                        solution: '',
                        staffInitial: USERNAME,
                        tenantId: TENANT,
                        type: 'request',
                        status: logStatus,
                        source: 'guest-order',
                        orderId: orderId,
                        itemId: it.id,
                        assignedTo: freshOrder.assignedTo || null,
                        assignedToName: freshOrder.assignedToName || '',
                        updates: [{ user: USERNAME, text: 'Misafir self-servis talebi alındı.', time: hhmm(), timestamp: Date.now(), isSystem: true }],
                        createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                } else {
                    // Keep the existing room log's status in sync.
                    const upd = { status: logStatus };
                    // ÜSTLENME zamanı: kalem ilk kez işleme alındığında (in_progress)
                    // kayda acknowledgedAt/By yazılır — "misafir talebi ne kadar
                    // sürede üstlenildi" raporu QR talepleri için de çalışır.
                    if (it.status === 'in_progress' && oldById[it.id] !== 'in_progress') {
                        upd.acknowledgedAt = firebase.firestore.FieldValue.serverTimestamp();
                        upd.acknowledgedBy = USERNAME;
                        upd.acknowledgedDept = (localStorage.getItem('hotelDept') || '').trim();
                    }
                    if (it.status === 'completed') {
                        upd.completedAt = firebase.firestore.FieldValue.serverTimestamp();
                        upd.completedBy = USERNAME;
                        // Çekmeceden hiç işleme alınmadan tamamlandıysa üstlenme de şimdi.
                        if (!oldById[it.id] || oldById[it.id] === 'pending' || oldById[it.id] === 'confirmed') {
                            upd.acknowledgedAt = upd.acknowledgedAt || firebase.firestore.FieldValue.serverTimestamp();
                            upd.acknowledgedBy = upd.acknowledgedBy || USERNAME;
                        }
                    }
                    tx.update(db.collection('guestLogs').doc(it.logId), upd);
                }
            });

            const statusLog = (freshOrder.statusLog || []).concat([{ status: newStatus, at: Date.now(), by: USERNAME }]);
            tx.update(orderRef, Object.assign({
                items,
                status: newStatus,
                statusLog,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, extra || {}));
        }).then(() => { if (typeof after === 'function') after(); })
          .catch(err => { console.error('guest order commit failed', err); alert('İşlem kaydedilemedi.'); });
    }

    function assignOrder(orderId, uid, uname) {
        const o = findOrder(orderId);
        if (!o) return;
        const batch = db.batch();
        batch.update(db.collection('guestOrders').doc(orderId), {
            assignedTo: uid, assignedToName: uname, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        // Reflect the assignment on any room logs already created for this order.
        (o.items || []).forEach(it => {
            if (it.logId) batch.update(db.collection('guestLogs').doc(it.logId), { assignedTo: uid, assignedToName: uname });
        });
        batch.commit()
            .then(() => {
                if (window.RT && RT.sendNotification && uid) {
                    RT.sendNotification({
                        toUid: uid, toUsername: uname, type: 'guestOrder', recordId: orderId,
                        title: 'Misafir talebi atandı',
                        body: `Oda ${o.room || '—'} · ${(o.items || []).length} kalem`
                    }).catch(() => {});
                }
            })
            .catch(err => { console.error('assign failed', err); alert('Atama yapılamadı.'); });
    }

    // ── Live listeners ─────────────────────────────────────────
    function listen() {
        db.collection('guestOrders').where('tenantId', '==', TENANT)
            .orderBy('createdAt', 'desc').limit(80)
            .onSnapshot(snap => {
                orders = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
                if (!firstLoad) {
                    snap.docChanges().forEach(ch => {
                        if (ch.type === 'added' && (ch.doc.data().status === 'pending')) notifyNew(ch.doc.id, ch.doc.data());
                    });
                }
                firstLoad = false;
                renderBadge();
                if (drawerOpen) render();
                if (pendingFocus) { const id = pendingFocus; pendingFocus = null; setTimeout(() => focusOrder(id), 200); }
            }, err => console.error('guestOrders listen failed', err));
    }
    // Mirror current in-house occupants so each order shows the real guest name.
    // Durum filtresi sunucuda — tüm dizin yerine yalnızca konaklayanlar iner.
    function listenDirectory() {
        db.collection('guestDirectory').where('tenantId', '==', TENANT)
            .where('status', '==', 'in_house').onSnapshot(snap => {
                const map = {};
                snap.forEach(d => {
                    const g = d.data();
                    const room = String(g.room || '').trim();
                    if (!room || room.toLowerCase() === 'pre-arrival') return;
                    if (!map[room]) map[room] = g.name || '';
                });
                directory = map;
                if (drawerOpen) render();
            }, () => {});
    }

    // Open the drawer focused on a specific order (from a notification click).
    function focusOrder(orderId) {
        filterState = 'all';
        const drawer = document.getElementById('gos-drawer');
        if (drawer) drawer.querySelectorAll('.gos-fchip').forEach(x => x.classList.toggle('active', x.dataset.f === 'all'));
        openDrawer();
        if (!orderId) return;
        requestAnimationFrame(() => openOrderModal(orderId));   // jump straight to the detail
    }

    function notifyNew(id, o) {
        try { if (navigator.vibrate) navigator.vibrate([60, 40, 60]); } catch (e) {}
        // In the App Shell the persistent bell (realtime.js) already toasts new
        // guest orders via a Cloud Function notification — avoid a double toast.
        if (window.__EMBED__) return;
        const t = document.createElement('div');
        t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:12px 18px;border-radius:12px;z-index:99999;font-family:Outfit,sans-serif;font-size:13.5px;font-weight:600;box-shadow:0 18px 50px rgba(15,23,42,.35);cursor:pointer';
        t.textContent = `🛎️ Yeni misafir talebi · ${guestNameForRoom(o.room)}`;
        t.onclick = () => { focusOrder(id); t.remove(); };
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 6000);
    }

    // ── Boot (only for signed-in staff) ────────────────────────
    function boot() {
        // Feature-gated module: only build the staff surface when the hotel's
        // plan includes "Misafir Talepleri" (toggled per-tenant in superadmin).
        if (typeof moduleEnabled === 'function' && !moduleEnabled('guestOrders')) return;
        buildUI();
        // Panelin mobil ana menüsü (panel.js) çekmeceyi buradan açar — çekmece
        // bugüne dek yalnızca kendi düğmesi, kabuk postMessage'ı ve ?orders=1
        // üzerinden erişilebiliyordu.
        window.GuestOrders = { open: openDrawer, focus: focusOrder };
        if (window.RT && RT.registerOpener) RT.registerOpener('guestOrder', focusOrder);
        // App Shell'deki "Talepler" sekmesi (postMessage) veya ?orders=1 ile çekmeceyi aç.
        window.addEventListener('message', function (e) {
            if (e.data && e.data.__mgShell && e.data.type === 'openOrders') openDrawer();
        });
        try { const oid = new URLSearchParams(location.search).get('order'); if (oid) pendingFocus = oid; } catch (e) {}
        try { if (new URLSearchParams(location.search).get('orders') === '1') setTimeout(openDrawer, 80); } catch (e) {}
        // onAuthStateChanged aynı oturumda birden fazla kez tetiklenebilir; bir
        // "started" bayrağı olmadan her tetiklenişte listen()/listenDirectory()
        // YENİ bir onSnapshot dinleyicisi açıyor, öncekini hiç kapatmıyordu —
        // zamanla yinelenen bildirim/render'lara yol açardı.
        let started = false;
        auth.onAuthStateChanged(u => {
            if (!u || u.isAnonymous || started) return;
            started = true;
            listen();
            listenDirectory();
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
