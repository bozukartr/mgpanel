/* Misafir Kayıtları — geri al, toplu işlem, kaydırarak işlem (panel.js)
 *  · Tek iş akışı çekirdeği (runTransitionTx): modal, hızlı düğme,
 *    kaydırma ve toplu işlem aynı transaction'dan geçer.
 *  · Geri al: yalnızca tamamlayan kişi ve kayıt bu arada değişmediyse;
 *    ÖNCEKİ duruma döner, tamamlama notu çıkarılır, QR kalemi geri açılır.
 *  · Toplu: Tamamlandı yalnızca yetkili kayıtlara; Ata yalnızca yönetici ve
 *    yalnızca bekleyen kayıtlar (transaction içinde tekrar doğrulanır).
 *  · Kaydırma yalnızca yetkili eylem için; mobilde toplu seçim gizli.
 * Tarayıcıda uçtan uca doğrulandı (Playwright). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const js = read('js/modules/panel.js');
const sl = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i + 1); assert.ok(i > -1 && j > i, 'blok yok: ' + a); return js.slice(i, j); };

test('tek iş akışı çekirdeği; modal da onu kullanır ve önceki durumu döndürür', () => {
  assert.match(js, /async function runTransitionTx\(id, action\)/);
  assert.match(js, /return \{ ok: true, status: payload\.status, note, toastMsg, prevStatus: curStatus \};/);
  assert.match(sl('async function transitionRecordImpl', 'async function syncOrderItem'), /const result = await runTransitionTx\(editingId, action\);/);
  assert.match(js, /if \(action === 'complete'\) offerUndo\(\[\{ r, res: result \}\], result\.toastMsg\);/);
});

test('geri al: yalnızca tamamlayan, değişmemiş kayıt; önceki durum + not çıkarılır + QR geri açılır', () => {
  const u = sl('async function undoComplete', 'function offerUndo');
  assert.match(u, /if \(c\.status !== 'Solved' \|\| c\.completedBy !== loggedUsername\) return 'changed';/);
  assert.match(u, /status: res\.prevStatus \|\| 'InProgress'/);
  assert.match(u, /FieldValue\.arrayRemove\(res\.note\)/);
  assert.match(u, /syncOrderItem\(r\.orderId, r\.itemId, 'reopen'\)/);
});

test('toplu: tamamla yetki filtresi, ata yalnızca yönetici + bekleyen', () => {
  const c = sl('async function bulkComplete', 'async function openBulkAssign');
  assert.match(c, /\(r\.status \|\| 'Following'\) !== 'Solved' && canCompleteRecord\(r\)/);
  assert.match(c, /await runTransitionTx\(r\.id, 'complete'\)/);
  assert.match(c, /offerUndo\(done,/);
  const a = sl('async function bulkAssign', "document.getElementById('bulkComplete')");
  assert.match(a, /\(snap\.data\(\)\.status \|\| 'Following'\) !== 'Following'\) return false;/);
  assert.match(js, /ab\.hidden = !isManagerRole\(\);/);
  // Görünmeyen (filtre dışı) seçimler işlem görmez.
  assert.match(js, /syncBulkBar\(new Set\(finalFiltered\.map\(r => r\.id\)\)\);/);
});

test('kaydırma yalnızca yetkili eylemde; mobilde toplu seçim gizli', () => {
  assert.match(js, /status === 'Following' && canTakeRecord\(record\) \? 'take'\s*: \(status === 'InProgress' && canCompleteRecord\(record\) \? 'complete' : null\)/);
  assert.match(js, /row\.onclick = \(\) => \{ if \(!row\.__swiped\) openModal\(record\); \};/);
  const css = read('css/modules/panel.css');
  assert.match(css, /\.sel-box, \.bulk-bar \{ display: none !important; \}/);
  assert.match(css, /tr\.swipeable \{ position: relative; touch-action: pan-y; \}/);
  const html = read('panel.html');
  for (const id of ['bulkBar', 'bulkCount', 'bulkComplete', 'bulkAssignBtn', 'bulkAssignPop', 'bulkClear', 'selAll']) assert.match(html, new RegExp('id="' + id + '"'), id);
});
