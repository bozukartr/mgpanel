/* Hotizy — Face ID / Touch ID / Windows Hello ile giriş (passkey, WebAuthn).
 *
 * Saf çekirdek: seçenek üretme ve doğrulama @simplewebauthn/server ile;
 * Firestore ve Firebase Auth functions/index.js'tedir. Böylece tören (kayıt +
 * giriş) gerçek kriptografiyle, emülatörsüz test edilebilir
 * (tests/passkey-core.test.js).
 *
 * Güvenlik modeli
 *  · Biyometrik veri cihazdan hiç çıkmaz; sunucu yalnızca cihazın AÇIK
 *    anahtarını saklar ve her girişte imzayı doğrular.
 *  · RP ID = sayfanın TAM adresi (otelin alt alan adı, ör. otel.hotizy.com):
 *    bir otelde kaydedilen passkey başka otelin giriş sayfasında görünmez.
 *  · Köken (origin) allowlist'i: yalnızca hotizy.com ve alt alan adları,
 *    projenin Firebase Hosting adresleri ve yerel geliştirme (localhost).
 *  · Kullanıcı doğrulaması (Face ID/PIN) ZORUNLU (userVerification:
 *    'required'); yalnızca cihazda kayıtlı (platform) doğrulayıcılar.
 *  · Sayaç (counter) gerilerse kopyalanmış doğrulayıcı sayılır ve reddedilir
 *    (kütüphane uygular).
 */
'use strict';
const crypto = require('crypto');
const swa = require('@simplewebauthn/server');
const { isoBase64URL, isoUint8Array } = require('@simplewebauthn/server/helpers');

class PasskeyError extends Error {
  // detail: kütüphanenin (İngilizce) teknik nedeni — yalnızca sunucu günlüğü
  // için; kullanıcıya gösterilen mesaj Türkçe ve sadedir.
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail || ''; this.isPasskeyError = true; }
}
const why = (e) => (e && e.message ? String(e.message) : 'bilinmeyen hata');

const RP_NAME = 'Hotizy';
const MAX_CREDENTIALS_PER_USER = 10;

// İsteğin kökeninden (Origin başlığı) güvenilir RP bilgisini türetir; izin
// verilmeyen köken → null (çağıran reddeder).
function rpFromOrigin(origin, projectId) {
  let u;
  try { u = new URL(String(origin || '')); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const project = String(projectId || '').toLowerCase();
  const prodHost = host === 'hotizy.com' || host.endsWith('.hotizy.com')
    || (!!project && (host === project + '.web.app' || host === project + '.firebaseapp.com'));
  if (u.protocol === 'https:' && prodHost) return { origin: u.origin, rpID: host };
  if (host === 'localhost' && (u.protocol === 'http:' || u.protocol === 'https:')) return { origin: u.origin, rpID: host };
  return null;
}

// Firestore belge kimliği: kimlik bilgisi kimliği değişken uzunlukta
// base64url — sabit uzunlukta özetle saklanır.
function credDocId(credId) {
  return crypto.createHash('sha256').update(String(credId || '')).digest('hex');
}

// Kullanıcı aracısından insan-okur cihaz adı (yönetici listesinde gösterilir).
function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'Cihaz';
  const br = /Edg\//.test(s) ? 'Edge' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari' : '';
  return br ? os + ' · ' + br : os;
}

async function registrationOptions(rp, user, existing) {
  if (!rp) throw new PasskeyError('failed-precondition', 'Bu adreste Face ID kullanılamaz.');
  const list = Array.isArray(existing) ? existing : [];
  if (list.length >= MAX_CREDENTIALS_PER_USER) {
    throw new PasskeyError('resource-exhausted', 'Bu hesap için en fazla ' + MAX_CREDENTIALS_PER_USER + ' cihaz kaydedilebilir. Yöneticinizden eskileri kaldırmasını isteyin.');
  }
  return swa.generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: String(user.username || user.uid),
    userDisplayName: String(user.displayName || user.username || user.uid),
    userID: isoUint8Array.fromUTF8String(String(user.uid)),
    attestationType: 'none',
    excludeCredentials: list.filter((c) => c.rpID === rp.rpID).map((c) => ({ id: c.credId, transports: c.transports || [] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' },
    supportedAlgorithmIDs: [-7, -257],
    timeout: 60000
  });
}

async function verifyRegistration(rp, response, expectedChallenge) {
  let v;
  try {
    v = await swa.verifyRegistrationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true
    });
  } catch (e) {
    throw new PasskeyError('invalid-argument', 'Cihaz kaydı doğrulanamadı. Lütfen tekrar deneyin.', why(e));
  }
  if (!v || !v.verified || !v.registrationInfo) throw new PasskeyError('invalid-argument', 'Cihaz kaydı doğrulanamadı.');
  const info = v.registrationInfo;
  const cred = info.credential;
  const transports = (cred.transports && cred.transports.length ? cred.transports
    : ((response && response.response && response.response.transports) || [])).slice(0, 8);
  return {
    credId: cred.id,
    publicKey: isoBase64URL.fromBuffer(cred.publicKey),
    counter: Number(cred.counter) || 0,
    transports,
    deviceType: info.credentialDeviceType || '',
    backedUp: !!info.credentialBackedUp
  };
}

async function authenticationOptions(rp) {
  if (!rp) throw new PasskeyError('failed-precondition', 'Bu adreste Face ID kullanılamaz.');
  // allowCredentials boş: cihazdaki (keşfedilebilir) passkey'ler önerilir —
  // kullanıcı adı yazmadan giriş.
  return swa.generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', allowCredentials: [], timeout: 60000 });
}

// stored: Firestore'daki kayıt {uid, credId, publicKey(b64url), counter, transports, rpID}
async function verifyAuthentication(rp, response, expectedChallenge, stored) {
  if (!stored || stored.rpID !== rp.rpID) throw new PasskeyError('unauthenticated', 'Bu cihaz kaydı bu adres için geçerli değil.');
  // Kimlik bilgisi sahibi: doğrulayıcının döndürdüğü kullanıcı kimliği
  // (userHandle) kayıttaki kullanıcıyla aynı olmalı.
  const uh = response && response.response && response.response.userHandle;
  if (uh) {
    let handle = '';
    try { handle = isoBase64URL.toUTF8String(uh); } catch (e) { handle = ''; }
    if (handle !== stored.uid) throw new PasskeyError('unauthenticated', 'Cihaz kaydı bu hesaba ait değil.');
  }
  let v;
  try {
    v = await swa.verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: stored.credId, publicKey: isoBase64URL.toBuffer(stored.publicKey), counter: Number(stored.counter) || 0, transports: stored.transports || [] }
    });
  } catch (e) {
    throw new PasskeyError('unauthenticated', 'Face ID doğrulaması başarısız. Şifrenizle giriş yapabilirsiniz.', why(e));
  }
  if (!v || !v.verified) throw new PasskeyError('unauthenticated', 'Face ID doğrulaması başarısız.');
  return { newCounter: Number(v.authenticationInfo && v.authenticationInfo.newCounter) || 0 };
}

module.exports = {
  PasskeyError, RP_NAME, MAX_CREDENTIALS_PER_USER,
  rpFromOrigin, credDocId, deviceLabel,
  registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication
};
