/* Yetki yükseltme koruması — otel yöneticisi platform operatörü hesabını
 * ele geçiremez.
 *
 * Açık (düzeltildi): kurallar yöneticinin HERHANGİ bir uid için kendi
 * oteline ait systemUsers belgesi yaratmasına izin veriyordu; şifre
 * sıfırlama / kullanıcı silme fonksiyonları (requireTenantAdminFor) yalnızca
 * bu belgeye bakıyordu. Operatör uid'i migrationReview.resolvedBy'da
 * görünebildiğinden: belge yarat → resetUserPassword → dönen geçici şifreyle
 * operatör olarak giriş.
 *  · Kurallar: yönetici, superAdmins'te olan uid için belge yaratamaz.
 *  · Fonksiyon: hedef operatörse ya da gerçek bir personel (şifreli,
 *    e-postalı) hesabı değilse reddeder. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const { rulesEnv, staffCtx } = require('./helpers');

const PID = 'priv-esc-test';
let env;
before(async () => {
  env = await rulesEnv(PID);
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'superAdmins', 'op-1'), { note: 'platform operatörü' });
    await setDoc(doc(db, 'systemUsers', 'a-admin'), { tenantId: 'hotel-a', username: 'a.admin', role: 'admin' });
  });
});
after(async () => { if (env) await env.cleanup(); });

test('yönetici operatör uid\'i için systemUsers belgesi YARATAMAZ', async () => {
  const db = staffCtx(env, 'a-admin').firestore();
  await assertFails(setDoc(doc(db, 'systemUsers', 'op-1'), { tenantId: 'hotel-a', username: 'x', role: 'staff' }));
  // Normal yeni personel yaratmak bozulmadı.
  await assertSucceeds(setDoc(doc(db, 'systemUsers', 'new-staff-1'), { tenantId: 'hotel-a', username: 'yeni', role: 'staff' }));
  // Başka otel adına yaratamaz (mevcut korunma).
  await assertFails(setDoc(doc(db, 'systemUsers', 'new-staff-2'), { tenantId: 'hotel-b', username: 'y', role: 'staff' }));
});

test('requireTenantAdminFor: operatör ve personel olmayan hedefleri reddeder', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions/index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function requireTenantAdminFor'), src.indexOf('exports.resetUserPassword'));
  assert.match(fn, /db\.collection\('superAdmins'\)\.doc\(targetUid\)\.get\(\)/);
  assert.match(fn, /if \(targetSuper\.exists\)/);
  assert.match(fn, /providers\.indexOf\('password'\) === -1/);
  // Kontroller, çağıran operatör değilse (otel yöneticisi yolu) uygulanır.
  assert.ok(fn.indexOf('if (superSnap.exists) return') < fn.indexOf('targetSuper'));
  // resetUserPassword / revokeUserSessions / deleteUser hepsi bu kapıdan geçer.
  for (const name of ['resetUserPassword', 'revokeUserSessions']) {
    const body = src.slice(src.indexOf('exports.' + name), src.indexOf('exports.' + name) + 300);
    assert.match(body, /await requireTenantAdminFor\(request, targetUid\)/, name);
  }
  assert.match(src.slice(src.indexOf('exports.deleteUser'), src.indexOf('exports.deleteUser') + 700), /await requireTenantAdminFor\(request, uid\)/);
});
