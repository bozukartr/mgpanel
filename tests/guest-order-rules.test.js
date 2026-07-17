/* Misafir QR siparişi (guestOrders) — sunucu tarafı güvenlik kuralları:
 *   - kalem şekli/aralığı (qty 1-10, string uzunlukları) doğrulanır
 *   - doğrulama (requireVerification) KAPALI olsa bile, sistemin KANITLA
 *     bildiği (check-out yapılmış) bir odaya sipariş açılamaz
 *   - roomAccess hiç mirror edilmemiş (bilinmeyen) bir oda eskisi gibi
 *     çalışmaya devam eder (geriye dönük uyum — regresyon yok)
 * Emülatörde firestore.rules'un GERÇEK halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, collection, addDoc } = require('firebase/firestore');
const { rulesEnv, anonCtx } = require('./helpers');

const PID = 'guest-order-rules-test';
const T = 'hotel-a';
let env;

function baseOrder(overrides) {
  return Object.assign({
    sessionUid: 'guest-1',
    status: 'pending',
    tenantId: T,
    room: '204',
    items: [{ id: 'i1', name: 'Su', qty: 1, category: 'Oda Servisi' }]
  }, overrides);
}

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const { doc: d, setDoc: s } = require('firebase/firestore');
    // 204: doğrulama KAPALI (varsayılan) ama sistem bu odanın check-out
    // yapıldığını (open:false) BİLİYOR — kanıtlanmış kapalı oda.
    await s(d(db, 'roomAccess', T + '__204'), { tenantId: T, open: false });
    // 101: sistem bu odanın açık (in-house) olduğunu biliyor.
    await s(d(db, 'roomAccess', T + '__101'), { tenantId: T, open: true });
    // guestConfig hiç yok → verificationRequired() varsayılan false.
  });
});
after(async () => { if (env) await env.cleanup(); });

test('geçerli sipariş (bilinmeyen oda, doğrulama kapalı) OLUŞTURULABİLİR — regresyon yok', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertSucceeds(addDoc(collection(db, 'guestOrders'), baseOrder({ room: '999-bilinmeyen' })));
});

test('KANITLANMIŞ kapalı (check-out yapılmış) odaya sipariş REDDEDİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ room: '204' })));
});

test('açık (in-house) odaya sipariş OLUŞTURULABİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertSucceeds(addDoc(collection(db, 'guestOrders'), baseOrder({ room: '101' })));
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

test('kalem şekli geçerliyse (qty sınırında, uzun ama sınır içi not) OLUŞTURULABİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  await assertSucceeds(addDoc(collection(db, 'guestOrders'), baseOrder({
    room: '101', items: [{ id: 'i1', name: 'Su', qty: 10, note: 'x'.repeat(300), option: 'Soğuk' }]
  })));
});

test('20 kalemin TAMAMI doğrulanır — 20. kalem geçersizse (qty>10) REDDEDİLİR', async () => {
  const db = anonCtx(env, 'guest-1').firestore();
  const items = Array.from({ length: 19 }, (_, i) => ({ id: 'i' + i, name: 'Su', qty: 1 }));
  items.push({ id: 'i19', name: 'Kötü', qty: 999 });
  await assertFails(addDoc(collection(db, 'guestOrders'), baseOrder({ room: '101', items })));
});
