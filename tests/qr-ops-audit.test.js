/* QR misafir talebi — operasyonel denetim düzeltmeleri (saf mantık, emülatörsüz).
 *
 *  1) Hizmet ikonları: misafir ekranı ve personel çekmecesi katalog emojisi
 *     yerine js/core/service-icons.js çizgi ikonlarını gösterir.
 *  2) İlk sistem notunun saati İstanbul saatidir (UTC değil).
 *  3) Bağlı kayıt sahipliği: iptal/düzenleme yalnızca GERÇEKTEN bu siparişe
 *     ait guestLogs/reservations kaydına dokunur.
 *  4) Tek bekleyen talep yeni talebi engellemez (sınır 3).
 *  5) Saat penceresi otelin saatine göre hesaplanır.
 *  6) Çekmecede yalnızca Concierge kalemi olan talep "iptal edilemez".
 *  7) Sunucu tarafı talep sınırı (onGuestOrderCreate).
 * Kaynak dosyalar okunur — kopyası değil. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SI = require('../js/core/service-icons.js');
const bridge = require('../functions/order-bridge');

function slice(src, startMarker, endMarker) {
    const a = src.indexOf(startMarker);
    const b = src.indexOf(endMarker, a + startMarker.length);
    assert.ok(a > -1 && b > a, 'blok bulunamadı: ' + startMarker);
    return src.slice(a, b);
}

// ── 1) Hizmet ikonları ─────────────────────────────────────────────────
test('hazır kataloğun her kalemi anlamlı bir ikona çözülür (genel zile düşmez)', () => {
    const catSrc = read('js/modules/request-catalog.js');
    const block = slice(catSrc, "{ category: 'Temizlik', name: 'Oda Temizliği'", "\n    ];");
    const items = JSON.parse(JSON.stringify(vm.runInNewContext('[' + block + ']')));
    assert.ok(items.length >= 15);
    const generic = items.filter((it) => SI.key(it) === 'bell').map((it) => it.name);
    assert.deepEqual(generic, [], 'genel zile düşen kalemler');
});

test('ad, emojiden ve kategoriden önce gelir; kategori kelimesi adı ezmez', () => {
    assert.equal(SI.key({ icon: '🛏️', name: 'Ekstra Yastık', category: 'Konfor' }), 'pillow');
    assert.equal(SI.key({ icon: '🛎️', name: 'Meyve Tabağı', category: 'Yiyecek & İçecek' }), 'apple');
    assert.equal(SI.key({ icon: '🛎️', name: 'Sıcak Su Yok', category: 'Teknik' }), 'shower');
    assert.equal(SI.key({ icon: '🛎️', name: 'Lahmacun', category: 'Oda Servisi' }), 'utensils');
    assert.equal(SI.key({ icon: '🍕', name: 'Margarita' }), 'utensils');
    assert.equal(SI.key({ name: 'Bilinmeyen', department: 'Teknik' }), 'wrench');
    assert.equal(SI.key({ name: 'Bilinmeyen' }), 'bell');
    assert.equal(SI.key(null), 'bell');
});

test('ikon çıktısı dekoratif SVG; kullanılan her anahtar tanımlı', () => {
    const out = SI.svg({ name: 'Havlu' }, 20);
    assert.match(out, /^<svg viewBox="0 0 24 24" width="20" height="20"[^>]*aria-hidden="true"/);
    const src = read('js/core/service-icons.js');
    const keys = new Set([...src.matchAll(/'([a-z]+)'\]/g)].map((m) => m[1]).concat(
        [...src.matchAll(/addEmoji\('[^']*', '([a-z]+)'\)/g)].map((m) => m[1])));
    for (const k of keys) assert.ok(SI.has(k), 'tanımsız ikon: ' + k);
});

test('misafir ekranı ve çekmece kalem emojisini EKRANA basmaz', () => {
    const guest = read('js/modules/guest-order.js');
    assert.doesNotMatch(guest, /go-item-emoji/);
    assert.doesNotMatch(guest, /\$\{esc\((item|l|it)\.icon/);
    assert.match(guest, /function itemIcon\(/);
    const drawer = read('js/modules/guest-orders.js');
    assert.doesNotMatch(drawer, /\$\{esc\(it\.icon/);
    // Sayfalar ikon dosyasını yükler (ikon kullanan modülden ÖNCE).
    for (const [page, mod] of [['guest-order.html', 'guest-order.js'], ['panel.html', 'guest-orders.js'], ['concierge.html', 'guest-orders.js']]) {
        const html = read(page);
        const a = html.indexOf('js/core/service-icons.js'), b = html.indexOf('js/modules/' + mod);
        assert.ok(a > -1 && b > a, page + ': service-icons.js, ' + mod + ' öncesinde yüklenmeli');
    }
});

// ── 2) İstanbul saati ──────────────────────────────────────────────────
test('köprünün ilk sistem notu İstanbul saatini yazar (UTC değil)', () => {
    const out = bridge.buildOrderLogDocs({ tenantId: 't', room: '101', items: [{ id: 'i1', name: 'Su', qty: 1 }] }, 'o1', {});
    const time = out.docs[0].data.updates[0].time;
    const fmt = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    const now = fmt(new Date()), before = fmt(new Date(Date.now() - 60000));
    assert.ok(time === now || time === before, `beklenen ${now}, gelen ${time}`);
});

// ── 3) Bağlı kayıt sahipliği ───────────────────────────────────────────
test('bağlı kayıt yalnızca aynı sipariş + aynı otele aitse "bizim" sayılır', () => {
    const src = read('functions/index.js');
    const fn = vm.runInNewContext('(' + slice(src, 'function linkedBelongs(', '\nfunction computeOrderTotal').replace(/^function linkedBelongs/, 'function') + ')');
    const order = { tenantId: 'hotel-a' };
    assert.equal(fn({ orderId: 'o1', tenantId: 'hotel-a' }, order, 'o1'), true);
    assert.equal(fn({ orderId: 'o2', tenantId: 'hotel-a' }, order, 'o1'), false);
    assert.equal(fn({ orderId: 'o1', tenantId: 'hotel-b' }, order, 'o1'), false);
    assert.equal(fn({ tenantId: 'hotel-a' }, order, 'o1'), false); // manuel kayıt
    assert.equal(fn(null, order, 'o1'), false);
    // Üç callable da bu kontrolü kullanır.
    const uses = (src.match(/linkedBelongs\(/g) || []).length;
    assert.ok(uses >= 5, 'linkedBelongs çağrı sayısı: ' + uses);
});

// ── 4) Bekleyen talep sınırı ───────────────────────────────────────────
test('tek bekleyen talep yeni talebi engellemez; sınır 3', () => {
    const src = read('js/modules/guest-order.js');
    const block = slice(src, 'const MAX_OPEN_PENDING', '\n\n');
    const make = (statuses) => vm.runInNewContext(block + '; hasPending()', { myOrders: statuses.map((s) => ({ status: s })) });
    assert.equal(make(['pending']), false);
    assert.equal(make(['pending', 'pending']), false);
    assert.equal(make(['pending', 'pending', 'pending']), true);
    assert.equal(make(['pending', 'completed', 'in_progress', 'confirmed']), false);
});

// ── 5) Otel saati ──────────────────────────────────────────────────────
test('saat penceresi cihazın değil otelin saatine göre hesaplanır', () => {
    const src = read('js/modules/guest-order.js');
    const block = slice(src, 'function hotelMinutes()', '\n    // Availability window');
    const mins = vm.runInNewContext(block + '; hotelMinutes()', { Intl, Date, parseInt, isFinite });
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const exp = parseInt(parts.find((p) => p.type === 'hour').value, 10) * 60 + parseInt(parts.find((p) => p.type === 'minute').value, 10);
    assert.ok(Math.abs(mins - exp) <= 1, `beklenen ${exp}, gelen ${mins}`);
    assert.match(slice(src, 'function availInfo(', '\n    }'), /hotelMinutes\(\)/);
});

// ── 6) Çekmece: yalnızca-Concierge talepte sahte iptal ─────────────────
test('çekmecede iptal edilebilecek kalem yoksa İptal düğmesi devre dışı', () => {
    const src = read('js/modules/guest-orders.js');
    const block = slice(src, 'const cancelDis = noneMine', ';');
    assert.match(block, /disabled/);
    assert.match(src, /data-cancel="\$\{esc\(o\.id\)\}"\$\{cancelDis\}/);
});

// ── 7) Sunucu tarafı talep sınırı ──────────────────────────────────────
test('onGuestOrderCreate aynı oturumdan aşırı talebi köprülemeden iptal eder', () => {
    const src = read('functions/index.js');
    const trig = slice(src, 'exports.onGuestOrderCreate', 'exports.onReservationUpdate');
    const a = trig.indexOf('GUEST_ORDER_MAX_PER_WINDOW');
    const b = trig.indexOf('orderBridge.buildOrderLogDocs');
    const c = trig.indexOf("db.collection('notifications')");
    assert.ok(a > -1 && a < b && a < c, 'sınır kontrolü köprü ve bildirimlerden ÖNCE olmalı');
    assert.match(trig, /throttled: true/);
    assert.match(src, /const GUEST_ORDER_MAX_PER_WINDOW = \d+;/);
});
