/* Ürün içerikleri: gruplu ekstra / çıkart + ekstra adedi.
 *
 * Oda servisi siparişleri artık yemek sipariş uygulamalarındaki gibi çalışıyor:
 * bileşenler başlıklı gruplara ayrılıyor ve bir ekstra birden fazla kez
 * eklenebiliyor (2× Ekstra Peynir). Bu testler fiyat hesabının adetle
 * çarptığını, grup varsayılanlarının doğru düştüğünü ve GRUPSUZ/ADETSİZ eski
 * kayıtların bozulmadığını kilitler.
 *
 * İstemci bloğu KAYNAKTAN okunup değerlendirilir (kopyası değil). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const orderBridge = require('../functions/order-bridge');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'guest-order.js'), 'utf8');
const start = src.indexOf('    function normalizeModifier(m) {');
const endMarker = '    function modLabel(m, qty)';
const end = src.indexOf('\n', src.indexOf('}', src.indexOf(endMarker))) + 1;
assert.ok(start > -1 && end > start, 'guest-order.js modifier bloğu bulunamadı');
const block = src.slice(start, end);

const api = new Function('MAX_MOD_QTY', 't', `
    ${block}
    return { normalizeModifier: normalizeModifier, modifiersOf: modifiersOf, selList: selList,
             selQty: selQty, modifiersDelta: modifiersDelta, modifierGroups: modifierGroups, modLabel: modLabel };
`)(10, (k) => (k === 'guest.item.groupExtras' ? 'Ekstralar' : 'Çıkarılacaklar'));

const burger = {
    modifiers: [
        { name: 'Ekstra Peynir', type: 'extra', priceDelta: 20, maxQty: 3 },
        { name: 'Ekstra Sos', type: 'extra', priceDelta: 10, group: 'Soslar' },
        { name: 'Soğansız', type: 'remove', priceDelta: 0 }
    ]
};
// Adet/grup alanı HİÇ olmayan eski kayıt.
const legacy = { modifiers: [{ name: 'Buzsuz', type: 'remove' }, { name: 'Ekstra Limon', type: 'extra', priceDelta: 5 }] };

test('ekstra fiyat farkı ADETLE çarpılır', () => {
    assert.equal(api.modifiersDelta(burger, [{ name: 'Ekstra Peynir', qty: 2 }]), 40);
    assert.equal(api.modifiersDelta(burger, [{ name: 'Ekstra Peynir', qty: 3 }, { name: 'Ekstra Sos', qty: 1 }]), 70);
});

test('ESKİ biçim (yalnızca adlar) 1 adet sayılır — geriye dönük uyum', () => {
    assert.equal(api.modifiersDelta(burger, ['Ekstra Peynir']), 20);
    assert.equal(api.modifiersDelta(burger, ['Ekstra Peynir', 'Ekstra Sos']), 30);
});

test('bilinmeyen bileşen fiyata etki etmez', () => {
    assert.equal(api.modifiersDelta(burger, [{ name: 'Yok Böyle', qty: 5 }]), 0);
    assert.equal(api.modifiersDelta(burger, []), 0);
    assert.equal(api.modifiersDelta(burger, null), 0);
});

test('maxQty yalnızca ekstralarda geçerli; çıkarmalarda hep 1', () => {
    const mods = api.modifiersOf(burger);
    assert.equal(mods[0].maxQty, 3);
    assert.equal(mods[2].maxQty, 1);
    // Uydurma büyük değerler üst sınıra kırpılır (firestore.rules ile aynı sınır).
    assert.equal(api.normalizeModifier({ name: 'X', type: 'extra', maxQty: 999 }).maxQty, 10);
    assert.equal(api.normalizeModifier({ name: 'X', type: 'remove', maxQty: 5 }).maxQty, 1);
});

test('grup verilmemişse TİPE göre varsayılan başlığa düşer', () => {
    const g = api.modifierGroups(burger).map(x => x.key);
    assert.deepEqual(g, ['Ekstralar', 'Soslar', 'Çıkarılacaklar']);
    // Eski (grupsuz) kayıt da düzgün gruplanır — hiçbir migration gerekmez.
    assert.deepEqual(api.modifierGroups(legacy).map(x => x.key), ['Çıkarılacaklar', 'Ekstralar']);
});

test('adı boş bileşen hiçbir gruba girmez', () => {
    assert.deepEqual(api.modifierGroups({ modifiers: [{ name: '  ', type: 'extra' }] }), []);
});

test('etiket adet gösterir', () => {
    assert.equal(api.modLabel(api.normalizeModifier({ name: 'Ekstra Peynir', type: 'extra' }), 2), '+ Ekstra Peynir ×2');
    assert.equal(api.modLabel(api.normalizeModifier({ name: 'Soğansız', type: 'remove' }), 1), '− Soğansız');
});

// ── Personelin gördüğü metin (sunucu tarafı) ──
test('guestLogs metni ekstra adedini yazar', () => {
    const txt = orderBridge.itemComplaintText({
        name: 'Cheeseburger', qty: 1,
        modifiers: [{ name: 'Ekstra Peynir', type: 'extra', qty: 2 }, { name: 'Soğansız', type: 'remove' }]
    });
    assert.match(txt, /\+ Ekstra Peynir x2/);
    assert.match(txt, /− Soğansız/);
    assert.doesNotMatch(txt, /Soğansız x1/, 'tek adette çarpan yazılmamalı');
});

test('adı boş bileşen personel metnine sızmaz', () => {
    const txt = orderBridge.itemComplaintText({ name: 'X', qty: 1, modifiers: [{ name: '', type: 'extra' }] });
    assert.doesNotMatch(txt, /Özelleştirme/);
});
