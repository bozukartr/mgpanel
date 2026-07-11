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
        $('dashLogout').onclick = () => { try { auth.signOut(); } catch (e) {} try { clearSessionStorage(); } catch (e) {} location.href = 'login'; };
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

    // ── Talep & Şikayet analizi (durum/departman dağılımı + 14 günlük trend) ──
    const STATUS_LABEL = { Following: 'Bekliyor', InProgress: 'İşlemde', Solved: 'Çözüldü' };
    const STATUS_COLOR = { Following: '#d97706', InProgress: '#2563eb', Solved: '#16a34a' };
    function anBarRow(label, val, max, color) {
        const w = max > 0 ? Math.round(val / max * 100) : 0;
        return `<div class="an-row">
            <span class="an-label" title="${esc(label)}">${esc(label)}</span>
            <span class="an-bar"><i style="width:${w}%;${color ? 'background:' + color + ';' : ''}"></i></span>
            <span class="an-val">${esc(val)}</span>
        </div>`;
    }
    function renderAnalysis() {
        const quick = $('anQuick');
        if (!$('anStatus')) return; // modül kapalıysa bölüm gizli, hiç render etme
        if (!logs.length) {
            $('anStatus').innerHTML = '<div class="dash-empty">Kayıt yok.</div>';
            $('anDept').innerHTML = '';
            $('anTrend').innerHTML = '';
            if (quick) quick.textContent = '';
            return;
        }

        const reqCount = logs.filter(l => l.type !== 'complaint').length;
        const cmpCount = logs.filter(l => l.type === 'complaint').length;
        const escCount = logs.filter(l => l.escalated === true).length;
        if (quick) quick.textContent = `${reqCount} Talep · ${cmpCount} Şikayet` + (escCount ? ` · 🚨 ${escCount} eskale` : '');

        // Durum dağılımı (talep + şikayet birlikte)
        const statusCounts = { Following: 0, InProgress: 0, Solved: 0 };
        logs.forEach(l => { const s = l.status || 'Following'; if (statusCounts[s] != null) statusCounts[s]++; });
        const maxStatus = Math.max(1, ...Object.values(statusCounts));
        $('anStatus').innerHTML = Object.keys(statusCounts)
            .map(k => anBarRow(STATUS_LABEL[k], statusCounts[k], maxStatus, STATUS_COLOR[k])).join('');

        // Departman yükü — ilk 6, gerisi "Diğer"
        const deptCounts = {};
        logs.forEach(l => { const d = (l.department || '').trim() || 'Belirtilmemiş'; deptCounts[d] = (deptCounts[d] || 0) + 1; });
        const sortedDept = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]);
        const topDept = sortedDept.slice(0, 6);
        const restSum = sortedDept.slice(6).reduce((s, [, v]) => s + v, 0);
        if (restSum) topDept.push(['Diğer', restSum]);
        const maxDept = Math.max(1, ...topDept.map(([, v]) => v));
        $('anDept').innerHTML = topDept.length
            ? topDept.map(([k, v]) => anBarRow(k, v, maxDept)).join('')
            : '<div class="dash-empty">Kayıt yok.</div>';

        // Son 14 gün trend — kayıtlar en yeni 300 ile sınırlı (bkz. listen()),
        // bu yüzden çok yoğun bir otelde 14 günlük pencere eksik görünebilir;
        // mevcut KPI'lardaki (ör. "En Yoğun Departman") aynı sınırlamayı taşır.
        const days = [];
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const byDay = {};
        for (let i = 13; i >= 0; i--) {
            const d = new Date(today.getTime() - i * 86400000);
            const key = d.toISOString().slice(0, 10);
            const entry = { key, label: d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }), count: 0 };
            days.push(entry); byDay[key] = entry;
        }
        logs.forEach(l => {
            const t = ms(l.createdAt); if (!t) return;
            const key = new Date(t).toISOString().slice(0, 10);
            if (byDay[key]) byDay[key].count++;
        });
        const maxDay = Math.max(1, ...days.map(d => d.count));
        $('anTrend').innerHTML = days.map(d => {
            const h = d.count ? Math.max(6, Math.round(d.count / maxDay * 100)) : 2;
            return `<div class="trend-bar" title="${esc(d.label)}: ${d.count} kayıt"><i style="height:${h}%"></i></div>`;
        }).join('');
    }

    function renderAll() { renderKpis(); renderAnalysis(); renderFeed(); }

    // ── Canlı dinleyiciler ─────────────────────────────────────
    function listen() {
        if (typeof moduleEnabled !== 'function' || moduleEnabled('concierge')) {
            // Son 90 gün + gelecek — KPI'lar (bekleyen/geciken) ve akış için
            // yeterli; tüm tarihçeyi dinlemek sayfa başına büyüyen bir
            // maliyetti (bkz. hız denetimi).
            const winStart = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return d.toISOString().slice(0, 10); })();
            db.collection('reservations').where('tenantId', '==', TENANT)
                .where('date', '>=', winStart).onSnapshot(snap => {
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

    if (!USERNAME) { location.href = 'login'; return; }
    auth.onAuthStateChanged(u => { if (!u) { location.href = 'login'; return; } start(); });
})();
