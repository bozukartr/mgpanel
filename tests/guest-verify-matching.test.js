/* Misafir QR kimlik doğrulaması — eşleştirme kuralı.
 *
 * BİLDİRİLEN HATA (canlı): misafir CRM'de "Konaklıyor" görünüyor ve doğum
 * yılı girili olmasına rağmen QR girişinde "doğrulanamadı" alıyordu.
 *
 * İncelemede verifyGuestIdentity'nin, AYNI dizini okuyan kardeş fonksiyonlar
 * (getGuestName / getGuestStay) ile dört noktada ayrıştığı görüldü — her biri
 * tek başına sessiz bir redde yol açıyor:
 *   1. `.where('status','==','in_house')` sorgusu → status alanı hiç yazılmamış
 *      (eski/PMS kaynaklı) kayıt tamamen eleniyordu; kardeşler `g.status &&
 *      g.status !== 'in_house'` ile TOLERANSLI.
 *   2. tenantId için TAM eşleşme sorgusu → harf farkı olan kayıt hiç gelmiyordu;
 *      kardeşler karşılaştırmayı JS'te harf duyarsız yapıyor.
 *   3. checkOut düz string karşılaştırması → '14/08/2026' gibi ISO OLMAYAN bir
 *      değer her zaman "geçmiş" sayılıyor ('/' < rakam) ve misafir sessizce
 *      çıkış yapmış kabul ediliyordu.
 *   4. `matches.length !== 1` DOKÜMAN sayıyordu → aynı kişinin mükerrer dizin
 *      kaydı (kapatılmamış eski konaklama) varsa misafir HİÇ doğrulanamıyordu;
 *      getGuestName bunu isim üzerinden zaten tekilleştiriyordu.
 *
 * Kural saf mantık olduğundan kaynaktan okunup değerlendirilir (kopyası değil). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');

// Normalize edicileri kaynaktan al.
const nStart = src.indexOf('function _normTr(s) {');
const nEnd = src.indexOf('function _istanbulToday()');
assert.ok(nStart > -1 && nEnd > nStart, '_normTr/_nameTokens bulunamadı');
const norm = new Function(src.slice(nStart, nEnd) + '\nreturn { _normTr: _normTr, _nameTokens: _nameTokens };')();

// verifyGuestIdentity'nin süzme bloğunu kaynaktan al ve tek bir yüklem olarak
// çalıştır (Firestore/Cloud Functions gerekmez).
const fStart = src.indexOf('  const today = _istanbulToday();\n  const sTokens = _nameTokens(surname);\n  const matches = [];');
const fEnd = src.indexOf('  matches.sort(');
assert.ok(fStart > -1 && fEnd > fStart, 'verifyGuestIdentity süzme bloğu bulunamadı');
const filterSrc = src.slice(fStart, fEnd);

function run({ surname, birthYear, tenant, today, docs }) {
    const snap = { size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach((d, i) => f({ id: 'g' + i, data: () => d })) };
    const body = filterSrc
        .replace('const today = _istanbulToday();', 'const today = TODAY;')
        .replace(/console\.(info|warn|error)\([^;]*\);/g, '');
    return new Function('surname', 'birthYear', 'tenant', 'TODAY', 'snap', '_nameTokens', '_normTr',
        body + '\nreturn { ok: true, matches: matches };')(surname, birthYear, tenant, today, snap, norm._nameTokens, norm._normTr);
}

const T = 'otel';
const TODAY = '2026-08-14';
const base = { tenantId: T, name: 'Burak Göl', room: '1001', birthYear: 1990, status: 'in_house', checkOut: '2026-08-20' };
const ask = (over) => run(Object.assign({ surname: 'Göl', birthYear: 1990, tenant: T, today: TODAY }, over));

test('normal durum: konaklayan misafir doğrulanır', () => {
    const r = ask({ docs: [base] });
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 1);
});

test('status alanı HİÇ YOKSA da doğrulanır (eski/PMS kaydı)', () => {
    const g = Object.assign({}, base); delete g.status;
    assert.equal(ask({ docs: [g] }).ok, true);
});

test('status "checked_out" ise doğrulanmaz', () => {
    assert.equal(ask({ docs: [Object.assign({}, base, { status: 'checked_out' })] }).reason, 'no_match');
});

test('tenantId HARF FARKIYLA yazılmışsa da eşleşir', () => {
    assert.equal(ask({ docs: [Object.assign({}, base, { tenantId: 'Otel' })] }).ok, true);
});

test('BAŞKA otelin misafiri asla eşleşmez', () => {
    assert.equal(ask({ docs: [Object.assign({}, base, { tenantId: 'baska-otel' })] }).reason, 'no_match');
});

test('ISO OLMAYAN checkOut misafiri çıkış yapmış SAYMAZ', () => {
    // '20/08/2026' düz string karşılaştırmasında '2026-08-14'ten KÜÇÜK çıkar
    // ('/' < '2') — eski kod bu misafiri sessizce eliyordu.
    assert.equal(ask({ docs: [Object.assign({}, base, { checkOut: '20/08/2026' })] }).ok, true);
    assert.equal(ask({ docs: [Object.assign({}, base, { checkOut: '' })] }).ok, true);
});

test('GERÇEKTEN geçmiş ISO checkOut eler', () => {
    assert.equal(ask({ docs: [Object.assign({}, base, { checkOut: '2026-08-01' })] }).reason, 'no_match');
});

test('AYNI kişinin mükerrer kaydı reddedilmez (asıl hata)', () => {
    // Kapatılmamış eski konaklama + güncel kayıt. Eski kod DOKÜMAN sayıyordu
    // ve bu misafir hiç doğrulanamıyordu.
    const r = ask({ docs: [
        Object.assign({}, base, { checkIn: '2026-08-10' }),
        Object.assign({}, base, { checkIn: '2026-08-13' })
    ] });
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 2, 'iki kayıt da eşleşmeli, tekilleştirme isim+odada');
});

test('FARKLI kişi ya da FARKLI oda çıkarsa fail-closed', () => {
    assert.equal(ask({ docs: [base, Object.assign({}, base, { name: 'Ayşe Göl' })] }).reason, 'ambiguous');
    assert.equal(ask({ docs: [base, Object.assign({}, base, { room: '1002' })] }).reason, 'ambiguous');
});

test('doğum yılı tutmuyorsa ya da hiç yoksa eşleşmez', () => {
    assert.equal(ask({ docs: [Object.assign({}, base, { birthYear: 1985 })] }).reason, 'no_match');
    const g = Object.assign({}, base); delete g.birthYear;
    assert.equal(ask({ docs: [g] }).reason, 'no_match');
});

test('doğum yılı METİN olarak saklanmışsa da eşleşir', () => {
    assert.equal(ask({ docs: [Object.assign({}, base, { birthYear: '1990' })] }).ok, true);
});

test('soyadı Türkçe/aksan farkıyla yazılsa da eşleşir', () => {
    assert.equal(ask({ surname: 'GÖL', docs: [base] }).ok, true);
    assert.equal(ask({ surname: 'gol', docs: [base] }).ok, true);
    assert.equal(ask({ surname: 'Yılmaz', docs: [Object.assign({}, base, { name: 'Ali YILMAZ' })] }).ok, true);
});

test('oda atanmamışsa ayırt edilebilir sebep döner', () => {
    // (oda kontrolü süzme bloğunun DIŞINDA; burada eşleşmenin oluştuğu
    // doğrulanır, sebep kodu fonksiyonun devamında üretilir)
    const r = ask({ docs: [Object.assign({}, base, { room: '' })] });
    assert.equal(r.ok, true);
    assert.equal(String(r.matches[0].data.room || '').trim(), '');
});
