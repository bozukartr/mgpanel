/* Hotizy — personel ekranları için paylaşımlı çizgi ikon seti.
 *
 * Arayüzde emoji (📋 ⚠️ 🛎️ 🚗 …) ikon olarak kullanılıyordu: platforma göre
 * farklı çiziliyor, renk/kalınlık ayarlanamıyor ve modern arayüzün geri
 * kalanıyla uyumsuz duruyordu. Bu dosya tek tip (24×24, 2px çizgi, yuvarlak
 * uçlu) SVG ikonlar sağlar:
 *   · JS içinde:   UIcon('wrench')            → '<span class="ui-ic">…svg…</span>'
 *   · HTML içinde: <span data-ic="wrench"></span>  (yüklenince doldurulur)
 * İkon rengi `currentColor`, boyutu yazı boyutuna göre (1.15em) — yani
 * bulunduğu metnin rengini ve büyüklüğünü alır.
 *
 * Veri olarak saklanan metinler (iş akışı notları, bildirim başlıkları) bu
 * dosyanın kapsamı DIŞINDADIR — onlar içerik, arayüz değil. */
(function () {
    'use strict';
    var P = {
        plus: '<path d="M12 5v14M5 12h14"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        concierge: '<path d="M3 18h18"/><path d="M5 18a7 7 0 0 1 14 0"/><path d="M12 11V8.5"/><path d="M10 8.5h4"/><path d="M2 21h20"/>',
        clipboard: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
        wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.3 6.3a2.1 2.1 0 0 1-3-3l6.3-6.3a6 6 0 0 1 7.9-7.9z"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        chart: '<path d="M3 3v18h18"/><path d="M7 16v-5"/><path d="M12 16V8"/><path d="M17 16v-9"/>',
        mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
        pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
        trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
        siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 21h14v-3H5z"/><path d="M12 3v1"/><path d="m4.6 6 .8.8"/><path d="m19.4 6-.8.8"/>',
        message: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/>',
        hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22"/><path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"/>',
        timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/>',
        repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
        receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
        file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/>',
        sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h8M12 13v8"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
        users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        utensils: '<path d="M3 2v7c0 1.1.9 2 2 2a2 2 0 0 0 2-2V2"/><path d="M5 11v11"/><path d="M19 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
        beach: '<path d="M22 21H2"/><path d="M13 21 7.5 7.5"/><path d="M3.2 11.6A9 9 0 0 1 17.6 5.4z"/>',
        car: '<path d="M5 17h14"/><path d="M3 17v-4l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 8l2 5v4"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/><path d="M3 13h18"/>',
        flower: '<path d="M12 22V12"/><circle cx="12" cy="8" r="4"/><path d="M12 16c-3 0-5-2-5-4"/><path d="M12 16c3 0 5-2 5-4"/>',
        cake: '<path d="M4 21h16"/><path d="M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7"/><path d="M5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0"/><path d="M12 12V8"/><path d="M12 5.5v.01"/>',
        boat: '<path d="M2 20c2 1 4 1 6 0s4-1 6 0 4 1 6 0"/><path d="M4 17 3 13h18l-2 4"/><path d="M12 13V3l6 7H12"/>',
        map: '<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><path d="M9 3v15M15 6v15"/>',
        sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        party: '<path d="M5.8 11.3 2 22l10.7-3.8"/><path d="M4 3h.01M22 8h.01M15 2h.01M22 20h.01"/><path d="m22 2-2.2.7a2.9 2.9 0 0 0-1.9 3.4c.1.5-.2 1-.7 1.1-.7.1-1.4.5-1.8 1.1L15 9"/><path d="M11 13c1.9 1.9 2.4 4.4 1.1 5.7s-3.8.8-5.7-1.1S4 13.2 5.3 11.9 9.1 11.1 11 13z"/>',
        globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
        logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><path d="M21 12H9"/>'
    };
    function UIcon(name, opt) {
        opt = opt || {};
        var inner = P[name] || P.sparkles;
        return '<span class="ui-ic' + (opt.cls ? ' ' + opt.cls : '') + '" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (opt.sw || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg></span>';
    }
    // Statik HTML: <span data-ic="ad"></span> → ikon
    function hydrate(root) {
        (root || document).querySelectorAll('[data-ic]').forEach(function (el) {
            if (el.getAttribute('data-ic-done')) return;
            el.innerHTML = UIcon(el.getAttribute('data-ic'), { sw: el.getAttribute('data-ic-sw') });
            el.setAttribute('data-ic-done', '1');
        });
    }
    function injectCss() {
        if (document.getElementById('ui-icons-css')) return;
        var st = document.createElement('style');
        st.id = 'ui-icons-css';
        st.textContent = '.ui-ic{display:inline-flex;align-items:center;justify-content:center;width:1.15em;height:1.15em;'
            + 'vertical-align:-.22em;flex-shrink:0;line-height:1}.ui-ic svg{width:100%;height:100%;display:block}'
            + '[data-ic]{display:inline-flex;align-items:center;justify-content:center}';
        (document.head || document.documentElement).appendChild(st);
    }
    // Bilinmeyen ad yedek ikona düşer; testler adın gerçekten tanımlı olduğunu buradan doğrular.
    UIcon.has = function (name) { return Object.prototype.hasOwnProperty.call(P, name); };
    window.UIcon = UIcon;
    window.UIconHydrate = hydrate;
    injectCss();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { hydrate(); });
    else hydrate();
})();
