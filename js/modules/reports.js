/* Hotizy — Raporlar (uygulama geneli rapor merkezi).
 *
 * Standalone page (reports.html), app-shell içinde "Raporlar" sekmesi.
 * Çok kaynaklı (Misafir Kayıtları, Concierge Rezervasyonları, Misafir
 * Siparişleri, Misafirler) jenerik rapor motoru: kaynak seç → çok boyutlu
 * filtre + gruplama → canlı önizleme + Excel (profesyonel tablolu .xls) +
 * Yazdır.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;

    // ── Helpers ────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const $ = id => document.getElementById(id);
    function toast(msg, isErr) {
        const t = $('toast'); if (!t) return;
        t.textContent = msg; t.className = 'rep-toast show' + (isErr ? ' err' : '');
        setTimeout(() => { t.className = 'rep-toast'; }, 2600);
    }
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function todayStr() { return ymd(new Date()); }
    // Haftalık/Aylık/Yıllık gruplama anahtarları — önceden yalnızca güne göre
    // gruplama vardı (bkz. groupFacet). isoWeekKey: ISO hafta (Pazartesi
    // başlangıç, yıl sınırındaki hafta 1/53 kenar durumunu doğru çözer).
    function isoWeekKey(dateStr) {
        const d = new Date(dateStr + 'T12:00:00');
        const day = (d.getDay() + 6) % 7; // Pzt=0..Paz=6
        d.setDate(d.getDate() - day + 3); // bu ISO haftanın Perşembesi
        const firstThu = new Date(d.getFullYear(), 0, 4);
        const wk = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
        return d.getFullYear() + '-W' + pad(wk);
    }
    function monthKey(dateStr) { return dateStr.slice(0, 7); }
    function yearKey(dateStr) { return dateStr.slice(0, 4); }
    function tsToDate(v) {
        if (!v) return null;
        if (v.toDate) { try { return v.toDate(); } catch (e) { return null; } }
        if (v instanceof Date) return v;
        if (typeof v === 'number') return new Date(v);
        if (v.seconds) return new Date(v.seconds * 1000);
        return null;
    }
    // Normalize any date-ish value to 'YYYY-MM-DD' ('' if none).
    function normDate(v) {
        if (!v) return '';
        if (typeof v === 'number' || v.toDate || v.seconds) { const d = tsToDate(v); return d ? ymd(d) : ''; }
        const s = String(v);
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
        const m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/);
        if (m) return m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]);
        const d = new Date(s); return isNaN(d) ? '' : ymd(d);
    }
    function fmtDateTR(ymdStr) {
        if (!ymdStr) return '—';
        const p = String(ymdStr).slice(0, 10).split('-');
        if (p.length === 3) return p[2] + '.' + p[1] + '.' + p[0];
        return ymdStr;
    }
    function fmtDuration(ms) {
        if (ms == null || isNaN(ms) || ms < 0) return '—';
        const m = Math.floor(ms / 60000);
        if (m < 60) return m + ' dk';
        const h = Math.floor(m / 60);
        if (h < 24) return h + ' sa ' + (m % 60) + ' dk';
        const d = Math.floor(h / 24);
        return d + ' g ' + (h % 24) + ' sa';
    }
    function money(v) { const n = Number(v); return (isNaN(n) ? 0 : n).toLocaleString('tr-TR'); }
    // Ortalama yıldıza göre .rep-stat tint kodu — css/modules/reports.css'teki
    // GERÇEK renklerle doğrulandı: 's'=yeşil #16a34a (iyi), 'c'=amber #d97706
    // (orta/dikkat), 'o'=kırmızı #dc2626 (kötü). 'w' MAVİ #2563eb'dir ve
    // "Bekliyor" gibi nötr durumlar için kullanılır — uyarı anlamına GELMEZ,
    // bu yüzden düşük puan vurgusunda kasıtlı olarak kullanılmadı.
    function ratingTint(avg) {
        if (!avg) return 'i';
        if (avg >= 4) return 's';
        if (avg >= 3) return 'c';
        return 'o';
    }

    // ── Domain-specific label maps ─────────────────────────────
    const GL_STATUS = { Following: 'Bekliyor', InProgress: 'İşlemde', Solved: 'Tamamlandı' };
    const glStatus = s => GL_STATUS[s] || 'Bekliyor';
    const glType = r => ((r.type || 'complaint') === 'request' ? 'Talep' : 'Şikayet');
    const OVERDUE_MIN = 15;
    function glOverdue(r) {
        if ((r.status || 'Following') === 'Solved') return false;
        const c = tsToDate(r.createdAt); if (!c) return false;
        return (Date.now() - c.getTime()) / 60000 > OVERDUE_MIN;
    }
    function glDuration(r) {
        const created = tsToDate(r.createdAt), done = tsToDate(r.completedAt);
        if ((r.status || '') === 'Solved' && created && done) return done - created;
        if (created) return Date.now() - created;
        return null;
    }
    // İşi kimin yaptığı: üstlenen > tamamlayan > atanan; eski (üstlenen bilgisi
    // olmayan) tamamlanmış kayıtlarda kaydı giren; açık ve sahipsizse "Üstlenilmedi".
    function glWorker(r) {
        if (r.acknowledgedBy) return r.acknowledgedBy;
        if (r.completedBy) return r.completedBy;
        if (r.assignedToName) return r.assignedToName;
        if ((r.status || 'Following') === 'Solved') return r.staffInitial || '—';
        return 'Üstlenilmedi';
    }
    const RES_TYPE = { Restaurant: 'Restoran', Beach: 'Plaj', Transfer: 'Transfer', Flower: 'Çiçek', Cake: 'Pasta', Boat: 'Tekne', Tour: 'Tur', Other: 'Diğer' };
    const resType = r => RES_TYPE[r.type] || (r.type || 'Diğer');
    // Concierge rezervasyonları kendi `currency` alanını taşır (Restoran/QR'ın
    // guestConfig/restConfig currency'sinden BAĞIMSIZ — çoğunlukla yurt dışı
    // tur/transfer için EUR). Eski kayıtlarda alan yoktur → geriye dönük
    // uyum için EUR varsayılır (eskiden hep '€' gösteriliyordu).
    const RES_CUR_SYM = { EUR: '€', TRY: '₺', USD: '$' };
    const resCur = r => r.currency || 'EUR';
    const resCurSym = r => RES_CUR_SYM[resCur(r)] || '€';
    const RES_STATUS = { Pending: 'Bekliyor', Confirmed: 'Onaylı', Cancelled: 'İptal' };
    const resStatus = r => RES_STATUS[r.status] || 'Bekliyor';
    // Where / details, per service type (dynamic fields stored on the reservation).
    function resDetail(r) {
        switch (r.type) {
            case 'Restaurant':
            case 'Beach': return r.resName || '';
            case 'Transfer': return [r.from, r.to].filter(Boolean).join(' → ') + (r.vehicle ? ' (' + r.vehicle + ')' : '');
            case 'Boat':
            case 'Tour': return [r.vessel, r.provider].filter(Boolean).join(' · ');
            case 'Other': return r.otherType || '';
            default: return '';
        }
    }
    const ORD_STATUS = { pending: 'Bekliyor', completed: 'Tamamlandı', cancelled: 'İptal', accepted: 'Onaylandı' };
    const ordStatus = r => ORD_STATUS[r.status] || (r.status || 'Bekliyor');
    const DIR_STATUS = { in_house: 'Otelde', pre_arrival: 'Ön Geliş', checked_out: 'Çıkış Yaptı' };
    const dirStatus = r => DIR_STATUS[r.status] || (r.status || '—');
    function ordItems(r) {
        if (!Array.isArray(r.items)) return '';
        return r.items.map(it => (it.name || '?') + (it.qty > 1 ? ' ×' + it.qty : '')).join(', ');
    }

    // ── Facet helpers ──────────────────────────────────────────
    // kind: 'chips' (multi) | 'text'. valueOf(r) → display value used to match/group.
    // fixed: optional ordered [value,...] for chip lists that should always show.
    // extra(): optional extra chip values (e.g. config departments/topics).
    // match(r,set): optional custom matcher (e.g. overdue).
    function facet(o) { return o; }

    // ── Domains ────────────────────────────────────────────────
    const DOMAINS = {
        guestLogs: {
            label: 'Misafir Kayıtları (Talep / Şikayet)',
            collection: 'guestLogs', order: ['createdAt', 'desc'], tsBound: 'createdAt',
            dateOf: r => r.date || '',
            facets: [
                facet({ key: 'type', label: 'Kayıt Türü', kind: 'chips', fixed: ['Şikayet', 'Talep'], valueOf: glType }),
                // QR köprüsüyle gelen kayıtlar (source: guest-order) ile personel
                // girişleri ayrıştırılabilsin — kanal bazlı performans raporu.
                facet({
                    key: 'source', label: 'Kaynak', kind: 'chips', fixed: ['QR Misafir', 'Personel'],
                    valueOf: r => (r.source === 'guest-order' || r.source === 'qr') ? 'QR Misafir' : 'Personel'
                }),
                facet({
                    // canonicalDept: eski F&B kayıtları ("Food & Beverage") kanonik
                    // "Yiyecek & İçecek" ile aynı chip'te toplanır — iki ayrı
                    // departman gibi görünmez (bkz. firebase-config.js).
                    key: 'dept', label: 'Departman', kind: 'chips', valueOf: r => canonicalDept(r.department) || '—',
                    extra: () => (window.IssueConfig ? IssueConfig.departments().map(d => d.name) : [])
                }),
                facet({
                    key: 'topic', label: 'Konu (şikayet)', kind: 'chips',
                    valueOf: r => (r.type || 'complaint') === 'complaint' ? (r.topic || 'Genel') : '—',
                    extra: () => (window.IssueConfig ? IssueConfig.topics() : [])
                }),
                facet({
                    key: 'status', label: 'Durum', kind: 'chips', fixed: ['Bekliyor', 'İşlemde', 'Tamamlandı', 'Geciken'],
                    valueOf: r => glStatus(r.status),
                    match: (r, set) => {
                        if (!set.size) return true;
                        if (set.has(glStatus(r.status))) return true;
                        if (set.has('Geciken') && glOverdue(r)) return true;
                        return false;
                    }
                }),
                // İşi kimin YAPTIĞI: üstlenen (acknowledgedBy) esas alınır;
                // üstlenilmeden tamamlanmış kayıtta tamamlayan, atanmış ama
                // henüz üstlenilmemişse atanan görünür. Eski (üstlenen bilgisi
                // olmayan) tamamlanmış kayıtlar kaydı girene düşer.
                facet({ key: 'staff', label: 'Personel (üstlenen)', kind: 'chips', valueOf: glWorker }),
                facet({ key: 'room', label: 'Oda', kind: 'text', valueOf: r => r.room || '' }),
                facet({ key: 'guest', label: 'Misafir', kind: 'text', valueOf: r => r.guestName || '' })
            ],
            columns: [
                { label: 'Tarih', get: r => fmtDateTR(r.date) },
                { label: 'Oda', get: r => r.room || '—' },
                { label: 'Misafir', get: r => r.guestName || '—' },
                { label: 'Tür', get: glType },
                { label: 'Departman', get: r => canonicalDept(r.department) || '—' },
                { label: 'Konu', get: r => (r.type || 'complaint') === 'complaint' ? (r.topic || 'Genel') : '—' },
                { label: 'Açıklama', get: r => r.complaint || '', wide: true },
                { label: 'Çözüm', get: r => (r.type || 'complaint') === 'request' ? '' : (r.solution || ''), wide: true },
                { label: 'Kaydı Giren', get: r => r.staffInitial || '—' },
                { label: 'Üstlenen', get: glWorker },
                { label: 'Durum', get: r => glStatus(r.status) + (glOverdue(r) ? ' ⚠' : '') },
                { label: 'Süre', get: r => fmtDuration(glDuration(r)) }
            ],
            summary: rows => {
                let c = 0, rq = 0, w = 0, p = 0, s = 0, od = 0;
                rows.forEach(r => {
                    if ((r.type || 'complaint') === 'request') rq++; else c++;
                    const st = r.status || 'Following';
                    if (st === 'Solved') s++; else { if (st === 'InProgress') p++; else w++; if (glOverdue(r)) od++; }
                });
                return [['Toplam', rows.length, 'i'], ['Şikayet', c, 'c'], ['Talep', rq, 'r'], ['Bekliyor', w, 'w'],
                ['İşlemde', p, 'p'], ['Tamamlandı', s, 's'], ['Geciken', od, 'o'], ['Çözüm', '%' + (rows.length ? Math.round(s / rows.length * 100) : 0), 'k']];
            }
        },

        reservations: {
            label: 'Concierge Rezervasyonları',
            // tsBoundType 'dateString': date alanı 'YYYY-MM-DD' string —
            // sunucu sınırı string karşılaştırmasıyla itilir (bkz. queryBounds).
            // Önceden bu domain'de hiç sunucu sınırı yoktu; her açılışta tüm
            // rezervasyon tarihçesi canlı iniyordu (bkz. hız denetimi).
            collection: 'reservations', order: ['date', 'desc'], tsBound: 'date', tsBoundType: 'dateString',
            dateOf: r => normDate(r.date),
            facets: [
                facet({ key: 'type', label: 'Hizmet', kind: 'chips', valueOf: resType }),
                facet({ key: 'detail', label: 'Detay / Yer', kind: 'text', valueOf: resDetail }),
                facet({ key: 'status', label: 'Durum', kind: 'chips', fixed: ['Bekliyor', 'Onaylı', 'İptal'], valueOf: resStatus }),
                facet({ key: 'currency', label: 'Para Birimi', kind: 'chips', fixed: ['EUR', 'TRY', 'USD'], valueOf: resCur }),
                facet({ key: 'room', label: 'Oda', kind: 'text', valueOf: r => r.room || '' }),
                facet({ key: 'guest', label: 'Misafir', kind: 'text', valueOf: r => r.guestName || '' })
            ],
            columns: [
                { label: 'Tarih', get: r => fmtDateTR(normDate(r.date)) },
                { label: 'Saat', get: r => r.time || '—' },
                { label: 'Hizmet', get: resType },
                { label: 'Detay / Yer', get: resDetail, wide: true },
                { label: 'Kişi', get: r => r.pax || '—', c: true },
                { label: 'Misafir', get: r => r.guestName || '—' },
                { label: 'Oda', get: r => r.room || '—' },
                { label: 'Durum', get: resStatus },
                { label: 'Fiyat', get: r => resCurSym(r) + money(r.totalPrice), c: true },
                { label: 'Kapora', get: r => resCurSym(r) + money(r.deposit), c: true },
                { label: 'Bakiye', get: r => resCurSym(r) + money((Number(r.totalPrice) || 0) - (Number(r.deposit) || 0)), c: true },
                { label: 'Voucher', get: r => r.voucherNo || '—' },
                { label: 'Not', get: r => r.notes || '', wide: true }
            ],
            // Para birimleri ASLA karıştırılmadan gruplanır (bkz. concierge.js
            // summarizeFinance() ile aynı ilke) — EUR ve TRY ciroları tek bir
            // sayıda toplanmaz, ayrı ayrı gösterilir.
            summary: rows => {
                let conf = 0, pend = 0, canc = 0;
                const byCur = {};
                rows.forEach(r => {
                    if (r.status === 'Confirmed') conf++; else if (r.status === 'Cancelled') canc++; else pend++;
                    if (r.status !== 'Cancelled') {
                        const cur = resCur(r);
                        const g = byCur[cur] || (byCur[cur] = { rev: 0, dep: 0 });
                        g.rev += Number(r.totalPrice) || 0; g.dep += Number(r.deposit) || 0;
                    }
                });
                const curs = Object.keys(byCur);
                const line = key => curs.length ? curs.map(c => RES_CUR_SYM[c] + money(byCur[c][key])).join(' · ') : '€0';
                const lineBal = () => curs.length ? curs.map(c => RES_CUR_SYM[c] + money(byCur[c].rev - byCur[c].dep)).join(' · ') : '€0';
                return [['Toplam', rows.length, 'i'], ['Onaylı', conf, 's'], ['Bekleyen', pend, 'w'], ['İptal', canc, 'o'],
                ['Ciro', line('rev'), 'k'], ['Kapora', line('dep'), 'p'], ['Kalan', lineBal(), 'c']];
            },
            groupAgg: rows => {
                const byCur = {};
                rows.forEach(r => { if (r.status !== 'Cancelled') { const c = resCur(r); byCur[c] = (byCur[c] || 0) + (Number(r.totalPrice) || 0); } });
                const rev = Object.keys(byCur).map(c => RES_CUR_SYM[c] + money(byCur[c])).join(' · ') || '€0';
                return rows.length + ' rez. · ' + rev + ' ciro';
            }
        },

        guestOrders: {
            label: 'Misafir Siparişleri (QR)',
            collection: 'guestOrders', order: ['createdAt', 'desc'], tsBound: 'createdAt',
            dateOf: r => normDate(r.createdAt),
            facets: [
                facet({ key: 'status', label: 'Durum', kind: 'chips', fixed: ['Bekliyor', 'Tamamlandı', 'İptal'], valueOf: ordStatus }),
                facet({ key: 'room', label: 'Oda', kind: 'text', valueOf: r => r.room || '' }),
                facet({ key: 'guest', label: 'Misafir', kind: 'text', valueOf: r => r.guestName || '' })
            ],
            columns: [
                { label: 'Tarih', get: r => fmtDateTR(normDate(r.createdAt)) },
                { label: 'Oda', get: r => r.room || '—' },
                { label: 'Misafir', get: r => r.guestName || '—' },
                { label: 'Ürünler', get: ordItems, wide: true },
                { label: 'Adet', get: r => r.itemCount || (Array.isArray(r.items) ? r.items.reduce((s, i) => s + (i.qty || 1), 0) : 0), c: true },
                { label: 'Tutar', get: r => money(r.total) + (r.currency ? ' ' + r.currency : ''), c: true },
                { label: 'Durum', get: ordStatus }
            ],
            summary: rows => {
                let pend = 0, done = 0, canc = 0, qty = 0, rev = 0;
                rows.forEach(r => {
                    if (r.status === 'completed') done++; else if (r.status === 'cancelled') canc++; else pend++;
                    qty += r.itemCount || 0;
                    if (r.status !== 'cancelled') rev += Number(r.total) || 0;
                });
                return [['Toplam', rows.length, 'i'], ['Bekleyen', pend, 'w'], ['Tamamlanan', done, 's'], ['İptal', canc, 'o'],
                ['Ürün Adedi', qty, 'p'], ['Ciro', money(rev), 'k']];
            },
            groupAgg: rows => {
                let rev = 0; rows.forEach(r => { if (r.status !== 'cancelled') rev += Number(r.total) || 0; });
                return rows.length + ' sipariş · ' + money(rev) + ' ciro';
            }
        },

        orderItems: {
            label: 'Sipariş Ürünleri (kalem bazlı)',
            collection: 'guestOrders', order: ['createdAt', 'desc'], tsBound: 'createdAt',
            // Explode each order into one row per product line.
            transform: orders => {
                const out = [];
                orders.forEach(o => {
                    if (!Array.isArray(o.items)) return;
                    o.items.forEach(it => out.push({
                        _date: normDate(o.createdAt), room: o.room || '', guestName: o.guestName || '',
                        category: it.category || 'Diğer', department: it.department || '—',
                        name: it.name || '—', qty: it.qty || 1, price: Number(it.price) || 0,
                        lineTotal: (Number(it.price) || 0) * (it.qty || 1),
                        ostatus: o.status, currency: o.currency || ''
                    }));
                });
                return out;
            },
            dateOf: r => r._date || '',
            facets: [
                facet({ key: 'category', label: 'Kategori', kind: 'chips', valueOf: r => r.category || 'Diğer' }),
                facet({ key: 'product', label: 'Ürün', kind: 'text', valueOf: r => r.name || '' }),
                facet({ key: 'department', label: 'Departman', kind: 'chips', valueOf: r => canonicalDept(r.department) || '—' }),
                facet({ key: 'status', label: 'Durum', kind: 'chips', fixed: ['Bekliyor', 'Tamamlandı', 'İptal'], valueOf: r => ORD_STATUS[r.ostatus] || 'Bekliyor' }),
                facet({ key: 'room', label: 'Oda', kind: 'text', valueOf: r => r.room || '' }),
                facet({ key: 'guest', label: 'Misafir', kind: 'text', valueOf: r => r.guestName || '' })
            ],
            columns: [
                { label: 'Tarih', get: r => fmtDateTR(r._date) },
                { label: 'Oda', get: r => r.room || '—' },
                { label: 'Misafir', get: r => r.guestName || '—' },
                { label: 'Kategori', get: r => r.category || 'Diğer' },
                { label: 'Ürün', get: r => r.name || '—', wide: true },
                { label: 'Adet', get: r => r.qty, c: true },
                { label: 'Birim', get: r => money(r.price), c: true },
                { label: 'Tutar', get: r => money(r.lineTotal), c: true },
                { label: 'Departman', get: r => canonicalDept(r.department) || '—' },
                { label: 'Durum', get: r => ORD_STATUS[r.ostatus] || 'Bekliyor' }
            ],
            summary: rows => {
                let qty = 0, rev = 0; const prod = new Set();
                rows.forEach(r => { qty += r.qty || 0; if (r.ostatus !== 'cancelled') rev += r.lineTotal || 0; prod.add((r.name || '').toLowerCase()); });
                return [['Satır', rows.length, 'i'], ['Toplam Adet', qty, 'p'], ['Farklı Ürün', prod.size, 'c'], ['Ciro', money(rev), 'k']];
            },
            groupAgg: rows => {
                let q = 0, rev = 0; rows.forEach(r => { q += r.qty || 0; if (r.ostatus !== 'cancelled') rev += r.lineTotal || 0; });
                return rows.length + ' kalem · ' + q + ' adet · ' + money(rev) + ' ciro';
            }
        },

        serviceRatings: {
            label: 'Hizmet Değerlendirmeleri (★)',
            collection: 'serviceRatings', order: ['createdAt', 'desc'], tsBound: 'createdAt',
            dateOf: r => normDate(r.createdAt),
            facets: [
                facet({ key: 'department', label: 'Departman', kind: 'chips', valueOf: r => canonicalDept(r.department) || '—' }),
                facet({ key: 'category', label: 'Kategori', kind: 'chips', valueOf: r => r.category || 'Diğer' }),
                facet({ key: 'product', label: 'Ürün', kind: 'text', valueOf: r => r.name || '' }),
                facet({ key: 'room', label: 'Oda', kind: 'text', valueOf: r => r.room || '' }),
                facet({ key: 'stars', label: 'Puan', kind: 'chips', fixed: ['1', '2', '3', '4', '5'], valueOf: r => String(r.stars || '') })
            ],
            columns: [
                { label: 'Tarih', get: r => fmtDateTR(normDate(r.createdAt)) },
                { label: 'Oda', get: r => r.room || '—' },
                { label: 'Departman', get: r => canonicalDept(r.department) || '—' },
                { label: 'Kategori', get: r => r.category || 'Diğer' },
                { label: 'Ürün', get: r => r.name || '—', wide: true },
                { label: 'Puan', get: r => '★'.repeat(r.stars || 0) + '☆'.repeat(5 - (r.stars || 0)) }
            ],
            summary: rows => {
                const n = rows.length, avg = n ? rows.reduce((s, r) => s + (r.stars || 0), 0) / n : 0;
                const low = rows.filter(r => (r.stars || 0) <= 3).length;
                return [['Değerlendirme', n, 'i'], ['Ortalama', avg ? avg.toFixed(2) + ' ★' : '—', ratingTint(avg)], ['Düşük Puan (≤3)', low, low ? 'o' : 's']];
            },
            groupAgg: rows => {
                const n = rows.length, avg = n ? rows.reduce((s, r) => s + (r.stars || 0), 0) / n : 0;
                return n + ' değerlendirme · Ort. ' + avg.toFixed(2) + ' ★' + (avg > 0 && avg < 3 ? ' ⚠️ Düşük' : '');
            }
        },

        guestDirectory: {
            label: 'Misafirler (Rehber)',
            collection: 'guestDirectory', order: null,
            dateOf: r => normDate(r.checkIn),
            facets: [
                facet({ key: 'status', label: 'Durum', kind: 'chips', fixed: ['Otelde', 'Ön Geliş', 'Çıkış Yaptı'], valueOf: dirStatus }),
                facet({ key: 'room', label: 'Oda', kind: 'text', valueOf: r => r.room || '' }),
                facet({ key: 'guest', label: 'Misafir', kind: 'text', valueOf: r => r.name || '' })
            ],
            columns: [
                { label: 'Misafir', get: r => r.name || '—' },
                { label: 'Oda', get: r => r.room || '—' },
                { label: 'Durum', get: dirStatus },
                { label: 'Giriş', get: r => fmtDateTR(normDate(r.checkIn)) },
                { label: 'Çıkış', get: r => fmtDateTR(normDate(r.checkOut)) }
            ],
            summary: rows => {
                let ih = 0, pa = 0, co = 0;
                rows.forEach(r => { if (r.status === 'in_house') ih++; else if (r.status === 'pre_arrival') pa++; else co++; });
                return [['Toplam', rows.length, 'i'], ['Otelde', ih, 's'], ['Ön Geliş', pa, 'w'], ['Çıkış Yaptı', co, 'c']];
            }
        },

        restSales: {
            label: 'Restoran Satışları (adisyon bazlı)',
            collection: 'restChecks', order: ['closedAt', 'desc'], tsBound: 'closedAt',
            // Kapanmış adisyonlar: her satır bir adisyon (checkNo).
            transform: checks => {
                const PM = { cash: 'Nakit', card: 'Kart', room: 'Oda Hesabı' };
                return checks.filter(c => c.status === 'paid').map(c => ({
                    _date: normDate(c.closedAt || c.openedAt),
                    checkNo: c.checkNo || '', table: c.tableName || '—', section: c.section || 'Genel',
                    roomName: c.room ? ('Oda ' + c.room + (c.name ? ' · ' + c.name : '')) : (c.name || '—'),
                    pax: Number(c.pax) || 0, waiter: c.closedBy || c.openedBy || '—',
                    itemCount: Array.isArray(c.items) ? c.items.reduce((s, i) => s + (i.qty || 1), 0) : 0,
                    total: Number(c.payable != null ? c.payable : c.total) || 0,
                    payment: [...new Set((c.payments || []).map(p => PM[p.method] || p.method))].join(', ') || '—',
                    checkId: c.id
                }));
            },
            dateOf: r => r._date || '',
            facets: [
                facet({ key: 'payment', label: 'Ödeme', kind: 'chips', valueOf: r => r.payment || '—' }),
                facet({ key: 'waiter', label: 'Garson', kind: 'chips', valueOf: r => r.waiter || '—' }),
                facet({ key: 'section', label: 'Bölüm', kind: 'chips', valueOf: r => r.section || 'Genel' }),
                facet({ key: 'table', label: 'Masa', kind: 'text', valueOf: r => r.table || '' }),
                facet({ key: 'checkNo', label: 'Adisyon No', kind: 'text', valueOf: r => String(r.checkNo || '') })
            ],
            columns: [
                { label: 'Adisyon', get: r => r.checkNo ? '#' + r.checkNo : '—' },
                { label: 'Tarih', get: r => fmtDateTR(r._date) },
                { label: 'Masa', get: r => r.table || '—' },
                { label: 'Oda / İsim', get: r => r.roomName || '—', wide: true },
                { label: 'Kişi', get: r => r.pax, c: true },
                { label: 'Garson', get: r => r.waiter || '—' },
                { label: 'Ürün', get: r => r.itemCount, c: true },
                { label: 'Ödeme', get: r => r.payment || '—' },
                { label: 'Tutar', get: r => money(r.total), c: true }
            ],
            summary: rows => {
                let rev = 0, pax = 0; rows.forEach(r => { rev += r.total || 0; pax += r.pax || 0; });
                return [['Adisyon', rows.length, 'i'], ['Kişi', pax, 'p'], ['Ciro', money(rev), 'k'],
                ['Ort. Adisyon', money(rows.length ? rev / rows.length : 0), 's'], ['Kişi Başı', money(pax ? rev / pax : 0), 'c']];
            },
            groupAgg: rows => { let rev = 0; rows.forEach(r => rev += r.total || 0); return rows.length + ' adisyon · ' + money(rev) + ' ciro'; }
        },

        restItems: {
            label: 'Restoran Ürün Satışları (kalem bazlı)',
            collection: 'restChecks', order: ['closedAt', 'desc'], tsBound: 'closedAt',
            transform: checks => {
                const PM = { cash: 'Nakit', card: 'Kart', room: 'Oda Hesabı' };
                const out = [];
                checks.forEach(c => {
                    if (c.status !== 'paid' || !Array.isArray(c.items)) return;
                    const pmList = [...new Set((c.payments || []).map(p => PM[p.method] || p.method))].join(', ') || '—';
                    const d = normDate(c.closedAt || c.openedAt);
                    c.items.forEach(it => out.push({
                        _date: d, checkNo: c.checkNo || '', table: c.tableName || '—', waiter: c.openedBy || '—',
                        category: it.category || 'Diğer', name: it.name || '—', qty: it.qty || 1,
                        price: Number(it.unitPrice) || 0, lineTotal: (Number(it.unitPrice) || 0) * (it.qty || 1),
                        payment: pmList, checkId: c.id
                    }));
                });
                return out;
            },
            dateOf: r => r._date || '',
            facets: [
                facet({ key: 'category', label: 'Kategori', kind: 'chips', valueOf: r => r.category || 'Diğer' }),
                facet({ key: 'product', label: 'Ürün', kind: 'text', valueOf: r => r.name || '' }),
                facet({ key: 'waiter', label: 'Garson', kind: 'chips', valueOf: r => r.waiter || '—' }),
                facet({ key: 'table', label: 'Masa', kind: 'text', valueOf: r => r.table || '' })
            ],
            columns: [
                { label: 'Adisyon', get: r => r.checkNo ? '#' + r.checkNo : '—' },
                { label: 'Tarih', get: r => fmtDateTR(r._date) },
                { label: 'Masa', get: r => r.table || '—' },
                { label: 'Kategori', get: r => r.category || 'Diğer' },
                { label: 'Ürün', get: r => r.name || '—', wide: true },
                { label: 'Adet', get: r => r.qty, c: true },
                { label: 'Birim', get: r => money(r.price), c: true },
                { label: 'Tutar', get: r => money(r.lineTotal), c: true }
            ],
            summary: rows => {
                let qty = 0, rev = 0; const checks = new Set();
                rows.forEach(r => { qty += r.qty || 0; rev += r.lineTotal || 0; if (r.checkId) checks.add(r.checkId); });
                return [['Satır', rows.length, 'i'], ['Adet', qty, 'p'], ['Adisyon', checks.size, 'c'], ['Ciro', money(rev), 'k']];
            },
            groupAgg: rows => { let q = 0, rev = 0; rows.forEach(r => { q += r.qty || 0; rev += r.lineTotal || 0; }); return rows.length + ' kalem · ' + q + ' adet · ' + money(rev) + ' ciro'; }
        }
    };
    const DOMAIN_ORDER = ['guestLogs', 'reservations', 'guestOrders', 'orderItems', 'serviceRatings', 'guestDirectory', 'restSales', 'restItems'];

    // ── State ──────────────────────────────────────────────────
    let domainKey = 'guestLogs';
    let D = DOMAINS.guestLogs;
    let records = [];
    let unsub = null;
    let ready = false;
    const cache = {};               // domainKey -> records
    // Varsayılan aralık 'Son 30 Gün' — 'Tüm Zamanlar' varsayılanı her domain
    // seçiminde tüm koleksiyonu canlı dinletiyordu (bkz. hız denetimi);
    // isteyen hâlâ elle 'Tüm Zamanlar'ı seçebilir.
    let preset = '30', cFrom = '', cTo = '';
    let groupBy = 'none';
    let sel = {};                   // facet.key -> Set (chips) | string (text)

    function resetFilters() {
        preset = '30'; cFrom = ''; cTo = ''; groupBy = 'none';
        sel = {};
        D.facets.forEach(f => { sel[f.key] = (f.kind === 'chips') ? new Set() : ''; });
    }

    // ── Date window ────────────────────────────────────────────
    function dateWindow() {
        const now = new Date(); const t = todayStr();
        const som = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        switch (preset) {
            case 'today': return { from: t, to: t };
            case 'yesterday': { const y = new Date(now); y.setDate(now.getDate() - 1); return { from: ymd(y), to: ymd(y) }; }
            case '7': { const a = new Date(now); a.setDate(now.getDate() - 6); return { from: ymd(a), to: t }; }
            case '30': { const a = new Date(now); a.setDate(now.getDate() - 29); return { from: ymd(a), to: t }; }
            case 'thismonth': return { from: som, to: t };
            case 'lastmonth': { const a = new Date(now.getFullYear(), now.getMonth() - 1, 1); const b = new Date(now.getFullYear(), now.getMonth(), 0); return { from: ymd(a), to: ymd(b) }; }
            case 'custom': return { from: cFrom || '', to: cTo || '' };
            default: return { from: '', to: '' };
        }
    }
    function rangeLabel() {
        const w = dateWindow();
        if (preset === 'all' || (!w.from && !w.to)) return 'Tüm Zamanlar';
        if (w.from === w.to) return fmtDateTR(w.from);
        return fmtDateTR(w.from) + ' – ' + fmtDateTR(w.to);
    }

    // ── Filtering / grouping ───────────────────────────────────
    function inDateWindow(r) {
        const w = dateWindow();
        const d = D.dateOf(r);
        if (w.from && d && d < w.from) return false;
        if (w.to && d && d > w.to) return false;
        // Bir tarih filtresi tarihsiz kayıtları hariç tutmalı — öncesinde
        // yalnızca w.from kontrol ediliyordu; yalnız "bitiş" (to) tarihi
        // seçildiğinde tarihsiz kayıtlar hiçbir koşula takılmadan sızıyordu.
        if ((w.from || w.to) && !d) return false;
        return true;
    }
    function matchFacet(f, r) {
        const s = sel[f.key];
        if (f.kind === 'chips') {
            if (f.match) return f.match(r, s);
            return !s.size || s.has(f.valueOf(r));
        }
        const q = (s || '').trim().toLowerCase();
        return !q || String(f.valueOf(r) || '').toLowerCase().includes(q);
    }
    function filtered() {
        return records.filter(r => inDateWindow(r) && D.facets.every(f => matchFacet(f, r)))
            .sort((a, b) => String(D.dateOf(b)).localeCompare(String(D.dateOf(a))));
    }
    // Tarih penceresi + bir facet HARİÇ tüm facet'lerle eşleşen kayıtlar.
    // O facet'in "veri olan" seçeneklerini hesaplamak için (kademeli/dinamik filtre).
    function filteredExcept(exceptKey) {
        return records.filter(r => {
            if (!inDateWindow(r)) return false;
            for (const f of D.facets) { if (f.key !== exceptKey && !matchFacet(f, r)) return false; }
            return true;
        });
    }
    // group options = chip facets + Güne/Haftaya/Aya/Yıla göre
    function groupFacet() {
        if (groupBy === 'none') return null;
        if (groupBy === '__date__') return { keyOf: r => D.dateOf(r) || '—', label: k => fmtDateTR(k) };
        if (groupBy === '__week__') return { keyOf: r => isoWeekKey(D.dateOf(r) || todayStr()), label: k => k };
        if (groupBy === '__month__') return { keyOf: r => monthKey(D.dateOf(r) || todayStr()), label: k => k };
        if (groupBy === '__year__') return { keyOf: r => yearKey(D.dateOf(r) || todayStr()), label: k => k };
        const f = D.facets.find(x => x.key === groupBy);
        if (!f) return null;
        return { keyOf: r => f.valueOf(r), label: k => k };
    }
    function grouped(rows) {
        const gf = groupFacet();
        if (!gf) return [{ key: '', label: '', rows }];
        const map = new Map();
        rows.forEach(r => { const k = gf.keyOf(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
        const arr = [...map.entries()].map(([k, rs]) => ({ key: k, label: gf.label(k), rows: rs }));
        if (/^__(date|week|month|year)__$/.test(groupBy)) arr.sort((a, b) => String(b.key).localeCompare(String(a.key)));
        else arr.sort((a, b) => b.rows.length - a.rows.length || String(a.label).localeCompare(String(b.label), 'tr'));
        return arr;
    }

    // ── Dynamic chip values (kademeli filtre) ──────────────────
    // Yalnızca DİĞER filtrelerle + tarihle eşleşen veride MEVCUT değerleri göster.
    // Örn: Tür=Şikayet seçilince Departman'da yalnızca şikayet verisi olan
    // departmanlar görünür. Hâlihazırda seçili değerler her zaman görünür kalır.
    function facetHasValue(f, r, v) { return f.match ? f.match(r, new Set([v])) : (f.valueOf(r) === v); }
    function chipValues(f) {
        const base = filteredExcept(f.key);
        const selSet = (sel[f.key] && sel[f.key].has) ? sel[f.key] : new Set();
        const cand = new Set();
        if (f.fixed) f.fixed.forEach(v => cand.add(v));
        base.forEach(r => { const v = f.valueOf(r); if (v && v !== '—') cand.add(v); });
        selSet.forEach(v => cand.add(v));
        const present = [...cand].filter(v => selSet.has(v) || base.some(r => facetHasValue(f, r, v)));
        if (f.fixed) {
            const inFixed = f.fixed.filter(v => present.indexOf(v) !== -1);
            const rest = present.filter(v => f.fixed.indexOf(v) === -1).sort((a, b) => String(a).localeCompare(String(b), 'tr'));
            return inFixed.concat(rest);
        }
        return present.sort((a, b) => String(a).localeCompare(String(b), 'tr'));
    }

    // ── Render sidebar facets ──────────────────────────────────
    function renderFacets() {
        const host = $('repFacets');
        host.innerHTML = D.facets.map(f => {
            if (f.kind === 'chips') {
                const vals = chipValues(f);
                const inner = vals.length
                    ? vals.map(v => `<button data-facet="${esc(f.key)}" data-v="${esc(v)}"${sel[f.key].has(v) ? ' class="active"' : ''}>${esc(v)}</button>`).join('')
                    : '<span class="rep-none">Veri yok</span>';
                return `<div class="rep-f"><label class="rep-l">${esc(f.label)}</label><div class="rep-chips">${inner}</div></div>`;
            }
            return `<div class="rep-f"><label class="rep-l">${esc(f.label)}</label><input type="text" class="rep-in" data-facet="${esc(f.key)}" value="${esc(sel[f.key] || '')}" placeholder="${esc(f.label)} ile filtrele"></div>`;
        }).join('');
        host.querySelectorAll('button[data-facet]').forEach(b => {
            b.onclick = () => {
                const s = sel[b.getAttribute('data-facet')], v = b.getAttribute('data-v');
                if (s.has(v)) s.delete(v); else s.add(v);
                refresh(); // diğer facet'lerin "veri olan" seçenekleri güncellensin
            };
        });
        host.querySelectorAll('input[data-facet]').forEach(inp => {
            inp.oninput = () => { sel[inp.getAttribute('data-facet')] = inp.value; render(); };
        });
        // group-by options
        const gb = $('repGroupBy');
        const opts = ['<option value="none">Gruplama Yok (düz liste)</option>']
            .concat(D.facets.filter(f => f.kind === 'chips').map(f => `<option value="${esc(f.key)}">${esc(f.label)}e göre</option>`))
            .concat(['<option value="__date__">Güne göre</option>', '<option value="__week__">Haftaya göre</option>',
                     '<option value="__month__">Aya göre</option>', '<option value="__year__">Yıla göre</option>']);
        gb.innerHTML = opts.join('');
        gb.value = groupBy;
    }

    // Facet seçenekleri + tablo birlikte tazelensin (kademeli filtre).
    function refresh() { renderFacets(); render(); }

    // ── Render preview ─────────────────────────────────────────
    function render() {
        const rows = filtered();
        const cols = D.columns;
        $('repTitle').textContent = D.label;
        const gName = $('repGroupBy').selectedOptions[0] ? $('repGroupBy').selectedOptions[0].textContent : '';
        $('repRangeLabel').textContent = rangeLabel() + (groupBy !== 'none' ? ' · ' + gName : '') + ' · ' + rows.length + ' kayıt';

        $('repStats').innerHTML = D.summary(rows).map(([l, v, c]) =>
            `<div class="rep-stat s-${c}"><span class="v">${esc(v)}</span><span class="l">${esc(l)}</span></div>`).join('');

        const groups = grouped(rows);
        const MAX = 400; let shown = 0, truncated = false, html = '';
        if (!rows.length) {
            html = `<div class="rep-empty">Seçili filtrelerle kayıt bulunamadı.</div>`;
        } else {
            html = `<table class="rep-table"><thead><tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
            for (const g of groups) {
                if (g.key !== '') html += `<tr class="rep-grp"><td colspan="${cols.length}">${esc(g.label)} <span>${esc(D.groupAgg ? D.groupAgg(g.rows) : g.rows.length + ' kayıt')}</span></td></tr>`;
                for (const r of g.rows) {
                    if (shown >= MAX) { truncated = true; break; }
                    html += '<tr>' + cols.map(c => {
                        const val = c.get(r);
                        return `<td class="${c.wide ? 'rep-w' : ''}${c.c ? ' rep-c' : ''}" title="${esc(val)}">${esc(val)}</td>`;
                    }).join('') + '</tr>';
                    shown++;
                }
                if (truncated) break;
            }
            html += '</tbody></table>';
            if (truncated) html += `<div class="rep-more">Önizlemede ilk ${MAX} kayıt · Excel/Yazdır tüm ${rows.length} kaydı içerir.</div>`;
        }
        $('repTableScroll').innerHTML = html;
    }

    // ── Filter description (exports) ───────────────────────────
    function filterDesc() {
        const parts = ['Kaynak: ' + D.label, 'Tarih: ' + rangeLabel()];
        D.facets.forEach(f => {
            const s = sel[f.key];
            if (f.kind === 'chips') { if (s.size) parts.push(f.label + ': ' + [...s].join(', ')); }
            else if ((s || '').trim()) parts.push(f.label + ': ' + s.trim());
        });
        if (groupBy !== 'none') { const g = $('repGroupBy').selectedOptions[0]; if (g) parts.push('Gruplama: ' + g.textContent); }
        return parts;
    }

    // ── Excel export (HTML→.xls) ───────────────────────────────
    function exportExcel() {
        const rows = filtered();
        if (!rows.length) { toast('Bu rapor için veri yok.', true); return; }
        const cols = D.columns;
        const groups = grouped(rows);
        const sumRows = D.summary(rows).map(([l, v]) => [l, v]);
        const head = '<tr>' + cols.map(c => `<th>${esc(c.label)}</th>`).join('') + '</tr>';
        let body = '';
        for (const g of groups) {
            if (g.key !== '') body += `<tr><td class="grp" colspan="${cols.length}">${esc(g.label)}  (${esc(D.groupAgg ? D.groupAgg(g.rows) : g.rows.length + ' kayıt')})</td></tr>`;
            for (const r of g.rows) body += '<tr>' + cols.map(c => `<td class="${c.wide ? 'wide' : ''}${c.c ? ' c' : ''}">${esc(c.get(r))}</td>`).join('') + '</tr>';
            if (groupBy !== 'none' && g.key !== '') body += `<tr><td class="sub" colspan="${cols.length}">Ara toplam: ${g.rows.length}</td></tr>`;
        }
        const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Rapor</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
 table{border-collapse:collapse;font-family:'Segoe UI',Arial,sans-serif;font-size:10pt;margin-bottom:14px}
 td,th{border:0.5pt solid #c9ced6;padding:6px 8px;vertical-align:middle}
 th{background:#111827;color:#fff;font-weight:bold;text-align:center}
 .c{text-align:center}.wide{width:280px;white-space:normal;word-wrap:break-word}
 .grp{background:#e8edf7;color:#1e3a8a;font-weight:bold;font-size:11pt}
 .sub{background:#f4f6fa;color:#475569;font-style:italic;text-align:right;font-size:9pt}
 .t-title{font-size:17pt;font-weight:bold;color:#111827}.t-sub{font-size:9pt;color:#64748b}
 .sumk{background:#f8fafc;font-weight:bold;width:180px}.sumv{text-align:center;font-weight:bold;width:110px}
 .sumh{background:#2563eb;color:#fff;font-weight:bold;text-align:center}
</style></head><body>
<div class="t-title">${esc(D.label)} — Hotizy Rapor</div>
<div class="t-sub">${esc(filterDesc().join('  ·  '))}</div>
<div class="t-sub">Oluşturulma: ${esc(fmtDateTR(todayStr()))}</div><br>
<table><tr><td class="sumh" colspan="2">ÖZET</td></tr>${sumRows.map(([k, v]) => `<tr><td class="sumk">${esc(k)}</td><td class="sumv">${esc(v)}</td></tr>`).join('')}</table>
<table><thead>${head}</thead><tbody>${body}</tbody></table>
</body></html>`;
        const blob = new Blob(['﻿', html], { type: 'application/vnd.ms-excel;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'Hotizy_' + domainKey + '_' + todayStr() + '.xls';
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        toast('Excel raporu indirildi.');
    }

    // ── Print ──────────────────────────────────────────────────
    function printReport() {
        const rows = filtered();
        if (!rows.length) { toast('Bu rapor için veri yok.', true); return; }
        const cols = D.columns;
        const groups = grouped(rows);
        const stats = D.summary(rows);
        let body = '';
        for (const g of groups) {
            if (g.key !== '') body += `<tr><td class="grp" colspan="${cols.length}">${esc(g.label)} — ${esc(D.groupAgg ? D.groupAgg(g.rows) : g.rows.length + ' kayıt')}</td></tr>`;
            for (const r of g.rows) body += '<tr>' + cols.map(c => `<td class="${c.wide ? 'wide' : ''}">${esc(c.get(r))}</td>`).join('') + '</tr>';
        }
        const w = window.open('', '_blank');
        if (!w) { toast('Açılır pencere engellendi.', true); return; }
        w.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>${esc(D.label)} — Hotizy</title>
<style>
 *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111827}
 h1{font-size:20px;margin:0 0 2px}.sub{font-size:11px;color:#64748b;margin-bottom:14px;line-height:1.5}
 .stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
 .stat{border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;min-width:90px}
 .stat b{display:block;font-size:18px}.stat span{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px}
 table{border-collapse:collapse;width:100%;font-size:10px}
 td,th{border:1px solid #d1d5db;padding:5px 7px;text-align:left;vertical-align:top}
 th{background:#111827;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.4px}
 .grp{background:#e8edf7;color:#1e3a8a;font-weight:bold}.wide{max-width:240px}
 tr{page-break-inside:avoid}@media print{body{margin:10px}}
</style></head><body>
<h1>${esc(D.label)} — Hotizy Rapor</h1>
<div class="sub">${esc(filterDesc().join(' · '))}<br>Oluşturulma: ${esc(fmtDateTR(todayStr()))}</div>
<div class="stats">${stats.map(([l, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
<table><thead><tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
<script>window.onload=function(){setTimeout(function(){window.print();},300);}<\/script>
</body></html>`);
        w.document.close();
    }

    // ── Domain switching / data ────────────────────────────────
    // Seçili tarih aralığını sunucu tarafına iter (tüm koleksiyonu çekmek
    // yerine). Yalnızca order alanı = sınır alanı olan domain'lerde (tsBound)
    // ve aralık zaman damgası alanıyla aynı günse güvenli; render() zaten
    // dateOf ile istemci tarafında tam filtrelediğinden ±1 gün marj bırakıp
    // hiçbir aralık-içi kaydı atlamayız. 'Tüm Zamanlar'da sınır yok.
    const DAY_MS = 86400000;
    function queryBounds() {
        if (!D.tsBound) return null;
        const w = dateWindow();
        if (!w.from && !w.to) return null; // preset 'all' → tüm koleksiyon
        const out = {};
        if (D.tsBoundType === 'dateString') {
            // 'YYYY-MM-DD' string alanlar (ör. reservations.date) — string
            // karşılaştırması leksikografik olarak doğru; ±1 gün marj korunur.
            const shift = (s, days) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + days); return ymd(d); };
            if (w.from) out.lo = shift(w.from, -1);
            if (w.to) out.hi = shift(w.to, 1);
            return out;
        }
        if (w.from) out.lo = firebase.firestore.Timestamp.fromDate(new Date(new Date(w.from + 'T00:00:00').getTime() - DAY_MS));
        if (w.to) out.hi = firebase.firestore.Timestamp.fromDate(new Date(new Date(w.to + 'T23:59:59.999').getTime() + DAY_MS));
        return out;
    }
    function subscribe() {
        if (unsub) { try { unsub(); } catch (e) { } unsub = null; }
        let q = db.collection(D.collection).where('tenantId', '==', TENANT_ID);
        const b = queryBounds();
        if (b && b.lo) q = q.where(D.tsBound, '>=', b.lo);
        if (b && b.hi) q = q.where(D.tsBound, '<=', b.hi);
        if (D.order) { try { q = q.orderBy(D.order[0], D.order[1]); } catch (e) { } }
        ready = false;
        // Map docs, optionally transform (e.g. explode orders into line items).
        const apply = docs => {
            const raw = docs.map(d => Object.assign({ id: d.id }, d.data()));
            records = D.transform ? D.transform(raw) : raw;
            cache[domainKey] = records; ready = true; renderFacets(); render();
        };
        // Show cached immediately for snappy switches.
        if (cache[domainKey]) { records = cache[domainKey]; ready = true; renderFacets(); render(); }
        unsub = q.onSnapshot(snap => apply(snap.docs), err => {
            console.error('reports load failed', err);
            // Fallback without orderBy (e.g. missing composite index).
            if (D.order) {
                if (unsub) { try { unsub(); } catch (e) { } }
                unsub = db.collection(D.collection).where('tenantId', '==', TENANT_ID)
                    .onSnapshot(s2 => apply(s2.docs), e2 => { console.error(e2); toast('Veriler yüklenemedi.', true); });
            } else { toast('Veriler yüklenemedi.', true); }
        });
    }

    function setDomain(key) {
        if (!DOMAINS[key]) return;
        domainKey = key; D = DOMAINS[key];
        resetFilters();
        $('repDatePreset').value = '30'; $('repCustomDates').style.display = 'none';
        $('repFrom').value = ''; $('repTo').value = '';
        records = cache[key] || [];
        renderFacets(); render();
        subscribe();
    }

    // ── Wire ───────────────────────────────────────────────────
    function wire() {
        $('repDomain').innerHTML = DOMAIN_ORDER.map(k => `<option value="${k}">${esc(DOMAINS[k].label)}</option>`).join('');
        $('repDomain').onchange = e => setDomain(e.target.value);
        // Tarih aralığı değişince, sunucu sınırlaması olan domain'lerde sorguyu
        // yeni aralıkla yeniden kur (snapshot render eder); diğerlerinde istemci
        // tarafında yeniden filtrele.
        const applyDateChange = () => { if (D.tsBound) { renderFacets(); subscribe(); } else { refresh(); } };
        $('repDatePreset').onchange = e => { preset = e.target.value; $('repCustomDates').style.display = (preset === 'custom') ? '' : 'none'; applyDateChange(); };
        $('repFrom').onchange = e => { cFrom = e.target.value; applyDateChange(); };
        $('repTo').onchange = e => { cTo = e.target.value; applyDateChange(); };
        $('repGroupBy').onchange = e => { groupBy = e.target.value; render(); };
        $('repReset').onclick = () => { setDomain(domainKey); };
        $('repExcel').onclick = exportExcel;
        $('repPrint').onclick = printReport;
    }

    function start() {
        wire();
        if (window.IssueConfig) {
            IssueConfig.load().then(() => { if (domainKey === 'guestLogs') renderFacets(); });
            IssueConfig.listen(() => { if (domainKey === 'guestLogs' && ready) renderFacets(); });
            IssueConfig.listenTopics(() => { if (domainKey === 'guestLogs' && ready) renderFacets(); });
        }
        setDomain('guestLogs');
    }
    function boot() {
        if (typeof auth !== 'undefined' && auth.onAuthStateChanged) auth.onAuthStateChanged(u => { if (u) start(); });
        else start();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
