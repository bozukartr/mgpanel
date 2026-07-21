/* reports.js'e QR Değerlendirme özelliğiyle birlikte eklenen Haftalık/Aylık/
 * Yıllık gruplama anahtarı üreticileri — saf mantık, emülatörsüz. reports.js
 * bir IIFE'dir (module.exports yok), bu yüzden bu 3 saf fonksiyon burada
 * birebir kopyalanır (dosyaya yeni bir export yüzeyi eklemeye zorlamadan). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function isoWeekKey(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day + 3);
    const firstThu = new Date(d.getFullYear(), 0, 4);
    const wk = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
    return d.getFullYear() + '-W' + pad(wk);
}
function monthKey(dateStr) { return dateStr.slice(0, 7); }
function yearKey(dateStr) { return dateStr.slice(0, 4); }

test('monthKey: YYYY-MM dilimini doğru çıkarır', () => {
    assert.equal(monthKey('2026-07-19'), '2026-07');
    assert.equal(monthKey('2026-01-05'), '2026-01');
});

test('yearKey: YYYY dilimini doğru çıkarır', () => {
    assert.equal(yearKey('2026-07-19'), '2026');
    assert.equal(yearKey('2025-12-31'), '2025');
});

test('isoWeekKey: yıl ortasında sıradan bir tarih', () => {
    // 2026-07-19 bir Pazar — ISO haftası Pazartesi 2026-07-13'ten başlar.
    assert.equal(isoWeekKey('2026-07-19'), '2026-W29');
});

test('isoWeekKey: yıl başı bir önceki yılın son haftasına düşebilir', () => {
    // 2027-01-01 bir Cuma — ISO 8601'e göre 2026 yılının 53. haftasına aittir.
    assert.equal(isoWeekKey('2027-01-01'), '2026-W53');
});

test('isoWeekKey: yıl sonu ertesi yılın 1. haftasına düşebilir', () => {
    // 2025-12-29 bir Pazartesi — 2026'nın 1. haftasının ilk günü.
    assert.equal(isoWeekKey('2025-12-29'), '2026-W01');
});

test('isoWeekKey: artık yıl Şubat 29 doğru hesaplanır', () => {
    // 2024-02-29 bir Perşembe — 2024 yılının 9. haftası.
    assert.equal(isoWeekKey('2024-02-29'), '2024-W09');
});

test('isoWeekKey: aynı haftanın farklı günleri AYNI anahtarı üretir', () => {
    const mon = isoWeekKey('2026-07-13'), sun = isoWeekKey('2026-07-19');
    assert.equal(mon, sun);
});
