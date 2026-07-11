/* Hotizy — tembel (lazy) script yükleyici.
 *
 * Ağır dışa-aktarma kütüphaneleri (jsPDF ~360KB, jspdf-autotable, XLSX
 * ~430KB, html2pdf ~370KB) önceden sayfa açılışında eager yükleniyordu —
 * oysa yalnızca kullanıcı "dışa aktar / PDF" tıkladığında lazımlar (bkz.
 * hız denetimi). Bu yardımcı, bir script'i İLK ihtiyaç anında bir kez
 * yükler; tekrar çağrılar aynı promise'i paylaşır.
 *
 * Kullanım:
 *   await loadScriptOnce('https://cdn.../xlsx.full.min.js');
 *   await loadScriptsOnce([urlA, urlB]);   // sıralı (bağımlılık için)
 */
(function (global) {
    'use strict';
    var inflight = {}; // src -> Promise

    function loadScriptOnce(src) {
        if (inflight[src]) return inflight[src];
        inflight[src] = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = function () { resolve(); };
            s.onerror = function () {
                delete inflight[src]; // başarısız oldu — sonraki deneme yeniden indirsin
                reject(new Error('Script yüklenemedi: ' + src));
            };
            document.head.appendChild(s);
        });
        return inflight[src];
    }

    // Sıralı yükleme — eklenti kütüphaneleri (ör. jspdf-autotable) ana
    // kütüphaneden sonra yüklenmeli.
    async function loadScriptsOnce(srcs) {
        for (var i = 0; i < srcs.length; i++) await loadScriptOnce(srcs[i]);
    }

    global.loadScriptOnce = loadScriptOnce;
    global.loadScriptsOnce = loadScriptsOnce;
})(window);
