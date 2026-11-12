/* Profil menüsü — js/core/shell-profile.js
 *  · Başlıkta çıkış / tema düğmesi yok; çıkış menüde (yanlışlıkla basılmaz)
 *    ve push kaydını ayıran hotelSignOut'u kullanır.
 *  · Şifre değişimi mevcut şifreyle yeniden doğrulama ister; F&B kod
 *    hesaplarında gizli (şifre koddan türetilir, değişirse kodla giriş bozulur).
 *  · Face ID yalnızca yönetici izin verdiyse; cihazlar listelenir / kaldırılır;
 *    "Bu cihazda aç" seçenekleri önceden alır (Safari).
 *  · Görünüm: Açık / Koyu / Sistem (theme.js).
 * Tarayıcıda uçtan uca doğrulandı (Playwright). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const src = read('js/core/shell-profile.js');
const html = read('app.html');

test('başlık sadeleşti; çıkış menüde ve hotelSignOut ile', () => {
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.doesNotMatch(header, /id="shLogout"|id="shThemeBtn"/);
  assert.match(header, /<button class="sh-chip" id="shProfileBtn"[^>]*aria-haspopup="menu"/);
  const menu = html.slice(html.indexOf('id="shProfileMenu"'));
  assert.match(menu, /id="shLogout"/);
  assert.match(read('js/core/app-shell.js'), /\$\('shLogout'\)\.onclick = function \(\) \{ this\.disabled = true; hotelSignOut\('login'\); \};/);
  for (const id of ['pmPassword', 'pmFaceId', 'pmPush', 'pmKeys']) assert.match(menu, new RegExp('id="' + id + '"'));
  for (const t of ['light', 'dark', 'auto']) assert.match(menu, new RegExp('data-theme="' + t + '"'));
  assert.ok(html.indexOf('firebase-functions.js') > -1 && html.indexOf('src="js/core/passkey.js') < html.indexOf('src="js/core/shell-profile.js'));
});

test('şifre: yeniden doğrulama, doğrulamalar, F&B hesabında gizli', () => {
  assert.match(src, /reauthenticateWithCredential\(firebase\.auth\.EmailAuthProvider\.credential\(u\.email, cur\)\)/);
  assert.match(src, /await u\.updatePassword\(n1\);/);
  assert.match(src, /n1\.length < 6/);
  assert.match(src, /n1 !== n2/);
  assert.match(src, /var fnbAccount = CTX === 'fnb' \|\| \(typeof isFnbDept === 'function' && isFnbDept\(DEPT\)\);/);
  assert.match(src, /if \(fnbAccount\) \$\('pmPassword'\)\.hidden = true;/);
});

test('Face ID: izinle görünür, liste / kaldır / bu cihazda aç (önceden alınan seçenekler)', () => {
  assert.match(src, /faceIdAllowed = !!\(snap\.exists && snap\.data\(\)\.faceIdAllowed === true\);/);
  assert.match(src, /item\.hidden = !faceIdAllowed \|\| CTX !== 'hotel';/);
  assert.match(src, /fn\('passkeyManage'\)\(\{ action: 'list' \}\)/);
  assert.match(src, /fn\('passkeyManage'\)\(\{ action: 'revoke', id: b\.dataset\.rm \}\)/);
  assert.match(src, /fn\('passkeyRegisterOptions'\)\(\{\}\)/);
  assert.match(src, /await Passkey\.create\(o\)/);
});

test('görünüm ve bildirim durumu', () => {
  assert.match(src, /Theme\.set\(b\.dataset\.theme\)/);
  assert.match(src, /await Push\.repair\(\)/);
  assert.match(src, /s\.permission === 'denied'/);
});
