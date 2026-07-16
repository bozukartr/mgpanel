/* Hotizy — PMS kimlik bilgisi şifreleme çekirdeği (saf, test edilebilir).
 *
 * pmsConfig.apiKey / oauth2.clientSecret / extraHeaders.* DEĞERLERİ bu
 * modülle AES-256-GCM şifrelenip Firestore'a öyle yazılır — düz metin
 * hiçbir zaman kalıcı depoya inmez (bkz. PMS güvenlik denetimi).
 *
 * Anahtar (master secret) parametre olarak alınır — Secret Manager'a
 * (functions/index.js'teki PMS_CRED_ENC_KEY) bağımlı DEĞİLDİR, böylece
 * emülatörsüz, saf birim testleriyle doğrulanabilir.
 */
'use strict';
const crypto = require('crypto');

function keyBuf(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

// "iv:tag:ciphertext" (üçü de base64) tek bir string döner.
function encrypt(plaintext, secret) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}

// Üç parçalı biçimde OLMAYAN bir değeri (ör. henüz kaydedilmemiş, test
// edilmekte olan düz metin bir form girdisi, ya da göç öncesi eski bir
// kayıt) OLDUĞU GİBİ geri döner — geriye dönük uyumluluk + pmsTestConfig'in
// kaydedilmemiş form değerlerini şifresiz test edebilmesi için kasıtlı.
// Yanlış anahtar/bozuk veri → sessizce boş string (PMS 401'i olarak yüzeye çıkar).
function decrypt(blob, secret) {
  if (!blob || typeof blob !== 'string') return blob || '';
  const parts = blob.split(':');
  if (parts.length !== 3) return blob;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf(secret), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
  } catch (e) { return ''; }
}

// pmsSaveConfig'in extraHeaders birleştirme kuralı: client'tan gelen değer
// boşsa (form artık gerçek değeri geri okumuyor) o ANAHTAR ADI için mevcut
// şifreli değer korunur; anahtar adı değişirse eski değer sahipsiz kalıp
// düşer (o anahtar için "koru"nacak bir şey yok). Anahtar adının kendisi
// hassas değildir (ör. "x-app-key"), düz kalır — yalnız değer şifrelenir.
function mergeExtraHeaders(existingEh, newEh, secret) {
  const existing = (existingEh && typeof existingEh === 'object') ? existingEh : {};
  const incoming = (newEh && typeof newEh === 'object') ? newEh : {};
  const out = {};
  Object.keys(incoming).forEach((k) => {
    const key = String(k || '').trim().slice(0, 80);
    if (!key) return;
    const val = String(incoming[k] || '').trim().slice(0, 500);
    const enc = val ? encrypt(val, secret) : (existing[key] || '');
    if (enc) out[key] = enc;
  });
  return out;
}

// pmsTestConfig'in kaydedilmemiş test isteğine mevcut (şifreli) değerleri
// taşıması için: form o anahtar için boş gönderdiyse mevcut değer eklenir.
function fillMissingExtraHeaders(existingEh, cfgEh) {
  const existing = (existingEh && typeof existingEh === 'object') ? existingEh : {};
  const cfg = (cfgEh && typeof cfgEh === 'object') ? cfgEh : {};
  if (!Object.keys(existing).length) return cfg;
  const merged = Object.assign({}, cfg);
  Object.keys(cfg).forEach((k) => { if (!cfg[k] && existing[k]) merged[k] = existing[k]; });
  return merged;
}

module.exports = { keyBuf, encrypt, decrypt, mergeExtraHeaders, fillMissingExtraHeaders };
