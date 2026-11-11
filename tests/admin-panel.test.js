/* Ayarlar paneli (admin.html) — yeniden tasarım korkulukları.
 *
 * Sayfa baştan yazıldı (yeni bilgi mimarisi, yeni tasarım sistemi); asıl
 * mantık ise beş ayrı JS modülünde duruyor ve öğeleri ID ile buluyor. Bir ID
 * HTML'den düşerse ilgili özellik SESSİZCE ölür (çoğu çağrı `if (el)` ile
 * korunuyor). Bu test:
 *  · modüllerin aradığı her ID'nin sayfada bulunduğunu,
 *  · her menü öğesinin bir görünümü ve başlığı olduğunu (#users gibi derin
 *    bağlantılar dahil),
 *  · sayfanın emoji ikon ve panel.css'e bağımlı olmadığını doğrular.
 * Saf mantık — kaynak dosyalar okunur. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const html = read('admin.html');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// JS tarafından ÇALIŞMA ANINDA oluşturulan öğeler (HTML'de olmaları beklenmez).
const DYNAMIC = new Set(['cat-admin-styles', 'iss-admin-styles', 'menus-admin-styles', 'subIbanBtn']);

test('modüllerin ID ile aradığı her öğe sayfada var', () => {
    const files = ['js/modules/admin.js', 'js/modules/request-catalog.js', 'js/modules/issue-config-admin.js',
        'js/modules/menus-admin.js', 'js/modules/notify-config-admin.js'];
    const missing = [];
    for (const f of files) {
        const src = read(f);
        const wanted = new Set([
            ...[...src.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]),
            ...[...src.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1])
        ]);
        for (const id of wanted) if (!ids.has(id) && !DYNAMIC.has(id)) missing.push(f + ' → #' + id);
    }
    assert.deepEqual(missing, []);
});

test('her menü öğesinin görünümü ve başlığı var; özet kartları geçerli görünümlere gider', () => {
    const views = [...html.matchAll(/class="sb-link[^"]*" data-view="([\w-]+)"/g)].map((m) => m[1]);
    assert.ok(views.length >= 10, 'menü öğesi sayısı: ' + views.length);
    const titlesBlock = html.slice(html.indexOf('var TITLES = {'), html.indexOf('};', html.indexOf('var TITLES = {')));
    for (const v of views) {
        assert.ok(ids.has('view-' + v), 'görünüm yok: view-' + v);
        assert.match(titlesBlock, new RegExp('\\b' + v + ':\\s*\\['), 'başlık yok: ' + v);
    }
    for (const m of html.matchAll(/data-goto="([\w-]+)"/g)) assert.ok(views.includes(m[1]), 'geçersiz hedef: ' + m[1]);
    // Bildirimlerden gelen derin bağlantı (functions/index.js, realtime.js: admin#users)
    assert.ok(views.includes('users'));
});

test('misafir modülü kapalıysa misafir deneyimi görünümlerinin hepsi kalkar', () => {
    const src = read('js/modules/request-catalog.js');
    const gate = src.slice(src.indexOf("!moduleEnabled('guestOrders')"), src.indexOf('injectStyles();', src.indexOf("!moduleEnabled('guestOrders')")));
    for (const v of ['catalog', 'guestpage', 'menusqr']) assert.match(gate, new RegExp("'" + v + "'"));
    assert.match(html, /class="sb-group" data-group="guest"/);
});

test('sayfa emoji ikon kullanmıyor ve panel.css\'e bağımlı değil', () => {
    const body = html.replace(/placeholder="[^"]*"/g, ''); // ikon ipucu alanının örnek emojisi hariç
    assert.doesNotMatch(body, /[\u{1F300}-\u{1FAFF}☀-➿]/u);
    assert.doesNotMatch(html, /css\/modules\/panel\.css/);
    assert.match(html, /js\/core\/ui-icons\.js/);
    assert.match(html, /js\/core\/service-icons\.js/);
});

test('eski JS-enjekte stiller kaldırıldı; tek kaynak admin.css', () => {
    for (const f of ['js/modules/request-catalog.js', 'js/modules/issue-config-admin.js', 'js/modules/menus-admin.js']) {
        assert.match(read(f), /function injectStyles\(\) \{\}/, f);
    }
    const css = read('css/modules/admin.css');
    for (const sel of ['.cat-row', '.iss-card', '.menu-row', '.ov-card', '.toast-notification']) {
        assert.ok(css.indexOf(sel) !== -1, 'admin.css içinde yok: ' + sel);
    }
});
