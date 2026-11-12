/* İş kuyruğum (saha personeli) — panel.js renderMyQueue + rol bazlı açılış.
 *  · Üzerimde: üstlendiğim VEYA bana atanan açık işler; Sırada: departmanımda
 *    kimsenin üstlenmediği, benim üstlenebileceğim işler. Gecikenler önce.
 *  · Düğmeler aynı transaction'lı iş akışından geçer (quickTransition):
 *    katı departman kuralı ve vardiya kontrolü korunur.
 *  · Personel (admin/yönetici değil) uygulamayı Kayıtlar'da açar; yönetici Panel'de.
 * Tarayıcıda uçtan uca doğrulandı (Playwright). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const js = read('js/modules/panel.js');
const q = js.slice(js.indexOf('function myQueue()'), js.indexOf('(function initMobHome()'));

test('kuyruk: üzerimde + departmanımda sırada; gecikenler önce', () => {
  assert.match(q, /const mine = open\.filter\(isMineRecord\)\.sort\(queueSort\);/);
  assert.match(q, /\(r\.status \|\| 'Following'\) === 'Following' && !isMineRecord\(r\)\s*&& deptOf\(r\.department\) && sameDept\(myDept, r\.department\) && canTakeRecord\(r\)/);
  assert.match(js, /const rank = \(s\) => \(s\.state === 'breached' \? 0 : \(s\.state === 'soon' \? 1 : 2\)\);/);
});

test('düğmeler korumalı iş akışından geçer; yetkisizde düğme yok', () => {
  assert.match(q, /if \(st === 'Following' && canTakeRecord\(r\)\) btn = /);
  assert.match(q, /else if \(st === 'InProgress' && canCompleteRecord\(r\)\) btn = /);
  assert.match(q, /if \(rec\) quickTransition\(rec, b\.dataset\.mq, b\);/);
});

test('kuyruk her iki ekranda: mobil ana menü + masaüstü sağ sütun', () => {
  const html = read('panel.html');
  assert.match(html, /<div class="mq-wrap" id="mhQueue"><\/div>/);
  assert.match(html, /<div class="cz-card mq-card" id="giMyQueue"><\/div>/);
  assert.ok(html.indexOf('id="mhQueue"') < html.indexOf('class="mh-grid"'), 'mobilde menünün üstünde');
  assert.match(js, /renderMyQueue\(\);\n    \}/); // syncMobHome her güncellemede çağırır
});

test('rol bazlı açılış: personel Kayıtlar, yönetici Panel', () => {
  const shell = read('js/core/app-shell.js');
  assert.match(shell, /function isManagerRole\(\) \{ return ROLE === 'admin' \|\| ROLE === 'manager'/);
  assert.match(shell, /if \(\(isMobileShell\(\) \|\| !isManagerRole\(\)\) && moduleOn\('guestIssues'\)\) return 'kayitlar';/);
});
