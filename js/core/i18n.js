/* Hotizy — i18n.js · Türkçe/İngilizce arayüz çevirisi.
 *
 * Derleme adımı YOK: sözlükler düz global nesneler (js/i18n/tr.js, en.js),
 * bu dosya da klasik bir <script>. Her sayfada firebase-config.js'ten HEMEN
 * SONRA yüklenir (embed.js en başta kalır — kendi sözleşmesi gereği).
 *
 * ── Kapsam ────────────────────────────────────────────────────────────────
 * YALNIZCA arayüz metinleri çevrilir. Otelin kendi girdiği içerik (katalog
 * talep adları, restoran menüsü, departman adları) çevrilmez — o veri otele
 * aittir. Ayrıca `department` gibi YÖNLENDİRME anahtarları asla çevrilmez:
 * çevrilirse talep yanlış departmana gider (bkz. tests/dept-routing.test.js).
 *
 * ── Eksik çeviri davranışı ────────────────────────────────────────────────
 * aktif dil → Türkçe → anahtarın kendisi. Kullanıcı hiçbir zaman boş ekran
 * görmez; en kötü ihtimalle o satır Türkçe kalır. Aşamalı teslimat bu
 * davranışa dayanır (henüz çevrilmemiş ekranlar çalışmaya devam eder).
 *
 * ── Dil değiştirme ────────────────────────────────────────────────────────
 * Tercih yazılır + sayfa yeniden yüklenir. Personel sayfaları kabuk (app.html)
 * içindeki bir IFRAME'de AYRI doküman olarak çalıştığından (js/core/app-shell.js)
 * üst pencerenin yeniden yüklenmesi kabuğu ve içeriği birlikte tazeler — bu
 * kadar çok dinamik DOM'u canlı yeniden çizmeye çalışmaktan çok daha güvenli.
 */
(function () {
    'use strict';

    var SUPPORTED = ['tr', 'en'];
    var FALLBACK = 'tr';

    // Personel tarafı tercih anahtarı. clearSessionStorage()'a BİLİNÇLİ olarak
    // eklenmez (js/core/firebase-config.js): dil bir oturum verisi değil, kişisel
    // bir cihaz tercihidir — çıkış yapınca kaybolmamalı.
    var STAFF_KEY = 'hotelLang';

    function norm(l) {
        l = String(l || '').toLowerCase().slice(0, 2);
        return SUPPORTED.indexOf(l) !== -1 ? l : '';
    }

    // Misafir (QR) sayfası kendi tenant'ına özel anahtar kullanır — guest-order.js'in
    // go2_* deseniyle aynı; aynı cihazda farklı otelin QR'ı okutulunca karışmaz.
    function guestKey() {
        var t = (typeof TENANT !== 'undefined' && TENANT) ||
                (typeof resolveTenant === 'function' ? resolveTenant() : '') || 'default';
        return 'go2_lang_' + t;
    }
    function isGuestPage() {
        return /guest-order/.test(location.pathname);
    }
    function storageKey() { return isGuestPage() ? guestKey() : STAFF_KEY; }

    function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
    function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

    // Dil çözümleme:
    //  · Misafir: kayıtlı tercih → TARAYICI dili (otomatik) → tr
    //  · Personel: kayıtlı tercih → tr  (tarayıcıdan otomatik SEÇİLMEZ; personel
    //    kendi diliyle çalışır ve bunu bilinçli seçer)
    var _lang = (function () {
        var saved = norm(read(storageKey()));
        if (saved) return saved;
        if (isGuestPage()) {
            var navLangs = (navigator.languages && navigator.languages.length)
                ? navigator.languages : [navigator.language || ''];
            for (var i = 0; i < navLangs.length; i++) {
                var m = norm(navLangs[i]);
                if (m) return m;
            }
        }
        return FALLBACK;
    })();

    function dict(l) {
        return (l === 'en' ? window.I18N_EN : window.I18N_TR) || {};
    }

    // {name} yer tutucularını doldurur. Değer verilmemişse yer tutucu OLDUĞU
    // GİBİ bırakılır — "undefined" basmaktansa görünür bir eksiklik yeğdir.
    function interpolate(s, params) {
        if (!params) return s;
        return s.replace(/\{(\w+)\}/g, function (whole, k) {
            return (params[k] === undefined || params[k] === null) ? whole : String(params[k]);
        });
    }

    function translate(key, params) {
        if (!key) return '';
        var v = dict(_lang)[key];
        if (v === undefined) v = dict(FALLBACK)[key];
        if (v === undefined) v = key;   // son çare: anahtarın kendisi
        return interpolate(String(v), params);
    }

    // ── Statik HTML ───────────────────────────────────────────────────────
    // data-i18n         → textContent
    // data-i18n-ph      → placeholder
    // data-i18n-title   → title
    // data-i18n-aria    → aria-label
    // data-i18n-html    → innerHTML (yalnızca SÖZLÜKTEN gelen, geliştirici
    //                     yazımı metin için; kullanıcı verisi ASLA buraya
    //                     verilmez — XSS yüzeyi açmamak için)
    var ATTR = [
        ['data-i18n', function (el, s) { el.textContent = s; }],
        ['data-i18n-html', function (el, s) { el.innerHTML = s; }],
        ['data-i18n-ph', function (el, s) { el.setAttribute('placeholder', s); }],
        ['data-i18n-title', function (el, s) { el.setAttribute('title', s); }],
        ['data-i18n-aria', function (el, s) { el.setAttribute('aria-label', s); }]
    ];
    function apply(root) {
        root = root || document;
        ATTR.forEach(function (pair) {
            var attr = pair[0], set = pair[1];
            var nodes = root.querySelectorAll('[' + attr + ']');
            for (var i = 0; i < nodes.length; i++) {
                set(nodes[i], translate(nodes[i].getAttribute(attr)));
            }
        });
        // <html lang> ekran okuyucular ve tarayıcı çevirisi için doğru olmalı.
        try { document.documentElement.setAttribute('lang', _lang); } catch (e) {}
    }

    // ── Biçimleme ─────────────────────────────────────────────────────────
    // DİKKAT: burası yalnızca GÖRÜNTÜLEME içindir. Veri normalizasyonunda
    // kullanılan toLocaleLowerCase('tr-TR') (departman eşleştirme deptKey/
    // sameDept, misafir arama nameKey, transfer/F&B kalem sınıflandırması)
    // ASLA dile bağlı hale getirilmemelidir — aksi halde talep yönlendirmesi
    // bozulur. Bkz. tests/dept-routing.test.js.
    function locale() { return _lang === 'en' ? 'en-GB' : 'tr-TR'; }
    function fmtDate(d) {
        var dt = (d instanceof Date) ? d : new Date(d);
        if (isNaN(dt.getTime())) return '';
        try { return dt.toLocaleDateString(locale()); } catch (e) { return dt.toISOString().slice(0, 10); }
    }
    function fmtNum(n) {
        var v = Number(n);
        if (isNaN(v)) v = 0;
        try { return v.toLocaleString(locale()); } catch (e) { return String(v); }
    }
    function collator() {
        try { return new Intl.Collator(locale()); } catch (e) { return null; }
    }

    function setLang(l) {
        var next = norm(l);
        if (!next || next === _lang) return;
        write(storageKey(), next);
        // Kabuk + iframe birlikte tazelensin: üst pencereyi yenile. Aynı origin
        // olduğundan erişilebilir; olmazsa kendi penceremizi yenileriz.
        try {
            if (window.top && window.top !== window) { window.top.location.reload(); return; }
        } catch (e) { /* cross-origin — kendi penceremize düş */ }
        location.reload();
    }

    window.I18n = {
        lang: function () { return _lang; },
        supported: function () { return SUPPORTED.slice(); },
        setLang: setLang,
        t: translate,
        apply: apply,
        locale: locale,
        fmtDate: fmtDate,
        fmtNum: fmtNum,
        collator: collator
    };
    // Modüllerde kısa kullanım: t('anahtar')
    window.t = translate;

    // Sözlükler bu dosyadan ÖNCE yüklenir (script sırası), DOM ise sonra hazır olur.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { apply(document); });
    } else {
        apply(document);
    }
})();
