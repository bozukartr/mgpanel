/* Concierge — yeniden tasarım korkulukları.
 *
 *  · Kayıt kimlikleri satır içi onclick'e yazılmaz (misafirin seçebildiği
 *    kimliklerle saklı XSS açığı vardı) — data-id + olay devri.
 *  · prompt()/confirm() yok: iptal nedeni, voucher ve silme onayı çekmece içinde.
 *  · JS'in dokunduğu her sabit kimlik sayfada var (yeniden adlandırma kırılmasın).
 *  · İş kuralları korunur: terminal durum, voucher'sız onay yok, zorunlu iptal
 *    nedeni, kayıp-güncelleme transaction'ı, yalnız oluşturan siler.
 *  · Tarayıcıda uçtan uca doğrulandı (Playwright, sahte Firestore). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const js = read('js/modules/concierge.js');
const html = read('concierge.html');
const css = read('css/modules/concierge.css');
const pdf = read('js/modules/concierge-pdf.js');
const admin = read('js/modules/admin.js');
const adminHtml = read('admin.html');

test('XSS: satır içi olay işleyicisi yok, kimlikler kaçışlı data-id ile', () => {
  assert.doesNotMatch(js, /\bon(click|change|input|mousedown)="/);
  assert.doesNotMatch(html, /\bon(click|change|input)="/);
  // Kimlik taşıyan her öznitelik esc() ile yazılır.
  const raw = js.match(/data-id="\$\{(?!esc\()[^}]*\}"/g) || [];
  assert.deepEqual(raw, [], 'kaçışsız data-id: ' + raw.join(', '));
  assert.doesNotMatch(js, /value="\$\{item\.id\}"/);
  // Yedekten yükleme yalnız güvenli belge kimliklerini kabul eder.
  assert.match(js, /const safeId = \(id\) => \/\^\[A-Za-z0-9_-\]\{1,120\}\$\/\.test/);
});

test('tarayıcı diyalogları yok (prompt/confirm/alert)', () => {
  assert.doesNotMatch(js, /\b(prompt|confirm|alert)\(/);
});

test('JS\'in kullandığı her sabit kimlik sayfada var', () => {
  const dynamic = new Set(['d-voucherIn', 'd-cancelIn', 'd-delPass', 'd-applyFolioBtn', 'userNameDisplay', 'c-avatar', 'c-roleLabel', 'c-adminNav']);
  const ids = new Set();
  for (const m of js.matchAll(/(?:\$|getElementById)\('([A-Za-z][\w-]*)'\)/g)) ids.add(m[1]);
  const missing = [...ids].filter(id => !dynamic.has(id) && !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], 'concierge.html\'de olmayan kimlikler');
  assert.ok(ids.size > 60, 'beklenenden az kimlik: ' + ids.size);
});

test('eski bağımlılıklar kaldırıldı; hidden her bileşende geçerli', () => {
  assert.doesNotMatch(html, /flatpickr|modal-guard\.js|bottom-nav/);
  assert.doesNotMatch(js, /flatpickr|smartExpandDate|summarizeFinance/);
  assert.match(css, /\.cz-page \[hidden\] \{ display: none !important; \}/);
});

test('durum kuralları korunur (terminal, voucher, iptal nedeni, tamamlandı)', () => {
  const ss = js.slice(js.indexOf('async function setStatus'), js.indexOf('const armed'));
  assert.match(ss, /\(cur === 'Cancelled' \|\| cur === 'Done'\) && st !== cur/);
  assert.match(ss, /st === 'Confirmed' && needsVoucher/);
  assert.match(ss, /upd\.completedBy = loggedUsername/);
  assert.match(js, /const VOUCHER_REQ = \['Transfer', 'Flower', 'Cake', 'Boat', 'Tour'\];/);
  assert.match(js, /cancelReason: reasonTxt\.slice\(0, 300\), cancelledBy: loggedUsername/);
  assert.match(js, /if \(!reasonTxt\) \{/);
  // Tamamlandı geri alınamaz → iki dokunuş; geri al yalnız onay için.
  assert.match(js, /btn\.innerHTML = 'Emin misiniz\?'/);
  assert.match(js, /update\(\{ status: 'Pending' \}\); showToast\('Onay geri alındı'\)/);
});

test('kayıt: kayıp güncelleme transaction\'ı, seri alanları, kimlik çözümü', () => {
  assert.match(js, /if \(baseMs !== null && curMs !== null && baseMs !== curMs\) return \{ error: 'stale' \};/);
  assert.match(js, /GuestDirectory\.syncGuestStatus\(guestName, \{ room: isPreArrival \? '' : room, isPreArrival, checkIn, checkOut \}\)/);
  assert.match(js, /seriesIndex: isSeries \? i \+ 1 : null/);
  assert.match(js, /data\.status = confirmToo \? 'Confirmed' : 'Pending';/);
  // "Kaydet ve onayla" da voucher kuralına uyar.
  assert.match(js, /if \(confirmToo && VOUCHER_REQ\.includes\(type\) && !voucher\)/);
});

test('silme: yalnız oluşturan (ya da QR kaydı) + şifreyle yeniden doğrulama', () => {
  assert.match(js, /const canDelete = \(r\) => r\.staffInitial === loggedUsername \|\| r\.staffInitial === 'QR-Misafir';/);
  const del = js.slice(js.indexOf('async function deleteReservation'), js.indexOf('async function applyToFolio'));
  assert.ok(del.indexOf('reauthenticateWithCredential') > -1 && del.indexOf('reauthenticateWithCredential') < del.indexOf('.delete()'));
});

test('raporlar: tembel kütüphaneler denetlenir; özet Excel XLSX\'i yükler', () => {
  const sum = js.slice(js.indexOf("if (type === 'summary')"), js.indexOf("if (type === 'activity' || type === 'dateRange')"));
  assert.match(sum, /return exportExcel\(/);
  assert.doesNotMatch(sum, /XLSX\.utils/);
  assert.match(js, /if \(typeof XLSX === 'undefined'\) return showToast/);
  // PDF'ler concierge-pdf.js'te; kütüphane yüklenemezse anlaşılır uyarı.
  assert.match(js, /if \(e && e\.code === 'lib'\) return showToast\('PDF kütüphanesi yüklenemedi\.', true\);/);
  // "Tarih aralığı" seçeneği artık bir rapor üretir (önceden hiçbir şey olmuyordu).
  assert.match(js, /type === 'activity' \|\| type === 'dateRange'/);
  // 90 günden eski veri için tek seferlik tam okuma.
  assert.match(js, /async function reportData\(from, all\)/);
});

test('kabuk içinden ulaşılabilir eylemler (başlık gizliyken de)', () => {
  // Eskiden program/yedek/rapor düğmeleri yalnız gömülüyken gizlenen başlıktaydı.
  const top = html.slice(html.indexOf('<main class="cz-app"'), html.indexOf('</main>'));
  for (const id of ['czMenuIti', 'czMenuReport', 'c-exportDataBtn', 'c-importDataBtn', 'c-fab']) {
    assert.ok(top.includes(`id="${id}"`), id + ' ana alanda olmalı');
  }
});

// ── Hizmet bazlı ücret ayarı (Ayarlar → Gelir ve Komisyon → Concierge ücretleri) ──
test('ücret ayarı: sabit liste yok, ayar financeConfig.pricedTypes\'tan okunur', () => {
  assert.doesNotMatch(js, /PAID_TYPES/);
  assert.match(js, /db\.collection\('financeConfig'\)\.doc\(TENANT_ID\)\.onSnapshot/);
  assert.match(js, /const isPriced = \(type\) => \(typeof pricedTypes\[type\] === 'boolean'/);
  // Varsayılan liste iki dosyada aynı (ayar yokken davranış değişmez).
  const def = (src) => (src.match(/const DEFAULT_PRICED = (\[[^\]]*\]);/) || [])[1];
  assert.ok(def(js) && def(js) === def(admin), 'DEFAULT_PRICED concierge.js ve admin.js\'te aynı olmalı');
  assert.equal(def(js), "['Transfer', 'Flower', 'Cake', 'Boat', 'Tour', 'Other']");
});

test('ücret ayarı: form yalnız açık hizmette ödeme alanlarını gösterir ve yazar', () => {
  // Düzenlenen kayıtta tutar varsa alanlar ayardan bağımsız görünür (veri kaybı yok).
  assert.match(js, /const payOn = \(type\) => isPriced\(type\) \|\| editKeepPay === type;/);
  assert.match(js, /editKeepPay = hasMoney\(r\) \? r\.type : null;/);
  // Voucher, onay için gerekiyorsa ücret kapalıyken de görünür.
  assert.match(js, /const voucherOn = \(type\) => VOUCHER_REQ\.includes\(type\) \|\| payOn\(type\);/);
  assert.match(js, /\$\('rs-finance-group'\)\.hidden = !pay;/);
  assert.match(js, /totalPrice: pay \? price : 0, deposit: pay \? deposit : 0, currency,\s*voucherNo: vou \? voucher : ''/);
  // Kart / yan panel / çekmece: veriye göre (ayar kapansa da mevcut bakiye görünür).
  assert.match(js, /if \(st !== 'Cancelled' && \(Number\(r\.totalPrice\) \|\| 0\) > 0\) \{/);
});

test('ücret ayarı: Ayarlar kartı pricedTypes yazar; "fiyatı girilmemiş" yalnız ücretli hizmetleri sayar', () => {
  assert.match(adminHtml, /<h2>Concierge ücretleri<\/h2>/);
  assert.match(admin, /set\(\{ commissions: next, pricedTypes: paid, updatedAt:/);
  assert.match(admin, /const missingPrice = active\.filter\(r => isPriced\(r\.type\) && num\(r\.totalPrice\) <= 0\);/);
  assert.match(admin, /Math\.min\(100, Math\.max\(0, num\(inp\.value\)\)\)/);
});

// ── PDF belgeleri ─────────────────────────────────────────
test('PDF: vektörel modül, html2pdf ve platform logosu yok', () => {
  assert.doesNotMatch(js + html, /html2pdf|itinerary-pdf|fixTurkishChars/);
  assert.doesNotMatch(pdf + js, /logo\.png/);
  // concierge-pdf.js, concierge.js'ten ÖNCE yüklenir.
  assert.ok(html.indexOf('js/modules/concierge-pdf.js') > -1 && html.indexOf('js/modules/concierge-pdf.js') < html.indexOf('js/modules/concierge.js'));
  assert.match(pdf, /if \(!global\.jspdf \|\| !global\.jspdf\.jsPDF\) throw libError\(\);/);
  // Türkçe yazı tipi; yüklenemezse Helvetica + ASCII'ye düşer.
  assert.match(pdf, /fontOk = !!\(v && v\['Roboto-Regular\.ttf'\] && v\['Roboto-Medium\.ttf'\]\);/);
});

test('PDF: misafir belgelerine ekip notu ve fiyat yazılmaz (açık alan listesi)', () => {
  const safe = (js.match(/const pdfSafe = \(r\) => \{[\s\S]*?\n    \};/) || [''])[0];
  assert.ok(safe, 'pdfSafe bulunamadı');
  assert.doesNotMatch(safe, /'notes'|'totalPrice'|'deposit'|'staffInitial'|'cancelReason'/);
  const code = pdf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.notes\b|totalPrice|deposit/);
  assert.match(js, /items: items\.map\(pdfSafe\)/);
  assert.match(js, /r: pdfSafe\(r\)/);
});

test('PDF: durum ve dile göre belge; dosya adları ASCII', () => {
  for (const k of ['RESERVATION CONFIRMATION', 'RESERVATION REQUEST', 'CANCELLATION NOTICE', 'REZERVASYON ONAYI', 'REZERVASYON TALEBİ', 'İPTAL BİLDİRİMİ', 'Pre-Arrival Itinerary', 'Varış Öncesi Program']) {
    assert.ok(pdf.includes(k), k);
  }
  assert.match(js, /localStorage\.getItem\('cz_doc_lang'\) === 'tr' \? 'tr' : 'en'/);
  // Türkçe harfli indirme adı tarayıcıda "download" oluyordu.
  assert.match(js, /\.replace\(\/\[\^\\w-\]\+\/g, '_'\)/);
});
