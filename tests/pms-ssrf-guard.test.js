/* PMS dış istek adresi SSRF savunması — saf birim testleri.
 * Güvenlik denetiminin bulduğu boşluğu doğrudan doğrular: baseUrl/tokenUrl
 * için host doğrulaması yoktu, Cloud Functions'ın iç ağına/GCP metadata
 * sunucusuna (169.254.169.254) karşı kör SSRF mümkündü. Gerçek DNS'e hiç
 * çıkılmaz — `lookup` sahte bir çözümleyici olarak enjekte edilir. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const guard = require('../functions/pms-ssrf-guard');

const fakeLookup = (map) => async (hostname) => {
  if (!(hostname in map)) throw new Error('ENOTFOUND ' + hostname);
  return map[hostname];
};

test('ipBlocked: private/loopback/link-local/CGNAT IPv4 aralıkları engellenir', () => {
  ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
   '169.254.169.254', '100.64.0.1', '0.0.0.0'].forEach((ip) => {
    assert.strictEqual(guard.ipBlocked(ip), true, ip + ' engellenmeliydi');
  });
});

test('ipBlocked: sınır dışı özel aralıklar (172.15.x, 172.32.x) engellenmez', () => {
  assert.strictEqual(guard.ipBlocked('172.15.0.1'), false);
  assert.strictEqual(guard.ipBlocked('172.32.0.1'), false);
});

test('ipBlocked: gerçek genel (public) IPv4 adresleri engellenmez', () => {
  ['8.8.8.8', '1.1.1.1', '203.0.113.5'].forEach((ip) => {
    assert.strictEqual(guard.ipBlocked(ip), false, ip + ' engellenmemeliydi');
  });
});

test('ipBlocked: IPv6 loopback/link-local/unique-local + IPv4-mapped engellenir', () => {
  assert.strictEqual(guard.ipBlocked('::1'), true);
  assert.strictEqual(guard.ipBlocked('fe80::1'), true);
  assert.strictEqual(guard.ipBlocked('fc00::1'), true);
  assert.strictEqual(guard.ipBlocked('fd12:3456::1'), true);
  assert.strictEqual(guard.ipBlocked('::ffff:169.254.169.254'), true, 'GCP metadata IPv4-mapped adres olarak da engellenmeli');
});

test('ipBlocked: biçimsiz IPv4 (fazla/az parça, aralık dışı sayı) fail-closed engellenir', () => {
  assert.strictEqual(guard.ipBlocked('999.1.1.1'), true);
  assert.strictEqual(guard.ipBlocked('1.2.3'), true);
});

test('assertSafeOutboundUrl: http/https dışı şema reddedilir', async () => {
  await assert.rejects(guard.assertSafeOutboundUrl('file:///etc/passwd', 'URL', fakeLookup({})));
  await assert.rejects(guard.assertSafeOutboundUrl('gopher://evil.example/', 'URL', fakeLookup({})));
});

test('assertSafeOutboundUrl: localhost ve GCP metadata hostname\'i doğrudan reddedilir (DNS\'e çıkmadan)', async () => {
  await assert.rejects(guard.assertSafeOutboundUrl('http://localhost/x', 'URL', fakeLookup({})));
  await assert.rejects(guard.assertSafeOutboundUrl('http://metadata.google.internal/computeMetadata/v1/', 'URL', fakeLookup({})));
});

test('assertSafeOutboundUrl: IP-literal URL doğrudan (DNS atlanarak) kontrol edilir', async () => {
  await assert.rejects(guard.assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/', 'baseUrl', fakeLookup({})));
  await assert.doesNotReject(guard.assertSafeOutboundUrl('http://203.0.113.5/api', 'baseUrl', fakeLookup({})));
});

test('assertSafeOutboundUrl: DNS-rebinding — genel görünen hostname private IP\'ye çözülürse reddedilir', async () => {
  const lookup = fakeLookup({ 'pms.evil-hotel.example': ['169.254.169.254'] });
  await assert.rejects(guard.assertSafeOutboundUrl('https://pms.evil-hotel.example/search', 'baseUrl', lookup));
});

test('assertSafeOutboundUrl: meşru genel hostname (tüm çözülen IP\'ler public) kabul edilir', async () => {
  const lookup = fakeLookup({ 'pms.gercek-otel.example': ['203.0.113.10', '203.0.113.11'] });
  await assert.doesNotReject(guard.assertSafeOutboundUrl('https://pms.gercek-otel.example/search?q=a', 'baseUrl', lookup));
});

test('assertSafeOutboundUrl: birden fazla çözülen IP\'den TEK biri bile private ise reddedilir (rebinding çeşitliliği)', async () => {
  const lookup = fakeLookup({ 'pms.karma.example': ['203.0.113.10', '10.0.0.5'] });
  await assert.rejects(guard.assertSafeOutboundUrl('https://pms.karma.example/', 'baseUrl', lookup));
});

test('assertSafeOutboundUrl: geçersiz URL string\'i reddedilir', async () => {
  await assert.rejects(guard.assertSafeOutboundUrl('not a url', 'URL', fakeLookup({})));
  await assert.rejects(guard.assertSafeOutboundUrl('', 'URL', fakeLookup({})));
});

test('assertSafeOutboundUrl: DNS çözümlenemezse (ENOTFOUND) reddedilir', async () => {
  await assert.rejects(guard.assertSafeOutboundUrl('https://var-olmayan-alan.example/', 'baseUrl', fakeLookup({})));
});
