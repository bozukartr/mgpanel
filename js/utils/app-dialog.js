/* Hotizy — paylaşımlı uygulama-içi dialog sistemi (confirm/prompt/info).
 *
 * Native tarayıcı confirm()/prompt() yerine geçer — ~10 çağrı noktası
 * (kullanıcı silme, şifre sıfırlama sonrası geçici şifre gösterimi, konu
 * ekle/sil, talep/departman/menü silme, "Sistemi Sıfırla" iki adımlı onayı)
 * bu API'ye taşınır. Mevcut `.modal`/`.modal-content` sınıflarının ÜZERİNE
 * kurulur — js/utils/modal-guard.js ve css/core/mobile-sheet.css bu sınıf
 * adlarına göre çalışır, ikisine de dokunulmadı.
 *
 * API (Promise tabanlı — bu kod tabanında zaten yaygın async/await deseniyle
 * birebir uyumlu):
 *   AppDialog.confirm({title, message, danger, confirmText, cancelText}) → Promise<boolean>
 *   AppDialog.prompt({title, message, placeholder, value, confirmText})  → Promise<string|null>
 *   AppDialog.info({title, message, copyValue, closeText})              → Promise<void>
 *
 * Tek-seferlik çözümleme (resolve-once) BURADA, merkezi olarak garanti
 * edilir: native confirm() senkron/bloklayıcıydı — sayfadaki hiçbir buton
 * (tetikleyicinin kendisi dahil) o sırada tıklanamazdı. Bu dialog ASENKRON
 * olduğundan, aynı butona hızlı çift tıklama iki ayrı "Tamam" tıklamasına
 * yol açabilir; `settle()` ikinci çağrıda hiçbir şey yapmayarak bunu
 * merkezi olarak engeller — her çağıran ayrıca kendi tetikleyici butonunu
 * disable etmelidir (bkz. Sistem sekmesi "Sistemi Sıfırla" akışı).
 */
(function (global) {
    'use strict';

    let activeSettle = null; // yalnızca bir dialog aktif olabilir; resolve-once buradan garanti edilir

    function root() {
        let el = document.getElementById('appDialog');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'appDialog';
        el.className = 'modal';
        el.innerHTML = `
            <div class="modal-content small-modal ad-box">
                <div class="modal-header">
                    <h3 id="adTitle">Onayla</h3>
                </div>
                <div class="modal-body">
                    <p id="adMessage" class="ad-msg"></p>
                    <input type="text" id="adInput" class="ad-input" style="display:none;" autocomplete="off">
                    <div id="adCopyBox" class="ad-copy" style="display:none;">
                        <code id="adCopyValue"></code>
                        <button type="button" class="btn btn-ghost" id="adCopyBtn">Kopyala</button>
                    </div>
                </div>
                <div class="modal-actions">
                    <button type="button" class="action-btn secondary" id="adCancel">Vazgeç</button>
                    <button type="button" class="action-btn save-btn" id="adOk">Tamam</button>
                </div>
            </div>`;
        document.body.appendChild(el);
        return el;
    }

    function settle(value) {
        const cb = activeSettle;
        activeSettle = null; // ikinci çağrı sessizce yok sayılır (resolve-once)
        const el = document.getElementById('appDialog');
        if (el) el.style.display = 'none';
        if (cb) cb(value);
    }

    function open(cfg) {
        return new Promise(resolve => {
            // Zaten açık bir dialog varsa (beklenmedik çift tetikleme) — öncekini
            // "iptal" sonucuyla kapat, iki promise aynı anda asılı kalmasın.
            if (activeSettle) settle(cfg.cancelValue !== undefined ? cfg.cancelValue : false);
            activeSettle = resolve;

            const el = root();
            const okBtn = el.querySelector('#adOk');
            const cancelBtn = el.querySelector('#adCancel');
            const input = el.querySelector('#adInput');
            const copyBox = el.querySelector('#adCopyBox');
            const copyValueEl = el.querySelector('#adCopyValue');
            const copyBtn = el.querySelector('#adCopyBtn');

            el.querySelector('#adTitle').textContent = cfg.title || '';
            el.querySelector('#adMessage').textContent = cfg.message || '';
            el.classList.toggle('ad-danger', !!cfg.danger);

            input.style.display = cfg.mode === 'prompt' ? '' : 'none';
            input.value = cfg.value || '';
            input.placeholder = cfg.placeholder || '';

            copyBox.style.display = cfg.copyValue ? '' : 'none';
            if (cfg.copyValue) {
                copyValueEl.textContent = cfg.copyValue;
                copyBtn.onclick = () => {
                    navigator.clipboard?.writeText(cfg.copyValue).then(() => {
                        copyBtn.textContent = 'Kopyalandı ✓';
                        setTimeout(() => { copyBtn.textContent = 'Kopyala'; }, 1600);
                    }).catch(() => {});
                };
            }

            cancelBtn.style.display = cfg.mode === 'info' ? 'none' : '';
            okBtn.textContent = cfg.confirmText || (cfg.mode === 'info' ? 'Kapat' : 'Tamam');
            cancelBtn.textContent = cfg.cancelText || 'Vazgeç';
            okBtn.className = 'action-btn save-btn' + (cfg.danger ? ' ad-danger-btn' : '');

            okBtn.onclick = () => {
                if (cfg.mode === 'prompt') settle(input.value.trim() || null);
                else if (cfg.mode === 'confirm') settle(true);
                else settle(undefined);
            };
            cancelBtn.onclick = () => settle(cfg.mode === 'prompt' ? null : false);
            input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } };

            el.style.display = 'flex';
            setTimeout(() => { (cfg.mode === 'prompt' ? input : okBtn).focus(); }, 30);
        });
    }

    global.AppDialog = {
        confirm(opts) {
            opts = opts || {};
            return open(Object.assign({}, opts, { mode: 'confirm' }));
        },
        prompt(opts) {
            opts = opts || {};
            return open(Object.assign({}, opts, { mode: 'prompt' }));
        },
        info(opts) {
            opts = opts || {};
            return open(Object.assign({}, opts, { mode: 'info' }));
        }
    };
})(window);
