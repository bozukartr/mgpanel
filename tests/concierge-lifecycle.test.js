/* QR ↔ Concierge yaşam döngüsü — denetimde bulunan operasyonel kırılmalar.
 *
 * Bu testler saf mantığı kilitler (Firestore gerekmez): tarih çözümlemesi,
 * misafir/personel not birleştirme ve sipariş-durumu rollup'ı. Her biri
 * gerçek bir operasyonel hataya karşılık gelir — regresyonu erken yakalasın
 * diye ayrı ayrı adlandırıldı. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../functions/order-bridge');

const mkOrder = (item) => ({
    tenantId: 't1', room: '101',
    items: [Object.assign({ id: 'i0', name: 'Havalimanı Transferi', qty: 1, department: 'Concierge' }, item)]
});
const resDoc = (item) => {
    const r = bridge.buildOrderReservationDocs(mkOrder(item), 'ord1', {});
    assert.equal(r.docs.length, 1, 'Concierge kalemi rezervasyon üretmeliydi');
    return r.docs[0].data;
};

// ── Tarih: misafirin seçtiği gün korunmalı ──
test('Transfer: misafirin seçtiği tarih/saat rezervasyona yazılır', () => {
    const d = resDoc({ transferDate: '2026-09-15', transferTime: '06:30', transferFrom: 'Otel', transferTo: 'Havalimanı' });
    assert.equal(d.date, '2026-09-15');
    assert.equal(d.time, '06:30');
    assert.equal(d.from, 'Otel');
    assert.equal(d.to, 'Havalimanı');
});

test('Transfer OLMAYAN Concierge kalemi de misafirin seçtiği tarihe gider', () => {
    // Eskiden koşul `isTransfer && it.transferDate` idi: restoran/spa/tur gibi
    // kalemler koşulsuz BUGÜNE düşüyor, "Cuma için masa" talebi bugünün
    // ajandasına giriyordu.
    const d = resDoc({ name: 'Restoran Rezervasyonu', transferDate: '2026-09-20', transferTime: '20:00' });
    assert.equal(d.date, '2026-09-20', 'Concierge kalemi bugüne zorlanmamalı');
    assert.equal(d.time, '20:00');
});

test('tarih verilmemişse bugüne düşer (geriye dönük uyum)', () => {
    const d = resDoc({ name: 'Restoran Rezervasyonu' });
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
});

// ── Not birleştirme: personelin notu korunmalı ──
test('misafir notu ilk kez yazılır', () => {
    const out = bridge.mergeGuestNote('', { name: 'VIP Transfer', qty: 2, note: 'Bavul var' });
    assert.match(out, /^QR misafir talebi/);
    assert.match(out, /Bavul var/);
});

test('misafir düzenlemesi PERSONELİN notunu SİLMEZ', () => {
    // Denetimde bulunan hata: reservationNotesText çıktısı `notes` alanının
    // tamamını eziyordu; misafir adet/not değiştirince personelin yazdığı
    // "Sürücü Ahmet atandı" bilgisi sessizce kayboluyordu.
    const withStaff = bridge.mergeGuestNote('', { name: 'VIP Transfer', qty: 2, note: 'Bavul var' })
        + '\nSürücü Ahmet atandı.';
    const after = bridge.mergeGuestNote(withStaff, { name: 'VIP Transfer', qty: 3, note: 'Bavul yok' });
    assert.match(after, /Sürücü Ahmet atandı\./, 'personel notu korunmalı');
    assert.match(after, /3 adet/, 'misafir güncellemesi yansımalı');
    assert.doesNotMatch(after, /Bavul var/, 'eski misafir metni tekrarlanmamalı');
});

test('misafir satırı birden fazla kez birikmez', () => {
    let n = '';
    for (let i = 1; i <= 4; i++) n = bridge.mergeGuestNote(n, { name: 'X', qty: i, note: 'n' });
    assert.equal((n.match(/QR misafir talebi/g) || []).length, 1);
});

// ── Sipariş rollup: iptal, "tamamlandı" gibi görünmemeli ──
// functions/index.js:rollupOrderStatus ile AYNI kural (o dosya firebase-admin
// gerektirdiğinden burada birebir kopyası doğrulanır; kuralın kendisi tek
// cümledir ve iki yerde ayrışmamalıdır).
function rollupOrderStatus(items, currentStatus) {
    const allCancelled = items.every((it) => (it.status || 'pending') === 'cancelled');
    const allDone = items.length > 0 && items.every((it) =>
        (it.status || 'pending') === 'completed' || (it.status || 'pending') === 'cancelled');
    return allCancelled ? 'cancelled' : (allDone ? 'completed' : currentStatus);
}

test('tüm kalemler İPTAL ise sipariş "cancelled" olur, "completed" DEĞİL', () => {
    // Denetimde bulunan hata: onReservationUpdate'in yerel rollup kopyasında
    // allCancelled dalı yoktu; personel tek kalemli bir Concierge talebini
    // iptal edince misafir 🎉 "Talebiniz tamamlandı" görüyordu.
    assert.equal(rollupOrderStatus([{ status: 'cancelled' }], 'pending'), 'cancelled');
    assert.equal(rollupOrderStatus([{ status: 'cancelled' }, { status: 'cancelled' }], 'confirmed'), 'cancelled');
});

test('kalemlerin bir kısmı iptal, kalanı tamamlandıysa sipariş "completed"', () => {
    assert.equal(rollupOrderStatus([{ status: 'completed' }, { status: 'cancelled' }], 'pending'), 'completed');
});

test('devam eden kalem varsa sipariş durumu korunur', () => {
    assert.equal(rollupOrderStatus([{ status: 'completed' }, { status: 'pending' }], 'in_progress'), 'in_progress');
});
