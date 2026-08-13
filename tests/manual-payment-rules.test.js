/* Elle ödeme kaydı (`payments`) — sunucu tarafı yetki ve alan sınırları.
 *
 * Online ödeme (PayTR / Lemon Squeezy) üründen kaldırıldı: bu koleksiyona
 * eskiden YALNIZCA webhook'lar (Admin SDK, kuralları atlar) yazıyordu ve kural
 * `allow write: if false` idi. Tahsilat artık çevrim dışı yapılıp platform
 * operatörü tarafından elle kaydedildiğinden yazım superadmin'e açıldı — bu
 * testler açılan yüzeyin DAR kaldığını kilitler:
 *   · otel yöneticisi kendi kaydını OKUR ama YAZAMAZ (ciro uydurulamaz),
 *   · başka otelin kaydını okuyamaz,
 *   · superadmin yazar ama alan sınırlarının dışına çıkamaz. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc } = require('firebase/firestore');
const { rulesEnv, staffCtx } = require('./helpers');

const PID = 'manual-payment-rules-test';
let env;

const ok = (over) => Object.assign({
  tenantId: 'hotel-a', plan: 'pro', amount: 99, currency: 'EUR',
  status: 'success', method: 'transfer', note: 'Dekont 123'
}, over);

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'superAdmins', 'op-1'), { email: 'op@hotizy.com' });
    await setDoc(doc(db, 'systemUsers', 'admin-a'), { tenantId: 'hotel-a', role: 'admin', username: 'a' });
    await setDoc(doc(db, 'systemUsers', 'admin-b'), { tenantId: 'hotel-b', role: 'admin', username: 'b' });
    await setDoc(doc(db, 'payments', 'MAN-hotel-a-20260101-9900'), ok({ paidAt: new Date() }));
  });
});
after(async () => { if (env) await env.cleanup(); });

test('superadmin elle ödeme kaydı OLUŞTURABİLİR', async () => {
  const db = staffCtx(env, 'op-1').firestore();
  await assertSucceeds(setDoc(doc(db, 'payments', 'MAN-hotel-a-20260202-4900'), ok({ amount: 49 })));
});

test('otel yöneticisi KENDİ otelinin kaydını okur ama YAZAMAZ', async () => {
  const db = staffCtx(env, 'admin-a').firestore();
  await assertSucceeds(getDoc(doc(db, 'payments', 'MAN-hotel-a-20260101-9900')));
  // Kritik: otel kendi cirosunu uyduramamalı.
  await assertFails(setDoc(doc(db, 'payments', 'MAN-hotel-a-20260303-1'), ok({ amount: 1 })));
});

test('otel yöneticisi BAŞKA otelin kaydını okuyamaz', async () => {
  const db = staffCtx(env, 'admin-b').firestore();
  await assertFails(getDoc(doc(db, 'payments', 'MAN-hotel-a-20260101-9900')));
});

test('tutar 0/negatif ya da sayı değilse REDDEDİLİR', async () => {
  const db = staffCtx(env, 'op-1').firestore();
  await assertFails(setDoc(doc(db, 'payments', 'bad-1'), ok({ amount: 0 })));
  await assertFails(setDoc(doc(db, 'payments', 'bad-2'), ok({ amount: -50 })));
  await assertFails(setDoc(doc(db, 'payments', 'bad-3'), ok({ amount: '99' })));
  // Üst sınır: tek kayıtla ciroyu uçurmak mümkün olmamalı.
  await assertFails(setDoc(doc(db, 'payments', 'bad-4'), ok({ amount: 9999999 })));
});

test('status "success" dışında olamaz (ciro yalnızca gerçekleşmiş tahsilattır)', async () => {
  const db = staffCtx(env, 'op-1').firestore();
  await assertFails(setDoc(doc(db, 'payments', 'bad-5'), ok({ status: 'pending' })));
});

test('tenantId eksik/boş ya da aşırı uzun alanlar REDDEDİLİR', async () => {
  const db = staffCtx(env, 'op-1').firestore();
  await assertFails(setDoc(doc(db, 'payments', 'bad-6'), ok({ tenantId: '' })));
  await assertFails(setDoc(doc(db, 'payments', 'bad-7'), ok({ note: 'x'.repeat(301) })));
  await assertFails(setDoc(doc(db, 'payments', 'bad-8'), ok({ method: 'm'.repeat(41) })));
});

test('oturumsuz kullanıcı ne okuyabilir ne yazabilir', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'payments', 'MAN-hotel-a-20260101-9900')));
  await assertFails(setDoc(doc(db, 'payments', 'bad-9'), ok()));
});
