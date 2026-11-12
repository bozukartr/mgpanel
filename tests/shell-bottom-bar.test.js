/* Mobil alt sekme çubuğu — app-shell.js buildBottomBar
 *  · ≤880px, role göre en sık 4 hedef + Menü (çekmeceyi açar).
 *    Personel: Kayıtlar, QR Talepler, Ara, Concierge… · Yönetici: Panel,
 *    Kayıtlar, Concierge, QR Talepler… Kapalı modüller atlanır.
 *  · F&B girişinde yok; klavye açıkken gizli; içerik çubuğun üstünde biter.
 * Tarayıcıda uçtan uca doğrulandı (Playwright). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const shell = read('js/core/app-shell.js');
const bb = shell.slice(shell.indexOf('function buildBottomBar'), shell.indexOf('// Header'));

test('role göre sıra, kapalı modüller atlanır, en çok 4 + Menü', () => {
  assert.match(bb, /\? \['dashboard', 'kayitlar', 'concierge', '@orders', '@search', 'crm', 'raporlar'\]/);
  assert.match(bb, /: \['kayitlar', '@orders', '@search', 'concierge', 'crm', 'raporlar', 'dashboard'\]/);
  assert.match(bb, /return d && moduleOn\(d\.module\) && ctxAllows\(k\);/);
  assert.match(bb, /\.slice\(0, 4\);/);
  assert.match(bb, /data-bt="menu"/);
});

test('F&B girişinde yok; klavye açıkken gizli; etkin sekme senkron', () => {
  assert.match(bb, /if \(!bar \|\| CTX === 'fnb'\) return;/);
  assert.match(bb, /window\.visualViewport\.height < window\.innerHeight \* 0\.78/);
  assert.match(shell, /'\.sh-tab\[data-route\], \.sh-dr\[data-route\], \.sh-bt\[data-route\]'/);
  const css = read('css/core/app-shell.css');
  assert.match(css, /\.sh-app\.has-bottom\.kb-open \.sh-bottom \{ display: none; \}/);
  assert.match(css, /\.sh-bottom \{ display: none; \}/); // masaüstünde yok
  // Başlıktaki arama yalnızca çubukta "Ara" varken gizlenir (yönetici çubuğunda yok).
  assert.match(css, /\.sh-app\.has-bottom-search \.sh-search \{ display: none; \}/);
  assert.doesNotMatch(css, /\.sh-app\.has-bottom \.sh-search \{ display: none; \}/);
  assert.match(bb, /classList\.toggle\('has-bottom-search', picks\.indexOf\('@search'\) !== -1\)/);
  assert.match(read('app.html'), /<nav class="sh-bottom" id="shBottom"/);
});
