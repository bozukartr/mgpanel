/* ===== StayOS — Superadmin Console ===== */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    // Screens
    const loginScreen  = $('loginScreen');
    const deniedScreen = $('deniedScreen');
    const consoleEl    = $('console');

    let tenants = [];          // [{ id, ...data }]
    let orders = [];           // [{ id, ...data }] checkoutOrders
    let userCountByTenant = {}; // { tenantId: n }
    let currentSubTenant = null;
    let currentOrderId = null;  // set when the new-hotel modal is opened from an order
    let drawerTenantId = null;
    let drawerOrderId = null;   // open order in the order detail drawer
    let orderFilter = 'all';    // all | unprovisioned | success | pending | provisioned | archived
    let orderSearch = '';

    // ---------- helpers ----------
    function toast(msg, isErr) {
        const t = $('toast');
        t.textContent = msg;
        t.className = 'toast show' + (isErr ? ' err' : '');
        setTimeout(() => { t.className = 'toast'; }, 2600);
    }
    function initials(name) {
        return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
    }
    function fmtDate(d) {
        if (!d) return '—';
        return d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    function daysBetween(d) {
        return Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
    }
    // Returns { key, label, cls, end, days }
    function statusOf(t) {
        const end = t.subscriptionEnd && t.subscriptionEnd.toDate ? t.subscriptionEnd.toDate() : null;
        if (t.archived === true) return { key: 'archived', label: 'Arşivli', cls: 'pill-gray', end };
        if (t.suspended === true) return { key: 'suspended', label: 'Askıda', cls: 'pill-gray', end };
        if (!end) return { key: 'none', label: 'Tanımsız', cls: 'pill-gray', end: null };
        const days = daysBetween(end);
        if (days < 0)  return { key: 'expired', label: 'Süresi Doldu', cls: 'pill-red', end, days };
        if (days <= 7) return { key: 'soon', label: 'Yakında Bitecek', cls: 'pill-amber', end, days };
        return { key: 'active', label: 'Aktif', cls: 'pill-green', end, days };
    }
    function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    // ---------- plans / modules ----------
    const PLANS = {
        starter:    { name: 'Starter',  maxUsers: 5,  modules: { concierge: true, crm: false, guestIssues: false, guestOrders: false } },
        pro:        { name: 'Pro',      maxUsers: 15, modules: { concierge: true, crm: true,  guestIssues: false, guestOrders: false } },
        enterprise: { name: 'Business', maxUsers: 40, modules: { concierge: true, crm: true,  guestIssues: true, guestOrders: true } },
        custom:     { name: 'Özel',     maxUsers: 0,  modules: { concierge: true, crm: true,  guestIssues: true, guestOrders: true } }
    };
    const MODULE_KEYS = ['concierge', 'crm', 'guestIssues', 'guestOrders'];
    const MODULE_LABELS = { concierge: 'Concierge', crm: 'CRM', guestIssues: 'Kayıtlar', guestOrders: 'Misafir Talepleri' };

    function planKey(t) { return (t && t.plan && PLANS[t.plan]) ? t.plan : 'custom'; }
    function planName(t) { return PLANS[planKey(t)].name; }
    function modulesOf(t) { return (t && t.modules) ? t.modules : { concierge: true, crm: true, guestIssues: true, guestOrders: true }; }
    function applyPlanToForm(planSel, maxInput, modsContainer) {
        const p = PLANS[planSel.value];
        if (!p || planSel.value === 'custom') return;
        maxInput.value = p.maxUsers;
        modsContainer.querySelectorAll('input[data-mod]').forEach(cb => { cb.checked = p.modules[cb.dataset.mod] !== false; });
    }
    function readModules(container) {
        const mods = {};
        container.querySelectorAll('input[data-mod]').forEach(cb => { mods[cb.dataset.mod] = cb.checked; });
        return mods;
    }
    function setModules(container, mods) {
        container.querySelectorAll('input[data-mod]').forEach(cb => { cb.checked = mods[cb.dataset.mod] !== false; });
    }

    // ---------- data ----------
    async function loadUserCounts() {
        const snap = await db.collection('systemUsers').get();
        const map = {};
        snap.forEach(doc => {
            const tid = doc.data().tenantId || 'mgallery';
            map[tid] = (map[tid] || 0) + 1;
        });
        userCountByTenant = map;
    }

    function subscribeTenants() {
        db.collection('tenants').orderBy('name').onSnapshot(snap => {
            tenants = [];
            snap.forEach(doc => tenants.push(Object.assign({ id: doc.id }, doc.data())));
            render();
        }, err => {
            // orderBy may fail if some docs lack 'name'; fall back to unordered.
            db.collection('tenants').onSnapshot(s2 => {
                tenants = [];
                s2.forEach(doc => tenants.push(Object.assign({ id: doc.id }, doc.data())));
                render();
            });
        });
    }

    function subscribeOrders() {
        db.collection('checkoutOrders').orderBy('createdAt', 'desc').onSnapshot(snap => {
            orders = [];
            snap.forEach(doc => orders.push(Object.assign({ id: doc.id }, doc.data())));
            renderOrders();
        }, err => {
            // orderBy may fail before any order carries createdAt; fall back to unordered.
            db.collection('checkoutOrders').onSnapshot(s2 => {
                orders = [];
                s2.forEach(doc => orders.push(Object.assign({ id: doc.id }, doc.data())));
                renderOrders();
            });
        });
    }

    // Quote requests from the marketing site's "Teklif Al" form.
    let quotes = [];
    function subscribeQuotes() {
        db.collection('quoteRequests').onSnapshot(snap => {
            quotes = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                .sort((a, b) => ((b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) -
                                 (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0)));
            renderQuotes();
        }, () => { });
    }

    function renderQuotes() {
        const body = $('quotesBody');
        if (!body) return;
        const newCount = quotes.filter(q => q.status === 'new').length;
        const countEl = $('quotesCount');
        if (countEl) countEl.textContent = quotes.length + ' talep · ' + newCount + ' yeni';
        if (!quotes.length) {
            body.innerHTML = `<tr><td colspan="6"><div class="empty">Henüz teklif talebi yok. stayos.org'daki "Teklif Al" formu buraya düşer.</div></td></tr>`;
            return;
        }
        body.innerHTML = quotes.map(q => {
            const created = q.createdAt && q.createdAt.toDate ? q.createdAt.toDate() : null;
            const isNew = q.status === 'new';
            const contact = [
                q.email ? `<a href="mailto:${esc(q.email)}" style="color:var(--accent)">${esc(q.email)}</a>` : '',
                q.phone ? esc(q.phone) : ''
            ].filter(Boolean).join('<br>') || '—';
            const scope = [q.rooms ? esc(q.rooms) + ' oda' : '', q.hotels ? esc(q.hotels) : '']
                .filter(Boolean).join(' · ') || '—';
            const msg = q.message ? `<div class="mono" style="margin-top:3px;max-width:340px;white-space:normal;">${esc(q.message.slice(0, 140))}${q.message.length > 140 ? '…' : ''}</div>` : '';
            return `
            <tr>
                <td><div class="mono">${fmtDate(created)}</div></td>
                <td><div class="hotel-cell"><div class="av">${esc(initials(q.hotel || q.name || '?'))}</div><div><b>${esc(q.hotel || '—')}</b><div class="mono">${esc(q.name || '')}</div>${msg}</div></div></td>
                <td style="font-size:12.5px;">${contact}</td>
                <td style="font-size:12.5px;">${scope}</td>
                <td><span class="pill ${isNew ? 'pill-amber' : 'pill-green'}">${isNew ? 'Yeni' : 'İşlendi'}</span></td>
                <td style="text-align:right;"><div class="row-actions" style="justify-content:flex-end;">
                    <button class="btn-ghost" style="padding:6px 12px;font-size:12px;" data-qact="toggle" data-id="${esc(q.id)}">${isNew ? 'İşlendi' : 'Yeni yap'}</button>
                    <button class="btn-ghost btn-danger-ghost" style="padding:6px 12px;font-size:12px;" data-qact="del" data-id="${esc(q.id)}">Sil</button>
                </div></td>
            </tr>`;
        }).join('');
    }

    $('quotesBody')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-qact]');
        if (!btn) return;
        const q = quotes.find(x => x.id === btn.dataset.id);
        if (!q) return;
        try {
            if (btn.dataset.qact === 'toggle') {
                await db.collection('quoteRequests').doc(q.id).update({ status: q.status === 'new' ? 'handled' : 'new' });
                toast(q.status === 'new' ? 'Talep işlendi olarak işaretlendi' : 'Talep yeniye alındı');
            } else if (btn.dataset.qact === 'del') {
                if (!confirm(`"${q.hotel || q.name}" teklif talebi silinsin mi?`)) return;
                await db.collection('quoteRequests').doc(q.id).delete();
                toast('Teklif talebi silindi');
            }
        } catch (err) { toast('Hata: ' + err.message, true); }
    });

    // Ensure the founding hotel (mgallery) has a tenant document so it appears
    // in the console. Tenant writes are superadmin-only, so this can't be done
    // by the migration tool; the operator console self-heals it once.
    async function ensureDefaultTenant() {
        try {
            const ref = db.collection('tenants').doc(DEFAULT_TENANT);
            const snap = await ref.get();
            if (snap.exists) return;
            const reg = {
                id: DEFAULT_TENANT,
                name: 'MGallery',
                emailDomain: tenantEmailDomain(DEFAULT_TENANT),
                plan: 'enterprise',
                maxUsers: 0,
                modules: { concierge: true, crm: true, guestIssues: true, guestOrders: true },
                suspended: false,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            const legacy = await db.collection('systemConfig').doc('subscription').get().catch(() => null);
            if (legacy && legacy.exists && legacy.data().subscriptionEnd) reg.subscriptionEnd = legacy.data().subscriptionEnd;
            await ref.set(reg, { merge: true });
        } catch (e) { /* ignore */ }
    }

    // ---------- render ----------
    function render() {
        renderKpis();
        renderRenewals();
        renderHotels();
        renderOrders();
        if (typeof renderTickets === 'function') renderTickets();
        if (drawerTenantId) refreshDrawerStats();
    }

    // ---------- orders (public checkout) ----------
    // Status of a checkout order. Provisioned = a tenant already links back to it.
    const ORDER_STATUS = {
        success: { label: 'Ödendi',  cls: 'pill-green' },
        pending: { label: 'Bekliyor', cls: 'pill-amber' },
        error:   { label: 'Hatalı',  cls: 'pill-red' }
    };
    function orderTenant(o) { return tenants.find(t => t.sourceOrderId === o.id) || null; }
    function fmtMoney(n) {
        const v = Number(n) || 0;
        return v.toLocaleString('tr-TR') + ' ₺';
    }
    function orderItemsText(o) {
        const it = o.items || {};
        const parts = [];
        if (it.hotels) parts.push('+' + it.hotels + ' otel');
        if (it.users) parts.push('+' + it.users + ' kullanıcı');
        if (it.pms) parts.push('PMS');
        return parts.length ? parts.join(', ') : 'Core';
    }
    // Paid but not yet turned into a hotel and not archived — needs operator action.
    function isActionable(o) { return o.status === 'success' && !o.archived && !orderTenant(o); }
    function matchesFilter(o) {
        switch (orderFilter) {
            case 'archived':      return !!o.archived;
            case 'unprovisioned': return isActionable(o);
            case 'success':       return o.status === 'success' && !o.archived;
            case 'pending':       return o.status === 'pending' && !o.archived;
            case 'provisioned':   return !!orderTenant(o) && !o.archived;
            default:              return !o.archived; // 'all' hides the archive
        }
    }
    function matchesSearch(o) {
        if (!orderSearch) return true;
        const b = o.buyer || {};
        return [b.hotel, b.name, b.email, b.phone, o.id].some(v => (v || '').toLowerCase().includes(orderSearch));
    }

    function renderOrders() {
        const actionable = orders.filter(isActionable).length;
        const badge = $('ordersBadge');
        if (badge) { badge.textContent = actionable; badge.hidden = actionable === 0; }

        const countEl = $('ordersCount');
        if (countEl) countEl.textContent = orders.length + ' sipariş · ' + actionable + ' açılmayı bekliyor';

        const body = $('ordersBody');
        if (!body) return;

        const rows = orders.filter(o => matchesFilter(o) && matchesSearch(o));
        if (!rows.length) {
            const msg = orders.length
                ? 'Bu filtreye uygun sipariş yok.'
                : 'Henüz sipariş yok. Tanıtım sitesinden gelen ödemeler burada listelenir.';
            body.innerHTML = `<tr><td colspan="6"><div class="empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                <div>${msg}</div></div></td></tr>`;
            if (drawerOrderId) refreshOrderDrawer();
            return;
        }
        body.innerHTML = rows.map(o => {
            const st = ORDER_STATUS[o.status] || { label: o.status || '—', cls: 'pill-gray' };
            const b = o.buyer || {};
            const created = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : null;
            const cycle = o.cycle === 'annual' ? 'Yıllık' : 'Aylık';
            const tn = orderTenant(o);
            let action;
            if (tn) {
                action = `<a class="order-open" href="https://${esc(tn.id)}.stayos.org" target="_blank" rel="noopener">Açıldı · ${esc(tn.id)} ↗</a>`;
            } else if (o.status === 'success' && !o.archived) {
                action = `<button class="btn-primary btn-sm" data-act="provision" data-id="${esc(o.id)}">Otel Aç</button>`;
            } else {
                action = `<span class="muted-sm">—</span>`;
            }
            const noteIco = o.note ? ' <span class="note-dot" title="Not var">●</span>' : '';
            return `
            <tr class="row-click${o.archived ? ' row-archived' : ''}" data-order="${esc(o.id)}">
                <td><div class="mono">${fmtDate(created)}</div></td>
                <td><div class="hotel-cell"><div class="av">${esc(initials(b.hotel || b.name || '?'))}</div><div><b>${esc(b.hotel || '—')}${noteIco}</b><div class="mono">${esc(b.name || '')}${b.email ? ' · ' + esc(b.email) : ''}</div></div></div></td>
                <td>${esc(cycle)}<div class="sub-end">${esc(orderItemsText(o))}</div></td>
                <td><b>${fmtMoney(o.priceTRY)}</b></td>
                <td><span class="pill ${st.cls}">${st.label}</span></td>
                <td style="text-align:right;">${action}</td>
            </tr>`;
        }).join('');

        if (drawerOrderId) refreshOrderDrawer();
        if (typeof renderFinance === 'function') renderFinance();
    }

    // ---------- order detail drawer ----------
    function openOrderDrawer(id) {
        if (!orders.find(o => o.id === id)) return;
        drawerOrderId = id;
        refreshOrderDrawer();
        $('orderDrawer').classList.add('show');
        $('orderDrawerBackdrop').classList.add('show');
    }
    function closeOrderDrawer() {
        drawerOrderId = null;
        $('orderDrawer').classList.remove('show');
        $('orderDrawerBackdrop').classList.remove('show');
    }
    function refreshOrderDrawer() {
        const o = orders.find(x => x.id === drawerOrderId);
        if (!o) { closeOrderDrawer(); return; }
        const b = o.buyer || {};
        const st = ORDER_STATUS[o.status] || { label: o.status || '—', cls: 'pill-gray' };
        const created = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : null;
        const paid = o.paidAt && o.paidAt.toDate ? o.paidAt.toDate() : null;
        const tn = orderTenant(o);

        $('odAvatar').textContent = initials(b.hotel || b.name || '?');
        $('odName').textContent = b.hotel || '—';
        $('odSub').textContent = o.id + (o.archived ? ' · arşivli' : '');
        $('odStatus').innerHTML = `<span class="pill ${st.cls}">${st.label}</span>`;
        $('odPrice').textContent = fmtMoney(o.priceTRY);
        $('odCycle').textContent = o.cycle === 'annual' ? 'Yıllık' : 'Aylık';

        // Detail rows
        const rowsHtml = [
            ['Yetkili', esc(b.name || '—')],
            ['E-posta', b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : '—'],
            ['Telefon', b.phone ? `<a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : '—'],
            ['Kalemler', esc(orderItemsText(o))],
            ['Oluşturma', fmtDate(created)],
            ['Ödeme', paid ? fmtDate(paid) : '—'],
            ['Sipariş No', `<span class="mono">${esc(o.id)}</span>`]
        ];
        if (o.status === 'error' && o.error) rowsHtml.push(['Hata', esc(o.error)]);
        $('odDetail').innerHTML = rowsHtml.map(([k, v]) => `<div class="o-row"><span>${k}</span><div>${v}</div></div>`).join('');

        // Actions
        const acts = [];
        if (tn) {
            acts.push(`<a class="btn-ghost btn-sm" href="https://${esc(tn.id)}.stayos.org" target="_blank" rel="noopener">Oteli Aç ↗</a>`);
        } else if (o.status === 'success' && !o.archived) {
            acts.push(`<button class="btn-primary btn-sm" data-oact="provision">Otel Aç</button>`);
        }
        acts.push(`<button class="btn-ghost btn-sm" data-oact="archive">${o.archived ? 'Arşivden Çıkar' : 'Arşivle'}</button>`);
        acts.push(`<button class="btn-ghost btn-sm btn-danger-ghost" data-oact="delete">Sil</button>`);
        $('odActions').innerHTML = acts.join('');

        // Note
        $('odNote').value = o.note || '';
        $('odNoteHint').textContent = '';
    }

    async function saveOrderNote() {
        const o = orders.find(x => x.id === drawerOrderId); if (!o) return;
        const note = $('odNote').value.trim();
        const btn = $('odNoteSave'); btn.disabled = true; btn.textContent = 'Kaydediliyor…';
        try {
            await db.collection('checkoutOrders').doc(o.id).update({ note });
            $('odNoteHint').textContent = 'Kaydedildi ✓';
            toast('Not kaydedildi');
        } catch (e) { $('odNoteHint').textContent = 'Hata: ' + e.message; toast('Hata: ' + e.message, true); }
        finally { btn.disabled = false; btn.textContent = 'Notu Kaydet'; }
    }

    async function toggleOrderArchive() {
        const o = orders.find(x => x.id === drawerOrderId); if (!o) return;
        const next = !o.archived;
        try {
            await db.collection('checkoutOrders').doc(o.id).update({
                archived: next,
                archivedAt: next ? firebase.firestore.FieldValue.serverTimestamp() : null
            });
            toast(next ? 'Sipariş arşivlendi' : 'Sipariş arşivden çıkarıldı');
        } catch (e) { toast('Hata: ' + e.message, true); }
    }

    async function deleteOrder() {
        const o = orders.find(x => x.id === drawerOrderId); if (!o) return;
        const label = (o.buyer && o.buyer.hotel) || o.id;
        if (!confirm(`"${label}" siparişi kalıcı olarak silinsin mi?\n\nPayTR/muhasebe kaydı kaybolur. Geri alınamaz. Gereksiz değilse "Arşivle" tercih edin.`)) return;
        try {
            await db.collection('checkoutOrders').doc(o.id).delete();
            closeOrderDrawer();
            toast('Sipariş silindi');
        } catch (e) { toast('Hata: ' + e.message, true); }
    }

    function renderKpis() {
        const now = new Date();
        let active = 0, soon = 0, expired = 0;
        tenants.forEach(t => {
            const s = statusOf(t);
            if (s.key === 'active') active++;
            else if (s.key === 'soon') soon++;
            else if (s.key === 'expired' || s.key === 'suspended' || s.key === 'none') expired++;
        });
        const totalUsers = Object.values(userCountByTenant).reduce((a, b) => a + b, 0);
        const cards = [
            { lbl: 'Toplam Otel', val: tenants.length, hint: 'Kayıtlı mülk', ico: 'slate', svg: '<path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/>' },
            { lbl: 'Aktif Abonelik', val: active, hint: 'Erişimi açık', ico: 'green', svg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' },
            { lbl: 'Yakında Bitecek', val: soon, hint: '≤ 7 gün kaldı', ico: 'amber', svg: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
            { lbl: 'Pasif / Süresi Dolmuş', val: expired, hint: 'İlgilenilmeli', ico: 'red', svg: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
            { lbl: 'Toplam Kullanıcı', val: totalUsers, hint: 'Tüm otellerde', ico: 'indigo', svg: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>' }
        ];
        $('kpiGrid').innerHTML = cards.map(c => `
            <div class="kpi">
                <div class="top">
                    <span class="lbl">${c.lbl}</span>
                    <span class="ico ico-${c.ico}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.svg}</svg></span>
                </div>
                <div class="val">${c.val}</div>
                <div class="hint">${c.hint}</div>
            </div>`).join('');
    }

    function renderRenewals() {
        const rows = tenants
            .map(t => ({ t, s: statusOf(t) }))
            .filter(x => x.s.end && x.s.days >= 0 && x.s.days <= 14 && x.s.key !== 'suspended' && x.s.key !== 'archived')
            .sort((a, b) => a.s.days - b.s.days);
        const body = $('renewalsBody');
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="4"><div class="empty">Yaklaşan yenileme yok.</div></td></tr>`;
            return;
        }
        body.innerHTML = rows.map(({ t, s }) => `
            <tr>
                <td><div class="hotel-cell"><div class="av">${esc(initials(t.name || t.id))}</div><div><b>${esc(t.name || t.id)}</b><div class="mono">${esc(t.id)}</div></div></div></td>
                <td><span class="pill ${s.cls}">${s.label}</span></td>
                <td>${fmtDate(s.end)}</td>
                <td>${s.days} gün</td>
            </tr>`).join('');
    }

    function renderHotels() {
        $('hotelsCount').textContent = tenants.length + ' otel kayıtlı';
        const body = $('hotelsBody');
        if (!tenants.length) {
            body.innerHTML = `<tr><td colspan="6"><div class="empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>
                <div>Henüz otel yok. "Yeni Otel" ile ilk oteli oluşturun.</div></div></td></tr>`;
            return;
        }
        body.innerHTML = tenants.map(t => {
            const s = statusOf(t);
            const count = userCountByTenant[t.id] || 0;
            const max = t.maxUsers || 0;
            const usage = max > 0 ? `${count} / ${max}` : `${count} <span class="muted-sm">/ ∞</span>`;
            const overLimit = max > 0 && count > max;
            const suspended = t.suspended === true;
            const mods = modulesOf(t);
            const chips = MODULE_KEYS.map(k => `<span class="mchip ${mods[k] !== false ? 'on' : 'off'}">${MODULE_LABELS[k]}</span>`).join('');
            return `
            <tr class="row-click" data-hotel="${esc(t.id)}">
                <td><div class="hotel-cell"><div class="av">${esc(initials(t.name || t.id))}</div><div><b>${esc(t.name || t.id)}</b><div class="mono">${esc(t.id)}.stayos.org</div></div></div></td>
                <td><span class="plan-badge">${esc(planName(t))}</span></td>
                <td><span class="pill ${s.cls}">${s.label}</span><div class="sub-end">${fmtDate(s.end)}</div></td>
                <td><span class="${overLimit ? 'usage-over' : ''}">${usage}</span></td>
                <td><div class="mchips">${chips}</div></td>
                <td><div class="row-actions">
                    <button class="icon-btn" title="Abonelik" data-act="sub" data-id="${esc(t.id)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    </button>
                    <button class="icon-btn" title="Paket & Modüller" data-act="pkg" data-id="${esc(t.id)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                    </button>
                    <button class="icon-btn" title="${suspended ? 'Aktifleştir' : 'Askıya Al'}" data-act="toggle" data-id="${esc(t.id)}" data-suspended="${suspended}">
                        ${suspended
                            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
                            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
                    </button>
                </div></td>
            </tr>`;
        }).join('');
    }

    // ---------- actions ----------
    async function refresh() {
        await loadUserCounts();
        render();
    }

    // New hotel. When `order` is supplied, prefill from a paid checkout order and
    // remember it so the created tenant links back (marking the order provisioned).
    function openHotelModal(order) {
        ['nhName', 'nhSlug', 'nhUser', 'nhPass'].forEach(id => $(id).value = '');
        $('nhSlug').dataset.touched = '';
        $('nhUser').value = 'admin';
        const sub = new Date();
        $('nhPlan').value = 'pro';
        applyPlanToForm($('nhPlan'), $('nhMaxUsers'), $('nhModules'));

        const banner = $('nhOrderBanner');
        if (order) {
            currentOrderId = order.id;
            const b = order.buyer || {};
            $('nhName').value = b.hotel || '';
            $('nhSlug').value = (b.hotel || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
            // Annual orders cover a year; monthly cover a month.
            sub.setMonth(sub.getMonth() + (order.cycle === 'annual' ? 12 : 1));
            banner.innerHTML = 'Sipariş kaynaklı · <b>' + esc(b.name || '') + '</b>'
                + (b.email ? ' · ' + esc(b.email) : '')
                + (b.phone ? ' · ' + esc(b.phone) : '')
                + ' · ' + (order.cycle === 'annual' ? 'Yıllık' : 'Aylık');
            banner.hidden = false;
        } else {
            currentOrderId = null;
            sub.setMonth(sub.getMonth() + 1);
            banner.hidden = true;
            banner.innerHTML = '';
        }
        $('nhSubEnd').value = sub.toISOString().slice(0, 10);
        $('nhErr').textContent = '';
        $('hotelModal').classList.add('show');
    }

    $('nhName').addEventListener('input', () => {
        const slug = $('nhSlug');
        if (!slug.dataset.touched) {
            slug.value = $('nhName').value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
        }
    });
    $('nhSlug').addEventListener('input', () => { $('nhSlug').dataset.touched = '1'; });

    async function createHotel() {
        const name = $('nhName').value.trim();
        const slug = $('nhSlug').value.trim().toLowerCase();
        const user = $('nhUser').value.trim().toLowerCase();
        const pass = $('nhPass').value;
        const subEnd = $('nhSubEnd').value;
        const plan = $('nhPlan').value;
        const maxUsersVal = parseInt($('nhMaxUsers').value || '0', 10) || 0;
        const mods = readModules($('nhModules'));
        const err = $('nhErr');
        err.textContent = '';

        if (!name) return err.textContent = 'Otel adı gerekli.';
        if (!/^[a-z0-9-]{2,24}$/.test(slug)) return err.textContent = 'Otel kodu küçük harf/rakam/tire, 2-24 karakter olmalı.';
        if (tenants.some(t => t.id === slug)) return err.textContent = 'Bu otel kodu zaten kullanımda.';
        if (!user) return err.textContent = 'Yönetici kullanıcı adı gerekli.';
        if (pass.length < 6) return err.textContent = 'Şifre en az 6 karakter olmalı.';
        if (!subEnd) return err.textContent = 'Abonelik bitiş tarihi gerekli.';
        if (!MODULE_KEYS.some(k => mods[k])) return err.textContent = 'En az bir modül seçili olmalı.';

        const btn = $('nhCreate'); btn.disabled = true; btn.textContent = 'Oluşturuluyor...';
        try {
            const endDate = new Date(subEnd + 'T23:59:59');

            // 1) Tenant document
            const tenantDoc = {
                id: slug,
                name: name,
                emailDomain: tenantEmailDomain(slug),
                subscriptionEnd: firebase.firestore.Timestamp.fromDate(endDate),
                suspended: false,
                plan: plan,
                maxUsers: maxUsersVal,
                modules: mods,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            // Link back to the originating checkout order (marks it provisioned).
            if (currentOrderId) {
                const order = orders.find(o => o.id === currentOrderId);
                tenantDoc.sourceOrderId = currentOrderId;
                if (order && order.buyer) {
                    if (order.buyer.email) tenantDoc.billingEmail = order.buyer.email;
                    if (order.buyer.phone) tenantDoc.billingPhone = order.buyer.phone;
                }
            }
            await db.collection('tenants').doc(slug).set(tenantDoc);

            // 2) First admin auth account — created on a secondary app so the
            //    operator's own session is not disturbed.
            let secondary;
            try { secondary = firebase.app('secondary'); }
            catch (e) { secondary = firebase.initializeApp(firebaseConfig, 'secondary'); }
            const email = userEmail(user, slug);
            const cred = await secondary.auth().createUserWithEmailAndPassword(email, pass);
            const uid = cred.user.uid;
            await secondary.auth().signOut();

            // 3) Staff record for that admin
            await db.collection('systemUsers').doc(uid).set({
                uid: uid,
                username: user,
                email: email,
                role: 'admin',
                department: 'Management',
                tenantId: slug,
                mustChangePassword: true,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            $('hotelModal').classList.remove('show');
            currentOrderId = null;
            toast(name + ' oluşturuldu · ' + slug + '.stayos.org');
            await refresh();
        } catch (e) {
            err.textContent = 'Hata: ' + e.message;
        } finally {
            btn.disabled = false; btn.textContent = 'Otel Oluştur';
        }
    }

    // Subscription
    function openSubModal(id) {
        const t = tenants.find(x => x.id === id);
        if (!t) return;
        currentSubTenant = id;
        $('subModalHotel').textContent = (t.name || id) + ' · ' + id;
        const end = t.subscriptionEnd && t.subscriptionEnd.toDate ? t.subscriptionEnd.toDate() : null;
        $('subDate').value = end ? end.toISOString().slice(0, 10) : '';
        $('subErr').textContent = '';
        $('subModal').classList.add('show');
    }

    async function saveSub() {
        const val = $('subDate').value;
        const err = $('subErr'); err.textContent = '';
        if (!val) return err.textContent = 'Tarih seçin.';
        const btn = $('subSave'); btn.disabled = true; btn.textContent = 'Kaydediliyor...';
        try {
            const endDate = new Date(val + 'T23:59:59');
            await db.collection('tenants').doc(currentSubTenant).update({
                subscriptionEnd: firebase.firestore.Timestamp.fromDate(endDate)
            });
            $('subModal').classList.remove('show');
            toast('Abonelik güncellendi');
        } catch (e) {
            err.textContent = 'Hata: ' + e.message;
        } finally {
            btn.disabled = false; btn.textContent = 'Kaydet';
        }
    }

    async function toggleSuspend(id, suspended) {
        const t = tenants.find(x => x.id === id);
        const name = t ? (t.name || id) : id;
        if (!confirm(suspended ? `${name} aktifleştirilsin mi?` : `${name} askıya alınsın mı? Otelin tüm kullanıcıları giriş yapamaz.`)) return;
        try {
            // Reactivating also lifts the archived flag, restoring the hotel.
            const patch = suspended ? { suspended: false, archived: false } : { suspended: true };
            await db.collection('tenants').doc(id).update(patch);
            toast(suspended ? 'Otel aktifleştirildi' : 'Otel askıya alındı');
        } catch (e) {
            toast('Hata: ' + e.message, true);
        }
    }

    // Package & modules
    let currentPkgTenant = null;
    function openPkgModal(id) {
        const t = tenants.find(x => x.id === id);
        if (!t) return;
        currentPkgTenant = id;
        $('pkgHotel').textContent = (t.name || id) + ' · ' + id;
        $('pkgPlan').value = planKey(t);
        $('pkgMaxUsers').value = t.maxUsers || 0;
        setModules($('pkgModules'), modulesOf(t));
        $('pkgErr').textContent = '';
        $('pkgModal').classList.add('show');
    }
    async function savePkg() {
        const plan = $('pkgPlan').value;
        const maxUsersVal = parseInt($('pkgMaxUsers').value || '0', 10) || 0;
        const mods = readModules($('pkgModules'));
        const err = $('pkgErr'); err.textContent = '';
        if (!MODULE_KEYS.some(k => mods[k])) return err.textContent = 'En az bir modül seçili olmalı.';
        const btn = $('pkgSave'); btn.disabled = true; btn.textContent = 'Kaydediliyor...';
        try {
            await db.collection('tenants').doc(currentPkgTenant).update({ plan, maxUsers: maxUsersVal, modules: mods });
            $('pkgModal').classList.remove('show');
            toast('Paket güncellendi');
        } catch (e) {
            err.textContent = 'Hata: ' + e.message;
        } finally {
            btn.disabled = false; btn.textContent = 'Kaydet';
        }
    }

    // ---------- PMS integration ----------
    let currentPmsTenant = null;
    function pmsSetField(id, v) { const e = $(id); if (e) e.value = v || ''; }
    function togglePmsGeneric() {
        $('pmsGenericFields').style.display = $('pmsProvider').value === 'generic' ? 'block' : 'none';
    }
    async function openPmsModal(id) {
        const t = tenants.find(x => x.id === id); if (!t) return;
        currentPmsTenant = id;
        $('pmsHotel').textContent = (t.name || id) + ' · ' + id;
        $('pmsErr').textContent = ''; $('pmsTestOut').innerHTML = '';
        // Defaults
        $('pmsEnabledChk').checked = false;
        $('pmsProvider').value = 'mock';
        ['pmsBaseUrl', 'pmsSearchPath', 'pmsResultsPath', 'pmsApiKey', 'pmsAuthHeader', 'pmsAuthPrefix',
            'pmsMapName', 'pmsMapRoom', 'pmsMapCheckIn', 'pmsMapCheckOut', 'pmsMapPhone', 'pmsMapEmail'].forEach(x => pmsSetField(x, ''));
        try {
            const snap = await db.collection('pmsConfig').doc(id).get();
            if (snap.exists) {
                const c = snap.data();
                $('pmsEnabledChk').checked = !!c.enabled;
                $('pmsProvider').value = c.provider || 'mock';
                pmsSetField('pmsBaseUrl', c.baseUrl); pmsSetField('pmsSearchPath', c.searchPath);
                pmsSetField('pmsResultsPath', c.resultsPath); pmsSetField('pmsApiKey', c.apiKey);
                pmsSetField('pmsAuthHeader', c.authHeader); pmsSetField('pmsAuthPrefix', c.authPrefix);
                const m = c.map || {};
                pmsSetField('pmsMapName', m.name); pmsSetField('pmsMapRoom', m.room);
                pmsSetField('pmsMapCheckIn', m.checkIn); pmsSetField('pmsMapCheckOut', m.checkOut);
                pmsSetField('pmsMapPhone', m.phone); pmsSetField('pmsMapEmail', m.email);
            }
        } catch (e) { $('pmsErr').textContent = 'Yapılandırma okunamadı: ' + e.message; }
        togglePmsGeneric();
        $('pmsModal').classList.add('show');
    }
    function readPmsConfig() {
        return {
            enabled: $('pmsEnabledChk').checked,
            provider: $('pmsProvider').value,
            baseUrl: $('pmsBaseUrl').value.trim(),
            searchPath: $('pmsSearchPath').value.trim(),
            resultsPath: $('pmsResultsPath').value.trim(),
            apiKey: $('pmsApiKey').value.trim(),
            authHeader: $('pmsAuthHeader').value.trim() || 'Authorization',
            authPrefix: $('pmsAuthPrefix').value,
            map: {
                name: $('pmsMapName').value.trim(), room: $('pmsMapRoom').value.trim(),
                checkIn: $('pmsMapCheckIn').value.trim(), checkOut: $('pmsMapCheckOut').value.trim(),
                phone: $('pmsMapPhone').value.trim(), email: $('pmsMapEmail').value.trim()
            }
        };
    }
    function renderPmsResults(data) {
        const out = $('pmsTestOut');
        if (!data || !data.results || !data.results.length) {
            out.innerHTML = '<div class="pms-test-msg ok">Bağlantı başarılı — sonuç bulunamadı (sorguyu değiştirin).</div>';
            return;
        }
        out.innerHTML = '<div class="pms-test-msg ok">' + data.results.length + ' sonuç (' + (data.source || '') + '):</div>' +
            data.results.slice(0, 6).map(g => `
            <div class="pms-guest">
                <span><b>${esc(g.name || '—')}</b>${g.vip ? '<span class="vip">VIP</span>' : ''}</span>
                <span>Oda ${esc(g.room || '—')}${g.checkIn ? ' · ' + esc(g.checkIn) + '→' + esc(g.checkOut || '') : ''}</span>
            </div>`).join('');
    }
    async function testPms() {
        const btn = $('pmsTestBtn'); const out = $('pmsTestOut');
        btn.disabled = true; btn.textContent = 'Test ediliyor…'; out.innerHTML = '';
        try {
            const call = firebase.app().functions('us-central1').httpsCallable('pmsTestConfig');
            const res = await call({ config: readPmsConfig(), query: $('pmsTestQuery').value.trim() || 'a' });
            renderPmsResults(res.data);
        } catch (e) {
            out.innerHTML = '<div class="pms-test-msg err">Test başarısız: ' + esc(e.message || 'hata') + '</div>';
        } finally { btn.disabled = false; btn.textContent = 'Bağlantıyı Test Et'; }
    }
    async function savePms() {
        const cfg = readPmsConfig();
        const err = $('pmsErr'); err.textContent = '';
        if (cfg.enabled && cfg.provider === 'generic' && !cfg.baseUrl) {
            return err.textContent = 'Generic sağlayıcı için API adresi gerekli.';
        }
        const btn = $('pmsSave'); btn.disabled = true; btn.textContent = 'Kaydediliyor...';
        try {
            await db.collection('pmsConfig').doc(currentPmsTenant).set(Object.assign({}, cfg, {
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }), { merge: true });
            // Cheap client gate lives on the tenant doc (hotel users can read it).
            await db.collection('tenants').doc(currentPmsTenant).update({ pmsEnabled: cfg.enabled });
            $('pmsModal').classList.remove('show');
            toast('PMS ayarları kaydedildi');
        } catch (e) {
            err.textContent = 'Hata: ' + e.message;
        } finally { btn.disabled = false; btn.textContent = 'Kaydet'; }
    }
    $('pmsProvider').addEventListener('change', togglePmsGeneric);
    $('pmsTestBtn').addEventListener('click', testPms);
    $('pmsSave').addEventListener('click', savePms);

    // ---------- hotel detail drawer ----------
    function openHotelDrawer(id) {
        if (!tenants.find(x => x.id === id)) return;
        drawerTenantId = id;
        refreshDrawerStats();
        loadDrawerUsers(id);
        $('hotelDrawer').classList.add('show');
        $('drawerBackdrop').classList.add('show');
    }
    function closeDrawer() {
        drawerTenantId = null;
        $('hotelDrawer').classList.remove('show');
        $('drawerBackdrop').classList.remove('show');
    }
    function refreshDrawerStats() {
        const t = tenants.find(x => x.id === drawerTenantId);
        if (!t) { closeDrawer(); return; }
        const s = statusOf(t);
        $('dAvatar').textContent = initials(t.name || t.id);
        $('dName').textContent = t.name || t.id;
        $('dSub').innerHTML = '<a href="https://' + esc(t.id) + '.stayos.org" target="_blank" rel="noopener" style="color:inherit">' + esc(t.id) + '.stayos.org ↗</a>';
        $('dPlan').textContent = planName(t);
        $('dStatus').innerHTML = `<span class="pill ${s.cls}">${s.label}</span>`;
        const count = userCountByTenant[t.id] || 0;
        const max = t.maxUsers || 0;
        $('dUserCount').textContent = max > 0 ? `${count} / ${max}` : count;
        $('dToggle').textContent = t.archived ? 'Arşivden Çıkar' : (t.suspended ? 'Aktifleştir' : 'Askıya Al');
    }
    async function loadDrawerUsers(id) {
        const list = $('dUserList');
        list.innerHTML = '<div class="empty" style="padding:20px;">Yükleniyor…</div>';
        try {
            const snap = await db.collection('systemUsers').where('tenantId', '==', id).get();
            if (snap.empty) { list.innerHTML = '<div class="empty" style="padding:20px;">Kullanıcı yok.</div>'; return; }
            const rows = [];
            snap.forEach(doc => {
                const u = doc.data();
                const role = u.role || 'staff';
                const roleCls = role.toLowerCase() === 'admin' ? '' : 'staff';
                rows.push(`
                    <div class="u-row">
                        <div class="u-info"><b>${esc(u.username || '—')}</b><div class="u-meta">${esc(u.email || '')}${u.department ? ' · ' + esc(u.department) : ''}</div></div>
                        <span class="role-badge ${roleCls}">${esc(role)}</span>
                        <div class="u-actions">
                            <button class="icon-btn" title="Şifre sıfırla" data-uact="reset" data-uid="${doc.id}" data-uname="${esc(u.username || '')}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>
                            </button>
                            <button class="icon-btn" title="Kaldır" data-uact="remove" data-uid="${doc.id}" data-uname="${esc(u.username || '')}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                        </div>
                    </div>`);
            });
            list.innerHTML = rows.join('');
        } catch (e) {
            list.innerHTML = `<div class="empty" style="padding:20px;">Hata: ${esc(e.message)}</div>`;
        }
    }

    // Edit hotel name
    function openEditModal() {
        const t = tenants.find(x => x.id === drawerTenantId); if (!t) return;
        $('editHotelId').textContent = t.id;
        $('editName').value = t.name || '';
        $('editErr').textContent = '';
        $('editModal').classList.add('show');
    }
    async function saveEdit() {
        const name = $('editName').value.trim();
        const err = $('editErr'); err.textContent = '';
        if (!name) return err.textContent = 'Otel adı gerekli.';
        const btn = $('editSave'); btn.disabled = true; btn.textContent = 'Kaydediliyor...';
        try {
            await db.collection('tenants').doc(drawerTenantId).update({ name });
            $('editModal').classList.remove('show');
            toast('Otel güncellendi');
        } catch (e) { err.textContent = 'Hata: ' + e.message; }
        finally { btn.disabled = false; btn.textContent = 'Kaydet'; }
    }

    // Add user to the open hotel
    function openAddUserModal() {
        const t = tenants.find(x => x.id === drawerTenantId); if (!t) return;
        $('uaHotel').textContent = (t.name || t.id) + ' · ' + t.id;
        $('uaUser').value = ''; $('uaPass').value = ''; $('uaRole').value = 'staff';
        $('uaErr').textContent = '';
        $('userAddModal').classList.add('show');
    }
    async function createDrawerUser() {
        const t = tenants.find(x => x.id === drawerTenantId); if (!t) return;
        const user = $('uaUser').value.trim().toLowerCase();
        const pass = $('uaPass').value;
        const role = $('uaRole').value;
        const err = $('uaErr'); err.textContent = '';
        if (!/^[a-z0-9._-]{2,}$/.test(user)) return err.textContent = 'Geçerli bir kullanıcı adı girin (küçük harf/rakam).';
        if (pass.length < 6) return err.textContent = 'Şifre en az 6 karakter olmalı.';
        const count = userCountByTenant[t.id] || 0;
        const max = t.maxUsers || 0;
        if (max > 0 && count >= max) return err.textContent = `Kullanıcı limitine ulaşıldı (${max}).`;
        const btn = $('uaCreate'); btn.disabled = true; btn.textContent = 'Oluşturuluyor...';
        try {
            let secondary;
            try { secondary = firebase.app('secondary'); } catch (e) { secondary = firebase.initializeApp(firebaseConfig, 'secondary'); }
            const email = userEmail(user, t.id);
            const cred = await secondary.auth().createUserWithEmailAndPassword(email, pass);
            const uid = cred.user.uid;
            await secondary.auth().signOut();
            await db.collection('systemUsers').doc(uid).set({
                uid, username: user, email, role,
                department: role === 'admin' ? 'Management' : 'Staff',
                tenantId: t.id, mustChangePassword: true,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            $('userAddModal').classList.remove('show');
            toast('Kullanıcı oluşturuldu');
            await refresh();
            loadDrawerUsers(t.id);
        } catch (e) { err.textContent = 'Hata: ' + e.message; }
        finally { btn.disabled = false; btn.textContent = 'Oluştur'; }
    }

    // Delete hotel
    function delMode() {
        const r = document.querySelector('input[name="delMode"]:checked');
        return r ? r.value : 'archive';
    }
    function syncDelButton() {
        $('delConfirmBtn').textContent = delMode() === 'purge' ? 'Kalıcı Olarak Sil' : 'Arşivle';
    }
    function openDeleteModal() {
        const t = tenants.find(x => x.id === drawerTenantId); if (!t) return;
        $('delHotel').textContent = (t.name || t.id) + ' · ' + t.id;
        $('delCode').textContent = t.id;
        $('delConfirm').value = '';
        $('delErr').textContent = '';
        const archive = document.querySelector('input[name="delMode"][value="archive"]');
        if (archive) archive.checked = true;
        syncDelButton();
        $('deleteModal').classList.add('show');
    }
    async function doDeleteHotel() {
        const t = tenants.find(x => x.id === drawerTenantId); if (!t) return;
        const err = $('delErr'); err.textContent = '';
        if ($('delConfirm').value.trim() !== t.id) return err.textContent = 'Otel kodu eşleşmiyor.';
        const purge = delMode() === 'purge';
        const btn = $('delConfirmBtn'); btn.disabled = true;
        btn.textContent = purge ? 'Siliniyor...' : 'Arşivleniyor...';
        try {
            if (purge) {
                // Server-side full delete: removes staff Auth accounts and ALL
                // hotel data, so the code (slug) is genuinely freed and nothing
                // is left behind ("email-already-in-use" hatası da önlenir).
                const deleteHotel = firebase.app().functions('us-central1').httpsCallable('deleteHotel');
                await deleteHotel({ tenantId: t.id, purgeData: true });
                toast(t.name + ' ve tüm verileri silindi');
            } else {
                // Soft archive: keep all data, deactivate the hotel and block
                // logins. Reversible via "Aktifleştir".
                await db.collection('tenants').doc(t.id).update({
                    archived: true,
                    suspended: true,
                    archivedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                toast(t.name + ' arşivlendi');
            }
            $('deleteModal').classList.remove('show');
            closeDrawer();
            await refresh();
        } catch (e) { err.textContent = 'Hata: ' + e.message; }
        finally { btn.disabled = false; syncDelButton(); }
    }

    // ======================================================================
    //  DESTEK (Support tickets from hotel admins)
    // ======================================================================
    let tickets = [];
    let ticketFilter = 'open';
    let ticketSearch = '';
    let curTicketId = null;

    function subscribeTickets() {
        db.collection('tickets').onSnapshot(snap => {
            tickets = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                .sort((a, b) => ((b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : 0) -
                                 (a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() : 0)));
            renderTickets();
            if (curTicketId) { const t = tickets.find(x => x.id === curTicketId); if (t) fillTicketModal(t); }
        }, () => { });
    }
    function ticketHotel(t) { const x = tenants.find(h => h.id === t.tenantId); return x ? (x.name || t.tenantId) : (t.tenantId || '—'); }
    function ticketOpen(t) { return (t.status || 'Open') !== 'Closed'; }

    function renderTickets() {
        const open = tickets.filter(ticketOpen).length;
        const badge = $('ticketsBadge');
        if (badge) { badge.textContent = open; badge.hidden = open === 0; }
        const body = $('ticketsBody'); if (!body) return;

        const q = ticketSearch.trim().toLowerCase();
        const rows = tickets.filter(t => {
            if (ticketFilter === 'open' && !ticketOpen(t)) return false;
            if (ticketFilter === 'closed' && ticketOpen(t)) return false;
            if (['Sorun', 'İstek', 'Öneri'].includes(ticketFilter) && (t.type || '') !== ticketFilter) return false;
            if (q && ![ticketHotel(t), t.subject, t.createdBy, t.message].some(v => (v || '').toLowerCase().includes(q))) return false;
            return true;
        });
        $('ticketsCount').textContent = rows.length + ' talep · ' + open + ' açık';
        const typeBadge = ty => ty ? `<span class="tk-type">${esc(ty)}</span>` : '';
        const prio = p => { const k = (p || 'Medium'); const cls = k === 'High' ? 'pill-red' : (k === 'Low' ? 'pill-gray' : 'pill-amber'); const lbl = k === 'High' ? 'Yüksek' : (k === 'Low' ? 'Düşük' : 'Orta'); return `<span class="pill ${cls}">${lbl}</span>`; };
        const stat = t => ticketOpen(t) ? `<span class="pill pill-green">${esc(t.status === 'In Progress' ? 'İşlemde' : 'Açık')}</span>` : `<span class="pill pill-gray">Kapalı</span>`;
        body.innerHTML = rows.length ? rows.map(t => {
            const d = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate() : null;
            const rc = Array.isArray(t.replies) ? t.replies.length : 0;
            return `<tr class="row-click" data-ticket="${esc(t.id)}">
                <td>${fmtDate(d)}</td>
                <td><b>${esc(ticketHotel(t))}</b></td>
                <td>${typeBadge(t.type)}</td>
                <td>${esc(t.subject || '—')}${rc ? ` <span class="muted-sm">· ${rc} yanıt</span>` : ''}</td>
                <td>${prio(t.priority)}</td>
                <td>${stat(t)}</td>
            </tr>`;
        }).join('') : `<tr><td colspan="6"><div class="empty">Bu filtrede talep yok.</div></td></tr>`;
    }

    function openTicketModal(id) {
        const t = tickets.find(x => x.id === id); if (!t) return;
        curTicketId = id;
        fillTicketModal(t);
        $('tkReply').value = '';
        $('tkErr').textContent = '';
        $('ticketModal').classList.add('show');
    }
    function fillTicketModal(t) {
        $('tkSubject').textContent = (t.type ? '[' + t.type + '] ' : '') + (t.subject || 'Talep');
        const d = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleString('tr-TR') : '';
        $('tkMeta').textContent = ticketHotel(t) + ' · ' + (t.createdBy || '—') + ' · ' + d;
        $('tkStatus').value = t.status || 'Open';
        let html = `<div class="tk-msg"><div class="tk-who">${esc(t.createdBy || '—')} <span class="tk-when">otel</span></div><div class="tk-text">${esc(t.message || '')}</div></div>`;
        (t.replies || []).forEach(r => {
            const rwhen = r.at ? new Date(r.at).toLocaleString('tr-TR') : '';
            const mine = r.platform;
            html += `<div class="tk-msg ${mine ? 'tk-mine' : ''}"><div class="tk-who">${esc(r.by || '')} <span class="tk-when">${mine ? 'StayOS' : 'otel'} · ${rwhen}</span></div><div class="tk-text">${esc(r.text || '')}</div></div>`;
        });
        $('tkThread').innerHTML = html;
    }
    async function sendTicketReply() {
        if (!curTicketId) return;
        const text = $('tkReply').value.trim();
        const status = $('tkStatus').value;
        const btn = $('tkSend'); btn.disabled = true; btn.textContent = 'Kaydediliyor...';
        try {
            const upd = { status: status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
            if (text) {
                upd.replies = firebase.firestore.FieldValue.arrayUnion({
                    by: 'StayOS Destek', platform: true, text: text, at: new Date().toISOString()
                });
            }
            await db.collection('tickets').doc(curTicketId).update(upd);
            $('tkReply').value = '';
            toast('Kaydedildi');
        } catch (e) { $('tkErr').textContent = 'Hata: ' + e.message; }
        finally { btn.disabled = false; btn.textContent = 'Yanıtla & Kaydet'; }
    }

    // ======================================================================
    //  MUHASEBE (Finance)
    // ======================================================================
    let payments = [];          // tenant subscription renewal payments
    let finRange = 'month';     // month | lastMonth | quarter | year | all | custom
    let finTxTypeFilter = 'all';
    let billing = {};           // siteConfig/billing (seller + invoice settings)

    // Revenue is collected in EUR; the Muhasebe panel converts to TRY for
    // accounting using a manual rate (siteConfig/billing.fxRate). Per-plan
    // monthly EUR prices are editable in Ayarlar (defaults = pricing page base).
    const BILLING_DEFAULTS = {
        name: 'Burak Göl Şahıs Şirketi', addr: '', taxOffice: 'Arda Vergi Dairesi',
        taxNo: '1234567890', mersis: '000000000', iban: '', phone: '+90 (542) 307 4620',
        email: 'bu.gol@outlook.com', kdvRate: 20, series: 'SOS', nextNo: 1, notes: '',
        planStarter: 49, planPro: 99, planEnterprise: 199, fxRate: 0,
        lemonStoreId: '', lemonVariantStarter: '', lemonVariantPro: '', lemonVariantEnterprise: ''
    };
    function B(k) { return (billing && billing[k] != null && billing[k] !== '') ? billing[k] : BILLING_DEFAULTS[k]; }
    function currentKdvRate() { const r = Number(B('kdvRate')); return isFinite(r) ? r : 20; }
    function fxRate() { const r = Number(B('fxRate')); return (isFinite(r) && r > 0) ? r : 0; }
    function planPriceEur(key) {
        const map = { starter: 'planStarter', pro: 'planPro', enterprise: 'planEnterprise' };
        if (key === 'custom' || !map[key]) return 0;
        const v = Number(B(map[key]));
        return isFinite(v) ? v : 0;
    }
    function eurM(n) { const v = Number(n) || 0; return '€' + v.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
    function tryM(n, dec) { const r = fxRate(); if (!r) return '—'; const v = (Number(n) || 0) * r; return v.toLocaleString('tr-TR', { minimumFractionDigits: dec == null ? 0 : dec, maximumFractionDigits: dec == null ? 0 : dec }) + ' ₺'; }
    // tryM takes an EUR amount and returns its TRY string at the current rate.

    function subscribePayments() {
        db.collection('payments').onSnapshot(snap => {
            payments = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
            renderFinance();
        }, () => { });
    }

    function tsDate(ts) { return ts && ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : null); }
    function finMoney(n, dec) {
        const v = Number(n) || 0;
        return v.toLocaleString('tr-TR', { minimumFractionDigits: dec == null ? 0 : dec, maximumFractionDigits: dec == null ? 0 : dec }) + ' ₺';
    }
    function splitKdv(gross, ratePct) { const r = (Number(ratePct) || 0) / 100; const net = r ? gross / (1 + r) : gross; return { net, kdv: gross - net }; }
    function planLabel(key) { return (PLANS[key] || {}).name || key || '—'; }

    // ── Date range ─────────────────────────────────────────────
    function rangeBounds() {
        const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
        let from = null, to = null;
        if (finRange === 'month') { from = new Date(y, m, 1); to = new Date(y, m + 1, 1); }
        else if (finRange === 'lastMonth') { from = new Date(y, m - 1, 1); to = new Date(y, m, 1); }
        else if (finRange === 'quarter') { const q = Math.floor(m / 3); from = new Date(y, q * 3, 1); to = new Date(y, q * 3 + 3, 1); }
        else if (finRange === 'year') { from = new Date(y, 0, 1); to = new Date(y + 1, 0, 1); }
        else if (finRange === 'custom') {
            const f = $('finFrom').value, t = $('finTo').value;
            from = f ? new Date(f + 'T00:00:00') : null;
            if (t) { to = new Date(t + 'T00:00:00'); to.setDate(to.getDate() + 1); }
        }
        return { from, to };
    }
    function inRange(d, b) { if (!d) return false; if (b.from && d < b.from) return false; if (b.to && d >= b.to) return false; return true; }
    function rangeLabelText() {
        const b = rangeBounds();
        if (!b.from && !b.to) return 'Tüm zamanlar';
        const fmt = d => d ? d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' }) : '…';
        const end = b.to ? new Date(b.to.getTime() - 1) : null;
        return fmt(b.from) + ' – ' + fmt(end);
    }

    // Normalise any stored amount to EUR (the billing currency). Legacy records
    // (old subscription/checkout) were in TRY; new ones carry currency:'EUR'.
    function toEur(amount, currency) {
        const v = Number(amount) || 0;
        if (currency === 'EUR') return v;
        const r = fxRate();
        return r ? v / r : v; // TRY → EUR (best effort; needs the rate)
    }

    // ── Unified transaction model (gross is EUR) ───────────────
    function buildTx() {
        const tx = [];
        orders.forEach(o => {
            if (o.status !== 'success') return;
            const d = tsDate(o.paidAt) || tsDate(o.createdAt);
            tx.push({
                id: o.id, kind: 'new', date: d, hotel: (o.buyer && o.buyer.hotel) || '—',
                buyer: o.buyer || {}, cycle: o.cycle || 'monthly',
                detail: (o.cycle === 'annual' ? 'Yıllık' : 'Aylık') + ' Paket',
                gross: toEur(o.priceTRY, o.currency || 'TRY'), ref: o.oid || o.id, tenantId: o.sourceTenantId || ''
            });
        });
        payments.forEach(p => {
            if (p.status !== 'success') return;
            const d = tsDate(p.paidAt) || tsDate(p.createdAt);
            const t = tenants.find(x => x.id === p.tenantId);
            const hotel = t ? (t.name || p.tenantId) : (p.tenantId || '—');
            tx.push({
                id: p.id, kind: 'renewal', date: d, hotel: hotel,
                buyer: { hotel: hotel, email: (t && t.billingEmail) || '', phone: (t && t.billingPhone) || '' },
                cycle: 'monthly', detail: planLabel(p.plan) + ' · Yenileme',
                gross: toEur(p.amount != null ? p.amount : p.amountTRY, p.currency || 'EUR'), ref: p.oid || p.id, tenantId: p.tenantId || ''
            });
        });
        return tx.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
    }

    function finKpiCards(cards) {
        return cards.map(c => `<div class="kpi"><div class="top"><span class="lbl">${c.lbl}</span>
            <span class="ico ico-${c.ico}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.svg}</svg></span></div>
            <div class="val">${c.val}</div><div class="hint">${c.hint || ''}</div></div>`).join('');
    }
    const ICO = {
        money: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
        net: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/>',
        kdv: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
        cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
        repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
        trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'
    };

    // ── Master render (called on data/range changes) ───────────
    function renderFinance() {
        if (!document.getElementById('view-finance')) return;
        const lbl = $('finRangeLabel'); if (lbl) lbl.textContent = rangeLabelText();
        const banner = $('finRateBanner');
        if (banner) {
            const r = fxRate();
            if (r) { banner.className = 'fin-rate-banner'; banner.innerHTML = 'Tahsilat: <b>€ (EUR)</b> · Muhasebe kuru: <b>1€ = ' + r.toLocaleString('tr-TR') + ' ₺</b>'; }
            else { banner.className = 'fin-rate-banner warn'; banner.innerHTML = '⚠ EUR→TRY kuru girilmemiş — ₺ karşılıkları görünmüyor. <b>Ayarlar</b> sekmesinden kuru girin.'; }
        }
        const b = rangeBounds();
        const all = buildTx();
        const rng = all.filter(t => inRange(t.date, b));
        finRenderSummary(rng, all);
        finRenderTx(rng);
        finRenderMrr();
        finRebuildInvoiceSelect(all);
    }

    // Amounts in tx.gross are EUR (billing currency). finMoney → ₺ (accounting).
    function finRenderSummary(rng, all) {
        const kdvR = currentKdvRate();
        let gross = 0, newG = 0, renG = 0;
        rng.forEach(t => { gross += t.gross; if (t.kind === 'new') newG += t.gross; else renG += t.gross; });
        const tryGross = gross * fxRate();
        const { net, kdv } = splitKdv(tryGross, kdvR); // KDV in TRY (Türk muhasebesi)
        $('finKpis').innerHTML = finKpiCards([
            { lbl: 'Brüt Gelir', val: eurM(gross), hint: '≈ ' + tryM(gross) + ' · ' + rng.length + ' işlem', ico: 'green', svg: ICO.money },
            { lbl: 'Net Matrah (₺)', val: fxRate() ? finMoney(net, 0) : '—', hint: 'KDV hariç', ico: 'indigo', svg: ICO.net },
            { lbl: 'KDV ₺ (%' + kdvR + ')', val: fxRate() ? finMoney(kdv, 0) : '—', hint: 'Hesaplanan', ico: 'amber', svg: ICO.kdv },
            { lbl: 'Yeni Satış', val: eurM(newG), hint: rng.filter(t => t.kind === 'new').length + ' işlem', ico: 'slate', svg: ICO.cart },
            { lbl: 'Yenileme', val: eurM(renG), hint: rng.filter(t => t.kind === 'renewal').length + ' işlem', ico: 'green', svg: ICO.repeat }
        ]);

        // 12-month trend (€, from all tx, independent of selected range)
        const now = new Date(); const months = [];
        for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ y: d.getFullYear(), m: d.getMonth(), sum: 0 }); }
        all.forEach(t => { if (!t.date) return; const mm = months.find(x => x.y === t.date.getFullYear() && x.m === t.date.getMonth()); if (mm) mm.sum += t.gross; });
        const max = Math.max(1, ...months.map(x => x.sum));
        const mlbl = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
        $('finChart').innerHTML = months.map(x => {
            const h = Math.round((x.sum / max) * 100);
            const v = x.sum >= 1000 ? '€' + Math.round(x.sum / 1000) + 'k' : (x.sum ? '€' + Math.round(x.sum) : '');
            return `<div class="fin-bar-wrap" title="${eurM(x.sum)}"><div class="fin-bar-val">${v}</div>
                <div class="fin-bar" style="height:${h}%"></div><div class="fin-bar-lbl">${mlbl[x.m]}</div></div>`;
        }).join('');

        // By plan / type (€)
        const byPlan = {};
        rng.forEach(t => { const k = t.kind === 'new' ? ('Yeni Satış · ' + (t.cycle === 'annual' ? 'Yıllık' : 'Aylık')) : t.detail; byPlan[k] = byPlan[k] || { c: 0, g: 0 }; byPlan[k].c++; byPlan[k].g += t.gross; });
        const planRows = Object.keys(byPlan).sort((a, b) => byPlan[b].g - byPlan[a].g);
        $('finByPlan').innerHTML = planRows.length ? planRows.map(k =>
            `<tr><td>${esc(k)}</td><td style="text-align:right;">${byPlan[k].c}</td><td style="text-align:right;">${eurM(byPlan[k].g)}</td></tr>`).join('')
            : `<tr><td colspan="3"><div class="empty">Bu dönemde gelir yok.</div></td></tr>`;

        // Top hotels (€)
        const byHotel = {};
        rng.forEach(t => { byHotel[t.hotel] = byHotel[t.hotel] || { c: 0, g: 0 }; byHotel[t.hotel].c++; byHotel[t.hotel].g += t.gross; });
        const hotelRows = Object.keys(byHotel).sort((a, b) => byHotel[b].g - byHotel[a].g).slice(0, 8);
        $('finTopHotels').innerHTML = hotelRows.length ? hotelRows.map(k =>
            `<tr><td>${esc(k)}</td><td style="text-align:right;">${byHotel[k].c}</td><td style="text-align:right;">${eurM(byHotel[k].g)}</td></tr>`).join('')
            : `<tr><td colspan="3"><div class="empty">Bu dönemde gelir yok.</div></td></tr>`;
    }

    function finRenderTx(rng) {
        const kdvR = currentKdvRate();
        const rows = rng.filter(t => finTxTypeFilter === 'all' || t.kind === finTxTypeFilter);
        $('finTxCount').textContent = rows.length + ' işlem · ' + rangeLabelText();
        let gross = 0, kdv = 0;
        $('finTxBody').innerHTML = rows.length ? rows.map(t => {
            const s = splitKdv(t.gross * fxRate(), kdvR); kdv += s.kdv; gross += t.gross;
            return `<tr>
                <td>${fmtDate(t.date)}</td>
                <td>${esc(t.hotel)}</td>
                <td><span class="tx-badge ${t.kind}">${t.kind === 'new' ? 'Yeni Satış' : 'Yenileme'}</span></td>
                <td>${esc(t.detail)}</td>
                <td style="text-align:right;"><b>${eurM(t.gross)}</b></td>
                <td style="text-align:right;">${tryM(t.gross, 0)}</td>
                <td style="text-align:right;">${fxRate() ? finMoney(s.kdv, 0) : '—'}</td>
                <td style="text-align:right;"><button class="fin-inv-open" data-invtx="${esc(t.id)}">Fatura</button></td>
            </tr>`;
        }).join('') : `<tr><td colspan="8"><div class="empty">Bu dönemde işlem yok.</div></td></tr>`;
        $('finTxGross').textContent = eurM(gross);
        $('finTxTry').textContent = tryM(gross, 0);
        $('finTxKdv').textContent = fxRate() ? finMoney(kdv, 0) : '—';
    }

    function finRenderMrr() {
        const active = tenants.filter(t => { const k = statusOf(t).key; return k === 'active' || k === 'soon'; });
        const byPlan = {}; let mrr = 0;
        active.forEach(t => { const k = planKey(t); const price = planPriceEur(k); byPlan[k] = byPlan[k] || { c: 0, price: price, sum: 0 }; byPlan[k].c++; byPlan[k].sum += price; mrr += price; });
        $('finMrrKpis').innerHTML = finKpiCards([
            { lbl: 'MRR', val: eurM(mrr), hint: '≈ ' + tryM(mrr) + '/ay', ico: 'green', svg: ICO.repeat },
            { lbl: 'ARR', val: eurM(mrr * 12), hint: 'Yıllık tahmini · ≈ ' + tryM(mrr * 12), ico: 'indigo', svg: ICO.trend },
            { lbl: 'Aktif Abonelik', val: active.length, hint: 'Gelir getiren otel', ico: 'slate', svg: ICO.cart },
            { lbl: 'Ortalama (ARPA)', val: eurM(active.length ? mrr / active.length : 0), hint: 'Otel başına/ay', ico: 'amber', svg: ICO.money }
        ]);
        const order = ['starter', 'pro', 'enterprise', 'custom'];
        $('finMrrByPlan').innerHTML = order.filter(k => byPlan[k]).map(k =>
            `<tr><td>${planLabel(k)}</td><td style="text-align:right;">${byPlan[k].c}</td><td style="text-align:right;">${byPlan[k].price ? eurM(byPlan[k].price) : '—'}</td><td style="text-align:right;"><b>${eurM(byPlan[k].sum)}</b></td></tr>`).join('')
            || `<tr><td colspan="4"><div class="empty">Aktif abonelik yok.</div></td></tr>`;

        const soon = tenants.map(t => ({ t, s: statusOf(t) }))
            .filter(x => x.s.end && x.s.days != null && x.s.days >= 0 && x.s.days <= 30 && x.s.key !== 'suspended' && x.s.key !== 'archived')
            .sort((a, b) => a.s.days - b.s.days);
        $('finUpcoming').innerHTML = soon.length ? soon.map(({ t, s }) =>
            `<tr><td>${esc(t.name || t.id)}</td><td>${fmtDate(s.end)} · ${s.days}g</td><td style="text-align:right;">${eurM(planPriceEur(planKey(t)))}</td></tr>`).join('')
            : `<tr><td colspan="3"><div class="empty">30 gün içinde yenileme yok.</div></td></tr>`;
    }

    // ── Invoice ────────────────────────────────────────────────
    let invTxCache = [];
    function finRebuildInvoiceSelect(all) {
        invTxCache = all;
        const sel = $('invTx'); if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = '<option value="">— Elle giriş —</option>' + all.slice(0, 300).map(t =>
            `<option value="${esc(t.id)}">${fmtDate(t.date)} · ${esc(t.hotel)} · ${eurM(t.gross)} (${t.kind === 'new' ? 'Yeni' : 'Yenileme'})</option>`).join('');
        if (cur) sel.value = cur;
    }
    function prefillInvoiceFromTx(id) {
        const t = invTxCache.find(x => x.id === id); if (!t) return;
        const b = t.buyer || {};
        $('invBuyerName').value = b.hotel || t.hotel || '';
        $('invBuyerAddr').value = b.address || '';
        $('invBuyerTaxOffice').value = '';
        $('invBuyerTaxNo').value = '';
        $('invBuyerEmail').value = b.email || '';
        $('invBuyerPhone').value = b.phone || '';
        $('invDesc').value = 'StayOS · ' + t.detail;
        $('invGross').value = t.gross;            // EUR
        if ($('invFx') && !$('invFx').value) $('invFx').value = fxRate() || '';
        $('invDate').value = (t.date || new Date()).toISOString().slice(0, 10);
        renderInvoicePreview();
    }
    // The invoice is issued in TRY (Türk muhasebesi): the EUR amount is converted
    // at the entered rate, then KDV is computed on the TRY figure.
    function renderInvoicePreview() {
        const grossEur = Number($('invGross').value) || 0;
        const kdvRate = Number($('invKdv').value) || 0;
        const fx = Number($('invFx').value) || fxRate();
        const grossTry = grossEur * fx;
        const { net, kdv } = splitKdv(grossTry, kdvRate);
        const m = (n, d) => (Number(n) || 0).toLocaleString('tr-TR', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }) + ' ₺';
        const dateStr = $('invDate').value ? new Date($('invDate').value + 'T00:00:00').toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
        const noStr = ($('invSeries').value || B('series') || '') + (($('invSeries').value || B('series')) ? '-' : '') + ($('invNo').value || '');
        const sellerLines = [B('addr'), (B('taxOffice') ? 'V.D.: ' + B('taxOffice') : '') + (B('taxNo') ? ' · VKN: ' + B('taxNo') : ''), B('mersis') ? 'MERSİS: ' + B('mersis') : '', [B('phone'), B('email')].filter(Boolean).join(' · '), B('iban') ? 'IBAN: ' + B('iban') : ''].filter(Boolean);
        const buyerLines = [$('invBuyerAddr').value, ([$('invBuyerTaxOffice').value ? 'V.D.: ' + $('invBuyerTaxOffice').value : '', $('invBuyerTaxNo').value ? 'VKN/TCKN: ' + $('invBuyerTaxNo').value : ''].filter(Boolean).join(' · ')), [$('invBuyerEmail').value, $('invBuyerPhone').value].filter(Boolean).join(' · ')].filter(Boolean);
        const fxNote = fx ? ('Döviz: ' + eurM(grossEur) + ' · Kur: 1€ = ' + fx.toLocaleString('tr-TR') + ' ₺') : '⚠ Kur girilmedi — tutarlar 0 ₺';
        $('invPreview').innerHTML = `<div class="inv-doc" id="invDoc">
            <div class="inv-top">
                <div class="inv-seller"><b>${esc(B('name'))}</b>${sellerLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
                <div class="inv-title"><h2>FATURA</h2><div class="inv-meta">No: ${esc(noStr || '—')}<br>Tarih: ${esc(dateStr)}</div></div>
            </div>
            <div class="inv-parties">
                <div><h4>Satıcı</h4><div>${esc(B('name'))}</div></div>
                <div><h4>Alıcı</h4><div><b>${esc($('invBuyerName').value || '—')}</b></div>${buyerLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
            </div>
            <table class="inv-tbl">
                <thead><tr><th>Açıklama</th><th class="r">Matrah</th><th class="r">KDV (%${kdvRate})</th><th class="r">Tutar</th></tr></thead>
                <tbody><tr><td>${esc($('invDesc').value || 'StayOS aboneliği')}</td><td class="r">${m(net)}</td><td class="r">${m(kdv)}</td><td class="r">${m(grossTry)}</td></tr></tbody>
            </table>
            <div class="inv-totals">
                <div class="row"><span>Matrah</span><span>${m(net)}</span></div>
                <div class="row"><span>KDV (%${kdvRate})</span><span>${m(kdv)}</span></div>
                <div class="row grand"><span>Genel Toplam</span><span>${m(grossTry)}</span></div>
            </div>
            <div class="inv-foot">${esc(fxNote)}<br>${esc(B('notes') || '')}${B('notes') ? '<br>' : ''}Bu belge bilgilendirme amaçlı bir taslaktır; resmi e-Fatura/e-Arşiv yerine geçmez.</div>
        </div>`;
    }
    function printInvoice() {
        const doc = document.getElementById('invDoc');
        if (!doc) { toast('Önce fatura alanlarını doldurun', true); return; }
        const css = `body{font-family:Inter,system-ui,sans-serif;color:#1e293b;padding:32px;max-width:780px;margin:0 auto;}
            .inv-top{display:flex;justify-content:space-between;border-bottom:2px solid #1e293b;padding-bottom:16px;margin-bottom:18px;}
            .inv-seller b{font-size:17px;} .inv-seller div,.inv-buyer div,.inv-parties div{font-size:12px;color:#475569;line-height:1.6;}
            .inv-title{text-align:right;} .inv-title h2{margin:0;font-size:22px;letter-spacing:1px;} .inv-meta{font-size:12px;color:#64748b;margin-top:6px;}
            .inv-parties{display:flex;gap:24px;margin-bottom:18px;} .inv-parties>div{flex:1;} .inv-parties h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;color:#94a3b8;}
            .inv-tbl{width:100%;border-collapse:collapse;margin:6px 0 16px;} .inv-tbl th{text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid #e2e8f0;padding:8px 6px;}
            .inv-tbl td{padding:10px 6px;border-bottom:1px solid #eef2f7;font-size:13px;} .inv-tbl .r{text-align:right;}
            .inv-totals{margin-left:auto;width:260px;} .inv-totals .row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#475569;}
            .inv-totals .row.grand{border-top:2px solid #1e293b;margin-top:6px;padding-top:10px;font-size:16px;font-weight:800;color:#1e293b;}
            .inv-foot{margin-top:22px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#94a3b8;line-height:1.6;}`;
        const w = window.open('', '_blank', 'width=820,height=900');
        if (!w) { toast('Pop-up engellendi', true); return; }
        w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Fatura</title><style>' + css + '</style></head><body>' + doc.innerHTML + '</body></html>');
        w.document.close();
        w.focus();
        setTimeout(() => { w.print(); }, 250);
    }

    // ── CSV export ─────────────────────────────────────────────
    function exportFinCsv() {
        const b = rangeBounds();
        const kdvR = currentKdvRate();
        const fx = fxRate();
        const rows = buildTx().filter(t => inRange(t.date, b)).filter(t => finTxTypeFilter === 'all' || t.kind === finTxTypeFilter);
        const head = ['Tarih', 'Otel', 'Tur', 'Detay', 'Brut_EUR', 'Kur', 'Brut_TRY', 'Matrah_TRY', 'KDV_TRY', 'Referans'];
        const lines = [head.join(';')];
        rows.forEach(t => {
            const grossTry = t.gross * fx;
            const s = splitKdv(grossTry, kdvR);
            const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
            lines.push([
                t.date ? t.date.toISOString().slice(0, 10) : '',
                t.hotel, t.kind === 'new' ? 'Yeni Satis' : 'Yenileme', t.detail,
                t.gross.toFixed(2), fx || '', grossTry.toFixed(2), s.net.toFixed(2), s.kdv.toFixed(2), t.ref
            ].map(cell).join(';'));
        });
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'muhasebe-' + finRange + '-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }

    // ── Settings (siteConfig/billing) ──────────────────────────
    function fillSettingsForm() {
        const map = { setName: 'name', setAddr: 'addr', setTaxOffice: 'taxOffice', setTaxNo: 'taxNo', setMersis: 'mersis', setIban: 'iban', setPhone: 'phone', setEmail: 'email', setKdv: 'kdvRate', setSeries: 'series', setNextNo: 'nextNo', setNotes: 'notes', setPlanStarter: 'planStarter', setPlanPro: 'planPro', setPlanEnterprise: 'planEnterprise', setLemonStore: 'lemonStoreId', setLemonStarter: 'lemonVariantStarter', setLemonPro: 'lemonVariantPro', setLemonEnt: 'lemonVariantEnterprise' };
        Object.keys(map).forEach(id => { const el = $(id); if (el) el.value = B(map[id]); });
        const fxEl = $('setFxRate'); if (fxEl) fxEl.value = fxRate() || '';
        // Invoice defaults
        if ($('invKdv')) $('invKdv').value = currentKdvRate();
        if ($('invFx')) $('invFx').value = fxRate() || '';
        if ($('invSeries')) $('invSeries').value = B('series');
        if ($('invNo')) $('invNo').value = B('nextNo');
        if ($('invDate') && !$('invDate').value) $('invDate').value = new Date().toISOString().slice(0, 10);
    }
    function loadFinSettings() {
        db.collection('siteConfig').doc('billing').get().then(s => {
            billing = s.exists ? s.data() : {};
            fillSettingsForm(); renderFinance(); renderInvoicePreview();
        }).catch(() => { fillSettingsForm(); });
    }
    async function saveFinSettings() {
        const data = {
            name: $('setName').value.trim(), addr: $('setAddr').value.trim(), taxOffice: $('setTaxOffice').value.trim(),
            taxNo: $('setTaxNo').value.trim(), mersis: $('setMersis').value.trim(), iban: $('setIban').value.trim(),
            phone: $('setPhone').value.trim(), email: $('setEmail').value.trim(),
            kdvRate: Number($('setKdv').value) || 0,
            series: $('setSeries').value.trim(), nextNo: Number($('setNextNo').value) || 1, notes: $('setNotes').value.trim(),
            planStarter: Number($('setPlanStarter').value) || 0, planPro: Number($('setPlanPro').value) || 0,
            planEnterprise: Number($('setPlanEnterprise').value) || 0, fxRate: Number($('setFxRate').value) || 0,
            lemonStoreId: (($('setLemonStore') || {}).value || '').trim(),
            lemonVariantStarter: (($('setLemonStarter') || {}).value || '').trim(),
            lemonVariantPro: (($('setLemonPro') || {}).value || '').trim(),
            lemonVariantEnterprise: (($('setLemonEnt') || {}).value || '').trim()
        };
        const btn = $('setSave'); btn.disabled = true; btn.textContent = 'Kaydediliyor...';
        try {
            await db.collection('siteConfig').doc('billing').set(data, { merge: true });
            billing = data;
            const ok = $('setSaved'); ok.style.display = 'inline'; setTimeout(() => ok.style.display = 'none', 2200);
            fillSettingsForm(); renderFinance(); renderInvoicePreview();
        } catch (e) { toast('Hata: ' + e.message, true); }
        finally { btn.disabled = false; btn.textContent = 'Kaydet'; }
    }

    function switchFinTab(name) {
        document.querySelectorAll('.fin-tab').forEach(t => t.classList.toggle('active', t.dataset.fin === name));
        document.querySelectorAll('.fin-panel').forEach(p => p.classList.toggle('active', p.id === 'fin-' + name));
    }

    // ---------- events ----------
    $('hotelsBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (btn) {
            const id = btn.dataset.id;
            if (btn.dataset.act === 'sub') openSubModal(id);
            else if (btn.dataset.act === 'pkg') openPkgModal(id);
            else if (btn.dataset.act === 'toggle') toggleSuspend(id, btn.dataset.suspended === 'true');
            return;
        }
        const row = e.target.closest('tr[data-hotel]');
        if (row) openHotelDrawer(row.dataset.hotel);
    });
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);
    $('dEdit').addEventListener('click', openEditModal);
    $('dSubBtn').addEventListener('click', () => openSubModal(drawerTenantId));
    $('dPkgBtn').addEventListener('click', () => openPkgModal(drawerTenantId));
    $('dPmsBtn').addEventListener('click', () => openPmsModal(drawerTenantId));
    $('dToggle').addEventListener('click', () => { const t = tenants.find(x => x.id === drawerTenantId); if (t) toggleSuspend(t.id, t.suspended === true); });
    $('dDelete').addEventListener('click', openDeleteModal);
    $('dAddUser').addEventListener('click', openAddUserModal);
    $('editSave').addEventListener('click', saveEdit);
    $('uaCreate').addEventListener('click', createDrawerUser);
    $('delConfirmBtn').addEventListener('click', doDeleteHotel);
    document.querySelectorAll('input[name="delMode"]').forEach(r => r.addEventListener('change', syncDelButton));
    $('dUserList').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-uact]');
        if (!btn) return;
        const uid = btn.dataset.uid, uname = btn.dataset.uname;
        if (btn.dataset.uact === 'reset') {
            if (!confirm(`${uname} için şifre sıfırlansın mı?\n\nKullanıcı mevcut şifresiyle bir kez girip yeni şifre belirleyecek.`)) return;
            try {
                await db.collection('systemUsers').doc(uid).update({ mustChangePassword: true, passwordResetAt: firebase.firestore.FieldValue.serverTimestamp() });
                toast('Şifre sıfırlama istendi');
            } catch (e2) { toast('Hata: ' + e2.message, true); }
        } else if (btn.dataset.uact === 'remove') {
            if (!confirm(`${uname} kaldırılsın mı? Bu kullanıcı giriş yapamayacak.`)) return;
            try {
                // Server-side delete removes the Auth account too, so the same
                // username can be issued again later.
                const deleteUser = firebase.app().functions('us-central1').httpsCallable('deleteUser');
                await deleteUser({ uid: uid });
                toast('Kullanıcı kaldırıldı');
                await refresh();
                loadDrawerUsers(drawerTenantId);
            } catch (e2) { toast('Hata: ' + e2.message, true); }
        }
    });
    $('ordersBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act="provision"]');
        if (btn) {
            const order = orders.find(o => o.id === btn.dataset.id);
            if (order) openHotelModal(order);
            return;
        }
        const row = e.target.closest('tr[data-order]');
        if (row) openOrderDrawer(row.dataset.order);
    });
    $('orderFilters').addEventListener('click', (e) => {
        const tab = e.target.closest('.o-tab');
        if (!tab) return;
        orderFilter = tab.dataset.filter;
        $('orderFilters').querySelectorAll('.o-tab').forEach(t => t.classList.toggle('active', t === tab));
        renderOrders();
    });
    $('orderSearch').addEventListener('input', (e) => {
        orderSearch = e.target.value.trim().toLowerCase();
        renderOrders();
    });
    $('orderDrawerClose').addEventListener('click', closeOrderDrawer);
    $('orderDrawerBackdrop').addEventListener('click', closeOrderDrawer);
    $('odNoteSave').addEventListener('click', saveOrderNote);
    $('odActions').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-oact]');
        if (!btn) return;
        const o = orders.find(x => x.id === drawerOrderId); if (!o) return;
        if (btn.dataset.oact === 'provision') { closeOrderDrawer(); openHotelModal(o); }
        else if (btn.dataset.oact === 'archive') toggleOrderArchive();
        else if (btn.dataset.oact === 'delete') deleteOrder();
    });
    $('newHotelBtn').addEventListener('click', () => openHotelModal());
    $('nhCreate').addEventListener('click', createHotel);
    $('nhPlan').addEventListener('change', () => applyPlanToForm($('nhPlan'), $('nhMaxUsers'), $('nhModules')));
    $('pkgPlan').addEventListener('change', () => applyPlanToForm($('pkgPlan'), $('pkgMaxUsers'), $('pkgModules')));
    $('pkgSave').addEventListener('click', savePkg);
    $('subSave').addEventListener('click', saveSub);
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
        b.closest('.modal-backdrop').classList.remove('show');
    }));
    document.querySelectorAll('.modal-backdrop').forEach(m => m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.remove('show');
    }));

    // Navigation
    document.querySelectorAll('.sb-link').forEach(link => link.addEventListener('click', () => {
        document.querySelectorAll('.sb-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        const view = link.dataset.view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        $('view-' + view).classList.add('active');
        const titles = { overview: ['Genel Bakış', 'Platform genelinde özet'], hotels: ['Oteller', 'Tüm otelleri yönetin'], orders: ['Siparişler', 'Tanıtım sitesinden gelen ödemeler'], tickets: ['Destek', 'Otellerden gelen sorun, istek ve öneriler'], finance: ['Muhasebe', 'Gelir, KDV, abonelik ve fatura'], site: ['Site', 'Apex tanıtım sayfası görünümü'] };
        $('pageTitle').textContent = titles[view][0];
        $('pageSub').textContent = titles[view][1];
        $('sidebar').classList.remove('open');
    }));
    $('menuToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));

    // ---------- support (tickets) events ----------
    $('ticketFilters').addEventListener('click', (e) => {
        const b = e.target.closest('.o-tab'); if (!b) return;
        ticketFilter = b.dataset.tf;
        $('ticketFilters').querySelectorAll('.o-tab').forEach(x => x.classList.toggle('active', x === b));
        renderTickets();
    });
    $('ticketSearch').addEventListener('input', (e) => { ticketSearch = e.target.value; renderTickets(); });
    $('ticketsBody').addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-ticket]'); if (row) openTicketModal(row.dataset.ticket);
    });
    $('tkSend').addEventListener('click', sendTicketReply);

    // ---------- finance events ----------
    $('finRange').addEventListener('click', (e) => {
        const btn = e.target.closest('.fin-rg'); if (!btn) return;
        finRange = btn.dataset.range;
        $('finRange').querySelectorAll('.fin-rg').forEach(b => b.classList.toggle('active', b === btn));
        $('finCustom').hidden = finRange !== 'custom';
        renderFinance();
    });
    $('finFrom').addEventListener('change', renderFinance);
    $('finTo').addEventListener('change', renderFinance);
    $('finTabs').addEventListener('click', (e) => { const t = e.target.closest('.fin-tab'); if (t) switchFinTab(t.dataset.fin); });
    $('finTxType').addEventListener('change', (e) => { finTxTypeFilter = e.target.value; renderFinance(); });
    $('finExportCsv').addEventListener('click', exportFinCsv);
    $('finTxBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-invtx]'); if (!btn) return;
        switchFinTab('invoice');
        $('invTx').value = btn.dataset.invtx;
        prefillInvoiceFromTx(btn.dataset.invtx);
    });
    $('invTx').addEventListener('change', (e) => { if (e.target.value) prefillInvoiceFromTx(e.target.value); else renderInvoicePreview(); });
    ['invBuyerName', 'invBuyerAddr', 'invBuyerTaxOffice', 'invBuyerTaxNo', 'invBuyerEmail', 'invBuyerPhone', 'invDesc', 'invGross', 'invKdv', 'invFx', 'invSeries', 'invNo', 'invDate']
        .forEach(id => { const el = $(id); if (el) el.addEventListener('input', renderInvoicePreview); });
    $('invPrint').addEventListener('click', printInvoice);
    $('setSave').addEventListener('click', saveFinSettings);

    // ── Apex tanıtım sayfası görünümü (Açık / Yakında / Bakımda) ──
    (function () {
        const saveBtn = $('apexSave');
        if (!saveBtn) return;
        const setRadio = (mode) => {
            const r = document.querySelector('input[name="apexMode"][value="' + mode + '"]');
            if (r) r.checked = true;
        };
        db.collection('siteConfig').doc('apex').get()
            .then(doc => setRadio((doc.exists && doc.data().mode) || 'open'))
            .catch(() => setRadio('open'));
        saveBtn.addEventListener('click', () => {
            const sel = document.querySelector('input[name="apexMode"]:checked');
            const mode = sel ? sel.value : 'open';
            saveBtn.disabled = true; saveBtn.textContent = 'Kaydediliyor...';
            db.collection('siteConfig').doc('apex').set(
                { mode, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
                .then(() => { const s = $('apexSaved'); if (s) { s.style.display = 'inline'; setTimeout(() => { s.style.display = 'none'; }, 2500); } })
                .catch(e => { console.error(e); alert('Kaydedilemedi.'); })
                .finally(() => { saveBtn.disabled = false; saveBtn.textContent = 'Kaydet'; });
        });
    })();

    // ---------- auth ----------
    $('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('loginBtn'); btn.disabled = true;
        $('loginErr').textContent = '';
        try {
            await auth.signInWithEmailAndPassword($('suEmail').value.trim(), $('suPass').value);
        } catch (err) {
            $('loginErr').textContent = 'Giriş başarısız. E-posta veya şifre hatalı.';
            btn.disabled = false;
        }
    });
    $('logoutBtn').addEventListener('click', () => auth.signOut());
    $('deniedLogout').addEventListener('click', () => auth.signOut());
    $('copyUid').addEventListener('click', () => {
        const uid = $('deniedUid').textContent;
        navigator.clipboard.writeText(uid).then(() => {
            const b = $('copyUid'); b.textContent = 'Kopyalandı ✓';
            setTimeout(() => { b.textContent = 'Kopyala'; }, 1600);
        });
    });

    function show(screen) {
        loginScreen.classList.toggle('hidden', screen !== 'login');
        deniedScreen.classList.toggle('hidden', screen !== 'denied');
        consoleEl.classList.toggle('hidden', screen !== 'console');
    }

    auth.onAuthStateChanged(async (user) => {
        $('loginBtn').disabled = false;
        if (!user) { show('login'); return; }
        // Verify platform-operator membership.
        let isSuper = false;
        try {
            const doc = await db.collection('superAdmins').doc(user.uid).get();
            isSuper = doc.exists;
        } catch (e) { isSuper = false; }
        if (!isSuper) {
            $('deniedUid').textContent = user.uid;
            show('denied');
            return;
        }

        // Fill operator identity
        $('sbEmail').textContent = user.email || '';
        $('sbName').textContent = (user.email || 'Operatör').split('@')[0];
        $('sbAvatar').textContent = initials(user.email || 'OP');

        show('console');
        await ensureDefaultTenant();
        subscribeTenants();
        subscribeOrders();
        subscribeQuotes();
        subscribePayments();
        subscribeTickets();
        loadFinSettings();
        await refresh();
    });
})();
