/* Hotizy — PMS guest lookup (client).
 *
 * When the hotel has PMS enabled, typing a guest name or room number queries
 * the hotel's PMS through the pmsLookup Cloud Function (which holds the API
 * key server-side) and shows a suggestion dropdown. Picking a result fills the
 * name + room (+ check-in/out when available).
 *
 * Requires firebase-functions.js (compat) loaded before this script.
 * Usage:
 *   PMS.attach({ nameInput, roomInput, checkInInput, checkOutInput, onPick });
 */
(function () {
    'use strict';
    const PMS = window.PMS = window.PMS || {};
    let callable = null;
    // Kısa ömürlü önbellek: aynı sorgu yazarken tekrar tekrar PMS'e gitmesin,
    // ama oda değişikliği/yeni giriş birkaç dakika boyunca eski kalmasın
    // (eskiden sayfa açık kaldıkça sonsuza dek saklanıyordu).
    const cache = new Map();
    const CACHE_TTL_MS = 60 * 1000, CACHE_MAX = 60;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    function getFn() {
        if (callable) return callable;
        try { callable = firebase.app().functions('us-central1').httpsCallable('pmsLookup'); }
        catch (e) { callable = null; }
        return callable;
    }

    PMS.enabled = function () {
        return (typeof pmsEnabled === 'function') ? pmsEnabled()
            : localStorage.getItem('hotelPmsEnabled') === '1';
    };

    PMS.lookup = async function (query) {
        const q = String(query || '').trim();
        if (!PMS.enabled() || q.length < 2) return [];
        const key = q.toLocaleLowerCase('tr-TR');
        const hit = cache.get(key);
        if (hit && hit.exp > Date.now()) return hit.results;
        const fn = getFn();
        if (!fn) return [];
        try {
            const res = await fn({ query: q });
            const data = (res && res.data) || {};
            // Demo sağlayıcının sonuçları işaretlenir — listede "DEMO VERİ"
            // olarak gösterilir, personel uydurma misafiri gerçek sanmasın.
            const results = (data.results || []).map(g => Object.assign({}, g, { _demo: data.source === 'mock' }));
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
            cache.set(key, { results, exp: Date.now() + CACHE_TTL_MS });
            return results;
        } catch (e) {
            // Zaman aşımı, yanlış kimlik bilgisi, PMS erişilemez, hız sınırı —
            // önceden hepsi burada sessizce yutulup "sonuç yok" ile ayırt
            // edilemez hale geliyordu (bkz. tutarlılık denetimi). Kullanıcıya
            // hâlâ boş liste dönüyoruz (arama akışını kesmemek için), ama en
            // azından console'da hata türü ayırt edilebiliyor — sunucu
            // tarafında da errorLogs'a yazılıyor (bkz. functions/index.js
            // logPmsFailure), süperadmin "Hatalar" sekmesinde görebiliyor.
            console.error('[PMS] arama başarısız', (e && e.code) || '', (e && e.message) || e);
            return [];
        }
    };

    function injectStyles() {
        if (document.getElementById('pms-styles')) return;
        const css = `
        .pms-dd{position:absolute;z-index:99999;background:#fff;border:1px solid #e2e8f0;border-radius:12px;
            box-shadow:0 18px 50px rgba(15,23,42,.18);overflow:hidden;font-family:'Outfit',sans-serif;max-height:300px;overflow-y:auto}
        .pms-it{padding:10px 13px;cursor:pointer;border-bottom:1px solid #f1f4f9}
        .pms-it:last-of-type{border-bottom:none}
        .pms-it:hover,.pms-it.active{background:#eef2ff}
        .pms-nm{font-size:13.5px;font-weight:700;color:#1e293b;display:flex;align-items:center;gap:7px}
        .pms-vip{font-size:9px;font-weight:800;color:#b45309;background:#fff7ed;border:1px solid #fed7aa;padding:1px 6px;border-radius:6px}
        .pms-mt{font-size:11.5px;color:#64748b;margin-top:2px}
        .pms-src{font-size:10px;font-weight:700;color:#94a3b8;text-align:right;padding:6px 12px;background:#fafbfd;
            display:flex;align-items:center;justify-content:flex-end;gap:6px}
        .pms-src::before{content:"";width:6px;height:6px;border-radius:50%;background:#10b981}
        .pms-src.demo{color:#b45309;background:#fff7ed}
        .pms-src.demo::before{background:#f59e0b}`;
        const el = document.createElement('style');
        el.id = 'pms-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // "PMS açık mı" bayrağı yalnızca GİRİŞTE yazılıyordu (app.js
    // applyTenantConfig): süperadmin entegrasyonu açınca personel çıkış yapıp
    // tekrar girmeden öneri görmüyordu (uygulama günlerce açık kalabiliyor).
    // Sayfa başına bir kez otel dokümanından tazelenir.
    let flagRefreshed = false;
    function refreshFlag() {
        if (flagRefreshed) return;
        flagRefreshed = true;
        try {
            const tid = localStorage.getItem('hotelTenantId');
            if (!tid || typeof firebase === 'undefined') return;
            firebase.firestore().collection('tenants').doc(tid).get().then(d => {
                if (d.exists) localStorage.setItem('hotelPmsEnabled', (d.data() || {}).pmsEnabled ? '1' : '0');
            }).catch(() => {});
        } catch (e) { /* bayrak olduğu gibi kalır */ }
    }

    PMS.attach = function (opts) {
        opts = opts || {};
        const name = opts.nameInput;
        if (!name) return;
        injectStyles();
        refreshFlag();

        const dd = document.createElement('div');
        dd.className = 'pms-dd';
        dd.style.display = 'none';
        document.body.appendChild(dd);
        let items = [], active = -1, anchor = name, timer = null;

        function hide() { dd.style.display = 'none'; active = -1; }
        function position() {
            const r = anchor.getBoundingClientRect();
            dd.style.left = (r.left + window.scrollX) + 'px';
            dd.style.top = (r.bottom + window.scrollY + 4) + 'px';
            dd.style.width = Math.max(r.width, 240) + 'px';
        }
        function pick(g) {
            if (!g) return;
            name.value = g.name || name.value;
            if (opts.roomInput && g.room && g.room !== 'Pre-Arrival') {
                opts.roomInput.disabled = false;
                opts.roomInput.value = g.room;
            }
            // Sunucu tarihleri YYYY-MM-DD'ye normalize eder; <input type="date">
            // başka biçimi sessizce boşaltır, o yüzden yalnızca bu biçim yazılır.
            const iso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
            if (opts.checkInInput && iso(g.checkIn)) opts.checkInInput.value = g.checkIn;
            if (opts.checkOutInput && iso(g.checkOut)) opts.checkOutInput.value = g.checkOut;
            if (typeof opts.onPick === 'function') opts.onPick(g);
            hide();
            // Let existing autofill / validation logic react to the new value.
            name.dispatchEvent(new Event('input', { bubbles: true }));
        }
        function render(list) {
            items = list || [];
            if (!items.length) { hide(); return; }
            dd.innerHTML = items.map((g, i) =>
                `<div class="pms-it" data-i="${i}">
                    <div class="pms-nm">${esc(g.name) || '—'}${g.vip ? ' <span class="pms-vip">VIP</span>' : ''}</div>
                    <div class="pms-mt">Oda ${esc(g.room || '—')}${g.checkIn ? ' · ' + esc(g.checkIn) + ' → ' + esc(g.checkOut || '') : ''}</div>
                </div>`).join('') + (items.some(g => g._demo)
                    ? '<div class="pms-src demo">DEMO VERİ — gerçek misafir değil</div>'
                    : '<div class="pms-src">PMS</div>');
            position();
            dd.style.display = 'block';
            dd.querySelectorAll('.pms-it').forEach(el =>
                el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(items[+el.dataset.i]); }));
        }

        function bind(input) {
            input.addEventListener('input', () => {
                anchor = input;
                clearTimeout(timer);
                const q = input.value.trim();
                if (!PMS.enabled() || q.length < 2) { hide(); return; }
                timer = setTimeout(async () => {
                    const list = await PMS.lookup(q);
                    if (document.activeElement === input && input.value.trim() === q) render(list);
                }, 320);
            });
            input.addEventListener('focus', () => { anchor = input; });
            input.addEventListener('blur', () => setTimeout(hide, 160));
            input.addEventListener('keydown', (e) => {
                if (dd.style.display !== 'block') return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    active = e.key === 'ArrowDown'
                        ? Math.min(active + 1, items.length - 1)
                        : Math.max(active - 1, 0);
                    dd.querySelectorAll('.pms-it').forEach((el, i) => el.classList.toggle('active', i === active));
                } else if (e.key === 'Enter' && active >= 0) {
                    e.preventDefault(); pick(items[active]);
                } else if (e.key === 'Escape') { hide(); }
            });
        }
        bind(name);
        if (opts.roomInput) bind(opts.roomInput);
        window.addEventListener('scroll', () => { if (dd.style.display === 'block') position(); }, true);
        window.addEventListener('resize', () => { if (dd.style.display === 'block') position(); });
    };
})();
