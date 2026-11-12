/* Hotizy — theme.js · Açık / koyu (gece modu) / sistem teması.
 *
 * <head> içinde, stil dosyalarından ÖNCE yüklenir: sınıf ilk boyamadan önce
 * kurulur (beyaz parlama olmaz). Tercih localStorage'da (hz_theme:
 * 'light' | 'dark' | 'auto'); kabuk ve tüm modül çerçeveleri aynı kökende
 * olduğundan aynı tercihi okur. Bir pencerede değişince diğerleri `storage`
 * olayıyla, kabuk da çerçevelerini doğrudan günceller. 'auto' cihazın açık /
 * koyu ayarını izler. Koyu renkler css/dark/*.dark.css (tools/dark-theme.js).
 */
(function () {
    'use strict';
    var KEY = 'hz_theme';
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function pref() { try { return localStorage.getItem(KEY) || 'light'; } catch (e) { return 'light'; } }
    function isDark(p) { p = p || pref(); return p === 'dark' || (p === 'auto' && !!(mq && mq.matches)); }
    function apply() {
        var d = isDark();
        var h = document.documentElement;
        h.classList.toggle('theme-dark', d);
        h.style.colorScheme = d ? 'dark' : 'light';
        var m = document.querySelector('meta[name="theme-color"]');
        if (m) m.setAttribute('content', d ? '#181b22' : '#ffffff');
    }
    function syncFrames() {
        try {
            Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (f) {
                try { if (f.contentWindow && f.contentWindow.Theme) f.contentWindow.Theme.apply(); } catch (e) {}
            });
        } catch (e) {}
    }
    function set(p) {
        try { localStorage.setItem(KEY, p); } catch (e) {}
        apply();
        syncFrames();
    }
    apply();
    window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
    if (mq) {
        var onChange = function () { if (pref() === 'auto') { apply(); syncFrames(); } };
        if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    window.Theme = { get: pref, set: set, apply: apply, isDark: isDark };
})();
