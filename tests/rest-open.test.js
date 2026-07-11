/* Faz 2 — sunucu tarafı adisyon açma çekirdeği: eşzamanlılık, idempotency,
 * normalizasyon, tenant izolasyonu, kilit onarımı. Admin SDK ile emülatöre
 * karşı GERÇEK transaction semantiği (kurallar bypass — çekirdek testidir;
 * kural testleri rules.*.test.js dosyalarında). */
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
const { adminDb } = require('./helpers');
const core = require('../functions/rest-core');

const PID = 'rest-open-core-test';
let db;

function opts(over) {
  return Object.assign({
    tenantId: 'hotel-a', uid: 'staff-1', username: 'garson',
    operationId: 'op-' + Math.random().toString(36).slice(2),
    tableName: 'Masa 1', pax: 2, section: 'Genel', room: '', name: ''
  }, over);
}

before(async () => {
  db = adminDb(PID);
  // temiz zemin
  for (const col of ['restChecks', 'restTables', 'restCounters', 'restOps']) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) await d.ref.delete();
  }
});

test('tableKey normalizasyonu', () => {
  assert.strictEqual(core.tableKey('  MASA  1 '), 'masa 1');
  assert.strictEqual(core.tableKey('Bahçe/3'), 'bahçe_3');
  assert.strictEqual(core.tableKey('İÇ SALON'), 'iç salon');
});

test('adisyon açma: checkNo + kilit + doküman tek transaction', async () => {
  const r = await core.openCheckCore(db, opts({ tableName: 'Masa 10' }));
  assert.ok(r.checkId); assert.ok(r.checkNo >= 1);
  const check = await db.collection('restChecks').doc(r.checkId).get();
  assert.strictEqual(check.data().status, 'open');
  assert.strictEqual(check.data().version, 1);
  assert.strictEqual(check.data().tableKey, 'masa 10');
  const lock = await db.collection('restTables').doc('hotel-a__masa 10').get();
  assert.strictEqual(lock.data().openCheckId, r.checkId);
});

test('EŞZAMANLI iki açma aynı masada: biri kazanır, diğeri TABLE_OCCUPIED', async () => {
  const [a, b] = await Promise.allSettled([
    core.openCheckCore(db, opts({ tableName: 'Masa 20', operationId: 'op-c1' })),
    core.openCheckCore(db, opts({ tableName: 'MASA 20', operationId: 'op-c2' }))
  ]);
  const ok = [a, b].filter(x => x.status === 'fulfilled');
  const fail = [a, b].filter(x => x.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'tam olarak biri başarılı olmalı');
  assert.strictEqual(fail.length, 1);
  assert.strictEqual(fail[0].reason.errCode, core.ERR.TABLE_OCCUPIED);
  // tek adisyon dokümanı oluşmuş olmalı
  const checks = await db.collection('restChecks')
    .where('tenantId', '==', 'hotel-a').where('tableKey', '==', 'masa 20').get();
  assert.strictEqual(checks.size, 1);
});

test('İDEMPOTENCY: aynı operationId iki kez → tek adisyon, aynı sonuç', async () => {
  const o = opts({ tableName: 'Masa 30', operationId: 'op-dup' });
  const r1 = await core.openCheckCore(db, o);
  const r2 = await core.openCheckCore(db, o);
  assert.strictEqual(r2.checkId, r1.checkId);
  assert.strictEqual(r2.checkNo, r1.checkNo);
  assert.strictEqual(r2.replay, true);
  const checks = await db.collection('restChecks')
    .where('tenantId', '==', 'hotel-a').where('tableKey', '==', 'masa 30').get();
  assert.strictEqual(checks.size, 1);
});

test('ÇİFT TIKLAMA (eşzamanlı aynı operationId) → tek adisyon', async () => {
  const o = opts({ tableName: 'Masa 31', operationId: 'op-dblclick' });
  const results = await Promise.allSettled([
    core.openCheckCore(db, o), core.openCheckCore(db, o)
  ]);
  // İkisi de başarılı dönebilir (biri replay) YA DA biri TABLE_OCCUPIED
  // alabilir (kilit önce yazıldıysa) — her durumda TEK adisyon oluşur.
  const checks = await db.collection('restChecks')
    .where('tenantId', '==', 'hotel-a').where('tableKey', '==', 'masa 31').get();
  assert.strictEqual(checks.size, 1, 'çift tıklama tek adisyon üretmeli');
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  assert.ok(fulfilled.length >= 1);
});

test('TENANT İZOLASYONU: başka otel aynı masa adını bağımsız kullanır', async () => {
  await core.openCheckCore(db, opts({ tableName: 'Masa 40' }));
  const r = await core.openCheckCore(db, opts({ tenantId: 'hotel-b', tableName: 'Masa 40', uid: 'staff-b' }));
  assert.ok(r.checkId);
  const lockB = await db.collection('restTables').doc('hotel-b__masa 40').get();
  assert.strictEqual(lockB.data().openCheckId, r.checkId);
});

test('force: dolu masada bilinçli ikinci adisyon açılabilir (kilit yeni adisyona döner)', async () => {
  const r1 = await core.openCheckCore(db, opts({ tableName: 'Masa 50' }));
  await assert.rejects(core.openCheckCore(db, opts({ tableName: 'Masa 50' })), (e) => e.errCode === core.ERR.TABLE_OCCUPIED);
  const r2 = await core.openCheckCore(db, opts({ tableName: 'Masa 50', force: true }));
  assert.notStrictEqual(r2.checkId, r1.checkId);
  const lock = await db.collection('restTables').doc('hotel-a__masa 50').get();
  assert.strictEqual(lock.data().openCheckId, r2.checkId);
});

test('kapalı adisyona işaret eden BAYAT kilit yeni açmayı engellemez', async () => {
  const r = await core.openCheckCore(db, opts({ tableName: 'Masa 60' }));
  await db.collection('restChecks').doc(r.checkId).update({ status: 'paid' });
  const r2 = await core.openCheckCore(db, opts({ tableName: 'Masa 60' }));
  assert.ok(r2.checkId && r2.checkId !== r.checkId);
});

test('repairTableLocksCore: bayat siler, normalize eder, kopuk kilidi bağlar', async () => {
  // bayat kilit (adisyonu yok)
  await db.collection('restTables').doc('hotel-a__hayalet').set({
    tenantId: 'hotel-a', table: 'Hayalet', tableKey: 'hayalet', openCheckId: 'yok-boyle-adisyon'
  });
  // normalize edilmemiş kimlikli ama geçerli kilit
  const r = await core.openCheckCore(db, opts({ tableName: 'Teras 1' }));
  await db.collection('restTables').doc('hotel-a__TERAS  1').set({
    tenantId: 'hotel-a', table: 'TERAS  1', openCheckId: r.checkId
  });
  // kilidi olmayan açık adisyon
  const orphan = await db.collection('restChecks').add({
    tenantId: 'hotel-a', status: 'open', tableName: 'Kameriye 2', items: [], version: 1
  });

  const report = await core.repairTableLocksCore(db, 'hotel-a');
  assert.ok(report.removedStale >= 1, 'bayat kilit silinmeli: ' + JSON.stringify(report));
  assert.ok(report.relinked >= 1, 'kopuk adisyona kilit yazılmalı');

  const ghost = await db.collection('restTables').doc('hotel-a__hayalet').get();
  assert.strictEqual(ghost.exists, false);
  const orphanLock = await db.collection('restTables').doc('hotel-a__kameriye 2').get();
  assert.strictEqual(orphanLock.data().openCheckId, orphan.id);
  // normalize edilmemiş kimlik artık yok, normalize olan geçerli adisyona işaret ediyor
  const badId = await db.collection('restTables').doc('hotel-a__TERAS  1').get();
  assert.strictEqual(badId.exists, false);
  const goodId = await db.collection('restTables').doc('hotel-a__teras 1').get();
  assert.strictEqual(goodId.data().openCheckId, r.checkId);
});
