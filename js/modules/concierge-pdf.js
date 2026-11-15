/* concierge-pdf.js — Concierge belgeleri (vektörel PDF)
 *
 * Misafir programı (konaklayan / varış öncesi), rezervasyon onay mektubu ve
 * tablo raporları TEK, sade ve kurumsal bir tasarım dilinde üretilir:
 * otel adı (wordmark) + iletişim satırı, ince çizgiler, tek vurgu rengi,
 * sayfa altında otel bilgisi ve sayfa numarası.
 *
 *  · Çıktı vektöreldir (jsPDF): metin seçilebilir, baskıda keskin, dosya
 *    küçük. Önceki html2pdf çıktısı sayfanın JPEG fotoğrafıydı.
 *  · Türkçe karakterler için Roboto gömülür (tembel yüklenir). Yüklenemezse
 *    yerleşik Helvetica + ASCII sadeleştirme ile belge yine üretilir.
 *  · Platform logosu basılmaz — belge otelin kendi adıyla çıkar.
 *  · Misafire giden belgeler İngilizce ya da Türkçe (lang: 'en' | 'tr').
 *  · Personel notları (r.notes) misafir belgelerine ASLA yazılmaz.
 */
(function (global) {
    'use strict';

    var LIBS = [
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js'
    ];
    // Roboto (Regular/Medium) — pdfmake'in yazı tipi paketi; window.pdfMake.vfs.
    var FONT_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.min.js';

    // ── Tasarım belirteçleri ─────────────────────────────────
    var C = {
        ink: [23, 30, 43],        // başlıklar, değerler
        text: [55, 63, 77],       // gövde metni
        muted: [110, 117, 130],   // ikincil
        faint: [150, 156, 168],   // alt bilgi
        line: [221, 225, 231],    // ince çizgi
        soft: [246, 247, 249],    // zemin
        accent: [31, 58, 96],     // tek vurgu (lacivert)
        warn: [150, 98, 16],
        bad: [160, 46, 46],
        ok: [32, 110, 72]
    };
    var M = 18;                   // kenar boşluğu (mm)

    // ── Metinler ─────────────────────────────────────────────
    var L = {
        en: {
            locale: 'en-GB',
            itinerary: 'Guest Itinerary', preItinerary: 'Pre-Arrival Itinerary',
            lblItinerary: 'GUEST ITINERARY', lblPre: 'PRE-ARRIVAL ITINERARY',
            guest: 'Guest', room: 'Room', stay: 'Stay', issued: 'Issued', reference: 'Reference',
            roomPre: 'To be assigned',
            dear: function (n) { return 'Dear ' + n + ','; },
            introIn: 'Please find below the arrangements we have made for you during your stay. Should you wish to change anything, our concierge team will be pleased to assist.',
            introPre: 'We look forward to welcoming you. Below are the arrangements we have prepared ahead of your arrival. Should you wish to change anything, simply let us know.',
            closingIn: 'We wish you a wonderful stay.',
            closingPre: 'We look forward to welcoming you soon.',
            sign: 'Concierge Desk', regards: 'Kind regards,',
            anyTime: 'During the day', toConfirm: 'To be confirmed', confNo: 'Conf. no.',
            cont: 'continued',
            page: function (i, n) { return 'Page ' + i + ' of ' + n; },
            svc: { Restaurant: 'Restaurant', Beach: 'Beach', Transfer: 'Transfer', Flower: 'Flowers', Cake: 'Cake', Boat: 'Boat Trip', Tour: 'Tour', Other: 'Service' },
            pax: function (n) { return n + (String(n) === '1' ? ' guest' : ' guests'); },
            f: { service: 'Service', date: 'Date', time: 'Time', venue: 'Venue', guests: 'Guests', from: 'From', to: 'To', vehicle: 'Vehicle / flight', vessel: 'Vessel', tour: 'Tour', provider: 'Provider', arrangement: 'Arrangement', confNo: 'Confirmation no.', status: 'Status' },
            vehicle: 'Vehicle / flight', provider: 'Provider',
            st: { Confirmed: 'Confirmed', Pending: 'Awaiting confirmation', Done: 'Completed', Cancelled: 'Cancelled' },
            conf: {
                Confirmed: ['RESERVATION CONFIRMATION', 'Reservation Confirmed', 'We are pleased to confirm the following arrangement on your behalf.'],
                Done: ['RESERVATION CONFIRMATION', 'Reservation Confirmed', 'We are pleased to confirm the following arrangement on your behalf.'],
                Pending: ['RESERVATION REQUEST', 'Reservation Request', 'Thank you for your request. We are arranging the following and will confirm it with you shortly.'],
                Cancelled: ['CANCELLATION NOTICE', 'Reservation Cancelled', 'Please note that the following arrangement has been cancelled.']
            },
            contact: function (p) { return 'Should you wish to make any changes, please contact the concierge desk' + (p ? ' on ' + p : '') + '.'; }
        },
        tr: {
            locale: 'tr-TR',
            itinerary: 'Misafir Programı', preItinerary: 'Varış Öncesi Program',
            lblItinerary: 'MİSAFİR PROGRAMI', lblPre: 'VARIŞ ÖNCESİ PROGRAM',
            guest: 'Misafir', room: 'Oda', stay: 'Konaklama', issued: 'Düzenlenme', reference: 'Referans',
            roomPre: 'Atanacak',
            dear: function (n) { return 'Sayın ' + n + ','; },
            introIn: 'Konaklamanız süresince sizin için yaptığımız düzenlemeleri aşağıda bulabilirsiniz. Herhangi bir değişiklik isterseniz concierge ekibimiz memnuniyetle yardımcı olacaktır.',
            introPre: 'Sizi ağırlamayı sabırsızlıkla bekliyoruz. Varışınızdan önce sizin için hazırladığımız düzenlemeler aşağıdadır. Değişiklik isterseniz bize bildirmeniz yeterli.',
            closingIn: 'Keyifli bir konaklama dileriz.',
            closingPre: 'Sizi yakında ağırlamayı dört gözle bekliyoruz.',
            sign: 'Concierge Ekibi', regards: 'Saygılarımızla,',
            anyTime: 'Gün içinde', toConfirm: 'Onay bekleniyor', confNo: 'Onay no.',
            cont: 'devamı',
            page: function (i, n) { return 'Sayfa ' + i + ' / ' + n; },
            svc: { Restaurant: 'Restoran', Beach: 'Plaj', Transfer: 'Transfer', Flower: 'Çiçek', Cake: 'Pasta', Boat: 'Tekne Turu', Tour: 'Tur', Other: 'Hizmet' },
            pax: function (n) { return n + ' kişi'; },
            f: { service: 'Hizmet', date: 'Tarih', time: 'Saat', venue: 'Mekân', guests: 'Kişi sayısı', from: 'Nereden', to: 'Nereye', vehicle: 'Araç / uçuş', vessel: 'Tekne', tour: 'Tur', provider: 'Sağlayıcı', arrangement: 'Düzenleme', confNo: 'Onay no.', status: 'Durum' },
            vehicle: 'Araç / uçuş', provider: 'Sağlayıcı',
            st: { Confirmed: 'Onaylandı', Pending: 'Onay bekleniyor', Done: 'Tamamlandı', Cancelled: 'İptal edildi' },
            conf: {
                Confirmed: ['REZERVASYON ONAYI', 'Rezervasyonunuz Onaylandı', 'Sizin adınıza yapılan aşağıdaki düzenlemeyi onaylamaktan memnuniyet duyarız.'],
                Done: ['REZERVASYON ONAYI', 'Rezervasyonunuz Onaylandı', 'Sizin adınıza yapılan aşağıdaki düzenlemeyi onaylamaktan memnuniyet duyarız.'],
                Pending: ['REZERVASYON TALEBİ', 'Talebiniz Alındı', 'Talebiniz için teşekkür ederiz. Aşağıdaki düzenleme için çalışıyoruz; en kısa sürede onaylayacağız.'],
                Cancelled: ['İPTAL BİLDİRİMİ', 'Rezervasyonunuz İptal Edildi', 'Aşağıdaki düzenlemenin iptal edildiğini bilgilerinize sunarız.']
            },
            contact: function (p) { return 'Değişiklik için lütfen concierge masamızla iletişime geçin' + (p ? ' (' + p + ')' : '') + '.'; }
        }
    };

    // ── Kütüphane + yazı tipi ────────────────────────────────
    var fontOk = false;
    function libError() { var e = new Error('PDF kütüphanesi yüklenemedi.'); e.code = 'lib'; return e; }
    async function ensureLibs() {
        try { if (typeof global.loadScriptsOnce === 'function') await global.loadScriptsOnce(LIBS); } catch (e) { /* aşağıda denetlenir */ }
        if (!global.jspdf || !global.jspdf.jsPDF) throw libError();
        if (!fontOk) {
            try { if (typeof global.loadScriptOnce === 'function') await global.loadScriptOnce(FONT_LIB); } catch (e) { /* Helvetica'ya düşülür */ }
            var v = global.pdfMake && global.pdfMake.vfs;
            fontOk = !!(v && v['Roboto-Regular.ttf'] && v['Roboto-Medium.ttf']);
        }
    }
    function hasTable(doc) { return typeof doc.autoTable === 'function'; }

    // Yazı tipinde olmayan işaretler sadeleştirilir; Roboto yoksa Türkçe
    // harfler ve para simgeleri de ASCII'ye indirgenir (Helvetica'da yoklar).
    var FOLD = { 'ı': 'i', 'İ': 'I', 'ğ': 'g', 'Ğ': 'G', 'ü': 'u', 'Ü': 'U', 'ş': 's', 'Ş': 'S', 'ö': 'o', 'Ö': 'O', 'ç': 'c', 'Ç': 'C', 'â': 'a', 'Â': 'A', 'î': 'i', 'û': 'u' };
    function T(s) {
        s = String(s == null ? '' : s).replace(/[→➔➜➡]/g, '–').replace(/[✓✔]/g, '');
        if (fontOk) return s;
        return s.replace(/[ıİğĞüÜşŞöÖçÇâÂîû]/g, function (c) { return FOLD[c]; })
            .replace(/₺/g, 'TL ').replace(/€/g, 'EUR ').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[·•]/g, '-')
            .replace(/[^\x20-\x7E]/g, '');
    }
    function up(s, lang) { return String(s || '').toLocaleUpperCase(lang === 'tr' ? 'tr-TR' : 'en-GB'); }
    // Otel adı belge dilinden bağımsızdır: "Villa Mare" Türkçe kuralla
    // "VİLLA" olmasın; adda Türkçe harf varsa Türkçe kural uygulanır.
    function upName(s) { return up(s, /[ğşıçöüĞŞİÇÖÜ]/.test(String(s || '')) ? 'tr' : 'en'); }

    function newDoc(opts) {
        var doc = new global.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: opts.orientation || 'portrait', compress: true });
        if (fontOk) {
            var v = global.pdfMake.vfs;
            doc.addFileToVFS('Roboto-Regular.ttf', v['Roboto-Regular.ttf']); doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
            doc.addFileToVFS('Roboto-Medium.ttf', v['Roboto-Medium.ttf']); doc.addFont('Roboto-Medium.ttf', 'Roboto', 'bold');
        }
        doc.setProperties({ title: T(opts.title || ''), subject: T(opts.subject || ''), author: T(opts.author || ''), creator: 'Concierge' });
        doc.setLineHeightFactor(1.4);
        return doc;
    }
    function font(doc, style, size, color) {
        doc.setFont(fontOk ? 'Roboto' : 'helvetica', style === 'bold' ? 'bold' : 'normal');
        doc.setFontSize(size);
        if (color) doc.setTextColor(color[0], color[1], color[2]);
    }
    // Harf aralıklı metnin genişliği (jsPDF align:'right' charSpace'i saymaz).
    function width(doc, s, cs) { s = T(s); return doc.getTextWidth(s) + (cs ? cs * Math.max(0, s.length - 1) : 0); }
    function text(doc, s, x, y, o) {
        o = o || {};
        s = T(s);
        if (o.align === 'right') x -= width(doc, s, o.cs);
        doc.text(s, x, y, o.cs ? { charSpace: o.cs } : undefined);
    }
    function hline(doc, x1, x2, y, color, w) {
        doc.setDrawColor(color[0], color[1], color[2]); doc.setLineWidth(w || 0.2); doc.line(x1, y, x2, y);
    }
    function wrap(doc, s, w) { return doc.splitTextToSize(T(s), w); }

    // ── Ortak sayfa başlığı / alt bilgi ──────────────────────
    function contactLine(h) { return [h.address, h.phone].filter(Boolean).join('   ·   '); }
    // Tam başlık (ilk sayfa): otel adı + iletişim · sağda belge türü + tarih.
    function header(doc, ctx) {
        var W = doc.internal.pageSize.getWidth();
        var name = ctx.hotel.name || 'Concierge';
        font(doc, 'bold', 12.5, C.ink);
        text(doc, fit(doc, upName(name), W - 2 * M - 70, 0.9), M, 21, { cs: 0.9 });
        var cl = contactLine(ctx.hotel);
        if (cl) { font(doc, 'normal', 7.6, C.muted); text(doc, fit(doc, cl, W - 2 * M - 70), M, 26.2); }
        font(doc, 'bold', 6.8, C.accent);
        text(doc, ctx.label, W - M, 21, { align: 'right', cs: 0.7 });
        if (ctx.labelSub) { font(doc, 'normal', 7.6, C.muted); text(doc, ctx.labelSub, W - M, 26.2, { align: 'right' }); }
        hline(doc, M, W - M, 31, C.ink, 0.35);
        return 43;
    }
    // Devam sayfaları: tek satırlık sade başlık.
    function miniHeader(doc, ctx) {
        var W = doc.internal.pageSize.getWidth();
        font(doc, 'bold', 8.6, C.ink);
        text(doc, fit(doc, upName(ctx.hotel.name || 'Concierge'), W / 2, 0.6), M, 16, { cs: 0.6 });
        font(doc, 'normal', 7.4, C.muted);
        text(doc, ctx.miniRight || ctx.label, W - M, 16, { align: 'right' });
        hline(doc, M, W - M, 19.5, C.line, 0.25);
        return 28;
    }
    function footers(doc, ctx) {
        var n = doc.internal.getNumberOfPages();
        var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
        var left = ctx.footLeft != null ? ctx.footLeft : [ctx.hotel.name, contactLine(ctx.hotel)].filter(Boolean).join('   ·   ');
        for (var i = 1; i <= n; i++) {
            doc.setPage(i);
            hline(doc, M, W - M, H - 15, C.line, 0.2);
            font(doc, 'normal', 7, C.faint);
            if (left) text(doc, fit(doc, left, W - 2 * M - 30), M, H - 10.5);
            text(doc, L[ctx.lang] ? L[ctx.lang].page(i, n) : ('Sayfa ' + i + ' / ' + n), W - M, H - 10.5, { align: 'right' });
        }
    }
    // Sığmayan tek satırlık metni "…" ile kısaltır.
    function fit(doc, s, w, cs) {
        s = T(s);
        if (width(doc, s, cs) <= w) return s;
        var ell = fontOk ? '…' : '...';
        while (s.length > 1 && width(doc, s + ell, cs) > w) s = s.slice(0, -1);
        return s.replace(/\s+$/, '') + ell;
    }
    // Etiket + değer sütunları (misafir · oda · konaklama · tarih).
    function metaGrid(doc, y, cols) {
        var W = doc.internal.pageSize.getWidth();
        var cw = (W - 2 * M) / cols.length, maxLines = 1;
        cols.forEach(function (c, i) {
            var x = M + i * cw;
            font(doc, 'bold', 6.6, C.accent);
            text(doc, c[0], x, y, { cs: 0.5 });
            font(doc, 'normal', 9.6, C.ink);
            var lines = wrap(doc, c[1] || '—', cw - 4).slice(0, 2);
            maxLines = Math.max(maxLines, lines.length);
            lines.forEach(function (ln, j) { doc.text(ln, x, y + 5.4 + j * 4.6); });
        });
        return y + 5.4 + (maxLines - 1) * 4.6;
    }
    function paragraph(doc, s, y, w, size, color, lh) {
        font(doc, 'normal', size || 9.3, color || C.text);
        var lines = wrap(doc, s, w);
        lines.forEach(function (ln, i) { doc.text(ln, M, y + i * (lh || 4.7)); });
        return y + (lines.length - 1) * (lh || 4.7);
    }

    // ── Tarih biçimleri ──────────────────────────────────────
    function isoDate(iso) { var p = String(iso || '').split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
    var validIso = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
    function longDate(iso, lang) {
        if (!validIso(iso)) return '';
        return isoDate(iso).toLocaleDateString(L[lang].locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
    function shortDate(d, lang) {
        return d.toLocaleDateString(L[lang].locale, { day: 'numeric', month: 'long', year: 'numeric' });
    }
    function stayRange(a, b, lang) {
        var loc = L[lang].locale;
        if (!validIso(a) && !validIso(b)) return '';
        var f = function (iso, withYear) { return validIso(iso) ? isoDate(iso).toLocaleDateString(loc, withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }) : '…'; };
        var sameYear = validIso(a) && validIso(b) && a.slice(0, 4) === b.slice(0, 4);
        return f(a, !sameYear) + ' – ' + f(b, true);
    }

    // ── Rezervasyon → misafire görünen satırlar ──────────────
    // Yalnız hizmet alanları kullanılır; personel notu, fiyat, oluşturan vb. yok.
    var clean = function (s) { return String(s == null ? '' : s).trim(); };
    function itemView(r, lang) {
        var t = L[lang], type = t.svc[r.type] ? r.type : 'Other';
        var title = '', details = [];
        if (type === 'Restaurant' || type === 'Beach') {
            title = clean(r.resName) || t.svc[type];
            if (clean(r.pax)) details.push(t.pax(clean(r.pax)));
        } else if (type === 'Transfer') {
            var from = clean(r.from), to = clean(r.to);
            title = (from || to) ? (from || '…') + ' – ' + (to || '…') : t.svc.Transfer;
            var meta = [];
            if (clean(r.vehicle)) meta.push(t.vehicle + ': ' + clean(r.vehicle));
            if (clean(r.pax)) meta.push(t.pax(clean(r.pax)));
            if (meta.length) details.push(meta.join('  ·  '));
        } else if (type === 'Boat' || type === 'Tour') {
            title = clean(r.vessel) || t.svc[type];
            var m2 = [];
            if (clean(r.provider)) m2.push(t.provider + ': ' + clean(r.provider));
            if (clean(r.pax)) m2.push(t.pax(clean(r.pax)));
            if (m2.length) details.push(m2.join('  ·  '));
        } else {
            title = clean(r.otherType) || clean(r.resName) || t.svc[type];
        }
        return { type: type, service: t.svc[type], title: title, details: details };
    }
    function detailRows(r, lang) {
        var t = L[lang], f = t.f, v = itemView(r, lang), rows = [];
        rows.push([f.service, v.service]);
        rows.push([f.date, longDate(r.date, lang)]);
        rows.push([f.time, clean(r.time) || t.anyTime]);
        if (v.type === 'Restaurant' || v.type === 'Beach') {
            if (clean(r.resName)) rows.push([f.venue, clean(r.resName)]);
        } else if (v.type === 'Transfer') {
            if (clean(r.from)) rows.push([f.from, clean(r.from)]);
            if (clean(r.to)) rows.push([f.to, clean(r.to)]);
            if (clean(r.vehicle)) rows.push([f.vehicle, clean(r.vehicle)]);
        } else if (v.type === 'Boat' || v.type === 'Tour') {
            if (clean(r.vessel)) rows.push([v.type === 'Boat' ? f.vessel : f.tour, clean(r.vessel)]);
            if (clean(r.provider)) rows.push([f.provider, clean(r.provider)]);
        } else {
            rows.push([f.arrangement, v.title]);
        }
        if (clean(r.pax)) rows.push([f.guests, clean(r.pax)]);
        if (clean(r.voucherNo)) rows.push([f.confNo, clean(r.voucherNo)]);
        return rows;
    }

    // ── 1) Misafir programı ──────────────────────────────────
    // o: { lang, hotel:{name,address,phone}, guest, room, preArrival, stay:{checkIn,checkOut}, items:[res], filename }
    async function itinerary(o) {
        await ensureLibs();
        var lang = L[o.lang] ? o.lang : 'en', t = L[lang];
        var pre = !!o.preArrival;
        var ctx = { lang: lang, hotel: o.hotel || {}, label: pre ? t.lblPre : t.lblItinerary, labelSub: shortDate(new Date(), lang) };
        ctx.miniRight = o.guest + '  ·  ' + (pre ? t.preItinerary : t.itinerary);
        var doc = newDoc({ title: (pre ? t.preItinerary : t.itinerary) + ' – ' + o.guest, author: ctx.hotel.name });
        var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), bottom = H - 24;
        var cw = W - 2 * M;

        var y = header(doc, ctx);
        font(doc, 'normal', 20, C.ink);
        text(doc, pre ? t.preItinerary : t.itinerary, M, y + 4);
        y += 15;
        y = metaGrid(doc, y, [
            [up(t.guest, lang), o.guest],
            [up(t.room, lang), pre || !o.room ? t.roomPre : o.room],
            [up(t.stay, lang), stayRange(o.stay && o.stay.checkIn, o.stay && o.stay.checkOut, lang) || '—']
        ]);
        y += 7;
        hline(doc, M, W - M, y, C.line, 0.25);
        y += 10;
        font(doc, 'normal', 10, C.ink);
        text(doc, t.dear(o.guest), M, y);
        y = paragraph(doc, pre ? t.introPre : t.introIn, y + 6.5, cw);
        y += 11;

        // Gün gün gruplanmış ajanda
        var items = (o.items || []).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || String(a.time || '99').localeCompare(String(b.time || '99')); });
        var groups = [];
        items.forEach(function (r) {
            var g = groups[groups.length - 1];
            if (!g || g.date !== r.date) groups.push(g = { date: r.date, items: [] });
            g.items.push(r);
        });
        var TIME_W = 27, RIGHT_W = 38;
        var midX = M + TIME_W, midW = cw - TIME_W - RIGHT_W;
        function measure(r) {
            var v = itemView(r, lang);
            font(doc, 'bold', 10.4, C.ink);
            var tl = wrap(doc, v.title, midW).slice(0, 3);
            font(doc, 'normal', 8.5, C.text);
            var dl = [];
            v.details.forEach(function (d) { dl = dl.concat(wrap(doc, d, midW)); });
            return { v: v, tl: tl, dl: dl, h: 5 + tl.length * 4.9 + dl.length * 4.3 + 4.5 };
        }
        function dayHead(g, cont) {
            font(doc, 'bold', 10, C.ink);
            var s = longDate(g.date, lang) || g.date;
            text(doc, s, M, y);
            var sw = width(doc, s);   // başlık yazı boyutuyla ölçülür
            if (cont) { font(doc, 'normal', 8, C.muted); text(doc, '(' + t.cont + ')', M + sw + 2.5, y); }
            y += 3;
            hline(doc, M, W - M, y, C.ink, 0.25);
            y += 6.5;
        }
        function newPage() { doc.addPage(); y = miniHeader(doc, ctx); }
        groups.forEach(function (g) {
            var first = measure(g.items[0]);
            if (y + 10 + first.h > bottom) newPage();
            dayHead(g, false);
            g.items.forEach(function (r, idx) {
                var mm = idx === 0 ? first : measure(r);
                if (y + mm.h > bottom) { newPage(); dayHead(g, true); }
                var top = y;
                // Saat
                if (clean(r.time)) { font(doc, 'bold', 10.4, C.ink); text(doc, clean(r.time), M, top + 4.6); }
                else { font(doc, 'normal', 8, C.muted); wrap(doc, t.anyTime, TIME_W - 4).forEach(function (ln, i) { doc.text(ln, M, top + 4.6 + i * 3.8); }); }
                // Hizmet etiketi + başlık + ayrıntı
                font(doc, 'bold', 6.6, C.accent);
                text(doc, up(mm.v.service, lang), midX, top, { cs: 0.5 });
                font(doc, 'bold', 10.4, C.ink);
                mm.tl.forEach(function (ln, i) { doc.text(ln, midX, top + 4.9 + i * 4.9); });
                font(doc, 'normal', 8.5, C.text);
                var dy = top + 4.9 + mm.tl.length * 4.9 - 0.4;
                mm.dl.forEach(function (ln, i) { doc.text(ln, midX, dy + i * 4.3); });
                // Sağ sütun: onay no ya da "onay bekleniyor"
                var st = r.status || 'Pending';
                if (clean(r.voucherNo)) {
                    font(doc, 'normal', 6.8, C.muted); text(doc, t.confNo, W - M, top, { align: 'right' });
                    font(doc, 'bold', 8.6, C.ink); text(doc, fit(doc, clean(r.voucherNo), RIGHT_W - 4), W - M, top + 4.6, { align: 'right' });
                } else if (st === 'Pending') {
                    font(doc, 'normal', 7.8, C.warn); text(doc, t.toConfirm, W - M, top + 4.6, { align: 'right' });
                }
                y = top + mm.h;
                if (idx < g.items.length - 1) { hline(doc, midX, W - M, y - 3.2, C.line, 0.18); y += 1.5; }
            });
            y += 6;
        });

        // Kapanış
        if (y + 26 > bottom) newPage();
        y += 2;
        y = paragraph(doc, pre ? t.closingPre : t.closingIn, y, cw);
        y = paragraph(doc, t.contact(ctx.hotel.phone), y + 4.7, cw);
        y += 10;
        font(doc, 'bold', 9.6, C.ink); text(doc, t.sign, M, y);
        if (ctx.hotel.name) { font(doc, 'normal', 8.6, C.muted); text(doc, ctx.hotel.name, M, y + 4.8); }

        footers(doc, ctx);
        doc.save(o.filename || 'Itinerary.pdf');
        return true;
    }

    // ── 2) Onay mektubu ──────────────────────────────────────
    // o: { lang, hotel, r (rezervasyon), ref, room, preArrival, filename }
    async function confirmation(o) {
        await ensureLibs();
        var lang = L[o.lang] ? o.lang : 'en', t = L[lang], r = o.r || {};
        var st = t.conf[r.status] ? r.status : 'Pending';
        var c = t.conf[st];
        var ctx = { lang: lang, hotel: o.hotel || {}, label: c[0], labelSub: shortDate(new Date(), lang), miniRight: c[1] };
        var doc = newDoc({ title: c[1] + ' – ' + (r.guestName || ''), author: ctx.hotel.name });
        var W = doc.internal.pageSize.getWidth(), cw = W - 2 * M;

        var y = header(doc, ctx);
        font(doc, 'normal', 20, C.ink);
        text(doc, fit(doc, c[1], cw - 50), M, y + 4);
        if (o.ref) {
            font(doc, 'bold', 6.6, C.accent); text(doc, up(t.reference, lang), W - M, y - 1.5, { align: 'right', cs: 0.5 });
            font(doc, 'bold', 10.4, C.ink); text(doc, '#' + o.ref, W - M, y + 4, { align: 'right' });
        }
        y += 15;
        y = metaGrid(doc, y, [
            [up(t.guest, lang), r.guestName || ''],
            [up(t.room, lang), o.preArrival || !o.room ? t.roomPre : o.room],
            [up(t.issued, lang), shortDate(new Date(), lang)]
        ]);
        y += 7;
        hline(doc, M, W - M, y, C.line, 0.25);
        y += 10;
        font(doc, 'normal', 10, C.ink);
        text(doc, t.dear(r.guestName || ''), M, y);
        y = paragraph(doc, c[2], y + 6.5, cw);
        y += 9;

        // Ayrıntı paneli: açık zemin, etiket | değer satırları
        var rows = detailRows(r, lang);
        rows.push([t.f.status, t.st[st]]);
        var LW = 46, pad = 7, valW = cw - LW - pad * 2;
        font(doc, 'normal', 10, C.ink);
        var measured = rows.map(function (row) { return { k: row[0], lines: wrap(doc, row[1] || '—', valW).slice(0, 4) }; });
        var heights = measured.map(function (m) { return 5.2 + m.lines.length * 4.9 + 1.6; });
        var boxH = heights.reduce(function (a, b) { return a + b; }, 0) + pad - 1.6;
        doc.setFillColor(C.soft[0], C.soft[1], C.soft[2]);
        doc.rect(M, y, cw, boxH, 'F');
        doc.setFillColor(C.accent[0], C.accent[1], C.accent[2]);
        doc.rect(M, y, 0.9, boxH, 'F');
        var ry = y + pad;
        measured.forEach(function (m, i) {
            font(doc, 'bold', 6.6, C.accent);
            text(doc, up(m.k, lang), M + pad, ry + 3.4, { cs: 0.45 });
            var isStatus = i === measured.length - 1;
            var col = !isStatus ? C.ink : (st === 'Cancelled' ? C.bad : st === 'Pending' ? C.warn : C.ok);
            font(doc, isStatus ? 'bold' : 'normal', 10, col);
            m.lines.forEach(function (ln, j) { doc.text(ln, M + pad + LW, ry + 3.6 + j * 4.9); });
            ry += heights[i];
            if (i < measured.length - 1) hline(doc, M + pad, W - M - pad, ry - 3.6, [229, 232, 237], 0.2);
        });
        y += boxH + 12;

        y = paragraph(doc, t.contact(ctx.hotel.phone), y, cw);
        y += 11;
        font(doc, 'normal', 9.3, C.text); text(doc, t.regards, M, y);
        y += 9;
        font(doc, 'bold', 9.6, C.ink); text(doc, t.sign, M, y);
        if (ctx.hotel.name) { font(doc, 'normal', 8.6, C.muted); text(doc, ctx.hotel.name, M, y + 4.8); }

        footers(doc, ctx);
        doc.save(o.filename || 'Confirmation.pdf');
        return true;
    }

    // ── 3) Tablo raporu (personel, Türkçe) ───────────────────
    // o: { hotel, title, subtitle, head:[], rows:[[]], right:[sütun adları], status: 'Durum',
    //      summary:[[etiket, değer]], user, filename }
    async function table(o) {
        await ensureLibs();
        var lang = 'tr';
        var cols = (o.head || []).length;
        var doc = newDoc({ orientation: cols > 7 ? 'landscape' : 'portrait', title: o.title, author: (o.hotel || {}).name });
        if (!hasTable(doc)) throw libError();
        var now = new Date();
        var stamp = now.toLocaleDateString('tr-TR') + ' ' + now.toTimeString().slice(0, 5);
        var ctx = { lang: lang, hotel: o.hotel || {}, label: 'CONCIERGE RAPORU', labelSub: stamp, miniRight: o.title };
        ctx.footLeft = [ctx.hotel.name, o.user ? 'Oluşturan: ' + o.user : '', stamp].filter(Boolean).join('   ·   ');
        var W = doc.internal.pageSize.getWidth(), cw = W - 2 * M;

        var y = header(doc, ctx);
        font(doc, 'normal', 16, C.ink);
        text(doc, o.title, M, y + 2);
        if (o.subtitle) { font(doc, 'normal', 8.6, C.muted); text(doc, o.subtitle, M, y + 8); }
        y += 15;
        if (o.summary && o.summary.length) {
            var n = o.summary.length, gap = 2.5, bw = (cw - gap * (n - 1)) / n;
            o.summary.forEach(function (s, i) {
                var x = M + i * (bw + gap);
                doc.setFillColor(C.soft[0], C.soft[1], C.soft[2]);
                doc.rect(x, y, bw, 15, 'F');
                font(doc, 'bold', 6.2, C.accent); text(doc, fit(doc, up(s[0], lang), bw - 6, 0.4), x + 3.5, y + 5.2, { cs: 0.4 });
                font(doc, 'bold', 10.6, C.ink); text(doc, fit(doc, String(s[1]), bw - 6), x + 3.5, y + 11.2);
            });
            y += 21;
        }

        var right = {}; (o.right || []).forEach(function (h) { var i = o.head.indexOf(h); if (i > -1) right[i] = { halign: 'right' }; });
        var stCol = o.head.indexOf(o.status || 'Durum');
        var ST_COL = { 'Bekliyor': C.warn, 'Onaylı': C.ok, 'Tamamlandı': C.muted, 'İptal': C.bad };
        doc.autoTable({
            head: [o.head.map(T)],
            body: o.rows.map(function (row) { return row.map(function (c) { return T(c == null ? '' : c); }); }),
            startY: y,
            theme: 'plain',
            margin: { left: M, right: M, top: 28, bottom: 22 },
            styles: { font: fontOk ? 'Roboto' : 'helvetica', fontSize: 8, textColor: C.text, cellPadding: { top: 2.3, bottom: 2.3, left: 2, right: 2 }, overflow: 'linebreak', valign: 'top' },
            headStyles: { fontStyle: 'bold', fontSize: 7.2, textColor: C.ink, fillColor: C.soft },
            columnStyles: right,
            didParseCell: function (d) {
                if (d.section === 'body' && d.column.index === stCol) {
                    var col = ST_COL[o.rows[d.row.index] && o.rows[d.row.index][stCol]];
                    if (col) d.cell.styles.textColor = col;
                }
                if (d.section === 'head' && right[d.column.index]) d.cell.styles.halign = 'right';
            },
            didDrawCell: function (d) {
                if (d.section !== 'body') return;
                hline(doc, d.cell.x, d.cell.x + d.cell.width, d.cell.y + d.cell.height, C.line, 0.15);
            },
            didDrawPage: function (d) { if (d.pageNumber > 1) miniHeader(doc, ctx); }
        });
        footers(doc, ctx);
        doc.save(o.filename || 'Rapor.pdf');
        return true;
    }

    global.CzPdf = { itinerary: itinerary, confirmation: confirmation, table: table, _itemView: itemView, _detailRows: detailRows };
})(window);
