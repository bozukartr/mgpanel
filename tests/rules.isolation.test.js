/* Faz 1 — tenant izolasyonu ve temel erişim kuralları (restChecks odaklı).
 * Emülatörde firestore.rules'un GERÇEK halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, collection, getDocs, query, where } = require('firebase/firestore');
const { rulesEnv, staffCtx, anonCtx, seedTenant } = require('./helpers');

const PID = 'rules-isolation-test';
let env;

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // rules-unit-testing bağlamı modular API verir; seedTenant admin-SDK
    // batch bekler — burada küçük bir uyarlayıcıyla aynı veriyi yazamayız,
    // o yüzden seed'i admin SDK ile değil bu bağlamla yapıyoruz:
    const { doc: d, setDoc: s, writeBatch } = require('firebase/firestore');
    for (const t of ['hotel-a', 'hotel-b']) {
      const b = writeBatch(db);
      b.set(d(db, 'systemUsers', `${t}-admin`), { tenantId: t, username: `${t}.admin`, role: 'admin' });
      b.set(d(db, 'systemUsers', `${t}-staff`), { tenantId: t, username: `${t}.garson`, role: 'staff', department: 'Restoran' });
      b.set(d(db, 'restChecks', `${t}-check-open`), {
        tenantId: t, status: 'open', checkNo: 100, tableName: 'Masa 5', tableKey: 'masa 5',
        section: 'Genel', pax: 2, version: 1, items: [], subtotal: 0, vat: 0, total: 0
      });
      b.set(d(db, 'folioCharges', `${t}-folio1`), { tenantId: t, room: '101', amount: 150, currency: 'TRY', status: 'open' });
      b.set(d(db, 'restMenu', `${t}-menu1`), { tenantId: t, name: 'Çay', price: 20, active: true });
      await b.commit();
    }
    await s(d(db, 'superAdmins', 'super-1'), { note: 'platform operatörü' });
  });
});
after(async () => { if (env) await env.cleanup(); });

test('kendi otelinin adisyonunu personel OKUYABİLİR', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertSucceeds(getDoc(doc(db, 'restChecks', 'hotel-a-check-open')));
});

test('BAŞKA otelin adisyonunu personel OKUYAMAZ', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(getDoc(doc(db, 'restChecks', 'hotel-b-check-open')));
});

test('BAŞKA otelin adisyon listesi sorgusu REDDEDİLİR', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(getDocs(query(collection(db, 'restChecks'), where('tenantId', '==', 'hotel-b'))));
});

test('anonim oturum restChecks OKUYAMAZ', async () => {
  const db = anonCtx(env, 'anon-1').firestore();
  await assertFails(getDoc(doc(db, 'restChecks', 'hotel-a-check-open')));
});

test('personel BAŞKA otele adisyon YAZAMAZ (tenant sahteciliği)', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(setDoc(doc(db, 'restChecks', 'fake-1'), {
    tenantId: 'hotel-b', status: 'open', items: [], version: 1
  }));
});

test('folioCharges tenant izolasyonu (okuma)', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(getDoc(doc(db, 'folioCharges', 'hotel-b-folio1')));
  await assertSucceeds(getDoc(doc(db, 'folioCharges', 'hotel-a-folio1')));
});

test('süperadmin her tenantı okuyabilir', async () => {
  const db = staffCtx(env, 'super-1').firestore();
  await assertSucceeds(getDoc(doc(db, 'restChecks', 'hotel-a-check-open')));
  await assertSucceeds(getDoc(doc(db, 'restChecks', 'hotel-b-check-open')));
});
