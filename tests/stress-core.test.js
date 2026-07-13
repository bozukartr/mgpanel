/* Kapasite testi çekirdeği (stress-core) — saf birim testleri + emülatörde
 * kısa gerçek kademe: metrik şekli, işlem desenlerinin gerçekten çalıştığı
 * (kilit/adisyon/defter dokümanları), temizlik ve sağlık eşikleri. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { adminDb } = require('./helpers');
const core = require('../functions/stress-core');

const PROJECT = 'stress-core-test';

test('karışım ve merdiven deterministik ve doğru oranlarda', () => {
  const counts = {};
  core.MIX.forEach((k) => { counts[k] = (counts[k] || 0) + 1; });
  assert.deepStrictEqual(counts, { log: 8, item: 6, open: 3, settle: 3 }); // %40/%30/%15/%15
  assert.deepStrictEqual(core.ladder(40), [2, 5, 10, 20, 40]);
  assert.deepStrictEqual(core.ladder(80), [2, 5, 10, 20, 40, 80]);
  assert.deepStrictEqual(core.ladder(3), [2, 3]);   // maks her zaman son kademe
  assert.deepStrictEqual(core.ladder(1), [1]);
});

test('percentile ve sağlık eşikleri', () => {
  assert.strictEqual(core.percentile([], 95), 0);
  assert.strictEqual(core.percentile([10, 20, 30, 40], 50), 20);
  assert.strictEqual(core.percentile([10, 20, 30, 40], 95), 40);
  assert.ok(core.isHealthy({ errorRate: 0.01, p95: 500 }));
  assert.ok(!core.isHealthy({ errorRate: 0.05, p95: 500 }), 'hata oranı eşiği');
  assert.ok(!core.isHealthy({ errorRate: 0, p95: 3000 }), 'p95 eşiği');
});

test('emülatörde kısa kademe: gerçek işlem desenleri + metrikler + temizlik', async () => {
  const db = adminDb(PROJECT);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const st = await core.runStage(db, { runId: 'captest', hotels: 2, seconds: 2, expiresAt });

  assert.strictEqual(st.hotels, 2);
  assert.strictEqual(st.workers, 2 * core.WORKERS_PER_HOTEL);
  assert.ok(st.ops > 0, 'işlem yapılmış olmalı');
  assert.ok(st.opsPerSec > 0);
  assert.ok(st.p50 <= st.p95, 'p50 <= p95');
  assert.strictEqual(st.errors, 0, 'emülatörde hata beklenmez: ' + st.errors);

  // İşlem desenleri gerçekten koştu mu: kayıt + adisyon açma izleri
  assert.ok(st.created.some((id) => /_log\d+$/.test(id)), 'kayıt (log) dokümanı üretilmeli');
  assert.ok(st.created.some((id) => /_check_t\d+$/.test(id)), 'adisyon (check) dokümanı üretilmeli');

  // Açılan bir adisyonda versiyon disiplini korunmuş olmalı (tx şekli kanıtı)
  const checkId = st.created.find((id) => /_check_t\d+$/.test(id));
  const snap = await db.collection(core.COL).doc(checkId).get();
  assert.ok(snap.exists);
  assert.ok(snap.data().version >= 1);
  assert.ok(['open', 'paid'].includes(snap.data().status));
  assert.ok(snap.data().expiresAt, 'TTL yedeği için expiresAt zorunlu');

  // Temizlik: tüm üretilen dokümanlar silinir
  const cl = await core.cleanup(db, st.created, Date.now() + 30000);
  assert.strictEqual(cl.leftover, 0);
  const after = await db.collection(core.COL).doc(checkId).get();
  assert.ok(!after.exists, 'temizlik sonrası doküman kalmamalı');
});

test('emülatörde çekişme davranışı: aynı masada eş zamanlı işlemler tutarlı kalır', async () => {
  const db = adminDb(PROJECT);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  // Tek otel, 3 cihaz — hepsi aynı 5 masalık havuza vurur; süre kısa tutulur.
  const st = await core.runStage(db, { runId: 'captest2', hotels: 1, seconds: 2, expiresAt });
  assert.ok(st.ops > 0);
  // Çekişme olsa da (aborted sayılabilir) tutarsızlık OLMAMALI: her açık
  // adisyonun kilidi kendisini göstermeli, paid adisyonun kilidi kalmamalı.
  const checks = await db.collection(core.COL).where('runId', '==', 'captest2').where('kind', '==', 'check').get();
  for (const c of checks.docs) {
    const lockId = c.id.replace('_check_t', '_lock_t');
    const lock = await db.collection(core.COL).doc(lockId).get();
    if (c.data().status === 'open') {
      assert.ok(lock.exists && lock.data().openCheckId === c.id, 'açık adisyonun kilidi tutarlı olmalı');
    } else if (c.data().status === 'paid') {
      // kapanan masada kilit ya silinmiş ya da YENİ bir adisyon için yeniden açılmıştır
      if (lock.exists) assert.notStrictEqual(lock.data().openCheckId, undefined);
    }
  }
  await core.cleanup(db, st.created, Date.now() + 30000);
});
