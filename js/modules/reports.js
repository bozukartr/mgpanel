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
    // 'Done' EKSİKTİ: Concierge'te "Tamamlandı" yapılan rezervasyonlar raporda
    // "Bekliyor" görünüyor ve bekleyen sayısını şişiriyordu.
    const RES_STATUS = { Pending: 'Bekliyor', Confirmed: 'Onaylı', Done: 'Tamamlandı', Cancelled: 'İptal' };
    const RES_TONE = { Pending: 'warn', Confirmed: 'info', Done: 'ok', Cancelled: 'bad' };
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
    // QR sipariş durumları: 'confirmed' ve 'in_progress' haritada YOKTU — raporda
    // İngilizce ham değer ("confirmed", "in_progress") olarak görünüyordu.
    const ORD_STATUS = { pending: 'Bekliyor', confirmed: 'Onaylandı', accepted: 'Onaylandı', in_progress: 'İşlemde', completed: 'Tamamlandı', cancelled: 'İptal' };
    const ORD_TONE = { pending: 'warn', confirmed: 'info', accepted: 'info', in_progress: 'info', completed: 'ok', cancelled: 'bad' };
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
            // Sıralama: önce "ne, kim, ne durumda" — Durum ve Süre eskiden en
            // sondaydı ve masaüstünde bile ekranın dışında kalıyordu.
            columns: [
                { label: 'Tarih', get: r => fmtDateTR(r.date) },
                { label: 'Oda', get: r => r.room || '—' },
                { label: 'Misafir', get: r => r.guestName || '—' },
                { label: 'Tür', get: glType },
                { label: 'Durum', get: r => glStatus(r.status) + (glOverdue(r) ? ' (gecikti)' : ''),
                  tone: r => glOverdue(r) ? 'bad' : ({ Solved: 'ok', InProgress: 'info' }[r.status] || 'warn'),
                  pillText: r => glStatus(r.status) + (glOverdue(r) ? ' · gecikti' : '') },
                { label: 'Süre', get: r => fmtDuration(glDuration(r)), c: true },
                { label: 'Departman', get: r => canonicalDept(r.department) || '—' },
                { label: 'Üstlenen', get: glWorker },
                { label: 'Açıklama', get: r => r.complaint || '', wide: true },
                { label: 'Konu', get: r => (r.type || 'complaint') === 'complaint' ? (r.topic || 'Genel') : '—' },
                { label: 'Çözüm', get: r => (r.type || 'complaint') === 'request' ? '' : (r.solution || ''), wide: true },
                { label: 'Kaydı Giren', get: r => r.staffInitial || '—' }
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
                facet({ key: 'status', label: 'Durum', kind: 'chips', fixed: ['Bekliyor', 'Onaylı', 'Tamamlandı', 'İptal'], valueOf: resStatus }),
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
                { label: 'Durum', get: resStatus, tone: r => RES_TONE[r.status] || 'warn' },
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
                let conf = 0, pend = 0, canc = 0, done = 0;
                const byCur = {};
                rows.forEach(r => {
                    if (r.status === 'Confirmed') conf++; else if (r.status === 'Cancelled') canc++; else if (r.status === 'Done') done++; else pend++;
                    if (r.status !== 'Cancelled') {
                        const cur = resCur(r);
                        const g = byCur[cur] || (byCur[cur] = { rev: 0, dep: 0 });
                        g.rev += Number(r.totalPrice) || 0; g.dep += Number(r.deposit) || 0;
                    }
                });
                const curs = Object.keys(byCur);
                const line = key => curs.length ? curs.map(c => RES_CUR_SYM[c] + money(byCur[c][key])).join(' · ') : '€0';
                const lineBal = () => curs.length ? curs.map(c => RES_CUR_SYM[c] + money(byCur[c].rev - byCur[c].dep)).join(' · ') : '€0';
                return [['Toplam', rows.length, 'i'], ['Onaylı', conf, 's'], ['Tamamlandı', done, 's'], ['Bekleyen', pend, 'w'], ['İptal', canc, 'o'],
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
                facet({ key: 'status', label: 'Durum', kind: 'chips', fixed: ['Bekliyor', 'Onaylandı', 'İşlemde', 'Tamamlandı', 'İptal'], valueOf: ordStatus }),
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
                { label: 'Durum', get: ordStatus, tone: r => ORD_TONE[r.status] || 'warn' }
            ],
            summary: rows => {
                let pend = 0, done = 0, canc = 0, qty = 0, rev = 0;
                rows.forEach(r => {
                    if (r.status === 'completed') done++; else if (r.status === 'cancelled') canc++; else pend++;
                    qty += r.itemCount || 0;
                    if (r.status !== 'cancelled') rev += Number(r.total) || 0;
                });
                return [['Toplam', rows.length, 'i'], ['Açık', pend, 'w'], ['Tamamlanan', done, 's'], ['İptal', canc, 'o'],
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
                        // Kalem bazlı durum (kalemler ayrı ayrı onaylanır/iptal edilir);
                        // eski kayıtlarda kalem durumu yoksa sipariş durumu.
                        ostatus: it.status || o.status, currency: o.currency || ''
                    }));
                });
                return out;
            },
            dateOf: r => r._date || '',
            facets: [
                facet({ key: 'category', label: 'Kategori', kind: 'chips', valueOf: r => r.category || 'Diğer' }),
                facet({ key: 'product', label: 'Ürün', kind: 'text', valueOf: r => r.name || '' }),
                facet({ key: 'department', label: 'Departman', kind: 'chips', valueOf: r => canonicalDept(r.department) || '—' }),
                facet({ key: 'status', label: 'Durum', kind: 'chips', fixed: ['Bekliyor', 'Onaylandı', 'İşlemde', 'Tamamlandı', 'İptal'], valueOf: r => ORD_STATUS[r.ostatus] || 'Bekliyor' }),
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
                { label: 'Durum', get: r => ORD_STATUS[r.ostatus] || 'Bekliyor', tone: r => ORD_TONE[r.ostatus] || 'warn' }
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

    // ── Menü + özet + grafik tanımları (rapor türü başına) ──────────
    // module: bu raporun ait olduğu modül — otelde/kullanıcıda kapalıysa menüde
    // görünmez (eskiden restoranı olmayan bir otel de "Restoran Satışları"nı
    // görüyordu). kpis: özet kartları {l, v, s, tone, icon}. trend: zaman
    // serisi ölçüsü. breakdowns: sıralı dağılım çubukları; `facet` verilirse
    // satıra tıklamak o filtreyi uygular.
    const sumBy = (rows, f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
    const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
    function glTimes(rows) {
        let ackSum = 0, ackN = 0, solSum = 0, solN = 0;
        rows.forEach(r => {
            const cr = tsToDate(r.createdAt), ack = tsToDate(r.acknowledgedAt), done = tsToDate(r.completedAt);
            if (cr && ack && ack >= cr) { ackSum += ack - cr; ackN++; }
            if ((r.status || '') === 'Solved' && cr && done && done >= cr) { solSum += done - cr; solN++; }
        });
        return { ack: ackN ? ackSum / ackN : null, ackN, sol: solN ? solSum / solN : null, solN };
    }
    const fromSummary = rows => D.summary(rows).map(([l, v, c]) => ({ l, v, tone: (c === 'o' && Number(v) > 0) ? 'bad' : '' }));
    const META = {
        guestLogs: {
            nav: 'Talep ve şikayetler', group: 'Misafir hizmetleri', icon: 'clipboard', module: 'guestIssues',
            title: 'Talep ve şikayetler',
            kpis: rows => {
                let c = 0, rq = 0, w = 0, p = 0, s = 0, od = 0;
                rows.forEach(r => {
                    if ((r.type || 'complaint') === 'request') rq++; else c++;
                    const st = r.status || 'Following';
                    if (st === 'Solved') s++; else { if (st === 'InProgress') p++; else w++; if (glOverdue(r)) od++; }
                });
                const t = glTimes(rows);
                return [
                    { l: 'Toplam kayıt', v: rows.length, s: c + ' şikayet · ' + rq + ' talep' },
                    { l: 'Çözüm oranı', v: '%' + pct(s, rows.length), s: s + ' tamamlandı' },
                    { l: 'Açık', v: w + p, s: w + ' bekliyor · ' + p + ' işlemde' },
                    { l: 'Geciken', v: od, s: od ? OVERDUE_MIN + ' dk’yı aşan açık kayıt' : 'Geciken kayıt yok', tone: od ? 'bad' : '', icon: od ? 'alert' : '' },
                    { l: 'Ort. üstlenme süresi', v: t.ack == null ? '—' : fmtDuration(t.ack), s: t.ackN ? t.ackN + ' kayıtta ölçüldü' : 'Ölçülecek kayıt yok' },
                    { l: 'Ort. çözüm süresi', v: t.sol == null ? '—' : fmtDuration(t.sol), s: t.solN ? t.solN + ' tamamlanan kayıt' : 'Tamamlanan kayıt yok' }
                ];
            },
            trend: { title: 'Kayıt sayısı' },
            breakdowns: [
                { title: 'Departmana göre', facet: 'dept' },
                { title: 'Konuya göre (şikayet)', facet: 'topic', only: r => (r.type || 'complaint') === 'complaint' }
            ]
        },
        reservations: {
            nav: 'Concierge rezervasyonları', group: 'Concierge', icon: 'concierge', module: 'concierge',
            title: 'Concierge rezervasyonları',
            kpis: rows => {
                const sm = Object.fromEntries(D.summary(rows).map(([l, v]) => [l, v]));
                return [
                    { l: 'Rezervasyon', v: rows.length, s: sm['Onaylı'] + ' onaylı · ' + sm['Tamamlandı'] + ' tamamlandı' },
                    { l: 'Bekleyen', v: sm['Bekleyen'], s: 'Onay bekliyor' },
                    { l: 'İptal', v: sm['İptal'], s: '%' + pct(sm['İptal'], rows.length) + ' iptal oranı' },
                    { l: 'Ciro', v: sm['Ciro'], s: 'İptaller hariç' },
                    { l: 'Kapora', v: sm['Kapora'], s: 'Alınan ön ödeme' },
                    { l: 'Kalan bakiye', v: sm['Kalan'], s: 'Tahsil edilecek' }
                ];
            },
            trend: { title: 'Rezervasyon sayısı' },
            breakdowns: [{ title: 'Hizmete göre', facet: 'type' }, { title: 'Duruma göre', facet: 'status' }]
        },
        guestOrders: {
            nav: 'QR siparişleri', group: 'Misafir hizmetleri', icon: 'receipt', module: 'guestOrders',
            title: 'QR siparişleri', kpis: fromSummary,
            trend: { title: 'Sipariş sayısı' },
            breakdowns: [{ title: 'Duruma göre', facet: 'status' }, { title: 'En çok sipariş veren odalar', by: r => r.room ? 'Oda ' + r.room : '—' }]
        },
        orderItems: {
            nav: 'Sipariş edilen ürünler', group: 'Misafir hizmetleri', icon: 'layers', module: 'guestOrders',
            title: 'Sipariş edilen ürünler', kpis: fromSummary,
            trend: { title: 'Ürün adedi', measure: r => r.qty || 0 },
            breakdowns: [{ title: 'En çok istenen ürünler', by: r => r.name || '—', measure: r => r.qty || 0, unit: 'adet' },
                         { title: 'Kategoriye göre', facet: 'category', measure: r => r.qty || 0, unit: 'adet' }]
        },
        serviceRatings: {
            nav: 'Hizmet puanları', group: 'Misafir hizmetleri', icon: 'sparkles', module: 'guestOrders',
            title: 'Hizmet puanları', kpis: rows => fromSummary(rows).map(k => k.l === 'Ortalama'
                ? Object.assign(k, { tone: ratingTint(parseFloat(String(k.v))) === 's' ? 'good' : (ratingTint(parseFloat(String(k.v))) === 'o' ? 'bad' : '') }) : k),
            trend: { title: 'Değerlendirme sayısı' },
            breakdowns: [{ title: 'Puan dağılımı', facet: 'stars', order: ['5', '4', '3', '2', '1'], labelOf: v => v + ' yıldız' },
                         { title: 'Departmana göre', facet: 'department' }]
        },
        guestDirectory: {
            nav: 'Misafir rehberi', group: 'Misafirler', icon: 'users', module: 'crm',
            title: 'Misafir rehberi', kpis: fromSummary,
            trend: { title: 'Girişler (check-in)' },
            breakdowns: [{ title: 'Duruma göre', facet: 'status' }]
        },
        restSales: {
            nav: 'Restoran adisyonları', group: 'Restoran', icon: 'utensils', module: 'restaurant',
            title: 'Restoran adisyonları', kpis: fromSummary,
            trend: { title: 'Ciro', measure: r => r.total || 0, money: true },
            breakdowns: [{ title: 'Ödeme türüne göre (ciro)', facet: 'payment', measure: r => r.total || 0, money: true },
                         { title: 'Garsona göre (ciro)', facet: 'waiter', measure: r => r.total || 0, money: true }]
        },
        restItems: {
            nav: 'Restoran ürün satışları', group: 'Restoran', icon: 'chart', module: 'restaurant',
            title: 'Restoran ürün satışları', kpis: fromSummary,
            trend: { title: 'Ciro', measure: r => r.lineTotal || 0, money: true },
            breakdowns: [{ title: 'En çok satan ürünler', by: r => r.name || '—', measure: r => r.qty || 0, unit: 'adet' },
                         { title: 'Kategoriye göre (ciro)', facet: 'category', measure: r => r.lineTotal || 0, money: true }]
        }
    };
    const domainOn = k => !META[k].module || typeof moduleEnabled !== 'function' || moduleEnabled(META[k].module);
    // Menü sırası gruplara göre (DOMAIN_ORDER veri/geri uyum sırası olarak kalır).
    const NAV_ORDER = ['guestLogs', 'guestOrders', 'orderItems', 'serviceRatings', 'reservations', 'guestDirectory', 'restSales', 'restItems'];

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
    // Hâlihazırda seçili değerler her zaman görünür kalır.
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
    const ic = (n) => (typeof window.UIcon === 'function' ? window.UIcon(n) : '');
    function activeCount() {
        return D.facets.reduce((n, f) => n + (f.kind === 'chips' ? sel[f.key].size : ((sel[f.key] || '').trim() ? 1 : 0)), 0);
    }

    // ── Rapor türleri menüsü ───────────────────────────────────
    function renderNav() {
        const nav = $('repNav');
        let html = '<div class="rep-nav-h">Raporlar</div>', lastGroup = '';
        NAV_ORDER.filter(domainOn).forEach(k => {
            const m = META[k];
            if (m.group !== lastGroup) { html += `<div class="rep-nav-g">${esc(m.group)}</div>`; lastGroup = m.group; }
            html += `<button class="rep-nav-i${k === domainKey ? ' active' : ''}" data-domain="${k}"${k === domainKey ? ' aria-current="page"' : ''}>${ic(m.icon)}<span>${esc(m.nav)}</span></button>`;
        });
        nav.innerHTML = html;
        nav.querySelectorAll('[data-domain]').forEach(b => { b.onclick = () => { if (b.dataset.domain !== domainKey) setDomain(b.dataset.domain); }; });
        const act = nav.querySelector('.rep-nav-i.active');
        if (act && act.scrollIntoView && window.innerWidth <= 960) act.scrollIntoView({ inline: 'center', block: 'nearest' });
    }

    // ── Filtreler çekmecesi ────────────────────────────────────
    function renderFacets() {
        const host = $('repFacets');
        host.innerHTML = D.facets.map(f => {
            if (f.kind === 'chips') {
                const vals = chipValues(f);
                const n = sel[f.key].size;
                const inner = vals.length
                    ? vals.map(v => `<button type="button" data-facet="${esc(f.key)}" data-v="${esc(v)}" aria-pressed="${sel[f.key].has(v)}"${sel[f.key].has(v) ? ' class="active"' : ''}>${esc(v)}</button>`).join('')
                    : '<span class="rep-none">Bu aralıkta veri yok</span>';
                return `<div class="rep-f"><div class="rep-l">${esc(f.label)}${n ? `<small>${n} seçili</small>` : ''}</div><div class="rep-chips">${inner}</div></div>`;
            }
            return `<div class="rep-f"><label class="rep-l" for="rf-${esc(f.key)}">${esc(f.label)}</label><input type="text" class="rep-in" id="rf-${esc(f.key)}" data-facet="${esc(f.key)}" value="${esc(sel[f.key] || '')}" placeholder="${esc(f.label)} ara"></div>`;
        }).join('');
        host.querySelectorAll('button[data-facet]').forEach(b => {
            b.onclick = () => {
                const s2 = sel[b.getAttribute('data-facet')], v = b.getAttribute('data-v');
                if (s2.has(v)) s2.delete(v); else s2.add(v);
                refresh(); // diğer filtrelerin "veri olan" seçenekleri güncellensin
            };
        });
        host.querySelectorAll('input[data-facet]').forEach(inp => {
            inp.oninput = () => { sel[inp.getAttribute('data-facet')] = inp.value; render(); };
        });
        // Gruplama seçenekleri — eskiden "Departmane göre", "Durume göre" gibi
        // hatalı Türkçe ek üretiliyordu; artık yalnızca alan adı (etiket "Gruplama").
        const gb = $('repGroupBy');
        const opts = ['<option value="none">Yok</option>']
            .concat(D.facets.filter(f => f.kind === 'chips').map(f => `<option value="${esc(f.key)}">${esc(f.label)}</option>`))
            .concat(['<option value="__date__">Gün</option>', '<option value="__week__">Hafta</option>',
                     '<option value="__month__">Ay</option>', '<option value="__year__">Yıl</option>']);
        gb.innerHTML = opts.join('');
        gb.value = groupBy;
        const n = activeCount();
        $('repFilterCount').textContent = n; $('repFilterCount').hidden = !n;
    }
    function openDrawer(id) {
        $('repScrim').hidden = false; $(id).hidden = false;
        const first = $(id).querySelector('button, input'); if (first) setTimeout(() => first.focus(), 30);
    }
    function closeDrawers() { ['repDrawer', 'repDetail'].forEach(id => { $(id).hidden = true; }); $('repScrim').hidden = true; }

    // Uygulanan filtreler — ana alanda görünür ve tek tıkla kaldırılabilir
    // (eskiden yalnızca uzun yan paneli tarayarak anlaşılabiliyordu).
    function renderActive() {
        const host = $('repActive');
        const chips = [];
        D.facets.forEach(f => {
            if (f.kind === 'chips') sel[f.key].forEach(v => chips.push({ k: f.key, v, t: f.label, kind: 'chips' }));
            else if ((sel[f.key] || '').trim()) chips.push({ k: f.key, v: sel[f.key].trim(), t: f.label, kind: 'text' });
        });
        host.hidden = !chips.length;
        if (!chips.length) { host.innerHTML = ''; return; }
        host.innerHTML = chips.map((c, i) => `<span class="rep-chip">${esc(c.t)}: <b>${esc(c.v)}</b><button type="button" data-rm="${i}" aria-label="${esc(c.t + ' filtresini kaldır')}">${ic('x')}</button></span>`).join('')
            + '<button type="button" class="rep-clear" id="repClearAll">Tümünü temizle</button>';
        host.querySelectorAll('[data-rm]').forEach(b => {
            b.onclick = () => {
                const c = chips[+b.dataset.rm];
                if (c.kind === 'chips') sel[c.k].delete(c.v); else sel[c.k] = '';
                refresh();
            };
        });
        $('repClearAll').onclick = () => { D.facets.forEach(f => { sel[f.key] = (f.kind === 'chips') ? new Set() : ''; }); refresh(); };
    }

    // Facet seçenekleri + içerik birlikte tazelensin (kademeli filtre).
    function refresh() { renderFacets(); render(); }

    // ── Özet kartları ──────────────────────────────────────────
    function renderKpis(rows) {
        const m = META[domainKey];
        const list = m.kpis ? m.kpis(rows) : fromSummary(rows);
        // Çok para birimli değerler ("₺1.060 · €3.300") kırpılmasın: uzun değer
        // daha küçük puntoda ve satır kırarak gösterilir.
        $('repStats').innerHTML = list.map(k =>
            `<div class="rep-kpi${k.tone ? ' ' + k.tone : ''}${String(k.v).length > 11 ? ' long' : ''}"><span class="l">${k.icon ? ic(k.icon) : ''}${esc(k.l)}</span><span class="v" title="${esc(k.v)}">${esc(k.v)}</span>${k.s ? `<span class="s" title="${esc(k.s)}">${esc(k.s)}</span>` : ''}</div>`).join('');
    }

    // ── Trend (zaman serisi) ───────────────────────────────────
    // Kova: aralık ≤ 45 gün → gün, ≤ 26 hafta → hafta, üstü → ay. Boş günler
    // sıfır olarak doldurulur (eksen kesintisiz). Tek seri, tek renk.
    const MON = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    function addDays(s, n) { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); }
    function trendSeries(rows) {
        const tr = META[domainKey].trend || {};
        const measure = tr.measure || (() => 1);
        const dates = rows.map(r => D.dateOf(r)).filter(Boolean).sort();
        const w = dateWindow();
        let from = w.from || dates[0], to = w.to || dates[dates.length - 1];
        if (!from || !to) return null;
        if (to > todayStr() && !w.to) to = todayStr();
        const spanDays = Math.round((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 86400000) + 1;
        const unit = spanDays <= 45 ? 'day' : (spanDays <= 26 * 7 ? 'week' : 'month');
        const keyOf = unit === 'day' ? (d => d) : (unit === 'week' ? isoWeekKey : monthKey);
        const keys = [];
        if (unit === 'day') { for (let d = from; d <= to && keys.length < 400; d = addDays(d, 1)) keys.push(d); }
        else if (unit === 'week') { for (let d = from; d <= to && keys.length < 60; d = addDays(d, 7)) { const k = isoWeekKey(d); if (keys.indexOf(k) === -1) keys.push(k); } const lk = isoWeekKey(to); if (keys.indexOf(lk) === -1) keys.push(lk); }
        else { let y = +from.slice(0, 4), mo = +from.slice(5, 7); const ey = +to.slice(0, 4), em = +to.slice(5, 7); while ((y < ey || (y === ey && mo <= em)) && keys.length < 120) { keys.push(y + '-' + pad(mo)); mo++; if (mo > 12) { mo = 1; y++; } } }
        const val = new Map(keys.map(k => [k, 0]));
        rows.forEach(r => { const d = D.dateOf(r); if (!d) return; const k = keyOf(d); if (val.has(k)) val.set(k, val.get(k) + (Number(measure(r)) || 0)); });
        const label = k => {
            if (unit === 'day') { const p = k.split('-'); return (+p[2]) + ' ' + MON[+p[1] - 1]; }
            if (unit === 'week') return k.replace(/^(\d{4})-W(\d+)$/, (m0, yy, ww) => (+ww) + '. hafta');
            const p = k.split('-'); return MON[+p[1] - 1] + ' ' + p[0];
        };
        return { unit, points: keys.map(k => ({ k, label: label(k), v: val.get(k) })), money: !!tr.money, title: tr.title || 'Kayıt' };
    }
    function niceMax(v) {
        if (v <= 0) return 1;
        const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
        return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
    }
    const fmtNum = (v, isMoney) => isMoney ? money(Math.round(v)) : (Number.isInteger(v) ? v.toLocaleString('tr-TR') : v.toLocaleString('tr-TR', { maximumFractionDigits: 1 }));
    const compact = v => v >= 10000 ? (v / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 0 }) + 'B' : v.toLocaleString('tr-TR');
    function trendSvg(ser, width) {
        const H = 190, padL = 34, padB = 22, padT = 10, padR = 4;
        const n = ser.points.length, max = niceMax(Math.max(...ser.points.map(p => p.v)));
        const plotW = Math.max(40, width - padL - padR), plotH = H - padB - padT;
        const slot = plotW / n, bw = Math.max(2, Math.min(24, slot - 2));
        const y = v => padT + plotH - (v / max) * plotH;
        let g = '';
        // Sayımlarda kesirli ara değer ("2,5 kayıt") gösterilmez.
        const ticks = (ser.money || Number.isInteger(max / 2)) ? [0, max / 2, max] : [0, max];
        ticks.forEach(t => {
            g += `<line class="grid" x1="${padL}" x2="${width - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`;
            g += `<text class="tick" x="${padL - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(compact(t))}</text>`;
        });
        const step = Math.max(1, Math.ceil(n / 6));
        ser.points.forEach((p, i) => {
            const x = padL + i * slot + (slot - bw) / 2, top = y(p.v), h = padT + plotH - top;
            const r = Math.min(4, bw / 2, h);
            const bar = h <= 0 ? '' : `<path class="col" d="M${x.toFixed(1)},${(padT + plotH).toFixed(1)}V${(top + r).toFixed(1)}q0,-${r} ${r},-${r}h${(bw - 2 * r).toFixed(1)}q${r},0 ${r},${r}V${(padT + plotH).toFixed(1)}Z"/>`;
            g += `<rect class="hit" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" tabindex="0" data-i="${i}" aria-label="${esc(p.label + ': ' + fmtNum(p.v, ser.money))}"/>` + bar;
            if (i % step === 0 || i === n - 1) {
                if (i === n - 1 && i % step !== 0 && (n - 1) % step < step / 2) return; // son etiket çakışmasın
                g += `<text class="tick" x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>`;
            }
        });
        return `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="${esc(ser.title)}">${g}</svg>`;
    }
    function bindTip(root, items, fmt) {
        const tip = $('repTip');
        const show = (el, x, yy) => {
            const p = items[+el.dataset.i]; if (!p) return;
            tip.innerHTML = ''; const b = document.createElement('b'); b.textContent = fmt(p); const sp = document.createElement('span'); sp.textContent = p.label;
            tip.appendChild(b); tip.appendChild(sp); tip.hidden = false;
            const r = tip.getBoundingClientRect();
            tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + 'px';
            tip.style.top = Math.max(8, yy - r.height - 12) + 'px';
        };
        root.querySelectorAll('[data-i]').forEach(el => {
            el.addEventListener('pointermove', e => show(el, e.clientX, e.clientY));
            el.addEventListener('focus', () => { const b = el.getBoundingClientRect(); show(el, b.left + b.width / 2, b.top + 20); });
            el.addEventListener('pointerleave', () => { tip.hidden = true; });
            el.addEventListener('blur', () => { tip.hidden = true; });
        });
    }

    // ── Dağılım: sıralı yatay çubuklar ─────────────────────────
    function breakdownData(rows, bd) {
        const f = bd.facet ? D.facets.find(x => x.key === bd.facet) : null;
        const keyOf = bd.by || (f ? f.valueOf : null); if (!keyOf) return [];
        const measure = bd.measure || (() => 1);
        const map = new Map();
        rows.forEach(r => {
            if (bd.only && !bd.only(r)) return;
            const k = keyOf(r); if (!k || k === '—') return;
            map.set(k, (map.get(k) || 0) + (Number(measure(r)) || 0));
        });
        let arr = [...map.entries()].map(([k, v]) => ({ k, v }));
        if (bd.order) arr.sort((a, b) => bd.order.indexOf(a.k) - bd.order.indexOf(b.k));
        else arr.sort((a, b) => b.v - a.v || String(a.k).localeCompare(String(b.k), 'tr'));
        const TOP = 6;
        if (!bd.order && arr.length > TOP + 1) {
            const rest = arr.slice(TOP).reduce((s2, x) => s2 + x.v, 0);
            arr = arr.slice(0, TOP).concat([{ k: 'Diğer', v: rest, other: true }]);
        }
        return arr;
    }
    function breakdownHtml(bd, data) {
        if (!data.length) return '<div class="rep-nodata">Bu aralıkta veri yok</div>';
        const total = data.reduce((s2, x) => s2 + x.v, 0), max = Math.max(...data.map(x => x.v)) || 1;
        const f = bd.facet ? D.facets.find(x => x.key === bd.facet) : null;
        const clickable = !!(f && f.kind === 'chips');
        return '<ul class="rep-bars">' + data.map(x => {
            const on = clickable && !x.other && sel[f.key].has(x.k);
            const name = bd.labelOf ? bd.labelOf(x.k) : x.k;
            const val = (bd.money ? money(Math.round(x.v)) : fmtNum(x.v)) + (bd.unit ? ' ' + bd.unit : '');
            const attrs = clickable && !x.other ? ` class="click${on ? ' on' : ''}" tabindex="0" role="button" aria-pressed="${on}" data-bf="${esc(f.key)}" data-bv="${esc(x.k)}" title="${esc(name)} — filtrele"` : '';
            return `<li${attrs}><span class="n">${esc(name)}</span><span class="v">${esc(val)}<small>%${pct(x.v, total)}</small></span><span class="t"><i style="width:${Math.max(1, x.v / max * 100).toFixed(1)}%"></i></span></li>`;
        }).join('') + '</ul>';
    }
    function renderInsights(rows) {
        const host = $('repInsights'), m = META[domainKey];
        if (!rows.length) { host.innerHTML = ''; return; }
        const ser = trendSeries(rows);
        let html = '';
        if (ser && ser.points.length > 1) {
            const unitTxt = { day: 'günlük', week: 'haftalık', month: 'aylık' }[ser.unit];
            const total = ser.points.reduce((s2, p) => s2 + p.v, 0);
            html += `<section class="rep-card rep-trend"><div class="rep-card-h"><h2>${esc(ser.title)} <span>· ${unitTxt}</span></h2></div>`
                + `<div class="rep-card-sub">Toplam ${esc(fmtNum(total, ser.money))} · en yüksek ${esc(fmtNum(Math.max(...ser.points.map(p => p.v)), ser.money))}</div>`
                + `<div class="rep-card-b" id="repTrendBox"></div></section>`;
        }
        (m.breakdowns || []).forEach((bd, i) => {
            html += `<section class="rep-card"><div class="rep-card-h"><h2>${esc(bd.title)}</h2></div><div class="rep-card-b">${breakdownHtml(bd, breakdownData(rows, bd))}</div></section>`;
        });
        host.innerHTML = html;
        const box = $('repTrendBox');
        if (box && ser) {
            box.innerHTML = trendSvg(ser, Math.max(260, Math.floor(box.clientWidth)));
            bindTip(box, ser.points, p => fmtNum(p.v, ser.money) + (ser.money ? '' : ' ' + ser.title.toLocaleLowerCase('tr-TR')));
        }
        host.querySelectorAll('[data-bf]').forEach(li => {
            const act = () => { const s2 = sel[li.dataset.bf]; if (s2.has(li.dataset.bv)) s2.delete(li.dataset.bv); else s2.add(li.dataset.bv); refresh(); };
            li.onclick = act;
            li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } };
        });
    }

    // ── Tablo + sütun seçimi + satır ayrıntısı ─────────────────
    const COLS_KEY = k => 'rep_cols_' + TENANT_ID + '_' + k;
    function hiddenCols() { try { return new Set(JSON.parse(localStorage.getItem(COLS_KEY(domainKey)) || '[]')); } catch (e) { return new Set(); } }
    function visibleCols() { const h = hiddenCols(); const v = D.columns.filter(c => !h.has(c.label)); return v.length ? v : D.columns; }
    function renderColsPop() {
        const h = hiddenCols();
        $('repColsPop').innerHTML = D.columns.map((c, i) => `<label><input type="checkbox" data-col="${i}"${h.has(c.label) ? '' : ' checked'}>${esc(c.label)}</label>`).join('')
            + '<p>Excel ve yazdırma tüm sütunları içerir.</p>';
        $('repColsPop').querySelectorAll('[data-col]').forEach(cb => {
            cb.onchange = () => {
                const set = hiddenCols(), lbl = D.columns[+cb.dataset.col].label;
                if (cb.checked) set.delete(lbl); else set.add(lbl);
                if (set.size >= D.columns.length) { set.delete(lbl); cb.checked = true; }
                try { localStorage.setItem(COLS_KEY(domainKey), JSON.stringify([...set])); } catch (e) {}
                render();
            };
        });
    }
    let rowRefs = [];
    function cellHtml(c, r) {
        const val = c.get(r);
        if (c.tone) return `<td><span class="rep-pill ${esc(c.tone(r))}">${esc(c.pillText ? c.pillText(r) : val)}</span></td>`;
        return `<td class="${c.wide ? 'rep-w' : ''}${c.c ? ' rep-c' : ''}" title="${esc(val)}">${esc(val)}</td>`;
    }
    function renderTable(rows) {
        const cols = visibleCols();
        const groups = grouped(rows);
        const MAX = 400; let shown = 0, truncated = false, html = '';
        rowRefs = [];
        $('repRowCount').textContent = '· ' + rows.length.toLocaleString('tr-TR');
        if (!rows.length) {
            html = `<div class="rep-empty">Seçili tarih ve filtrelerle kayıt bulunamadı.<br>Tarih aralığını genişletmeyi ya da filtreleri temizlemeyi deneyin.</div>`;
        } else {
            html = `<table class="rep-table"><thead><tr>${cols.map(c => `<th${c.c ? ' class="rep-c"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
            for (const g of groups) {
                if (g.key !== '') html += `<tr class="rep-grp"><td colspan="${cols.length}">${esc(g.label)} <span>${esc(D.groupAgg ? D.groupAgg(g.rows) : g.rows.length + ' kayıt')}</span></td></tr>`;
                for (const r of g.rows) {
                    if (shown >= MAX) { truncated = true; break; }
                    html += `<tr class="row" tabindex="0" data-row="${rowRefs.length}">` + cols.map(c => cellHtml(c, r)).join('') + '</tr>';
                    rowRefs.push(r); shown++;
                }
                if (truncated) break;
            }
            html += '</tbody></table>';
            if (truncated) html += `<div class="rep-more">Önizlemede ilk ${MAX} kayıt gösteriliyor · Excel ve yazdırma tüm ${rows.length.toLocaleString('tr-TR')} kaydı içerir.</div>`;
        }
        const box = $('repTableScroll');
        box.innerHTML = html;
        box.querySelectorAll('tr[data-row]').forEach(tr => {
            const open = () => openDetail(rowRefs[+tr.dataset.row]);
            tr.onclick = open;
            tr.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); open(); } };
        });
    }
    // Satır ayrıntısı: tablodaki kırpılmış metinlerin (açıklama, çözüm, not)
    // tamamı ve gizli sütunlar dahil tüm alanlar.
    function openDetail(r) {
        if (!r) return;
        const body = $('repDetailBody');
        body.innerHTML = '<dl>' + D.columns.map(c => `<div class="dr"><dt>${esc(c.label)}</dt><dd>${esc(c.get(r) || '—')}</dd></div>`).join('') + '</dl>';
        $('repDetailTitle').textContent = META[domainKey].title;
        openDrawer('repDetail');
    }

    // ── Render ─────────────────────────────────────────────────
    function render() {
        const rows = filtered();
        $('repTitle').textContent = META[domainKey].title;
        const gOpt = $('repGroupBy').selectedOptions[0];
        $('repRangeLabel').textContent = rangeLabel() + ' · ' + rows.length.toLocaleString('tr-TR') + ' kayıt'
            + (groupBy !== 'none' && gOpt ? ' · Gruplama: ' + gOpt.textContent : '');
        $('repScroll').classList.toggle('is-loading', !ready);
        renderKpis(rows);
        renderInsights(rows);
        renderActive();
        renderTable(rows);
        const n = activeCount();
        $('repFilterCount').textContent = n; $('repFilterCount').hidden = !n;
        $('repDrawerApply').textContent = 'Sonuçları göster (' + rows.length.toLocaleString('tr-TR') + ')';
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

    function syncDateUI() {
        $('repDateSeg').querySelectorAll('[data-preset]').forEach(b => {
            const on = b.dataset.preset === preset;
            b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        $('repCustomDates').hidden = preset !== 'custom';
    }
    function setDomain(key) {
        if (!DOMAINS[key] || !domainOn(key)) return;
        domainKey = key; D = DOMAINS[key];
        resetFilters();
        syncDateUI();
        $('repFrom').value = ''; $('repTo').value = '';
        records = cache[key] || [];
        try { history.replaceState(null, '', '#' + key); } catch (e) {}
        renderNav(); renderColsPop(); renderFacets(); render();
        subscribe();
    }

    // ── Wire ───────────────────────────────────────────────────
    function wire() {
        // Tarih aralığı değişince, sunucu sınırlaması olan raporlarda sorguyu
        // yeni aralıkla yeniden kur (snapshot render eder); diğerlerinde istemci
        // tarafında yeniden filtrele.
        const applyDateChange = () => { if (D.tsBound) { renderFacets(); render(); subscribe(); } else { refresh(); } };
        $('repDateSeg').querySelectorAll('[data-preset]').forEach(b => {
            b.onclick = () => { preset = b.dataset.preset; syncDateUI(); if (preset === 'custom') { $('repFrom').focus(); return; } applyDateChange(); };
        });
        $('repFrom').onchange = e => { cFrom = e.target.value; applyDateChange(); };
        $('repTo').onchange = e => { cTo = e.target.value; applyDateChange(); };
        $('repGroupBy').onchange = e => { groupBy = e.target.value; render(); };
        $('repReset').onclick = () => { setDomain(domainKey); };
        $('repExcel').onclick = exportExcel;
        $('repPrint').onclick = printReport;
        $('repFiltersBtn').onclick = () => openDrawer('repDrawer');
        $('repDrawerClose').onclick = closeDrawers;
        $('repDrawerApply').onclick = closeDrawers;
        $('repDetailClose').onclick = closeDrawers;
        $('repScrim').onclick = closeDrawers;
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawers(); $('repColsPop').hidden = true; } });
        $('repColsBtn').onclick = e => { e.stopPropagation(); $('repColsPop').hidden = !$('repColsPop').hidden; };
        document.addEventListener('click', e => { if (!e.target.closest('.rep-cols')) $('repColsPop').hidden = true; });
        // Trend grafiği kapsayıcı genişliğine göre çizilir — boyut değişince yeniden.
        let rt = null;
        window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (ready) renderInsights(filtered()); }, 150); });
    }

    function start() {
        wire();
        if (window.IssueConfig) {
            IssueConfig.load().then(() => { if (domainKey === 'guestLogs') renderFacets(); });
            IssueConfig.listen(() => { if (domainKey === 'guestLogs' && ready) renderFacets(); });
            IssueConfig.listenTopics(() => { if (domainKey === 'guestLogs' && ready) renderFacets(); });
        }
        // İlk rapor: adres çubuğundaki #rapor ya da erişilebilen ilk rapor
        // (ör. yalnızca restoran modülü olan F&B girişinde restoran raporları).
        const want = (location.hash || '').replace('#', '');
        const first = NAV_ORDER.filter(domainOn);
        if (!first.length) {
            $('repTitle').textContent = 'Raporlar';
            $('repScroll').innerHTML = '<div class="rep-empty">Hesabınız için görüntülenebilecek rapor yok.</div>';
            return;
        }
        setDomain(first.indexOf(want) !== -1 ? want : first[0]);
    }
    function boot() {
        if (typeof auth !== 'undefined' && auth.onAuthStateChanged) auth.onAuthStateChanged(u => { if (u) start(); });
        else start();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
