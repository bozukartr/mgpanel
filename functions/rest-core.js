/* Hotizy — restoran çekirdeği (rest-core).
 *
 * TÜM finansal iş kuralları burada yaşar; `db` enjekte edilir — üretimde
 * admin.firestore(), testte Firestore Emulator'a bağlı admin SDK. Böylece
 * eşzamanlılık/yetki senaryoları GERÇEK transaction semantiğiyle test
 * edilir (bkz. tests/ ve docs/restoran-uretim-plani.md).
 *
 * onCall sarmalayıcıları (functions/index.js) ince kalır: kimlik + rol
 * çözümü, girdi budama, RestError → HttpsError çevirisi.
 */
'use strict';
const { FieldValue } = require('firebase-admin/firestore');

// ── Hata kodları (katalog: docs/restoran-uretim-plani.md §2) ────────
const ERR = {
  INVALID_INPUT: 'REST/INVALID_INPUT',
  TABLE_OCCUPIED: 'REST/TABLE_OCCUPIED',
  CHECK_NOT_FOUND: 'REST/CHECK_NOT_FOUND',
  CHECK_IMMUTABLE: 'REST/CHECK_IMMUTABLE',
  INVALID_TRANSITION: 'REST/INVALID_TRANSITION',
  OVERPAY_NONCASH: 'REST/OVERPAY_NONCASH',
  NO_PAYMENT: 'REST/NO_PAYMENT',
  ROLE_DENIED: 'REST/ROLE_DENIED',
  REASON_REQUIRED: 'REST/REASON_REQUIRED',
  TENANT_MISMATCH: 'REST/TENANT_MISMATCH'
};

class RestError extends Error {
  constructor(errCode, message, details) {
    super(message);
    this.name = 'RestError';
    this.errCode = errCode;
    this.details = details || {};
  }
}

// Masa adını normalize eden anahtar: kırp, boşlukları tekle, tr-küçült,
// '/' → '_' (doküman yolu güvenliği). "MASA  1" ve "masa 1" aynı kilit.
function tableKey(name) {
  return String(name || '')
    .trim().replace(/\s+/g, ' ')
    .toLocaleLowerCase('tr-TR')
    .replace(/\//g, '_')
    .slice(0, 60);
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// İdempotency defteri anahtarı. operationId istemciden gelir (çift
// tıklama/tekrar istek aynı kimliği taşır) — aynı kimlikle ikinci çağrı
// İLK sonucun aynısını döner, hiçbir yan etki tekrarlanmaz.
function opRef(db, tenantId, operationId) {
  return db.collection('restOps').doc(tenantId + '_' + operationId);
}

function auditEntry(db, tx, data) {
  const ref = db.collection('restAudit').doc();
  tx.set(ref, Object.assign({ at: FieldValue.serverTimestamp() }, data));
}

// ── Adisyon açma ────────────────────────────────────────────────────
// TEK transaction'da: idempotency kontrolü + masa kilidi + sıralı
// checkNo + adisyon dokümanı + kilit + işlem kaydı.
async function openCheckCore(db, o) {
  const tKey = tableKey(o.tableName);
  if (!o.tenantId || !o.operationId) throw new RestError(ERR.INVALID_INPUT, 'tenant/operationId eksik.');
  if (!tKey) throw new RestError(ERR.INVALID_INPUT, 'Masa adı zorunlu.');

  const oRef = opRef(db, o.tenantId, o.operationId);
  const lockRef = db.collection('restTables').doc(o.tenantId + '__' + tKey);
  const counterRef = db.collection('restCounters').doc(o.tenantId);
  const checkRef = db.collection('restChecks').doc();

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const lockSnap = await tx.get(lockRef);
    if (!o.force && lockSnap.exists && lockSnap.data().openCheckId) {
      const openSnap = await tx.get(db.collection('restChecks').doc(lockSnap.data().openCheckId));
      if (openSnap.exists && openSnap.data().tenantId === o.tenantId
          && (openSnap.data().status === 'open' || openSnap.data().status === 'sent')) {
        throw new RestError(ERR.TABLE_OCCUPIED, 'Bu masada zaten açık bir adisyon var.', {
          checkId: openSnap.id, checkNo: openSnap.data().checkNo || null
        });
      }
    }

    const counterSnap = await tx.get(counterRef);
    const no = ((counterSnap.exists && counterSnap.data().checkNo) || 0) + 1;

    const check = {
      tenantId: o.tenantId,
      status: 'open',
      version: 1,
      checkNo: no,
      tableName: String(o.tableName || '').trim().replace(/\s+/g, ' ').slice(0, 20),
      tableKey: tKey,
      section: String(o.section || 'Genel').trim().slice(0, 30) || 'Genel',
      pax: Math.max(1, parseInt(o.pax, 10) || 1),
      room: String(o.room || '').trim().slice(0, 20),
      name: String(o.name || '').trim().slice(0, 40),
      items: [],
      subtotal: 0, vat: 0, total: 0,
      openedBy: o.username || o.uid || '',
      openedByUid: o.uid || '',
      openedAt: FieldValue.serverTimestamp(),
      operationId: o.operationId
    };
    if (o.guestId) check.guestId = String(o.guestId).slice(0, 40);
    if (o.stayId) check.stayId = String(o.stayId).slice(0, 40);

    tx.set(counterRef, { tenantId: o.tenantId, checkNo: no, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(checkRef, check);
    tx.set(lockRef, {
      tenantId: o.tenantId, table: check.tableName, tableKey: tKey,
      openCheckId: checkRef.id, updatedAt: FieldValue.serverTimestamp()
    });

    const result = { checkId: checkRef.id, checkNo: no, tableKey: tKey };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'openCheck', uid: o.uid || '', result, at: FieldValue.serverTimestamp() });
    return result;
  });
}

// ── Kilit onarımı (migration — geri döndürülebilir) ─────────────────
// Bayat kilit: openCheckId'si olmayan/kapalı adisyona işaret eden kilit
// SİLİNİR. Normalize edilmemiş doküman kimliği (eski `{tenant}__{ham ad}`
// biçimi) → normalize kopya yazılır, eski silinir. Kilidi olmayan açık
// adisyonlara kilit yazılır. Hiçbir adisyon dokümanına DOKUNULMAZ.
async function repairTableLocksCore(db, tenantId) {
  const report = { scanned: 0, removedStale: 0, normalized: 0, relinked: 0 };

  const locksSnap = await db.collection('restTables').where('tenantId', '==', tenantId).get();
  for (const lock of locksSnap.docs) {
    report.scanned++;
    const d = lock.data() || {};
    let openOk = false;
    if (d.openCheckId) {
      const c = await db.collection('restChecks').doc(d.openCheckId).get();
      openOk = c.exists && c.data().tenantId === tenantId
        && (c.data().status === 'open' || c.data().status === 'sent');
    }
    if (!openOk) {
      await lock.ref.delete();
      report.removedStale++;
      continue;
    }
    const wantId = tenantId + '__' + tableKey(d.table || d.tableKey || '');
    if (lock.id !== wantId && tableKey(d.table || '')) {
      await db.collection('restTables').doc(wantId).set({
        tenantId, table: d.table || '', tableKey: tableKey(d.table || ''),
        openCheckId: d.openCheckId, updatedAt: FieldValue.serverTimestamp()
      });
      await lock.ref.delete();
      report.normalized++;
    }
  }

  // Kilidi olmayan açık adisyonlar → kilit yaz (son güncellenen kazanır).
  const openSnap = await db.collection('restChecks')
    .where('tenantId', '==', tenantId).where('status', 'in', ['open', 'sent']).get();
  for (const c of openSnap.docs) {
    const tKey = tableKey(c.data().tableName || '');
    if (!tKey) continue;
    const lockRef = db.collection('restTables').doc(tenantId + '__' + tKey);
    const lock = await lockRef.get();
    if (!lock.exists) {
      await lockRef.set({
        tenantId, table: c.data().tableName || '', tableKey: tKey,
        openCheckId: c.id, updatedAt: FieldValue.serverTimestamp()
      });
      report.relinked++;
    }
  }
  return report;
}

module.exports = { ERR, RestError, tableKey, round2, opRef, auditEntry, openCheckCore, repairTableLocksCore };
