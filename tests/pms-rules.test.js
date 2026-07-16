/* PMS güvenlik denetimi — Firestore kuralları:
 *   pmsConfig     : yalnızca superadmin okur/yazar (mevcut davranış — regresyon koruması)
 *   pmsOAuthCache : DENY-ALL — superadmin DAHİL hiçbir client SDK çağrısı canlı
 *                   OAuth2 bearer token'ı okuyamaz/yazamaz (yalnızca Admin SDK).
 * Emülatörde firestore.rules'un GERÇEK halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const { rulesEnv, staffCtx, anonCtx } = require('./helpers');

const PID = 'pms-rules-test';
let env;

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const { doc: d, setDoc: s } = require('firebase/firestore');
    await s(d(db, 'superAdmins', 'super-1'), { note: 'platform operatörü' });
    await s(d(db, 'systemUsers', 'hotel-a-admin'), { tenantId: 'hotel-a', username: 'hotel-a.admin', role: 'admin' });
    await s(d(db, 'systemUsers', 'hotel-a-staff'), { tenantId: 'hotel-a', username: 'hotel-a.garson', role: 'staff' });
    await s(d(db, 'pmsConfig', 'hotel-a'), {
      enabled: true, provider: 'generic', apiKey: 'iv:tag:cipher',
      extraHeaders: { 'x-app-key': 'iv2:tag2:cipher2' }
    });
    await s(d(db, 'pmsOAuthCache', 'hotel-a'), { token: 'canli-bearer-token-xyz', expiresAt: Date.now() + 300000 });
  });
});
after(async () => { if (env) await env.cleanup(); });

test('süperadmin pmsConfig OKUYABİLİR (mevcut davranış — ayar formu için gerekli)', async () => {
  const db = staffCtx(env, 'super-1').firestore();
  await assertSucceeds(getDoc(doc(db, 'pmsConfig', 'hotel-a')));
});

test('otel admin/staff pmsConfig OKUYAMAZ', async () => {
  await assertFails(getDoc(doc(staffCtx(env, 'hotel-a-admin').firestore(), 'pmsConfig', 'hotel-a')));
  await assertFails(getDoc(doc(staffCtx(env, 'hotel-a-staff').firestore(), 'pmsConfig', 'hotel-a')));
});

test('anonim (QR misafir) pmsConfig OKUYAMAZ', async () => {
  await assertFails(getDoc(doc(anonCtx(env, 'anon-1').firestore(), 'pmsConfig', 'hotel-a')));
});

// ── pmsOAuthCache: canlı bearer token — deny-all, superadmin dahil ──
test('süperadmin pmsOAuthCache OKUYAMAZ (canlı token client SDK ile hiç çekilemez)', async () => {
  const db = staffCtx(env, 'super-1').firestore();
  await assertFails(getDoc(doc(db, 'pmsOAuthCache', 'hotel-a')));
});

test('süperadmin pmsOAuthCache YAZAMAZ', async () => {
  const db = staffCtx(env, 'super-1').firestore();
  await assertFails(setDoc(doc(db, 'pmsOAuthCache', 'hotel-a'), { token: 'x', expiresAt: 0 }));
});

test('otel admin pmsOAuthCache OKUYAMAZ', async () => {
  const db = staffCtx(env, 'hotel-a-admin').firestore();
  await assertFails(getDoc(doc(db, 'pmsOAuthCache', 'hotel-a')));
});

test('anonim (QR misafir) pmsOAuthCache OKUYAMAZ', async () => {
  const db = anonCtx(env, 'anon-1').firestore();
  await assertFails(getDoc(doc(db, 'pmsOAuthCache', 'hotel-a')));
});

test('hiç kimliği doğrulanmamış istek pmsOAuthCache OKUYAMAZ', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'pmsOAuthCache', 'hotel-a')));
});
