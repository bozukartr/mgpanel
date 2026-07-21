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

// guest-orders.js ile AYNI kategori→departman eşlemesi.
const DEPT_BY_CAT = {
  'Temizlik': 'Housekeeping', 'Konfor': 'Housekeeping',
  'Yiyecek & İçecek': 'Yiyecek & İçecek', 'Yiyecek-İçecek': 'Yiyecek & İçecek',
  'Teknik Servis': 'Engineering', 'Resepsiyon': 'Front Desk'
};

function todayYmd(d) {
  const x = d || new Date();
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
function reservationNotesText(it) {
  const qty = Number(it && it.qty) || 1;
  const name = String((it && it.name) || '').trim();
  const option = String((it && it.option) || '').trim().slice(0, 60);
  const isTransfer = /transfer/.test(name.toLocaleLowerCase('tr-TR'));
  return [
    'QR misafir talebi', qty > 1 ? qty + ' adet' : '',
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
      date: (isTransfer && it && it.transferDate) ? String(it.transferDate).slice(0, 10) : todayYmd(),
      time: (isTransfer && it && it.transferTime) ? String(it.transferTime).slice(0, 5) : String((it && it.preferredTime) || '').slice(0, 5),
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
      department: String((it && it.department) || DEPT_BY_CAT[(it && it.category)] || 'Concierge').trim(),
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

module.exports = { buildOrderLogDocs, buildOrderReservationDocs, isConciergeItem, isFnbItem, itemComplaintText, reservationNotesText, DEPT_BY_CAT, safeId };
