/* PMS adaptörü — gerçek PMS olmadan uçtan uca doğrulama.
 *
 * functions/pms-core.js yerel bir SAHTE PMS sunucusuna (OAuth2 token ucu +
 * OPERA benzeri iç içe misafir yanıtı) karşı gerçek fetch ile çalıştırılır.
 * Yalnızca SSRF denetimi (127.0.0.1 normalde engellenir) ve şifre çözme
 * sahte bağımlılıkla verilir. Emülatör gerekmez. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('../functions/pms-core');

const GUESTS = [
  { profile: { firstName: 'Ahmet', lastName: 'Yılmaz', birthDate: '1985-03-02', phones: [{ number: '+90 532 000' }] }, roomNumber: 204, arrivalDate: '2026-11-10T14:00:00Z', departureDate: '15.11.2026', vipCode: 'N' },
  { profile: { firstName: 'Sema', lastName: 'Doğan', birthDate: '21.07.1979' }, roomNumber: '410', arrivalDate: '20261109', departureDate: '2026-11-20', vipCode: 'VIP2' }
];
let server, B, hits = [], tokenCount = 0, revoked = false, fail5xx = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      hits.push({ path: u.pathname, q: u.search, auth: req.headers.authorization || '', key: req.headers['x-api-key'] || '', app: req.headers['x-app-key'] || '' });
      const json = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/oauth/token') {
        const p = new URLSearchParams(body);
        if (p.get('client_id') === 'good' && p.get('client_secret') === 's3cret') { tokenCount++; return json(200, { access_token: 'tok-' + tokenCount, expires_in: 3600 }); }
        return json(401, { error: 'invalid_client' });
      }
      if (u.pathname === '/redirect') { res.writeHead(302, { location: B + '/api/guests?q=x' }); return res.end(); }
      if (u.pathname === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>giriş</html>'); }
      if (u.pathname === '/slow') { setTimeout(() => json(200, []), 400); return; }
      if (u.pathname === '/flaky') { if (fail5xx-- > 0) return json(503, {}); return json(200, [{ name: 'Flaky Misafir', room: '9' }]); }
      if (u.pathname === '/flat') {
        if (req.headers['x-api-key'] !== 'k1') return json(401, {});
        return json(200, [{ name: 'Düz Kayıt', roomNo: '7', arrival: '01/12/2026', vip: 'yes' }]);
      }
      if (u.pathname === '/api/guests' || u.pathname === '/api/rooms') {
        const a = req.headers.authorization || '';
        if (!/^Bearer tok-\d+$/.test(a) || (revoked && a === 'Bearer tok-1')) return json(401, { error: 'unauthorized' });
        const q = (u.searchParams.get('q') || u.searchParams.get('room') || '').toLocaleLowerCase('tr-TR');
        const list = GUESTS.filter((g) => (g.profile.lastName + ' ' + g.profile.firstName).toLocaleLowerCase('tr-TR').includes(q) || String(g.roomNumber) === q);
        return json(200, { data: { guests: list }, total: list.length });
      }
      json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  B = 'http://127.0.0.1:' + server.address().port;
});
after(() => server && server.close());

function deps(cache) {
  const store = cache || { v: null };
  return {
    fetch: (u, init) => fetch(u, init),
    assertSafeUrl: async () => {},      // yerel sahte sunucu — gerçek SSRF denetimi ayrı testte
    decrypt: (x) => x || '',
    tokenCache: { get: async () => store.v, set: async (v) => { store.v = v; } },
    retryDelayMs: 5,
    timeoutMs: 1500
  };
}
const OAUTH = () => ({
  enabled: true, provider: 'generic', authType: 'oauth2', baseUrl: B + '/api', searchPath: '/guests?q={q}', resultsPath: 'data.guests',
  authPrefix: '', extraHeaders: { 'x-app-key': 'app-1' },
  oauth2: { tokenUrl: B + '/oauth/token', clientId: 'good', clientSecret: 's3cret' },
  map: { name: 'profile.firstName + profile.lastName', room: 'roomNumber', checkIn: 'arrivalDate', checkOut: 'departureDate', vip: 'vipCode', birthDate: 'profile.birthDate', phone: 'profile.phones[0].number' }
});

test('OAuth2 uçtan uca: token alınır, "Bearer" önekiyle aranır, alanlar doğru eşlenir', async () => {
  hits = [];
  const r = await core.runLookup(OAUTH(), 'yılmaz', deps());
  assert.equal(r.source, 'generic');
  assert.deepEqual(r.results, [{
    name: 'Ahmet Yılmaz', room: '204', checkIn: '2026-11-10', checkOut: '2026-11-15', vip: false,
    phone: '+90 532 000', email: '', birthYear: 1985
  }]);
  const api = hits.find((h) => h.path === '/api/guests');
  assert.match(api.auth, /^Bearer tok-\d+$/);       // boş önek → Bearer (eskiden 401)
  assert.equal(api.app, 'app-1');                    // ek header gönderilir
});

test('VIP kodu, doğum tarihi ve farklı tarih biçimleri normalize edilir', async () => {
  const r = await core.runLookup(OAUTH(), 'doğan', deps());
  assert.equal(r.results[0].vip, true);
  assert.equal(r.results[0].checkIn, '2026-11-09');
  assert.equal(r.results[0].birthYear, 1979);
});

test('eşlemesi BOŞ alan "[object Object]" olmaz; yaygın alan adlarına düşülür', async () => {
  hits = [];
  const cfg = { enabled: true, provider: 'generic', baseUrl: B + '/flat', searchPath: '?q={q}', apiKey: 'k1', authHeader: 'x-api-key', map: { name: '', room: '', phone: '' } };
  const r = await core.runLookup(cfg, 'düz', deps());
  assert.deepEqual(r.results, [{ name: 'Düz Kayıt', room: '7', checkIn: '2026-12-01', checkOut: '', vip: true, phone: '', email: '', birthYear: '' }]);
  assert.equal(hits[0].key, 'k1');                   // API anahtarında önek yok
});

test('"Bearer" boşluksuz yazılsa da doğru başlık üretilir', () => {
  assert.equal(core.authValue('Bearer', 't', false), 'Bearer t');
  assert.equal(core.authValue('Bearer ', 't', false), 'Bearer t');
  assert.equal(core.authValue('', 't', true), 'Bearer t');
  assert.equal(core.authValue('', 'k', false), 'k');
  assert.equal(core.authValue('Token token=', 'k', false), 'Token token=k');
});

test('süperadmin testi: kısa sorgu PMS\'e gitmeden "başarılı" DÖNMEZ', async () => {
  hits = [];
  await assert.rejects(core.runLookup(OAUTH(), 'a', deps(), { diagnose: true }), (e) => e.code === 'invalid-argument');
  assert.equal(hits.length, 0);
  // Personel aramasında kısa sorgu sessizce boş döner (yazarken).
  assert.deepEqual((await core.runLookup(OAUTH(), 'a', deps())).results, []);
});

test('token önbelleği kimlik bilgisine bağlı: yeni (yanlış) secret eski token\'la GEÇMEZ', async () => {
  const cache = { v: null };
  await core.runLookup(OAUTH(), 'yılmaz', deps(cache));
  assert.ok(cache.v && cache.v.token);
  const wrong = OAUTH(); wrong.oauth2.clientSecret = 'YANLIS';
  await assert.rejects(core.runLookup(wrong, 'yılmaz', deps(cache)), /OAuth2 token alınamadı: HTTP 401/);
});

test('token süresinden önce geçersizleşirse bir kez yenilenip tekrar denenir', async () => {
  tokenCount = 0; revoked = false;
  const cache = { v: null };
  await core.runLookup(OAUTH(), 'yılmaz', deps(cache));   // tok-1
  revoked = true;                                             // PMS tok-1'i iptal etti
  const r = await core.runLookup(OAUTH(), 'yılmaz', deps(cache));
  assert.equal(r.results.length, 1);
  assert.equal(cache.v.token, 'tok-2');
  revoked = false;
});

test('yönlendirme İZLENMEZ (SSRF) ve açık hata verir', async () => {
  hits = [];
  const cfg = { enabled: true, provider: 'generic', baseUrl: B + '/redirect', searchPath: '?q={q}', apiKey: 'k1', authHeader: 'x-api-key' };
  await assert.rejects(core.runLookup(cfg, 'yılmaz', deps()), /yönlendirme döndürdü \(HTTP 302\)/);
  assert.equal(hits.filter((h) => h.path === '/api/guests').length, 0);
});

test('JSON olmayan yanıt anlaşılır hata verir', async () => {
  const cfg = { enabled: true, provider: 'generic', baseUrl: B + '/html', searchPath: '?q={q}' };
  await assert.rejects(core.runLookup(cfg, 'yılmaz', deps()), /JSON değil \(text\/html\)/);
});

test('teşhis: yanlış Sonuç Yolu bulunamadı olarak raporlanır, yanıt alan yolları (değersiz) döner', async () => {
  const cfg = OAUTH(); cfg.resultsPath = 'data.guest';
  const r = await core.runLookup(cfg, 'yılmaz', deps(), { diagnose: true });
  assert.equal(r.diag.resultsPathFound, false);
  assert.deepEqual(r.diag.topKeys, ['data', 'total']);
  const ok = await core.runLookup(OAUTH(), 'yılmaz', deps(), { diagnose: true });
  assert.equal(ok.diag.resultsPathFound, true);
  assert.ok(ok.diag.itemKeys.includes('profile.firstName'));
  assert.ok(ok.diag.itemKeys.includes('profile.phones[0].number'));
  assert.equal(ok.diag.insecure, true);
  assert.ok(!JSON.stringify(ok.diag).includes('Yılmaz'), 'teşhis kişisel veri taşımamalı');
});

test('oda numarası gibi görünen sorguda Oda Arama Yolu kullanılır', async () => {
  hits = [];
  const cfg = OAUTH(); cfg.roomSearchPath = '/rooms?room={q}';
  const r = await core.runLookup(cfg, '410', deps());
  assert.equal(r.results[0].name, 'Sema Doğan');
  assert.ok(hits.some((h) => h.path === '/api/rooms' && h.q === '?room=410'));
});

test('5xx\'te bir kez yeniden dener; zaman aşımında açık hata verir', async () => {
  fail5xx = 1;
  const r = await core.runLookup({ enabled: true, provider: 'generic', baseUrl: B + '/flaky', searchPath: '?q={q}' }, 'flaky', deps());
  assert.equal(r.results[0].name, 'Flaky Misafir');
  const d = deps(); d.timeoutMs = 100;
  await assert.rejects(core.runLookup({ enabled: true, provider: 'generic', baseUrl: B + '/slow', searchPath: '?q={q}' }, 'xx', d), (e) => e.code === 'deadline-exceeded');
});

test('demo sağlayıcı bugüne göre tarih üretir ve "mock" olarak işaretlenir', async () => {
  const r = await core.runLookup({ enabled: true, provider: 'mock' }, 'yılmaz', deps());
  assert.equal(r.source, 'mock');
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  assert.ok(r.results[0].checkIn <= today && r.results[0].checkOut >= today);
});

test('yardımcılar: URL kurma, tarih, VIP', () => {
  assert.equal(core.buildUrl('https://p.example/api/', '/g?q={q}', 'a b'), 'https://p.example/api/g?q=a%20b');
  assert.equal(core.buildUrl('https://p.example/api?hotel=7', '?q={q}', 'x'), 'https://p.example/api?hotel=7&q=x');
  assert.equal(core.normDate('2026-11-10T23:30:00+03:00'), '2026-11-10');
  assert.equal(core.normDate('5.3.2026'), '2026-03-05');
  assert.equal(core.normDate('03/25/2026'), '2026-03-25');   // ABD biçimi (ikinci sayı > 12)
  assert.equal(core.normDate('yarın'), '');
  for (const v of ['N', 'no', 'false', '0', '', null, 0, false]) assert.equal(core.normVip(v), false, String(v));
  for (const v of ['Y', 'VIP1', 'Gold', 'true', 1, true]) assert.equal(core.normVip(v), true, String(v));
});

test('Cloud Function sarmalayıcıları: test modu, alan değiştirme, önbellek temizliği', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  assert.doesNotMatch(src, /request\.data\.query\) \|\| 'a'/);                // varsayılan 'a' yok
  assert.match(src, /pmsRunLookup\(.*\{ test: true \}\);/);
  assert.match(src, /ref\.set\(out, \{ mergeFields: Object\.keys\(out\) \}\)/); // kaldırılan header/eşleme kalmaz
  assert.match(src, /db\.collection\('pmsOAuthCache'\)\.doc\(tenantId\)\.delete\(\)/);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'superadmin.html'), 'utf8');
  assert.doesNotMatch(ui, /id="pmsTestQuery"[^>]*value="a"/);
  for (const id of ['pmsRoomSearchPath', 'pmsMapVip', 'pmsMapBirth']) assert.match(ui, new RegExp('id="' + id + '"'));
});
