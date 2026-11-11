/* Misafir "Konaklamam" ekstresi — functions/guest-stay.js (saf, emülatörsüz).
 *
 * getGuestStay misafire oda hesabını ADİSYON ayrıntısıyla, rezervasyonları
 * onay no / tutar / ön ödeme / kalanla döndürür. Asıl risk SIZINTI: personel
 * notları, ödeme kayıtları, personel adları misafire gitmemeli; başka otelin
 * adisyonu/rezervasyonu ayrıntı olarak eklenmemeli. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gs = require('../functions/guest-stay');

const ts = (ms) => ({ toMillis: () => ms });

const CHECK = {
    tenantId: 'otel', checkNo: 128, tableName: 'Masa 12',
    items: [
        { name: 'Izgara Köfte', qty: 2, unitPrice: 240, note: 'az pişmiş' },
        { name: 'Ayran', qty: 2, unitPrice: 40 },
        { name: 'Künefe', qty: 1, unitPrice: 180, ikram: true }
    ],
    subtotal: 466.67, vat: 93.33, total: 560, payable: 504,
    discount: { type: 'percent', value: 10, reason: 'sadakat', amount: 56 },
    payments: [{ method: 'room', amount: 504, by: 'garson.ali' }],
    closedBy: 'garson.ali', closedAt: ts(1700000000000)
};
const RES = {
    tenantId: 'otel', type: 'Transfer', date: '2026-07-04', time: '11:00', status: 'Confirmed',
    from: 'Otel', to: 'Havalimanı', vehicle: 'TK 1234', pax: '2', voucherNo: 'VX-88',
    totalPrice: 150, deposit: 50, currency: 'EUR', notes: 'DAHİLİ: misafir zor, dikkat', folioApplied: true, folioAmount: 100,
    guestName: 'Ayşe Yılmaz', createdBy: 'concierge.mehmet'
};

test('adisyon özeti: kalemler, ikram 0, indirim, ödenecek toplam', () => {
    const s = gs.checkSummary(CHECK);
    assert.equal(s.checkNo, '128');
    assert.equal(s.tableName, 'Masa 12');
    assert.deepEqual(s.lines, [
        { name: 'Izgara Köfte', qty: 2, amount: 480, ikram: false },
        { name: 'Ayran', qty: 2, amount: 80, ikram: false },
        { name: 'Künefe', qty: 1, amount: 0, ikram: true }
    ]);
    assert.equal(s.discount, 56);
    assert.equal(s.total, 504);        // payable (indirim sonrası) tercih edilir
    assert.equal(s.vat, 93.33);
    assert.equal(s.closedAt, 1700000000000);
});

test('adisyon özeti personel/ödeme ayrıntısı SIZDIRMAZ', () => {
    const json = JSON.stringify(gs.checkSummary(CHECK));
    assert.doesNotMatch(json, /garson|payments|closedBy|az pişmiş/);
});

test('çok kalemli adisyon kırpılır, kalan sayı bildirilir', () => {
    const big = Object.assign({}, CHECK, { items: Array.from({ length: 55 }, (_, i) => ({ name: 'K' + i, qty: 1, unitPrice: 1 })) });
    const s = gs.checkSummary(big);
    assert.equal(s.lines.length, 40);
    assert.equal(s.moreLines, 15);
});

test('rezervasyon görünümü: onay no, tutar, ön ödeme, kalan, oda hesabı', () => {
    const v = gs.reservationView(RES);
    assert.equal(v.voucherNo, 'VX-88');
    assert.equal(v.total, 150);
    assert.equal(v.deposit, 50);
    assert.equal(v.balance, 100);
    assert.equal(v.folioApplied, true);
    assert.equal(v.folioAmount, 100);
    assert.equal(v.currency, 'EUR');
    assert.equal(v.status, 'Confirmed');
});

test('rezervasyon görünümü personel notunu ve personel adını SIZDIRMAZ', () => {
    const v = gs.reservationView(RES);
    assert.equal(v.notes, undefined);
    assert.doesNotMatch(JSON.stringify(v), /DAHİLİ|mehmet|guestName/);
});

test('kalan bakiye negatif olmaz; eksik alanlar güvenli varsayılan', () => {
    assert.equal(gs.reservationView({ totalPrice: 50, deposit: 80 }).balance, 0);
    const v = gs.reservationView({});
    assert.equal(v.status, 'Pending');
    assert.equal(v.currency, 'EUR');
    assert.equal(v.total, 0);
});

test('oda hesabı satırı adisyon / rezervasyon ile zenginleşir', () => {
    const rest = gs.folioItemView({ source: 'restaurant', checkId: 'c1', amount: 504, tableName: 'Masa 12', createdAt: ts(5) }, 'otel', { c1: CHECK }, {});
    assert.equal(rest.amount, 504);
    assert.equal(rest.createdAt, 5);
    assert.equal(rest.check.checkNo, '128');
    const con = gs.folioItemView({ source: 'concierge', reservationId: 'r1', amount: 100 }, 'otel', {}, { r1: RES });
    assert.deepEqual(con.res, { type: 'Transfer', date: '2026-07-04', time: '11:00', resName: '', from: 'Otel', to: 'Havalimanı', otherType: '', vessel: '' });
});

test('başka otelin adisyonu/rezervasyonu ayrıntı olarak EKLENMEZ (fail-closed)', () => {
    const foreignCheck = Object.assign({}, CHECK, { tenantId: 'baska' });
    const r = gs.folioItemView({ source: 'restaurant', checkId: 'c1', amount: 10 }, 'otel', { c1: foreignCheck }, {});
    assert.equal(r.check, undefined);
    const foreignRes = Object.assign({}, RES, { tenantId: 'baska' });
    const c = gs.folioItemView({ source: 'concierge', reservationId: 'r1', amount: 10 }, 'otel', {}, { r1: foreignRes });
    assert.equal(c.res, undefined);
});

test('bağlı kimlikler benzersiz ve sınırlı', () => {
    const charges = [
        { source: 'restaurant', checkId: 'a' }, { source: 'restaurant', checkId: 'a' },
        { source: 'restaurant', checkId: 'b' }, { source: 'concierge', reservationId: 'r' }, { source: 'other' }
    ];
    assert.deepEqual(gs.linkedIds(charges, 40), { checkIds: ['a', 'b'], resIds: ['r'] });
    assert.equal(gs.linkedIds(Array.from({ length: 60 }, (_, i) => ({ source: 'restaurant', checkId: 'c' + i })), 40).checkIds.length, 40);
});
