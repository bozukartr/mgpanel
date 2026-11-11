/* Hizmet kataloğu — "Varsayılanları kaldır" ve misafir sepeti.
 *
 * 1) Eskiden yalnızca İSİM eşleşmesine bakılıyordu: otelin kendi eklediği
 *    aynı adlı kalemler ("Su", "Terlik"…) ve varsayılandan yüklenip sonra
 *    düzenlenmiş kalemler de siliniyordu. Artık yalnızca varsayılanla içerik
 *    olarak aynı (hiç düzenlenmemiş) kalemler silinir.
 * 2) Silinen/pasife alınan hizmet misafirin sepetinde kalıp gönderilebiliyordu;
 *    katalog sunucudan geldiğinde sepet temizlenir.
 * Kaynaktan okunur (kopya değil). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
function slice(src, a, b) {
    const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
    assert.ok(i > -1 && j > i, 'blok bulunamadı: ' + a);
    return src.slice(i, j);
}
const cat = read('js/modules/request-catalog.js');
const code = [
    slice(cat, '    const DEFAULTS = [', '\n\n    function esc('),
    slice(cat, '    function parseEtaText(txt) {', '    function minsToHHMM('),
    slice(cat, "    const lc = (v) =>", '    // "Varsayılanları kaldır" — HER ZAMAN')
].join('\n') + '\n;this.isUntouchedDefault = isUntouchedDefault; this.DEFAULTS = DEFAULTS;';
const ctx = {};
vm.runInNewContext(code, ctx);
const { isUntouchedDefault, DEFAULTS } = ctx;
const def = (name) => JSON.parse(JSON.stringify(DEFAULTS.find((d) => d.name === name)));

test('varsayılandan yüklenmiş, dokunulmamış kalem kaldırılabilir', () => {
    const seeded = Object.assign({ tenantId: 't', description: '', active: true, sortOrder: 10 }, def('Oda Temizliği'));
    assert.equal(isUntouchedDefault(seeded), true);
    // Pasife alınmış ama içeriği aynı → yine varsayılan
    assert.equal(isUntouchedDefault(Object.assign({}, seeded, { active: false })), true);
});

test('modalda değiştirmeden kaydedilmiş varsayılan (yeni alan biçimi) kaldırılabilir', () => {
    const d = def('Su');
    const resaved = { tenantId: 't', name: 'Su', category: d.category, subcategory: '', icon: d.icon, department: d.department,
        description: '', etaMin: 15, etaMax: 15, eta: '15 dk', price: 0, maxQty: 0, availFrom: '', availTo: '', active: true, options: [], modifiers: [] };
    assert.equal(isUntouchedDefault(resaved), true);
});

test('düzenlenmiş varsayılan veya otelin kendi eklediği aynı adlı kalem KORUNUR', () => {
    const base = Object.assign({ description: '' }, def('Çay / Kahve'));
    assert.equal(isUntouchedDefault(Object.assign({}, base, { price: 90 })), false, 'fiyat değişti');
    assert.equal(isUntouchedDefault(Object.assign({}, base, { description: 'Türk kahvesi dahil' })), false, 'açıklama eklendi');
    assert.equal(isUntouchedDefault(Object.assign({}, base, { options: [{ name: 'Şekersiz', priceDelta: 0 }] })), false, 'seçenek eklendi');
    assert.equal(isUntouchedDefault(Object.assign({}, base, { etaMin: 5, etaMax: 10 })), false, 'süre değişti');
    // Otelin kendi "Su" kalemi: farklı kategori ve fiyat
    assert.equal(isUntouchedDefault({ name: 'Su', category: 'Minibar', department: 'Yiyecek & İçecek', icon: '🚰', price: 25 }), false);
    // Varsayılan listesinde olmayan ad
    assert.equal(isUntouchedDefault({ name: 'Spa Randevusu', category: 'Spa' }), false);
});

test('"Varsayılanları kaldır" her zaman pencere açar; dokunulmamışlar işaretli, düzenlenmişler işaretsiz gelir', () => {
    const fn = slice(cat, '    function openUnseedModal() {', '    function closeUnseedModal()');
    // Erken dönüş (yalnızca bildirim gösterip pencere açmama) yok.
    assert.doesNotMatch(fn, /return;/);
    assert.match(fn, /\$\('catUnseedModal'\)\.style\.display = 'flex'/);
    assert.match(fn, /isUntouchedDefault\(i\)/);
    assert.match(fn, /r\.untouched \? 'checked' : ''/);
    assert.match(cat, /\$\('catUnseedBtn'\)\.onclick = openUnseedModal/);
    // Silme yalnızca SEÇİLENLERE uygulanır.
    const del = slice(cat, '    function confirmUnseed() {', '    // ── Guest page settings');
    assert.match(del, /unseedSelected\(\)/);
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
    for (const id of ['catUnseedModal', 'unseedList', 'unseedConfirm', 'unseedCancel', 'unseedEmpty', 'unseedAll', 'unseedNone']) {
        assert.match(html, new RegExp('id="' + id + '"'), id);
    }
    assert.doesNotMatch(cat, /kendi eklediğiniz\/adını değiştirdiğiniz talepler etkilenmez/);
});

test('misafir sepeti: artık sunulmayan kalem çıkarılır, bağlantı hatasında sepet silinmez', () => {
    const g = read('js/modules/guest-order.js');
    const block = slice(g, '    let catalogLive = false;', '    function listenCatalog(onFirst) {');
    const run = (live, cart, catalog) => {
        const c = { cart: cart.slice(), catalog, DEMO: false, saved: 0, toasts: [],
            saveCart() { c.saved++; }, renderCartUI() {}, toast(m) { c.toasts.push(m); }, t: (k, p) => k + ':' + (p && p.names) };
        vm.runInNewContext(block.replace('let catalogLive = false;', 'var catalogLive = ' + live + ';')
            + '\n;this.r = pruneCart(); this.cartOut = cart;', c);
        return c;
    };
    const cart = [{ catalogId: 'a', name: 'Havlu' }, { catalogId: 'b', name: 'Oda Temizliği' }];
    const ok = run(true, cart, [{ id: 'a' }]);
    assert.equal(ok.r, true);
    assert.deepEqual(JSON.parse(JSON.stringify(ok.cartOut)).map((l) => l.catalogId), ['a']);
    assert.match(ok.toasts[0], /Oda Temizliği/);
    const offline = run(false, cart, []);
    assert.equal(offline.r, false);
    assert.equal(offline.cartOut.length, 2);
    // Gönderimden önce de çalışır
    assert.match(slice(g, '    function submitOrder() {', 'if (!cart.length || !sessionUid) return;'), /pruneCart\(\)/);
});
