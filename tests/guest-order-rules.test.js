/* Misafir QR siparişi (guestOrders) — sunucu tarafı güvenlik kuralları:
 *   - kalem şekli/aralığı (qty 1-10, string uzunlukları) doğrulanır
 *   - sipariş yalnızca, çağıranın verifiedGuestSessions/{uid} dokümanındaki
 *     GERÇEK odasıyla eşleşen room değeriyle oluşturulabilir (mandatory
 *     doğrulama — bkz. functions/index.js:verifyGuestIdentity). İstemcinin
 *     gönderdiği room değeri artık TEK BAŞINA hiçbir şey kanıtlamaz.
 *   - verifiedGuestSessions doğrulaması, guestDirectory.status=='in_house'
 *     canlı kontrolüyle bağlıdır — checkout sonrası oturum otomatik geçersiz.
 *   - sistemin KANITLA bildiği (check-out yapılmış, roomAccess.open=false)
 *     bir odaya, doğrulanmış oturum olsa BİLE sipariş açılamaz (ek katman).
 *   - verifiedGuestSessions dokümanı istemciye (personel veya misafir) hiç
 *     okunamaz/yazılamaz — yalnızca Admin SDK.
 * Emülatörde firestore.rules'un GERÇEK halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, collection, addDoc } = require('firebase/firestore');
const { rulesEnv, anonCtx } = require('./helpers');

const PID = 'guest-order-rules-test';
const T = 'hotel-a';
let env;

function baseOrder(overrides) {
  return Object.assign({
    sessionUid: 'guest-1',
    status: 'pending',
    tenantId: T,
    room: '101',
    items: [{ id: 'i1', name: 'Su', qty: 1, category: 'Oda Servisi' }]
  }, overrides);
}

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const { doc: d, setDoc: s } = require('firebase/firestore');

    // guestDirectory: 101 in_house (doğrulanmış oturumla eşleşecek), 204
    // checked_out (guestDirectory tarafında da artık in_house değil).
    await s(d(db, 'guestDirectory', 'guest-101'), { tenantId: T, room: '101', status: 'in_house', name: 'Ayşe Yılmaz', birthYear: 1990 });
    await s(d(db, 'guestDirectory', 'guest-204'), { tenantId: T, room: '204', status: 'checked_out', name: 'Eski Misafir', birthYear: 1985 });

    // verifyGuestIdentity callable'ının yazdığı doğrulanmış oturum —
    // guest-1 gerçekten 101 numaralı odada doğrulanmış.
    await s(d(db, 'verifiedGuestSessions', 'guest-1'), { tenantId: T, guestId: 'guest-101', room: '101' });
    // guest-2: 204'te (artık checked_out olan) bir misafire bağlı ESKİ bir
    // doğrulanmış oturum — checkout sonrası guestDirectory.status kontrolü
    // sayesinde bu oturum artık GEÇERSİZ olmalı (canlı kontrol).
    await s(d(db, 'verifiedGuestSessions', 'guest-2'), { tenantId: T, guestId: 'guest-204', room: '204' });
    // guest-3: farklı bir tenant için doğrulanmış — cross-tenant reddedilmeli.
    await s(d(db, 'verifiedGuestSessions', 'guest-3'), { tenantId: 'hotel-b', guestId: 'guest-101', room: '101' });

    // roomAccess: 204 sistemin KANITLA kapalı bildiği bir oda (ek katman).
    await s(d(db, 'roomAccess', T + '__204'), { tenantId: T, open: false });
    await s(d(db, 'roomAccess', T + '__101'), { tenantId: T, open: true });
  });
});
after(async () => { if (env) await env.cleanup(); });

test('doğrulanmış oturumun GERÇEK odasıyla eşleşen sipariş OLUŞTURULABİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertSucceeds(addDoc(collection(db, 'guestOrders'), baseOrder({ room: '101' })));
});

test('doğrulanmış oturum VARKEN başka bir odaya sipariş REDDEDİLİR (room manipülasyonu)', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ room: '999-baska-oda' })));
});

test('HİÇ doğrulanmamış oturum sipariş OLUŞTURAMAZ', async () => {
  const db = anonCtx(env, 'guest-hic-dogrulanmamis').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ sessionUid: 'guest-hic-dogrulanmamis', room: '101' })));
});

test('checkout sonrası (guestDirectory.status artık in_house değil) eski doğrulanmış oturum GEÇERSİZDİR', async () => {
  const db = anonCtx(env, 'guest-2').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ sessionUid: 'guest-2', room: '204' })));
});

test('farklı tenant için doğrulanmış oturum bu tenant’a sipariş açamaz', async () => {
  const db = anonCtx(env, 'guest-3').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ sessionUid: 'guest-3', room: '101' })));
});

test('KANITLANMIŞ kapalı (check-out yapılmış roomAccess) odaya, doğrulanmış oturum olsa bile sipariş REDDEDİLİR', async () => {
  // guest-2'nin doğrulanmış odası zaten 204 ve guestDirectory kontrolünde
  // düşüyor; roomIsExplicitlyClosed katmanını izole test etmek için ayrı
  // bir doğrulanmış oturum + hâlâ in_house bir misafir simüle edelim.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const { doc: d, setDoc: s } = require('firebase/firestore');
    await s(d(db, 'guestDirectory', 'guest-204b'), { tenantId: T, room: '204', status: 'in_house', name: 'Yeni Misafir', birthYear: 1992 });
    await s(d(db, 'verifiedGuestSessions', 'guest-4'), { tenantId: T, guestId: 'guest-204b', room: '204' });
  });
  const db = anonCtx(env, 'guest-4').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ sessionUid: 'guest-4', room: '204' })));
});

test('verifiedGuestSessions istemciye (misafir dahil) hiç okunamaz', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertFails(getDoc(doc(db, 'verifiedGuestSessions', 'guest-1')));
});

test('verifiedGuestSessions istemciye (misafir dahil) hiç yazılamaz', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertFails(setDoc(doc(db, 'verifiedGuestSessions', 'guest-1'), { tenantId: T, guestId: 'guest-101', room: '101' }));
});

test('kalem adedi (qty) 10\'dan fazlaysa REDDEDİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({
    room: '101', items: [{ id: 'i1', name: 'Su', qty: 11 }]
  })));
});

test('kalem adı (name) eksikse REDDEDİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({
    room: '101', items: [{ id: 'i1', qty: 1 }]
  })));
});

test('kalem şekli geçerliyse (qty sınırında, uzun ama sınır içi not, modifiers) OLUŞTURULABİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertSucceeds(addDoc(collection(db, 'guestOrders'), baseOrder({
    room: '101', items: [{
      id: 'i1', name: 'Su', qty: 10, note: 'x'.repeat(300), option: 'Soğuk',
      modifiers: [{ name: 'Buzsuz', type: 'remove', priceDelta: 0 }, { name: 'Limonlu', type: 'extra', priceDelta: 10 }]
    }]
  })));
});

test('modifiers 10\'dan fazlaysa REDDEDİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  const modifiers = Array.from({ length: 11 }, (_, i) => ({ name: 'Mod' + i, type: 'extra' }));
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({
    room: '101', items: [{ id: 'i1', name: 'Su', qty: 1, modifiers }]
  })));
});

test('20 kalemin TAMAMI doğrulanır — 20. kalem geçersizse (qty>10) REDDEDİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  const items = Array.from({ length: 19 }, (_, i) => ({ id: 'i' + i, name: 'Su', qty: 1 }));
  items.push({ id: 'i19', name: 'Kötü', qty: 999 });
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ room: '101', items })));
});
