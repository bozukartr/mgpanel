/* Face ID / Touch ID ile giriş (passkey · WebAuthn) — çekirdek.
 *
 * Yazılım doğrulayıcı: gerçek bir P-256 anahtar çifti, gerçek CBOR
 * attestation ('none') ve gerçek ECDSA imzasıyla kayıt + giriş törenini
 * uçtan uca koşar (functions/passkey-core.js → @simplewebauthn/server).
 * Emülatör gerekmez.
 *
 *  · Köken allowlist'i: yalnızca hotizy.com (+alt alan adları, https),
 *    projenin Firebase Hosting adresleri ve localhost.
 *  · Kayıt → giriş başarılı; sayaç ilerler.
 *  · Reddedilenler: başka köken/RP ID, yanlış doğrulama dizesi, kullanıcı
 *    doğrulaması (Face ID) yapılmamış yanıt, başka kullanıcıya ait
 *    userHandle, başka otelin (RP ID) kaydı, geriye giden sayaç (kopyalanmış
 *    doğrulayıcı), bozulmuş imza.
 *  · Kullanıcı başına cihaz sınırı; excludeCredentials yalnızca aynı RP ID. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { isoCBOR, isoBase64URL } = require('@simplewebauthn/server/helpers');
const core = require('../functions/passkey-core');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ── Yazılım doğrulayıcı ───────────────────────────────────────────
function makeAuthenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  return { privateKey, jwk, credId, counter: 0 };
}
function coseKey(jwk) {
  return isoCBOR.encode(new Map([
    [1, 2],                                   // kty: EC2
    [3, -7],                                  // alg: ES256
    [-1, 1],                                  // crv: P-256
    [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
    [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]
  ]));
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
const UP = 0x01, UV = 0x04, AT = 0x40;

function attest(a, opts, origin, { flags = UP | UV | AT } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin, crossOrigin: false }));
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(a.credId.length);
  const authData = Buffer.concat([
    sha256(opts.rp.id), Buffer.from([flags]), u32(a.counter),
    Buffer.alloc(16), idLen, a.credId, Buffer.from(coseKey(a.jwk))
  ]);
  const attestationObject = isoCBOR.encode(new Map([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]
  ]));
  return {
    id: b64u(a.credId), rawId: b64u(a.credId), type: 'public-key',
    authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] }
  };
}

function assertion(a, opts, origin, rpID, uid, { flags = UP | UV, counter, tamper = false } = {}) {
  a.counter = counter !== undefined ? counter : a.counter + 1;
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin, crossOrigin: false }));
  const authData = Buffer.concat([sha256(rpID), Buffer.from([flags]), u32(a.counter)]);
  let signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), a.privateKey);
  if (tamper) { signature = Buffer.from(signature); signature[signature.length - 1] ^= 0xff; }
  return {
    id: b64u(a.credId), rawId: b64u(a.credId), type: 'public-key',
    authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: {
      clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData),
      signature: b64u(signature), userHandle: b64u(Buffer.from(uid, 'utf8'))
    }
  };
}

const RP = core.rpFromOrigin('https://grandotel.hotizy.com', 'panel-d25c9');
const USER = { uid: 'uid-ayse-123', username: 'ayse' };

// Kayıt yap, sunucunun saklayacağı kaydı (Firestore'daki gibi) döndür.
async function register(a, rp = RP, user = USER) {
  const opts = await core.registrationOptions(rp, user, []);
  const info = await core.verifyRegistration(rp, attest(a, opts, rp.origin), opts.challenge);
  return Object.assign({}, info, { uid: user.uid, rpID: rp.rpID });
}

// ── Köken allowlist'i ─────────────────────────────────────────────
test('rpFromOrigin: yalnızca izinli kökenler, RP ID = tam alan adı', () => {
  assert.deepEqual(core.rpFromOrigin('https://grandotel.hotizy.com', 'p'), { origin: 'https://grandotel.hotizy.com', rpID: 'grandotel.hotizy.com' });
  assert.deepEqual(core.rpFromOrigin('https://hotizy.com', 'p'), { origin: 'https://hotizy.com', rpID: 'hotizy.com' });
  assert.deepEqual(core.rpFromOrigin('https://panel-d25c9.web.app', 'panel-d25c9'), { origin: 'https://panel-d25c9.web.app', rpID: 'panel-d25c9.web.app' });
  assert.ok(core.rpFromOrigin('https://panel-d25c9.firebaseapp.com', 'panel-d25c9'));
  assert.deepEqual(core.rpFromOrigin('http://localhost:8920', 'p'), { origin: 'http://localhost:8920', rpID: 'localhost' });
  for (const bad of ['http://grandotel.hotizy.com', 'https://hotizy.com.evil.com', 'https://evilhotizy.com',
    'https://other-project.web.app', 'https://evil.com', '', 'null', 'javascript:alert(1)']) {
    assert.equal(core.rpFromOrigin(bad, 'panel-d25c9'), null, bad);
  }
});

test('credDocId sabit uzunlukta, deterministik; deviceLabel okunur', () => {
  const id = core.credDocId('abc');
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, core.credDocId('abc'));
  assert.notEqual(id, core.credDocId('abd'));
  assert.equal(core.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(core.deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(core.deviceLabel(''), 'Cihaz');
});

// ── Tören ─────────────────────────────────────────────────────────
test('kayıt seçenekleri: cihazda kayıtlı (platform), keşfedilebilir, Face ID zorunlu', async () => {
  const opts = await core.registrationOptions(RP, USER, []);
  assert.equal(opts.rp.id, 'grandotel.hotizy.com');
  assert.equal(opts.rp.name, 'Hotizy');
  assert.equal(isoBase64URL.toUTF8String(opts.user.id), USER.uid);
  assert.equal(opts.authenticatorSelection.residentKey, 'required');
  assert.equal(opts.authenticatorSelection.userVerification, 'required');
  assert.equal(opts.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(opts.attestation, 'none');
  assert.ok(opts.challenge.length >= 32);
});

test('kayıt + giriş uçtan uca: doğrulanır, sayaç ilerler', async () => {
  const a = makeAuthenticator();
  const stored = await register(a);
  assert.equal(stored.credId, b64u(a.credId));
  assert.ok(stored.publicKey.length > 40);
  assert.deepEqual(stored.transports, ['internal']);

  const opts = await core.authenticationOptions(RP);
  assert.equal(opts.rpId, RP.rpID);
  assert.equal(opts.userVerification, 'required');
  assert.deepEqual(opts.allowCredentials, []); // kullanıcı adı yazmadan giriş
  const res = await core.verifyAuthentication(RP, assertion(a, opts, RP.origin, RP.rpID, USER.uid), opts.challenge, stored);
  assert.equal(res.newCounter, 1);
});

test('kayıt: yanlış köken, yanlış doğrulama dizesi ve Face ID yapılmamış yanıt reddedilir', async () => {
  const a = makeAuthenticator();
  const opts = await core.registrationOptions(RP, USER, []);
  await assert.rejects(core.verifyRegistration(RP, attest(a, opts, 'https://evil.com'), opts.challenge), { code: 'invalid-argument' });
  await assert.rejects(core.verifyRegistration(RP, attest(a, opts, RP.origin), 'baska-bir-dize'), { code: 'invalid-argument' });
  await assert.rejects(core.verifyRegistration(RP, attest(a, opts, RP.origin, { flags: UP | AT }), opts.challenge), { code: 'invalid-argument' });
});

test('giriş: yanlış doğrulama dizesi / köken / Face ID yok / bozuk imza reddedilir', async () => {
  const a = makeAuthenticator();
  const stored = await register(a);
  const opts = await core.authenticationOptions(RP);
  await assert.rejects(core.verifyAuthentication(RP, assertion(a, opts, RP.origin, RP.rpID, USER.uid), 'eski-dize', stored), { code: 'unauthenticated' });
  await assert.rejects(core.verifyAuthentication(RP, assertion(a, opts, 'https://evil.com', RP.rpID, USER.uid), opts.challenge, stored), { code: 'unauthenticated' });
  await assert.rejects(core.verifyAuthentication(RP, assertion(a, opts, RP.origin, RP.rpID, USER.uid, { flags: UP }), opts.challenge, stored), { code: 'unauthenticated' });
  await assert.rejects(core.verifyAuthentication(RP, assertion(a, opts, RP.origin, RP.rpID, USER.uid, { tamper: true }), opts.challenge, stored), { code: 'unauthenticated' });
});

test('giriş: başka kullanıcının userHandle\'ı ve başka otelin kaydı reddedilir', async () => {
  const a = makeAuthenticator();
  const stored = await register(a);
  const opts = await core.authenticationOptions(RP);
  await assert.rejects(
    core.verifyAuthentication(RP, assertion(a, opts, RP.origin, RP.rpID, 'uid-baskasi'), opts.challenge, stored),
    { code: 'unauthenticated', message: /bu hesaba ait değil/ });
  // Otel B'nin giriş sayfası, otel A'da kaydedilmiş kaydı kabul etmez.
  const rpB = core.rpFromOrigin('https://otelb.hotizy.com', 'p');
  const optsB = await core.authenticationOptions(rpB);
  await assert.rejects(
    core.verifyAuthentication(rpB, assertion(a, optsB, rpB.origin, rpB.rpID, USER.uid), optsB.challenge, stored),
    { code: 'unauthenticated', message: /bu adres için geçerli değil/ });
});

test('giriş: geriye giden sayaç (kopyalanmış doğrulayıcı) reddedilir', async () => {
  const a = makeAuthenticator();
  const stored = await register(a);
  stored.counter = 10;
  const opts = await core.authenticationOptions(RP);
  await assert.rejects(
    core.verifyAuthentication(RP, assertion(a, opts, RP.origin, RP.rpID, USER.uid, { counter: 5 }), opts.challenge, stored),
    (e) => e.code === 'unauthenticated' && /counter/i.test(e.detail) && !/counter|expected/i.test(e.message));
});

test('kullanıcı başına cihaz sınırı; excludeCredentials yalnızca aynı RP ID', async () => {
  const many = Array.from({ length: core.MAX_CREDENTIALS_PER_USER }, (_, i) => ({ credId: 'c' + i, rpID: RP.rpID }));
  await assert.rejects(core.registrationOptions(RP, USER, many), { code: 'resource-exhausted' });
  const opts = await core.registrationOptions(RP, USER, [
    { credId: 'AAAA', rpID: RP.rpID, transports: ['internal'] },
    { credId: 'BBBB', rpID: 'otelb.hotizy.com' }
  ]);
  assert.deepEqual(opts.excludeCredentials.map((c) => c.id), ['AAAA']);
  await assert.rejects(core.registrationOptions(null, USER, []), { code: 'failed-precondition' });
  await assert.rejects(core.authenticationOptions(null), { code: 'failed-precondition' });
});

// ── Sunucu ve istemci bağlantıları (kaynaktan) ────────────────────
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('sunucu: yönetici izni, tek kullanımlık doğrulama dizesi, kullanıcı silme/şifre sıfırlamada iptal', () => {
  const idx = read('functions/index.js');
  const block = idx.slice(idx.indexOf('exports.passkeyRegisterOptions'), idx.indexOf('exports.healthCheck'));
  // Kayıt ve giriş yalnızca faceIdAllowed === true iken.
  assert.match(block.slice(0, block.indexOf('exports.passkeyRegisterVerify')), /faceIdAllowed !== true/);
  const verify = block.slice(block.indexOf('exports.passkeyLoginVerify'), block.indexOf('exports.passkeyManage'));
  assert.match(verify, /faceIdAllowed !== true/);
  assert.match(verify, /tx\.delete\(chRef\)/);             // yeniden oynatılamaz
  assert.match(verify, /ch\.expiresAt < Date\.now\(\)/);
  assert.match(verify, /withinRateLimit\('pk_ver_'/);
  assert.match(verify, /au\.disabled/);
  assert.match(verify, /createCustomToken\(stored\.uid\)/);
  assert.match(block, /requireTenantAdminFor\(request, targetUid\)/); // başkasının cihazları: yalnızca otel yöneticisi
  const del = idx.slice(idx.indexOf('exports.deleteUser'), idx.indexOf('exports.resetUserPassword'));
  assert.match(del, /pkDeleteForUser\(uid\)/);
  const reset = idx.slice(idx.indexOf('exports.resetUserPassword'), idx.indexOf('exports.resetUserPassword') + 2500);
  assert.match(reset, /pkDeleteForUser\(targetUid\)/);
  assert.match(idx.slice(idx.indexOf('const TENANT_FIELD_COLLECTIONS'), idx.indexOf('const TENANT_DOC_COLLECTIONS')), /'webauthnCredentials'/);
  assert.match(read('functions/package.json'), /"@simplewebauthn\/server"/);
});

test('istemci: giriş ekranı Face ID düğmesi + öneri kartı; şifre ve Face ID aynı giriş akışından geçer', () => {
  const html = read('login.html');
  for (const id of ['faceIdBox', 'faceIdBtn', 'faceIdLabel', 'faceIdOfferCard', 'fidOfferYes', 'fidOfferNo', 'fidOfferErr', 'fidOfferTitle', 'fidOfferLabel']) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
  assert.ok(html.indexOf('js/core/passkey.js') > -1 && html.indexOf('js/core/passkey.js') < html.indexOf('js/modules/app.js'), 'passkey.js app.js\'ten önce');
  assert.match(html, /firebase-functions\.js/);
  const app = read('js/modules/app.js');
  assert.match(app, /signInWithEmailAndPassword\(email, password\);\s*await continueAfterSignIn\(userCredential\.user, userInput, false\)/);
  assert.match(app, /signInWithCustomToken\(r\.data\.token\)[\s\S]{0,120}continueAfterSignIn\(cred\.user, '', true\)/);
  // Zorunlu şifre değişimi ve abonelik denetimi ortak akışta (Face ID atlatamaz).
  const cont = app.slice(app.indexOf('async function continueAfterSignIn'), app.indexOf('async function completeLogin'));
  assert.match(cont, /isSubscriptionActive\(tenantId\)/);
  assert.match(cont, /mustChangePassword === true/);
  // Öneri yalnızca yönetici izin verdiyse.
  assert.match(app, /userData\.faceIdAllowed !== true/);
});

test('yönetici: kullanıcı oluştururken/düzenlerken Face ID seçeneği; kapatınca cihazlar silinir', () => {
  const html = read('admin.html');
  assert.match(html, /id="adminUserFaceId"/);
  assert.match(html, /id="adminUserFaceIdRevoke"/);
  const js = read('js/modules/admin.js');
  const upd = js.slice(js.indexOf('// UPDATE MODE'), js.indexOf('// CREATE MODE'));
  assert.match(upd, /faceIdAllowed: faceIdOn/);
  assert.match(upd, /faceIdWas && !faceIdOn[\s\S]{0,200}revokeAll/);
  const create = js.slice(js.indexOf('// CREATE MODE'), js.indexOf("showToast('Yeni hesap oluşturuldu"));
  assert.match(create, /faceIdAllowed: faceIdOn/);
  assert.match(js, /const faceIdOn = !isFnbDept\(department\) &&/); // F&B kodla girer
  assert.match(js, /setFaceIdSel\(false\)/);                        // yeni kullanıcı varsayılanı: kapalı
});
