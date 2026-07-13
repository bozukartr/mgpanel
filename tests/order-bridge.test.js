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

test('misafir adı yoksa oda etiketi kullanılır; tenantsız/boş sipariş kayıt üretmez', () => {
  const r = bridge.buildOrderLogDocs({ tenantId: 'hotel-a', room: '305', items: [{ id: 'x', name: 'Çay' }] }, 'ord4', {});
  assert.strictEqual(r.docs[0].data.guestName, 'Oda 305');
  assert.deepStrictEqual(bridge.buildOrderLogDocs({ items: [{ id: 'x' }] }, 'o', {}).docs, []);
  assert.deepStrictEqual(bridge.buildOrderLogDocs({ tenantId: 't', items: [] }, 'o', {}).docs, []);
});
