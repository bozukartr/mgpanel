/* Hotizy — shell-search.js · Oda numarası / misafir genel arama (App Shell)
 *
 * Resepsiyonun en sık yaptığı iş: "204'te kim var, açık talebi var mı?".
 * Önceden her modülün kendi araması vardı; bu palet hepsini tek pencerede
 * toplar: misafir (konaklıyor / gelecek), açık talep ve şikayetler, açık QR
 * siparişleri, yaklaşan rezervasyonlar ve açık oda hesabı. Satıra dokununca
 * ilgili modül kayıt açık şekilde gelir (App Shell derin bağlantısı, sayfa
 * yeniden yüklenmez). "Bu oda için yeni talep/şikayet" formu oda ve misafir
 * dolu açar.
 *
 * Açma: başlıktaki arama düğmesi, Ctrl/⌘+K, ya da yazı alanında değilken "/".
 * Yalnızca otel bağlamında (F&B girişinde gizli). Modülü kapalı bölümler
 * gösterilmez. Veriler yalnızca okunur; kurallar zaten personel okumasına açık.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;
    if ((localStorage.getItem('loginContext') || 'hotel') !== 'hotel') return;

    var $ = function (id) { return document.getElementById(id); };
    var on = function (k) { return typeof moduleEnabled !== 'function' || moduleEnabled(k); };
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    // Türkçe harf duyarsız karşılaştırma ("şükrü" ~ "Sukru", "İLKER" ~ "ilker").
    function fold(s) {
        return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase()
            .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u')
            .replace(/ö/g, 'o').replace(/ç/g, 'c').trim();
    }
    function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
    function tsMs(v) { return v && v.toMillis ? v.toMillis() : (typeof v === 'number' ? v : (v ? Date.parse(v) || 0 : 0)); }
    function ago(ms) {
        if (!ms) return '';
        var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
        if (m < 1) return 'şimdi';
        if (m < 60) return m + ' dk önce';
        var h = Math.round(m / 60);
        return h < 24 ? h + ' sa önce' : Math.round(h / 24) + ' gün önce';
    }
    var MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    function fmtDay(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] : '';
    }
    function money(n, cur) {
        var sym = { EUR: '€', TRY: '₺', USD: '$', GBP: '£' }[cur] || (cur ? cur + ' ' : '');
        var v = (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        return sym + v;
    }

    var IC = {
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
        cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v13H5a2 2 0 0 1-2-2V5"/><path d="M16 14h.01"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        chev: '<path d="m9 6 6 6-6 6"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>'
    };
    function ic(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + IC[n] + '</svg>'; }

    var LOG_ST = { following: 'Bekliyor', open: 'Bekliyor', inprogress: 'İşlemde', solved: 'Tamamlandı' };
    var ORD_ST = { pending: 'Bekliyor', confirmed: 'Onaylandı', in_progress: 'Hazırlanıyor', completed: 'Tamamlandı', cancelled: 'İptal' };
    var RES_ST = { Confirmed: 'Onaylı', Cancelled: 'İptal', Done: 'Tamamlandı', Pending: 'Bekliyor' };

    // ── Veri ──────────────────────────────────────────────────────
    var guests = null, guestsAt = 0;
    function loadGuests() {
        if (guests && Date.now() - guestsAt < 60000) return Promise.resolve(guests);
        return db.collection('guestDirectory').where('tenantId', '==', TENANT_ID)
            .where('status', 'in', ['in_house', 'pre_arrival']).get()
            .then(function (snap) {
                guests = snap.docs.map(function (d) { var g = d.data() || {}; g.id = d.id; return g; });
                guestsAt = Date.now();
                return guests;
            }).catch(function () { return guests || []; });
    }
    function roomVariants(room) {
        var r = String(room || '').trim(), v = [r];
        var n = r.replace(/^0+(?=\d)/, '');
        if (n !== r) v.push(n);
        if (/^\d+$/.test(r) && r.length < 4) v.push(('0000' + r).slice(-4));
        return v.filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 10);
    }
    function q(col, room, extra) {
        var ref = db.collection(col).where('tenantId', '==', TENANT_ID).where('room', 'in', roomVariants(room));
        if (extra) ref = extra(ref);
        return ref.limit(60).get()
            .then(function (s) { return s.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return x; }); })
            .catch(function () { return null; });   // bölüm "yüklenemedi" gösterir
    }
    var roomCache = {};
    function loadRoom(room) {
        var c = roomCache[room];
        if (c && Date.now() - c.at < 20000) return c.p;
        var p = Promise.all([
            on('guestIssues') ? q('guestLogs', room) : Promise.resolve(undefined),
            on('guestOrders') ? q('guestOrders', room) : Promise.resolve(undefined),
            on('concierge') ? q('reservations', room) : Promise.resolve(undefined),
            q('folioCharges', room, function (r) { return r.where('status', '==', 'open'); })
        ]).then(function (a) { return { logs: a[0], orders: a[1], res: a[2], folio: a[3] }; });
        roomCache[room] = { at: Date.now(), p: p };
        return p;
    }

    // ── Arayüz ────────────────────────────────────────────────────
    var root, input, body, lastQ = '', seq = 0, sel = -1, debounce = null, prevFocus = null;
    var RECENT_KEY = 'hz_search_recent_' + (localStorage.getItem('hotelUsername') || '');
    function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 5); } catch (e) { return []; } }
    function remember(room) {
        try {
            var r = recent().filter(function (x) { return x !== room; });
            r.unshift(room);
            localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 5)));
        } catch (e) {}
    }

    function build() {
        root = document.createElement('div');
        root.className = 'ss-root';
        root.hidden = true;
        root.innerHTML =
            '<div class="ss-scrim" data-close></div>' +
            '<div class="ss-panel" role="dialog" aria-modal="true" aria-label="Oda veya misafir ara">' +
            '  <div class="ss-head">' + ic('search') +
            '    <input id="ssInput" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="Oda numarası ya da misafir adı" aria-controls="ssBody">' +
            '    <button class="ss-close" data-close aria-label="Kapat"><span class="ss-kbd">Esc</span><span class="ss-x">' + ic('x') + '</span></button>' +
            '  </div>' +
            '  <div class="ss-body" id="ssBody" role="listbox"></div>' +
            '  <div class="ss-foot"><span><kbd>↑</kbd><kbd>↓</kbd> gezin</span><span><kbd>Enter</kbd> aç</span><span><kbd>Esc</kbd> kapat</span></div>' +
            '</div>';
        document.body.appendChild(root);
        input = $('ssInput');
        body = $('ssBody');
        root.addEventListener('click', function (e) {
            if (e.target.closest('[data-close]')) { close(); return; }
            var row = e.target.closest('.ss-row[data-act]');
            if (row) act(row);
        });
        input.addEventListener('input', function () { schedule(); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                var rows = actRows();
                if (sel >= 0 && rows[sel]) act(rows[sel]);
                else if (rows.length) act(rows[0]);
            } else if (e.key === 'Escape') { e.preventDefault(); close(); }
        });
    }
    function actRows() { return body ? Array.prototype.slice.call(body.querySelectorAll('.ss-row[data-act]')) : []; }
    function move(d) {
        var rows = actRows();
        if (!rows.length) return;
        sel = (sel + d + rows.length) % rows.length;
        rows.forEach(function (r, i) { r.classList.toggle('sel', i === sel); r.setAttribute('aria-selected', i === sel ? 'true' : 'false'); });
        rows[sel].scrollIntoView({ block: 'nearest' });
    }
    function resetSel() { sel = -1; }

    function open(initial) {
        if (!root) build();
        prevFocus = document.activeElement;
        root.hidden = false;
        document.documentElement.classList.add('ss-open');
        input.value = initial || '';
        resetSel();
        render();
        setTimeout(function () { input.focus(); input.select(); }, 0);
        loadGuests().then(function () { if (!root.hidden) render(); });
    }
    function close() {
        if (!root || root.hidden) return;
        root.hidden = true;
        document.documentElement.classList.remove('ss-open');
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
    }
    function isOpen() { return !!root && !root.hidden; }

    function schedule() {
        clearTimeout(debounce);
        resetSel();
        debounce = setTimeout(render, 160);
    }

    function go(route, query) {
        close();
        if (window.Shell && Shell.navigate) Shell.navigate(route, query);
        else location.href = 'app#' + route + (query ? '?' + query : '');
    }
    function act(row) {
        var a = row.getAttribute('data-act'), v = row.getAttribute('data-v') || '';
        if (a === 'room') { input.value = v; resetSel(); render(); input.focus(); return; }
        var room = row.getAttribute('data-room') || '';
        if (room) remember(room);
        if (a === 'log') go('kayitlar', 'open=' + encodeURIComponent(v));
        else if (a === 'order') go('concierge', 'order=' + encodeURIComponent(v));
        else if (a === 'res') go('concierge', 'res=' + encodeURIComponent(v));
        else if (a === 'crm') go('crm', 'q=' + encodeURIComponent(v));
        else if (a === 'new') {
            var p = new URLSearchParams();
            p.set('new', v); p.set('room', room);
            var gn = row.getAttribute('data-guest'); if (gn) p.set('guest', gn);
            go('kayitlar', p.toString());
        }
    }

    function row(o) {
        return '<div class="ss-row"' + (o.act ? ' role="option" data-act="' + esc(o.act) + '" data-v="' + esc(o.v || '') + '"' : '') +
            (o.room ? ' data-room="' + esc(o.room) + '"' : '') + (o.guest ? ' data-guest="' + esc(o.guest) + '"' : '') + '>' +
            '<span class="ss-ic ' + (o.tone || '') + '">' + ic(o.icon) + '</span>' +
            '<span class="ss-tx"><b>' + esc(o.title) + '</b>' + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</span>' +
            (o.pill ? '<span class="ss-pill ' + (o.pillTone || '') + '">' + esc(o.pill) + '</span>' : '') +
            (o.act ? '<span class="ss-chev">' + (o.actLabel ? '<em>' + esc(o.actLabel) + '</em>' : '') + ic('chev') + '</span>' : '') + '</div>';
    }
    function section(title, inner, count) {
        return '<div class="ss-sec"><div class="ss-sec-h">' + esc(title) + (count != null ? ' <span>' + count + '</span>' : '') + '</div>' + inner + '</div>';
    }
    function note(t, tone) { return '<div class="ss-note ' + (tone || '') + '">' + esc(t) + '</div>'; }

    // inRoom: oda görünümündeki misafir satırı (dokununca CRM'de açılır);
    // değilse ad listesindeki satır (dokununca o odanın ayrıntıları gelir).
    function guestRow(g, inRoom) {
        var pre = g.status === 'pre_arrival';
        var room = (g.room && g.room !== 'Pre-Arrival') ? g.room : '';
        var dates = [g.checkIn && ('Giriş ' + fmtDay(g.checkIn)), g.checkOut && ('Çıkış ' + fmtDay(g.checkOut))].filter(Boolean).join(' · ');
        var toCrm = (inRoom || !room) && on('crm');
        return row({
            act: toCrm ? 'crm' : ((!inRoom && room) ? 'room' : ''), v: toCrm ? (g.name || '') : room,
            actLabel: toCrm ? 'CRM' : '',
            icon: 'user', tone: pre ? 't-amber' : 't-indigo',
            title: g.name || 'Misafir', sub: (room ? 'Oda ' + room : 'Oda atanmadı') + (dates ? ' · ' + dates : ''),
            pill: pre ? 'Gelecek' : 'Konaklıyor', pillTone: pre ? 'p-amber' : 'p-green'
        });
    }

    function render() {
        var my = ++seq;
        var raw = (input.value || '').trim();
        lastQ = raw;
        if (!raw) {
            var rec = recent();
            var html = rec.length
                ? section('Son aranan odalar', rec.map(function (r) { return row({ act: 'room', v: r, icon: 'clock', title: 'Oda ' + r }); }).join(''))
                : '';
            body.innerHTML = html + note('Oda numarası (ör. 204) ya da misafir adı yazın.' + (window.matchMedia && matchMedia('(pointer:fine)').matches ? ' Kısayol: Ctrl+K ya da /' : ''), 'ss-hint');
            return;
        }
        var gs = guests || [];
        var f = fold(raw);
        var roomLike = /^[0-9]{1,5}[a-zA-Z]?$/.test(raw) || gs.some(function (g) { return fold(g.room) === f; });
        var matches;
        if (roomLike) {
            matches = gs.filter(function (g) { var r = fold(g.room); return r === f || r.replace(/^0+/, '') === f.replace(/^0+/, ''); });
        } else {
            matches = gs.filter(function (g) { return fold(g.name).indexOf(f) !== -1 || (f.length >= 2 && fold(g.room).indexOf(f) === 0); }).slice(0, 8);
        }

        if (!roomLike) {
            body.innerHTML = matches.length
                ? section('Misafirler', matches.map(function (g) { return guestRow(g, false); }).join(''), matches.length)
                : note(guests ? '“' + raw + '” ile eşleşen konaklayan ya da gelecek misafir yok.' : 'Yükleniyor…');
            return;
        }
        // Oda: misafir + ayrıntılar
        var room = raw;
        var guestHtml = matches.length ? section('Misafir', matches.map(function (g) { return guestRow(g, true); }).join('')) : '';
        var g0 = matches[0];
        // Bu oda için hızlı eylemler: misafirin hemen altında, kompakt.
        var gn = g0 ? esc(g0.name || '') : '';
        var quickBtn = function (type, icon, label, tone) {
            return '<div class="ss-row ss-qbtn" role="option" data-act="new" data-v="' + type + '" data-room="' + esc(room) + '"' +
                (gn ? ' data-guest="' + gn + '"' : '') + '><span class="ss-ic ' + tone + '">' + ic(icon) + '</span><b>' + label + '</b></div>';
        };
        var quick = on('guestIssues') ? '<div class="ss-quick">' + quickBtn('request', 'plus', 'Yeni talep', 't-indigo') +
            quickBtn('complaint', 'alert', 'Yeni şikayet', 't-red') + '</div>' : '';
        var head = (guestHtml || section('Misafir', note('Bu odada konaklayan ya da gelecek misafir yok.'))) + quick;
        body.innerHTML = head + '<div class="ss-loading">Oda ' + esc(room) + ' yükleniyor…</div>';

        loadRoom(room).then(function (d) {
            if (my !== seq || !isOpen()) return;   // bu arada başka bir şey yazıldı
            var out = head;
            var any = matches.length > 0;

            if (d.logs !== undefined) {
                if (d.logs === null) out += section('Açık talep ve şikayetler', note('Yüklenemedi.', 'ss-err'));
                else {
                    var openLogs = d.logs.filter(function (r) { return String(r.status || 'Following').toLowerCase() !== 'solved'; })
                        .sort(function (a, b) { return tsMs(b.createdAt) - tsMs(a.createdAt); });
                    any = any || openLogs.length > 0;
                    out += section('Açık talep ve şikayetler', openLogs.length ? openLogs.slice(0, 8).map(function (r) {
                        var cmp = (r.type || 'complaint') === 'complaint';
                        var st = LOG_ST[String(r.status || 'Following').toLowerCase()] || 'Bekliyor';
                        return row({
                            act: 'log', v: r.id, room: room, icon: cmp ? 'alert' : 'bell', tone: cmp ? 't-red' : 't-indigo',
                            title: (r.topic || r.complaint || (cmp ? 'Şikayet' : 'Talep')).slice(0, 80),
                            sub: [cmp ? 'Şikayet' : 'Talep', r.department, ago(tsMs(r.createdAt))].filter(Boolean).join(' · '),
                            pill: st, pillTone: st === 'İşlemde' ? 'p-blue' : 'p-amber'
                        });
                    }).join('') : note('Açık kayıt yok.'), openLogs.length);
                }
            }
            if (d.orders !== undefined) {
                if (d.orders === null) out += section('QR talepleri', note('Yüklenemedi.', 'ss-err'));
                else {
                    var openOrd = d.orders.filter(function (o) { return o.status !== 'completed' && o.status !== 'cancelled'; })
                        .sort(function (a, b) { return (b.createdAtMs || tsMs(b.createdAt)) - (a.createdAtMs || tsMs(a.createdAt)); });
                    any = any || openOrd.length > 0;
                    if (openOrd.length) out += section('Açık QR talepleri', openOrd.slice(0, 6).map(function (o) {
                        var items = (o.items || []).map(function (i) { return (i.qty > 1 ? i.qty + '× ' : '') + (i.name || ''); }).join(', ');
                        return row({
                            act: 'order', v: o.id, room: room, icon: 'qr', tone: 't-teal',
                            title: items || 'QR talebi', sub: ago(o.createdAtMs || tsMs(o.createdAt)),
                            pill: ORD_ST[o.status] || 'Bekliyor', pillTone: o.status === 'pending' ? 'p-amber' : 'p-blue'
                        });
                    }).join(''), openOrd.length);
                }
            }
            if (d.res !== undefined && d.res !== null) {
                var t = today();
                var up = d.res.filter(function (r) { return r.status !== 'Cancelled' && r.status !== 'Done' && String(r.date || '') >= t; })
                    .sort(function (a, b) { return String(a.date + (a.time || '')).localeCompare(String(b.date + (b.time || ''))); });
                any = any || up.length > 0;
                if (up.length) out += section('Yaklaşan rezervasyonlar', up.slice(0, 5).map(function (r) {
                    return row({
                        act: 'res', v: r.id, room: room, icon: 'cal', tone: 't-violet',
                        title: (r.type || 'Rezervasyon') + (r.guestName ? ' · ' + r.guestName : ''),
                        sub: [fmtDay(r.date) + (r.date === t ? ' (bugün)' : ''), r.time].filter(Boolean).join(' · '),
                        pill: RES_ST[r.status] || 'Bekliyor', pillTone: r.status === 'Confirmed' ? 'p-green' : 'p-amber'
                    });
                }).join(''), up.length);
            }
            if (d.folio && d.folio.length) {
                any = true;
                var by = {};
                d.folio.forEach(function (c) {
                    var cur = c.currency || (c.source === 'concierge' ? 'EUR' : 'TRY');
                    by[cur] = by[cur] || { total: 0, n: 0 };
                    by[cur].total += Number(c.amount) || 0; by[cur].n++;
                });
                var parts = Object.keys(by).map(function (k) { return money(by[k].total, k); });
                var n = d.folio.length;
                out += section('Oda hesabı', '<div class="ss-folio">' + ic('wallet') + '<div><b>' + esc(parts.join(' + ')) + '</b><small>' + n + ' açık kalem · çıkışta tahsil edilecek</small></div></div>');
            }
            if (!any) out += note('Oda ' + room + ' için açık kayıt yok.');
            body.innerHTML = out;
            resetSel();
        });
    }

    // Başlık düğmesi + kısayollar
    function wire() {
        var btn = $('shSearchBtn');
        if (btn) { btn.hidden = false; btn.addEventListener('click', function () { open(''); }); }
        var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
        document.querySelectorAll('.sh-search kbd').forEach(function (k) { k.textContent = mac ? '⌘K' : 'Ctrl K'; });
        if (window.Shell && Shell.addKeyHandler) {
            Shell.addKeyHandler(function (e, typing) {
                var k = (e.key || '').toLowerCase();
                if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'k') { isOpen() ? close() : open(''); return true; }
                if (!typing && !isOpen() && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) { open(''); return true; }
                return false;
            });
        }
    }
    window.ShellSearch = { open: open, close: close, isOpen: isOpen, _fold: fold, _roomVariants: roomVariants };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
