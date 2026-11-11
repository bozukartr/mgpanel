/* Face ID (passkey) — Firestore kuralları.
 *   webauthnCredentials : DENY-ALL — cihaz açık anahtarları ve sayaçlar
 *                         yalnızca Cloud Functions (Admin SDK) ile okunur/yazılır.
 *   webauthnChallenges  : DENY-ALL — tek kullanımlık doğrulama dizeleri.
 *   systemUsers.faceIdAllowed : yalnızca otel yöneticisi açar/kapatır;
 *                         kullanıcı kendi hesabında açamaz (öz-güncelleme
 *                         yalnızca mustChangePassword=false).
 * Emülatörde firestore.rules'un GERÇEK halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where } = require('firebase/firestore');
const { rulesEnv, staffCtx, anonCtx } = require('./helpers');

const PID = 'passkey-rules-test';
let env;

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'superAdmins', 'super-1'), { note: 'platform operatörü' });
    await setDoc(doc(db, 'systemUsers', 'a-admin'), { tenantId: 'hotel-a', username: 'a.admin', role: 'admin' });
    await setDoc(doc(db, 'systemUsers', 'a-staff'), { tenantId: 'hotel-a', username: 'a.ayse', role: 'staff', faceIdAllowed: false, mustChangePassword: true });
    await setDoc(doc(db, 'systemUsers', 'b-admin'), { tenantId: 'hotel-b', username: 'b.admin', role: 'admin' });
    await setDoc(doc(db, 'webauthnCredentials', 'cred-1'), { uid: 'a-staff', tenantId: 'hotel-a', rpID: 'a.hotizy.com', publicKey: 'pk', counter: 3 });
    await setDoc(doc(db, 'webauthnChallenges', 'ch-1'), { type: 'auth', challenge: 'xyz', rpID: 'a.hotizy.com', expiresAt: Date.now() + 60000 });
  });
});
after(async () => { if (env) await env.cleanup(); });

const who = () => [
  ['süperadmin', staffCtx(env, 'super-1')],
  ['otel admin', staffCtx(env, 'a-admin')],
  ['kaydın sahibi', staffCtx(env, 'a-staff')],
  ['anonim misafir', anonCtx(env, 'anon-1')],
  ['oturumsuz', env.unauthenticatedContext()]
];

test('webauthnCredentials: hiçbir istemci okuyamaz / listeleyemez / yazamaz / silemez', async () => {
  for (const [name, ctx] of who()) {
    const db = ctx.firestore();
    await assertFails(getDoc(doc(db, 'webauthnCredentials', 'cred-1')), name);
    await assertFails(getDocs(query(collection(db, 'webauthnCredentials'), where('uid', '==', 'a-staff'))), name);
    await assertFails(setDoc(doc(db, 'webauthnCredentials', 'sahte'), { uid: 'a-admin', publicKey: 'saldirgan', rpID: 'a.hotizy.com', counter: 0 }), name);
    await assertFails(updateDoc(doc(db, 'webauthnCredentials', 'cred-1'), { counter: 0 }), name);
    await assertFails(deleteDoc(doc(db, 'webauthnCredentials', 'cred-1')), name);
  }
});

test('webauthnChallenges: hiçbir istemci okuyamaz / yazamaz', async () => {
  for (const [name, ctx] of who()) {
    const db = ctx.firestore();
    await assertFails(getDoc(doc(db, 'webauthnChallenges', 'ch-1')), name);
    await assertFails(setDoc(doc(db, 'webauthnChallenges', 'reg_a-staff'), { type: 'reg', uid: 'a-staff', challenge: 'bilinen' }), name);
    await assertFails(deleteDoc(doc(db, 'webauthnChallenges', 'ch-1')), name);
  }
});

test('kullanıcı kendi Face ID iznini AÇAMAZ', async () => {
  const db = staffCtx(env, 'a-staff').firestore();
  await assertFails(updateDoc(doc(db, 'systemUsers', 'a-staff'), { faceIdAllowed: true }));
  await assertFails(updateDoc(doc(db, 'systemUsers', 'a-staff'), { faceIdAllowed: true, mustChangePassword: false }));
  // Mevcut öz-güncelleme yolu bozulmadı.
  await assertSucceeds(updateDoc(doc(db, 'systemUsers', 'a-staff'), { mustChangePassword: false }));
});

test('otel yöneticisi kendi otelindeki kullanıcıda açar/kapatır; başka otelinkinde yapamaz', async () => {
  await assertSucceeds(updateDoc(doc(staffCtx(env, 'a-admin').firestore(), 'systemUsers', 'a-staff'), { faceIdAllowed: true }));
  await assertSucceeds(updateDoc(doc(staffCtx(env, 'a-admin').firestore(), 'systemUsers', 'a-staff'), { faceIdAllowed: false }));
  await assertFails(updateDoc(doc(staffCtx(env, 'b-admin').firestore(), 'systemUsers', 'a-staff'), { faceIdAllowed: true }));
});
