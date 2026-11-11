/* Hotizy — Misafir "Konaklamam" ekstresi (getGuestStay) için SAF yardımcılar.
 *
 * getGuestStay misafiri (oda + soyad → guestDirectory) sunucuda doğruladıktan
 * sonra oda hesabı (folioCharges) ve rezervasyonları toplar. Önceden misafire
 * yalnızca "kaynak + tutar" gidiyordu — restoran harcamasının hangi
 * adisyondan, hangi ürünlerden oluştuğu; rezervasyonun onay numarası,
 * tutarı, ön ödemesi ve kalan bakiyesi hiç gösterilmiyordu.
 *
 * Bu modül Firestore'a DOKUNMAZ (test: tests/guest-stay.test.js). Misafire
 * gidecek her alan burada AÇIKÇA seçilir ve kırpılır:
 *   · Personelin dahili `notes` alanı, personel adları, ödeme kayıtlarının
 *     ayrıntıları (`payments`, `by`) ve doküman kimlikleri ASLA dönmez.
 *   · Adisyon kalemleri yalnızca ad / adet / satır tutarı / ikram bayrağı.
 */
'use strict';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const tsMs = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis() : (typeof v === 'number' ? v : null);

const MAX_LINES = 40;

// Kapalı restoran adisyonunun misafire gösterilebilir özeti. Toplamlar
// SUNUCUDA hesaplanıp adisyona yazılmış değerlerdir (rest-core.js
// restSettleCheck); burada yeniden hesaplanmaz, yalnızca okunur.
function checkSummary(check) {
  if (!check) return null;
  const items = Array.isArray(check.items) ? check.items : [];
  const lines = items.slice(0, MAX_LINES).map((it) => {
    const qty = Math.max(1, Number(it && it.qty) || 1);
    const ikram = !!(it && it.ikram);
    return {
      name: str(it && it.name, 60),
      qty,
      amount: ikram ? 0 : round2((Number(it && it.unitPrice) || 0) * qty),
      ikram
    };
  });
  const discount = check.discount && Number(check.discount.amount) > 0 ? round2(check.discount.amount) : 0;
  return {
    checkNo: check.checkNo != null ? str(check.checkNo, 12) : '',
    tableName: str(check.tableName, 40),
    lines,
    moreLines: Math.max(0, items.length - lines.length),
    subtotal: round2(check.subtotal),
    vat: round2(check.vat),
    discount,
    total: round2(check.payable != null ? check.payable : check.total),
    closedAt: tsMs(check.closedAt)
  };
}

// Rezervasyonun misafire gösterilebilir görünümü. `notes` (personel notu)
// BİLİNÇLİ OLARAK dahil edilmez — dahili yorumlar içerebilir.
function reservationView(r) {
  r = r || {};
  const total = round2(r.totalPrice);
  const deposit = round2(r.deposit);
  return {
    type: str(r.type, 30),
    date: str(r.date, 20),
    time: str(r.time, 20),
    status: str(r.status || 'Pending', 20),
    resName: str(r.resName, 80),
    from: str(r.from, 80),
    to: str(r.to, 80),
    vehicle: str(r.vehicle, 60),
    vessel: str(r.vessel, 60),
    provider: str(r.provider, 60),
    pax: str(r.pax, 10),
    otherType: str(r.otherType, 60),
    voucherNo: str(r.voucherNo, 40),
    currency: str(r.currency || 'EUR', 3),
    total,
    deposit,
    balance: round2(Math.max(0, total - deposit)),
    folioApplied: !!r.folioApplied,
    folioAmount: round2(r.folioAmount)
  };
}

// Oda hesabı satırı: kaynağına göre adisyon ya da rezervasyon özetiyle
// zenginleştirilir. Bağlı doküman başka bir otele aitse (bozuk/çapraz veri)
// ayrıntı EKLENMEZ — yalnızca tutar ve kaynak kalır (fail-closed).
function folioItemView(charge, tenant, checksById, resById) {
  const c = charge || {};
  const out = {
    amount: round2(c.amount),
    source: str(c.source, 40),
    tableName: str(c.tableName, 40),
    createdAt: tsMs(c.createdAt)
  };
  if (c.source === 'restaurant' && c.checkId) {
    const ch = checksById && checksById[c.checkId];
    if (ch && ch.tenantId === tenant) out.check = checkSummary(ch);
  } else if (c.source === 'concierge' && c.reservationId) {
    const r = resById && resById[c.reservationId];
    if (r && r.tenantId === tenant) {
      const v = reservationView(r);
      out.res = { type: v.type, date: v.date, time: v.time, resName: v.resName, from: v.from, to: v.to, otherType: v.otherType, vessel: v.vessel };
    }
  }
  return out;
}

// Ekstre için bağlı doküman kimlikleri (benzersiz, sınırlı).
function linkedIds(charges, limit) {
  const checkIds = [], resIds = [];
  (charges || []).forEach((c) => {
    if (!c) return;
    if (c.source === 'restaurant' && c.checkId && checkIds.indexOf(c.checkId) === -1) checkIds.push(String(c.checkId));
    if (c.source === 'concierge' && c.reservationId && resIds.indexOf(c.reservationId) === -1) resIds.push(String(c.reservationId));
  });
  const n = limit || 40;
  return { checkIds: checkIds.slice(0, n), resIds: resIds.slice(0, n) };
}

module.exports = { checkSummary, reservationView, folioItemView, linkedIds, round2 };
