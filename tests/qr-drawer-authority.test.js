/* QR talep çekmecesi (js/modules/guest-orders.js) — departman yetkisi.
 *
 * OPERASYONEL HATA: çekmece departman kuralını HİÇ uygulamıyordu. Teknik
 * departmanı personeli, Kat Hizmetleri'ne düşen bir QR talebini onaylayıp
 * tamamlayabiliyordu — panel.js aynı kaydı `guestLogs` üzerinden katı biçimde
 * kısıtlarken (takeBlockReason). Aynı iş, açıldığı yüzeye göre iki farklı
 * kurala tabiydi.
 *
 * Kural KAYNAKTAN okunup değerlendirilir (kopyası değil): guest-orders.js bir
 * tarayıcı script'i olduğundan (module.exports yok) ilgili saf blok dosyadan
 * alınır, dış bağımlılıkları (sameDept, personelin departmanı/rolü) enjekte
 * edilir. Böylece test, gerçekte çalışan kodun davranışını kilitler. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sameDept } = require('../functions/order-bridge');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'guest-orders.js'), 'utf8');
const start = src.indexOf('    const CAT_TO_DEPT = [');
const endMarker = 'function blockedItems(o) {';
const end = src.indexOf('}', src.indexOf(endMarker) + endMarker.length) + 1;
assert.ok(start > -1 && end > start, 'guest-orders.js departman yetkisi bloğu bulunamadı');
const block = src.slice(start, end);

// Bloğu verilen personel kimliğiyle değerlendirir.
function asStaff({ dept, role, username }) {
    return new Function('sameDept', 'MY_DEPT', 'isManager', `
        ${block}
        return { itemBlockReason: itemBlockReason, canActOnItem: canActOnItem,
                 actionableItems: actionableItems, blockedItems: blockedItems, itemDept: itemDept };
    `)(sameDept, dept, () => role === 'admin' || role === 'manager' || String(username || '').toLowerCase() === 'admin');
}

const TEKNIK = asStaff({ dept: 'Teknik', role: 'staff', username: 'ahmet' });
const KAT = asStaff({ dept: 'Kat Hizmetleri', role: 'staff', username: 'merve' });
const MUDUR = asStaff({ dept: 'Teknik', role: 'manager', username: 'selin' });

const hkItem = { id: 'i1', name: 'Havlu Değişimi', department: 'Housekeeping', status: 'pending' };
const teknikItem = { id: 'i2', name: 'Klima arızası', department: 'Teknik', status: 'pending' };
const sahipsiz = { id: 'i3', name: 'Bilinmeyen', department: '', category: 'Havuz', status: 'pending' };

test('BAŞKA departmanın kalemini personel İŞLEYEMEZ', () => {
    // Bildirilen hata: Teknik personeli Housekeeping talebini onaylayıp tamamladı.
    assert.ok(!TEKNIK.canActOnItem(hkItem));
    assert.match(TEKNIK.itemBlockReason(hkItem), /departmanına ait/);
    assert.ok(!KAT.canActOnItem(teknikItem));
});

test('KENDİ departmanının kalemini personel işleyebilir', () => {
    assert.equal(TEKNIK.itemBlockReason(teknikItem), null);
    assert.equal(KAT.itemBlockReason(hkItem), null); // Housekeeping ↔ Kat Hizmetleri
});

test('yönetici/admin her departmanın kalemini işleyebilir', () => {
    assert.equal(MUDUR.itemBlockReason(hkItem), null);
    assert.equal(MUDUR.itemBlockReason(teknikItem), null);
    assert.equal(asStaff({ dept: '', role: '', username: 'admin' }).itemBlockReason(hkItem), null);
});

test('departmanı ÇÖZÜLEMEYEN kalemi herkes üstlenebilir (sahipsiz kalmasın)', () => {
    // order-bridge ile aynı güvenli başarısızlık: yanlış departmana kilitlemek
    // yerine boş bırakılır; boş departman herkese açıktır.
    assert.equal(TEKNIK.itemDept(sahipsiz), '');
    assert.equal(TEKNIK.itemBlockReason(sahipsiz), null);
    assert.equal(KAT.itemBlockReason(sahipsiz), null);
});

test('departman boşsa KATEGORİDEN çözülür ve kural ona göre işler', () => {
    const fnb = { id: 'i4', name: 'Kahve', department: '', category: 'Yiyecek & İçecek', status: 'pending' };
    assert.equal(TEKNIK.itemDept(fnb), 'Yiyecek & İçecek');
    assert.ok(!TEKNIK.canActOnItem(fnb));
    assert.ok(asStaff({ dept: 'Mutfak', role: 'staff', username: 'can' }).canActOnItem(fnb)); // eşanlamlı
});

test('toplu işlem kapsamı YALNIZCA yetkili kalemleri içerir', () => {
    const order = { items: [hkItem, teknikItem, sahipsiz] };
    assert.deepEqual(TEKNIK.actionableItems(order).map(i => i.id), ['i2', 'i3']);
    assert.deepEqual(TEKNIK.blockedItems(order).map(i => i.id), ['i1']);
    assert.equal(MUDUR.blockedItems(order).length, 0);
});

test('Concierge (resId) ve iptal edilmiş kalemler toplu işlem kapsamı DIŞINDA', () => {
    const order = {
        items: [
            Object.assign({}, teknikItem, { id: 'r1', resId: 'res_1' }),
            Object.assign({}, teknikItem, { id: 'c1', status: 'cancelled' }),
            teknikItem
        ]
    };
    assert.deepEqual(TEKNIK.actionableItems(order).map(i => i.id), ['i2']);
});
