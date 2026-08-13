/* "Talep Ekle" modalı — eksik alan TÜM modalı öldürmemeli.
 *
 * BİLDİRİLEN HATA (canlı): admin panelinde "Talep Ekle" butonu
 *   TypeError: Cannot set properties of null (setting 'value')
 *     at openModal (request-catalog.js:265)
 * ile çöküyordu; modal hiç açılmıyordu.
 *
 * KÖK NEDEN: firebase.json'da `cleanUrls: true` olduğundan sayfalar UZANTISIZ
 * adresten servis ediliyor (/admin) ve bu yol "**\/*.html" glob'una uymadığı
 * için `no-cache` başlığını HİÇ almıyordu. JS ise 10 dk önbellekli. Sonuç:
 * dağıtımdan sonra tarayıcı ESKİ HTML + YENİ JS gösterebiliyor; yeni JS'in
 * aradığı alan (catEtaMin) eski HTML'de olmadığından korumasız atama
 * patlıyordu. Başlık firebase.json'da düzeltildi; burada kodun bu duruma
 * DAYANIKLI olduğu kilitleniyor — HTML/JS sürüm kayması her dağıtımda
 * kaçınılmaz bir pencere. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'request-catalog.js'), 'utf8');

// ── Yardımcılar kaynaktan alınıp gerçek davranışı sınanır ──
const hStart = src.indexOf('    function setVal(id, v)');
const hEnd = src.indexOf('\n', src.indexOf('    function setTxt(id, v)')) + 1;
assert.ok(hStart > -1 && hEnd > hStart, 'setVal/setChk/setTxt bulunamadı');
const helpers = src.slice(hStart, hEnd);

function api(dom) {
    return new Function('$', helpers + '\nreturn { setVal: setVal, setChk: setChk, setTxt: setTxt };')(
        (id) => (Object.prototype.hasOwnProperty.call(dom, id) ? dom[id] : null));
}

test('var olan alana yazar', () => {
    const dom = { catName: { value: '' }, catActive: { checked: false }, catalogModalTitle: { textContent: '' } };
    const a = api(dom);
    a.setVal('catName', 'Havlu');
    a.setChk('catActive', true);
    a.setTxt('catalogModalTitle', 'Talep Ekle');
    assert.equal(dom.catName.value, 'Havlu');
    assert.equal(dom.catActive.checked, true);
    assert.equal(dom.catalogModalTitle.textContent, 'Talep Ekle');
});

test('OLMAYAN alanda HATA FIRLATMAZ (asıl hata buydu)', () => {
    const a = api({});
    assert.doesNotThrow(() => a.setVal('catEtaMin', '00:15'));
    assert.doesNotThrow(() => a.setChk('catSingle', true));
    assert.doesNotThrow(() => a.setTxt('catalogModalTitle', 'x'));
});

// ── openModal içinde korumasız DOM ataması kalmamalı ──
test('openModal içinde korumasız $(...).value/checked ataması YOK', () => {
    const start = src.indexOf('    function openModal(id) {');
    const end = src.indexOf('\n    function closeModal()', start);
    assert.ok(start > -1 && end > start, 'openModal gövdesi bulunamadı');
    const body = src.slice(start, end);
    const unguarded = body.split('\n').filter((l) =>
        /\$\(['"][^'"]+['"]\)\s*\.\s*(value|checked|textContent)\s*=/.test(l) && !/if \(\$\(/.test(l));
    assert.deepEqual(unguarded, [],
        'Bu satırlar eksik alanda modalı çökertir — setVal/setChk/setTxt kullanın:\n' + unguarded.join('\n'));
});

// ── Hosting başlığı: uzantısız adresler de no-cache almalı ──
test('firebase.json: uzantısız sayfa adresleri no-cache alır', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8'));
    const headers = cfg.hosting.headers || [];
    const noCache = headers.filter((h) =>
        (h.headers || []).some((x) => x.key === 'Cache-Control' && String(x.value).indexOf('no-cache') !== -1));
    assert.ok(noCache.some((h) => h.source === '**/*.html'), '.html için no-cache kuralı kayboldu');
    // cleanUrls açıkken asıl servis edilen adres UZANTISIZ olan.
    assert.equal(cfg.hosting.cleanUrls, true);
    const clean = noCache.find((h) => h.source !== '**/*.html');
    assert.ok(clean, 'uzantısız adresler için no-cache kuralı yok — eski HTML + yeni JS kayması geri döner');
    ['admin', 'panel', 'superadmin', 'guest-order', 'app'].forEach((page) => {
        assert.ok(clean.source.indexOf(page) !== -1, `"${page}" no-cache listesinde yok`);
    });
});
