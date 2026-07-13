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

// ── Rol matrisi (docs/restoran-uretim-plani.md §2) ──────────────────
const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };
function requireRole(actor, minRole, message) {
  if ((ROLE_RANK[actor.role] || 0) < (ROLE_RANK[minRole] || 99)) {
    throw new RestError(ERR.ROLE_DENIED, message || 'Bu işlem için yetkiniz yok.', { requiredRole: minRole, role: actor.role });
  }
}

// İstemcideki computeTotals ile AYNI matematik — ama SUNUCUDAKİ kalemler
// ve SUNUCUDAKİ KDV konfigürasyonuyla; istemcinin gönderdiği tutarlara
// asla güvenilmez. İkram kalemleri 0 sayılır.
function computeTotals(items, cfg) {
  const mode = (cfg && cfg.vatMode) || 'included';
  const defRate = Number((cfg && cfg.vatRate)) || 0;
  let subtotal = 0, vat = 0, total = 0;
  (items || []).forEach((it) => {
    const rate = (it.vatRate != null && it.vatRate !== '') ? Number(it.vatRate) : defRate;
    const line = (it.ikram ? 0 : (Number(it.unitPrice) || 0)) * (Number(it.qty) || 1);
    if (mode === 'included') {
      const lvat = rate > 0 ? line * rate / (100 + rate) : 0;
      vat += lvat; subtotal += line - lvat; total += line;
    } else {
      const lvat = line * rate / 100;
      subtotal += line; vat += lvat; total += line + lvat;
    }
  });
  return { subtotal: round2(subtotal), vat: round2(vat), total: round2(total) };
}
function computeDiscount(total, discount) {
  if (!discount) return 0;
  if (discount.type === 'percent') {
    const v = Math.min(100, Math.max(0, Number(discount.value) || 0));
    return round2(total * v / 100);
  }
  return round2(Math.min(Math.max(0, Number(discount.value) || 0), total));
}
// İkram kalemlerinin brüt (ikram olmasaydı) değeri — indirim+ikram oranı
// %10'u aşarsa manager gerekir (rol matrisi).
function ikramValue(items) {
  return round2((items || []).reduce((s, it) => s + (it.ikram ? (Number(it.unitPrice) || 0) * (Number(it.qty) || 1) : 0), 0));
}

// Stok düşüm haritası: menuId → adet (yalnız trackStock ürünler; menü
// dokümanları transaction içinde OKUNMUŞ olmalı).
function stockPlan(items) {
  const dec = {};
  (items || []).forEach((l) => { if (l.menuId) dec[l.menuId] = (dec[l.menuId] || 0) + (Number(l.qty) || 0); });
  return dec;
}

// ── ÖDEME (settle) ──────────────────────────────────────────────────
// TEK transaction: idempotency + sunucu-hesaplı due/applied/tendered/
// change + kart/oda fazla ödeme reddi + folio + stok + audit.
// payments: [{method:'cash'|'card'|'room', amount, room?, guestName?, guestId?}]
async function settleCore(db, o) {
  if (!o.tenantId || !o.operationId || !o.checkId) throw new RestError(ERR.INVALID_INPUT, 'Eksik parametre.');
  const rows = (Array.isArray(o.payments) ? o.payments : [])
    .map((p) => ({
      method: String((p && p.method) || '').slice(0, 12),
      amount: round2(p && p.amount),
      room: String((p && p.room) || '').slice(0, 20),
      guestName: String((p && p.guestName) || '').slice(0, 60),
      guestId: String((p && p.guestId) || '').slice(0, 40)
    }))
    .filter((p) => p.amount > 0 && ['cash', 'card', 'room'].includes(p.method));

  const oRef = opRef(db, o.tenantId, o.operationId);
  const checkRef = db.collection('restChecks').doc(o.checkId);
  const cfgRef = db.collection('restConfig').doc(o.tenantId);

  return db.runTransaction(async (tx) => {
    // ── OKUMALAR (hepsi yazımlardan önce) ──
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const cSnap = await tx.get(checkRef);
    if (!cSnap.exists) throw new RestError(ERR.CHECK_NOT_FOUND, 'Adisyon bulunamadı.');
    const c = cSnap.data();
    if (c.tenantId !== o.tenantId) throw new RestError(ERR.TENANT_MISMATCH, 'Bu adisyon sizin otelinize ait değil.');
    if (c.status === 'paid' || c.status === 'void') {
      throw new RestError(ERR.CHECK_IMMUTABLE, 'Adisyon zaten ' + (c.status === 'paid' ? 'ödenmiş' : 'iptal edilmiş') + '.', { status: c.status });
    }

    const cfgSnap = await tx.get(cfgRef);
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};

    // Sunucu-hesaplı tutarlar (istemci tutarına güven yok)
    const gross = computeTotals(c.items, cfg);
    const dA = computeDiscount(gross.total, o.discount);
    const due = round2(Math.max(0, gross.total - dA));

    // İndirim+ikram > %10 → manager (rol matrisi). Sebep her durumda audit'e.
    const ikram = ikramValue(c.items);
    const grossFull = round2(gross.total + ikram);
    if (grossFull > 0 && (dA + ikram) / grossFull > 0.10) {
      requireRole(o, 'manager', 'Toplam indirim/ikram %10 sınırını aşıyor — yönetici yetkisi gerekli.');
    }

    // due/tendered/applied/change ayrımı:
    //   Nakit dışı (kart+oda) toplam kalanı AŞAMAZ — para üstü nakitten olur.
    let nonCash = 0, cashTendered = 0;
    rows.forEach((p) => { if (p.method === 'cash') cashTendered = round2(cashTendered + p.amount); else nonCash = round2(nonCash + p.amount); });
    if (nonCash > due + 0.005) {
      throw new RestError(ERR.OVERPAY_NONCASH, 'Kart/oda ödemesi kalan tutarı aşamaz.', { due, nonCash });
    }
    const cashApplied = round2(Math.min(cashTendered, round2(due - nonCash)));
    const applied = round2(nonCash + cashApplied);
    const tendered = round2(nonCash + cashTendered);
    const change = round2(cashTendered - cashApplied);
    if (due > 0 && applied + 0.005 < due) {
      throw new RestError(ERR.NO_PAYMENT, 'Ödeme tutarı yetersiz.', { due, applied });
    }

    // Stok okumaları (yalnız trackStock)
    const plan = stockPlan(c.items);
    const menuIds = Object.keys(plan);
    const menuSnaps = [];
    for (const id of menuIds) menuSnaps.push(await tx.get(db.collection('restMenu').doc(id)));

    // MENÜ FİYAT OTORİTESİ: kalem fiyatları istemci yazımıdır (POS düzenleme
    // istemcide). Personelin kalem fiyatını menü fiyatının altına çekerek
    // hesabı düşürmesine karşı: menuId'li, ikram olmayan kalemlerin toplamı
    // menü fiyatlı toplamın %2'sinden fazla ALTINDAYSA manager gerekir ve
    // sapma audit'e yazılır. (menuId'siz satırlar — ör. bölme payları —
    // karşılaştırma dışıdır; bölme zaten sunucuda hesaplanır.)
    let menuPriced = 0, itemPriced = 0;
    (c.items || []).forEach((it) => {
      if (!it.menuId || it.ikram) return;
      const idx = menuIds.indexOf(it.menuId);
      const ms = idx >= 0 ? menuSnaps[idx] : null;
      if (!ms || !ms.exists) return;
      const mPrice = Number(ms.data().price != null ? ms.data().price : ms.data().unitPrice) || 0;
      if (mPrice <= 0) return;
      menuPriced += mPrice * (Number(it.qty) || 1);
      itemPriced += (Number(it.unitPrice) || 0) * (Number(it.qty) || 1);
    });
    const priceDeviation = round2(Math.max(0, menuPriced - itemPriced));
    if (menuPriced > 0 && itemPriced < menuPriced * 0.98 - 0.005) {
      requireRole(o, 'manager', 'Kalem fiyatları menü fiyatının altında — yönetici yetkisi gerekli.');
    }

    // Oda ödemeleri için misafir/konaklama çözümü (istemcinin guestId'si
    // yalnızca ipucu — doküman gerçekten bu tenanta ait mi doğrulanır)
    const roomRows = rows.filter((p) => p.method === 'room');
    const guestSnaps = {};
    for (const p of roomRows) {
      if (p.guestId && !guestSnaps[p.guestId]) {
        guestSnaps[p.guestId] = await tx.get(db.collection('guestDirectory').doc(p.guestId));
      }
    }

    // ── YAZIMLAR ──
    const TS = FieldValue.serverTimestamp();
    const currency = String(cfg.currencyIso || (cfg.currency === '€' ? 'EUR' : cfg.currency === '$' ? 'USD' : 'TRY')).slice(0, 3);

    tx.update(checkRef, {
      status: 'paid',
      payments: rows.map((p) => Object.assign({}, p, { at: Date.now(), by: o.username || o.uid })),
      discount: o.discount ? { type: o.discount.type, value: Number(o.discount.value) || 0, reason: String(o.discount.reason || '').slice(0, 120), amount: dA } : null,
      subtotal: gross.subtotal, vat: gross.vat, total: gross.total,
      due, applied, tendered, change, payable: due,
      currency,
      closedBy: o.username || o.uid, closedByUid: o.uid, closedByRole: o.role,
      closedAt: TS, updatedAt: TS,
      settleOperationId: o.operationId,
      version: ((c.version) || 0) + 1
    });

    // Folio: oda ödemeleri (nakit dışı — applied tamamı)
    roomRows.forEach((p) => {
      const folioDoc = {
        tenantId: o.tenantId, room: p.room || c.room || '', guestName: p.guestName || '',
        source: 'restaurant', checkId: o.checkId, sourceId: o.checkId, tableName: c.tableName || '',
        amount: p.amount, currency, status: 'open', createdAt: TS, by: o.username || o.uid
      };
      const gs = p.guestId && guestSnaps[p.guestId];
      if (gs && gs.exists && gs.data().tenantId === o.tenantId) {
        folioDoc.guestId = p.guestId;
        if (gs.data().activeStayId) folioDoc.stayId = gs.data().activeStayId;
      }
      tx.set(db.collection('folioCharges').doc(), folioDoc);
    });

    // Stok: aynı transaction'da, 0'da kilitli (idempotency zaten opRef'te —
    // replay'de buraya hiç girilmez → STOK TEK KEZ düşer)
    menuSnaps.forEach((snap, i) => {
      if (!snap.exists || !snap.data().trackStock) return;
      const cur = Number(snap.data().stock) || 0;
      tx.update(snap.ref, { stock: Math.max(0, cur - plan[menuIds[i]]), updatedAt: TS });
    });

    auditEntry(db, tx, {
      tenantId: o.tenantId, action: 'settle', checkId: o.checkId, checkNo: c.checkNo || null,
      uid: o.uid, username: o.username || '', role: o.role,
      amount: applied, meta: {
        due, tendered, change, currency,
        discount: dA || 0, ikram: ikram || 0, priceDeviation,
        discountReason: (o.discount && o.discount.reason) || '',
        methods: rows.map((p) => p.method + ':' + p.amount).join(',')
      }
    });

    const result = { checkId: o.checkId, due, applied, tendered, change, currency };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'settle', uid: o.uid, result, at: TS });
    return result;
  });
}

// ── İPTAL (void) ────────────────────────────────────────────────────
// Gönderilmiş kalemli adisyonun iptali manager/admin ister + SEBEP zorunlu.
// (Düz metin cancelCode kaldırıldı — yetkili UID + sebep + audit kaydı.)
async function voidCore(db, o) {
  if (!o.tenantId || !o.operationId || !o.checkId) throw new RestError(ERR.INVALID_INPUT, 'Eksik parametre.');
  const reason = String(o.reason || '').trim().slice(0, 200);
  const oRef = opRef(db, o.tenantId, o.operationId);
  const checkRef = db.collection('restChecks').doc(o.checkId);

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const cSnap = await tx.get(checkRef);
    if (!cSnap.exists) throw new RestError(ERR.CHECK_NOT_FOUND, 'Adisyon bulunamadı.');
    const c = cSnap.data();
    if (c.tenantId !== o.tenantId) throw new RestError(ERR.TENANT_MISMATCH, 'Bu adisyon sizin otelinize ait değil.');
    if (c.status === 'paid' || c.status === 'void') {
      throw new RestError(ERR.CHECK_IMMUTABLE, 'Adisyon zaten ' + (c.status === 'paid' ? 'ödenmiş' : 'iptal edilmiş') + '.', { status: c.status });
    }

    const sentItems = (c.items || []).filter((l) => l.sent);
    if (sentItems.length) {
      requireRole(o, 'manager', 'Mutfağa gönderilmiş adisyonu yalnızca yönetici iptal edebilir.');
      if (!reason) throw new RestError(ERR.REASON_REQUIRED, 'İptal için sebep zorunlu.');
    }

    // Gönderilen (fiilen tüketilmiş) kalemlerin stoğu düşer (mevcut politika).
    const plan = stockPlan(sentItems);
    const menuIds = Object.keys(plan);
    const menuSnaps = [];
    for (const id of menuIds) menuSnaps.push(await tx.get(db.collection('restMenu').doc(id)));

    // Kilit temizliği için oku
    const tKey = c.tableKey || tableKey(c.tableName || '');
    const lockRef = tKey ? db.collection('restTables').doc(o.tenantId + '__' + tKey) : null;
    const lockSnap = lockRef ? await tx.get(lockRef) : null;

    const TS = FieldValue.serverTimestamp();
    tx.update(checkRef, {
      status: 'void',
      voidReason: reason, voidBy: o.username || o.uid, voidByUid: o.uid, voidByRole: o.role,
      voidAt: TS, updatedAt: TS,
      version: ((c.version) || 0) + 1
    });
    menuSnaps.forEach((snap, i) => {
      if (!snap.exists || !snap.data().trackStock) return;
      const cur = Number(snap.data().stock) || 0;
      tx.update(snap.ref, { stock: Math.max(0, cur - plan[menuIds[i]]), updatedAt: TS });
    });
    if (lockSnap && lockSnap.exists && lockSnap.data().openCheckId === o.checkId) tx.delete(lockRef);

    auditEntry(db, tx, {
      tenantId: o.tenantId, action: 'void', checkId: o.checkId, checkNo: c.checkNo || null,
      uid: o.uid, username: o.username || '', role: o.role, reason,
      amount: c.total || 0, meta: { sentItemCount: sentItems.length }
    });

    const result = { checkId: o.checkId, voided: true };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'void', uid: o.uid, result, at: TS });
    return result;
  });
}

// ── FOLIO TAHSİL & KAPAT ────────────────────────────────────────────
async function folioSettleCore(db, o) {
  if (!o.tenantId || !o.operationId) throw new RestError(ERR.INVALID_INPUT, 'Eksik parametre.');
  requireRole(o, 'manager', 'Oda hesabını yalnızca yönetici kapatabilir.');
  const ids = (Array.isArray(o.chargeIds) ? o.chargeIds : []).map(String).slice(0, 100);
  if (!ids.length) throw new RestError(ERR.INVALID_INPUT, 'Kapatılacak kayıt yok.');
  const oRef = opRef(db, o.tenantId, o.operationId);

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const snaps = [];
    for (const id of ids) snaps.push(await tx.get(db.collection('folioCharges').doc(id)));
    let total = 0, count = 0;
    const TS = FieldValue.serverTimestamp();
    snaps.forEach((s) => {
      if (!s.exists) return;
      const d = s.data();
      if (d.tenantId !== o.tenantId) throw new RestError(ERR.TENANT_MISMATCH, 'Kayıtlardan biri başka otele ait.');
      if (d.status !== 'open') return; // zaten kapatılmış — atla (idempotent davranış)
      tx.update(s.ref, { status: 'settled', settledAt: TS, settledBy: o.username || o.uid, settledByUid: o.uid });
      total = round2(total + (Number(d.amount) || 0)); count++;
    });

    auditEntry(db, tx, {
      tenantId: o.tenantId, action: 'folioSettle',
      uid: o.uid, username: o.username || '', role: o.role,
      amount: total, meta: { count, chargeIds: ids.join(',').slice(0, 900) }
    });
    const result = { settled: count, total };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'folioSettle', uid: o.uid, result, at: TS });
    return result;
  });
}

// Ortak: adisyonu oku + open/sent doğrula (transfer/merge/split için).
async function readOpenCheck(db, tx, tenantId, checkId) {
  const ref = db.collection('restChecks').doc(checkId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new RestError(ERR.CHECK_NOT_FOUND, 'Adisyon bulunamadı.');
  const c = snap.data();
  if (c.tenantId !== tenantId) throw new RestError(ERR.TENANT_MISMATCH, 'Bu adisyon sizin otelinize ait değil.');
  if (c.status === 'paid' || c.status === 'void') {
    throw new RestError(ERR.CHECK_IMMUTABLE, 'Adisyon ' + (c.status === 'paid' ? 'ödenmiş' : 'iptal edilmiş') + '.', { status: c.status });
  }
  return { ref, c };
}

// ── MASAYA TAŞIMA ───────────────────────────────────────────────────
async function transferCore(db, o) {
  if (!o.tenantId || !o.operationId || !o.checkId) throw new RestError(ERR.INVALID_INPUT, 'Eksik parametre.');
  const newTable = String(o.newTable || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  const nKey = tableKey(newTable);
  if (!nKey) throw new RestError(ERR.INVALID_INPUT, 'Masa adı zorunlu.');
  const oRef = opRef(db, o.tenantId, o.operationId);

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const { ref: checkRef, c } = await readOpenCheck(db, tx, o.tenantId, o.checkId);
    const oldKey = c.tableKey || tableKey(c.tableName || '');
    const newLockRef = db.collection('restTables').doc(o.tenantId + '__' + nKey);
    const oldLockRef = oldKey ? db.collection('restTables').doc(o.tenantId + '__' + oldKey) : null;

    const newLock = await tx.get(newLockRef);
    if (newLock.exists && newLock.data().openCheckId && newLock.data().openCheckId !== o.checkId) {
      const occ = await tx.get(db.collection('restChecks').doc(newLock.data().openCheckId));
      if (occ.exists && (occ.data().status === 'open' || occ.data().status === 'sent')) {
        throw new RestError(ERR.TABLE_OCCUPIED, 'Hedef masada açık adisyon var.', { checkNo: occ.data().checkNo || null });
      }
    }
    const oldLock = oldLockRef ? await tx.get(oldLockRef) : null;

    const TS = FieldValue.serverTimestamp();
    tx.update(checkRef, {
      tableName: newTable, tableKey: nKey,
      section: String(o.newSection || c.section || 'Genel').trim().slice(0, 30) || 'Genel',
      version: ((c.version) || 0) + 1, updatedAt: TS
    });
    if (oldLock && oldLock.exists && oldLock.data().openCheckId === o.checkId && oldKey !== nKey) tx.delete(oldLockRef);
    tx.set(newLockRef, { tenantId: o.tenantId, table: newTable, tableKey: nKey, openCheckId: o.checkId, updatedAt: TS });

    auditEntry(db, tx, {
      tenantId: o.tenantId, action: 'transfer', checkId: o.checkId, checkNo: c.checkNo || null,
      uid: o.uid, username: o.username || '', role: o.role,
      meta: { from: c.tableName || '', to: newTable }
    });
    const result = { checkId: o.checkId, tableName: newTable, tableKey: nKey };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'transfer', uid: o.uid, result, at: TS });
    return result;
  });
}

// ── BİRLEŞTİRME ─────────────────────────────────────────────────────
async function mergeCore(db, o) {
  if (!o.tenantId || !o.operationId || !o.checkId || !o.otherId) throw new RestError(ERR.INVALID_INPUT, 'Eksik parametre.');
  if (o.checkId === o.otherId) throw new RestError(ERR.INVALID_INPUT, 'Adisyon kendisiyle birleştirilemez.');
  const oRef = opRef(db, o.tenantId, o.operationId);

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const { ref: curRef, c: cur } = await readOpenCheck(db, tx, o.tenantId, o.checkId);
    const { ref: othRef, c: oth } = await readOpenCheck(db, tx, o.tenantId, o.otherId);
    const othKey = oth.tableKey || tableKey(oth.tableName || '');
    const othLockRef = othKey ? db.collection('restTables').doc(o.tenantId + '__' + othKey) : null;
    const othLock = othLockRef ? await tx.get(othLockRef) : null;

    const merged = (Array.isArray(cur.items) ? cur.items : []).concat(
      (Array.isArray(oth.items) ? oth.items : []).map((l) => Object.assign({}, l)));
    const cfgSnap = await tx.get(db.collection('restConfig').doc(o.tenantId));
    const t = computeTotals(merged, cfgSnap.exists ? cfgSnap.data() : {});
    const notes = [cur.note, oth.note].filter(Boolean);

    const TS = FieldValue.serverTimestamp();
    tx.update(curRef, {
      items: merged,
      pax: (Number(cur.pax) || 1) + (Number(oth.pax) || 0),
      note: notes.length ? notes.join(' · ').slice(0, 160) : (cur.note || ''),
      subtotal: t.subtotal, vat: t.vat, total: t.total,
      status: (cur.status === 'sent' || oth.status === 'sent') ? 'sent' : cur.status,
      version: ((cur.version) || 0) + 1, updatedAt: TS
    });
    tx.delete(othRef);
    if (othLock && othLock.exists && othLock.data().openCheckId === o.otherId) tx.delete(othLockRef);

    auditEntry(db, tx, {
      tenantId: o.tenantId, action: 'merge', checkId: o.checkId, checkNo: cur.checkNo || null,
      uid: o.uid, username: o.username || '', role: o.role,
      meta: { mergedCheckId: o.otherId, mergedCheckNo: oth.checkNo || null, mergedTotal: oth.total || 0 }
    });
    const result = { checkId: o.checkId, items: merged.length, total: t.total };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'merge', uid: o.uid, result, at: TS });
    return result;
  });
}

// ── EŞİT BÖLME ──────────────────────────────────────────────────────
// Paylar SUNUCUDAKİ kalemlerden hesaplanır; sayaç + mevcut adisyon +
// yeni parçalar + ORİJİNAL kalemlerin stok düşümü tek transaction.
function equalShares(total, n) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const shares = Array(n).fill(base);
  for (let i = 0; i < cents - base * n; i++) shares[i] += 1;
  return shares.map((c2) => round2(c2 / 100));
}
async function splitCore(db, o) {
  if (!o.tenantId || !o.operationId || !o.checkId) throw new RestError(ERR.INVALID_INPUT, 'Eksik parametre.');
  const n = Math.min(8, Math.max(2, parseInt(o.parts, 10) || 2));
  const oRef = opRef(db, o.tenantId, o.operationId);
  const counterRef = db.collection('restCounters').doc(o.tenantId);

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const { ref: checkRef, c } = await readOpenCheck(db, tx, o.tenantId, o.checkId);
    const cfgSnap = await tx.get(db.collection('restConfig').doc(o.tenantId));
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    const total = computeTotals(c.items, cfg).total;
    if (total <= 0) throw new RestError(ERR.INVALID_INPUT, 'Bölünecek tutar yok.');
    const cntSnap = await tx.get(counterRef);

    // Orijinal kalemlerin stoğu ŞİMDİ düşer (paylar menuId taşımaz;
    // ödeme anında düşülemez) — aynı transaction'da, tek kez.
    const plan = stockPlan(c.items);
    const menuIds = Object.keys(plan);
    const menuSnaps = [];
    for (const id of menuIds) menuSnaps.push(await tx.get(db.collection('restMenu').doc(id)));

    const shares = equalShares(total, n);
    const rate = Number(cfg.vatRate) || 0;
    const group = 'g' + o.operationId.slice(-8);
    const shareLine = (amount, k) => ({
      lineId: 'sl' + k + '-' + o.operationId.slice(-6),
      menuId: null, name: 'Eşit Pay (' + k + '/' + n + ')', category: 'Bölüm',
      unitPrice: amount, qty: 1, vatRate: rate || null, station: 'kitchen',
      note: (c.tableName ? 'Masa ' + c.tableName + ' · ' : '') + n + ' eşit pay',
      sent: true, served: true, ready: true
    });

    const TS = FieldValue.serverTimestamp();
    let no = ((cntSnap.exists && cntSnap.data().checkNo) || 0);
    const firstItems = [shareLine(shares[0], 1)];
    const t0 = computeTotals(firstItems, cfg);
    tx.update(checkRef, {
      items: firstItems, splitGroup: group, status: 'sent',
      subtotal: t0.subtotal, vat: t0.vat, total: t0.total,
      version: ((c.version) || 0) + 1, updatedAt: TS
    });
    const parts = [];
    for (let k = 2; k <= n; k++) {
      no += 1;
      const items = [shareLine(shares[k - 1], k)];
      const t = computeTotals(items, cfg);
      tx.set(db.collection('restChecks').doc(), {
        tenantId: o.tenantId, tableName: c.tableName || '', tableKey: c.tableKey || tableKey(c.tableName || ''),
        name: (c.name ? c.name + ' ' : '') + '(' + k + '/' + n + ')',
        room: '', section: c.section || 'Genel', status: 'sent', pax: 1, note: '',
        items, subtotal: t.subtotal, vat: t.vat, total: t.total,
        version: 1, checkNo: no, splitGroup: group, sentAt: Date.now(),
        openedBy: o.username || o.uid, openedAt: TS
      });
      parts.push({ checkNo: no, amount: shares[k - 1] });
    }
    tx.set(counterRef, { tenantId: o.tenantId, checkNo: no, updatedAt: TS }, { merge: true });
    menuSnaps.forEach((snap, i) => {
      if (!snap.exists || !snap.data().trackStock) return;
      const curStock = Number(snap.data().stock) || 0;
      tx.update(snap.ref, { stock: Math.max(0, curStock - plan[menuIds[i]]), updatedAt: TS });
    });

    auditEntry(db, tx, {
      tenantId: o.tenantId, action: 'split', checkId: o.checkId, checkNo: c.checkNo || null,
      uid: o.uid, username: o.username || '', role: o.role,
      amount: total, meta: { parts: n, group }
    });
    const result = { checkId: o.checkId, group, shares, parts, firstShare: shares[0] };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'split', uid: o.uid, result, at: TS });
    return result;
  });
}

// ── REZERVASYON BAKİYESİNİ FOLIO'YA YANSIT (concierge) ─────────────
// Önceden istemci transaction'ıydı (concierge.js applyToFolio) — folio
// CREATE artık istemciye kapalı olduğundan sunucuya taşındı. Bakiye
// SUNUCUDAKİ rezervasyondan hesaplanır; folioApplied çift yansıtmayı,
// operationId tekrar isteği engeller.
async function applyReservationFolioCore(db, o) {
  if (!o.tenantId || !o.operationId || !o.reservationId) throw new RestError(ERR.INVALID_INPUT, 'Eksik parametre.');
  const oRef = opRef(db, o.tenantId, o.operationId);
  const resRef = db.collection('reservations').doc(o.reservationId);

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(oRef);
    if (opSnap.exists) return Object.assign({ replay: true }, opSnap.data().result);

    const snap = await tx.get(resRef);
    if (!snap.exists) throw new RestError(ERR.CHECK_NOT_FOUND, 'Rezervasyon bulunamadı.');
    const r = snap.data();
    if (r.tenantId !== o.tenantId) throw new RestError(ERR.TENANT_MISMATCH, 'Bu rezervasyon sizin otelinize ait değil.');
    if (!r.room || r.room === 'Pre-Arrival') throw new RestError(ERR.INVALID_INPUT, 'Oda ataması olmayan rezervasyon yansıtılamaz.');
    if (r.folioApplied) throw new RestError(ERR.CHECK_IMMUTABLE, 'Bu rezervasyon zaten oda hesabına yansıtılmış.', { already: true });
    const balance = round2((Number(r.totalPrice) || 0) - (Number(r.deposit) || 0));
    if (balance <= 0) throw new RestError(ERR.INVALID_INPUT, 'Yansıtılacak bakiye yok.', { noBalance: true });

    const TS = FieldValue.serverTimestamp();
    const folioDoc = {
      tenantId: o.tenantId, room: r.room, guestName: r.guestName || '',
      source: 'concierge', reservationId: o.reservationId, sourceId: o.reservationId, tableName: '',
      amount: balance, currency: r.currency || 'EUR', status: 'open', createdAt: TS, by: o.username || o.uid
    };
    if (r.guestId) folioDoc.guestId = r.guestId;
    if (r.stayId) folioDoc.stayId = r.stayId;
    tx.set(db.collection('folioCharges').doc(), folioDoc);
    tx.update(resRef, { folioApplied: true, folioAmount: balance, folioAt: TS });

    auditEntry(db, tx, {
      tenantId: o.tenantId, action: 'applyReservationFolio', checkId: o.reservationId,
      uid: o.uid, username: o.username || '', role: o.role,
      amount: balance, meta: { room: r.room, currency: folioDoc.currency }
    });
    const result = { reservationId: o.reservationId, balance, currency: folioDoc.currency };
    tx.set(oRef, { tenantId: o.tenantId, operationId: o.operationId, kind: 'applyReservationFolio', uid: o.uid, result, at: TS });
    return result;
  });
}

module.exports = {
  ERR, RestError, tableKey, round2, opRef, auditEntry,
  ROLE_RANK, requireRole, computeTotals, computeDiscount, equalShares,
  openCheckCore, repairTableLocksCore, settleCore, voidCore, folioSettleCore,
  transferCore, mergeCore, splitCore, applyReservationFolioCore
};
