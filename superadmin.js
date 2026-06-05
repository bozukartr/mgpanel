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

    // ---------- render ----------
    function render() {
        renderKpis();
        renderRenewals();
        renderHotels();
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
            const created = t.createdAt && t.createdAt.toDate ? fmtDate(t.createdAt.toDate()) : '—';
            const count = userCountByTenant[t.id] || 0;
            const suspended = t.suspended === true;
            return `
            <tr>
                <td><div class="hotel-cell"><div class="av">${esc(initials(t.name || t.id))}</div><div><b>${esc(t.name || t.id)}</b><div class="mono">${esc(t.id)}.stayos.org</div></div></div></td>
                <td><span class="pill ${s.cls}">${s.label}</span></td>
                <td>${fmtDate(s.end)}</td>
                <td>${count}</td>
                <td>${created}</td>
                <td><div class="row-actions">
                    <button class="icon-btn" title="Abonelik" data-act="sub" data-id="${esc(t.id)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
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
        $('nhUser').value = 'admin';
        const d = new Date(); d.setMonth(d.getMonth() + 1);
        $('nhSubEnd').value = d.toISOString().slice(0, 10);
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
        const err = $('nhErr');
        err.textContent = '';

        if (!name) return err.textContent = 'Otel adı gerekli.';
        if (!/^[a-z0-9-]{2,24}$/.test(slug)) return err.textContent = 'Otel kodu küçük harf/rakam/tire, 2-24 karakter olmalı.';
        if (tenants.some(t => t.id === slug)) return err.textContent = 'Bu otel kodu zaten kullanımda.';
        if (!user) return err.textContent = 'Yönetici kullanıcı adı gerekli.';
        if (pass.length < 6) return err.textContent = 'Şifre en az 6 karakter olmalı.';
        if (!subEnd) return err.textContent = 'Abonelik bitiş tarihi gerekli.';

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
            toast(name + ' oluşturuldu');
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

    // ---------- events ----------
    $('hotelsBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.dataset.id;
        if (btn.dataset.act === 'sub') openSubModal(id);
        else if (btn.dataset.act === 'toggle') toggleSuspend(id, btn.dataset.suspended === 'true');
    });
    $('newHotelBtn').addEventListener('click', openHotelModal);
    $('nhCreate').addEventListener('click', createHotel);
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
        if (!isSuper) { show('denied'); return; }

        // Fill operator identity
        $('sbEmail').textContent = user.email || '';
        $('sbName').textContent = (user.email || 'Operatör').split('@')[0];
        $('sbAvatar').textContent = initials(user.email || 'OP');

        show('console');
        subscribeTenants();
        await refresh();
    });
})();
