/* Ortak cihaz ekran kilidi — js/core/shell-lock.js + screenLocks kuralları
 *  · PIN tuzlu SHA-256 özeti; düz metin hiçbir yerde saklanmaz.
 *  · screenLocks/{uid}: yalnızca o hesap (kilidi açmak için) ve kendi otelinin
 *    yöneticisi okur; diğer personel okuyamaz (kısa PIN'in özeti çevrimdışı
 *    denenemesin). Yalnızca yönetici, yalnızca kendi otelindeki kullanıcı için yazar.
 *  · Boşta kalma kabukta ve modül çerçevelerinde sayılır; kilit yenilemeyle
 *    aşılamaz; 5 yanlış denemeden sonra yalnızca şifreyle giriş.
 * Tarayıcıda uçtan uca doğrulandı (Playwright, sahte saat). */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, deleteDoc } = require('firebase/firestore');
const { rulesEnv, staffCtx, anonCtx } = require('./helpers');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const PID = 'screen-lock-test';
let env;
before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'systemUsers', 'a-admin'), { tenantId: 'hotel-a', username: 'a.admin', role: 'admin' });
    await setDoc(doc(db, 'systemUsers', 'a-desk'), { tenantId: 'hotel-a', username: 'resepsiyon', role: 'staff' });
    await setDoc(doc(db, 'systemUsers', 'a-staff'), { tenantId: 'hotel-a', username: 'ayse', role: 'staff' });
    await setDoc(doc(db, 'systemUsers', 'b-admin'), { tenantId: 'hotel-b', username: 'b.admin', role: 'admin' });
    await setDoc(doc(db, 'systemUsers', 'b-desk'), { tenantId: 'hotel-b', username: 'b.desk', role: 'staff' });
    await setDoc(doc(db, 'screenLocks', 'a-desk'), { tenantId: 'hotel-a', idleMin: 5, salt: 's', pinHash: 'h', pinLength: 4 });
  });
});
after(async () => { if (env) await env.cleanup(); });

const lock = { tenantId: 'hotel-a', idleMin: 5, salt: 'x', pinHash: 'y', pinLength: 4 };

test('okuma: hesabın kendisi ve kendi otelinin yöneticisi; diğer personel ve başka otel okuyamaz', async () => {
  await assertSucceeds(getDoc(doc(staffCtx(env, 'a-desk').firestore(), 'screenLocks', 'a-desk')));
  await assertSucceeds(getDoc(doc(staffCtx(env, 'a-admin').firestore(), 'screenLocks', 'a-desk')));
  await assertFails(getDoc(doc(staffCtx(env, 'a-staff').firestore(), 'screenLocks', 'a-desk')));
  await assertFails(getDoc(doc(staffCtx(env, 'b-admin').firestore(), 'screenLocks', 'a-desk')));
  await assertFails(getDoc(doc(anonCtx(env, 'g1').firestore(), 'screenLocks', 'a-desk')));
});

test('yazma: yalnızca yönetici, yalnızca kendi otelindeki kullanıcı için; hesap kendi kilidini değiştiremez', async () => {
  await assertSucceeds(setDoc(doc(staffCtx(env, 'a-admin').firestore(), 'screenLocks', 'a-staff'), lock));
  await assertFails(setDoc(doc(staffCtx(env, 'a-desk').firestore(), 'screenLocks', 'a-desk'), Object.assign({}, lock, { idleMin: 0 })));
  await assertFails(setDoc(doc(staffCtx(env, 'a-staff').firestore(), 'screenLocks', 'a-desk'), lock));
  // Başka otelin kullanıcısına kilit yazılamaz (tenantId kendi oteli olsa bile).
  await assertFails(setDoc(doc(staffCtx(env, 'a-admin').firestore(), 'screenLocks', 'b-desk'), lock));
  await assertFails(setDoc(doc(staffCtx(env, 'b-admin').firestore(), 'screenLocks', 'a-desk'), Object.assign({}, lock, { tenantId: 'hotel-b' })));
  await assertFails(deleteDoc(doc(staffCtx(env, 'a-desk').firestore(), 'screenLocks', 'a-desk')));
  await assertSucceeds(deleteDoc(doc(staffCtx(env, 'a-admin').firestore(), 'screenLocks', 'a-staff')));
});

test('istemci: tuzlu özet, yenilemeyle aşılamaz, deneme sınırı, çerçevelerde etkinlik', () => {
  const lk = read('js/core/shell-lock.js');
  assert.match(lk, /crypto\.subtle\.digest\('SHA-256', new TextEncoder\(\)\.encode\(salt \+ ':' \+ p\)\)/);
  assert.match(lk, /var MAX_FAILS = 5;/);
  assert.match(lk, /if \(lsGet\(LK\(\)\) === '1'\) lock\(\);/);
  assert.match(lk, /if \(Date\.now\(\) - lastAct >= cfg\.idleMin \* 60000\) lock\(\);/);
  const shell = read('js/core/app-shell.js');
  assert.match(shell, /f\.contentWindow\.addEventListener\(t, activity, \{ passive: true, capture: true \}\)/);
  assert.match(shell, /if \(document\.documentElement\.classList\.contains\('hz-locked'\)\) return;/);
  assert.match(read('css/core/app-shell.css'), /html\.hz-locked \.sh-app \{ visibility: hidden; \}/);
  const admin = read('js/modules/admin.js');
  assert.match(admin, /data\.pinHash = await pinHashOf\(data\.salt, pin\);/);
  assert.match(admin, /crypto\.getRandomValues\(a\)/);
  assert.doesNotMatch(admin, /pin: pin|pinPlain|pin:\s*lockPin/);
  const fn = read('functions/index.js');
  assert.match(fn, /'screenLocks'\s+\/\/ ortak cihaz ekran kilidi/);
  assert.match(fn, /db\.collection\('screenLocks'\)\.doc\(uid\)\.delete\(\)/);
});
