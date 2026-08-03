/* Misafir QR oturumu — yerel "doğrulandı" bayrağının anonim UID'ye bağlanması.
 *
 * BİLDİRİLEN HATA: web'de oluşturulabilen QR talebi mobilde
 * "Gönderilemedi. Tekrar deneyin." ile başarısız oluyordu.
 *
 * KÖK NEDEN: doğrulamanın SUNUCUDAKİ kanıtı `verifiedGuestSessions/{uid}`
 * dokümanıdır (functions/index.js:verifyGuestIdentity) — anonim oturumun
 * UID'sine bağlıdır. İstemcideki bayrak ise SADECE bir son-kullanma zamanıydı,
 * UID ile hiç ilişkilendirilmemişti. Anonim UID döndüğünde (iOS Safari/ITP
 * depolama tahliyesi, QR'ın uygulama-içi tarayıcıda açılması, oturumun
 * düşmesi) istemci hâlâ "doğrulandım" sanıyor; firestore.rules ise hem
 * `sessionUid == request.auth.uid` hem `verifiedSessionRoom()` koşullarını
 * düşürüp yazımı reddediyor. Misafir, tekrar denemenin asla çalışmadığı bir
 * döngüde kilitleniyordu.
 *
 * Kural KAYNAKTAN okunup değerlendirilir (kopyası değil). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'guest-order.js'), 'utf8');
const start = src.indexOf('    function currentUid() {');
const endMarker = 'function clearVerified()';
const end = src.indexOf('\n', src.indexOf(endMarker)) + 1;
assert.ok(start > -1 && end > start, 'guest-order.js doğrulama bloğu bulunamadı');
const block = src.slice(start, end);

const KEY = 'go2_verify_otel_101';
function mk({ uid, room = '101', store = {} }) {
    const localStorage = {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    };
    const api = new Function('DEMO', 'auth', 'sessionUid', 'ROOM', 'VERIFY_KEY', 'localStorage', `
        ${block}
        return { isVerified: isVerified, setVerified: setVerified, clearVerified: clearVerified, currentUid: currentUid };
    `)(false, { currentUser: uid ? { uid } : null }, '', room, KEY, localStorage);
    return { api, store };
}

test('doğrulama, oturumu açan UID ile birlikte saklanır', () => {
    const { api, store } = mk({ uid: 'uid-A' });
    api.setVerified();
    assert.equal(JSON.parse(store[KEY]).u, 'uid-A');
    assert.ok(api.isVerified());
});

test('anonim UID DEĞİŞTİĞİNDE doğrulama geçersiz sayılır', () => {
    // Asıl hata buydu: eski davranışta bu durumda hâlâ "doğrulandı" dönüyor,
    // sipariş geçersiz sessionUid ile yazılıp reddediliyordu.
    const store = {};
    mk({ uid: 'uid-A', store }).api.setVerified();
    const after = mk({ uid: 'uid-B', store });   // aynı cihaz, yeni anonim oturum
    assert.ok(!after.api.isVerified(), 'UID değiştiğinde kapı yeniden açılmalı');
});

test('süresi dolmuş doğrulama geçersizdir', () => {
    const store = { [KEY]: JSON.stringify({ u: 'uid-A', e: Date.now() - 1000 }) };
    assert.ok(!mk({ uid: 'uid-A', store }).api.isVerified());
});

test('oda atanmamışsa doğrulama sayılmaz', () => {
    const store = {};
    mk({ uid: 'uid-A', store }).api.setVerified();
    assert.ok(!mk({ uid: 'uid-A', room: '', store }).api.isVerified());
});

test('ESKİ biçim (düz zaman damgası) geriye dönük çalışır', () => {
    // Dağıtım anında hâlâ doğrulanmış olan misafirler gereksiz yere tekrar
    // sorgulanmaz; UID gerçekten döndüyse yazım reddedilir ve istemcideki
    // permission-denied kurtarma yolu kapıyı açar.
    const store = { [KEY]: String(Date.now() + 3600000) };
    assert.ok(mk({ uid: 'uid-A', store }).api.isVerified());
    const expired = { [KEY]: String(Date.now() - 1) };
    assert.ok(!mk({ uid: 'uid-A', store: expired }).api.isVerified());
});

test('clearVerified bayrağı tamamen siler', () => {
    const store = {};
    const { api } = mk({ uid: 'uid-A', store });
    api.setVerified();
    api.clearVerified();
    assert.equal(store[KEY], undefined);
    assert.ok(!api.isVerified());
});

test('UID henüz bilinmiyorken doğrulama engellenmez', () => {
    // Anonim giriş tamamlanmadan isVerified() çağrılabilir; burada kapıyı
    // açmak gereksiz sürtünme yaratırdı — submitOrder zaten sessionUid
    // olmadan hiç çalışmaz.
    const store = { [KEY]: JSON.stringify({ u: 'uid-A', e: Date.now() + 3600000 }) };
    assert.ok(mk({ uid: null, store }).api.isVerified());
});
