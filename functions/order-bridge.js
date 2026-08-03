/* Hotizy — QR sipariş → Misafir Kayıtları köprüsü (sunucu tarafı).
 *
 * MEVCUT istemci köprüsü (js/modules/guest-orders.js commit()) kaydı ancak
 * personel çekmecede kalemi İLERLETİNCE oluşturuyordu — yani "misafir talebi
 * ne kadar sürede üstlenildi" ölçülemiyordu ve çekmeceye hiç dokunulmazsa
 * kayıt hiç doğmuyor, SLA/eskalasyon devreye giremiyordu.
 *
 * Bu köprü kayıtları SİPARİŞ GELDİĞİ ANDA, kalem başına ve istemci köprüsüyle
 * AYNI ŞEMADA açar (source: 'guest-order', orderId, itemId, logId geri-yazımı)
 * — çekmecenin mevcut `it.logId` güncelleme yolu değişmeden çalışır, panel
 * "Üstlen/Tamamla" akışı, SLA, eskalasyon ve performans raporları misafirin
 * talep ETTİĞİ andan itibaren işler.
 *
 * İdempotency: log kimliği deterministik (qr_{orderId}_{itemId}) — tetikleyici
 * yeniden çalışsa da mükerrer kayıt oluşmaz. SAF fonksiyon; Firestore'a
 * dokunmaz (test: tests/order-bridge.test.js).
 */
'use strict';

// Kategori → departman eşlemesi (kalemin kendi `department` alanı boşsa
// kullanılan yedek yol).
//
// DENETİM DÜZELTMESİ: değerler eskiden İNGİLİZCE idi ('Housekeeping',
// 'Engineering', 'Front Desk') — oysa personel hesapları TÜRKÇE varsayılan
// departman listesini kullanıyor (js/core/issue-config.js DEFAULT_DEPTS:
// Kat Hizmetleri / Ön Büro / Teknik / Mutfak). İki sözlük kesişmediği için
// bu yolla açılan talepleri ilgili departman personeli ÜSTLENEMİYORDU.
// Artık kanonik Türkçe adlar yazılır (firebase-config.js'teki eşanlamlı
// tablosu eski İngilizce veriyi de köprüler).
//
// Anahtar kümesi de genişletildi: 'Teknik' (hazır kataloğun KENDİ kategori
// adı, bkz. request-catalog.js DEFAULTS), 'Kat Hizmetleri', 'Oda Servisi'
// ve 'Front Office' eskiden haritada YOKTU — bu kategorilerdeki departmansız
// kalemler aşağıdaki eski 'Concierge' sabitine düşüyordu (ör. klima arızası
// → Concierge). Eşleme büyük/küçük harf duyarsız yapılır.
// Kategori → departman. Anahtarlar TABLODAN TÜRETİLİR (elle küçük harfle
// yazılmaz): 'İ' harfinin Unicode varsayılan küçük harfi 'i'+U+0307 (birleşen
// nokta) iken toLocaleLowerCase('tr-TR') düz 'i' üretir. Elle yazılan
// "yiyecek & i̇çecek" anahtarı bu yüzden HİÇBİR ZAMAN eşleşmiyordu ve
// departmansız gelen Yiyecek & İçecek kalemleri sahipsiz kalıyordu.
// Türetme, anahtar biçiminin arama biçiminden ayrışmasını yapısal olarak
// imkânsız kılar (bkz. tests/dept-routing.test.js).
const CAT_TO_DEPT = [
  ['Kat Hizmetleri', ['Temizlik', 'Konfor', 'Kat Hizmetleri']],
  ['Yiyecek & İçecek', ['Yiyecek & İçecek', 'Yiyecek-İçecek', 'Oda Servisi', 'Mutfak']],
  ['Teknik', ['Teknik', 'Teknik Servis']],
  ['Ön Büro', ['Resepsiyon', 'Ön Büro', 'Front Office', 'Front Desk']]
];
const DEPT_BY_CAT = (function () {
  const m = {};
  CAT_TO_DEPT.forEach(function (pair) {
    pair[1].forEach(function (cat) { m[String(cat).trim().toLocaleLowerCase('tr-TR')] = pair[0]; });
  });
  return m;
})();
function deptByCat(category) {
  return DEPT_BY_CAT[String(category || '').trim().toLocaleLowerCase('tr-TR')] || '';
}

// ── Departman eşanlamlıları — js/core/firebase-config.js'in AYNISI ───────
// Firebase yalnızca functions/ dizinini deploy ettiğinden istemci dosyası
// buradan require EDİLEMEZ; tablo bilinçli olarak çoğaltılmıştır. İkisinin
// ayrışmaması tests/dept-routing.test.js tarafından zorunlu kılınır (iki
// dosyadaki tablo birebir karşılaştırılır).
const DEPT_SYNONYMS = [
  ['Kat Hizmetleri', 'Housekeeping'],
  ['Ön Büro', 'Front Desk', 'Front Office', 'Resepsiyon'],
  ['Teknik', 'Engineering', 'Teknik Servis'],
  ['Yiyecek & İçecek', 'Food & Beverage', 'Mutfak']
];
function deptKey(s) { return String(s || '').trim().toLocaleLowerCase('tr-TR'); }
const DEPT_SYNONYM_MAP = (function () {
  const m = {};
  DEPT_SYNONYMS.forEach(function (group) {
    group.forEach(function (n) { m[deptKey(n)] = group[0]; });
  });
  return m;
})();
// İki departman adı aynı departmanı mı ifade ediyor? Bildirim hedeflemesi
// ham string eşitliği yerine bunu kullanır — aksi halde katalogdaki eski
// İngilizce ad ile personelin Türkçe departmanı eşleşmez, o departman
// hiç bildirim almazdı.
function sameDept(a, b) {
  const ka = deptKey(a), kb = deptKey(b);
  if (!ka || !kb) return ka === kb;
  if (ka === kb) return true;
  const ca = DEPT_SYNONYM_MAP[ka], cb = DEPT_SYNONYM_MAP[kb];
  return !!(ca && cb && ca === cb);
}

// Cloud Function sunucusunun yerel saati UTC'dir; otel operasyonu ise
// İstanbul saatine göre çalışır. Eskiden sunucu yerel günü kullanılıyordu ve
// gece yarısı civarı kayıt YANLIŞ güne düşüyordu (functions/index.js'teki
// _istanbulToday/hhmmIstanbul zaten bu düzeltmeyi yapıyor, bu dosya geride
// kalmıştı).
function todayYmd(d) {
  const x = d || new Date(Date.now() + 3 * 3600 * 1000); // UTC+3
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}
function hhmm(d) {
  const x = d || new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(x.getHours()) + ':' + p(x.getMinutes());
}
function safeId(s) { return String(s || '').replace(/[\/#?%\[\]]/g, '_').slice(0, 60); }

// guestLogs'ın tek-satırlık `complaint` metnini bir sipariş kalemi
// nesnesinden üretir — buildOrderLogDocs (ilk oluşturma) VE
// updateGuestOrderItem callable'ı (misafir daha sonra düzenlerse, bkz.
// functions/index.js) AYNI biçimlendirmeyi paylaşsın diye tek yerde
// toplanır; ikisi farklı metin üretirse personel eski/tutarsız bir açıklama
// görebilirdi.
function itemComplaintText(it) {
  const qty = Number(it && it.qty) || 1;
  const parts = [String((it && it.name) || '').trim() + (qty > 1 ? ' x' + qty : '')];
  if (it && it.option) parts.push('Seçenek: ' + String(it.option).trim().slice(0, 60));
  if (Array.isArray(it && it.modifiers) && it.modifiers.length) {
    // modifiers: {name, type:'remove'|'extra', priceDelta?}[] — düz string
    // DEĞİL, bu yüzden String(m) burada "[object Object]" üretirdi; ad
    // alanı ayrıca okunur, tip işaretiyle (−/+) birlikte gösterilir.
    const modTxt = it.modifiers
      .map((m) => (m && m.type === 'extra' ? '+' : '−') + ' ' + String((m && m.name) || '').trim().slice(0, 60))
      .filter((s) => s.length > 2).join(', ');
    if (modTxt) parts.push('Özelleştirme: ' + modTxt);
  }
  if (it && it.preferredTime) parts.push('Saat: ' + it.preferredTime);
  if (it && it.note) parts.push('Not: ' + String(it.note).slice(0, 200));
  return parts.filter(Boolean).join(' · ').slice(0, 500);
}

// Concierge tespiti: kalemin departmanı veya kategorisi Concierge'i işaret
// ediyorsa bu kalem NORMAL talep değildir — guestLogs yerine Concierge
// panelinde "Bekleyen" bir rezervasyon olarak doğar.
function isConciergeItem(it) {
  const s = (String((it && it.department) || '') + ' ' + String((it && it.category) || ''))
    .toLocaleLowerCase('tr-TR');
  return s.indexOf('concierge') !== -1 || s.indexOf('konsiyerj') !== -1;
}

// F&B tespiti: kanonik "Yiyecek & İçecek" + eski "Food & Beverage" adı +
// "Oda Servisi" kategorisi (guest-order.js'in varsayılan kataloğu) hepsi
// aynı mutfak kalemi sayılır — restaurant.js'in "QR Siparişleri" ekranı ve
// onGuestOrderCreate'in departman-hedefli bildirimi bu eşleşmeyi kullanır.
function isFnbItem(it) {
  const s = (String((it && it.department) || '') + ' ' + String((it && it.category) || ''))
    .toLocaleLowerCase('tr-TR');
  return /yiyecek|i̇çecek|icecek|içecek|food|beverage|f&b|oda servisi|room service/.test(s);
}

// reservations dokümanının tek-satırlık `notes` metnini bir sipariş kalemi
// nesnesinden üretir — buildOrderReservationDocs (ilk oluşturma) VE
// updateGuestOrderItem callable'ı (misafir daha sonra not/adet düzenlerse,
// bkz. functions/index.js) AYNI biçimlendirmeyi paylaşsın diye tek yerde
// toplanır — itemComplaintText'in (guestLogs için) AYNI gerekçesi.
// Misafir bölümünün başlangıç işareti. `notes` alanı personelin de
// yazabildiği ORTAK bir alan: eskiden misafirin her düzenlemesi personelin
// yazdığı notu tamamen SİLİYORDU (ve tersi). Artık misafir metni bu işaretle
// başlayan tek bir satırda tutulur; mergeGuestNote personelin satırlarına
// dokunmadan yalnızca o satırı tazeler.
const GUEST_NOTE_PREFIX = 'QR misafir talebi';

// Mevcut `notes` içinde misafir satırını günceller, personel satırlarını
// KORUR. Personel notu yoksa davranış eskisiyle aynıdır.
function mergeGuestNote(existingNotes, it) {
  const guestLine = reservationNotesText(it);
  const lines = String(existingNotes || '').split('\n');
  const kept = lines.filter((l) => l.trim() && l.indexOf(GUEST_NOTE_PREFIX) !== 0);
  return [guestLine].concat(kept).join('\n').slice(0, 1000);
}

function reservationNotesText(it) {
  const qty = Number(it && it.qty) || 1;
  const name = String((it && it.name) || '').trim();
  const option = String((it && it.option) || '').trim().slice(0, 60);
  const isTransfer = /transfer/.test(name.toLocaleLowerCase('tr-TR'));
  return [
    GUEST_NOTE_PREFIX, qty > 1 ? qty + ' adet' : '',
    (option && !isTransfer) ? 'Seçenek: ' + option : '',
    (it && it.note) ? String(it.note).slice(0, 200) : ''
  ].filter(Boolean).join(' · ');
}

// Concierge kalemleri → reservations dokümanları (status: Pending) + resId
// geri yazımı. concierge.js'in beklediği şemaya birebir uyar; adı "transfer"
// içeren kalem Transfer tipiyle, diğerleri Other/otherType ile açılır.
//
// it.option (katalogdaki "Seçenekler" listesinden misafirin seçtiği tek
// değer, ör. "Vito") Transfer tipinde concierge.js'in beklediği `vehicle`
// alanına yazılır (aksi halde Concierge panelindeki Transfer detay/rapor
// görünümü boş araç gösterir — bkz. concierge.js rowBase/dynHtml); Other
// tipinde otherType/resName/notes'a eklenir ki personel hangi seçeneğin
// istendiğini adisyon gibi ayrı bir ekrana gitmeden görsün.
//
// it.transferFrom/transferTo/transferDate/transferTime (guest-order.js'in
// Transfer kalemleri için sunduğu yapılandırılmış alanlar — bkz. güvenlik/
// operasyonel denetim: eskiden misafir yalnızca "bugün" için, Nereden/
// Nereye olmadan transfer talep edebiliyordu, personelin manuel formundaki
// from/to/date alanlarıyla uyumsuzdu) personelin manuel Transfer formuyla
// (concierge.js rs-from/rs-to/rs-date) AYNI alan adlarına yazılır.
function buildOrderReservationDocs(order, orderId, extra) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length || !order.tenantId) return { docs: [], items: items };
  const guestName = String((extra && extra.guestName) || order.guestName || '').trim()
    || ('Oda ' + String(order.room || '—').trim());
  const docs = [];
  const outItems = items.map((it, idx) => {
    if (!isConciergeItem(it)) return it;
    if (it && it.resId) return it; // zaten bağlı — dokunma (idempotent)
    const itemId = safeId((it && it.id) || ('i' + idx));
    const resId = 'qr_' + safeId(orderId) + '_' + itemId;
    const name = String((it && it.name) || '').trim();
    const option = String((it && it.option) || '').trim().slice(0, 60);
    const isTransfer = /transfer/.test(name.toLocaleLowerCase('tr-TR'));
    const displayName = option ? name + ' — ' + option : name;
    const data = {
      tenantId: order.tenantId,
      type: isTransfer ? 'Transfer' : 'Other',
      otherType: isTransfer ? '' : displayName,
      resName: displayName,
      // Misafirin seçtiği tarih HER Concierge kalemi için geçerlidir
      // (yalnızca transfer değil): guest-order.js artık restoran/spa/tur
      // gibi kalemlerde de tarih soruyor. Eskiden koşul `isTransfer &&`
      // idi ve diğer tüm Concierge talepleri koşulsuz BUGÜNE düşüyordu.
      date: (it && it.transferDate) ? String(it.transferDate).slice(0, 10) : todayYmd(),
      time: (it && it.transferTime) ? String(it.transferTime).slice(0, 5) : String((it && it.preferredTime) || '').slice(0, 5),
      guestName: guestName,
      room: String(order.room || '').trim(),
      status: 'Pending',
      notes: reservationNotesText(it),
      staffInitial: 'QR-Misafir',
      source: 'guest-order',
      orderId: orderId,
      itemId: (it && it.id) || ('i' + idx)
    };
    if (isTransfer && option) data.vehicle = option;
    if (isTransfer) {
      if (it && it.transferFrom) data.from = String(it.transferFrom).trim().slice(0, 80);
      if (it && it.transferTo) data.to = String(it.transferTo).trim().slice(0, 80);
    }
    if (extra && extra.guestId) data.guestId = extra.guestId;
    if (extra && extra.stayId) data.stayId = extra.stayId;
    docs.push({ id: resId, data });
    return Object.assign({}, it, { resId });
  });
  return { docs, items: outItems };
}

// Kalem başına guestLogs dokümanlarını + logId işlenmiş kalem dizisini üretir.
// extra: {guestId, stayId, guestName} — tetikleyicinin çözdüğü kimlik.
// Concierge kalemleri ATLANIR — onlar buildOrderReservationDocs ile
// rezervasyon olur (normal talep akışına girmezler).
function buildOrderLogDocs(order, orderId, extra) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length || !order.tenantId) return { docs: [], items: items };

  const guestName = String((extra && extra.guestName) || order.guestName || '').trim()
    || ('Oda ' + String(order.room || '—').trim());
  const docs = [];
  const outItems = items.map((it, idx) => {
    const itemId = safeId((it && it.id) || ('i' + idx));
    if (it && it.logId) return it; // zaten bağlı (eski istemci köprüsü) — dokunma
    if (isConciergeItem(it)) return it; // concierge → rezervasyon akışı
    const logId = 'qr_' + safeId(orderId) + '_' + itemId;
    const data = {
      date: todayYmd(),
      room: String(order.room || '').trim(),
      guestName: guestName,
      // Son çare eskiden sabit 'Concierge' idi: bilinmeyen bir kategoriden
      // (ör. otelin eklediği "Spa"/"Havuz") gelen departmansız bir talep
      // YANLIŞ departmana damgalanıyor ve — o otelde Concierge personeli
      // yoksa — hiç üstlenilemiyordu. Boş bırakmak panel.js'in
      // takeBlockReason kuralında "herkes üstlenebilir" anlamına gelir;
      // yanlış bir departmana kilitlemekten belirgin şekilde güvenli.
      department: String((it && it.department) || '').trim() || deptByCat(it && it.category),
      topic: '',
      complaint: itemComplaintText(it),
      solution: '',
      staffInitial: 'QR-Misafir',
      tenantId: order.tenantId,
      type: 'request',
      status: 'Following',
      source: 'guest-order',
      orderId: orderId,
      itemId: (it && it.id) || ('i' + idx),
      assignedTo: order.assignedTo || null,
      assignedToName: order.assignedToName || '',
      updates: [{ user: 'QR-Misafir', text: 'Misafir self-servis talebi alındı.', time: hhmm(), timestamp: Date.now(), isSystem: true }]
    };
    if (extra && extra.guestId) data.guestId = extra.guestId;
    if (extra && extra.stayId) data.stayId = extra.stayId;
    docs.push({ id: logId, data });
    return Object.assign({}, it, { logId });
  });
  return { docs, items: outItems };
}

module.exports = { mergeGuestNote, buildOrderLogDocs, buildOrderReservationDocs, isConciergeItem, isFnbItem, itemComplaintText, reservationNotesText, DEPT_BY_CAT, CAT_TO_DEPT, safeId, sameDept, deptByCat, DEPT_SYNONYMS };
