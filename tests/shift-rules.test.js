/* Vardiya konumu (shiftConfig) — Firestore kuralları:
 *   shiftConfig/{tid} : personel OKUR (kendi vardiya durumunu hesaplamak
 *                        için), yalnızca ADMIN yazar; başka otelin
 *                        yapılandırmasına kimse erişemez.
 * Emülatörde firestore.rules'un GERÇEK halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const { rulesEnv, staffCtx, anonCtx } = require('./helpers');

const PID = 'shift-rules-test';
let env;

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const { doc: d, setDoc: s } = require('firebase/firestore');
    await s(d(db, 'systemUsers', 'hotel-a-admin'), { tenantId: 'hotel-a', username: 'hotel-a.admin', role: 'admin' });
    await s(d(db, 'systemUsers', 'hotel-a-staff'), { tenantId: 'hotel-a', username: 'hotel-a.garson', role: 'staff' });
    await s(d(db, 'systemUsers', 'hotel-b-staff'), { tenantId: 'hotel-b', username: 'hotel-b.garson', role: 'staff' });
    await s(d(db, 'shiftConfig', 'hotel-a'), { tenantId: 'hotel-a', enabled: true, lat: 36.9, lng: 30.7, radiusM: 150 });
  });
});
after(async () => { if (env) await env.cleanup(); });

test('kendi otelinin personeli shiftConfig OKUYABİLİR', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertSucceeds(getDoc(doc(db, 'shiftConfig', 'hotel-a')));
});

test('BAŞKA otelin personeli shiftConfig OKUYAMAZ', async () => {
  const db = staffCtx(env, 'hotel-b-staff').firestore();
  await assertFails(getDoc(doc(db, 'shiftConfig', 'hotel-a')));
});

test('anonim (QR misafir) shiftConfig OKUYAMAZ', async () => {
  const db = anonCtx(env, 'anon-1').firestore();
  await assertFails(getDoc(doc(db, 'shiftConfig', 'hotel-a')));
});

test('normal personel shiftConfig YAZAMAZ', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(setDoc(doc(db, 'shiftConfig', 'hotel-a'), { tenantId: 'hotel-a', enabled: false, lat: 0, lng: 0, radiusM: 100 }));
});

test('otel admin\'i KENDİ oteli için shiftConfig YAZABİLİR', async () => {
  const db = staffCtx(env, 'hotel-a-admin').firestore();
  await assertSucceeds(setDoc(doc(db, 'shiftConfig', 'hotel-a'), { tenantId: 'hotel-a', enabled: true, lat: 36.91, lng: 30.71, radiusM: 200 }));
});

test('admin BAŞKA otelin shiftConfig\'ini YAZAMAZ (tenant sahteciliği)', async () => {
  const db = staffCtx(env, 'hotel-a-admin').firestore();
  await assertFails(setDoc(doc(db, 'shiftConfig', 'hotel-b'), { tenantId: 'hotel-b', enabled: true, lat: 0, lng: 0, radiusM: 100 }));
});

// ── presence: personel kendi onShift/shiftCheckedAt alanlarını yazabilir ──
test('personel kendi presence belgesine onShift/shiftCheckedAt YAZABİLİR (mevcut sahiplik kuralı kapsıyor)', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertSucceeds(setDoc(doc(db, 'presence', 'hotel-a-staff'), {
    uid: 'hotel-a-staff', username: 'garson', dept: 'Housekeeping', tenantId: 'hotel-a',
    online: true, onShift: false, shiftCheckedAt: new Date()
  }));
});

test('personel BAŞKASININ presence belgesine onShift YAZAMAZ', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(setDoc(doc(db, 'presence', 'hotel-a-admin'), {
    uid: 'hotel-a-admin', tenantId: 'hotel-a', onShift: false
  }));
});
