/* Panel-arası paylaşılan koleksiyonlar (roomAccess, notifications) —
 * cross-tenant güvenlik denetiminde bulunan iki açığı doğrudan kilitler:
 *   - roomAccess: doküman ID'si (tenantId + '__' + room) çağıranın GERÇEKTEN
 *     kendi tenant'ına ait olmalı — aksi halde bir otelin personeli başka
 *     bir otelin GERÇEK bir odasını kalıcı olarak "kapalı" işaretleyip o
 *     odanın misafirlerinin QR sipariş vermesini engelleyebilirdi
 *     (cross-tenant DoS, roomIsExplicitlyClosed() üzerinden).
 *   - notifications: toUid'nin GÖNDERENLE AYNI tenant'a ait olduğu
 *     doğrulanmıyordu — bir otelin personeli başka bir otelin personeline
 *     sınırsız içerikli bildirim enjekte edip okutabilirdi.
 * Emülatörde firestore.rules'un GERÇEK halini yükler. */
'use strict';
const { test, before, after } = require('node:test');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, deleteDoc, collection, addDoc } = require('firebase/firestore');
const { rulesEnv, staffCtx } = require('./helpers');

const PID = 'collab-rules-test';
let env;

before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const { doc: d, setDoc: s, writeBatch } = require('firebase/firestore');
    const b = writeBatch(db);
    for (const t of ['hotel-a', 'hotel-b']) {
      b.set(d(db, 'systemUsers', `${t}-admin`), { tenantId: t, username: `${t}.admin`, role: 'admin' });
      b.set(d(db, 'systemUsers', `${t}-staff`), { tenantId: t, username: `${t}.garson`, role: 'staff', department: 'Restoran' });
    }
    // Hotel-B'nin GERÇEK, meşru bir açık odası — Hotel-A personeli bunu
    // hedeflemeye çalışacak.
    b.set(d(db, 'roomAccess', 'hotel-b__101'), { tenantId: 'hotel-b', room: '101', open: true });
    await b.commit();
  });
});
after(async () => { if (env) await env.cleanup(); });

// ── roomAccess: cross-tenant DoS kapatıldı mı ───────────────────────────
test('roomAccess: personel KENDİ tenant\'ının odasını yazabilir', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertSucceeds(setDoc(doc(db, 'roomAccess', 'hotel-a__101'), { tenantId: 'hotel-a', room: '101', open: true }));
});

test('roomAccess: BAŞKA tenant\'ın ID\'sini taşıyan yeni doküman (kendi tenantId\'siyle) OLUŞTURULAMAZ', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  // id.split(\'__\')[0] != callerTenant() olduğundan create reddedilmeli —
  // eskiden yalnızca tenantId ALANI kontrol edildiğinden bu İZİN VERİLİYORDU.
  await assertFails(setDoc(doc(db, 'roomAccess', 'hotel-b__999-yeni-oda'), { tenantId: 'hotel-a', room: '999-yeni-oda', open: false }));
});

test('roomAccess: BAŞKA tenant\'ın VAR OLAN gerçek odası (kendi tenantId\'siyle) ÜZERİNE YAZILAMAZ (sahiplik devralma)', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  // Hotel-A personeli hotel-b__101 dokümanını "kapalı" yaparak Hotel-B'nin
  // GERÇEK odasını sabote etmeye çalışıyor — hem id-öneki hem MEVCUT
  // sahiplik (resource.data.tenantId) kontrolü bunu reddetmeli.
  await assertFails(setDoc(doc(db, 'roomAccess', 'hotel-b__101'), { tenantId: 'hotel-a', room: '101', open: false }, { merge: true }));
});

test('roomAccess: BAŞKA tenant\'ın odasını (kendi tenantId\'siyle bile) SİLEMEZ', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(deleteDoc(doc(db, 'roomAccess', 'hotel-b__101')));
});

test('roomAccess: sahibi olan tenant kendi odasını GÜNCELLEYEBİLİR', async () => {
  const db = staffCtx(env, 'hotel-b-staff').firestore();
  await assertSucceeds(setDoc(doc(db, 'roomAccess', 'hotel-b__101'), { tenantId: 'hotel-b', room: '101', open: false }, { merge: true }));
});

// ── notifications: cross-tenant enjeksiyon kapatıldı mı ─────────────────
test('notifications: personel KENDİ tenant\'ındaki bir meslektaşına bildirim gönderebilir', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertSucceeds(addDoc(collection(db, 'notifications'), {
    tenantId: 'hotel-a', toUid: 'hotel-a-admin', toUsername: 'hotel-a.admin',
    fromUid: 'hotel-a-staff', fromUsername: 'hotel-a.garson',
    title: 'Yeni talep', body: 'Oda 101', recordId: 'rec1', type: 'request', read: false
  }));
});

test('notifications: BAŞKA tenant\'ın personeline bildirim ENJEKTE EDİLEMEZ (cross-tenant spam)', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  // toUid hotel-b'nin admin'i — eskiden yalnızca tenantId ALANI ve
  // fromUid==auth.uid kontrol edildiğinden bu İZİN VERİLİYORDU.
  await assertFails(addDoc(collection(db, 'notifications'), {
    tenantId: 'hotel-a', toUid: 'hotel-b-admin', toUsername: 'hotel-b.admin',
    fromUid: 'hotel-a-staff', fromUsername: 'hotel-a.garson',
    title: 'phishing', body: 'tıkla', recordId: '', type: 'request', read: false
  }));
});

test('notifications: sınırların dışında title/body REDDEDİLİR', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  await assertFails(addDoc(collection(db, 'notifications'), {
    tenantId: 'hotel-a', toUid: 'hotel-a-admin', toUsername: 'hotel-a.admin',
    fromUid: 'hotel-a-staff', fromUsername: 'hotel-a.garson',
    title: 'x'.repeat(201), body: '', recordId: '', type: 'request', read: false
  }));
});

test('notifications: alıcı yalnızca "read" alanını değiştirebilir', async () => {
  const db = staffCtx(env, 'hotel-a-admin').firestore();
  const ref = await addDoc(collection(staffCtx(env, 'hotel-a-staff').firestore(), 'notifications'), {
    tenantId: 'hotel-a', toUid: 'hotel-a-admin', toUsername: 'hotel-a.admin',
    fromUid: 'hotel-a-staff', fromUsername: 'hotel-a.garson',
    title: 'Yeni talep', body: '', recordId: '', type: 'request', read: false
  });
  await assertSucceeds(setDoc(doc(db, 'notifications', ref.id), { read: true }, { merge: true }));
});

test('notifications: gönderen AYNI dakika-penceresinde kendi bildirimini idempotent olarak yeniden yazabilir (deterministik ID)', async () => {
  const db = staffCtx(env, 'hotel-a-staff').firestore();
  const id = 'request_rec42_hotel-a-admin_999999';
  const payload = {
    tenantId: 'hotel-a', toUid: 'hotel-a-admin', toUsername: 'hotel-a.admin',
    fromUid: 'hotel-a-staff', fromUsername: 'hotel-a.garson',
    title: 'Yeni talep', body: 'Oda 101', recordId: 'rec42', type: 'request', read: false
  };
  await assertSucceeds(setDoc(doc(db, 'notifications', id), payload, { merge: true }));
  // İKİNCİ yazım artık bir "update" — RT.sendNotification'ın aynı pencere
  // içindeki yeniden denemesini simüle eder, izin verilmeli.
  await assertSucceeds(setDoc(doc(db, 'notifications', id), payload, { merge: true }));
});

test('verifiedGuestSessions hâlâ tamamen kapalı (bu PR\'ın kapsamı değişmedi)', async () => {
  const db = staffCtx(env, 'hotel-a-admin').firestore();
  await assertFails(getDoc(doc(db, 'verifiedGuestSessions', 'anyone')));
});
