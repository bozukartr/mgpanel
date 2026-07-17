/* Hotizy — paylaşımlı toast bildirimi.
 *
 * admin.js/request-catalog.js/issue-config-admin.js/menus-admin.js her biri
 * kendi küçük toast() kopyasını taşıyordu (aynı #toast elemanını, aynı
 * className kalıbını kullanan ~4 ayrı fonksiyon). Tek bir yerde toplanır;
 * her sayfa `js/utils/toast.js`'i admin.js'ten ÖNCE yükler, tüm modüller
 * aynı window.showToast()'u çağırır.
 */
(function (global) {
    'use strict';
    let timer = null;
    function showToast(message, isError) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = message;
        el.className = 'toast-notification show' + (isError ? ' error' : '');
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { el.className = 'toast-notification'; }, 3000);
    }
    global.showToast = showToast;
})(window);
