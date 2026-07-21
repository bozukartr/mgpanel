/* serviceRatings — misafirin tamamlanmış QR talebine verdiği 1-5 yıldız
 * değerlendirme. Koleksiyon tamamen sunucu-yazımlı (functions/index.js:
 * submitItemRating callable): "bu kalem gerçekten bu misafirin siparişine
 * ait mi / tamamlandı mı / daha önce değerlendirildi mi" kontrolü
 * guestOrders'ın taze okunmasını gerektirir, deklaratif rules dilinde
 * ifade edilemez — bu yüzden rules yalnızca personel-okur/hiç-client-yazamaz
 * uygular (restAudit ile AYNI desen). Emülatörde firestore.rules'un GERÇEK
 * halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');
const { rulesEnv, staffCtx, anonCtx } = require('./helpers');

const PID = 'service-ratings-rules-test';
let env;

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const { doc: d, setDoc: s } = require('firebase/firestore');
    await s(d(db, 'systemUsers', 'hotel-a-staff'), { tenantId: 'hotel-a', username: 'hotel-a.garson', role: 'staff', department: 'Restoran' });
    await s(d(db, 'systemUsers', 'hotel-b-staff'), { tenantId: 'hotel-b', username: 'hotel-b.garson', role: 'staff', department: 'Restoran' });
    await s(d(db, 'serviceRatings', 'qr_rating_ord1_i0'), {
      tenantId: 'hotel-a', orderId: 'ord1', itemId: 'i0', room: '101',
      department: 'Housekeeping', category: 'Temizlik', name: 'Havlu', stars: 4
    });
  });
});
after(async () => { if (env) await env.cleanup(); });

test('serviceRatings: AYNI tenant personeli okuyabilir', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertSucceeds(getDoc(doc(db, 'serviceRatings', 'qr_rating_ord1_i0')));
});

test('serviceRatings: BAŞKA tenant personeli okuyamaz', async () => {
  const db = staffCtx(env, 'hotel-b-staff').firestore();
  await assertFails(getDoc(doc(db, 'serviceRatings', 'qr_rating_ord1_i0')));
});

test('serviceRatings: misafir (anonim) DOĞRUDAN yeni bir değerlendirme YAZAMAZ (yalnızca submitItemRating callable üzerinden)', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertFails(setDoc(doc(db, 'serviceRatings', 'qr_rating_ord2_i0'), {
    tenantId: 'hotel-a', orderId: 'ord2', itemId: 'i0', room: '101',
    department: 'Housekeeping', category: 'Temizlik', name: 'Havlu', stars: 5
  }));
});

test('serviceRatings: personel bile DOĞRUDAN yazamaz/güncelleyemez (tek yazım yolu callable)', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(setDoc(doc(db, 'serviceRatings', 'qr_rating_ord3_i0'), {
    tenantId: 'hotel-a', orderId: 'ord3', itemId: 'i0', room: '101',
    department: 'Housekeeping', category: 'Temizlik', name: 'Havlu', stars: 3
  }));
  await assertFails(updateDoc(doc(db, 'serviceRatings', 'qr_rating_ord1_i0'), { stars: 1 }));
});

test('serviceRatings: hiç kimse silemez', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(deleteDoc(doc(db, 'serviceRatings', 'qr_rating_ord1_i0')));
});
