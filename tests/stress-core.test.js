/* Kapasite testi çekirdeği (stress-core) — saf birim testleri + emülatörde
 * kısa gerçek kademe: metrik şekli, işlem desenlerinin gerçekten çalıştığı
 * (kilit/adisyon/defter dokümanları), temizlik ve sağlık eşikleri. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { adminDb } = require('./helpers');
const core = require('../functions/stress-core');

const PROJECT = 'stress-core-test';

test('varsayılan karışım tüm modülleri kapsar; merdiven deterministik', () => {
  const counts = {};
  core.MIX.forEach((k) => { counts[k] = (counts[k] || 0) + 1; });
  // Dengeli profil, 40 slot: %20 kayıt · %15 iş akışı · %10 QR · restoran %35
  // (kalem/açma/kapama 3:2:2) · %10 rezervasyon · %5 CRM · %5 rapor
  assert.deepStrictEqual(counts, {
    log: 8, wf: 6, qr: 4, item: 6, open: 4, settle: 4, resv: 4, crm: 2, report: 2
  });
  assert.deepStrictEqual(core.ladder(40), [2, 5, 10, 20, 40]);
  assert.deepStrictEqual(core.ladder(80), [2, 5, 10, 20, 40, 80]);
  assert.deepStrictEqual(core.ladder(3), [2, 3]);   // maks her zaman son kademe
  assert.deepStrictEqual(core.ladder(1), [1]);
});

test('özel ağırlıklar: buildMix dağılımı ve restoran hariç tutma', () => {
  // Restoran 0 → adisyon işlemlerinin (item/open/settle) hiçbiri karışıma girmez
  const noRest = core.buildMix(core.moduleWeightsToOps(
    { talep: 30, akis: 25, qr: 15, restoran: 0, concierge: 15, crm: 10, rapor: 5 }), 40);
  assert.strictEqual(noRest.length, 40);
  assert.ok(!noRest.some((k) => ['item', 'open', 'settle'].includes(k)), 'restoran işlemi olmamalı');
  assert.ok(noRest.includes('log') && noRest.includes('wf') && noRest.includes('qr')
    && noRest.includes('resv') && noRest.includes('crm') && noRest.includes('report'));

  // Yalnız restoran → 3:2:2 iç bölünme, başka tür yok
  const onlyRest = core.buildMix(core.moduleWeightsToOps({ restoran: 100 }), 40);
  const c = {}; onlyRest.forEach((k) => { c[k] = (c[k] || 0) + 1; });
  assert.deepStrictEqual(Object.keys(c).sort(), ['item', 'open', 'settle']);
  // 40 slot 3:2:2'ye tam bölünmez (17.1/11.4/11.4) — ±1 kuantizasyon payı
  assert.ok(c.item > c.open && Math.abs(c.open - c.settle) <= 1, '3:2:2 oranı (±1) korunmalı');
  assert.strictEqual(c.item + c.open + c.settle, 40);

  // Aynı ağırlık → aynı dizi (deterministik); tüm ağırlıklar 0 → boş karışım
  assert.deepStrictEqual(noRest, core.buildMix(core.moduleWeightsToOps(
    { talep: 30, akis: 25, qr: 15, restoran: 0, concierge: 15, crm: 10, rapor: 5 }), 40));
  assert.deepStrictEqual(core.buildMix(core.moduleWeightsToOps({}), 40), []);
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

  // Tüm modüllerin desenleri gerçekten koştu mu: panel kaydı, iş akışı,
  // QR siparişi, restoran adisyonu, concierge rezervasyonu, CRM profili
  assert.ok(st.created.some((id) => /_log\d+$/.test(id)), 'şikayet/talep (log) dokümanı üretilmeli');
  assert.ok(st.created.some((id) => /_wf_r\d+$/.test(id)), 'iş akışı (wf) dokümanı üretilmeli');
  assert.ok(st.created.some((id) => /_qr\d+$/.test(id)), 'QR sipariş dokümanı üretilmeli');
  assert.ok(st.created.some((id) => /_qr\d+_l1$/.test(id)), 'QR kalem kaydı üretilmeli');
  assert.ok(st.created.some((id) => /_check_t\d+$/.test(id)), 'adisyon (check) dokümanı üretilmeli');
  assert.ok(st.created.some((id) => /_resv\d+$/.test(id)), 'rezervasyon dokümanı üretilmeli');
  assert.ok(st.created.some((id) => /_folio\d+$/.test(id)), 'folio dokümanı üretilmeli');
  assert.ok(st.created.some((id) => /_guest_g\d+$/.test(id)), 'CRM misafir profili üretilmeli');

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

test('emülatörde restoran hariç kademe: adisyon dokümanı üretilmez', async () => {
  const db = adminDb(PROJECT);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const mix = core.buildMix(core.moduleWeightsToOps(
    { talep: 30, akis: 25, qr: 15, restoran: 0, concierge: 15, crm: 10, rapor: 5 }), 40);
  const st = await core.runStage(db, { runId: 'capnorest', hotels: 1, seconds: 2, expiresAt, mix });
  assert.ok(st.ops > 0);
  assert.ok(!st.created.some((id) => /_check_t\d+$/.test(id)), 'adisyon üretilmemeli');
  assert.ok(!st.created.some((id) => /_lock_t\d+$/.test(id)), 'masa kilidi üretilmemeli');
  assert.ok(st.created.some((id) => /_wf_r\d+$/.test(id)), 'iş akışı yine de koşmalı');
  await core.cleanup(db, st.created, Date.now() + 30000);
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
