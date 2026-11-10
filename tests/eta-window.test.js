/* Tahmini teslim (EDT) penceresi — misafir QR takip ekranının çekirdeği.
 *
 * Admin ürün süresini artık DAKİKA olarak giriyor (etaMin/etaMax); eski
 * kayıtlarda süre serbest metindi ('15-30 dk'), bu yüzden okunurken
 * ayrıştırılıyor — admin hiçbir kayda dokunmadan da EDT çalışmalı.
 *
 * Pencere, sonuna 2 dk kala bir sonraki kademeye KAYAR: 14:00–14:10
 * penceresinde saat 14:08'i geçince 14:10–14:15 olur ve gecikme sürdükçe
 * kademe kademe ilerler. Hesap tamamen istemcide, hiçbir yazım yok — bu
 * yüzden kural burada saf mantık olarak kilitlenebiliyor.
 *
 * Blok KAYNAKTAN okunup değerlendirilir (kopyası değil): guest-order.js bir
 * tarayıcı script'i, module.exports taşımıyor. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'guest-order.js'), 'utf8');
const start = src.indexOf('    const EDT_SLIDE_GRACE_MS');
const endMarker = '    function fmtWindow(w)';
const end = src.indexOf('\n', src.indexOf(endMarker)) + 1;
assert.ok(start > -1 && end > start, 'guest-order.js EDT bloğu bulunamadı');
const block = src.slice(start, end);

// clock(): blok dışında tanımlı — testte HH:MM üreten eşdeğeri enjekte edilir.
const api = new Function('clock', `
    ${block}
    return { parseEtaText: parseEtaText, etaMinutes: etaMinutes, slideWindow: slideWindow,
             etaWindow: etaWindow, fmtWindow: fmtWindow, scheduledAt: scheduledAt, itemWindow: itemWindow };
`)((ms) => {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
});

const at = (h, m) => new Date(2026, 0, 15, h, m, 0, 0).getTime();

// ── Eski serbest metnin ayrıştırılması ──
test('eski süre metinleri dakikaya çevrilir', () => {
    assert.deepEqual(api.parseEtaText('15-30 dk'), { min: 15, max: 30 });
    assert.deepEqual(api.parseEtaText('30 dk'), { min: 30, max: 30 });
    assert.deepEqual(api.parseEtaText('30-15 dk'), { min: 15, max: 30 }); // ters yazım düzeltilir
    assert.equal(api.parseEtaText('—'), null);
    assert.equal(api.parseEtaText(''), null);
    assert.equal(api.parseEtaText(null), null);
});

test('etaMinutes yeni alanları eski metne TERCİH eder', () => {
    assert.deepEqual(api.etaMinutes({ etaMin: 10, etaMax: 20, eta: '99 dk' }), { min: 10, max: 20 });
    // Yalnızca etaMin girilmişse pencere tek noktaya iner.
    assert.deepEqual(api.etaMinutes({ etaMin: 10 }), { min: 10, max: 10 });
    // Yeni alan yoksa eski metne düşer — göç gerektirmeyen davranış.
    assert.deepEqual(api.etaMinutes({ eta: '15-30 dk' }), { min: 15, max: 30 });
    assert.equal(api.etaMinutes({}), null);
});

// ── Pencere ve kademeli ilerleme ──
test('13:45te verilen 15–25 dk talebi 14:00 – 14:10 gösterir', () => {
    const w = api.etaWindow(at(13, 45), { etaMin: 15, etaMax: 25 }, at(13, 46));
    assert.equal(api.fmtWindow(w), '14:00 – 14:10');
});

test('pencere sonuna 2 dk kala BİR sonraki kademeye kayar', () => {
    // Kullanıcının verdiği örnek: 14:00–14:10 penceresinde 14:08'i geçince
    // 14:10–14:15 olmalı.
    const w = api.etaWindow(at(13, 45), { etaMin: 15, etaMax: 25 }, at(14, 8));
    assert.equal(api.fmtWindow(w), '14:10 – 14:15');
});

test('gecikme sürdükçe KADEME KADEME ilerler (tek adım değil)', () => {
    const base = at(13, 45), item = { etaMin: 15, etaMax: 25 };
    assert.equal(api.fmtWindow(api.etaWindow(base, item, at(14, 14))), '14:15 – 14:20');
    assert.equal(api.fmtWindow(api.etaWindow(base, item, at(14, 19))), '14:20 – 14:25');
    assert.equal(api.fmtWindow(api.etaWindow(base, item, at(15, 0))), '15:00 – 15:05');
});

test('pencere içindeyken (henüz sona yaklaşmamışken) kaymaz', () => {
    assert.equal(api.fmtWindow(api.etaWindow(at(13, 45), { etaMin: 15, etaMax: 25 }, at(14, 5))), '14:00 – 14:10');
});

test('kayan pencere HER ZAMAN ileriyi gösterir (geçmiş saat asla yazılmaz)', () => {
    // Asıl amaç bu: misafire çoktan geçmiş bir saat söylenmemeli.
    const base = at(13, 45), item = { etaMin: 15, etaMax: 25 };
    [at(14, 0), at(14, 9), at(14, 30), at(16, 0)].forEach(now => {
        const w = api.etaWindow(base, item, now);
        assert.ok(w.end > now, 'pencere sonu şimdiden sonra olmalı: ' + api.fmtWindow(w));
    });
});

test('süresi olmayan kalem ya da base yoksa pencere üretilmez', () => {
    assert.equal(api.etaWindow(at(13, 45), { eta: '—' }, at(13, 46)), null);
    assert.equal(api.etaWindow(0, { etaMin: 15, etaMax: 25 }, at(13, 46)), null);
});

test('slideWindow bozuk girdide sonsuz döngüye girmez', () => {
    // guard olmadan base=1970 gibi bir değer tarayıcıyı kilitlerdi.
    const w = api.slideWindow(0, 60000, Date.now());
    assert.ok(isFinite(w.start) && isFinite(w.end));
});

// ── Planlı kalemler (tercih edilen saat / transfer tarihi) ──
// Önceden EDT her zaman siparişin verildiği andan hesaplanıyordu: yarın
// 10:00'a istenen transfer bugün "14:15 – 14:30" gösteriyor ve 5'er dk
// kayarak sürekli gecikiyormuş gibi görünüyordu.
test('tercih edilen saat hazırlık süresinden sonraysa pencere O SAATTEN başlar', () => {
    const it = { etaMin: 30, etaMax: 45, preferredTime: '15:00' };
    const w = api.itemWindow(at(11, 0), it, at(11, 1));
    assert.equal(w.scheduled, true);
    assert.equal(api.fmtWindow(w), '15:00 – 15:15');
    // Saatler geçse de planlı saate kadar KAYMAZ.
    assert.equal(api.fmtWindow(api.itemWindow(at(11, 0), it, at(14, 50))), '15:00 – 15:15');
});

test('tercih edilen saat hazırlıktan önceyse normal EDT geçerli', () => {
    const it = { etaMin: 30, etaMax: 45, preferredTime: '11:10' };
    const w = api.itemWindow(at(11, 0), it, at(11, 1));
    assert.ok(!w.scheduled);
    assert.equal(api.fmtWindow(w), '11:30 – 11:45');
});

test('gece verilen "09:00" ertesi sabahı kasteder (tarihli gösterilir)', () => {
    const it = { etaMin: 15, etaMax: 20, preferredTime: '09:00' };
    const base = at(23, 0);
    assert.equal(api.scheduledAt(base, it), new Date(2026, 0, 16, 9, 0, 0, 0).getTime());
    assert.equal(api.fmtWindow(api.itemWindow(base, it, at(23, 1))), '16.01 09:00 – 09:05');
});

test('transfer tarih+saatinden başlar; süre tanımsız olsa da pencere üretilir', () => {
    const it = { transferDate: '2026-01-16', transferTime: '10:00' };
    const w = api.itemWindow(at(14, 0), it, at(14, 1));
    assert.equal(w.scheduled, true);
    assert.equal(api.fmtWindow(w), '16.01 10:00 – 10:05');
    // Ertesi gün görüntülenince tarih öneki düşer.
    const next = api.itemWindow(at(14, 0), it, new Date(2026, 0, 16, 8, 0).getTime());
    assert.equal(api.fmtWindow(next), '10:00 – 10:05');
});

test('planı olmayan kalem eski davranışla aynı', () => {
    const it = { etaMin: 15, etaMax: 25 };
    assert.equal(api.scheduledAt(at(13, 45), it), 0);
    assert.equal(api.fmtWindow(api.itemWindow(at(13, 45), it, at(13, 46))), '14:00 – 14:10');
});
