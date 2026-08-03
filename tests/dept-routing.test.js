/* QR talebi → doğru departman yönlendirmesi.
 *
 * DENETİMDE BULUNAN KRİTİK HATA: Hazır Talepler kataloğu departmanları
 * İNGİLİZCE sabit bir listeden seçiyordu (Housekeeping/Front Desk/
 * Engineering — admin.html), personel hesapları ise TÜRKÇE varsayılan
 * listeden (Kat Hizmetleri/Ön Büro/Teknik — js/core/issue-config.js).
 * İki sözlük hiç kesişmediğinden, QR'dan gelen bir "Housekeeping" talebini
 * "Kat Hizmetleri" personeli ÜSTLENEMİYORDU (panel.js takeBlockReason katı
 * departman kuralı) — talep listede görünüyor ama yalnızca yönetici
 * alabiliyordu. Varsayılan kurulumda 5 katalog departmanının 4'ü hiçbir
 * personelle eşleşmiyordu.
 *
 * Bu testler hem eşanlamlı köprüsünü hem de order-bridge'in kategori→
 * departman çözümlemesini kilitler. firebase-config.js bir tarayıcı
 * script'i (module.exports yok), bu yüzden ilgili saf blok dosyadan okunup
 * değerlendirilir — kaynağın KENDİSİ test edilir, kopyası değil. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── firebase-config.js'in departman bloğunu KAYNAKTAN yükle ──
const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'core', 'firebase-config.js'), 'utf8');
const blockStart = cfgSrc.indexOf('const FNB_DEPT =');
const blockEnd = cfgSrc.indexOf('function fnbPassword');
assert.ok(blockStart > -1 && blockEnd > blockStart, 'firebase-config.js departman bloğu bulunamadı');
const deptBlock = cfgSrc.slice(blockStart, blockEnd);
// Function yapıcısı: blok kendi kapsamında değerlendirilir, aradığımız
// yardımcılar açıkça dışarı verilir (eval'in strict-mode kapsam sızdırmama
// davranışını aşar).
const { sameDept, canonicalDept } = new Function(
  deptBlock + '\nreturn { sameDept: sameDept, canonicalDept: canonicalDept, deptKey: deptKey };'
)();

// issue-config.js'teki DEFAULT_DEPTS ile AYNI liste (personel tarafı).
const STAFF_DEPTS = ['Kat Hizmetleri', 'Ön Büro', 'Teknik', 'Mutfak', 'Yiyecek & İçecek'];
// admin.html'deki katalog seçicisinin taşıdığı (eski/İngilizce) değerler.
const LEGACY_CATALOG_DEPTS = ['Housekeeping', 'Front Desk', 'Engineering', 'Food & Beverage'];

test('katalogdaki İngilizce departmanlar Türkçe personel departmanlarıyla EŞLEŞİR', () => {
  for (const cat of LEGACY_CATALOG_DEPTS) {
    const matches = STAFF_DEPTS.filter((s) => sameDept(s, cat));
    assert.ok(matches.length > 0,
      `"${cat}" hiçbir personel departmanıyla eşleşmiyor — bu talep üstlenilemez kalır`);
  }
});

test('her İngilizce ad DOĞRU Türkçe karşılığına eşlenir (çapraz karışma yok)', () => {
  assert.ok(sameDept('Housekeeping', 'Kat Hizmetleri'));
  assert.ok(sameDept('Engineering', 'Teknik'));
  assert.ok(sameDept('Front Desk', 'Ön Büro'));
  assert.ok(sameDept('Food & Beverage', 'Yiyecek & İçecek'));
  // Çapraz eşleşme OLMAMALI — aksi halde temizlikçi teknik işi üstlenebilirdi.
  assert.ok(!sameDept('Housekeeping', 'Teknik'));
  assert.ok(!sameDept('Engineering', 'Kat Hizmetleri'));
  assert.ok(!sameDept('Front Desk', 'Yiyecek & İçecek'));
});

test('otelin kendi eklediği özel departman bozulmadan çalışır', () => {
  assert.ok(sameDept('Spa & Wellness', 'Spa & Wellness'));
  assert.ok(sameDept('spa & wellness', 'SPA & WELLNESS')); // büyük/küçük harf duyarsız
  assert.ok(!sameDept('Spa & Wellness', 'Housekeeping'));
  assert.equal(canonicalDept('Spa & Wellness'), 'Spa & Wellness'); // tabloya girmez
});

test('boş departman DOLU bir departmanla eşleşmez (yanlış personele açılmaz)', () => {
  assert.ok(!sameDept('', 'Housekeeping'));
  assert.ok(!sameDept('Housekeeping', ''));
  assert.ok(!sameDept('   ', 'Kat Hizmetleri'));
  // İki boş değerin eşit sayılması mevcut (ve zararsız) davranıştır: hem
  // takeBlockReason hem notifyRequestTeam, sameDept'i çağırmadan ÖNCE boş
  // departmanda kısa devre yapar (panel.js) — bu dal hiç kullanılmaz.
  assert.ok(sameDept('', ''));
});

test('canonicalDept eş adları TEK bir Türkçe isme indirger (rapor gruplaması)', () => {
  assert.equal(canonicalDept('Housekeeping'), 'Kat Hizmetleri');
  assert.equal(canonicalDept('Engineering'), 'Teknik');
  assert.equal(canonicalDept('Front Desk'), 'Ön Büro');
  assert.equal(canonicalDept('Food & Beverage'), 'Yiyecek & İçecek');
  assert.equal(canonicalDept('Mutfak'), 'Yiyecek & İçecek');
  // Aynı departman raporda iki ayrı satır olarak görünmemeli.
  assert.equal(canonicalDept('Housekeeping'), canonicalDept('Kat Hizmetleri'));
});

// ── order-bridge: kategori → departman çözümlemesi ──
const orderBridge = require('../functions/order-bridge');
const mkOrder = (category, department) => ({
  tenantId: 't1', room: '101',
  items: [{ id: 'i0', name: 'Test', qty: 1, category, department }]
});
const deptOfBridged = (category, department) => {
  const r = orderBridge.buildOrderLogDocs(mkOrder(category, department), 'ord1', {});
  return r.docs.length ? r.docs[0].data.department : null;
};

test('departman DOLU ise kategoriye bakılmaksızın aynen korunur', () => {
  assert.equal(deptOfBridged('Teknik', 'Teknik'), 'Teknik');
  assert.equal(deptOfBridged('Herhangi', 'Spa & Wellness'), 'Spa & Wellness');
});

test('departman BOŞ ise bilinen kategoriler doğru departmana çözümlenir', () => {
  assert.equal(deptOfBridged('Temizlik', ''), 'Kat Hizmetleri');
  assert.equal(deptOfBridged('Konfor', ''), 'Kat Hizmetleri');
  // 'Teknik' hazır kataloğun KENDİ kategori adı — eskiden haritada yoktu ve
  // arıza talepleri Concierge'e düşüyordu.
  assert.equal(deptOfBridged('Teknik', ''), 'Teknik');
  assert.equal(deptOfBridged('Teknik Servis', ''), 'Teknik');
  assert.equal(deptOfBridged('Kat Hizmetleri', ''), 'Kat Hizmetleri');
  assert.equal(deptOfBridged('Resepsiyon', ''), 'Ön Büro');
});

test('BİLİNMEYEN kategori + boş departman → BOŞ bırakılır, Concierge\'e YÖNLENDİRİLMEZ', () => {
  // Eskiden sabit 'Concierge' yazılıyordu: talep yanlış departmana gidiyor VE
  // (Concierge personeli yoksa) hiç üstlenilemiyordu. Boş departman ise
  // panel.js takeBlockReason'da HERKESİN üstlenebildiği anlamına gelir —
  // yanlış departmana kilitlemekten kesinlikle daha güvenli bir başarısızlık.
  for (const cat of ['Spa', 'Havuz', 'Çamaşırhane', 'Bilinmeyen']) {
    assert.equal(deptOfBridged(cat, ''), '', `"${cat}" kategorisi bir departmana zorlanmamalı`);
  }
});

test('yalnızca boşluktan oluşan departman boş sayılır (kategoriye düşer)', () => {
  assert.equal(deptOfBridged('Temizlik', '   '), 'Kat Hizmetleri');
});

// ── İki eşanlamlı tablosunun ayrışmaması ──
// Firebase yalnızca functions/ dizinini deploy ettiğinden istemci dosyası
// (js/core/firebase-config.js) sunucudan require EDİLEMEZ ve tablo zorunlu
// olarak iki yerde durur. Bu test, birinin güncellenip diğerinin unutulmasını
// engeller — restaurant.js/panel.js kopyalarının sessizce ayrışması denetimde
// tespit edilen gerçek bir hata sınıfıydı.
test('sunucu ve istemci departman eşanlamlı tabloları BİREBİR aynı', () => {
  const serverTable = orderBridge.DEPT_SYNONYMS;
  const m = cfgSrc.match(/const DEPT_SYNONYMS = (\[[\s\S]*?\]);/);
  assert.ok(m, 'firebase-config.js içinde DEPT_SYNONYMS bulunamadı');
  const clientTable = new Function('return ' + m[1] + ';')();
  assert.deepEqual(clientTable, serverTable,
    'js/core/firebase-config.js ve functions/order-bridge.js eşanlamlı tabloları ayrışmış — ikisini de güncelleyin');
});

test('sunucu tarafı sameDept istemciyle aynı sonucu verir', () => {
  const pairs = [
    ['Housekeeping', 'Kat Hizmetleri'], ['Engineering', 'Teknik'],
    ['Front Desk', 'Ön Büro'], ['Food & Beverage', 'Yiyecek & İçecek'],
    ['Housekeeping', 'Teknik'], ['Spa', 'Housekeeping'], ['Spa', 'Spa'], ['', 'Teknik']
  ];
  for (const [a, b] of pairs) {
    assert.equal(orderBridge.sameDept(a, b), sameDept(a, b), `sameDept("${a}","${b}") sunucu/istemci farklı`);
  }
});

// ── Türkçe 'İ' tuzağı: kategori anahtarları elle küçük harfle yazılmamalı ──
// GERÇEK HATA: DEPT_BY_CAT anahtarları elle yazılmıştı ve 'Yiyecek & İçecek'
// için Unicode VARSAYILAN küçük harf ('i' + U+0307 birleşen nokta) kullanılmıştı;
// arama ise toLocaleLowerCase('tr-TR') ile düz 'i' üretiyor. Anahtar hiçbir
// zaman eşleşmiyor, departmanı boş gelen tüm Yiyecek & İçecek kalemleri
// sahipsiz kalıyordu. Anahtarlar artık tablodan TÜRETİLİR.
test("'İ' içeren kategoriler doğru departmana çözümlenir (Unicode tuzağı)", () => {
  assert.equal(orderBridge.deptByCat('Yiyecek & İçecek'), 'Yiyecek & İçecek');
  assert.equal(orderBridge.deptByCat('Yiyecek-İçecek'), 'Yiyecek & İçecek');
  assert.equal(deptOfBridged('Yiyecek & İçecek', ''), 'Yiyecek & İçecek');
  assert.equal(orderBridge.deptByCat('Oda Servisi'), 'Yiyecek & İçecek');
});

test('kategori→departman anahtarlarının HEPSİ arama biçimiyle aynı', () => {
  // Anahtar üretimi ile arama aynı normalizasyonu kullanmalı; aksi halde
  // sessizce hiç eşleşmeyen ölü anahtarlar oluşur.
  for (const key of Object.keys(orderBridge.DEPT_BY_CAT)) {
    assert.equal(key, key.trim().toLocaleLowerCase('tr-TR'),
      `"${key}" anahtarı arama biçiminde değil — hiçbir zaman eşleşmez`);
    assert.ok(orderBridge.deptByCat(key), `"${key}" anahtarı çözümlenmiyor`);
  }
});

// ── QR çekmecesindeki kategori tablosu sunucununkiyle aynı kalmalı ──
// guest-orders.js panel/concierge sayfalarında çalışan bir tarayıcı script'i;
// tablo zorunlu olarak çoğaltılmış durumda (DEPT_SYNONYMS ile aynı gerekçe).
test('QR çekmecesi ve sunucu kategori→departman tabloları BİREBİR aynı', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'guest-orders.js'), 'utf8');
  const m = src.match(/const CAT_TO_DEPT = (\[[\s\S]*?\]);/);
  assert.ok(m, 'guest-orders.js içinde CAT_TO_DEPT bulunamadı');
  const clientTable = new Function('return ' + m[1] + ';')();
  assert.deepEqual(clientTable, orderBridge.CAT_TO_DEPT,
    'js/modules/guest-orders.js ve functions/order-bridge.js kategori tabloları ayrışmış — ikisini de güncelleyin');
});
