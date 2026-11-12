/* App Shell — modüller kendi çerçevelerinde AÇIK kalır (anında sekme geçişi).
 *
 *  · Her rota için ayrı iframe; geri dönüşte sayfa yeniden yüklenmez
 *    (filtre, kaydırma, yarım form korunur). Bellek sınırı + bayatlık.
 *  · Açık modüle derin bağlantı yeniden yüklemeden "deepLink" mesajıyla
 *    iletilir; Misafir Kayıtları (?open=) ve QR çekmecesi (?order= /
 *    ?orders=1) bu mesajı işler.
 *  · Çerçeve kendi içinde başka modüle geçerse o rotaya taşınır.
 *  · Tarayıcıda uçtan uca doğrulandı (Playwright); burada kaynak korkulukları. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const shell = read('js/core/app-shell.js');

test('kabuk: rota başına çerçeve, yalnızca etkin olan görünür, sınır + bayatlık', () => {
  assert.match(shell, /var frames = \{\};/);
  assert.match(shell, /function createFrame\(route, query\)/);
  assert.match(shell, /var MAX_FRAMES = isMobileShell\(\) \? 3 : 6;/);
  assert.match(shell, /STALE_MS/);
  assert.match(shell, /function evict\(\)/);
  // Var olan çerçeve sorgusuz istenince yeniden YÜKLENMEZ (src atanmaz).
  const lr = shell.slice(shell.indexOf('function loadRoute'), shell.indexOf('function navigate'));
  assert.match(lr, /if \(!f\) \{\s*createFrame\(route, query\);/);
  assert.match(lr, /type: 'deepLink', query: query/);
  assert.doesNotMatch(lr, /\.src\s*=/);
  // Gizli çerçeveler odak/ekran okuyucu dışı.
  assert.match(shell, /setAttribute\('inert', ''\)/);
  const css = read('css/core/app-shell.css');
  assert.match(css, /\.sh-frame \{[^}]*position: absolute;[^}]*visibility: hidden;/);
  assert.match(css, /\.sh-frame\.on \{ visibility: visible; \}/);
});

test('kabuk: gezinme geçmişi + çift yükleme yok; derin bağlantı sorgusu temizlenir', () => {
  assert.match(shell, /function navigate\(route, query\)[\s\S]{0,200}history\.pushState\(null, '', '#' \+ route\)/);
  assert.match(shell, /window\.addEventListener\('hashchange', fromHash\)/);
  assert.match(shell, /if \(q\) \{ try \{ history\.replaceState\(null, '', '#' \+ currentRoute\)/);
  // Bildirim açıcıları da navigate kullanır (hash + loadRoute çift yüklemesi yok).
  assert.match(shell, /RT\.onOpen = function \(recordId\) \{\s*navigate\('kayitlar'/);
  assert.doesNotMatch(shell, /location\.hash = '#concierge';\s*loadRoute/);
});

test('kabuk: kendi içinde başka modüle geçen çerçeve o rotaya taşınır', () => {
  const m = shell.slice(shell.indexOf("d.type !== 'route'") - 200, shell.indexOf('// Bildirim (zil)'));
  assert.match(m, /routeOfWindow\(e\.source\)/);
  assert.match(m, /frames\[d\.route\] = f;/);
  const embed = read('js/core/embed.js');
  assert.match(embed, /f === 'reports'\) return 'raporlar'/);
  assert.match(embed, /f === 'restaurant'\) return 'restoran'/);
});

test('modüller derin bağlantı mesajını işler (yeniden yüklemeden kayıt açma)', () => {
  const panel = read('js/modules/panel.js');
  assert.match(panel, /function openRecordById\(openId\)/);
  assert.match(panel, /d\.type !== 'deepLink' \|\| e\.source !== window\.parent/);
  assert.match(panel, /if \(p\.get\('open'\)\) openRecordById\(p\.get\('open'\)\)/);
  const go = read('js/modules/guest-orders.js');
  assert.match(go, /d\.type === 'deepLink'[\s\S]{0,200}focusOrder\(q\.get\('order'\)\)[\s\S]{0,80}openDrawer\(\)/);
});
