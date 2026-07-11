/* Faz 4 — sunucu tarafı ödeme/iptal/folio çekirdekleri: rol matrisi,
 * çift ödeme, fazla ödeme, para üstü, stok tek düşüm, audit. */
'use strict';
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const { adminDb } = require('./helpers');
const core = require('../functions/rest-core');

const PID = 'rest-settle-core-test';
const T = 'hotel-a';
let db;
let seq = 0;

function actor(role) { return { tenantId: T, uid: role + '-uid', username: role + '.user', role }; }
function op() { return 'op-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8); }

// Taban adisyon: 2× Köfte (stok takipli, 200₺) + 1× Çay (20₺) = 420₺ (KDV dahil %10)
async function seedCheck(over, items) {
  const ref = db.collection('restChecks').doc();
  await ref.set(Object.assign({
    tenantId: T, status: 'sent', version: 2, checkNo: 500 + seq, tableName: 'Masa T', tableKey: 'masa t',
    section: 'Genel', pax: 2, room: '101', name: 'Test Misafir',
    items: items || [
      { lineId: 'l1', menuId: 'menu-kofte', name: 'Köfte', qty: 2, unitPrice: 200, sent: true },
      { lineId: 'l2', menuId: 'menu-cay', name: 'Çay', qty: 1, unitPrice: 20, sent: true }
    ],
    subtotal: 0, vat: 0, total: 420
  }, over));
  return ref.id;
}

before(async () => {
  db = adminDb(PID);
  for (const col of ['restChecks', 'restTables', 'restOps', 'restAudit', 'folioCharges', 'restMenu', 'restConfig', 'guestDirectory']) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  await db.collection('restConfig').doc(T).set({ currency: '₺', vatRate: 10, vatMode: 'included' });
  await db.collection('guestDirectory').doc('guest-1').set({
    tenantId: T, name: 'Test Misafir', room: '101', status: 'in_house', activeStayId: 'stay-1'
  });
});

beforeEach(async () => {
  await db.collection('restMenu').doc('menu-kofte').set({ tenantId: T, name: 'Köfte', trackStock: true, stock: 10 });
  await db.collection('restMenu').doc('menu-cay').set({ tenantId: T, name: 'Çay', trackStock: false });
});

test('NAKİT tam ödeme: paid + due/applied/tendered/change + stok + audit', async () => {
  const id = await seedCheck();
  const r = await core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, payments: [{ method: 'cash', amount: 420 }]
  }));
  assert.strictEqual(r.due, 420);
  assert.strictEqual(r.applied, 420);
  assert.strictEqual(r.tendered, 420);
  assert.strictEqual(r.change, 0);
  const c = (await db.collection('restChecks').doc(id).get()).data();
  assert.strictEqual(c.status, 'paid');
  assert.strictEqual(c.due, 420);
  assert.ok(c.currency, 'para birimi snapshot yazılmalı');
  const kofte = (await db.collection('restMenu').doc('menu-kofte').get()).data();
  assert.strictEqual(kofte.stock, 8, 'stok 2 düşmeli');
  const audit = await db.collection('restAudit').where('tenantId', '==', T).where('checkId', '==', id).get();
  assert.strictEqual(audit.size, 1, 'audit kaydı yazılmalı');
});

test('ÇİFT ÖDEME (aynı operationId) → tek tahsilat, STOK TEK düşüm', async () => {
  const id = await seedCheck();
  const o = op();
  const args = Object.assign(actor('staff'), { operationId: o, checkId: id, payments: [{ method: 'cash', amount: 420 }] });
  const r1 = await core.settleCore(db, args);
  const r2 = await core.settleCore(db, args);
  assert.strictEqual(r2.replay, true);
  assert.strictEqual(r2.applied, r1.applied);
  const kofte = (await db.collection('restMenu').doc('menu-kofte').get()).data();
  assert.strictEqual(kofte.stock, 8, 'replay stok DÜŞMEMELİ (tek düşüm)');
});

test('EŞZAMANLI iki ödeme (farklı operationId) → ikincisi CHECK_IMMUTABLE', async () => {
  const id = await seedCheck();
  const mk = () => core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, payments: [{ method: 'cash', amount: 420 }]
  }));
  const [a, b] = await Promise.allSettled([mk(), mk()]);
  const ok = [a, b].filter(x => x.status === 'fulfilled');
  const fail = [a, b].filter(x => x.status === 'rejected');
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(fail[0].reason.errCode, core.ERR.CHECK_IMMUTABLE);
  const kofte = (await db.collection('restMenu').doc('menu-kofte').get()).data();
  assert.strictEqual(kofte.stock, 8, 'stok yalnız BİR ödemede düşmeli');
});

test('KART fazla ödeme REDDEDİLİR (OVERPAY_NONCASH)', async () => {
  const id = await seedCheck();
  await assert.rejects(core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, payments: [{ method: 'card', amount: 500 }]
  })), (e) => e.errCode === core.ERR.OVERPAY_NONCASH);
});

test('ODA fazla ödeme REDDEDİLİR; kart+oda toplamı da sınırlı', async () => {
  const id = await seedCheck();
  await assert.rejects(core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id,
    payments: [{ method: 'card', amount: 300 }, { method: 'room', amount: 200, room: '101', guestId: 'guest-1' }]
  })), (e) => e.errCode === core.ERR.OVERPAY_NONCASH);
});

test('FAZLA NAKİT → para üstü; applied=due, change ciroya girmez', async () => {
  const id = await seedCheck();
  const r = await core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, payments: [{ method: 'cash', amount: 500 }]
  }));
  assert.strictEqual(r.due, 420);
  assert.strictEqual(r.applied, 420);
  assert.strictEqual(r.tendered, 500);
  assert.strictEqual(r.change, 80);
});

test('YETERSİZ ödeme REDDEDİLİR (NO_PAYMENT)', async () => {
  const id = await seedCheck();
  await assert.rejects(core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, payments: [{ method: 'cash', amount: 100 }]
  })), (e) => e.errCode === core.ERR.NO_PAYMENT);
});

test('ODA ödemesi folio yazar: guestId/stayId/sourceId ile', async () => {
  const id = await seedCheck();
  await core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id,
    payments: [{ method: 'room', amount: 420, room: '101', guestName: 'Test Misafir', guestId: 'guest-1' }]
  }));
  const folio = await db.collection('folioCharges').where('tenantId', '==', T).where('checkId', '==', id).get();
  assert.strictEqual(folio.size, 1);
  const f = folio.docs[0].data();
  assert.strictEqual(f.guestId, 'guest-1');
  assert.strictEqual(f.stayId, 'stay-1');
  assert.strictEqual(f.sourceId, id);
  assert.strictEqual(f.status, 'open');
});

test('İNDİRİM >%10 STAFF için ROLE_DENIED; manager için OK + audit sebep', async () => {
  const id1 = await seedCheck();
  await assert.rejects(core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id1,
    discount: { type: 'percent', value: 20, reason: 'kampanya' },
    payments: [{ method: 'cash', amount: 336 }]
  })), (e) => e.errCode === core.ERR.ROLE_DENIED);

  const id2 = await seedCheck();
  const r = await core.settleCore(db, Object.assign(actor('manager'), {
    operationId: op(), checkId: id2,
    discount: { type: 'percent', value: 20, reason: 'kampanya' },
    payments: [{ method: 'cash', amount: 336 }]
  }));
  assert.strictEqual(r.due, 336);
  const audit = await db.collection('restAudit').where('tenantId', '==', T).where('checkId', '==', id2).get();
  assert.strictEqual(audit.docs[0].data().meta.discountReason, 'kampanya');
});

test('KÜÇÜK indirim (≤%10) staff için serbest', async () => {
  const id = await seedCheck();
  const r = await core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id,
    discount: { type: 'percent', value: 5, reason: '' },
    payments: [{ method: 'cash', amount: 399 }]
  }));
  assert.strictEqual(r.due, 399);
});

test('VOID: gönderilmiş kalemli iptal STAFF için ROLE_DENIED', async () => {
  const id = await seedCheck();
  await assert.rejects(core.voidCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: id, reason: 'müşteri vazgeçti'
  })), (e) => e.errCode === core.ERR.ROLE_DENIED);
});

test('VOID: manager SEBEPSİZ iptal edemez (REASON_REQUIRED)', async () => {
  const id = await seedCheck();
  await assert.rejects(core.voidCore(db, Object.assign(actor('manager'), {
    operationId: op(), checkId: id, reason: '  '
  })), (e) => e.errCode === core.ERR.REASON_REQUIRED);
});

test('VOID: manager + sebep → void, stok düşer, kilit temizlenir, audit', async () => {
  const id = await seedCheck();
  await db.collection('restTables').doc(T + '__masa t').set({ tenantId: T, table: 'Masa T', tableKey: 'masa t', openCheckId: id });
  const r = await core.voidCore(db, Object.assign(actor('manager'), {
    operationId: op(), checkId: id, reason: 'yanlış sipariş'
  }));
  assert.strictEqual(r.voided, true);
  const c = (await db.collection('restChecks').doc(id).get()).data();
  assert.strictEqual(c.status, 'void');
  assert.strictEqual(c.voidReason, 'yanlış sipariş');
  assert.strictEqual(c.voidByRole, 'manager');
  const kofte = (await db.collection('restMenu').doc('menu-kofte').get()).data();
  assert.strictEqual(kofte.stock, 8, 'gönderilmiş kalem stoğu düşmeli');
  const lock = await db.collection('restTables').doc(T + '__masa t').get();
  assert.strictEqual(lock.exists, false, 'masa kilidi temizlenmeli');
  const audit = await db.collection('restAudit').where('tenantId', '==', T).where('checkId', '==', id).get();
  assert.strictEqual(audit.docs[0].data().action, 'void');
});

test('VOID: hiç gönderilmemiş boş adisyonu STAFF iptal edebilir', async () => {
  const id = await seedCheck({ status: 'open' }, [{ lineId: 'l1', name: 'Çay', qty: 1, unitPrice: 20, sent: false }]);
  const r = await core.voidCore(db, Object.assign(actor('staff'), { operationId: op(), checkId: id, reason: '' }));
  assert.strictEqual(r.voided, true);
});

test('VOID: ödenmiş adisyon iptal EDİLEMEZ', async () => {
  const id = await seedCheck({ status: 'paid' });
  await assert.rejects(core.voidCore(db, Object.assign(actor('admin'), {
    operationId: op(), checkId: id, reason: 'x'
  })), (e) => e.errCode === core.ERR.CHECK_IMMUTABLE);
});

test('FOLIO kapatma: staff ROLE_DENIED; manager OK + idempotent + audit', async () => {
  const f1 = await db.collection('folioCharges').add({ tenantId: T, room: '101', amount: 100, currency: 'TRY', status: 'open' });
  const f2 = await db.collection('folioCharges').add({ tenantId: T, room: '101', amount: 50, currency: 'TRY', status: 'open' });

  await assert.rejects(core.folioSettleCore(db, Object.assign(actor('staff'), {
    operationId: op(), chargeIds: [f1.id, f2.id]
  })), (e) => e.errCode === core.ERR.ROLE_DENIED);

  const o = op();
  const r1 = await core.folioSettleCore(db, Object.assign(actor('manager'), { operationId: o, chargeIds: [f1.id, f2.id] }));
  assert.strictEqual(r1.settled, 2);
  assert.strictEqual(r1.total, 150);
  const r2 = await core.folioSettleCore(db, Object.assign(actor('manager'), { operationId: o, chargeIds: [f1.id, f2.id] }));
  assert.strictEqual(r2.replay, true);
  const d1 = (await db.collection('folioCharges').doc(f1.id).get()).data();
  assert.strictEqual(d1.status, 'settled');
});

test('TENANT MISMATCH: başka otelin adisyonu ödenemez', async () => {
  const foreign = await db.collection('restChecks').add({
    tenantId: 'hotel-b', status: 'sent', version: 1, items: [{ lineId: 'x', name: 'X', qty: 1, unitPrice: 100 }], total: 100
  });
  await assert.rejects(core.settleCore(db, Object.assign(actor('staff'), {
    operationId: op(), checkId: foreign.id, payments: [{ method: 'cash', amount: 100 }]
  })), (e) => e.errCode === core.ERR.TENANT_MISMATCH);
});
