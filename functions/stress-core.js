/* Çoklu-otel kapasite testi çekirdeği.
 *
 * Amaç: "Aynı anda N otel operasyondayken sistem kaç işlemi kaldırır?"
 * sorusunu cevaplamak. Bunun için ham batch yazma hızı değil, gerçek
 * operasyonların ŞEKİLLERİ simüle edilir — kapasiteyi sınırlayan şey
 * sıcak dokümanlardaki transaction çekişmesidir:
 *
 *   · masa açma      → kilit dokümanı üzerinde transaction (restTables deseni)
 *   · kalem ekleme   → adisyonda versiyon artışlı transaction (restChecks deseni)
 *   · misafir kaydı  → düz doküman oluşturma (guestLogs deseni)
 *   · hesap kapama   → transaction + idempotency defteri (settleCore + restOps deseni)
 *
 * Her sanal otelde 3 eş zamanlı "personel cihazı" ve 5 masa vardır; aynı
 * masaya çakışan işlemler gerçek çekişmeyi üretir. Tüm dokümanlar izole
 * `_stressTest` koleksiyonundadır ve expiresAt (TTL yedeği) taşır —
 * hiçbir kiracı verisine dokunulmaz.
 */
'use strict';

const COL = '_stressTest';
const TABLES_PER_HOTEL = 5;   // otel içi sıcak doküman havuzu (çekişme kaynağı)
const WORKERS_PER_HOTEL = 3;  // aynı oteldeki eş zamanlı personel cihazı
const LATENCY_CAP = 4000;     // kademe başına gecikme örneklemi üst sınırı (bellek)
const PAYLOAD = 'x'.repeat(200);

// 20 slotluk deterministik işlem karışımı: %40 kayıt, %30 kalem, %15 açma, %15 kapama
const MIX = [
  'log', 'item', 'log', 'open', 'item', 'log', 'settle', 'item', 'log', 'open',
  'item', 'log', 'settle', 'item', 'log', 'open', 'item', 'log', 'settle', 'log'
];

// Sağlık eşikleri: bir kademe bu sınırların altında kalıyorsa "sürdürülebilir".
const HEALTH = { maxErrorRate: 0.02, maxP95Ms: 2000 };

// Rampa merdiveni: kademeli otel sayıları, en büyüğü maxHotels olacak şekilde.
function ladder(maxHotels) {
  const steps = [2, 5, 10, 20, 40, 80].filter((n) => n < maxHotels);
  steps.push(maxHotels);
  return steps;
}

function percentile(sortedMs, p) {
  if (!sortedMs.length) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function isHealthy(stage) {
  return stage.errorRate <= HEALTH.maxErrorRate && stage.p95 <= HEALTH.maxP95Ms;
}

// Tek "personel cihazı" döngüsü: kademe süresi bitene dek karışımdan işlem
// çeker, gecikme ve hata sayar. Admin SDK ABORTED transaction'ları kendi
// içinde yeniden dener; buna rağmen patlayanlar ağır çekişme sinyalidir.
async function hotelWorker(db, o) {
  const stats = { ops: 0, errors: 0, aborted: 0, latencies: [], created: [] };
  const col = db.collection(COL);
  const base = o.runId + '_h' + o.hotel;
  let seq = 0;
  while (Date.now() < o.deadline) {
    const kind = MIX[(seq + o.worker * 7) % MIX.length];
    const table = (seq + o.worker) % TABLES_PER_HOTEL;
    const t0 = Date.now();
    try {
      if (kind === 'log') {
        const ref = col.doc(base + '_w' + o.worker + '_log' + seq);
        await ref.set({
          kind: 'log', runId: o.runId, hotel: o.hotel, payload: PAYLOAD,
          createdAt: new Date(), expiresAt: o.expiresAt
        });
        stats.created.push(ref.id);
      } else if (kind === 'open') {
        const lockRef = col.doc(base + '_lock_t' + table);
        const checkRef = col.doc(base + '_check_t' + table);
        const opened = await db.runTransaction(async (tx) => {
          const lock = await tx.get(lockRef);
          if (lock.exists) return false; // masa dolu — gerçek akışta kalem eklemeye düşülür
          tx.set(checkRef, {
            kind: 'check', runId: o.runId, hotel: o.hotel, status: 'open',
            version: 1, items: [], total: 0, createdAt: new Date(), expiresAt: o.expiresAt
          });
          tx.set(lockRef, { kind: 'lock', runId: o.runId, openCheckId: checkRef.id, expiresAt: o.expiresAt });
          return true;
        });
        if (opened) stats.created.push(checkRef.id, lockRef.id);
      } else if (kind === 'item') {
        const checkRef = col.doc(base + '_check_t' + table);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(checkRef);
          if (!snap.exists || snap.data().status !== 'open') return;
          const d = snap.data();
          const items = (d.items || []).concat([{ lineId: 'l' + seq, name: 'Ürün', qty: 1, unitPrice: 50 }]);
          tx.update(checkRef, {
            items: items.slice(-30), total: (d.total || 0) + 50, version: (d.version || 0) + 1
          });
        });
      } else { // settle
        const checkRef = col.doc(base + '_check_t' + table);
        const lockRef = col.doc(base + '_lock_t' + table);
        const opRef = col.doc(base + '_op_w' + o.worker + '_' + seq);
        const settled = await db.runTransaction(async (tx) => {
          const snap = await tx.get(checkRef);
          if (!snap.exists || snap.data().status !== 'open' || !(snap.data().items || []).length) return false;
          tx.update(checkRef, { status: 'paid', version: (snap.data().version || 0) + 1, paidAt: new Date() });
          tx.set(opRef, { kind: 'op', runId: o.runId, result: 'paid', createdAt: new Date(), expiresAt: o.expiresAt });
          tx.delete(lockRef);
          return true;
        });
        if (settled) stats.created.push(opRef.id);
      }
      stats.ops++;
      if (stats.latencies.length < LATENCY_CAP) stats.latencies.push(Date.now() - t0);
    } catch (e) {
      const sig = String((e && e.code) || '') + ' ' + String((e && e.message) || '');
      if (/aborted|contention|deadline/i.test(sig)) stats.aborted++; else stats.errors++;
      if (stats.latencies.length < LATENCY_CAP) stats.latencies.push(Date.now() - t0);
    }
    seq++;
  }
  return stats;
}

// Bir rampa kademesi: hotels × WORKERS_PER_HOTEL eş zamanlı döngü, süre dolunca
// toplu metrik: işlem/sn, p50/p95 gecikme, hata + çekişme oranı.
async function runStage(db, o) {
  const deadline = Date.now() + o.seconds * 1000;
  const workers = [];
  for (let h = 0; h < o.hotels; h++) {
    for (let w = 0; w < WORKERS_PER_HOTEL; w++) {
      workers.push(hotelWorker(db, { runId: o.runId, hotel: h, worker: w, deadline, expiresAt: o.expiresAt }));
    }
  }
  const t0 = Date.now();
  const all = await Promise.all(workers);
  const ms = Date.now() - t0;
  const agg = { hotels: o.hotels, workers: workers.length, ms, ops: 0, errors: 0, aborted: 0, created: [] };
  const lat = [];
  all.forEach((s) => {
    agg.ops += s.ops; agg.errors += s.errors; agg.aborted += s.aborted;
    for (let i = 0; i < s.latencies.length; i++) lat.push(s.latencies[i]);
    for (let i = 0; i < s.created.length; i++) agg.created.push(s.created[i]);
  });
  lat.sort((a, b) => a - b);
  const attempts = agg.ops + agg.errors + agg.aborted;
  agg.opsPerSec = ms ? Math.round(agg.ops / (ms / 1000)) : 0;
  agg.p50 = percentile(lat, 50);
  agg.p95 = percentile(lat, 95);
  agg.errorRate = attempts ? (agg.errors + agg.aborted) / attempts : 0;
  return agg;
}

// Test dokümanlarını 450'lik batch'lerle siler; süre biterse kalanı TTL'e
// bırakır (tüm dokümanlar expiresAt taşır).
async function cleanup(db, ids, deadline) {
  const unique = [...new Set(ids)];
  let deleted = 0;
  for (let i = 0; i < unique.length; i += 450) {
    if (Date.now() > deadline) break;
    const batch = db.batch();
    const chunk = unique.slice(i, i + 450);
    chunk.forEach((id) => batch.delete(db.collection(COL).doc(id)));
    await batch.commit();
    deleted += chunk.length;
  }
  return { deleted, leftover: unique.length - deleted };
}

module.exports = {
  COL, MIX, TABLES_PER_HOTEL, WORKERS_PER_HOTEL, HEALTH,
  ladder, percentile, isHealthy, hotelWorker, runStage, cleanup
};
