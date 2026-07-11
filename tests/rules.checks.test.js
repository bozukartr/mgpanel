/* Faz 3 — adisyon durum makinesi + version disiplini (firestore.rules).
 * "Eski cihaz ödenmiş adisyonu kaydetmeye çalışır" senaryosu dahil. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, writeBatch } = require('firebase/firestore');
const { rulesEnv, staffCtx } = require('./helpers');

const PID = 'rules-checks-test';
const T = 'hotel-a';
let env;

function baseCheck(over) {
  return Object.assign({
    tenantId: T, status: 'open', version: 3, checkNo: 10, tableName: 'Masa 1', tableKey: 'masa 1',
    section: 'Genel', pax: 2, items: [{ lineId: 'l1', name: 'Çay', qty: 1, unitPrice: 20 }],
    subtotal: 20, vat: 1.8, total: 20
  }, over);
}

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const b = writeBatch(db);
    b.set(doc(db, 'systemUsers', 'staff-1'), { tenantId: T, username: 'garson', role: 'staff', department: 'Restoran' });
    b.set(doc(db, 'restChecks', 'c-open'), baseCheck());
    b.set(doc(db, 'restChecks', 'c-sent'), baseCheck({ status: 'sent' }));
    b.set(doc(db, 'restChecks', 'c-paid'), baseCheck({ status: 'paid' }));
    b.set(doc(db, 'restChecks', 'c-void'), baseCheck({ status: 'void' }));
    b.set(doc(db, 'restChecks', 'c-legacy'), (() => { const c = baseCheck(); delete c.version; return c; })()); // version'suz eski doküman
    await b.commit();
  });
});
after(async () => { if (env) await env.cleanup(); });

const db = () => staffCtx(env, 'staff-1').firestore();

test('ÖDENMİŞ adisyona kalem yazmak REDDEDİLİR (bayat cihaz senaryosu)', async () => {
  await assertFails(updateDoc(doc(db(), 'restChecks', 'c-paid'), {
    items: [{ lineId: 'hile', name: 'Sonradan', qty: 1, unitPrice: 999 }], version: 4
  }));
});

test('İPTAL adisyon güncellenemez', async () => {
  await assertFails(updateDoc(doc(db(), 'restChecks', 'c-void'), { note: 'x', version: 4 }));
});

test('open adisyon DOĞRU version (+1) ile güncellenir', async () => {
  await assertSucceeds(updateDoc(doc(db(), 'restChecks', 'c-open'), { note: 'ok', version: 4 }));
});

test('AYNI version ile güncelleme REDDEDİLİR (bayat cihaz)', async () => {
  // c-open az önce version 4 oldu — 4 tekrar gönderilirse red.
  await assertFails(updateDoc(doc(db(), 'restChecks', 'c-open'), { note: 'stale', version: 4 }));
});

test('version ATLAMA (+2) REDDEDİLİR', async () => {
  await assertFails(updateDoc(doc(db(), 'restChecks', 'c-open'), { note: 'skip', version: 7 }));
});

test('version alanı olmayan ESKİ doküman ilk güncellemede version:1 ister', async () => {
  await assertFails(updateDoc(doc(db(), 'restChecks', 'c-legacy'), { note: 'x' })); // version'suz güncelleme
  await assertSucceeds(updateDoc(doc(db(), 'restChecks', 'c-legacy'), { note: 'x', version: 1 }));
});

test('sent → open GERİ dönüş REDDEDİLİR', async () => {
  await assertFails(updateDoc(doc(db(), 'restChecks', 'c-sent'), { status: 'open', version: 4 }));
});

test('open → sent geçişi (mutfağa gönder) kabul edilir', async () => {
  await assertSucceeds(updateDoc(doc(db(), 'restChecks', 'c-open'), { status: 'sent', version: 5 }));
});

test('Faz 4: istemci sent → paid YAZAMAZ (ödeme yalnız restSettleCheck)', async () => {
  await assertFails(updateDoc(doc(db(), 'restChecks', 'c-sent'), { status: 'paid', version: 4 }));
});

test('paid adisyon SİLİNEMEZ', async () => {
  await assertFails(deleteDoc(doc(db(), 'restChecks', 'c-paid')));
});

test('void adisyon SİLİNEMEZ', async () => {
  await assertFails(deleteDoc(doc(db(), 'restChecks', 'c-void')));
});

test('open adisyon silinebilir (birleştirme kaynağı)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'restChecks', 'c-del'), baseCheck());
  });
  await assertSucceeds(deleteDoc(doc(db(), 'restChecks', 'c-del')));
});

test('istemci PAID adisyon OLUŞTURAMAZ', async () => {
  await assertFails(setDoc(doc(db(), 'restChecks', 'c-new-paid'), baseCheck({ status: 'paid', version: 1 })));
});

test('istemci version:1 olmadan adisyon OLUŞTURAMAZ', async () => {
  const c = baseCheck(); delete c.version;
  await assertFails(setDoc(doc(db(), 'restChecks', 'c-new-nover'), c));
  await assertSucceeds(setDoc(doc(db(), 'restChecks', 'c-new-ok'), baseCheck({ version: 1 })));
});
