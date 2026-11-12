/* Klavye kısayolları — js/core/shell-keys.js
 *  · Yalnızca yazı alanında DEĞİLKEN ve Ctrl/⌘/Alt olmadan çalışır.
 *  · 1–9 menüdeki görünür modüller, N bu ekranda yeni kayıt, T QR talepleri,
 *    ? yardım. Açık arama paletinde tetiklenmez.
 *  · N: Kayıtlar → yeni talep, Concierge → yeni rezervasyon, CRM → yeni misafir.
 * Tarayıcıda uçtan uca doğrulandı (Playwright). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const src = read('js/core/shell-keys.js');

test('yazarken ve değiştirici tuşlarla tetiklenmez; açık aramada pasif', () => {
  assert.match(src, /if \(typing \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return false;/);
  assert.match(src, /if \(window\.ShellSearch && ShellSearch\.isOpen\(\)\) return false;/);
  const shell = read('js/core/app-shell.js');
  assert.match(shell, /function isTyping\(t\)/);
  assert.match(shell, /tag === 'textarea' \|\| tag === 'select' \|\| t\.isContentEditable/);
});

test('rakamlar yalnızca görünür modüllere gider; N/T/? eşlemeleri', () => {
  assert.match(src, /\/\^\[1-9\]\$\/\.test\(k\)/);
  assert.match(src, /el\.style\.display !== 'none' && el\.offsetParent !== null/);
  assert.match(src, /kayitlar: \{ route: 'kayitlar', q: 'new=request'/);
  assert.match(src, /concierge: \{ route: 'concierge', q: 'new=1'/);
  assert.match(src, /crm: \{ route: 'crm', q: 'new=1'/);
  assert.match(src, /if \(lk === 't' && !e\.shiftKey && ordersVisible\(\)\)/);
  assert.match(src, /if \(k === '\?'\) \{ openHelp\(\); return true; \}/);
});

test('modüller "new" derin bağlantısını işler; kabuk betiği yükler', () => {
  assert.match(read('js/modules/concierge.js'), /else if \(p\.get\('new'\)\) openNewRes\(\);/);
  assert.match(read('js/modules/crm.js'), /if \(p\.get\('new'\)\) openAddGuest\(\);/);
  const html = read('app.html');
  assert.ok(html.indexOf('src="js/core/shell-search.js') < html.indexOf('src="js/core/shell-keys.js'));
});
