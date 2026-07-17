/* QR sipariş → Misafir Kayıtları köprüsü (order-bridge) — saf birim testleri:
 * kalem başına kayıt, departman eşleme, deterministik ID (idempotency),
 * mevcut logId'ye dokunmama, kimlik alanlarının taşınması. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const bridge = require('../functions/order-bridge');

const ORDER = {
  tenantId: 'hotel-a', room: '204', guestName: '',
  items: [
    { id: 'itm1', name: 'Havlu', qty: 2, category: 'Temizlik' },
    { id: 'itm2', name: 'Klima Arızası', qty: 1, category: 'Teknik Servis', note: 'Ses yapıyor' },
    { id: 'itm3', name: 'Su', qty: 1, department: 'Room Service' }
  ]
};

test('kalem başına kayıt + kategori→departman eşlemesi', () => {
  const r = bridge.buildOrderLogDocs(ORDER, 'ord1', { guestName: 'Ali Veli' });
  assert.strictEqual(r.docs.length, 3);
  const byItem = {}; r.docs.forEach(d => byItem[d.data.itemId] = d);
  assert.strictEqual(byItem.itm1.data.department, 'Housekeeping');   // Temizlik →
  assert.strictEqual(byItem.itm2.data.department, 'Engineering');    // Teknik Servis →
  assert.strictEqual(byItem.itm3.data.department, 'Room Service');   // açık department kazanır
  assert.strictEqual(byItem.itm1.data.status, 'Following');
  assert.strictEqual(byItem.itm1.data.type, 'request');
  assert.strictEqual(byItem.itm1.data.source, 'guest-order');
  assert.strictEqual(byItem.itm1.data.orderId, 'ord1');
  assert.strictEqual(byItem.itm1.data.guestName, 'Ali Veli');
  assert.ok(byItem.itm2.data.complaint.includes('Klima Arızası'));
  assert.ok(byItem.itm2.data.complaint.includes('Not: Ses yapıyor'));
  assert.ok(byItem.itm1.data.complaint.includes('x2'));
});

test('deterministik kimlik: aynı sipariş için aynı ID (idempotent)', () => {
  const a = bridge.buildOrderLogDocs(ORDER, 'ord1', {});
  const b = bridge.buildOrderLogDocs(ORDER, 'ord1', {});
  assert.deepStrictEqual(a.docs.map(d => d.id), b.docs.map(d => d.id));
  assert.strictEqual(a.docs[0].id, 'qr_ord1_itm1');
});

test('logId kalemlere geri yazılır; zaten bağlı kalem ATLANIR', () => {
  const order = { tenantId: 'hotel-a', room: '204', items: [
    { id: 'a', name: 'X', logId: 'mevcut-log' },
    { id: 'b', name: 'Y' }
  ]};
  const r = bridge.buildOrderLogDocs(order, 'ord2', {});
  assert.strictEqual(r.docs.length, 1, 'yalnız bağsız kalem için kayıt');
  assert.strictEqual(r.items[0].logId, 'mevcut-log', 'mevcut bağa dokunulmaz');
  assert.strictEqual(r.items[1].logId, 'qr_ord2_b');
});

test('kimlik alanları (guestId/stayId) kayda taşınır', () => {
  const r = bridge.buildOrderLogDocs(ORDER, 'ord3', { guestId: 'g1', stayId: 's1', guestName: 'Ali' });
  assert.strictEqual(r.docs[0].data.guestId, 'g1');
  assert.strictEqual(r.docs[0].data.stayId, 's1');
});

test('concierge kalemi: guestLogs ATLANIR, Pending rezervasyon üretilir', () => {
  const order = { tenantId: 'hotel-a', room: '204', items: [
    { id: 'c1', name: 'Havalimanı Transferi', qty: 1, category: 'Concierge', note: '2 valiz', preferredTime: '09:30' },
    { id: 'c2', name: 'Restoran Rezervasyonu', department: 'Concierge' },
    { id: 'n1', name: 'Havlu', category: 'Temizlik' }
  ]};
  // 1) Log köprüsü concierge kalemlerini atlar
  const logs = bridge.buildOrderLogDocs(order, 'ordC', { guestName: 'Ali' });
  assert.strictEqual(logs.docs.length, 1, 'yalnız normal kalem log olur');
  assert.strictEqual(logs.docs[0].data.itemId, 'n1');
  assert.strictEqual(logs.items[0].logId, undefined, 'concierge kaleme logId yazılmaz');
  // 2) Rezervasyon köprüsü yalnız concierge kalemlerini işler
  const res = bridge.buildOrderReservationDocs(order, 'ordC', { guestName: 'Ali', guestId: 'g1' });
  assert.strictEqual(res.docs.length, 2);
  const tr = res.docs.find(d => d.data.itemId === 'c1');
  assert.strictEqual(tr.data.status, 'Pending');
  assert.strictEqual(tr.data.type, 'Transfer', 'adı transfer içeren kalem Transfer tipi');
  assert.strictEqual(tr.data.source, 'guest-order');
  assert.ok(tr.data.notes.includes('2 valiz'));
  assert.strictEqual(tr.data.time, '09:30');
  assert.strictEqual(tr.data.guestId, 'g1');
  const other = res.docs.find(d => d.data.itemId === 'c2');
  assert.strictEqual(other.data.type, 'Other');
  assert.strictEqual(other.data.otherType, 'Restoran Rezervasyonu');
  // 3) resId geri yazımı + deterministik kimlik + idempotens
  assert.strictEqual(res.items[0].resId, 'qr_ordC_c1');
  assert.strictEqual(res.items[2].resId, undefined, 'normal kaleme resId yazılmaz');
  const again = bridge.buildOrderReservationDocs({ tenantId: 'hotel-a', room: '204', items: res.items }, 'ordC', {});
  assert.strictEqual(again.docs.length, 0, 'resId bağlı kalem yeniden üretilmez');
});

test('concierge seçenek (ör. VIP Transfer → Vito): Transfer kalemi vehicle alanına yazılır', () => {
  const order = { tenantId: 'hotel-a', room: '204', items: [
    { id: 't1', name: 'VIP Transfer', qty: 1, category: 'Concierge', option: 'Vito', note: 'Havalimanından' }
  ]};
  const res = bridge.buildOrderReservationDocs(order, 'ordT', { guestName: 'Ali' });
  assert.strictEqual(res.docs.length, 1);
  const d = res.docs[0].data;
  assert.strictEqual(d.type, 'Transfer');
  assert.strictEqual(d.vehicle, 'Vito', 'concierge.js Transfer görünümünün beklediği alan');
  assert.strictEqual(d.resName, 'VIP Transfer — Vito', 'personel arama/liste ekranında seçenek görünür');
  assert.ok(!d.notes.includes('Seçenek:'), 'Transfer tipinde seçenek notes yerine vehicle alanına gider (mükerrer olmasın)');
  assert.ok(d.notes.includes('Havalimanından'), 'ayrıca girilen not korunur');
});

test('concierge seçenek: Other tipi kalemde otherType/resName/notes seçeneği taşır', () => {
  const order = { tenantId: 'hotel-a', room: '204', items: [
    { id: 'o1', name: 'Özel Kutlama', qty: 1, category: 'Concierge', option: 'Doğum Günü Paketi' }
  ]};
  const res = bridge.buildOrderReservationDocs(order, 'ordO', {});
  const d = res.docs[0].data;
  assert.strictEqual(d.type, 'Other');
  assert.strictEqual(d.otherType, 'Özel Kutlama — Doğum Günü Paketi');
  assert.strictEqual(d.resName, 'Özel Kutlama — Doğum Günü Paketi');
  assert.ok(d.notes.includes('Seçenek: Doğum Günü Paketi'));
  assert.strictEqual(d.vehicle, undefined, 'Other tipinde vehicle alanı hiç yazılmaz');
});

test('concierge seçenek yoksa (option boş/yok) davranış değişmez — geriye dönük uyum', () => {
  const order = { tenantId: 'hotel-a', room: '204', items: [
    { id: 't1', name: 'Havalimanı Transferi', qty: 1, category: 'Concierge' }
  ]};
  const res = bridge.buildOrderReservationDocs(order, 'ordN', {});
  const d = res.docs[0].data;
  assert.strictEqual(d.resName, 'Havalimanı Transferi');
  assert.strictEqual(d.vehicle, undefined);
});

test('normal (guestLogs) kalemde seçenek talep metnine eklenir', () => {
  const order = { tenantId: 'hotel-a', room: '204', items: [
    { id: 'n1', name: 'Yastık', category: 'Konfor', option: 'Yumuşak' }
  ]};
  const logs = bridge.buildOrderLogDocs(order, 'ordP', { guestName: 'Ali' });
  assert.ok(logs.docs[0].data.complaint.includes('Seçenek: Yumuşak'));
});

test('isFnbItem: kanonik/eski F&B departman adı + Oda Servisi kategorisi tanınır', () => {
  assert.strictEqual(bridge.isFnbItem({ name: 'Çay', department: 'Yiyecek & İçecek' }), true);
  assert.strictEqual(bridge.isFnbItem({ name: 'Çay', department: 'Food & Beverage' }), true, 'eski departman adı da tanınmalı');
  assert.strictEqual(bridge.isFnbItem({ name: 'Su', category: 'Oda Servisi' }), true, 'guest-order.js varsayılan kataloğu');
  assert.strictEqual(bridge.isFnbItem({ name: 'Havlu', department: 'Housekeeping' }), false);
  assert.strictEqual(bridge.isFnbItem({ name: 'Klima Arızası', category: 'Teknik Servis' }), false);
  assert.strictEqual(bridge.isFnbItem({}), false);
});

test('misafir adı yoksa oda etiketi kullanılır; tenantsız/boş sipariş kayıt üretmez', () => {
  const r = bridge.buildOrderLogDocs({ tenantId: 'hotel-a', room: '305', items: [{ id: 'x', name: 'Çay' }] }, 'ord4', {});
  assert.strictEqual(r.docs[0].data.guestName, 'Oda 305');
  assert.deepStrictEqual(bridge.buildOrderLogDocs({ items: [{ id: 'x' }] }, 'o', {}).docs, []);
  assert.deepStrictEqual(bridge.buildOrderLogDocs({ tenantId: 't', items: [] }, 'o', {}).docs, []);
});
