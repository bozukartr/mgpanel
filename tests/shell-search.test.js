/* Genel arama (oda / misafir) — js/core/shell-search.js
 *
 *  · Türkçe harf duyarsız eşleşme ("sukru" ~ "Şükrü", "ILKER" ~ "İlker").
 *  · Oda varyantları: "0708" ~ "708", "12" ~ "0012" (yazım farkı kaçmasın).
 *  · Yalnızca otel bağlamında; kapalı modüllerin bölümleri sorgulanmaz.
 *  · Oda hesabı para birimleri karıştırılmadan gruplanır.
 *  · Modüller aramadan gelen derin bağlantıları işler (kayıt / rezervasyon /
 *    CRM araması / oda-misafir dolu yeni kayıt).
 * Tarayıcıda uçtan uca doğrulandı (Playwright). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const src = read('js/core/shell-search.js');

function load(ctx) {
  const store = Object.assign({ hotelUsername: 'ayse' }, ctx || {});
  const win = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { readyState: 'complete', getElementById: () => null, querySelectorAll: () => [] },
    navigator: { platform: 'Linux', userAgent: '' },
    db: {}, TENANT_ID: 'otel'
  };
  win.window = win;
  vm.runInNewContext(src, win);
  return win.ShellSearch;
}

test('Türkçe harf duyarsız karşılaştırma', () => {
  const S = load();
  assert.equal(S._fold('Şükrü Öztürk'), 'sukru ozturk');
  assert.equal(S._fold('İLKER IŞIK'), 'ilker isik');
  assert.equal(S._fold('  Çağla  '), 'cagla');
});

test('oda yazım varyantları', () => {
  const S = load();
  const rv = (x) => JSON.parse(JSON.stringify(S._roomVariants(x))); // vm diziler başka realm'de
  assert.deepEqual(rv('0708'), ['0708', '708']);
  assert.deepEqual(rv('12'), ['12', '0012']);
  assert.deepEqual(rv('A101'), ['A101']);
  assert.ok(S._roomVariants('1001').length <= 10); // Firestore 'in' sınırı
});

test('yalnızca otel bağlamında yüklenir', () => {
  assert.equal(load({ loginContext: 'fnb' }), undefined);
  assert.ok(load({ loginContext: 'hotel' }));
});

test('kapalı modüllerin bölümleri sorgulanmaz; oda hesabı para birimine göre gruplanır', () => {
  const lr = src.slice(src.indexOf('function loadRoom'), src.indexOf('// ── Arayüz'));
  assert.match(lr, /on\('guestIssues'\) \? q\('guestLogs', room\)/);
  assert.match(lr, /on\('guestOrders'\) \? q\('guestOrders', room\)/);
  assert.match(lr, /on\('concierge'\) \? q\('reservations', room\)/);
  assert.match(lr, /q\('folioCharges', room, function \(r\) \{ return r\.where\('status', '==', 'open'\); \}\)/);
  assert.match(src, /var cur = c\.currency \|\| \(c\.source === 'concierge' \? 'EUR' : 'TRY'\);/);
  // Eski bir sorgunun sonucu yenisinin üstüne yazılmaz.
  assert.match(src, /if \(my !== seq \|\| !isOpen\(\)\) return;/);
});

test('kabuk: arama düğmesi, betik ve kısayol (Ctrl/⌘+K, yazı alanı dışında /)', () => {
  const html = read('app.html');
  assert.match(html, /id="shSearchBtn" data-ctx="hotel"/);
  assert.match(html, /js\/core\/shell-search\.js\?v=/);
  assert.ok(html.indexOf('src="js/core/app-shell.js') < html.indexOf('src="js/core/shell-search.js'));
  assert.match(src, /\(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && k === 'k'/);
  assert.match(src, /!typing && !isOpen\(\) && e\.key === '\/'/);
  const shell = read('js/core/app-shell.js');
  assert.match(shell, /f\.contentWindow\.addEventListener\('keydown', onKey, true\)/);
  assert.match(shell, /addKeyHandler: function \(fn\)/);
});

test('modüller aramadan gelen derin bağlantıları işler', () => {
  const panel = read('js/modules/panel.js');
  assert.match(panel, /else if \(p\.get\('new'\)\) openNewIssueFor\(p\.get\('new'\), p\.get\('room'\), p\.get\('guest'\)\)/);
  assert.match(panel, /function openNewIssueFor\(type, room, guest\)/);
  const con = read('js/modules/concierge.js');
  assert.match(con, /function openReservationById\(id\)/);
  assert.match(con, /get\('res'\);\s*if \(id\) openReservationById\(id\)/);
  assert.match(con, /if \(window\.__openPendingRes\) window\.__openPendingRes\(\);/);
  const crm = read('js/modules/crm.js');
  assert.match(crm, /applySearch\(new URLSearchParams\(d\.query \|\| ''\)\.get\('q'\)\)/);
});
