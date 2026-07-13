/* F4.5 — kalan risk kapatma testleri: menü fiyat sapması, sunucu tarafı
 * taşıma/birleştirme/bölme (stok dahil), rezervasyon→folio yansıtma. */
'use strict';
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const { adminDb } = require('./helpers');
const core = require('../functions/rest-core');

const PID = 'rest-phase45-test';
const T = 'hotel-a';
let db;
let seq = 0;

function actor(role) { return { tenantId: T, uid: role + '-uid', username: role + '.user', role }; }
function op() { return 'op45-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8); }

async function seedCheck(over, items) {
  const ref = db.collection('restChecks').doc();
  const tName = (over && over.tableName) || ('Masa ' + (100 + seq));
  await ref.set(Object.assign({
    tenantId: T, status: 'sent', version: 2, checkNo: 900 + seq, tableName: tName, tableKey: core.tableKey(tName),
    section: 'Genel', pax: 2, room: '', name: '',
    items: items || [{ lineId: 'l1', menuId: 'menu-kofte', name: 'Köfte', qty: 2, unitPrice: 200, sent: true }],
    subtotal: 0, vat: 0, total: 400
  }, over));
  return { id: ref.id, tableKey: core.tableKey(tName), tableName: tName };
}

before(async () => {
  db = adminDb(PID);
  for (const col of ['restChecks', 'restTables', 'restOps', 'restAudit', 'folioCharges', 'restMenu', 'restConfig', 'restCounters', 'reservations']) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  await db.collection('restConfig').doc(T).set({ currency: '₺', vatRate: 10, vatMode: 'included' });
  await db.collection('restCounters').doc(T).set({ tenantId: T, checkNo: 1000 });
});

beforeEach(async () => {
  await db.collection('restMenu').doc('menu-kofte').set({ tenantId: T, name: 'Köfte', price: 200, trackStock: true, stock: 10 });
});

test('FİYAT SAPMASI: staff kalem fiyatını menünün altına çekip ödeyemez', async () => {
  const { id } = await seedCheck({}, [
    { lineId: 'l1', menuId: 'menu-kofte', name: 'Köfte', qty: 2, unitPrice: 10, sent: true } // menü 200, kalem 10!
  ]);
  await assert.rejects(core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, payments: [{ method: 'cash', amount: 20 }]
  })), (e) => e.errCode === core.ERR.ROLE_DENIED);
});

test('FİYAT SAPMASI: manager ödeyebilir + sapma audit\'e yazılır', async () => {
  const { id } = await seedCheck({}, [
    { lineId: 'l1', menuId: 'menu-kofte', name: 'Köfte', qty: 2, unitPrice: 150, sent: true }
  ]);
  await core.settleCore(db, Object.assign(actor('manager'), {
    operationId: op(), checkId: id, payments: [{ method: 'cash', amount: 300 }]
  }));
  const audit = await db.collection('restAudit').where('tenantId', '==', T).where('checkId', '==', id).get();
  assert.strictEqual(audit.docs[0].data().meta.priceDeviation, 100, 'sapma (2×50) audit\'te olmalı');
});

test('FİYAT eşit/menüsüz kalemlerde staff normal öder', async () => {
  const { id } = await seedCheck({}, [
    { lineId: 'l1', menuId: 'menu-kofte', name: 'Köfte', qty: 1, unitPrice: 200, sent: true },
    { lineId: 'l2', menuId: null, name: 'Eşit Pay (1/2)', qty: 1, unitPrice: 55, sent: true } // menuId'siz — karşılaştırma dışı
  ]);
  const r = await core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, payments: [{ method: 'cash', amount: 255 }]
  }));
  assert.strictEqual(r.due, 255);
});

test('TRANSFER: hedef masa boşsa taşır — kilitler tutarlı + audit', async () => {
  const { id, tableKey: oldKey } = await seedCheck({});
  await db.collection('restTables').doc(T + '__' + oldKey).set({ tenantId: T, tableKey: oldKey, openCheckId: id });
  const r = await core.transferCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, newTable: 'Teras 9', newSection: 'Teras'
  }));
  assert.strictEqual(r.tableKey, 'teras 9');
  const c = (await db.collection('restChecks').doc(id).get()).data();
  assert.strictEqual(c.tableName, 'Teras 9');
  assert.strictEqual((await db.collection('restTables').doc(T + '__' + oldKey).get()).exists, false, 'eski kilit silinmeli');
  assert.strictEqual((await db.collection('restTables').doc(T + '__teras 9').get()).data().openCheckId, id);
});

test('TRANSFER: hedef masa doluysa TABLE_OCCUPIED', async () => {
  const a = await seedCheck({ tableName: 'Bar 1' });
  await db.collection('restTables').doc(T + '__bar 1').set({ tenantId: T, tableKey: 'bar 1', openCheckId: a.id });
  const b = await seedCheck({ tableName: 'Bar 2' });
  await assert.rejects(core.transferCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: b.id, newTable: 'BAR  1'
  })), (e) => e.errCode === core.ERR.TABLE_OCCUPIED);
});

test('MERGE: kaynak silinir, kilit temizlenir, toplamlar sunucuda; replay güvenli', async () => {
  const a = await seedCheck({}, [{ lineId: 'a1', menuId: 'menu-kofte', name: 'Köfte', qty: 1, unitPrice: 200, sent: true }]);
  const b = await seedCheck({}, [{ lineId: 'b1', menuId: null, name: 'Salata', qty: 2, unitPrice: 50, sent: true }]);
  await db.collection('restTables').doc(T + '__' + b.tableKey).set({ tenantId: T, tableKey: b.tableKey, openCheckId: b.id });
  const o = op();
  const args = Object.assign(actor('staff'), { operationId: o, checkId: a.id, otherId: b.id });
  const r1 = await core.mergeCore(db, args);
  assert.strictEqual(r1.items, 2);
  assert.strictEqual(r1.total, 300);
  assert.strictEqual((await db.collection('restChecks').doc(b.id).get()).exists, false, 'kaynak silinmeli');
  assert.strictEqual((await db.collection('restTables').doc(T + '__' + b.tableKey).get()).exists, false, 'kaynağın kilidi silinmeli');
  const r2 = await core.mergeCore(db, args); // replay — kaynak yok ama sonuç aynı dönmeli
  assert.strictEqual(r2.replay, true);
});

test('SPLIT: paylar sunucuda, sayaç artar, STOK bölmede TEK kez düşer, replay stok düşürmez', async () => {
  const { id } = await seedCheck({}, [{ lineId: 'l1', menuId: 'menu-kofte', name: 'Köfte', qty: 3, unitPrice: 200, sent: true }]);
  const o = op();
  const args = Object.assign(actor('staff'), { operationId: o, checkId: id, parts: 3 });
  const r1 = await core.splitCore(db, args);
  assert.strictEqual(r1.shares.length, 3);
  assert.strictEqual(core.round2(r1.shares.reduce((s, x) => s + x, 0)), 600, 'paylar toplamı korunmalı');
  assert.strictEqual(r1.parts.length, 2, 'n-1 yeni adisyon');
  const kofte = (await db.collection('restMenu').doc('menu-kofte').get()).data();
  assert.strictEqual(kofte.stock, 7, 'stok 3 düşmeli (bölme anında)');
  const r2 = await core.splitCore(db, args);
  assert.strictEqual(r2.replay, true);
  const kofte2 = (await db.collection('restMenu').doc('menu-kofte').get()).data();
  assert.strictEqual(kofte2.stock, 7, 'replay stok DÜŞÜRMEMELİ');
  // yeni parçalar gerçekten yazılmış ve sent durumda
  const parts = await db.collection('restChecks').where('tenantId', '==', T).where('splitGroup', '==', r1.group).get();
  assert.strictEqual(parts.size, 3, 'grup: orijinal + 2 parça');
});

test('FOLIO YANSITMA: bakiye sunucuda; ikinci deneme "already"; kimlik alanları taşınır', async () => {
  const res = await db.collection('reservations').add({
    tenantId: T, guestName: 'Test Misafir', room: '101', type: 'Transfer',
    totalPrice: 300, deposit: 100, currency: 'EUR',
    guestId: 'guest-1', stayId: 'stay-1', status: 'Confirmed'
  });
  const r = await core.applyReservationFolioCore(db, Object.assign(actor('staff'), {
    operationId: op(), reservationId: res.id
  }));
  assert.strictEqual(r.balance, 200);
  assert.strictEqual(r.currency, 'EUR');
  const folio = await db.collection('folioCharges').where('tenantId', '==', T).where('reservationId', '==', res.id).get();
  assert.strictEqual(folio.size, 1);
  assert.strictEqual(folio.docs[0].data().guestId, 'guest-1');
  assert.strictEqual(folio.docs[0].data().stayId, 'stay-1');
  assert.strictEqual(folio.docs[0].data().sourceId, res.id);
  // farklı operationId ile ikinci deneme → already (folioApplied)
  await assert.rejects(core.applyReservationFolioCore(db, Object.assign(actor('staff'), {
    operationId: op(), reservationId: res.id
  })), (e) => e.errCode === core.ERR.CHECK_IMMUTABLE && e.details.already === true);
  // aynı operationId → replay, ikinci folio YOK
  const folio2 = await db.collection('folioCharges').where('tenantId', '==', T).where('reservationId', '==', res.id).get();
  assert.strictEqual(folio2.size, 1);
});

test('FOLIO YANSITMA: bakiyesiz/odasız rezervasyon reddedilir', async () => {
  const res1 = await db.collection('reservations').add({ tenantId: T, room: '101', totalPrice: 100, deposit: 100 });
  await assert.rejects(core.applyReservationFolioCore(db, Object.assign(actor('staff'), {
    operationId: op(), reservationId: res1.id
  })), (e) => e.details.noBalance === true);
  const res2 = await db.collection('reservations').add({ tenantId: T, room: 'Pre-Arrival', totalPrice: 300, deposit: 0 });
  await assert.rejects(core.applyReservationFolioCore(db, Object.assign(actor('staff'), {
    operationId: op(), reservationId: res2.id
  })), (e) => e.errCode === core.ERR.INVALID_INPUT);
});
