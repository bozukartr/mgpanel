/* Hotizy — embed.js
 * Panel sayfaları App Shell (app.html) iframe'i içinde gömülü çalıştığında
 * kendi header/nav/alt-nav'larını gizler ve shell'e hangi sayfada olduğunu bildirir.
 * Bağımsız (standalone) açıldığında HİÇBİR şeyi değiştirmez — mevcut davranış korunur.
 * <head> içinde, diğer scriptlerden ÖNCE yüklenmelidir. */
(function () {
    var embedded = false;
    try {
        embedded = /[?&]embed=1/.test(location.search) || window.top !== window.self;
    } catch (e) {
        embedded = true; // top'a erişim engellendiyse bir iframe içindeyiz
    }
    window.__EMBED__ = embedded;
    if (!embedded) return;

    var de = document.documentElement;
    if (de && de.className.indexOf('embed') === -1) de.className += ' embed';

    function route() {
        var f = (location.pathname || '').toLowerCase().split('/').pop()
            .replace(/\.html$/, '').replace(/-mobile$/, '');
        if (f === '' || f === 'dashboard' || f === 'app') return 'dashboard';
        if (f === 'concierge') return 'concierge';
        if (f === 'panel') return 'kayitlar';
        if (f === 'crm') return 'crm';
        return '';
    }
    function notify() {
        try { window.parent.postMessage({ __mgShell: 1, type: 'route', route: route() }, '*'); } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notify);
    else notify();
})();
