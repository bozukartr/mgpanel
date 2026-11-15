/* concierge.js — Concierge (yeniden tasarım)
 *
 * Ekran: araç çubuğu (tarih gezinme · Gün/Hafta/Ay/Liste · arama · eylemler)
 * → durum ve hizmet türü süzgeç çipleri → pano + yan panel (yapılacaklar,
 * tahsilat, önümüzdeki 7 gün). Kartlarda hızlı işlemler (Onayla — geri
 * alınabilir; Tamamlandı — iki dokunuşla). Rezervasyon formu tek pencerede:
 * hizmet karoları, misafir seçici (rehber + PMS), canlı uyarılar (aynı misafir
 * ±2 sa, aynı araç/tekne, misafir o tarihte otelde değil, geçmiş zaman),
 * "Kaydet ve onayla". Ayrıntı sağdan açılan çekmecede: bağlama göre birincil
 * işlem, voucher / iptal nedeni / silme onayı pencere içinde (prompt yok).
 *
 * Güvenlik: kayıt kimlikleri asla satır içi onclick'e yazılmaz (misafirin
 * seçebildiği kimliklerle saklı XSS açığı vardı) — data-id + olay devri.
 */

// Escapes user-supplied text before it is inserted into innerHTML, preventing stored XSS.
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Rezervasyon para birimi. Eski kayıtlarda `currency` alanı yoktur — bunlar
// hep EUR olarak gösterildiğinden geriye dönük uyum için varsayılan EUR'dur.
// Rezervasyonun KENDİ currency alanı tek doğru kaynaktır.
const CUR_SYM = { EUR: '€', TRY: '₺', USD: '$' };
function curSym(cur) { return CUR_SYM[cur] || '€'; }

// Maintenance enforcement — also runs here (not only in maintenance-guard.js) so it
// works even if a cached page didn't load the guard script.
(function () {
    if (typeof db === 'undefined') return;
    db.collection('maintenance').doc(guardTenant()).onSnapshot((doc) => {
        if (!doc.exists) return;
        const d = doc.data();
        const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
        if (d.enabled && ends && ends > new Date()) window.location.replace('maintenance');
    }, function () {});
})();

document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);

    // ── AUTH ───────────────────────────────────────────────────
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    const loggedRole = (localStorage.getItem('hotelRole') || '').toLowerCase();
    const isAdminUser = loggedRole === 'admin' || loggedUsername.toLowerCase() === 'admin';
    if (!loggedUsername) { window.location.href = 'login'; return; }

    // Bu otelin (tenant) görünen adı — PDF/çıktılarda kullanılır (marka sızıntısı yok).
    let HOTEL_NAME = '';
    async function ensureHotelName() {
        if (HOTEL_NAME) return HOTEL_NAME;
        try {
            const d = await db.collection('guestConfig').doc(TENANT_ID).get();
            if (d.exists) HOTEL_NAME = String((d.data() || {}).hotelName || '').trim();
        } catch (e) { if (window.Monitor) Monitor.capture(e, { where: 'concierge.ensureHotelName' }); }
        return HOTEL_NAME;
    }
    ensureHotelName();
    auth.onAuthStateChanged(async (u) => {
        if (!u) { window.location.href = 'login'; return; }
        try {
            const doc = await db.collection('systemUsers').doc(u.uid).get();
            if (doc.exists) {
                const data = doc.data();
                const role = (data.role || '').toLowerCase();
                const uname = (data.username || '').toLowerCase();
                if (data.role) localStorage.setItem('hotelRole', data.role);
                if (role === 'admin' || uname === 'admin') {
                    const a = $('c-adminNav'); if (a) a.style.display = 'flex';
                }
            }
        } catch (e) { console.error('Auth error', e); }
    });
    (function fillIdentity() {
        const av = $('c-avatar'), rl = $('c-roleLabel'), nm = $('userNameDisplay');
        if (av) av.textContent = loggedUsername.slice(0, 2).toUpperCase();
        if (nm) nm.textContent = loggedUsername;
        if (rl) rl.textContent = loggedRole === 'admin' ? 'Yönetici' : (loggedRole === 'manager' ? 'Müdür' : 'Personel');
    })();
    $('c-logoutBtn')?.addEventListener('click', () => hotelSignOut('login'));

    // ── AUTO LOGOUT LOGIC (15 MINS) ────────────────────────────
    // App Shell içinde (gömülü) bu sayaç ÇALIŞMAZ: modüller arka planda açık
    // kaldığından her sayfanın kendi sayacı yalnız kendi etkinliğini sayıyor,
    // başka modülde çalışan kişiyi 15 dk sonra oturumdan atıyordu. Kabuk
    // (app-shell.js) tüm modüllerdeki etkinliği sayan TEK bir sayaç tutar.
    let logoutTimer;
    function resetLogoutTimer() {
        if (window.__EMBED__) return;
        clearTimeout(logoutTimer);
        logoutTimer = setTimeout(() => {
            auth.signOut().then(() => {
                clearSessionStorage();
                window.location.href = 'login';
            });
        }, 15 * 60 * 1000); // 15 minutes
    }
    ['keydown', 'input', 'change', 'scroll', 'touchstart', 'click'].forEach(evt => document.addEventListener(evt, resetLogoutTimer, true));
    resetLogoutTimer();

    // ── CONFIG ────────────────────────────────────────────────
    const SERVICE_IC = { Restaurant: 'utensils', Beach: 'beach', Transfer: 'car', Flower: 'flower', Cake: 'cake', Boat: 'boat', Tour: 'map', Other: 'sparkles' };
    const TYPE_TR = { Restaurant: 'Restoran', Beach: 'Plaj', Transfer: 'Transfer', Flower: 'Çiçek', Cake: 'Pasta', Boat: 'Tekne', Tour: 'Tur', Other: 'Diğer' };
    const TYPE_ORDER = ['Restaurant', 'Transfer', 'Beach', 'Boat', 'Tour', 'Cake', 'Flower', 'Other'];
    const ic = (n) => (typeof window.UIcon === 'function' ? window.UIcon(n) : '');
    const svcIcon = (type) => ic(SERVICE_IC[type] || 'sparkles');
    const typeTr = (type) => TYPE_TR[type] || type || '';
    const typeKey = (type) => (TYPE_TR[type] ? type : 'Other');
    // Ödeme alanları olan türler (eskiden de aynı liste) ve onay için voucher
    // isteyenler (eski güvenlik kontrolüyle aynı).
    const PAID_TYPES = ['Transfer', 'Flower', 'Cake', 'Boat', 'Tour', 'Other'];
    const VOUCHER_REQ = ['Transfer', 'Flower', 'Cake', 'Boat', 'Tour'];
    const ST_TR = { Pending: 'Bekliyor', Confirmed: 'Onaylı', Done: 'Tamamlandı', Cancelled: 'İptal' };
    const stOf = (r) => (ST_TR[r && r.status] ? r.status : 'Pending');
    const needsVoucher = (r) => VOUCHER_REQ.includes(r.type) && !String(r.voucherNo || '').trim();
    const balanceOf = (r) => Math.max(0, (Number(r.totalPrice) || 0) - (Number(r.deposit) || 0));
    const fmtMoney = (n, cur) => curSym(cur) + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('tr-TR');
    const norm = (s) => String(s || '').trim().toLocaleLowerCase('tr-TR');

    // ── TARİH YARDIMCILARI ─────────────────────────────────────
    const pad = (n) => String(n).padStart(2, '0');
    const dateToIso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const todayIso = () => dateToIso(new Date());
    const isoToDate = (iso) => { const p = String(iso || '').split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
    const isoAdd = (iso, n) => { const d = isoToDate(iso); d.setDate(d.getDate() + n); return dateToIso(d); };
    const validIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const nowHM = () => new Date().toTimeString().slice(0, 5);
    const parseTimeToMins = (t) => {
        if (!t || !String(t).includes(':')) return null;
        const p = String(t).split(':');
        return (parseInt(p[0], 10) * 60) + parseInt(p[1] || 0, 10);
    };
    // PDF'ler için GG/AA/YYYY (eski biçim korunur).
    const fmtDate = (d) => {
        if (!d) return '';
        const dt = validIso(d) ? isoToDate(d) : new Date(d);
        if (isNaN(dt.getTime())) return '';
        return pad(dt.getDate()) + '/' + pad(dt.getMonth() + 1) + '/' + dt.getFullYear();
    };
    const fmtDayLong = (iso) => isoToDate(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
    const fmtDayShort = (iso) => isoToDate(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
    function dayWord(iso) {
        const t = todayIso();
        if (iso === t) return 'Bugün';
        if (iso === isoAdd(t, 1)) return 'Yarın';
        if (iso === isoAdd(t, -1)) return 'Dün';
        return '';
    }
    const fmtDur = (mins) => {
        mins = Math.abs(Math.round(mins));
        if (mins < 60) return mins + ' dk';
        const h = Math.floor(mins / 60), m = mins % 60;
        if (h < 3) return m ? h + ' sa ' + m + ' dk' : h + ' sa';
        if (h < 24) return h + ' sa';
        const d = Math.round(h / 24);
        return d + ' gün';
    };
    // Gecikmiş: hâlâ "Bekliyor" ama planlanan an geçmiş (yerel gün + saat).
    function isOverdueRes(r) {
        if (!r || stOf(r) !== 'Pending' || !validIso(r.date)) return false;
        const today = todayIso();
        if (r.date < today) return true;
        if (r.date > today) return false;
        if (!r.time) return false;
        return r.time < nowHM();
    }
    // Karttaki göreli zaman: "40 dk sonra", "Gecikti · 2 sa", "3 gün sonra".
    function relWhen(r) {
        const st = stOf(r);
        if (st === 'Done' || st === 'Cancelled' || !validIso(r.date)) return null;
        const today = todayIso();
        if (r.date !== today) {
            const days = Math.round((isoToDate(r.date) - isoToDate(today)) / 86400000);
            if (days > 0) return { text: days === 1 ? 'yarın' : days + ' gün sonra', cls: '' };
            return st === 'Pending' ? { text: 'Gecikti · ' + (-days) + ' gün', cls: 'late' } : { text: (-days) + ' gün önce', cls: '' };
        }
        if (!r.time) return { text: 'gün içinde', cls: '' };
        const diff = parseTimeToMins(r.time) - parseTimeToMins(nowHM());
        if (diff >= 0) return { text: diff === 0 ? 'şimdi' : fmtDur(diff) + ' sonra', cls: diff <= 60 ? 'soon' : '' };
        return st === 'Pending' ? { text: 'Gecikti · ' + fmtDur(diff), cls: 'late' } : { text: fmtDur(diff) + ' önce', cls: '' };
    }

    // ── DURUM ─────────────────────────────────────────────────
    let reservations = [];
    let guestDirectory = [];
    let filteredReservations = [];          // "Şu anki görünüm" raporu
    let guestMap = {};                      // { guestName: room } — geçmiş rezervasyonlardan
    const VIEWS = ['day', 'week', 'month', 'list'];
    let view = (function () { try { const v = localStorage.getItem('cz_view'); return VIEWS.includes(v) ? v : 'day'; } catch (e) { return 'day'; } })();
    let cursor = todayIso();
    let statusFilter = null;                // Pending | Confirmed | Done | Cancelled | overdue
    let typeFilter = null;
    let searchQ = '';
    let showPast = false;
    let selectedId = null;
    window.selectedReservation = null;

    // ── TOAST (+ geri al) ─────────────────────────────────────
    let toastTimer = null;
    // action: işlev (→ "Geri al") ya da { label, fn } (ör. "Göster").
    const showToast = (msg, isError = false, action = null) => {
        const t = $('c-toast');
        if (!t) return;
        const act = typeof action === 'function' ? { label: 'Geri al', fn: action } : action;
        t.innerHTML = '<span>' + esc(msg) + '</span>' + (act ? '<button type="button">' + esc(act.label) + '</button>' : '');
        t.className = 'cz-toast show' + (isError ? ' error' : '');
        if (act) t.querySelector('button').onclick = () => { t.classList.remove('show'); act.fn(); };
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('show'), act ? 6000 : (isError ? 4500 : 3200));
    };

    // ── PENCERELER ────────────────────────────────────────────
    const openOv = (ov) => { ov.hidden = false; document.documentElement.classList.add('cz-modal-open'); };
    const closeOv = (ov) => {
        ov.hidden = true;
        if (!document.querySelector('.cz-ov:not([hidden])')) document.documentElement.classList.remove('cz-modal-open');
    };
    const anyOpen = () => !!document.querySelector('.cz-ov:not([hidden])');
    document.querySelectorAll('.cz-ov').forEach(ov => {
        ov.addEventListener('mousedown', (e) => { ov.__downOnBg = e.target === ov; });
        ov.addEventListener('click', (e) => {
            if (e.target !== ov || !ov.__downOnBg) return;
            if (ov.id === 'czFormOv') requestCloseForm(); else closeOv(ov);
            if (ov.id === 'czDetailOv') onDetailClosed();
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const menu = $('czMoreMenu');
            if (menu && !menu.hidden) { menu.hidden = true; $('czMoreBtn').setAttribute('aria-expanded', 'false'); return; }
            const dd = document.querySelector('.cz-dd:not([hidden])');
            if (dd) { dd.hidden = true; return; }
            const open = Array.from(document.querySelectorAll('.cz-ov:not([hidden])')).pop();
            if (!open) return;
            e.preventDefault();
            if (open.id === 'czFormOv') requestCloseForm();
            else { closeOv(open); if (open.id === 'czDetailOv') onDetailClosed(); }
            return;
        }
        // ← → : önceki / sonraki gün (yazı alanında ve pencere açıkken değil)
        const t = e.target, tag = (t && t.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
        if (typing || anyOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
    });

    // ── YEDEK (JSON) ──────────────────────────────────────────
    const moreBtn = $('czMoreBtn'), moreMenu = $('czMoreMenu');
    moreBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        moreMenu.hidden = !moreMenu.hidden;
        moreBtn.setAttribute('aria-expanded', moreMenu.hidden ? 'false' : 'true');
    });
    document.addEventListener('click', (e) => { if (moreMenu && !moreMenu.hidden && !e.target.closest('.cz-more')) { moreMenu.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); } });
    moreMenu?.addEventListener('click', (e) => { if (e.target.closest('button')) { moreMenu.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); } });

    $('c-exportDataBtn')?.addEventListener('click', async () => {
        try {
            const logsSnap = await db.collection('guestLogs').where('tenantId', '==', TENANT_ID).get();
            const resSnap = await db.collection('reservations').where('tenantId', '==', TENANT_ID).get();
            const dirSnap = await db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get();
            const fullBackup = {
                guestLogs: logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                reservations: resSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                guestDirectory: dirSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                backupDate: new Date().toISOString(),
                version: '3.0'
            };
            const blob = new Blob([JSON.stringify(fullBackup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Full_System_Backup_${todayIso()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Tam sistem yedeği indirildi.');
        } catch (e) { showToast('Yedek alınamadı.', true); }
    });
    if (!isAdminUser) { const ib = $('c-importDataBtn'); if (ib) ib.hidden = true; }
    $('c-importDataBtn')?.addEventListener('click', () => {
        if (!isAdminUser) return showToast('Yalnızca admin yedekten yükleyebilir.', true);
        $('c-importFileInput').click();
    });
    $('c-importFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const data = JSON.parse(event.target.result);
                const batch = db.batch();
                let logCount = 0, resCount = 0, dirCount = 0;
                // Belge kimlikleri yalnızca güvenli karakterlerden oluşabilir
                // (kimlikler arayüzde data-id olarak kullanılıyor).
                const safeId = (id) => /^[A-Za-z0-9_-]{1,120}$/.test(String(id || ''));
                const put = (col, item) => {
                    const { id, ...rest } = item || {};
                    if (!safeId(id)) return false;
                    batch.set(db.collection(col).doc(id), rest, { merge: true });
                    return true;
                };
                if (data.guestLogs || data.reservations || data.guestDirectory) {
                    (data.guestLogs || []).forEach(it => { if (put('guestLogs', it)) logCount++; });
                    (data.reservations || []).forEach(it => { if (put('reservations', it)) resCount++; });
                    (data.guestDirectory || []).forEach(it => { if (put('guestDirectory', it)) dirCount++; });
                } else if (Array.isArray(data)) {
                    data.forEach(it => { if (put('guestLogs', it)) logCount++; });
                } else {
                    throw new Error('Desteklenmeyen yedek biçimi');
                }
                await batch.commit();
                showToast(`Yüklendi: ${logCount} kayıt, ${resCount} rezervasyon, ${dirCount} CRM profili.`);
                e.target.value = '';
                setTimeout(() => window.location.reload(), 1500);
            } catch (err) { showToast('Yedekten yükleme başarısız: ' + err.message, true); }
        };
        reader.readAsText(file);
    });

    // ── VERİ ──────────────────────────────────────────────────
    db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
        guestDirectory = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Çıkış tarihi geçmiş "konaklıyor" misafirleri otomatik çıkışa al.
        const today = todayIso();
        const batch = db.batch();
        let needsCommit = false;
        guestDirectory.forEach(g => {
            if (g.status === 'in_house' && g.checkOut && g.checkOut < today) {
                batch.update(db.collection('guestDirectory').doc(g.id), { status: 'checked_out' });
                needsCommit = true;
            }
        });
        if (needsCommit) batch.commit().catch(e => console.error('Auto-checkout error', e));
        if (selectedId) { const r = reservations.find(x => x.id === selectedId); if (r) populateDetail(r); }
    });

    // Canlı pencere: son 90 gün + tüm gelecek (dışa aktarma ayrıca tam okur).
    const resWindowStart = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return dateToIso(d); })();
    db.collection('reservations').where('tenantId', '==', TENANT_ID)
        .where('date', '>=', resWindowStart).orderBy('date', 'asc').onSnapshot(snap => {
        reservations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        guestMap = {};
        reservations.forEach(r => { if (r.guestName && r.room) guestMap[r.guestName] = r.room; });
        render();
        if (window.__openPendingRes) window.__openPendingRes();
        if (selectedId) {
            const up = reservations.find(r => r.id === selectedId);
            if (up) { window.selectedReservation = up; populateDetail(up); }
        }
    });

    // ── KAPSAM / SÜZGEÇ ───────────────────────────────────────
    function matchesSearch(r, q) {
        if (!q) return true;
        return [r.guestName, r.room, typeTr(r.type), r.type, r.resName, r.otherType, r.vessel, r.provider, r.from, r.to, r.notes, r.voucherNo, r.vehicle]
            .some(v => v && norm(v).includes(q));
    }
    function passStatus(r) {
        if (!statusFilter) return true;
        if (statusFilter === 'overdue') return isOverdueRes(r);
        return stOf(r) === statusFilter;
    }
    const passType = (r) => !typeFilter || typeKey(r.type) === typeFilter;
    const byTime = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '99:99').localeCompare(b.time || '99:99');
    function weekStart(iso) { const d = isoToDate(iso); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateToIso(d); }
    // Görünümün kapsadığı kayıtlar (durum süzgecinden ÖNCE — çip sayıları için).
    function scopeItems() {
        if (statusFilter === 'overdue') return reservations.filter(isOverdueRes);
        if (view === 'day') {
            const next = isoAdd(cursor, 1);
            const out = [];
            reservations.forEach(r => {
                if (r.date === cursor) out.push(r);
                // Ertesi günün gece saatleri (00–08) bu günün akışında "+1 gün" olarak.
                else if (r.date === next && r.time && parseInt(r.time, 10) < 8) out.push(Object.assign({}, r, { __next: true }));
            });
            return out;
        }
        if (view === 'week') { const s = weekStart(cursor), e = isoAdd(s, 6); return reservations.filter(r => r.date >= s && r.date <= e); }
        if (view === 'month') { const m = cursor.slice(0, 7); return reservations.filter(r => (r.date || '').slice(0, 7) === m); }
        const t = todayIso();
        return reservations.filter(r => showPast || (r.date || '') >= t);
    }

    // ── ÇİZİM ─────────────────────────────────────────────────
    const board = $('c-feed');
    function render() {
        renderToolbar();
        const scope = scopeItems().filter(r => matchesSearch(r, searchQ));
        renderChips(scope);
        const visible = scope.filter(r => passType(r) && passStatus(r)).sort(byTime);
        filteredReservations = visible;
        if (statusFilter === 'overdue') renderOverdue(visible);
        else if (view === 'day') renderDay(visible);
        else if (view === 'week') renderWeek(visible);
        else if (view === 'month') renderMonth(visible);
        else renderList(visible);
        renderAside(scope.filter(passType));
        markSelected();
    }

    function renderToolbar() {
        const lbl = $('czDateLabel'), sub = $('czDateSub');
        const t = todayIso();
        if (view === 'day') {
            lbl.textContent = dayWord(cursor) || isoToDate(cursor).toLocaleDateString('tr-TR', { weekday: 'long' });
            sub.textContent = isoToDate(cursor).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) + (dayWord(cursor) ? ' · ' + isoToDate(cursor).toLocaleDateString('tr-TR', { weekday: 'long' }) : '');
        } else if (view === 'week') {
            const s = weekStart(cursor), e = isoAdd(s, 6);
            lbl.textContent = isoToDate(s).getMonth() === isoToDate(e).getMonth()
                ? isoToDate(s).getDate() + ' – ' + fmtDayShort(e)
                : fmtDayShort(s) + ' – ' + fmtDayShort(e);
            sub.textContent = (t >= s && t <= e) ? 'Bu hafta' : 'Hafta';
        } else if (view === 'month') {
            lbl.textContent = isoToDate(cursor).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
            sub.textContent = cursor.slice(0, 7) === t.slice(0, 7) ? 'Bu ay' : 'Ay';
        } else {
            lbl.textContent = 'Tüm rezervasyonlar';
            sub.textContent = showPast ? 'Son 90 gün + gelecek' : 'Bugünden itibaren';
        }
        const di = $('czDateInput'); if (di) di.value = cursor;
        const list = view === 'list' && statusFilter !== 'overdue';
        $('czPrev').hidden = list; $('czNext').hidden = list;
        $('czToday').disabled = !list && cursor === t && view === 'day';
        document.querySelectorAll('#czViews button').forEach(b => {
            const on = b.dataset.view === view;
            b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }

    function renderChips(scope) {
        const typed = scope.filter(passType);
        const cnt = { all: typed.length, Pending: 0, Confirmed: 0, Done: 0, Cancelled: 0 };
        typed.forEach(r => { cnt[stOf(r)]++; });
        const overdue = reservations.filter(isOverdueRes).length;
        const chip = (key, label, n, extra) => `<button type="button" class="cz-chip${extra || ''}${(statusFilter || 'all') === key ? ' on' : ''}" data-status="${key}" aria-pressed="${(statusFilter || 'all') === key}">${key !== 'all' && key !== 'overdue' ? `<i class="dot ${key}"></i>` : ''}${label} <b>${n}</b></button>`;
        let html = chip('all', 'Tümü', cnt.all) + chip('Pending', 'Bekliyor', cnt.Pending) + chip('Confirmed', 'Onaylı', cnt.Confirmed)
            + chip('Done', 'Tamamlandı', cnt.Done) + chip('Cancelled', 'İptal', cnt.Cancelled);
        if (overdue) html += chip('overdue', ic('alert') + ' Gecikti', overdue, ' warn');
        $('czStatusChips').innerHTML = html;
        // Tür çipleri: kapsamda olanlar (+ seçili olan, sayısı 0 olsa da)
        const tc = {};
        scope.filter(passStatus).forEach(r => { const k = typeKey(r.type); tc[k] = (tc[k] || 0) + 1; });
        const types = TYPE_ORDER.filter(k => tc[k] || typeFilter === k);
        $('czTypeChips').innerHTML = types.length < 2 && !typeFilter ? '' :
            `<button type="button" class="cz-chip${!typeFilter ? ' on' : ''}" data-type="">Tüm hizmetler</button>` +
            types.map(k => `<button type="button" class="cz-chip${typeFilter === k ? ' on' : ''}" data-type="${k}">${ic(SERVICE_IC[k])} ${TYPE_TR[k]} <span class="n">${tc[k] || 0}</span></button>`).join('');
    }
    $('czStatusChips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-status]'); if (!b) return;
        const k = b.dataset.status;
        statusFilter = (k === 'all' || statusFilter === k) ? null : k;
        render();
    });
    $('czTypeChips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-type]'); if (!b) return;
        typeFilter = (!b.dataset.type || typeFilter === b.dataset.type) ? null : b.dataset.type;
        render();
    });

    // Kart: misafir · oda · hizmet ayrıntısı · bayraklar · hızlı işlem.
    function whatLine(r) {
        const pax = r.pax ? r.pax + ' kişi' : '';
        let parts = [];
        if (r.type === 'Transfer') parts = [[r.from, r.to].filter(Boolean).join(' → '), r.vehicle, pax];
        else if (r.type === 'Boat' || r.type === 'Tour') parts = [r.vessel, r.provider, pax];
        else if (r.type === 'Restaurant' || r.type === 'Beach') parts = [r.resName, pax];
        else parts = [r.otherType || r.resName];
        return [typeTr(r.type)].concat(parts.filter(Boolean)).join(' · ');
    }
    function roomChip(r) {
        if (!r.room || r.room === 'Pre-Arrival') return '<span class="cz-room pre">Ön geliş</span>';
        return '<span class="cz-room">' + esc(r.room) + '</span>';
    }
    function seriesInfo(r) {
        if (!r.seriesId) return null;
        const sib = reservations.filter(x => x.seriesId === r.seriesId).sort(byTime);
        if (sib.length < 2) return null;
        return { i: sib.findIndex(x => x.id === r.id) + 1, n: sib.length, sib };
    }
    // "Tamamlandı" hızlı işlemi: onaylı ve vakti gelmiş (en çok 1 sa öncesi) kayıt.
    function doneDue(r) {
        if (stOf(r) !== 'Confirmed' || !validIso(r.date)) return false;
        const t = todayIso();
        if (r.date < t) return true;
        if (r.date > t) return false;
        return !r.time || parseTimeToMins(r.time) - parseTimeToMins(nowHM()) <= 60;
    }
    function flagsHtml(r) {
        const st = stOf(r), out = [];
        if (r.__next) out.push('<span class="cz-flag warn">+1 gün</span>');
        if (r.source === 'guest-order') out.push('<span class="cz-flag qr" title="Misafirin QR ekranından geldi">' + ic('qr') + ' QR</span>');
        const s = seriesInfo(r); if (s) out.push('<span class="cz-flag series" title="Tekrarlayan seri">' + ic('repeat') + ' ' + s.i + '/' + s.n + '</span>');
        if ((st === 'Pending' || st === 'Confirmed') && needsVoucher(r)) out.push('<span class="cz-flag warn">Voucher eksik</span>');
        const bal = balanceOf(r);
        if (st !== 'Cancelled' && PAID_TYPES.includes(r.type) && (Number(r.totalPrice) || 0) > 0) {
            if (r.folioApplied) out.push('<span class="cz-flag paid">Oda hesabında</span>');
            else if (bal > 0) out.push('<span class="cz-flag money">' + esc(fmtMoney(bal, r.currency)) + ' bakiye</span>');
            else out.push('<span class="cz-flag paid">Ödendi</span>');
        }
        return out.join('');
    }
    function cardHtml(r) {
        const st = stOf(r), rw = relWhen(r);
        let cls = ' is-' + st.toLowerCase();
        if (isOverdueRes(r)) cls += ' is-overdue';
        let acts = '';
        if (st === 'Pending') acts = `<button type="button" class="cz-qa go" data-qa="confirm" data-id="${esc(r.id)}">${ic('check')} Onayla</button>`;
        else if (doneDue(r)) acts = `<button type="button" class="cz-qa" data-qa="done" data-id="${esc(r.id)}">${ic('check')} Tamamlandı</button>`;
        return `<article class="cz-res${cls}" data-id="${esc(r.id)}" data-status="${st}" tabindex="0" aria-label="${esc(r.guestName)} · ${esc(typeTr(r.type))} · ${esc(r.time || '')}">
            <div class="cz-res-time"><b>${esc(r.time || '—')}</b>${rw ? `<small class="${rw.cls}">${esc(rw.text)}</small>` : ''}</div>
            <div class="cz-res-ic t-${typeKey(r.type)}">${svcIcon(r.type)}</div>
            <div class="cz-res-main">
                <div class="cz-res-top"><span class="cz-res-guest">${esc(r.guestName || '—')}</span>${roomChip(r)}</div>
                <div class="cz-res-what">${esc(whatLine(r))}</div>
                <div class="cz-res-flags">${flagsHtml(r)}</div>
            </div>
            <div class="cz-res-side"><span class="cz-st st-${st}">${ST_TR[st]}</span>${acts ? `<div class="cz-res-acts">${acts}</div>` : ''}</div>
        </article>`;
    }

    // Boş durum: süzgeç varsa temizle; aramada diğer günlerde sonuç varsa listede göster; sonraki rezervasyona git.
    function emptyHtml(title, text) {
        const filtered = statusFilter || typeFilter || searchQ;
        let extra = '';
        if (searchQ && view !== 'list') {
            const other = reservations.filter(r => matchesSearch(r, searchQ)).length;
            if (other) extra += `<p class="cz-hint-row">Diğer tarihlerde ${other} sonuç var — <button type="button" data-go="list">listede göster</button></p>`;
        }
        if (!filtered && view === 'day') {
            const next = reservations.filter(r => r.date > cursor && stOf(r) !== 'Cancelled').sort(byTime)[0];
            if (next) extra += `<p class="cz-hint-row">Sonraki rezervasyon: ${esc(fmtDayLong(next.date))} — <button type="button" data-go-date="${esc(next.date)}">git</button></p>`;
        }
        return `<div class="cz-empty"><span class="cz-empty-ic">${ic('concierge')}</span><b>${esc(title)}</b><p>${esc(text)}</p>
            <div class="cz-empty-act">${filtered ? '<button type="button" class="cz-btn ghost sm" data-clear="1">Süzgeçleri temizle</button>' : ''}<button type="button" class="cz-btn primary sm" data-new="1">${ic('plus')} Rezervasyon ekle</button></div>${extra}</div>`;
    }

    // Gün: zaman dilimi grupları + bugünse "şimdi" çizgisi.
    function renderDay(items) {
        if (!items.length) {
            const filtered = statusFilter || typeFilter || searchQ;
            board.innerHTML = emptyHtml(filtered ? 'Süzgeçlere uyan rezervasyon yok' : 'Bu gün için rezervasyon yok', filtered ? 'Süzgeçleri değiştirin ya da temizleyin.' : 'Yeni bir rezervasyon ekleyebilir ya da başka bir güne geçebilirsiniz.');
            return;
        }
        const groups = [
            ['notime', 'Saatsiz', r => !r.time && !r.__next],
            ['morning', 'Sabah', r => !r.__next && r.time && r.time < '12:00'],
            ['noon', 'Öğleden sonra', r => !r.__next && r.time >= '12:00' && r.time < '17:00'],
            ['evening', 'Akşam', r => !r.__next && r.time >= '17:00'],
            ['night', 'Gece · ertesi gün', r => r.__next]
        ];
        const isToday = cursor === todayIso();
        const now = nowHM();
        let nowPlaced = !isToday;
        let html = '';
        groups.forEach(([key, label, fn]) => {
            const list = items.filter(fn);
            if (!list.length) return;
            let inner = '';
            list.forEach(r => {
                if (!nowPlaced && r.time && !r.__next && r.time >= now) {
                    inner += `<div class="cz-now"><i></i>Şimdi ${now}</div>`;
                    nowPlaced = true;
                }
                inner += cardHtml(r);
            });
            html += `<section class="cz-group"><h3 class="cz-group-h">${label}<span class="n">${list.length}</span></h3><div class="cz-list">${inner}</div></section>`;
        });
        board.innerHTML = html;
    }

    function renderWeek(items) {
        const s = weekStart(cursor), t = todayIso();
        let html = '<div class="cz-week-wrap"><div class="cz-week">';
        for (let i = 0; i < 7; i++) {
            const iso = isoAdd(s, i);
            const day = items.filter(r => r.date === iso);
            const d = isoToDate(iso);
            html += `<div class="cz-wcol${iso === t ? ' today' : ''}">
                <button type="button" class="cz-wcol-h" data-go-date="${iso}"><b>${d.toLocaleDateString('tr-TR', { weekday: 'short' })} ${d.getDate()}</b><small>${day.length ? day.length + ' rez.' : ''}</small></button>
                <div class="cz-wcol-b">${day.length ? day.map(r => `<button type="button" class="cz-witem" data-id="${esc(r.id)}" data-status="${stOf(r)}">
                    <span class="t">${svcIcon(r.type)} ${esc(r.time || '—')}</span><span class="g">${esc(r.guestName || '—')}</span></button>`).join('') : '<div class="cz-wnone">Boş</div>'}</div>
            </div>`;
        }
        board.innerHTML = html + '</div></div>';
    }

    function renderMonth(items) {
        const first = isoToDate(cursor.slice(0, 7) + '-01');
        const m = first.getMonth();
        const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
        const t = todayIso();
        let html = '<div class="cz-month"><div class="cz-month-dow"><span>Pzt</span><span>Sal</span><span>Çar</span><span>Per</span><span>Cum</span><span>Cmt</span><span>Paz</span></div><div class="cz-month-grid">';
        const cells = [];
        for (let i = 0; i < 42; i++) { const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); cells.push(d); }
        const rows = cells.slice(35).every(d => d.getMonth() !== m) ? cells.slice(0, 35) : cells;
        rows.forEach(d => {
            const iso = dateToIso(d);
            const day = items.filter(r => r.date === iso);
            const cls = (d.getMonth() !== m ? ' dim' : '') + (iso === t ? ' today' : '') + (iso === cursor ? ' sel' : '');
            const shown = day.slice(0, 3).map(r => `<span><i class="${stOf(r)}"></i>${esc(r.time ? r.time + ' ' : '')}${esc(r.guestName || '')}</span>`).join('');
            html += `<button type="button" class="cz-mday${cls}" data-go-date="${iso}"><b>${d.getDate()}</b><div class="cz-mday-items">${shown}${day.length > 3 ? `<em class="cz-mday-more">+${day.length - 3} daha</em>` : ''}${day.length ? `<span class="cz-mday-cnt">${day.length}</span>` : ''}</div></button>`;
        });
        board.innerHTML = html + '</div></div>';
    }

    function dateGroupsHtml(items) {
        const t = todayIso();
        const groups = {};
        items.forEach(r => { (groups[r.date] = groups[r.date] || []).push(r); });
        return Object.keys(groups).sort().map(d => `<section class="cz-dgroup">
            <h3 class="cz-dgroup-h${d === t ? ' today' : ''}">${esc(dayWord(d) || fmtDayLong(d))} <small>${dayWord(d) ? esc(fmtDayLong(d)) + ' · ' : ''}${groups[d].length} rezervasyon</small></h3>
            <div class="cz-list">${groups[d].map(cardHtml).join('')}</div></section>`).join('');
    }
    function renderList(items) {
        const past = !showPast ? `<button type="button" class="cz-btn ghost sm cz-pastbtn" data-past="1">${ic('clock')} Geçmiş rezervasyonları da göster (son 90 gün)</button>` : '';
        if (!items.length) { board.innerHTML = past + emptyHtml('Rezervasyon bulunamadı', 'Süzgeçleri değiştirin ya da yeni bir rezervasyon ekleyin.'); return; }
        board.innerHTML = past + dateGroupsHtml(items);
    }
    function renderOverdue(items) {
        const head = `<div class="cz-banner late" style="margin-bottom:12px">${ic('alert')}<div><b>Gecikmiş rezervasyonlar</b>Planlanan zamanı geçmiş ama hâlâ onay bekleyen kayıtlar. Onaylayın, tamamlayın ya da iptal edin.</div></div>`;
        board.innerHTML = head + (items.length ? dateGroupsHtml(items) : emptyHtml('Gecikmiş rezervasyon yok', 'Her şey güncel.'));
    }

    // ── YAN PANEL ─────────────────────────────────────────────
    function todoItems() {
        const t = todayIso(), t1 = isoAdd(t, 1), t7 = isoAdd(t, 7);
        const seen = new Set(), out = [];
        const add = (r, kind, why) => { if (seen.has(r.id)) return; seen.add(r.id); out.push({ r, kind, why }); };
        reservations.filter(isOverdueRes).sort(byTime).forEach(r => add(r, 'bad', 'Gecikti'));
        reservations.filter(r => r.source === 'guest-order' && stOf(r) === 'Pending' && r.date >= t).sort(byTime).forEach(r => add(r, 'qr', 'QR talebi · onay bekliyor'));
        reservations.filter(r => stOf(r) === 'Pending' && needsVoucher(r) && r.date >= t && r.date <= t7).sort(byTime).forEach(r => add(r, 'warn', 'Voucher bekleniyor'));
        reservations.filter(r => stOf(r) === 'Pending' && r.date >= t && r.date <= t1).sort(byTime).forEach(r => add(r, 'warn', 'Onay bekliyor'));
        return out;
    }
    function todoHtml(items, max) {
        if (!items.length) return `<div class="cz-todo-ok">${ic('check')} Bekleyen iş yok — her şey yolunda.</div>`;
        const shown = items.slice(0, max);
        return '<div class="cz-todo">' + shown.map(({ r, kind, why }) => {
            const when = (dayWord(r.date) || fmtDayShort(r.date)) + (r.time ? ' ' + r.time : '');
            const act = stOf(r) === 'Pending' && !needsVoucher(r)
                ? `<button type="button" class="cz-qa go" data-qa="confirm" data-id="${esc(r.id)}">Onayla</button>`
                : `<button type="button" class="cz-qa" data-id="${esc(r.id)}">Aç</button>`;
            return `<div class="cz-todo-it" data-id="${esc(r.id)}"><span class="ic ${kind}">${kind === 'qr' ? ic('qr') : (kind === 'bad' ? ic('alert') : svcIcon(r.type))}</span>
                <span><b>${esc(r.guestName || '—')} · ${esc(typeTr(r.type))}</b><small>${esc(why)} · ${esc(when)}</small></span>${act}</div>`;
        }).join('') + '</div>' + (items.length > max ? `<button type="button" class="cz-todo-more" data-status-go="Pending">+${items.length - max} iş daha — bekleyenleri listede göster</button>` : '');
    }
    function renderAside(scopeTyped) {
        const todo = todoItems();
        $('czTodo').innerHTML = `<div class="cz-panel-h"><h4>Yapılacaklar</h4><span class="n${todo.length ? '' : ' ok'}">${todo.length}</span></div>` + todoHtml(todo, 6);
        // Mobil / dar ekran: panonun başında katlanabilir özet
        const m = $('czTodoMobile');
        if (m) m.innerHTML = todo.length ? `<details class="cz-panel"><summary class="cz-panel-h" style="cursor:pointer;list-style:none"><h4>${ic('alert')} ${todo.length} iş bekliyor</h4><span class="n">${todo.length}</span></summary>${todoHtml(todo, 8)}</details>` : '';

        // Tahsilat (kapsam: görünüm) — para birimleri karıştırılmaz
        const money = {};
        let dueCount = 0;
        scopeTyped.forEach(r => {
            if (stOf(r) === 'Cancelled' || !PAID_TYPES.includes(r.type)) return;
            const c = r.currency || 'EUR';
            const g = money[c] || (money[c] = { total: 0, dep: 0, due: 0 });
            g.total += Number(r.totalPrice) || 0; g.dep += Number(r.deposit) || 0;
            if (!r.folioApplied && balanceOf(r) > 0) { g.due += balanceOf(r); dueCount++; }
        });
        const curs = Object.keys(money).filter(c => money[c].total > 0);
        const scopeName = view === 'day' ? (dayWord(cursor) ? dayWord(cursor).toLowerCase() : 'bu gün') : view === 'week' ? 'bu hafta' : view === 'month' ? 'bu ay' : 'listede';
        $('czMoney').innerHTML = !curs.length ? '' : `<div class="cz-panel-h"><h4>Tahsilat · ${esc(scopeName)}</h4></div><div class="cz-money">
            <div class="cz-money-row big"><span>Tahsil edilecek</span><b>${curs.map(c => esc(fmtMoney(money[c].due, c))).join(' + ')}</b></div>
            <div class="cz-money-row"><span>Toplam tutar</span><b>${curs.map(c => esc(fmtMoney(money[c].total, c))).join(' + ')}</b></div>
            <div class="cz-money-row"><span>Alınan kapora</span><b>${curs.map(c => esc(fmtMoney(money[c].dep, c))).join(' + ')}</b></div>
            <p class="cz-money-note">${dueCount ? dueCount + ' rezervasyonda kalan bakiye var; ayrıntıdan oda hesabına yansıtılabilir.' : 'Kalan bakiye yok.'}</p></div>`;

        // Önümüzdeki 7 gün
        const t = todayIso();
        const days = [];
        for (let i = 0; i < 7; i++) { const iso = isoAdd(t, i); days.push([iso, reservations.filter(r => r.date === iso && stOf(r) !== 'Cancelled').length]); }
        const max = Math.max(1, ...days.map(d => d[1]));
        $('czWeekAhead').innerHTML = `<div class="cz-panel-h"><h4>Önümüzdeki 7 gün</h4></div><div class="cz-bars">${days.map(([iso, n]) =>
            `<button type="button" class="cz-bar${iso === t ? ' today' : ''}" data-go-date="${iso}" title="${esc(fmtDayLong(iso))}: ${n} rezervasyon"><em>${n || ''}</em><i style="height:${Math.max(4, Math.round(n / max * 64))}px"></i><span>${isoToDate(iso).toLocaleDateString('tr-TR', { weekday: 'short' })}</span></button>`).join('')}</div>`;
    }

    // ── GEZİNME ───────────────────────────────────────────────
    function goDate(iso, toView) {
        if (!validIso(iso)) return;
        cursor = iso;
        if (toView) setView(toView, true);
        if (statusFilter === 'overdue') statusFilter = null;
        render();
        $('czBoard')?.scrollTo({ top: 0 });
    }
    function step(dir) {
        if (view === 'list' || statusFilter === 'overdue') return;
        if (view === 'day') cursor = isoAdd(cursor, dir);
        else if (view === 'week') cursor = isoAdd(cursor, 7 * dir);
        else { const d = isoToDate(cursor); d.setDate(1); d.setMonth(d.getMonth() + dir); cursor = dateToIso(d); }
        render();
    }
    function setView(v, silent) {
        if (!VIEWS.includes(v)) return;
        view = v;
        try { localStorage.setItem('cz_view', v); } catch (e) {}
        if (!silent) render();
    }
    $('czPrev').addEventListener('click', () => step(-1));
    $('czNext').addEventListener('click', () => step(1));
    $('czToday').addEventListener('click', () => { cursor = todayIso(); if (view === 'list') setView('day', true); statusFilter = statusFilter === 'overdue' ? null : statusFilter; render(); });
    $('czDateInput').addEventListener('change', (e) => { if (validIso(e.target.value)) goDate(e.target.value, view === 'list' ? 'day' : null); });
    $('czViews').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) { if (statusFilter === 'overdue') statusFilter = null; setView(b.dataset.view); } });
    let searchTimer = null;
    $('czSearch').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchQ = norm(e.target.value); render(); }, 120); });

    // Pano ve yan panel: olay devri (satır içi onclick YOK).
    function onBoardClick(e) {
        const qa = e.target.closest('[data-qa]');
        if (qa) { e.stopPropagation(); quickAction(qa.dataset.id, qa.dataset.qa, qa); return; }
        const go = e.target.closest('[data-go-date]');
        if (go) { goDate(go.dataset.goDate, 'day'); return; }
        if (e.target.closest('[data-go="list"]')) { statusFilter = null; setView('list'); return; }
        if (e.target.closest('[data-clear]')) { statusFilter = null; typeFilter = null; searchQ = ''; $('czSearch').value = ''; render(); return; }
        if (e.target.closest('[data-new]')) { openNewRes({ date: cursor }); return; }
        if (e.target.closest('[data-past]')) { showPast = true; render(); return; }
        const sg = e.target.closest('[data-status-go]');
        if (sg) { statusFilter = sg.dataset.statusGo; setView('list'); return; }
        const it = e.target.closest('[data-id]');
        if (it) openDetailById(it.dataset.id);
    }
    $('czBoard').addEventListener('click', onBoardClick);
    document.querySelector('.cz-aside').addEventListener('click', onBoardClick);
    $('czBoard').addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('cz-res')) { e.preventDefault(); openDetailById(e.target.dataset.id); }
    });
    function markSelected() {
        document.querySelectorAll('.cz-res.is-sel').forEach(el => el.classList.remove('is-sel'));
        if (!selectedId) return;
        document.querySelectorAll('.cz-res').forEach(el => { if (el.dataset.id === selectedId) el.classList.add('is-sel'); });
    }

    // ── DURUM DEĞİŞTİRME (tek kapı) ───────────────────────────
    // Terminal durum koruması: iptal edilmiş (özellikle misafirin iptal ettiği)
    // ya da tamamlanmış kayıt geri çevrilemez — misafir ekranı ve QR siparişi
    // de bu durumda kalır (sunucu senkronu geri almaz).
    async function setStatus(r, st, extra) {
        const cur = stOf(r);
        if ((cur === 'Cancelled' || cur === 'Done') && st !== cur) {
            const who = r.cancelledBy === 'guest' ? 'Misafir' : (r.cancelledBy || 'Personel');
            showToast(cur === 'Cancelled' ? ('Bu kayıt iptal edilmiş (' + who + '). Geri alınamaz — gerekiyorsa yeni kayıt oluşturun.') : 'Bu kayıt tamamlanmış. Geri alınamaz.', true);
            return false;
        }
        if (st === 'Confirmed' && needsVoucher(Object.assign({}, r, extra || {}))) {
            showToast('Onaylamak için voucher / onay no gerekli.', true);
            return false;
        }
        const upd = Object.assign({ status: st, lastUpdated: firebase.firestore.FieldValue.serverTimestamp() }, extra || {});
        if (st === 'Confirmed') { upd.confirmedBy = loggedUsername; upd.confirmedAt = firebase.firestore.FieldValue.serverTimestamp(); }
        if (st === 'Done') { upd.completedBy = loggedUsername; upd.completedAt = firebase.firestore.FieldValue.serverTimestamp(); }
        try {
            await db.collection('reservations').doc(r.id).update(upd);
            return true;
        } catch (e) { showToast('Durum değiştirilemedi.', true); return false; }
    }
    const armed = new WeakMap();
    async function quickAction(id, act, btn) {
        const r = reservations.find(x => x.id === id);
        if (!r) return;
        if (act === 'confirm') {
            if (needsVoucher(r)) { openDetail(r); openInline('voucher'); return; }
            btn.disabled = true;
            if (await setStatus(r, 'Confirmed')) {
                showToast(r.guestName + ' · ' + typeTr(r.type) + ' onaylandı', false, async () => {
                    try { await db.collection('reservations').doc(r.id).update({ status: 'Pending' }); showToast('Onay geri alındı'); }
                    catch (e) { showToast('Geri alınamadı.', true); }
                });
            }
            btn.disabled = false;
        } else if (act === 'done') {
            // İki dokunuş: tamamlandı geri alınamaz.
            if (!armed.get(btn)) {
                armed.set(btn, true);
                btn.classList.add('arm');
                const old = btn.innerHTML;
                btn.innerHTML = 'Emin misiniz?';
                setTimeout(() => { if (btn.isConnected) { btn.classList.remove('arm'); btn.innerHTML = old; } armed.delete(btn); }, 3000);
                return;
            }
            btn.disabled = true;
            if (await setStatus(r, 'Done')) showToast(r.guestName + ' · ' + typeTr(r.type) + ' tamamlandı');
        }
    }

    // ── MİSAFİR YARDIMCILARI ──────────────────────────────────
    const findGuest = (name, guestId) => {
        if (guestId) { const g = guestDirectory.find(x => x.id === guestId); if (g) return g; }
        const n = norm(name);
        return n ? guestDirectory.find(x => norm(x.name) === n) || null : null;
    };
    const initials = (n) => String(n || '').trim().split(/\s+/).map(s => s[0] || '').slice(0, 2).join('').toLocaleUpperCase('tr-TR') || '·';
    function guestState(g) {
        if (!g) return null;
        if (g.status === 'in_house') return ['in', 'Konaklıyor'];
        if (g.status === 'pre_arrival' || g.room === 'Pre-Arrival') return ['pre', 'Ön geliş'];
        return ['out', 'Çıkış yaptı'];
    }
    const stayText = (g) => {
        if (!g || (!g.checkIn && !g.checkOut)) return '';
        const f = (iso) => validIso(iso) ? fmtDayShort(iso) : '?';
        return f(g.checkIn) + ' – ' + f(g.checkOut);
    };
    // Misafirin bu tarihte otelde olup olmadığı (konaklama tarihleri biliniyorsa).
    function outsideStay(g, iso) {
        if (!g || !validIso(iso)) return false;
        if (validIso(g.checkIn) && iso < g.checkIn) return true;
        if (validIso(g.checkOut) && iso > g.checkOut) return true;
        return false;
    }

    // ── AYRINTI ÇEKMECESİ ─────────────────────────────────────
    const detailOv = $('czDetailOv');
    let inlineMode = null;
    function openDetail(r) {
        if (!r) return;
        const same = selectedId === r.id;
        selectedId = r.id;
        window.selectedReservation = r;
        if (!same) inlineMode = null;
        populateDetail(r);
        openOv(detailOv);
        markSelected();
        if (!same) $('czDetailBody').scrollTop = 0;
    }
    function onDetailClosed() {
        selectedId = null;
        window.selectedReservation = null;
        inlineMode = null;
        markSelected();
    }
    function openDetailById(id) {
        const r = reservations.find(res => res.id === id);
        if (r) openDetail(r);
    }
    // QR çekmecesi (guest-orders.js) concierge kalemini buradan açar.
    window.openDetailById = (id) => {
        const r = reservations.find(res => res.id === id);
        if (r) openDetail(r);
    };
    $('detailClose').addEventListener('click', () => { closeOv(detailOv); onDetailClosed(); });

    const canDelete = (r) => r.staffInitial === loggedUsername || r.staffInitial === 'QR-Misafir';
    const tsText = (ts) => {
        const d = ts && ts.toDate ? ts.toDate() : null;
        return d ? d.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    };

    function populateDetail(r) {
        const st = stOf(r), k = typeKey(r.type);
        const g = findGuest(r.guestName, r.guestId);
        const ti = $('d-typeIc'); ti.className = 'cz-type-ic t-' + k; ti.innerHTML = svcIcon(r.type);
        $('d-type').textContent = typeTr(r.type);
        const ds = $('d-status'); ds.className = 'cz-st st-' + st; ds.textContent = ST_TR[st];
        $('d-guest').textContent = r.guestName || '—';
        const dr = $('d-room');
        const pre = !r.room || r.room === 'Pre-Arrival';
        dr.className = 'cz-room' + (pre ? ' pre' : ''); dr.textContent = pre ? 'Ön geliş' : 'Oda ' + r.room;
        const gs = guestState(g);
        $('d-stay').textContent = [gs ? gs[1] : '', stayText(g)].filter(Boolean).join(' · ');

        // Durum şeridi
        let banner = '';
        if (st === 'Cancelled') {
            const who = r.cancelledBy === 'guest' ? 'Misafir iptal etti' : ('İptal eden: ' + (r.cancelledBy || '—'));
            banner = `<div class="cz-banner cancel">${ic('ban')}<div><b>${esc(who)}</b>${r.cancelReason ? esc(r.cancelReason) : ''}</div></div>`;
        } else if (st === 'Done') {
            banner = `<div class="cz-banner done">${ic('check')}<div><b>Tamamlandı</b>${esc([r.completedBy, tsText(r.completedAt)].filter(Boolean).join(' · '))}</div></div>`;
        } else if (isOverdueRes(r)) {
            banner = `<div class="cz-banner late">${ic('alert')}<div><b>Gecikti</b>Planlanan zaman geçti, kayıt hâlâ onay bekliyor. Onaylayın, tamamlayın ya da iptal edin.</div></div>`;
        }
        if (r.source === 'guest-order' && st !== 'Cancelled' && st !== 'Done') {
            banner += `<div class="cz-banner qr">${ic('qr')}<div><b>Misafirin QR talebi</b>Durum değişiklikleri misafirin ekranına anında yansır.</div></div>`;
        }
        if (g && outsideStay(g, r.date) && st !== 'Cancelled' && st !== 'Done') {
            banner += `<div class="cz-banner late">${ic('calendar')}<div><b>Konaklama dışında</b>Misafirin konaklaması ${esc(stayText(g))}; bu rezervasyonun tarihi bu aralıkta değil.</div></div>`;
        }
        $('d-banner').innerHTML = banner;

        // Ne zaman
        const rw = relWhen(r);
        $('d-when').innerHTML = validIso(r.date) ? `<span class="ic">${ic('clock')}</span><div><b>${esc((dayWord(r.date) ? dayWord(r.date) + ', ' : '') + fmtDayLong(r.date))}${r.time ? ' · ' + esc(r.time) : ''}</b>${rw ? `<small class="${rw.cls}">${esc(rw.text)}</small>` : (r.time ? '' : '<small>Saat belirtilmedi</small>')}</div>` : '';

        // Bağlama göre işlemler
        let acts = '';
        if (st === 'Pending') {
            acts = needsVoucher(r)
                ? `<button type="button" class="cz-btn success" data-act="voucher">${ic('check')} Voucher ekle ve onayla</button>`
                : `<button type="button" class="cz-btn success" data-act="confirm">${ic('check')} Onayla</button>`;
            acts += `<button type="button" class="cz-btn ghost" data-act="cancel">${ic('ban')} İptal et</button>`;
        } else if (st === 'Confirmed') {
            acts = `<button type="button" class="cz-btn primary" data-act="done">${ic('check')} Tamamlandı</button>`
                + `<button type="button" class="cz-btn ghost" data-act="pending">${ic('hourglass')} Beklemeye al</button>`
                + `<button type="button" class="cz-btn ghost" data-act="cancel">${ic('ban')} İptal et</button>`;
        }
        $('d-actions').innerHTML = acts;
        renderInline(r);

        // Hizmet ayrıntıları
        const rows = [];
        const add = (k2, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') rows.push(`<dt>${k2}</dt><dd>${esc(v)}</dd>`); };
        if (r.type === 'Transfer') { add('Nereden', r.from); add('Nereye', r.to); add('Araç / uçuş', r.vehicle); }
        else if (r.type === 'Boat' || r.type === 'Tour') { add(r.type === 'Boat' ? 'Tekne' : 'Tur', r.vessel); add('Sağlayıcı', r.provider); }
        else if (r.type === 'Restaurant' || r.type === 'Beach') add(r.type === 'Beach' ? 'Plaj / mekân' : 'Restoran', r.resName);
        else add('Hizmet', r.otherType || r.resName);
        add('Kişi', r.pax ? r.pax + ' kişi' : '');
        if (VOUCHER_REQ.includes(r.type) || r.voucherNo) {
            rows.push(`<dt>Voucher no</dt><dd>${r.voucherNo ? esc(r.voucherNo) : '<span class="cz-flag warn">Eksik</span>'}</dd>`);
        }
        const si = seriesInfo(r);
        if (si) rows.push(`<dt>Seri</dt><dd>${si.i}. / ${si.n} rezervasyon</dd>`);
        $('d-info').innerHTML = rows.join('');

        // Ödeme
        const total = Number(r.totalPrice) || 0, dep = Number(r.deposit) || 0, bal = balanceOf(r);
        let money = '';
        if (PAID_TYPES.includes(r.type) && (total > 0 || dep > 0)) {
            const cur = r.currency || 'EUR';
            const balBox = r.folioApplied
                ? `<div class="ok"><span>Oda hesabında</span><b>${esc(fmtMoney(r.folioAmount != null ? r.folioAmount : bal, cur))}</b></div>`
                : (bal > 0 ? `<div class="due"><span>Kalan</span><b>${esc(fmtMoney(bal, cur))}</b></div>` : `<div class="ok"><span>Kalan</span><b>Ödendi</b></div>`);
            money = `<h4>Ödeme</h4><div class="cz-moneybox"><div><span>Tutar</span><b>${esc(fmtMoney(total, cur))}</b></div><div><span>Kapora</span><b>${esc(fmtMoney(dep, cur))}</b></div>${balBox}</div>`;
            // Bakiye varsa, oda gerçek bir numaraya atanmışsa ve daha önce
            // yansıtılmamışsa "oda hesabına yansıt" sunulur (sunucuda hesaplanır).
            if (!r.folioApplied && bal > 0 && !pre && st !== 'Cancelled') {
                money += `<button type="button" class="cz-btn" id="d-applyFolioBtn" data-act="folio">${ic('receipt')} Kalan bakiyeyi oda hesabına yansıt</button>`;
            } else if (!r.folioApplied && bal > 0 && pre && st !== 'Cancelled') {
                money += `<p class="cz-hint">Oda atandığında kalan bakiye oda hesabına yansıtılabilir.</p>`;
            }
        }
        $('d-money').innerHTML = money;

        const notes = $('d-notes');
        notes.textContent = r.notes || 'Not yok.';
        notes.className = r.notes ? '' : 'muted';

        const creator = r.staffInitial === 'QR-Misafir' ? 'Misafir (QR)' : (r.staffInitial || '—');
        const meta = [['Oluşturan', creator + (tsText(r.createdAt) ? ' · ' + tsText(r.createdAt) : '')]];
        if (r.confirmedBy) meta.push(['Onaylayan', r.confirmedBy + (tsText(r.confirmedAt) ? ' · ' + tsText(r.confirmedAt) : '')]);
        if (r.lastUpdated) meta.push(['Son değişiklik', tsText(r.lastUpdated)]);
        $('d-meta').innerHTML = '<h4>Kayıt</h4><dl class="cz-dl">' + meta.filter(m => m[1]).map(m => `<dt>${m[0]}</dt><dd>${esc(m[1])}</dd>`).join('') + '</dl>';

        // Aynı misafirin diğer rezervasyonları
        const n = norm(r.guestName);
        const others = reservations.filter(x => x.id !== r.id && ((r.guestId && x.guestId === r.guestId) || (n && norm(x.guestName) === n)) && stOf(x) !== 'Cancelled');
        const t = todayIso();
        const upcoming = others.filter(x => x.date >= t).sort(byTime);
        const past = others.filter(x => x.date < t).sort(byTime).reverse();
        const rel = upcoming.concat(past).slice(0, 5);
        $('d-related').innerHTML = !others.length ? '' : `<h4>Misafirin diğer rezervasyonları (${others.length})</h4><div class="cz-rel">${rel.map(x =>
            `<button type="button" data-id="${esc(x.id)}"><span class="cz-res-ic t-${typeKey(x.type)}">${svcIcon(x.type)}</span><span><b>${esc(typeTr(x.type))}${x.time ? ' · ' + esc(x.time) : ''}</b><small>${esc(dayWord(x.date) || fmtDayLong(x.date))}</small></span><span class="cz-st st-${stOf(x)}">${ST_TR[stOf(x)]}</span></button>`).join('')}</div>`
            + (upcoming.length ? `<button type="button" class="cz-btn ghost sm" data-act="iti" style="margin-top:8px;width:100%">${ic('file')} Misafir programı (PDF)</button>` : '');

        $('d-deleteBtn').hidden = !canDelete(r);
        $('d-editBtn').hidden = st === 'Cancelled';
    }

    // Çekmece içi pencereler: voucher · iptal nedeni · silme onayı (prompt/confirm yok).
    const CANCEL_REASONS = ['Misafir vazgeçti', 'Hava koşulları', 'Tedarikçi iptal etti', 'Yer / araç yok', 'Tarih değişti'];
    function renderInline(r) {
        const box = $('d-inline');
        if (!inlineMode) { box.hidden = true; box.innerHTML = ''; box.className = 'cz-inline'; return; }
        box.hidden = false;
        box.className = 'cz-inline' + (inlineMode === 'cancel' || inlineMode === 'delete' ? ' bad' : '');
        if (inlineMode === 'voucher') {
            box.innerHTML = `<h4>Voucher / onay no</h4><p>${esc(typeTr(r.type))} rezervasyonunu onaylamak için tedarikçinin verdiği onay numarası gerekli.</p>
                <input type="text" id="d-voucherIn" autocomplete="off" placeholder="Örn. TRF-48213" value="${esc(r.voucherNo || '')}">
                <div class="cz-inline-act"><button type="button" class="cz-btn ghost sm" data-act="inline-close">Vazgeç</button><button type="button" class="cz-btn success sm" data-act="voucher-save">${ic('check')} Kaydet ve onayla</button></div>`;
            setTimeout(() => $('d-voucherIn')?.focus(), 30);
        } else if (inlineMode === 'cancel') {
            box.innerHTML = `<h4>İptal nedeni</h4><p>${r.source === 'guest-order' ? 'Neden misafirin ekranında gösterilir.' : 'Neden kayıtta saklanır.'} İptal geri alınamaz.</p>
                <div class="cz-quick">${CANCEL_REASONS.map(x => `<button type="button" data-reason="${esc(x)}">${esc(x)}</button>`).join('')}</div>
                <textarea id="d-cancelIn" rows="2" maxlength="300" placeholder="Nedeni yazın"></textarea>
                <div class="cz-inline-act"><button type="button" class="cz-btn ghost sm" data-act="inline-close">Vazgeç</button><button type="button" class="cz-btn danger sm" data-act="cancel-save">${ic('ban')} Rezervasyonu iptal et</button></div>`;
            setTimeout(() => $('d-cancelIn')?.focus(), 30);
        } else if (inlineMode === 'delete') {
            box.innerHTML = `<h4>Rezervasyonu kalıcı olarak sil</h4><p>Silinen kayıt geri getirilemez; raporlarda da görünmez. İptal etmek çoğu zaman daha doğrudur. Onay için şifrenizi girin.</p>
                <input type="password" id="d-delPass" autocomplete="current-password" placeholder="Şifreniz">
                <div class="cz-inline-act"><button type="button" class="cz-btn ghost sm" data-act="inline-close">Vazgeç</button><button type="button" class="cz-btn danger sm" data-act="delete-save">${ic('trash')} Kalıcı olarak sil</button></div>`;
            setTimeout(() => $('d-delPass')?.focus(), 30);
        }
    }
    function openInline(mode) {
        const r = window.selectedReservation;
        if (!r) return;
        inlineMode = mode;
        renderInline(r);
        $('d-inline').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    $('czDetailBody').addEventListener('click', async (e) => {
        const r = window.selectedReservation;
        if (!r) return;
        const reason = e.target.closest('[data-reason]');
        if (reason) {
            const ta = $('d-cancelIn'); if (ta) { ta.value = reason.dataset.reason; ta.focus(); }
            reason.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === reason));
            return;
        }
        const rel = e.target.closest('.cz-rel [data-id]');
        if (rel) { openDetailById(rel.dataset.id); return; }
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'confirm') {
            b.disabled = true;
            if (await setStatus(r, 'Confirmed')) {
                showToast('Onaylandı', false, async () => {
                    try { await db.collection('reservations').doc(r.id).update({ status: 'Pending' }); showToast('Onay geri alındı'); }
                    catch (err) { showToast('Geri alınamadı.', true); }
                });
            }
            b.disabled = false;
        } else if (act === 'voucher') openInline('voucher');
        else if (act === 'cancel') openInline('cancel');
        else if (act === 'inline-close') { inlineMode = null; renderInline(r); }
        else if (act === 'pending') { if (await setStatus(r, 'Pending')) showToast('Beklemeye alındı'); }
        else if (act === 'done') {
            if (b.dataset.armed !== '1') {
                b.dataset.armed = '1';
                b.innerHTML = ic('check') + ' Emin misiniz? Geri alınamaz';
                setTimeout(() => { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.innerHTML = ic('check') + ' Tamamlandı'; } }, 3500);
                return;
            }
            b.disabled = true;
            if (await setStatus(r, 'Done')) showToast('Tamamlandı olarak işaretlendi');
            b.disabled = false;
        } else if (act === 'voucher-save') {
            const v = ($('d-voucherIn').value || '').trim();
            if (!v) { $('d-voucherIn').classList.add('bad'); $('d-voucherIn').focus(); return; }
            b.disabled = true;
            const ok = stOf(r) === 'Pending' ? await setStatus(r, 'Confirmed', { voucherNo: v }) : await db.collection('reservations').doc(r.id).update({ voucherNo: v }).then(() => true, () => false);
            b.disabled = false;
            if (ok) { inlineMode = null; showToast(stOf(r) === 'Pending' ? 'Voucher kaydedildi, onaylandı' : 'Voucher kaydedildi'); }
        } else if (act === 'cancel-save') {
            const reasonTxt = ($('d-cancelIn').value || '').trim();
            if (!reasonTxt) { $('d-cancelIn').classList.add('bad'); $('d-cancelIn').focus(); showToast('İptal nedeni belirtmelisiniz.', true); return; }
            b.disabled = true;
            const ok = await setStatus(r, 'Cancelled', { cancelReason: reasonTxt.slice(0, 300), cancelledBy: loggedUsername });
            b.disabled = false;
            if (ok) { inlineMode = null; showToast('Rezervasyon iptal edildi'); }
        } else if (act === 'delete-save') {
            await deleteReservation(r, b);
        } else if (act === 'folio') {
            await applyToFolio(r);
        } else if (act === 'iti') {
            closeOv(detailOv); onDetailClosed();
            openItinerary(r.guestName);
        }
    });
    $('czDetailBody').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        const id = e.target && e.target.id;
        const map = { 'd-voucherIn': 'voucher-save', 'd-delPass': 'delete-save' };
        if (map[id]) { e.preventDefault(); document.querySelector(`#d-inline [data-act="${map[id]}"]`)?.click(); }
    });

    // Silme: yalnızca oluşturan (ya da QR kaynaklı kayıtlar — firestore.rules
    // ile aynı istisna) ve şifre yeniden doğrulanarak.
    async function deleteReservation(r, btn) {
        if (!canDelete(r)) { showToast('Bu kaydı yalnızca oluşturan kişi silebilir!', true); return; }
        const passEl = $('d-delPass');
        const password = passEl ? passEl.value : '';
        if (!password) { showToast('Lütfen şifrenizi girin', true); passEl?.focus(); return; }
        btn.disabled = true;
        const old = btn.innerHTML;
        btn.textContent = 'Doğrulanıyor…';
        try {
            const user = firebase.auth().currentUser;
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
            await user.reauthenticateWithCredential(credential);
            await db.collection('reservations').doc(r.id).delete();
            closeOv(detailOv); onDetailClosed();
            showToast('Rezervasyon silindi');
        } catch (e) {
            showToast('Doğrulama başarısız. Şifre yanlış.', true);
            if (passEl) { passEl.value = ''; passEl.classList.add('bad'); passEl.focus(); }
        } finally {
            if (btn.isConnected) { btn.disabled = false; btn.innerHTML = old; }
        }
    }

    // Ödeme gerektiren rezervasyonların kalan bakiyesini misafirin oda hesabına
    // (folio) yansıtır. F4.5: folio CREATE istemciye kapalı — bakiye SUNUCUDA
    // hesaplanır (applyReservationFolio), folioApplied + operationId çift
    // yansıtmayı engeller, audit'e yazılır.
    async function applyToFolio(r) {
        if (!r) return;
        if (!r.room || r.room === 'Pre-Arrival') { showToast('Oda ataması olmayan rezervasyon oda hesabına yansıtılamaz.', true); return; }
        const btn = $('d-applyFolioBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Yansıtılıyor…'; }
        try {
            const call = firebase.app().functions('us-central1').httpsCallable('applyReservationFolio');
            const opId = 'op' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            const res = await call({ operationId: opId, reservationId: r.id });
            const updated = Object.assign({}, r, { folioApplied: true, folioAmount: res.data.balance });
            window.selectedReservation = updated;
            populateDetail(updated);
            showToast('Oda hesabına yansıtıldı.');
        } catch (e) {
            const det = (e && e.details) || {};
            if (det.already) showToast('Bu rezervasyon zaten oda hesabına yansıtılmış.', true);
            else if (det.noBalance) showToast('Yansıtılacak bakiye yok.', true);
            else if (String(e && e.code).includes('not-found') && !det.errCode) showToast('Servis henüz yüklenmemiş (deploy eksik) — yöneticinizle iletişime geçin.', true);
            else showToast('Yansıtılamadı: ' + ((e && e.message) || 'hata'), true);
            const b2 = $('d-applyFolioBtn');
            if (b2) { b2.disabled = false; b2.innerHTML = ic('receipt') + ' Kalan bakiyeyi oda hesabına yansıt'; }
        }
    }

    $('d-confirmLetterBtn').addEventListener('click', () => { if (window.selectedReservation) generateConfirmationPDF(window.selectedReservation); });
    $('d-deleteBtn').addEventListener('click', () => {
        const r = window.selectedReservation;
        if (!r) return;
        if (!canDelete(r)) { showToast('Bu kaydı yalnızca oluşturan kişi silebilir!', true); return; }
        openInline('delete');
    });
    $('d-editBtn').addEventListener('click', () => {
        const r = window.selectedReservation;
        if (!r) return;
        closeOv(detailOv); onDetailClosed();
        openEditRes(r);
    });
    $('d-dupBtn').addEventListener('click', () => {
        const r = window.selectedReservation;
        if (!r) return;
        closeOv(detailOv); onDetailClosed();
        const t = todayIso();
        openNewRes(Object.assign({}, r, { date: r.date > t ? isoAdd(r.date, 1) : t, voucherNo: '', deposit: '', __dup: true }));
    });

    // ── REZERVASYON FORMU ─────────────────────────────────────
    const formOv = $('czFormOv');
    const dynamicFields = $('rs-dynamic-fields');
    const DYN_KEYS = ['resName', 'pax', 'from', 'to', 'vehicle', 'vessel', 'provider', 'otherType'];
    let editResId = null;
    // Düzenleme açıldığındaki son güncelleme zamanı — kaydederken bir
    // transaction içinde bununla karşılaştırılır (kayıp güncelleme önlemi:
    // aynı rezervasyonu iki personel eşzamanlı düzenlerse ikinci kayıt
    // ilkini sessizce ezmez).
    let editResBaseUpdatedAt = null;
    let editResStatus = null;
    let formSnap = '';
    let seriesAck = false;

    // Daha önce girilmiş değerlerden öneriler (restoran adları, güzergâhlar, tekneler…).
    function suggest(key, type) {
        const cnt = {};
        reservations.forEach(r => {
            if (type && r.type !== type) return;
            const v = String(r[key] || '').trim();
            if (v && v.length < 60) cnt[v] = (cnt[v] || 0) + 1;
        });
        return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 12);
    }
    function field(key, label, opts) {
        opts = opts || {};
        const list = opts.sug ? suggest(key, opts.sugType) : [];
        const dl = list.length ? `<datalist id="czSug-${key}">${list.map(v => `<option value="${esc(v)}">`).join('')}</datalist>` : '';
        return `<div class="cz-field${opts.cls ? ' ' + opts.cls : ''}"><label for="rs-${key}">${label}</label><input type="${opts.num ? 'number' : 'text'}" id="rs-${key}"${opts.num ? ' min="1" max="99" inputmode="numeric"' : ''}${list.length ? ` list="czSug-${key}"` : ''} placeholder="${esc(opts.ph || '')}" autocomplete="off">${dl}</div>`;
    }
    function dynHtml(type) {
        if (type === 'Restaurant') return `<div class="cz-row">${field('resName', 'Restoran', { sug: true, sugType: 'Restaurant', ph: 'Restoran adı', cls: 'grow' })}${field('pax', 'Kişi', { num: true, cls: 'room' })}</div>`;
        if (type === 'Beach') return `<div class="cz-row">${field('resName', 'Plaj / mekân', { sug: true, sugType: 'Beach', ph: 'Plaj ya da beach club', cls: 'grow' })}${field('pax', 'Kişi', { num: true, cls: 'room' })}</div>`;
        if (type === 'Transfer') return `<div class="cz-row">${field('from', 'Nereden', { sug: true, ph: 'Örn. Otel' })}${field('to', 'Nereye', { sug: true, ph: 'Örn. Havalimanı' })}</div>
            <div class="cz-row" style="margin-top:10px">${field('vehicle', 'Araç / uçuş no', { sug: true, sugType: 'Transfer', ph: 'Örn. Vito · TK 2412', cls: 'grow' })}${field('pax', 'Kişi', { num: true, cls: 'room' })}</div>`;
        if (type === 'Boat' || type === 'Tour') return `${field('vessel', type === 'Boat' ? 'Tekne' : 'Tur', { sug: true, sugType: type, ph: type === 'Boat' ? 'Tekne adı' : 'Tur adı' })}
            <div class="cz-row" style="margin-top:10px">${field('provider', 'Sağlayıcı / rehber', { sug: true, sugType: type, cls: 'grow' })}${field('pax', 'Kişi', { num: true, cls: 'room' })}</div>`;
        const ph = type === 'Cake' ? 'Örn. Doğum günü pastası, 6 kişilik' : (type === 'Flower' ? 'Örn. Oda süslemesi, gül buketi' : 'Örn. Spa, araç kiralama, bebek bakıcısı');
        return field('otherType', 'Hizmet', { sug: true, sugType: type, ph });
    }
    function setType(type) {
        if (!TYPE_TR[type]) type = 'Restaurant';
        // Tür değişse de ortak alanların (kişi sayısı vb.) değeri korunur.
        const keep = {};
        dynamicFields.querySelectorAll('input').forEach(i => { if (i.value) keep[i.id] = i.value; });
        $('rs-type').value = type;
        document.querySelectorAll('#czTypeTiles .cz-tile').forEach(t => {
            const on = t.dataset.type === type;
            t.setAttribute('aria-checked', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
        });
        dynamicFields.innerHTML = dynHtml(type);
        Object.keys(keep).forEach(id => { const el = $(id); if (el) el.value = keep[id]; });
        $('czDetailsTitle').textContent = typeTr(type) + ' ayrıntıları';
        const paid = PAID_TYPES.includes(type);
        $('rs-finance-box').hidden = !paid;
        $('rs-voucher-group').hidden = !paid;
        const vl = document.querySelector('label[for="rs-voucher"] small');
        if (vl) vl.textContent = VOUCHER_REQ.includes(type) ? '(onaylamak için gerekli)' : '(isteğe bağlı)';
        refreshForm();
    }
    $('czTypeTiles').addEventListener('click', (e) => { const t = e.target.closest('.cz-tile'); if (t) setType(t.dataset.type); });
    $('czTypeTiles').addEventListener('keydown', (e) => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
        const tiles = Array.from(document.querySelectorAll('#czTypeTiles .cz-tile'));
        const i = tiles.findIndex(t => t.dataset.type === $('rs-type').value);
        const d = (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 4 : -4);
        const n = tiles[(i + d + tiles.length) % tiles.length];
        setType(n.dataset.type); n.focus(); e.preventDefault();
    });

    // Para birimi
    function setCur(c) {
        if (!CUR_SYM[c]) c = 'EUR';
        $('rs-currency').value = c;
        document.querySelectorAll('#czCurSeg [data-cur]').forEach(b => b.setAttribute('aria-checked', b.dataset.cur === c ? 'true' : 'false'));
        refreshForm();
    }
    $('czCurSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-cur]'); if (b) setCur(b.dataset.cur); });

    // Ön geliş
    function setPreArrival(on) {
        $('rs-isPreArrival').checked = on;
        const room = $('rs-room');
        room.disabled = on;
        if (on) room.value = '';
        room.placeholder = on ? '—' : 'No';
        $('rs-dates-wrapper').hidden = !on;
    }
    $('rs-isPreArrival').addEventListener('change', (e) => { setPreArrival(e.target.checked); refreshForm(); });

    // Tarih kısayolları
    $('czDateQuick').addEventListener('click', (e) => {
        const b = e.target.closest('[data-d]'); if (!b) return;
        $('rs-date').value = isoAdd(todayIso(), +b.dataset.d);
        refreshForm();
    });

    // Tekrarlama (seri)
    function repeatDates() {
        const baseIso = $('rs-date').value;
        if (!validIso(baseIso)) return [];
        if (editResId || !$('rs-repeatOn').checked) return [baseIso];
        const count = Math.max(2, Math.min(30, parseInt($('rs-repeatCount').value, 10) || 2));
        const stepN = parseInt($('rs-repeatInterval').value, 10) || 1;
        const out = [];
        for (let i = 0; i < count; i++) out.push(isoAdd(baseIso, i * stepN));
        return out;
    }
    $('rs-repeatOn').addEventListener('change', (e) => { $('rs-repeatOpts').hidden = !e.target.checked; refreshForm(); });

    // ── Misafir seçici (rehber + geçmiş rezervasyonlar + PMS) ──
    const guestIn = $('rs-guest'), roomIn = $('rs-room'), gList = $('czGuestList');
    let gItems = [], gActive = -1, pmsTimer = null, pmsSeq = 0;
    function localGuestMatches(q, byRoom) {
        const out = [], seen = new Set();
        const rank = (g) => g.status === 'in_house' ? 0 : (g.status === 'pre_arrival' ? 1 : 2);
        guestDirectory.slice().sort((a, b) => rank(a) - rank(b)).forEach(g => {
            const name = String(g.name || '').trim();
            if (!name) return;
            const hit = byRoom ? String(g.room || '') === q : (norm(name).includes(q) || (/^\d+$/.test(q) && String(g.room || '').startsWith(q)));
            if (!hit || seen.has(norm(name))) return;
            seen.add(norm(name));
            out.push({ name, room: g.room && g.room !== 'Pre-Arrival' ? g.room : '', checkIn: g.checkIn, checkOut: g.checkOut, g, src: 'dir' });
        });
        if (!byRoom) Object.keys(guestMap).forEach(name => {
            if (seen.has(norm(name)) || !norm(name).includes(q)) return;
            seen.add(norm(name));
            out.push({ name, room: guestMap[name] !== 'Pre-Arrival' ? guestMap[name] : '', src: 'res' });
        });
        return out.slice(0, 8);
    }
    function renderGuestList(local, pms) {
        gItems = local.concat(pms || []);
        gActive = -1;
        if (!gItems.length) { gList.hidden = true; return; }
        const row = (it, i) => {
            const st = it.g ? guestState(it.g) : null;
            const tag = it.src === 'pms' ? `<span class="tag pms">${it._demo ? 'DEMO' : 'PMS'}</span>` : (st ? `<span class="tag ${st[0] === 'in' ? '' : st[0]}">${st[1]}</span>` : '');
            const sub = [it.room ? 'Oda ' + it.room : (st && st[0] === 'pre' ? 'Oda atanmadı' : ''), stayText(it)].filter(Boolean).join(' · ') || 'Önceki rezervasyonlardan';
            return `<div class="cz-dd-it" role="option" data-i="${i}"><span class="av">${esc(initials(it.name))}</span><span><b>${esc(it.name)}${it.vip ? ' · VIP' : ''}</b><small>${esc(sub)}</small></span>${tag}</div>`;
        };
        let html = local.map(row).join('');
        if (pms && pms.length) html += `<div class="cz-dd-h">${pms.some(p => p._demo) ? 'PMS · DEMO VERİ — gerçek misafir değil' : 'PMS'}</div>` + pms.map((it, j) => row(it, local.length + j)).join('');
        gList.innerHTML = html;
        gList.hidden = false;
    }
    function guestSearch(fromRoom) {
        const raw = (fromRoom ? roomIn : guestIn).value.trim();
        const q = norm(raw);
        if (!q || (!fromRoom && q.length < 2 && !/^\d+$/.test(q))) { gList.hidden = true; return; }
        if (fromRoom && guestIn.value.trim()) { gList.hidden = true; return; }
        const local = localGuestMatches(q, fromRoom);
        renderGuestList(local, []);
        clearTimeout(pmsTimer);
        if (!fromRoom && window.PMS && PMS.enabled && PMS.enabled() && raw.length >= 2) {
            const seq = ++pmsSeq;
            pmsTimer = setTimeout(async () => {
                const list = await PMS.lookup(raw);
                if (seq !== pmsSeq || document.activeElement !== guestIn) return;
                const names = new Set(local.map(l => norm(l.name)));
                const pms = (list || []).filter(p => p && p.name && !names.has(norm(p.name))).slice(0, 6).map(p => Object.assign({}, p, { src: 'pms' }));
                renderGuestList(local, pms);
            }, 320);
        }
    }
    function pickGuest(it) {
        if (!it) return;
        guestIn.value = it.name;
        const g = it.g || findGuest(it.name);
        const isPre = g ? (g.status === 'pre_arrival' || g.room === 'Pre-Arrival') : false;
        setPreArrival(!!isPre && !it.room);
        if (it.room) { roomIn.disabled = false; roomIn.value = it.room; }
        // Sunucu/rehber tarihleri YYYY-MM-DD; <input type="date"> başka biçimi boşaltır.
        if (validIso(it.checkIn)) $('rs-checkIn').value = it.checkIn;
        if (validIso(it.checkOut)) $('rs-checkOut').value = it.checkOut;
        gList.hidden = true;
        refreshForm();
        (it.room || isPre ? $('rs-date') : roomIn).focus();
    }
    guestIn.addEventListener('input', () => { guestSearch(false); refreshForm(); });
    guestIn.addEventListener('focus', () => { if (guestIn.value.trim()) guestSearch(false); });
    roomIn.addEventListener('input', () => { guestSearch(true); refreshForm(); });
    [guestIn, roomIn].forEach(inp => {
        inp.addEventListener('blur', () => setTimeout(() => { if (!gList.contains(document.activeElement)) gList.hidden = true; }, 160));
        inp.addEventListener('keydown', (e) => {
            if (gList.hidden || !gItems.length) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                gActive = e.key === 'ArrowDown' ? Math.min(gActive + 1, gItems.length - 1) : Math.max(gActive - 1, 0);
                gList.querySelectorAll('.cz-dd-it').forEach((el, i) => el.classList.toggle('act', i === gActive));
                gList.querySelector('.cz-dd-it.act')?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && gActive >= 0) { e.preventDefault(); pickGuest(gItems[gActive]); }
            else if (e.key === 'Escape') { e.stopPropagation(); gList.hidden = true; }
        });
    });
    gList.addEventListener('mousedown', (e) => {
        const it = e.target.closest('.cz-dd-it'); if (!it) return;
        e.preventDefault();
        pickGuest(gItems[+it.dataset.i]);
    });

    function renderGuestCard() {
        const card = $('czGuestCard');
        const name = guestIn.value.trim();
        if (!name) { card.hidden = true; return; }
        const g = findGuest(name);
        const n = norm(name), t = todayIso();
        const list = reservations.filter(r => norm(r.guestName) === n && r.id !== editResId && stOf(r) !== 'Cancelled' && r.date >= t).sort(byTime);
        // Yazarken (rehberde eşleşen adlar varken) "yeni misafir" denmez.
        if (!g && !guestMap[name] && localGuestMatches(n, false).length) { card.hidden = true; return; }
        if (!g && !list.length && !guestMap[name]) {
            card.className = 'cz-guestcard new';
            card.innerHTML = `<span class="av">${esc(initials(name))}</span><span><b>Yeni misafir</b><small>Kaydedildiğinde misafir rehberine (CRM) eklenecek.</small></span>`;
            card.hidden = false;
            return;
        }
        const st = guestState(g);
        const sub = [st ? st[1] : '', stayText(g)].filter(Boolean).join(' · ') || 'Önceki rezervasyonlardan';
        const next = list.slice(0, 3).map(r => `${typeTr(r.type)} ${dayWord(r.date) || fmtDayShort(r.date)}${r.time ? ' ' + r.time : ''}`).join(' · ');
        card.className = 'cz-guestcard';
        card.innerHTML = `<span class="av">${esc(initials(name))}</span><span><b>${esc(g ? g.name : name)}</b><small>${esc(sub)}</small>${list.length ? `<small>${list.length} yaklaşan rezervasyon: ${esc(next)}${list.length > 3 ? ' …' : ''}</small>` : ''}</span>`;
        card.hidden = false;
    }

    // ── Canlı uyarılar ────────────────────────────────────────
    // Aynı misafir ±2 saat (seride TÜM tarihler), aynı araç/tekne başka
    // misafirde, misafir o tarihte otelde değil, geçmiş zaman, kapora > tutar.
    // Bilgilendiricidir; yalnız seri çakışması kayıttan önce bir kez onay ister.
    function sameGuestClash(date, guestName, time) {
        const entry = parseTimeToMins(time);
        if (entry === null) return [];
        return reservations.filter(r => {
            if (editResId && r.id === editResId) return false;
            if (stOf(r) === 'Cancelled' || r.date !== date || !r.time) return false;
            if (norm(r.guestName) !== norm(guestName)) return false;
            const m = parseTimeToMins(r.time);
            return m !== null && Math.abs(entry - m) <= 120;
        });
    }
    const seriesConflicts = (dates, guestName, time) => dates.filter(d => sameGuestClash(d, guestName, time).length);
    function resourceClash(type, date, time, guestName) {
        const key = type === 'Transfer' ? 'vehicle' : ((type === 'Boat' || type === 'Tour') ? 'vessel' : null);
        if (!key) return [];
        const val = norm(($('rs-' + key) || {}).value);
        const entry = parseTimeToMins(time);
        if (!val || entry === null) return [];
        return reservations.filter(r => {
            if (editResId && r.id === editResId) return false;
            if (r.type !== type || stOf(r) === 'Cancelled' || r.date !== date || !r.time) return false;
            if (norm(r[key]) !== val || norm(r.guestName) === norm(guestName)) return false;
            return Math.abs(parseTimeToMins(r.time) - entry) <= 90;
        });
    }
    function formWarnings() {
        const out = [];
        const name = guestIn.value.trim(), date = $('rs-date').value, time = $('rs-time').value, type = $('rs-type').value;
        const dates = repeatDates();
        if (name && time && dates.length) {
            if (dates.length > 1) {
                const cd = seriesConflicts(dates, name, time);
                if (cd.length) out.push({ kind: 'series', bad: true, title: `${cd.length} tarihte yakın saatte başka kayıt var`, text: 'Bu misafirin ±2 saat içinde başka rezervasyonu olan tarihler: ' + cd.slice(0, 5).map(fmtDayShort).join(', ') + (cd.length > 5 ? ' …' : '') });
            } else {
                const c = sameGuestClash(date, name, time);
                if (c.length) out.push({ kind: 'clash', title: 'Yakın saatte başka kayıt var', text: 'Bu misafirin ±2 saat içinde: ' + c.map(x => typeTr(x.type) + ' ' + x.time).join(', ') });
            }
        }
        if (date && time) {
            const rc = resourceClash(type, date, time, name);
            if (rc.length) out.push({ kind: 'res', title: type === 'Transfer' ? 'Aynı araç başka misafire ayrılmış' : 'Aynı tekne / tur başka misafire ayrılmış', text: rc.map(x => x.guestName + ' · ' + x.time).join(', ') + ' (±90 dk)' });
        }
        const g = name ? findGuest(name) : null;
        if (g && validIso(date) && outsideStay(g, date)) out.push({ kind: 'stay', title: 'Misafir bu tarihte otelde değil', text: 'Konaklama: ' + stayText(g) });
        if (!editResId && validIso(date)) {
            const t = todayIso();
            if (date < t || (date === t && time && time < nowHM())) out.push({ kind: 'past', title: 'Geçmiş bir zaman seçildi', text: 'Tarih ve saati kontrol edin.' });
        }
        const price = parseFloat($('rs-price').value) || 0, dep = parseFloat($('rs-deposit').value) || 0;
        if (PAID_TYPES.includes(type) && dep > 0 && dep > price) out.push({ kind: 'money', bad: true, title: 'Kapora tutardan büyük', text: 'Alınan kapora toplam tutarı aşıyor.' });
        return out;
    }

    function refreshForm() {
        const type = $('rs-type').value;
        // Bakiye
        const price = parseFloat($('rs-price').value) || 0, dep = parseFloat($('rs-deposit').value) || 0, cur = $('rs-currency').value;
        const bal = $('czBalance');
        if (!PAID_TYPES.includes(type) || (!price && !dep)) bal.innerHTML = '';
        else if (price - dep > 0) bal.innerHTML = 'Kalan bakiye: <b>' + esc(fmtMoney(price - dep, cur)) + '</b>' + (dep ? ' · kapora ' + esc(fmtMoney(dep, cur)) : '');
        else bal.innerHTML = '<span class="paid">Tamamı ödendi</span>';
        // Tarih kısayolları
        const d = $('rs-date').value, t = todayIso();
        document.querySelectorAll('#czDateQuick [data-d]').forEach(b => b.classList.toggle('on', d === isoAdd(t, +b.dataset.d)));
        // Seri ipucu
        const dates = repeatDates();
        $('rs-repeatHint').textContent = (!editResId && $('rs-repeatOn').checked && dates.length > 1)
            ? `${dates.length} rezervasyon oluşturulacak: ${dates.slice(0, 4).map(fmtDayShort).join(', ')}${dates.length > 4 ? ' …' : ''}` : '';
        // Uyarılar
        const w = formWarnings();
        const box = $('rs-conflict-alert');
        box.innerHTML = w.map(x => `<div class="cz-warn-it${x.bad ? ' bad' : ''}">${ic('alert')}<div><b>${esc(x.title)}</b>${esc(x.text)}</div></div>`).join('');
        box.hidden = !w.length;
        if (!w.some(x => x.kind === 'series')) seriesAck = false;
        // Özet
        const name = guestIn.value.trim();
        const room = $('rs-isPreArrival').checked ? 'Ön geliş' : (roomIn.value.trim() ? 'Oda ' + roomIn.value.trim() : '');
        const when = validIso(d) ? (dayWord(d) || fmtDayShort(d)) + ($('rs-time').value ? ' ' + $('rs-time').value : '') : '';
        $('czFormSum').innerHTML = `<b>${esc(typeTr(type))}</b>${[name, room, when].filter(Boolean).map(x => ' · ' + esc(x)).join('')}${dates.length > 1 ? ' · <b>' + dates.length + ' rezervasyon</b>' : ''}`;
        renderGuestCard();
        // "Kaydet ve onayla" yalnız yeni ya da bekleyen kayıtta
        $('rs-submitConfirm').hidden = !!editResId && editResStatus !== 'Pending';
        ['rs-guest', 'rs-room', 'rs-date', 'rs-voucher'].forEach(id => { const el = $(id); if (el && el.value) el.classList.remove('bad'); });
    }
    ['rs-date', 'rs-time', 'rs-price', 'rs-deposit', 'rs-voucher', 'rs-repeatCount', 'rs-repeatInterval', 'rs-checkIn', 'rs-checkOut', 'rs-notes'].forEach(id => {
        $(id).addEventListener('input', refreshForm);
        $(id).addEventListener('change', refreshForm);
    });
    dynamicFields.addEventListener('input', refreshForm);

    const formState = () => JSON.stringify(Array.from(formOv.querySelectorAll('input, textarea, select')).map(el => el.type === 'checkbox' ? el.checked : el.value));
    function resetForm() {
        ['rs-guest', 'rs-room', 'rs-time', 'rs-price', 'rs-deposit', 'rs-voucher', 'rs-notes', 'rs-checkIn', 'rs-checkOut'].forEach(id => { const el = $(id); el.value = ''; el.classList.remove('bad'); });
        dynamicFields.innerHTML = '';
        setPreArrival(false);
        $('rs-repeatOn').checked = false;
        $('rs-repeatOpts').hidden = true;
        $('rs-repeatCount').value = 3;
        $('rs-repeatInterval').value = '1';
        $('czLeave').hidden = true;
        gList.hidden = true;
        seriesAck = false;
    }
    function showForm() {
        $('czFormOv').querySelector('.cz-mb').scrollTop = 0;
        openOv(formOv);
        refreshForm();
        formSnap = formState();
        const first = guestIn.value ? $('rs-date') : guestIn;
        setTimeout(() => { if (document.activeElement === document.body || !formOv.contains(document.activeElement)) first.focus(); }, 40);
    }
    // Yeni rezervasyon (isteğe bağlı ön doldurma: tarih, ya da "benzerini oluştur").
    function openNewRes(pre) {
        pre = (pre && typeof pre === 'object' && !(pre instanceof Event)) ? pre : {};
        editResId = null; editResBaseUpdatedAt = null; editResStatus = null;
        resetForm();
        $('czFormTitle').textContent = pre.__dup ? 'Benzer rezervasyon' : 'Yeni rezervasyon';
        $('czFormSub').textContent = pre.__dup ? 'Bilgiler kopyalandı — tarihi ve saati kontrol edin.' : 'Hizmeti seçin, misafiri ve zamanı girin.';
        $('rs-submit').textContent = 'Kaydet';
        $('rs-repeatBox').hidden = false;
        setType(pre.type || 'Restaurant');
        setCur(pre.currency || 'EUR');
        const t = todayIso();
        $('rs-date').value = validIso(pre.date) && pre.date >= t ? pre.date : (cursor >= t ? cursor : t);
        if (pre.guestName) {
            guestIn.value = pre.guestName;
            if (pre.room === 'Pre-Arrival') setPreArrival(true); else roomIn.value = pre.room || '';
        }
        if (pre.time) $('rs-time').value = pre.time;
        if (pre.totalPrice) $('rs-price').value = pre.totalPrice;
        if (pre.notes) $('rs-notes').value = pre.notes;
        DYN_KEYS.forEach(k => { const el = $('rs-' + k); if (el && pre[k]) el.value = pre[k]; });
        showForm();
    }
    function openEditRes(r) {
        editResId = r.id;
        editResBaseUpdatedAt = r.lastUpdated || r.createdAt || null;
        editResStatus = stOf(r);
        resetForm();
        $('czFormTitle').textContent = 'Rezervasyonu düzenle';
        $('czFormSub').textContent = (r.guestName || '') + ' · ' + typeTr(r.type) + ' · ' + ST_TR[stOf(r)];
        $('rs-submit').textContent = 'Değişiklikleri kaydet';
        $('rs-repeatBox').hidden = true;
        setType(r.type);
        setCur(r.currency || 'EUR');
        guestIn.value = r.guestName || '';
        const isPre = r.room === 'Pre-Arrival';
        setPreArrival(isPre);
        if (!isPre) roomIn.value = r.room || '';
        if (isPre) {
            const g = findGuest(r.guestName, r.guestId);
            if (g) { $('rs-checkIn').value = g.checkIn || ''; $('rs-checkOut').value = g.checkOut || ''; }
        }
        $('rs-date').value = validIso(r.date) ? r.date : '';
        $('rs-time').value = r.time || '';
        $('rs-price').value = r.totalPrice || '';
        $('rs-deposit').value = r.deposit || '';
        $('rs-voucher').value = r.voucherNo || '';
        $('rs-notes').value = r.notes || '';
        DYN_KEYS.forEach(k => { const el = $('rs-' + k); if (el && r[k]) el.value = r[k]; });
        showForm();
    }
    function closeForm() { $('czLeave').hidden = true; gList.hidden = true; closeOv(formOv); }
    function requestCloseForm() {
        if (formOv.hidden) return;
        if (formState() !== formSnap && $('czLeave').hidden) { $('czLeave').hidden = false; $('czLeaveStay').focus(); return; }
        if (formState() !== formSnap && !$('czLeave').hidden) return;
        closeForm();
    }
    $('resClose').addEventListener('click', requestCloseForm);
    $('czFormCancel').addEventListener('click', requestCloseForm);
    $('czLeaveStay').addEventListener('click', () => { $('czLeave').hidden = true; });
    $('czLeaveGo').addEventListener('click', closeForm);
    $('c-fab').addEventListener('click', () => openNewRes());
    $('c-fab-mobile')?.addEventListener('click', () => openNewRes());
    formOv.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitRes(false); }
    });

    function fieldError(id, msg) {
        const el = $(id);
        if (el) { el.classList.add('bad'); el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        showToast(msg, true);
    }

    let submitting = false;
    async function submitRes(confirmToo) {
        if (submitting) return; // çift tıklamada mükerrer kayıt önlenir
        const type = $('rs-type').value;
        const guestName = guestIn.value.trim();
        const isPreArrival = $('rs-isPreArrival').checked;
        const room = roomIn.value.trim();
        const date = $('rs-date').value;
        const time = $('rs-time').value;
        const checkIn = $('rs-checkIn').value, checkOut = $('rs-checkOut').value;
        const price = parseFloat($('rs-price').value) || 0;
        const deposit = parseFloat($('rs-deposit').value) || 0;
        const currency = $('rs-currency').value || 'EUR';
        const voucher = $('rs-voucher').value.trim();
        const notes = $('rs-notes').value.trim();

        if (!guestName) return fieldError('rs-guest', 'Misafir adını girin.');
        if (!isPreArrival && !room) return fieldError('rs-room', 'Oda numarasını girin ya da "Ön geliş"i işaretleyin.');
        if (!validIso(date)) return fieldError('rs-date', 'Tarih seçin.');
        if (PAID_TYPES.includes(type) && deposit > price && price > 0) return fieldError('rs-deposit', 'Kapora tutardan büyük olamaz.');
        if (confirmToo && VOUCHER_REQ.includes(type) && !voucher) return fieldError('rs-voucher', 'Onaylamak için voucher / onay no gerekli.');

        // Seri oluşturulurken TÜM tarihlerdeki çakışma bir kez onaylanır
        // (tek tarihli uyarı yalnız bilgilendiricidir).
        const dates = repeatDates();
        if (!editResId && dates.length > 1 && seriesConflicts(dates, guestName, time).length && !seriesAck) {
            seriesAck = true;
            $('rs-conflict-alert').scrollIntoView({ block: 'center', behavior: 'smooth' });
            showToast('Seride çakışan tarihler var. Yine de kaydetmek için tekrar basın.', true);
            return;
        }

        const dynamicData = {};
        dynamicFields.querySelectorAll('input').forEach(inp => { dynamicData[inp.id.replace('rs-', '')] = inp.value.trim(); });
        const data = Object.assign({
            type, guestName, room: isPreArrival ? 'Pre-Arrival' : room, date, time, notes,
            totalPrice: PAID_TYPES.includes(type) ? price : 0, deposit: PAID_TYPES.includes(type) ? deposit : 0, currency,
            voucherNo: PAID_TYPES.includes(type) ? voucher : ''
        }, dynamicData);

        submitting = true;
        const btns = [$('rs-submit'), $('rs-submitConfirm')];
        btns.forEach(b => { b.disabled = true; });
        try {
            if (editResId) {
                // Kayıp güncelleme kontrolü (transaction): bu kayıt biz düzenleme
                // ekranını açtıktan SONRA değiştirildiyse sessizce ezilmez.
                const resRef = db.collection('reservations').doc(editResId);
                const txResult = await db.runTransaction(async (tx) => {
                    const snap = await tx.get(resRef);
                    if (!snap.exists) return { error: 'not-found' };
                    const cur = snap.data();
                    const curTs = cur.lastUpdated || cur.createdAt || null;
                    const baseMs = (editResBaseUpdatedAt && editResBaseUpdatedAt.toMillis) ? editResBaseUpdatedAt.toMillis() : null;
                    const curMs = (curTs && curTs.toMillis) ? curTs.toMillis() : null;
                    if (baseMs !== null && curMs !== null && baseMs !== curMs) return { error: 'stale' };
                    const upd = Object.assign({}, data, { lastUpdated: firebase.firestore.FieldValue.serverTimestamp() });
                    if (confirmToo && (cur.status || 'Pending') === 'Pending') {
                        upd.status = 'Confirmed'; upd.confirmedBy = loggedUsername; upd.confirmedAt = firebase.firestore.FieldValue.serverTimestamp();
                    }
                    tx.update(resRef, upd);
                    return { ok: true };
                });
                if (txResult.error === 'stale') { showToast('Bu rezervasyon siz düzenlerken başka biri tarafından güncellendi. Lütfen tekrar açıp kontrol edin.', true); return; }
                if (txResult.error === 'not-found') { showToast('Rezervasyon bulunamadı (silinmiş olabilir).', true); return; }
                closeForm();
                showToast(confirmToo ? 'Kaydedildi ve onaylandı' : 'Rezervasyon güncellendi');
            } else {
                // Kimlik: misafir/konaklama ÖNCE çözülür ki rezervasyon
                // dokümanları guestId/stayId ile doğsun — guestName/room yalnızca
                // gösterim snapshot'ı olarak kalır. Paylaşımlı yardımcı başarısız
                // olursa (ağ) rezervasyon yine de eski alanlarla kaydedilir.
                data.status = confirmToo ? 'Confirmed' : 'Pending';
                if (confirmToo) { data.confirmedBy = loggedUsername; data.confirmedAt = firebase.firestore.FieldValue.serverTimestamp(); }
                data.staffInitial = loggedUsername;
                data.tenantId = TENANT_ID;
                let guest = null;
                try { guest = await GuestDirectory.syncGuestStatus(guestName, { room: isPreArrival ? '' : room, isPreArrival, checkIn, checkOut }); } catch (e) { /* eski alanlarla devam */ }
                if (guest) {
                    data.guestId = guest.id;
                    if (guest.stayId) data.stayId = guest.stayId;
                }
                const isSeries = dates.length > 1;
                const seriesId = isSeries ? ('seq' + Date.now() + Math.floor(Math.random() * 1000)) : null;
                const batch = db.batch();
                dates.forEach((d, i) => {
                    const ref = db.collection('reservations').doc();
                    batch.set(ref, Object.assign({}, data, {
                        date: d,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                        seriesId: seriesId || null,
                        seriesIndex: isSeries ? i + 1 : null,
                        seriesTotal: isSeries ? dates.length : null
                    }));
                });
                await batch.commit();
                closeForm();
                const msg = (isSeries ? dates.length + ' rezervasyon oluşturuldu' : 'Rezervasyon kaydedildi') + (confirmToo ? ' (onaylı)' : '');
                const inScope = statusFilter !== 'overdue' && (view === 'list' || (view === 'day' && cursor === date) ||
                    (view === 'week' && date >= weekStart(cursor) && date <= isoAdd(weekStart(cursor), 6)) || (view === 'month' && date.slice(0, 7) === cursor.slice(0, 7)));
                showToast(msg, false, inScope ? null : { label: 'Göster', fn: () => goDate(date, 'day') });
            }
        } catch (e) {
            if (window.Monitor) Monitor.capture(e, { where: 'concierge.submit' });
            showToast('Kaydedilemedi. Bağlantıyı kontrol edip tekrar deneyin.', true);
        } finally {
            submitting = false;
            btns.forEach(b => { b.disabled = false; });
        }
    }
    $('rs-submit').addEventListener('click', () => submitRes(false));
    $('rs-submitConfirm').addEventListener('click', () => submitRes(true));

    // Genel aramadan rezervasyon aç (?res=ID ya da kabuğun deepLink mesajı).
    // Canlı pencerede (son 90 gün + gelecek) yoksa doğrudan okunur.
    function openReservationById(id) {
        const r = reservations.find(x => x.id === id);
        if (r) { openDetail(r); return true; }
        db.collection('reservations').doc(id).get().then(d => {
            if (d.exists && (d.data().tenantId || '') === TENANT_ID) openDetail({ id: d.id, ...d.data() });
        }).catch(() => {});
        return true;
    }
    window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || !d.__mgShell || d.type !== 'deepLink' || e.source !== window.parent) return;
        const p = new URLSearchParams(d.query || '');
        if (p.get('res')) openReservationById(p.get('res'));
        else if (p.get('new')) openNewRes();   // klavye kısayolu N
    });
    let pendingResId = null;
    try { pendingResId = new URLSearchParams(location.search).get('res'); } catch (e) {}
    window.__openPendingRes = () => { if (pendingResId && reservations.length) { const id = pendingResId; pendingResId = null; openReservationById(id); } };

    // ── MİSAFİR PROGRAMI (PDF) ────────────────────────────────
    const itiOv = $('czItiOv'), itiIn = $('iti-guest-search'), itiList = $('czItiList');
    let itiGuest = null, itiItems = [], itiActive = -1, itiMatches = [];
    const activeOf = (name) => reservations.filter(r => r.guestName === name && stOf(r) !== 'Cancelled' && stOf(r) !== 'Done').sort(byTime);
    function itiCandidates(q) {
        const by = {};
        reservations.forEach(r => {
            const st = stOf(r);
            if (!r.guestName || st === 'Cancelled' || st === 'Done') return;
            const g = by[r.guestName] || (by[r.guestName] = { name: r.guestName, room: '', n: 0 });
            g.n++;
            if (r.room && r.room !== 'Pre-Arrival') g.room = r.room;
        });
        return Object.values(by).filter(g => !q || norm(g.name).includes(q) || String(g.room).startsWith(q))
            .sort((a, b) => a.name.localeCompare(b.name, 'tr')).slice(0, 8);
    }
    function renderItiList() {
        const q = norm(itiIn.value);
        itiMatches = itiCandidates(q);
        itiActive = -1;
        itiList.innerHTML = itiMatches.length
            ? itiMatches.map((g, i) => `<div class="cz-dd-it" role="option" data-i="${i}"><span class="av">${esc(initials(g.name))}</span><span><b>${esc(g.name)}</b><small>${g.room ? 'Oda ' + esc(g.room) + ' · ' : ''}${g.n} aktif rezervasyon</small></span></div>`).join('')
            : '<div class="cz-dd-empty">Aktif rezervasyonu olan misafir bulunamadı.</div>';
        itiList.hidden = false;
    }
    function selectItiGuest(name) {
        itiGuest = name;
        itiIn.value = name;
        itiList.hidden = true;
        itiItems = activeOf(name);
        const room = guestMap[name] && guestMap[name] !== 'Pre-Arrival' ? guestMap[name] : '';
        $('iti-sel-guest').textContent = name;
        const rEl = $('iti-sel-room'); rEl.textContent = room ? 'Oda ' + room : 'Ön geliş'; rEl.className = 'cz-room' + (room ? '' : ' pre');
        const t = todayIso();
        // Kimlikler satır içi değil: dizin (data-i) üzerinden eşlenir.
        $('sel-options-list').innerHTML = itiItems.length ? itiItems.map((r, i) => `<label class="cz-iti-it"><input type="checkbox" data-i="${i}"${r.date >= t ? ' checked' : ''}>
            <span class="cz-res-ic t-${typeKey(r.type)}">${svcIcon(r.type)}</span>
            <span><b>${esc(typeTr(r.type))}${r.time ? ' · ' + esc(r.time) : ''}</b><small>${esc(dayWord(r.date) || fmtDayLong(r.date))}${whatLine(r) !== typeTr(r.type) ? ' · ' + esc(whatLine(r).split(' · ').slice(1).join(' · ')) : ''}</small></span></label>`).join('')
            : '<div class="cz-dd-empty">Bu misafirin aktif rezervasyonu yok.</div>';
        $('iti-guest-info').hidden = false;
        updateItiCount();
    }
    function updateItiCount() {
        const n = $('sel-options-list').querySelectorAll('input:checked').length;
        $('iti-sel-count').textContent = n + ' / ' + itiItems.length + ' seçili';
        $('sel-confirm-btn').disabled = !n;
    }
    function openItinerary(name) {
        itiGuest = null; itiItems = [];
        itiIn.value = '';
        $('iti-guest-info').hidden = true;
        $('sel-confirm-btn').disabled = true;
        itiList.hidden = true;
        openOv(itiOv);
        if (name && activeOf(name).length) selectItiGuest(name);
        else setTimeout(() => { itiIn.focus(); renderItiList(); }, 40);
    }
    $('czMenuIti').addEventListener('click', () => openItinerary());
    $('itiClose').addEventListener('click', () => closeOv(itiOv));
    itiIn.addEventListener('input', () => { $('iti-guest-info').hidden = true; $('sel-confirm-btn').disabled = true; renderItiList(); });
    itiIn.addEventListener('focus', () => { if (!itiGuest || itiIn.value !== itiGuest) renderItiList(); });
    itiIn.addEventListener('blur', () => setTimeout(() => { itiList.hidden = true; }, 160));
    itiIn.addEventListener('keydown', (e) => {
        if (itiList.hidden || !itiMatches.length) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            itiActive = e.key === 'ArrowDown' ? Math.min(itiActive + 1, itiMatches.length - 1) : Math.max(itiActive - 1, 0);
            itiList.querySelectorAll('.cz-dd-it').forEach((el, i) => el.classList.toggle('act', i === itiActive));
        } else if (e.key === 'Enter') { e.preventDefault(); selectItiGuest(itiMatches[Math.max(0, itiActive)].name); }
        else if (e.key === 'Escape') { e.stopPropagation(); itiList.hidden = true; }
    });
    itiList.addEventListener('mousedown', (e) => {
        const it = e.target.closest('.cz-dd-it'); if (!it) return;
        e.preventDefault();
        selectItiGuest(itiMatches[+it.dataset.i].name);
    });
    $('sel-options-list').addEventListener('change', updateItiCount);
    $('sel-confirm-btn').addEventListener('click', () => {
        const picked = Array.from($('sel-options-list').querySelectorAll('input:checked')).map(cb => itiItems[+cb.dataset.i]).filter(Boolean);
        if (!picked.length) { showToast('Lütfen en az bir öğe seçin', true); return; }
        generatePDF(itiGuest, guestMap[itiGuest], picked);
        closeOv(itiOv);
    });

    // ── RAPORLAR ──────────────────────────────────────────────
    const rptOv = $('czRptOv');
    const rptTypeSelect = $('reportTypeSelect');
    function viewRange() {
        if (view === 'week') { const s = weekStart(cursor); return [s, isoAdd(s, 6)]; }
        if (view === 'month') { const m = cursor.slice(0, 7); const e = isoToDate(m + '-01'); e.setMonth(e.getMonth() + 1); e.setDate(0); return [m + '-01', dateToIso(e)]; }
        if (view === 'list') return [todayIso(), isoAdd(todayIso(), 30)];
        return [cursor, cursor];
    }
    function updateRptUI() {
        const type = rptTypeSelect.value;
        $('rpt-specificDateContainer').hidden = type !== 'summary';
        $('rpt-rangeGroup').hidden = !['dateRange', 'revenue', 'activity'].includes(type);
        $('rpt-catContainer').hidden = type !== 'activity';
        $('rpt-guestContainer').hidden = type !== 'guest';
        const excelOnly = type === 'currentView' || type === 'fullArchive';
        $('czRptPdf').hidden = excelOnly;
        const hint = { currentView: 'Ekrandaki süzgeçlere uyan ' + filteredReservations.length + ' kayıt.', fullArchive: 'Tüm tarihler (eski kayıtlar dahil) tek dosyada.' }[type] || '';
        rptOv.querySelector('.cz-mf-sum').textContent = hint;
    }
    function populateGuestDatalist() {
        const uniqueNames = [...new Set(reservations.map(r => r.guestName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
        $('guestNamesList').innerHTML = uniqueNames.map(name => `<option value="${esc(name)}">`).join('');
    }
    $('czMenuReport').addEventListener('click', () => {
        const [f, t] = viewRange();
        $('rpt-specificDate').value = view === 'day' ? cursor : todayIso();
        $('rpt-dateFrom').value = f; $('rpt-dateTo').value = t;
        if (typeFilter) $('rpt-categorySelect').value = typeFilter;
        populateGuestDatalist();
        updateRptUI();
        openOv(rptOv);
    });
    $('reportClose').addEventListener('click', () => closeOv(rptOv));
    rptTypeSelect.addEventListener('change', updateRptUI);
    $('czRptExcel').addEventListener('click', () => generateReport(rptTypeSelect.value, 'excel'));
    $('czRptPdf').addEventListener('click', () => generateReport(rptTypeSelect.value, 'pdf'));
    window.generateReportFromUI = function (format) { generateReport(rptTypeSelect.value, format); };

    function getRptDates() {
        return {
            from: $('rpt-dateFrom')?.value || '',
            to: $('rpt-dateTo')?.value || '',
            specific: $('rpt-specificDate')?.value || todayIso(),
            cat: $('rpt-categorySelect')?.value || 'All',
            guest: $('rpt-guestSearch')?.value || ''
        };
    }
    // Canlı pencere son 90 günü tutar; daha eskisini kapsayan raporlar için
    // tek seferlik tam okuma yapılır (önceden "tüm arşiv" yalnız 90 günü veriyordu).
    async function reportData(from, all) {
        if (!all && from && from >= resWindowStart) return reservations;
        try {
            const snap = await db.collection('reservations').where('tenantId', '==', TENANT_ID).get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byTime);
        } catch (e) { showToast('Eski kayıtlar okunamadı; yalnız son 90 gün raporlanıyor.', true); return reservations; }
    }

    function rowBase(r) {
        let details = '';
        if (r.type === 'Restaurant' || r.type === 'Beach') details = r.resName || '';
        else if (r.type === 'Transfer') details = `${r.from || ''} -> ${r.to || ''}${r.vehicle ? ' (' + r.vehicle + ')' : ''}`;
        else if (r.type === 'Boat' || r.type === 'Tour') details = `${r.vessel || ''}${r.provider ? ' (' + r.provider + ')' : ''}`;
        // Other + Flower/Cake — otherType/resName ÖNCE notes'a düşmeden kontrol edilir.
        else details = r.otherType || r.resName || r.notes || '';
        return {
            Tarih: r.date,
            Saat: r.time || '',
            Oda: r.room === 'Pre-Arrival' ? 'Ön geliş' : (r.room || ''),
            Misafir: r.guestName,
            Hizmet: typeTr(r.type),
            Ayrıntı: details,
            Kişi: r.pax || '',
            Tutar: Number(r.totalPrice) || 0,
            Kapora: Number(r.deposit) || 0,
            'Para birimi': r.currency || 'EUR',
            Voucher: r.voucherNo || '',
            Durum: ST_TR[stOf(r)],
            Oluşturan: r.staffInitial || ''
        };
    }
    const pdfRow = (r, withGuest = true) => {
        const rb = rowBase(r); const s = curSym(rb['Para birimi']);
        const row = [fmtDate(rb.Tarih), rb.Saat, rb.Oda];
        if (withGuest) row.push(rb.Misafir);
        return row.concat([rb.Hizmet, rb.Ayrıntı, rb.Kişi, s + rb.Tutar, s + rb.Kapora, rb.Durum]);
    };
    const PDF_HEAD = ['Tarih', 'Saat', 'Oda', 'Misafir', 'Hizmet', 'Ayrıntı', 'Kişi', 'Tutar', 'Kapora', 'Durum'];

    function autoSizeSheet(ws, rows) {
        if (!rows || rows.length === 0) return;
        const keys = Object.keys(rows[0]);
        // Binlerce satırda tüm hücreleri taramak sekmeyi donduruyordu;
        // genişlik için ilk 500 satırlık örneklem yeterli.
        const sample = rows.length > 500 ? rows.slice(0, 500) : rows;
        ws['!cols'] = keys.map(k => {
            let maxLen = k.length;
            sample.forEach(r => { const val = r[k] ? String(r[k]) : ''; if (val.length > maxLen) maxLen = val.length; });
            return { wch: Math.min(60, maxLen + 2) };
        });
        if (ws['!ref']) {
            const range = XLSX.utils.decode_range(ws['!ref']);
            ws['!autofilter'] = { ref: XLSX.utils.encode_range(range) };
        }
    }

    // Dışa-aktarma kütüphaneleri TEMBEL yüklenir (bkz. js/core/lazy-load.js).
    const CG_PDF_LIBS = [
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js'
    ];
    const CG_XLSX_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    const CG_HTML2PDF_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';

    const safeName = (s) => String(s || '').replace(/[^\w\-ğüşöçıİĞÜŞÖÇ]+/g, '_').slice(0, 60);
    async function exportExcel(rows, filename, sheetName = 'Rapor', extraSheets) {
        if (!rows || rows.length === 0) return showToast('Bu rapor için veri yok.', true);
        try { await loadScriptOnce(CG_XLSX_LIB); } catch (e) { /* aşağıda denetlenir */ }
        if (typeof XLSX === 'undefined') return showToast('Excel kütüphanesi yüklenemedi.', true);
        const wb = XLSX.utils.book_new();
        (extraSheets || []).forEach(([name, data]) => {
            const ws0 = XLSX.utils.json_to_sheet(data); autoSizeSheet(ws0, data); XLSX.utils.book_append_sheet(wb, ws0, name);
        });
        const ws = XLSX.utils.json_to_sheet(rows);
        autoSizeSheet(ws, rows);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        XLSX.writeFile(wb, `${safeName(filename)}_${todayIso()}.xlsx`);
        showToast('Excel raporu indirildi.');
    }

    function fixTurkishChars(str) {
        if (typeof str !== 'string') return str;
        return str
            .replace(/ı/g, 'i').replace(/İ/g, 'I')
            .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
            .replace(/ü/g, 'u').replace(/Ü/g, 'U')
            .replace(/ş/g, 's').replace(/Ş/g, 'S')
            .replace(/ö/g, 'o').replace(/Ö/g, 'O')
            .replace(/ç/g, 'c').replace(/Ç/g, 'C')
            .replace(/₺/g, 'TL ').replace(/€/g, 'EUR ');
    }

    async function exportPDF(title, headers, rows, filename, subtitle = '') {
        if (!rows || rows.length === 0) return showToast('Bu rapor için veri yok.', true);
        try { await loadScriptsOnce(CG_PDF_LIBS); } catch (e) { /* aşağıda denetlenir */ }
        if (!window.jspdf || !window.jspdf.jsPDF) return showToast('PDF kütüphanesi yüklenemedi.', true);
        await ensureHotelName();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: rows[0].length > 6 ? 'landscape' : 'portrait' });
        // Yerleşik yazı tipinde Türkçe karakter yok — sadeleştirilir.
        const fixedTitle = fixTurkishChars(title);
        const fixedSubtitle = fixTurkishChars(subtitle || ((HOTEL_NAME ? HOTEL_NAME + ' · ' : '') + 'Olusturulma: ' + fmtDate(todayIso())));
        const fixedHeaders = headers.map(h => fixTurkishChars(h));
        const fixedRows = rows.map(row => row.map(cell => fixTurkishChars(typeof cell === 'number' ? String(cell) : cell)));
        doc.setFillColor(79, 70, 229);
        doc.rect(0, 0, doc.internal.pageSize.getWidth(), 28, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text(fixedTitle, 14, 12);
        doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        doc.text(fixedSubtitle, 14, 20);
        doc.setTextColor(0, 0, 0);
        doc.autoTable({
            head: [fixedHeaders],
            body: fixedRows,
            startY: 32,
            theme: 'grid',
            headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', fontSize: 9 },
            bodyStyles: { fontSize: 8.5 },
            alternateRowStyles: { fillColor: [245, 247, 255] },
            margin: { left: 14, right: 14 }
        });
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8); doc.setTextColor(150);
            doc.text(`Sayfa ${i} / ${pageCount} — Concierge`, 14, doc.internal.pageSize.getHeight() - 8);
        }
        doc.save(`${safeName(filename)}_${todayIso()}.pdf`);
        showToast('PDF raporu indirildi.');
    }

    window.generateReport = async function (type, format) {
        const { from, to, specific, cat, guest } = getRptDates();
        const inRange = (r) => (!from || r.date >= from) && (!to || r.date <= to);
        const rangeTxt = (from || to) ? `${from ? fmtDate(from) : '…'} – ${to ? fmtDate(to) : '…'}` : 'Tüm tarihler';
        if ((type === 'dateRange' || type === 'revenue' || type === 'activity') && from && to && from > to) return showToast('Başlangıç tarihi bitişten sonra olamaz.', true);

        if (type === 'summary') {
            const data = (await reportData(specific)).filter(r => r.date === specific && stOf(r) !== 'Cancelled').sort(byTime);
            // Para birimi bazında — o günün EUR ve TRY tutarları tek toplamda karışmaz.
            const byCur = {};
            data.forEach(r => { const c = r.currency || 'EUR'; const g = byCur[c] || (byCur[c] = { rev: 0, dep: 0 }); g.rev += Number(r.totalPrice) || 0; g.dep += Number(r.deposit) || 0; });
            const curs = Object.keys(byCur);
            const sumLine = key => curs.length ? curs.map(c => curSym(c) + byCur[c][key]).join(' · ') : curSym('EUR') + '0';
            const st = {}; data.forEach(r => { st[stOf(r)] = (st[stOf(r)] || 0) + 1; });
            const summaryRows = [
                { Gösterge: 'Rezervasyon', Değer: data.length },
                { Gösterge: 'Bekliyor', Değer: st.Pending || 0 },
                { Gösterge: 'Onaylı', Değer: st.Confirmed || 0 },
                { Gösterge: 'Tamamlandı', Değer: st.Done || 0 },
                { Gösterge: 'Toplam tutar', Değer: sumLine('rev') },
                { Gösterge: 'Alınan kapora', Değer: sumLine('dep') }
            ];
            if (format === 'excel') {
                // XLSX tembel yüklenir — önceden bu dal kütüphaneyi yüklemeden
                // XLSX'e erişip "XLSX is not defined" ile sessizce düşüyordu.
                if (!data.length) return showToast('Bu gün için rezervasyon yok.', true);
                return exportExcel(data.map(rowBase), `Gunluk_Ozet_${specific}`, 'Ayrıntı', [['Özet', summaryRows]]);
            }
            return exportPDF(`Gunluk ozet: ${fmtDate(specific)}`, PDF_HEAD, data.map(r => pdfRow(r)), `Gunluk_Ozet_${specific}`);
        }
        if (type === 'activity' || type === 'dateRange') {
            let data = (await reportData(from)).filter(inRange);
            if (type === 'activity') {
                data = data.filter(r => stOf(r) !== 'Cancelled');
                if (cat !== 'All') data = data.filter(r => typeKey(r.type) === cat);
            }
            data.sort(byTime);
            const label = type === 'activity' ? ('Hizmet: ' + (cat === 'All' ? 'Tümü' : typeTr(cat))) : 'Tarih aralığı';
            const file = type === 'activity' ? `Hizmet_${cat}` : 'Tarih_Araligi';
            if (format === 'excel') return exportExcel(data.map(rowBase), file);
            return exportPDF(label, PDF_HEAD, data.map(r => pdfRow(r)), file, rangeTxt);
        }
        if (type === 'guest') {
            if (!guest.trim()) return showToast('Lütfen bir misafir seçin.', true);
            const q = norm(guest);
            const data = (await reportData('', true)).filter(r => r.guestName && norm(r.guestName).includes(q) && stOf(r) !== 'Cancelled').sort(byTime);
            if (format === 'excel') return exportExcel(data.map(rowBase), `Misafir_${guest}`);
            return exportPDF(`Misafir: ${guest}`, PDF_HEAD.filter(h => h !== 'Misafir'), data.map(r => pdfRow(r, false)), `Misafir_${guest}`);
        }
        if (type === 'revenue') {
            const data = (await reportData(from)).filter(r => stOf(r) !== 'Cancelled' && inRange(r));
            // Tarih + PARA BİRİMİ bazında — aynı günün EUR ve TRY tutarları karışmaz.
            const m = {};
            data.forEach(r => {
                const cur = r.currency || 'EUR';
                const key = r.date + '|' + cur;
                if (!m[key]) m[key] = { Tarih: r.date, 'Para birimi': cur, Rezervasyon: 0, Tutar: 0, Kapora: 0, Kalan: 0 };
                m[key].Rezervasyon++;
                m[key].Tutar += Number(r.totalPrice) || 0;
                m[key].Kapora += Number(r.deposit) || 0;
                m[key].Kalan += balanceOf(r);
            });
            const rows = Object.values(m).filter(x => x.Tutar || x.Kapora).sort((a, b) => a.Tarih.localeCompare(b.Tarih) || a['Para birimi'].localeCompare(b['Para birimi']));
            if (format === 'excel') return exportExcel(rows, 'Gelir_Kapora');
            return exportPDF('Gelir ve kapora', ['Tarih', 'Para birimi', 'Adet', 'Tutar', 'Kapora', 'Kalan'],
                rows.map(r => [fmtDate(r.Tarih), r['Para birimi'], r.Rezervasyon, curSym(r['Para birimi']) + r.Tutar, curSym(r['Para birimi']) + r.Kapora, curSym(r['Para birimi']) + r.Kalan]), 'Gelir_Kapora', rangeTxt);
        }
        if (type === 'currentView') return exportExcel(filteredReservations.map(rowBase), 'Su_Anki_Gorunum');
        if (type === 'fullArchive') return exportExcel((await reportData('', true)).map(rowBase), 'Tum_Arsiv');
    };

    // ── PDF: MİSAFİR PROGRAMI ─────────────────────────────────
    const generatePDF = async (guest, room, itemsOverride = null) => {
        let guestItems = itemsOverride || reservations.filter(r => r.guestName === guest && r.status !== 'Cancelled');
        if (guestItems.length === 0) { showToast('Aktif rezervasyon bulunamadı', true); return; }
        await ensureHotelName();
        guestItems = guestItems.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

        const pdfEl = $('itinerary-pdf');
        pdfEl.style.display = 'block';

        let html = `
            <style>
                .pdf-container { padding: 30px; font-family: 'Helvetica', 'Arial', sans-serif; color: #2c3e50; line-height: 1.4; }
                .pdf-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #34495e; padding-bottom: 15px; margin-bottom: 20px; }
                .pdf-title h1 { margin: 0; font-size: 24px; text-transform: uppercase; letter-spacing: 1px; color: #34495e; }
                .pdf-guest-info { margin-bottom: 20px; background: #fafafa; padding: 15px; border-radius: 6px; border-left: 3px solid #34495e; }
                .pdf-guest-info p { margin: 0; font-size: 12px; color: #7f8c8d; }
                .pdf-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                .pdf-table th { text-align: left; padding: 10px; background: #34495e; color: #fff; font-size: 11px; text-transform: uppercase; }
                .pdf-table td { padding: 10px; border-bottom: 1px solid #ecf0f1; vertical-align: top; font-size: 13px; }
                .pdf-date-cell { white-space: nowrap; font-weight: bold; }
                .pdf-service-type { font-weight: 800; color: #2980b9; display: block; }
                .pdf-item-details { color: #34495e; }
            </style>
            <div class="pdf-container">
                <div class="pdf-header">
                    <img src="logo.png" style="height: 40px; width: auto;" alt="Logo">
                    <div class="pdf-title"><h1>Guest Itinerary</h1></div>
                </div>
                <div class="pdf-guest-info">
                    <p>Dear <strong>${esc(guest)}</strong>${room && room !== 'Pre-Arrival' ? ' · Room ' + esc(room) : ''},</p>
                    <p style="margin-top: 5px;">We hope you are enjoying your stay. Please find below the details of your arrangements. We remain at your full disposal for any further assistance.</p>
                </div>
                <table class="pdf-table">
                    <thead><tr><th style="width: 20%;">Date & Time</th><th style="width: 25%;">Service</th><th style="width: 55%;">Details & Arrangements</th></tr></thead>
                    <tbody>`;
        guestItems.forEach(item => {
            let details = '';
            if (item.type === 'Restaurant' || item.type === 'Beach') details = `<strong>${esc(item.resName || '')}</strong>${item.pax ? '<br>Guests: ' + esc(item.pax) : ''}`;
            else if (item.type === 'Transfer') details = `<strong>Route:</strong> ${esc(item.from || '')} ➔ ${esc(item.to || '')}<br><strong>Vehicle:</strong> ${esc(item.vehicle || 'Standard')}`;
            else if (item.type === 'Boat' || item.type === 'Tour') details = `<strong>Service:</strong> ${esc(item.vessel || 'Private Tour')}<br><strong>Provider:</strong> ${esc(item.provider || 'Hotel Direct')}`;
            else details = `<strong>Request:</strong> ${esc(item.otherType || item.resName || item.type)}`;
            html += `<tr><td class="pdf-date-cell">${fmtDate(item.date)}<br><span style="font-weight: normal; color: #7f8c8d;">${esc(item.time || '—')}</span></td>
                <td><span class="pdf-service-type">${esc(String(item.type || '').toUpperCase())}</span></td><td class="pdf-item-details">${details}</td></tr>`;
        });
        html += `</tbody></table>
                <div style="margin-top: 40px; padding: 20px; border: 1px solid #ecf0f1; border-radius: 8px;">
                    <h4 style="margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase;">A Note from Management</h4>
                    <p style="margin: 0; font-size: 12px; font-style: italic; color: #7f8c8d;">"We hope you enjoy your stay with us. If there are any changes to this schedule, please do not hesitate to contact our Concierge team at any time."</p>
                </div>
                ${HOTEL_NAME ? `<p style="margin-top: 24px; text-align: center; font-size: 11px; color: #95a5a6;">${esc(HOTEL_NAME)}</p>` : ''}
            </div>`;
        pdfEl.innerHTML = html;
        const opt = {
            margin: 0,
            filename: `Itinerary_${String(guest).replace(/\s+/g, '_')}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 3, useCORS: true, letterRendering: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        try { await loadScriptOnce(CG_HTML2PDF_LIB); } catch (e) { /* aşağıda denetlenir */ }
        if (typeof html2pdf !== 'function') { pdfEl.style.display = 'none'; return showToast('PDF kütüphanesi yüklenemedi.', true); }
        html2pdf().set(opt).from(pdfEl).save().then(() => { pdfEl.style.display = 'none'; showToast('Program PDF olarak indirildi.'); });
    };

    // ── PDF: ONAY MEKTUBU ─────────────────────────────────────
    const generateConfirmationPDF = async (r) => {
        await ensureHotelName(); // tenant'ın kendi otel adı (marka sızıntısını önler)
        const pdfEl = $('itinerary-pdf');
        pdfEl.style.display = 'block';
        let details = '';
        if (r.type === 'Restaurant' || r.type === 'Beach') details = `Venue: <strong>${esc(r.resName || '')}</strong>${r.pax ? '<br>Guests: ' + esc(r.pax) + ' Pax' : ''}`;
        else if (r.type === 'Transfer') details = `Route: <strong>${esc(r.from || '')} ➔ ${esc(r.to || '')}</strong><br>Vehicle/Flight: ${esc(r.vehicle || 'Standard')}<br>Pax: ${esc(r.pax || '—')}`;
        else if (r.type === 'Boat' || r.type === 'Tour') details = `Service: <strong>${esc(r.vessel || r.type)}</strong><br>Provider: ${esc(r.provider || 'Hotel Direct')}<br>Pax: ${esc(r.pax || '—')}`;
        else details = `Arrangement: <strong>${esc(r.otherType || r.resName || r.type)}</strong>`;
        const ST_EN = { Pending: 'Pending', Confirmed: 'Confirmed', Done: 'Completed', Cancelled: 'Cancelled' };
        pdfEl.innerHTML = `
            <style>
                .pdf-container { padding: 40px; font-family: 'Helvetica', 'Arial', sans-serif; color: #2c3e50; line-height: 1.6; }
                .pdf-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #34495e; padding-bottom: 20px; margin-bottom: 30px; }
                .pdf-title h1 { margin: 0; font-size: 28px; text-transform: uppercase; letter-spacing: 2px; color: #2c3e50; }
                .conf-box { background: #f8f9fa; border: 1px solid #dee2e6; padding: 25px; border-radius: 8px; margin: 25px 0; }
                .conf-row { display: flex; border-bottom: 1px solid #eee; padding: 10px 0; }
                .conf-label { width: 150px; font-weight: bold; color: #7f8c8d; text-transform: uppercase; font-size: 11px; }
                .conf-value { flex: 1; color: #2c3e50; font-size: 14px; }
                .pdf-footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid #eee; font-size: 11px; color: #95a5a6; text-align: center; }
            </style>
            <div class="pdf-container">
                <div class="pdf-header">
                    <img src="logo.png" style="height: 50px; width: auto;" alt="Logo">
                    <div class="pdf-title">
                        <h1>Confirmation</h1>
                        <p style="margin:5px 0 0 0; font-size:12px; color:#7f8c8d; text-align:right;">Ref: #${esc(String(r.id).substring(0, 8).toUpperCase())}</p>
                    </div>
                </div>
                <div class="pdf-content">
                    <p>Dear <strong>${esc(r.guestName)}</strong>,</p>
                    <p>We are pleased to confirm your upcoming arrangement as follows:</p>
                    <div class="conf-box">
                        <div class="conf-row"><div class="conf-label">Service Type</div><div class="conf-value" style="font-weight:bold; color:#2980b9;">${esc(String(r.type || '').toUpperCase())}</div></div>
                        <div class="conf-row"><div class="conf-label">Date</div><div class="conf-value">${fmtDate(r.date)}</div></div>
                        <div class="conf-row"><div class="conf-label">Time</div><div class="conf-value">${esc(r.time || '—')}</div></div>
                        <div class="conf-row"><div class="conf-label">Details</div><div class="conf-value">${details}</div></div>
                        <div class="conf-row"><div class="conf-label">Status</div><div class="conf-value"><strong>${esc(ST_EN[stOf(r)])}</strong></div></div>
                        ${r.voucherNo ? `<div class="conf-row"><div class="conf-label">Confirmation No</div><div class="conf-value">${esc(r.voucherNo)}</div></div>` : ''}
                    </div>
                    <p>Should you require any further assistance or wish to make changes, please contact the Concierge desk.</p>
                    <p style="margin-top:30px;">Warm regards,<br><strong>Concierge Team</strong></p>
                </div>
                <div class="pdf-footer">${esc(HOTEL_NAME)}</div>
            </div>`;
        const opt = {
            margin: 0,
            filename: `Confirmation_${String(r.guestName || '').replace(/\s+/g, '_')}_${r.type}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 3, useCORS: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        try { await loadScriptOnce(CG_HTML2PDF_LIB); } catch (e) { /* aşağıda denetlenir */ }
        if (typeof html2pdf !== 'function') { pdfEl.style.display = 'none'; return showToast('PDF kütüphanesi yüklenemedi.', true); }
        html2pdf().set(opt).from(pdfEl).save().then(() => { pdfEl.style.display = 'none'; });
    };

    // ── BAŞLANGIÇ ─────────────────────────────────────────────
    renderToolbar();
    board.innerHTML = '<div class="cz-empty"><span class="cz-empty-ic">' + ic('hourglass') + '</span><b>Rezervasyonlar yükleniyor…</b></div>';
    // Göreli zamanlar ("40 dk sonra"), "şimdi" çizgisi ve gecikme durumu
    // dakikada bir tazelenir (görünürken; açık pencere/yazma sırasında değil).
    let lastDay = todayIso();
    setInterval(() => {
        if (document.hidden || anyOpen() || !reservations.length) return;
        const t = todayIso();
        if (t !== lastDay) { if (cursor === lastDay) cursor = t; lastDay = t; }
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
        render();
    }, 60000);
});
