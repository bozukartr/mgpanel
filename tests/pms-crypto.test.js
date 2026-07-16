/* PMS kimlik bilgisi şifreleme çekirdeği — saf birim testleri.
 * Güvenlik denetiminin kapattığı bulguları doğrudan doğrular:
 * apiKey/clientSecret/extraHeaders DEĞERLERİ hiçbir zaman düz metin
 * Firestore'a inmez, "mevcut değeri koru" birleştirmesi yalnızca ANAHTAR
 * ADI eşleştiğinde çalışır, yanlış anahtarla deşifre asla eski değeri
 * sızdırmaz (sessizce boş döner). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pc = require('../functions/pms-crypto');

const KEY = 'test-master-key-' + 'x'.repeat(20);
const OTHER_KEY = 'yanlis-anahtar-' + 'y'.repeat(20);

test('encrypt: boş girdi boş string döner (şifrelenmez)', () => {
  assert.strictEqual(pc.encrypt('', KEY), '');
  assert.strictEqual(pc.encrypt(null, KEY), '');
});

test('encrypt→decrypt round-trip: gizli değer geri kazanılır', () => {
  const secret = 'sk_live_TOPSECRET_1234567890';
  const enc = pc.encrypt(secret, KEY);
  assert.notStrictEqual(enc, secret, 'şifreli çıktı düz metinle AYNI OLMAMALI');
  assert.ok(!enc.includes(secret), 'şifreli blob düz metni İÇERMEMELİ');
  assert.strictEqual(pc.decrypt(enc, KEY), secret);
});

test('şifreli blob "iv:tag:ciphertext" biçiminde, üç base64 parça', () => {
  const enc = pc.encrypt('x-app-key-value-abc', KEY);
  const parts = enc.split(':');
  assert.strictEqual(parts.length, 3);
  parts.forEach(p => assert.ok(/^[A-Za-z0-9+/]+=*$/.test(p), 'her parça base64 olmalı'));
});

test('aynı düz metin iki kez şifrelenince FARKLI blob üretir (rastgele IV — desen analizi engellenir)', () => {
  const a = pc.encrypt('ayni-deger', KEY);
  const b = pc.encrypt('ayni-deger', KEY);
  assert.notStrictEqual(a, b);
  assert.strictEqual(pc.decrypt(a, KEY), 'ayni-deger');
  assert.strictEqual(pc.decrypt(b, KEY), 'ayni-deger');
});

test('yanlış anahtarla decrypt SESSİZCE boş döner — eski değeri sızdırmaz', () => {
  const enc = pc.encrypt('gizli-token', KEY);
  assert.strictEqual(pc.decrypt(enc, OTHER_KEY), '');
});

test('decrypt: şifreli biçimde OLMAYAN değeri (düz metin/test girdisi) olduğu gibi geri döner', () => {
  assert.strictEqual(pc.decrypt('henuz-sifrelenmemis-deger', KEY), 'henuz-sifrelenmemis-deger');
  assert.strictEqual(pc.decrypt('', KEY), '');
  assert.strictEqual(pc.decrypt(null, KEY), '');
  assert.strictEqual(pc.decrypt(undefined, KEY), '');
});

test('mergeExtraHeaders: yeni değer girilirse şifrelenir, düz metin olarak SAKLANMAZ', () => {
  const out = pc.mergeExtraHeaders({}, { 'x-app-key': 'YENI_GIZLI_DEGER' }, KEY);
  assert.ok(out['x-app-key']);
  assert.notStrictEqual(out['x-app-key'], 'YENI_GIZLI_DEGER');
  assert.strictEqual(pc.decrypt(out['x-app-key'], KEY), 'YENI_GIZLI_DEGER');
});

test('mergeExtraHeaders: değer BOŞ gönderilirse (form artık gerçek değeri göstermiyor) aynı ANAHTAR ADI için mevcut şifreli değer KORUNUR', () => {
  const existingEnc = pc.encrypt('eski-gizli-deger', KEY);
  const existing = { 'x-app-key': existingEnc };
  // İstemci, kullanıcı alanı boş bıraktığında anahtar adını yine de gönderir
  // (superadmin.js readPmsConfig: `if (k1) eh[k1] = v1;`), değer boştur.
  const out = pc.mergeExtraHeaders(existing, { 'x-app-key': '' }, KEY);
  assert.strictEqual(out['x-app-key'], existingEnc, 'mevcut şifreli blob aynen korunmalı');
  assert.strictEqual(pc.decrypt(out['x-app-key'], KEY), 'eski-gizli-deger');
});

test('mergeExtraHeaders: anahtar adı DEĞİŞTİRİLİRSE eski değer yeni anahtara taşınmaz (sahipsiz kalıp düşer)', () => {
  const existing = { 'x-app-key': pc.encrypt('eski-deger', KEY) };
  const out = pc.mergeExtraHeaders(existing, { 'x-hotel-id': '' }, KEY);
  assert.strictEqual(out['x-hotel-id'], undefined, 'boş değerli yeni anahtar için koruyacak eski değer yok');
  assert.strictEqual(out['x-app-key'], undefined, 'yanıtta artık gönderilmeyen eski anahtar taşınmaz');
});

test('mergeExtraHeaders: hem anahtar hem değer boşsa slot tamamen atlanır', () => {
  const out = pc.mergeExtraHeaders({}, { '': 'deger-ama-anahtarsiz' }, KEY);
  assert.deepStrictEqual(out, {});
});

test('mergeExtraHeaders: iki bağımsız header karışmaz (çapraz sızıntı yok)', () => {
  const existing = { 'x-app-key': pc.encrypt('app-key-deger', KEY), 'x-hotel-id': pc.encrypt('hotel-id-deger', KEY) };
  const out = pc.mergeExtraHeaders(existing, { 'x-app-key': 'YENI', 'x-hotel-id': '' }, KEY);
  assert.strictEqual(pc.decrypt(out['x-app-key'], KEY), 'YENI');
  assert.strictEqual(pc.decrypt(out['x-hotel-id'], KEY), 'hotel-id-deger');
});

test('fillMissingExtraHeaders: test isteğinde boş bırakılan anahtar için mevcut şifreli değer eklenir', () => {
  const existing = { 'x-app-key': pc.encrypt('canli-deger', KEY) };
  const merged = pc.fillMissingExtraHeaders(existing, { 'x-app-key': '' });
  assert.strictEqual(merged['x-app-key'], existing['x-app-key']);
});

test('fillMissingExtraHeaders: form YENİ (taze) bir değer girdiyse mevcut değerin üzerine YAZILMAZ', () => {
  const existing = { 'x-app-key': pc.encrypt('eski', KEY) };
  const merged = pc.fillMissingExtraHeaders(existing, { 'x-app-key': 'taze-test-degeri' });
  assert.strictEqual(merged['x-app-key'], 'taze-test-degeri');
});

test('fillMissingExtraHeaders: kayıtlı header hiç yoksa girdi olduğu gibi döner', () => {
  const merged = pc.fillMissingExtraHeaders({}, { 'x-app-key': '' });
  assert.deepStrictEqual(merged, { 'x-app-key': '' });
});
