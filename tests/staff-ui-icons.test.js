/* Personel ekranları (Panel, Concierge, Misafir Kayıtları, CRM) — ikon seti
 * korkulukları.
 *
 * Emoji ikonlar js/core/ui-icons.js'teki tek tip SVG setiyle değiştirildi.
 * Bu test, HTML'deki `data-ic="…"` ve JS'teki `ic('…')` / `UIcon('…')` /
 * `crmIc('…')` çağrılarında geçen her adın sette TANIMLI olduğunu ve ikon
 * kullanan her sayfanın ui-icons.js'i yüklediğini doğrular. Tanımsız bir ad
 * sessizce boş ikon üretirdi.
 *
 * Saf mantık — kaynak dosyalar okunur, ui-icons.js küçük bir sahte DOM'da
 * çalıştırılır. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadIcons() {
    const win = {};
    const doc = {
        readyState: 'complete',
        head: { appendChild() {} },
        getElementById() { return null; },
        createElement() { return { set textContent(_) {}, setAttribute() {} }; },
        querySelectorAll() { return []; },
        addEventListener() {},
    };
    win.document = doc;
    vm.runInNewContext(read('js/core/ui-icons.js'), { window: win, document: doc });
    return win.UIcon;
}

const PAGES = ['panel.html', 'concierge.html', 'crm.html', 'dashboard.html'];
const SCRIPTS = ['js/modules/panel.js', 'js/modules/concierge.js', 'js/modules/crm.js', 'js/modules/dashboard.js'];

test('ui-icons: UIcon dekoratif SVG üretir, bilinmeyen ad yedek ikona düşer', () => {
    const UIcon = loadIcons();
    assert.equal(typeof UIcon, 'function');
    assert.match(UIcon('wrench'), /^<span class="ui-ic" aria-hidden="true"><svg [^>]*viewBox="0 0 24 24"/);
    assert.equal(UIcon.has('wrench'), true);
    assert.equal(UIcon.has('yok-boyle-bir-ikon'), false);
    assert.equal(UIcon('yok-boyle-bir-ikon'), UIcon('sparkles'));
});

test('ui-icons: sayfalarda ve modüllerde kullanılan her ikon adı sette var', () => {
    const UIcon = loadIcons();
    const used = new Map();
    const add = (name, where) => { if (!used.has(name)) used.set(name, where); };
    for (const p of PAGES) {
        for (const m of read(p).matchAll(/data-ic="([a-z-]+)"/g)) add(m[1], p);
    }
    for (const s of SCRIPTS) {
        for (const m of read(s).matchAll(/\b(?:ic|UIcon|crmIc)\('([a-z-]+)'/g)) add(m[1], s);
    }
    assert.ok(used.size > 10, 'beklenenden az ikon kullanımı bulundu: ' + used.size);
    const missing = [...used].filter(([n]) => !UIcon.has(n)).map(([n, w]) => `${n} (${w})`);
    assert.deepEqual(missing, [], 'tanımsız ikon adları');
});

test('ui-icons: data-ic kullanan her sayfa ui-icons.js yükler', () => {
    for (const p of PAGES) {
        const html = read(p);
        if (!/data-ic="/.test(html)) continue;
        assert.match(html, /<script src="js\/core\/ui-icons\.js(\?[^"]*)?"><\/script>/, p + ' ui-icons.js yüklemiyor');
    }
});

test('personel ekranları: arayüz metninde İngilizce kalıntı yok', () => {
    const conc = read('js/modules/concierge.js');
    // Personel kartı/detayı Türkçe: "Room ", "No notes.", "Pax" yerine Türkçe karşılıkları.
    assert.doesNotMatch(conc, /'No notes\.'/);
    assert.match(conc, /Not yok\./);
    const panel = read('js/modules/panel.js');
    assert.match(panel, /Henüz not yok/);
});
