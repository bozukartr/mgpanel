/* Hotizy — dashboard.js · Ana panel: canlı KPI'lar + aktivite akışı.
   Tenant izolasyonu (TENANT_ID) ve modül bayraklarıyla uyumlu. */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof auth === 'undefined') return;

    const $ = id => document.getElementById(id);
    const TENANT = (typeof TENANT_ID !== 'undefined' && TENANT_ID) || localStorage.getItem('hotelTenantId') || 'mgallery';
    const USERNAME = localStorage.getItem('hotelUsername') || '';
    const ROLE = (localStorage.getItem('hotelRole') || '').toLowerCase();

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const ms = ts => (ts && ts.toMillis ? ts.toMillis() : (typeof ts === 'number' ? ts : 0));
    function timeAgo(t) {
        if (!t) return '';
        const s = Math.floor((Date.now() - t) / 1000);
        if (s < 60) return 'az önce';
        const m = Math.floor(s / 60); if (m < 60) return m + ' dk önce';
        const h = Math.floor(m / 60); if (h < 24) return h + ' sa önce';
        const d = Math.floor(h / 24); if (d < 7) return d + ' gün önce';
        return new Date(t).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
    }
    function fmtDur(v) {
        if (v == null) return '—';
        const h = v / 3600000;
        if (h >= 24) return (h / 24).toFixed(1).replace('.0', '') + ' gün';
        if (h >= 1) return h.toFixed(1).replace('.0', '') + ' sa';
        return Math.max(1, Math.round(v / 60000)) + ' dk';
    }

    // ── State ──────────────────────────────────────────────────
    let reservations = [];
    let logs = [];

    // ── Header / greeting ──────────────────────────────────────
    function initHeader() {
        const name = USERNAME ? (USERNAME.charAt(0).toUpperCase() + USERNAME.slice(1)) : 'Ekip';
        const hour = new Date().getHours();
        const greet = hour < 6 ? 'İyi geceler' : hour < 12 ? 'Günaydın' : hour < 18 ? 'İyi günler' : 'İyi akşamlar';
        $('dashGreet').textContent = `${greet}, ${name} 👋`;
        $('dashDate').textContent = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        $('dashUser').textContent = name;
        $('dashRole').textContent = ROLE ? (ROLE.charAt(0).toUpperCase() + ROLE.slice(1)) : 'Personel';
        $('dashAvatar').textContent = (USERNAME.slice(0, 2) || '··').toUpperCase();
        if (ROLE === 'admin' || USERNAME.toLowerCase() === 'admin') {
            const a = $('dashAdminNav'); if (a) a.style.display = '';
        }
        $('dashLogout').onclick = () => { try { auth.signOut(); } catch (e) {} location.href = 'login.html'; };
    }

    // ── KPI hesapları ──────────────────────────────────────────
    function reservationOverdue(r) {
        if (r.status !== 'Pending' || !r.date) return false;
        let t = (r.time && /^\d{1,2}:\d{2}/.test(r.time)) ? r.time : '23:59';
        if (t.length === 4) t = '0' + t;
        const dt = new Date(r.date + 'T' + t);
        return !isNaN(dt) && dt.getTime() < Date.now();
    }

    function renderKpis() {
        // Concierge talepleri (Pending rezervasyonlar)
        const open = reservations.filter(r => r.status === 'Pending');
        const overdue = open.filter(reservationOverdue).length;
        $('kpiResOpen').textContent = open.length;
        const ov = $('kpiResOverdue');
        ov.innerHTML = '<span class="dot"></span>' + (overdue > 0 ? overdue + ' geciken' : 'Geciken yok');
        ov.className = 'kpi-sub ' + (overdue > 0 ? 'warn' : 'ok');

        // Açık şikayetler
        const openC = logs.filter(l => l.type === 'complaint' && l.status !== 'Solved');
        const inProg = openC.filter(l => l.status === 'InProgress').length;
        $('kpiComplaints').textContent = openC.length;
        const cs = $('kpiComplaintsSub');
        cs.innerHTML = '<span class="dot"></span>' + (openC.length ? inProg + ' işlemde' : 'Açık şikayet yok');
        cs.className = 'kpi-sub ' + (openC.length ? (inProg ? 'warn' : 'mut') : 'ok');

        // Ortalama çözüm süresi (son 30 gün, çözülenler)
        const cutoff = Date.now() - 30 * 86400000;
        let sum = 0, n = 0;
        logs.forEach(l => {
            if (l.status !== 'Solved') return;
            const c = ms(l.createdAt), done = ms(l.completedAt);
            if (c && done && done >= cutoff && done > c) { sum += (done - c); n++; }
        });
        $('kpiAvg').textContent = n ? fmtDur(sum / n) : '—';
        $('kpiAvgSub').innerHTML = '<span class="dot"></span>' + (n ? n + ' çözülen talep' : 'son 30 gün');

        // En yoğun departman
        const counts = {};
        logs.forEach(l => { const d = (l.department || '').trim(); if (d) counts[d] = (counts[d] || 0) + 1; });
        let best = null, bv = 0;
        Object.keys(counts).forEach(d => { if (counts[d] > bv) { bv = counts[d]; best = d; } });
        $('kpiDept').textContent = best || '—';
        $('kpiDeptSub').innerHTML = '<span class="dot"></span>' + (best ? bv + ' kayıt' : 'veri yok');
    }

    // ── Aktivite akışı ─────────────────────────────────────────
    function renderFeed() {
        const items = [];
        logs.forEach(l => items.push({
            kind: l.type === 'complaint' ? 'cmp' : 'req',
            t: ms(l.createdAt),
            title: l.type === 'complaint' ? (l.complaint || 'Şikayet') : (l.complaint || (l.department || 'Talep')),
            meta: `Oda ${l.room || '—'} · ${l.guestName || ''}`.trim(),
            pill: l.status === 'Solved' ? ['done', 'Tamamlandı'] : ['open', 'Açık']
        }));
        reservations.forEach(r => items.push({
            kind: 'res',
            t: ms(r.createdAt),
            title: `${r.type || 'Rezervasyon'}${r.guestName ? ' · ' + r.guestName : ''}`,
            meta: `Oda ${r.room || '—'}${r.date ? ' · ' + r.date : ''}${r.time ? ' ' + r.time : ''}`,
            pill: r.status === 'Confirmed' ? ['confirmed', 'Onaylı'] : (r.status === 'Cancelled' ? ['open', 'İptal'] : ['pending', 'Bekliyor'])
        }));
        items.sort((a, b) => b.t - a.t);
        const top = items.slice(0, 8);
        const wrap = $('feedList');
        if (!top.length) { wrap.innerHTML = '<div class="dash-empty">Henüz aktivite yok.</div>'; return; }
        const ic = { req: '🔔', cmp: '⚠️', res: '🛎️' };
        wrap.innerHTML = top.map(i => `
            <div class="feed-item">
                <div class="feed-ico ${i.kind}">${ic[i.kind]}</div>
                <div class="feed-body">
                    <div class="feed-title">${esc(i.title)}</div>
                    <div class="feed-meta">${esc(i.meta)}</div>
                </div>
                <span class="feed-pill ${i.pill[0]}">${i.pill[1]}</span>
                <span class="feed-time">${esc(timeAgo(i.t))}</span>
            </div>`).join('');
    }

    function renderAll() { renderKpis(); renderFeed(); }

    // ── Canlı dinleyiciler ─────────────────────────────────────
    function listen() {
        if (typeof moduleEnabled !== 'function' || moduleEnabled('concierge')) {
            db.collection('reservations').where('tenantId', '==', TENANT).onSnapshot(snap => {
                reservations = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
                renderAll();
            }, err => console.error('reservations listen', err));
        }
        if (typeof moduleEnabled !== 'function' || moduleEnabled('guestIssues')) {
            db.collection('guestLogs').where('tenantId', '==', TENANT)
                .orderBy('createdAt', 'desc').limit(300)
                .onSnapshot(snap => {
                    logs = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
                    renderAll();
                }, err => console.error('guestLogs listen', err));
        }
    }

    // ── Boot ───────────────────────────────────────────────────
    let started = false;
    function start() { if (started) return; started = true; initHeader(); listen(); }

    if (!USERNAME) { location.href = 'login.html'; return; }
    auth.onAuthStateChanged(u => { if (!u) { location.href = 'login.html'; return; } start(); });
})();
