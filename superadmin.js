/* ===== StayOS — Superadmin Console ===== */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    // Screens
    const loginScreen  = $('loginScreen');
    const deniedScreen = $('deniedScreen');
    const consoleEl    = $('console');

    let tenants = [];          // [{ id, ...data }]
    let userCountByTenant = {}; // { tenantId: n }
    let currentSubTenant = null;
    let drawerTenantId = null;

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
        starter:    { name: 'Başlangıç',   maxUsers: 5,  modules: { concierge: true, crm: false, guestIssues: true } },
        pro:        { name: 'Profesyonel', maxUsers: 25, modules: { concierge: true, crm: true,  guestIssues: true } },
        enterprise: { name: 'Kurumsal',    maxUsers: 0,  modules: { concierge: true, crm: true,  guestIssues: true } },
        custom:     { name: 'Özel',        maxUsers: 0,  modules: { concierge: true, crm: true,  guestIssues: true } }
    };
    const MODULE_KEYS = ['concierge', 'crm', 'guestIssues'];
    const MODULE_LABELS = { concierge: 'Concierge', crm: 'CRM', guestIssues: 'Kayıtlar' };

    function planKey(t) { return (t && t.plan && PLANS[t.plan]) ? t.plan : 'custom'; }
    function planName(t) { return PLANS[planKey(t)].name; }
    function modulesOf(t) { return (t && t.modules) ? t.modules : { concierge: true, crm: true, guestIssues: true }; }
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
                modules: { concierge: true, crm: true, guestIssues: true },
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
        if (drawerTenantId) refreshDrawerStats();
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
            .filter(x => x.s.end && x.s.days >= 0 && x.s.days <= 14 && x.s.key !== 'suspended')
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

    // New hotel
    function openHotelModal() {
        ['nhName', 'nhSlug', 'nhUser', 'nhPass'].forEach(id => $(id).value = '');
        $('nhSlug').dataset.touched = '';
        $('nhUser').value = 'admin';
        const d = new Date(); d.setMonth(d.getMonth() + 1);
        $('nhSubEnd').value = d.toISOString().slice(0, 10);
        $('nhPlan').value = 'pro';
        applyPlanToForm($('nhPlan'), $('nhMaxUsers'), $('nhModules'));
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
            await db.collection('tenants').doc(slug).set({
                id: slug,
                name: name,
                emailDomain: tenantEmailDomain(slug),
                subscriptionEnd: firebase.firestore.Timestamp.fromDate(endDate),
                suspended: false,
                plan: plan,
                maxUsers: maxUsersVal,
                modules: mods,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

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
            await db.collection('tenants').doc(id).update({ suspended: !suspended });
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
        $('dToggle').textContent = t.suspended ? 'Aktifleştir' : 'Askıya Al';
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
    function openDeleteModal() {
        const t = tenants.find(x => x.id === drawerTenantId); if (!t) return;
        $('delHotel').textContent = (t.name || t.id) + ' · ' + t.id;
        $('delCode').textContent = t.id;
        $('delConfirm').value = '';
        $('delErr').textContent = '';
        $('deleteModal').classList.add('show');
    }
    async function doDeleteHotel() {
        const t = tenants.find(x => x.id === drawerTenantId); if (!t) return;
        const err = $('delErr'); err.textContent = '';
        if ($('delConfirm').value.trim() !== t.id) return err.textContent = 'Otel kodu eşleşmiyor.';
        const btn = $('delConfirmBtn'); btn.disabled = true; btn.textContent = 'Siliniyor...';
        try {
            // Remove the hotel's user accounts (revokes access), then the tenant document.
            const snap = await db.collection('systemUsers').where('tenantId', '==', t.id).get();
            const batch = db.batch();
            snap.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            await db.collection('tenants').doc(t.id).delete();
            $('deleteModal').classList.remove('show');
            closeDrawer();
            toast(t.name + ' silindi');
            await refresh();
        } catch (e) { err.textContent = 'Hata: ' + e.message; }
        finally { btn.disabled = false; btn.textContent = 'Kalıcı Olarak Sil'; }
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
    $('dToggle').addEventListener('click', () => { const t = tenants.find(x => x.id === drawerTenantId); if (t) toggleSuspend(t.id, t.suspended === true); });
    $('dDelete').addEventListener('click', openDeleteModal);
    $('dAddUser').addEventListener('click', openAddUserModal);
    $('editSave').addEventListener('click', saveEdit);
    $('uaCreate').addEventListener('click', createDrawerUser);
    $('delConfirmBtn').addEventListener('click', doDeleteHotel);
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
                await db.collection('systemUsers').doc(uid).delete();
                toast('Kullanıcı kaldırıldı');
                await refresh();
                loadDrawerUsers(drawerTenantId);
            } catch (e2) { toast('Hata: ' + e2.message, true); }
        }
    });
    $('newHotelBtn').addEventListener('click', openHotelModal);
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
        const titles = { overview: ['Genel Bakış', 'Platform genelinde özet'], hotels: ['Oteller', 'Tüm otelleri yönetin'] };
        $('pageTitle').textContent = titles[view][0];
        $('pageSub').textContent = titles[view][1];
        $('sidebar').classList.remove('open');
    }));
    $('menuToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));

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
        await refresh();
    });
})();
