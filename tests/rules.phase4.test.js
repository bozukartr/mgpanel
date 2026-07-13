/* Faz 4 — kural sıkılaştırmaları: istemci paid/void yazamaz; menü yazımı
 * manager/admin; folioCharges istemci update/delete kapalı; restOps/
 * restAudit istemciye kapalı (audit'i admin okur). */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch } = require('firebase/firestore');
const { rulesEnv, staffCtx } = require('./helpers');

const PID = 'rules-phase4-test';
const T = 'hotel-a';
let env;

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const b = writeBatch(db);
    b.set(doc(db, 'systemUsers', 'staff-1'), { tenantId: T, username: 'garson', role: 'staff' });
    b.set(doc(db, 'systemUsers', 'mgr-1'), { tenantId: T, username: 'sef', role: 'manager' });
    b.set(doc(db, 'systemUsers', 'adm-1'), { tenantId: T, username: 'patron', role: 'admin' });
    b.set(doc(db, 'restChecks', 'c1'), { tenantId: T, status: 'sent', version: 2, items: [], total: 100 });
    b.set(doc(db, 'restMenu', 'm1'), { tenantId: T, name: 'Çay', price: 20, trackStock: true, stock: 5 });
    b.set(doc(db, 'folioCharges', 'f1'), { tenantId: T, room: '101', amount: 100, status: 'open' });
    b.set(doc(db, 'restOps', T + '_op1'), { tenantId: T, kind: 'settle', result: {} });
    b.set(doc(db, 'restAudit', 'a1'), { tenantId: T, action: 'void', uid: 'x', amount: 50 });
    await b.commit();
  });
});
after(async () => { if (env) await env.cleanup(); });

const as = (uid) => staffCtx(env, uid).firestore();

test('istemci adisyonu PAID yapamaz (ödeme yalnız sunucu fonksiyonu)', async () => {
  await assertFails(updateDoc(doc(as('staff-1'), 'restChecks', 'c1'), { status: 'paid', version: 3 }));
  await assertFails(updateDoc(doc(as('adm-1'), 'restChecks', 'c1'), { status: 'paid', version: 3 }));
});

test('istemci adisyonu VOID yapamaz (iptal yalnız sunucu fonksiyonu)', async () => {
  await assertFails(updateDoc(doc(as('mgr-1'), 'restChecks', 'c1'), { status: 'void', version: 3 }));
});

test('MENÜ yazımı: staff RED, manager/admin OK', async () => {
  await assertFails(updateDoc(doc(as('staff-1'), 'restMenu', 'm1'), { price: 1 }));
  await assertFails(setDoc(doc(as('staff-1'), 'restMenu', 'm-new'), { tenantId: T, name: 'Hile', price: 0 }));
  await assertFails(deleteDoc(doc(as('staff-1'), 'restMenu', 'm1')));
  await assertSucceeds(updateDoc(doc(as('mgr-1'), 'restMenu', 'm1'), { price: 25 }));
  await assertSucceeds(setDoc(doc(as('adm-1'), 'restMenu', 'm-new'), { tenantId: T, name: 'Yeni', price: 30 }));
});

test('STOK alanını staff SDK ile değiştiremez (menü yazım kuralı kapsar)', async () => {
  await assertFails(updateDoc(doc(as('staff-1'), 'restMenu', 'm1'), { stock: 999 }));
});

test('folioCharges: istemci CREATE/UPDATE/DELETE edemez (tüm yazımlar sunucu fonksiyonu — F4.5)', async () => {
  await assertFails(updateDoc(doc(as('adm-1'), 'folioCharges', 'f1'), { status: 'settled' }));
  await assertFails(deleteDoc(doc(as('adm-1'), 'folioCharges', 'f1')));
  await assertFails(setDoc(doc(as('staff-1'), 'folioCharges', 'f-new'), {
    tenantId: T, room: '102', amount: 60, currency: 'TRY', status: 'open'
  }));
});

test('restOps istemciye tamamen KAPALI', async () => {
  await assertFails(getDoc(doc(as('adm-1'), 'restOps', T + '_op1')));
  await assertFails(setDoc(doc(as('adm-1'), 'restOps', T + '_op2'), { tenantId: T }));
});

test('restAudit: istemci YAZAMAZ; admin kendi tenantını OKUR, staff okuyamaz', async () => {
  await assertFails(setDoc(doc(as('adm-1'), 'restAudit', 'a-new'), { tenantId: T, action: 'hile' }));
  await assertFails(updateDoc(doc(as('adm-1'), 'restAudit', 'a1'), { amount: 0 }));
  await assertSucceeds(getDoc(doc(as('adm-1'), 'restAudit', 'a1')));
  await assertFails(getDoc(doc(as('staff-1'), 'restAudit', 'a1')));
});
