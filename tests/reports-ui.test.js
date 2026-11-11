/* Raporlar ekranı — yeniden düzenleme korkulukları (saf mantık, kaynaktan).
 *
 *  · Modülün ID ile aradığı her öğe reports.html'de var.
 *  · Her rapor türünün menü/özet/grafik tanımı var; menü hepsini kapsar ve
 *    kapalı modüllerin raporları gizlenebilir (module alanı).
 *  · Durum eşlemeleri eksiksiz: Concierge "Tamamlandı" (Done) ve QR
 *    "confirmed"/"in_progress" artık ham İngilizce ya da "Bekliyor" görünmez.
 *  · Talep/şikayet tablosunda Durum ve Süre ilk sütunlar arasında (eskiden
 *    en sondaydı, ekranın dışında kalıyordu).
 *  · Gruplama seçenekleri hatalı Türkçe ek üretmez ("Departmane göre"). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const js = read('js/modules/reports.js');
const html = read('reports.html');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
function slice(a, b) { const i = js.indexOf(a), j = js.indexOf(b, i + a.length); assert.ok(i > -1 && j > i, 'blok yok: ' + a); return js.slice(i, j); }

test('modülün aradığı her öğe sayfada var', () => {
    const wanted = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
    // Çalışma anında oluşturulanlar: filtre çiplerindeki "Tümünü temizle" ve trend kutusu.
    const DYNAMIC = new Set(['repClearAll', 'repTrendBox']);
    for (const id of DYNAMIC) assert.ok(js.indexOf('id="' + id + '"') !== -1, id + ' artık oluşturulmuyor');
    const missing = [...wanted].filter((id) => !ids.has(id) && !DYNAMIC.has(id));
    assert.deepEqual(missing, []);
    assert.ok(wanted.size > 20);
});

test('her rapor türünün menü/özet/grafik tanımı var ve menü hepsini kapsar', () => {
    const order = JSON.parse(slice("const DOMAIN_ORDER = ", ';').replace('const DOMAIN_ORDER = ', '').replace(/'/g, '"'));
    const nav = JSON.parse(slice("const NAV_ORDER = ", ';').replace('const NAV_ORDER = ', '').replace(/'/g, '"'));
    assert.deepEqual([...nav].sort(), [...order].sort(), 'menü tüm raporları içermeli');
    const meta = slice('const META = {', '\n    const domainOn');
    for (const k of order) {
        const block = meta.slice(meta.indexOf('        ' + k + ': {'));
        assert.ok(meta.indexOf('        ' + k + ': {') !== -1, 'META eksik: ' + k);
        for (const field of ['nav:', 'group:', 'icon:', 'module:', 'title:', 'trend:']) {
            assert.ok(block.slice(0, 1600).indexOf(field) !== -1, k + ' → ' + field);
        }
    }
    assert.match(js, /function domainOn|const domainOn = k => !META\[k\]\.module \|\| typeof moduleEnabled !== 'function' \|\| moduleEnabled\(META\[k\]\.module\)/);
});

test('durum eşlemeleri eksiksiz (Done, confirmed, in_progress)', () => {
    const res = slice('const RES_STATUS = ', ';');
    assert.match(res, /Done: 'Tamamlandı'/);
    const ord = slice('const ORD_STATUS = ', ';');
    for (const k of ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled']) assert.match(ord, new RegExp(k + ': \''));
});

test('talep/şikayet tablosunda Durum ve Süre ilk altı sütunda', () => {
    const cols = slice("        guestLogs: {", "        reservations: {");
    const labels = [...cols.slice(cols.indexOf('columns: [')).matchAll(/\{ label: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(labels.indexOf('Durum') > -1 && labels.indexOf('Durum') < 6, labels.join(','));
    assert.ok(labels.indexOf('Süre') > -1 && labels.indexOf('Süre') < 6, labels.join(','));
});

test('gruplama seçenekleri hatalı ek üretmiyor; eski seçim kutusu kaldırıldı', () => {
    assert.doesNotMatch(js, /\}e göre<\/option>/);
    assert.doesNotMatch(html, /id="repDomain"|id="repDatePreset"/);
    for (const p of ['today', 'yesterday', '7', '30', 'thismonth', 'lastmonth', 'all', 'custom']) {
        assert.match(html, new RegExp('data-preset="' + p + '"'));
    }
});
