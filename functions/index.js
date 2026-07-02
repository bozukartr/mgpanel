/* StayOS — PayTR payment integration (one-time monthly subscription).
 *
 * Two functions:
 *   createPayment  (callable) — an authenticated hotel admin starts a payment;
 *                  we ask PayTR for an iframe token for that hotel's plan price.
 *   paytrCallback  (https)    — PayTR notifies us of the result; we verify the
 *                  hash and, on success, extend the hotel's subscription by 1 month.
 *
 * Credentials are stored as Firebase secrets (never in client code):
 *   PAYTR_MERCHANT_ID, PAYTR_MERCHANT_KEY, PAYTR_MERCHANT_SALT
 * Set them after PayTR approval:
 *   firebase functions:secrets:set PAYTR_MERCHANT_ID
 *   firebase functions:secrets:set PAYTR_MERCHANT_KEY
 *   firebase functions:secrets:set PAYTR_MERCHANT_SALT
 */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const MERCHANT_ID = defineSecret('PAYTR_MERCHANT_ID');
const MERCHANT_KEY = defineSecret('PAYTR_MERCHANT_KEY');
const MERCHANT_SALT = defineSecret('PAYTR_MERCHANT_SALT');

// Lemon Squeezy (Merchant of Record) — alternatif ödeme yöntemi.
//   firebase functions:secrets:set LEMON_API_KEY
//   firebase functions:secrets:set LEMON_WEBHOOK_SECRET
const LEMON_API_KEY = defineSecret('LEMON_API_KEY');
const LEMON_WEBHOOK_SECRET = defineSecret('LEMON_WEBHOOK_SECRET');

// Monthly price per plan, in EUR (server-authoritative — clients can't tamper).
// Revenue is collected in EUR; the superadmin Muhasebe panel converts to TRY
// for accounting with a manual rate. Operators can override these amounts in
// siteConfig/billing (planStarter / planPro / planEnterprise).
const PLAN_PRICE = { starter: 49, pro: 99, enterprise: 199 };
function configuredPlanPrice(plan, cfg) {
  const map = { starter: 'planStarter', pro: 'planPro', enterprise: 'planEnterprise' };
  const v = cfg && Number(cfg[map[plan]]);
  return (v && v > 0) ? v : PLAN_PRICE[plan];
}

// Public website checkout pricing (Core + extra modules), in TRY. NOTE: the
// public new-signup flow (createCheckout) still uses this TRY model and does NOT
// yet match the EUR pricing page (base + per-room). Migrating checkout to EUR is
// a separate task; subscription renewals (createPayment) are already EUR.
const CHECKOUT_PRICES = { core: 10000, hotel: 5000, userPack: 2000, pms: 4000 };
const ANNUAL_DISCOUNT = 0.18;

// '1' uses PayTR test cards (no real charge). Switch to '0' when going live.
const TEST_MODE = '1';

const BASE_URL = 'https://stayos.org';
const REGION = 'us-central1';

exports.createPayment = onCall(
  { secrets: [MERCHANT_ID, MERCHANT_KEY, MERCHANT_SALT], region: REGION },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
    const uid = request.auth.uid;

    const userSnap = await db.collection('systemUsers').doc(uid).get();
    if (!userSnap.exists) throw new HttpsError('permission-denied', 'Kullanıcı bulunamadı.');
    const user = userSnap.data();
    if ((user.role || '').toLowerCase() !== 'admin') {
      throw new HttpsError('permission-denied', 'Sadece otel yöneticisi ödeme yapabilir.');
    }

    const tenantId = user.tenantId || 'mgallery';
    const tenantSnap = await db.collection('tenants').doc(tenantId).get();
    const tenant = tenantSnap.exists ? tenantSnap.data() : {};
    const plan = tenant.plan || 'pro';
    const billingSnap = await db.collection('siteConfig').doc('billing').get();
    const billingCfg = billingSnap.exists ? billingSnap.data() : {};
    const price = configuredPlanPrice(plan, billingCfg); // EUR
    if (!price) {
      throw new HttpsError('failed-precondition', 'Bu paket için online ödeme tanımlı değil. Lütfen iletişime geçin.');
    }
    const amount = Math.round(price * 100); // PayTR expects the amount in minor units (cents)

    const email = user.email || (user.username + '@' + tenantId + '.com');
    const oid = tenantId.replace(/[^a-zA-Z0-9]/g, '') + Date.now(); // alphanumeric only
    const req = request.rawRequest;
    const userIp = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || '127.0.0.1';
    const basket = Buffer.from(JSON.stringify([
      ['StayOS ' + plan + ' aboneliği (1 ay)', price.toFixed(2), 1]
    ])).toString('base64');

    const noInstallment = '1';
    const maxInstallment = '0';
    const currency = 'EUR';

    const mid = MERCHANT_ID.value();
    const key = MERCHANT_KEY.value();
    const salt = MERCHANT_SALT.value();

    const hashStr = mid + userIp + oid + email + amount + basket + noInstallment + maxInstallment + currency + TEST_MODE;
    const paytrToken = crypto.createHmac('sha256', key).update(hashStr + salt).digest('base64');

    // Record the pending order before redirecting to PayTR.
    await db.collection('payments').doc(oid).set({
      oid, tenantId, plan, amount: price, currency: 'EUR', amountTRY: price, status: 'pending',
      createdBy: uid, createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const params = new URLSearchParams({
      merchant_id: mid,
      user_ip: userIp,
      merchant_oid: oid,
      email,
      payment_amount: String(amount),
      paytr_token: paytrToken,
      user_basket: basket,
      debug_on: '1',
      no_installment: noInstallment,
      max_installment: maxInstallment,
      user_name: user.username || 'StayOS',
      user_address: tenant.name || 'StayOS',
      user_phone: '05000000000',
      merchant_ok_url: BASE_URL + '/payment-result.html?status=ok',
      merchant_fail_url: BASE_URL + '/payment-result.html?status=fail',
      timeout_limit: '30',
      currency,
      test_mode: TEST_MODE
    });

    const resp = await fetch('https://www.paytr.com/odeme/api/get-token', { method: 'POST', body: params });
    const data = await resp.json();
    if (data.status !== 'success') {
      await db.collection('payments').doc(oid).update({ status: 'error', error: data.reason || 'token' });
      throw new HttpsError('internal', 'PayTR: ' + (data.reason || 'token alınamadı'));
    }

    return { token: data.token, iframeUrl: 'https://www.paytr.com/odeme/guest/' + data.token + '/', oid };
  }
);

// Public checkout from the marketing site (no auth). Computes the amount
// server-side from the cart, records an order, and returns a PayTR iframe URL.
exports.createCheckout = onRequest(
  { secrets: [MERCHANT_ID, MERCHANT_KEY, MERCHANT_SALT], region: REGION },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

    try {
      const b = req.body || {};
      const items = b.items || {};
      const cycle = b.cycle === 'annual' ? 'annual' : 'monthly';
      const buyer = b.buyer || {};
      const name = String(buyer.name || '').trim();
      const email = String(buyer.email || '').trim();
      const phone = String(buyer.phone || '').trim();
      const hotel = String(buyer.hotel || '').trim();

      if (!hotel || !name) { res.status(400).json({ error: 'Otel adı ve yetkili adı gerekli.' }); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { res.status(400).json({ error: 'Geçerli bir e-posta girin.' }); return; }

      const hotels = Math.max(0, Math.min(20, parseInt(items.hotels, 10) || 0));
      const users = Math.max(0, Math.min(20, parseInt(items.users, 10) || 0));
      const pms = !!items.pms;

      const monthly = CHECKOUT_PRICES.core
        + hotels * CHECKOUT_PRICES.hotel
        + users * CHECKOUT_PRICES.userPack
        + (pms ? CHECKOUT_PRICES.pms : 0);
      const priceTRY = cycle === 'annual' ? Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT)) : monthly;
      const amount = priceTRY * 100; // kuruş

      const oid = 'CHK' + Date.now() + Math.floor(Math.random() * 1000);
      const basket = Buffer.from(JSON.stringify([
        ['StayOS ' + (cycle === 'annual' ? 'Yıllık' : 'Aylık') + ' Paket', priceTRY.toFixed(2), 1]
      ])).toString('base64');
      const userIp = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || '127.0.0.1';
      const noInstallment = '1', maxInstallment = '0', currency = 'TL';

      const mid = MERCHANT_ID.value();
      const key = MERCHANT_KEY.value();
      const salt = MERCHANT_SALT.value();
      const hashStr = mid + userIp + oid + email + amount + basket + noInstallment + maxInstallment + currency + TEST_MODE;
      const paytrToken = crypto.createHmac('sha256', key).update(hashStr + salt).digest('base64');

      await db.collection('checkoutOrders').doc(oid).set({
        oid, status: 'pending', cycle, priceTRY,
        items: { hotels, users, pms },
        buyer: { name, email, phone, hotel },
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const params = new URLSearchParams({
        merchant_id: mid, user_ip: userIp, merchant_oid: oid, email,
        payment_amount: String(amount), paytr_token: paytrToken, user_basket: basket,
        debug_on: '1', no_installment: noInstallment, max_installment: maxInstallment,
        user_name: name, user_address: hotel, user_phone: phone || '05000000000',
        merchant_ok_url: BASE_URL + '/payment-result.html?status=ok',
        merchant_fail_url: BASE_URL + '/payment-result.html?status=fail',
        timeout_limit: '30', currency, test_mode: TEST_MODE
      });

      const resp = await fetch('https://www.paytr.com/odeme/api/get-token', { method: 'POST', body: params });
      const data = await resp.json();
      if (data.status !== 'success') {
        await db.collection('checkoutOrders').doc(oid).update({ status: 'error', error: data.reason || 'token' });
        res.status(502).json({ error: 'PayTR: ' + (data.reason || 'token alınamadı') });
        return;
      }
      res.json({ iframeUrl: 'https://www.paytr.com/odeme/guest/' + data.token + '/', oid, priceTRY, cycle });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

exports.paytrCallback = onRequest(
  { secrets: [MERCHANT_KEY, MERCHANT_SALT], region: REGION },
  async (req, res) => {
    try {
      const p = req.body || {};
      const key = MERCHANT_KEY.value();
      const salt = MERCHANT_SALT.value();

      const hashStr = p.merchant_oid + salt + p.status + p.total_amount;
      const token = crypto.createHmac('sha256', key).update(hashStr).digest('base64');
      if (!p.hash || token !== p.hash) {
        res.status(400).send('PAYTR notification failed: bad hash');
        return;
      }

      // Checkout orders (public website) are prefixed CHK; everything else is a
      // tenant subscription payment.
      const isCheckout = String(p.merchant_oid).startsWith('CHK');
      const ref = db.collection(isCheckout ? 'checkoutOrders' : 'payments').doc(p.merchant_oid);
      const snap = await ref.get();

      // Idempotent: only act once per order.
      if (snap.exists && snap.data().status !== 'success') {
        if (p.status === 'success') {
          if (isCheckout) {
            // Public order paid — record it; the operator provisions the hotel.
            await ref.update({
              status: 'success',
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              totalAmount: Number(p.total_amount)
            });
          } else {
            const pay = snap.data();
            const tRef = db.collection('tenants').doc(pay.tenantId);
            const tSnap = await tRef.get();
            const now = new Date();
            let base = now;
            if (tSnap.exists && tSnap.data().subscriptionEnd) {
              const cur = tSnap.data().subscriptionEnd.toDate();
              if (cur > now) base = cur;
            }
            const newEnd = new Date(base);
            newEnd.setMonth(newEnd.getMonth() + 1);
            await tRef.set({
              subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd),
              suspended: false
            }, { merge: true });
            await ref.update({
              status: 'success',
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              totalAmount: Number(p.total_amount)
            });
          }
        } else {
          await ref.update({ status: 'failed', failReason: p.failed_reason_msg || '' });
        }
      }

      // PayTR requires a plain "OK" response, otherwise it keeps retrying.
      res.send('OK');
    } catch (e) {
      res.status(500).send('error');
    }
  }
);

// ─── Web Push fan-out ─────────────────────────────────────────────
// When an in-app notification is written, push it to the recipient's
// registered devices via FCM. Tokens live in `pushTokens` (doc id = token).
// Requires a deployed function; until then the in-app bell still works.
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

exports.onNotificationCreate = onDocumentCreated(
  { document: 'notifications/{id}', region: REGION },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const n = snap.data() || {};
    if (!n.toUid) return;

    const tokensSnap = await db.collection('pushTokens').where('uid', '==', n.toUid).get();
    const tokens = tokensSnap.docs.map((d) => d.id);
    if (!tokens.length) return;

    const recordId = n.recordId || '';
    // App Shell rotaları (app.html#route) — eski bağımsız sayfalara (/panel.html,
    // /concierge.html) değil; böylece bildirim tıklayınca sabit header/nav korunur.
    const link = (n.type === 'guestOrder')
      ? '/app.html#concierge' + (recordId ? '?order=' + encodeURIComponent(recordId) : '')
      : '/app.html#kayitlar' + (recordId ? '?open=' + encodeURIComponent(recordId) : '');
    const message = {
      notification: { title: n.title || 'StayOS', body: n.body || '' },
      data: {
        recordId: recordId,
        type: n.type || 'request',
        url: link
      },
      webpush: {
        notification: { icon: '/logo.png', badge: '/logo.png' },
        fcmOptions: { link: link }
      },
      tokens
    };

    try {
      const resp = await admin.messaging().sendEachForMulticast(message);
      // Prune tokens that are no longer valid so the collection stays clean.
      const stale = [];
      resp.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token') {
            stale.push(tokens[i]);
          }
        }
      });
      await Promise.all(stale.map((t) => db.collection('pushTokens').doc(t).delete().catch(() => {})));
    } catch (e) {
      console.error('push send failed', e);
    }
  }
);

// ─── New guest order → notify the hotel's staff ───────────────────
// A guest (anonymous) creates a guestOrder; they cannot write notifications,
// so this trigger fans out an in-app notification to every staff member of the
// tenant. That makes the bell light up in the persistent App Shell (no matter
// which tab is open) AND triggers onNotificationCreate for a web-push.
exports.onGuestOrderCreate = onDocumentCreated(
  { document: 'guestOrders/{id}', region: REGION },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const o = snap.data() || {};
    if ((o.status || 'pending') !== 'pending') return;
    const tenantId = o.tenantId;
    if (!tenantId) return; // etiketsiz sipariş — hangi otele ait bilinmiyor, bildirim gönderme (fail-closed)
    const room = String(o.room || '').trim();
    const items = Array.isArray(o.items) ? o.items : [];
    const count = items.length;

    // Otelin bildirim ayarları (admin "Bildirimler" sekmesi). Yoksa makul
    // varsayılanlar: bildirim açık, içerik gösterilir, tüm personele gider.
    let cfg = {};
    try { const c = await db.collection('notifyConfig').doc(tenantId).get(); if (c.exists) cfg = c.data() || {}; } catch (e) { /* varsayılanlarla devam */ }
    if (cfg.guestOrderEnabled === false) return; // operatör bildirimi kapatmış

    const staffSnap = await db.collection('systemUsers').where('tenantId', '==', tenantId).get();
    if (staffSnap.empty) return;
    let recipients = staffSnap.docs;
    if (cfg.guestOrderRecipients === 'managers') {
      recipients = recipients.filter((d) => {
        const r = String((d.data() || {}).role || '').toLowerCase();
        return r === 'admin' || r === 'manager';
      });
    }
    if (!recipients.length) return;

    const title = (cfg.guestOrderTitle && String(cfg.guestOrderTitle).trim()) || '🛎️ Yeni misafir talebi';
    // İçerik: talep edilen ürün adları (ör. "Havlu x2, Su, Kahvaltı"). Ayar
    // kapalıysa yalnızca adet ("3 talep"). Push gövdesi için makul uzunlukta kırp.
    const showItems = cfg.guestOrderShowItems !== false;
    let detail = '';
    if (showItems && count) {
      const names = items
        .map((it) => String((it && it.name) || '').trim() + (it && it.qty > 1 ? ' x' + it.qty : ''))
        .filter((s) => s);
      detail = names.join(', ');
      if (detail.length > 120) detail = detail.slice(0, 117) + '…';
    } else if (count) {
      detail = count + ' talep';
    }
    const body = (room ? 'Oda ' + room : 'Misafir') + (detail ? ' · ' + detail : '');

    const batch = db.batch();
    recipients.forEach((doc) => {
      const ref = db.collection('notifications').doc();
      batch.set(ref, {
        toUid: doc.id,
        toUsername: (doc.data() || {}).username || '',
        title: title,
        body: body,
        recordId: event.params.id,
        type: 'guestOrder',
        fromUid: 'system',
        fromUsername: 'Misafir',
        tenantId: tenantId,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    try { await batch.commit(); } catch (e) { console.error('guest order notify failed', e); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// PMS INTEGRATION
// Per-hotel PMS config lives in pmsConfig/{tenantId} (superadmin-only via
// rules; the function reads it with the Admin SDK). Guest lookups are
// proxied here so the hotel's API key never reaches the browser and CORS
// is never an issue. Two providers: 'mock' (demo, always works) and
// 'generic' (configurable REST adapter for whatever API the hotel gives us).
// ═══════════════════════════════════════════════════════════════════

// Demo guests for the 'mock' provider — lets the whole flow work end-to-end
// before a real PMS is connected.
const PMS_MOCK_GUESTS = [
  { name: 'Ahmet Yılmaz',  room: '204', checkIn: '2026-06-12', checkOut: '2026-06-15', vip: true,  phone: '+90 532 111 2233', email: 'ahmet.yilmaz@example.com' },
  { name: 'Elif Demir',    room: '305', checkIn: '2026-06-11', checkOut: '2026-06-14', vip: false, phone: '+90 533 222 3344', email: 'elif.demir@example.com' },
  { name: 'Mehmet Kaya',   room: '118', checkIn: '2026-06-10', checkOut: '2026-06-16', vip: false, phone: '+90 534 333 4455', email: 'mehmet.kaya@example.com' },
  { name: 'Sema Doğan',    room: '410', checkIn: '2026-06-09', checkOut: '2026-06-20', vip: true,  phone: '+90 535 444 5566', email: 'sema.dogan@example.com' },
  { name: 'John Carter',   room: '512', checkIn: '2026-06-13', checkOut: '2026-06-18', vip: false, phone: '+1 202 555 0142',  email: 'j.carter@example.com' },
  { name: 'Ayşe Çelik',    room: '207', checkIn: '2026-06-12', checkOut: '2026-06-13', vip: false, phone: '+90 536 555 6677', email: 'ayse.celik@example.com' }
];

// Read a dotted path (supports array indices) out of a nested object.
function pmsDig(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

function pmsNormalize(item, map) {
  map = map || {};
  const g = {
    name: pmsDig(item, map.name) ?? item.name ?? item.guestName ?? '',
    room: pmsDig(item, map.room) ?? item.room ?? item.roomNo ?? item.roomNumber ?? '',
    checkIn: pmsDig(item, map.checkIn) ?? item.checkIn ?? item.arrival ?? '',
    checkOut: pmsDig(item, map.checkOut) ?? item.checkOut ?? item.departure ?? '',
    vip: !!(pmsDig(item, map.vip) ?? item.vip ?? false),
    phone: pmsDig(item, map.phone) ?? item.phone ?? '',
    email: pmsDig(item, map.email) ?? item.email ?? ''
  };
  Object.keys(g).forEach(k => { if (g[k] == null) g[k] = (k === 'vip' ? false : ''); else if (k !== 'vip') g[k] = String(g[k]); });
  return g;
}

// Run a lookup against a given config (used by both pmsLookup and the
// superadmin test). Returns a normalized array of guests.
async function pmsRunLookup(cfg, query) {
  const q = String(query || '').trim();
  if (!cfg || cfg.enabled === false) return { enabled: false, results: [] };
  if (q.length < 2) return { enabled: true, results: [] };

  const provider = cfg.provider || 'mock';

  if (provider === 'mock') {
    const ql = q.toLowerCase();
    const results = PMS_MOCK_GUESTS.filter(g =>
      g.name.toLowerCase().includes(ql) || String(g.room).includes(q)).slice(0, 8);
    return { enabled: true, results, source: 'mock' };
  }

  // generic REST adapter
  if (provider === 'generic') {
    if (!cfg.baseUrl) throw new HttpsError('failed-precondition', 'PMS baseUrl tanımlı değil.');
    const path = (cfg.searchPath || '?q={q}').replace(/\{q\}/g, encodeURIComponent(q));
    const url = cfg.baseUrl.replace(/\/+$/, '') + (path.startsWith('/') || path.startsWith('?') ? path : '/' + path);
    const headers = { 'Accept': 'application/json' };
    if (cfg.apiKey) headers[cfg.authHeader || 'Authorization'] = (cfg.authPrefix || '') + cfg.apiKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    let data;
    try {
      const resp = await fetch(url, { headers, signal: ctrl.signal });
      if (!resp.ok) throw new HttpsError('unavailable', 'PMS yanıtı: HTTP ' + resp.status);
      data = await resp.json();
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('unavailable', 'PMS bağlantısı başarısız: ' + (e.message || e.name));
    } finally { clearTimeout(timer); }

    let arr = pmsDig(data, cfg.resultsPath);
    if (!Array.isArray(arr)) arr = Array.isArray(data) ? data : [];
    const results = arr.slice(0, 12).map(it => pmsNormalize(it, cfg.map)).filter(g => g.name || g.room);
    return { enabled: true, results, source: 'generic' };
  }

  return { enabled: true, results: [] };
}

// Hotel users call this while typing a guest name / room number.
exports.pmsLookup = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const uid = request.auth.uid;
  const userSnap = await db.collection('systemUsers').doc(uid).get();
  if (!userSnap.exists) throw new HttpsError('permission-denied', 'Kullanıcı bulunamadı.');
  const tenantId = userSnap.data().tenantId;
  if (!tenantId) throw new HttpsError('failed-precondition', 'Kullanıcının oteli (tenant) tanımlı değil.'); // fail-closed

  const cfgSnap = await db.collection('pmsConfig').doc(tenantId).get();
  if (!cfgSnap.exists) return { enabled: false, results: [] };
  return pmsRunLookup(cfgSnap.data(), request.data && request.data.query);
});

// Superadmin-only: validate a config (before saving) by running a live query.
exports.pmsTestConfig = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (!su.exists) throw new HttpsError('permission-denied', 'Yalnızca platform operatörü.');
  const cfg = (request.data && request.data.config) || {};
  const query = (request.data && request.data.query) || 'a';
  return pmsRunLookup(Object.assign({}, cfg, { enabled: true }), query);
});

/* ── Hotel / user deletion (Admin SDK) ─────────────────────────────────────
 * Why a function? A staff member's login is a Firebase Auth account whose UID
 * is the systemUsers document id (see superadmin createHotel). The client SDK
 * can only delete the *currently signed-in* user, so deleting a hotel/user from
 * the panel left the Auth account orphaned — recreating with the same
 * name/username reused the derived email and failed with "email-already-in-use"
 * ("zaten tanımlı"). Here the Admin SDK removes the Auth account too, so the
 * slug/username is genuinely free again. Both are superadmin-only.
 */
async function requireSuperAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (!su.exists) throw new HttpsError('permission-denied', 'Yalnızca platform operatörü.');
}

// Delete a single Auth account, tolerating an already-removed one.
async function deleteAuthUser(uid) {
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e && e.code === 'auth/user-not-found') return; // already gone — fine
    throw e;
  }
}

// Delete every document a query returns, chunked under Firestore's 500/batch
// limit so it scales to large collections. Returns the number removed.
async function deleteByQuery(query) {
  let total = 0;
  for (;;) {
    const snap = await query.limit(450).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < 450) break;
  }
  return total;
}

// Hotel-scoped data. Most collections carry a `tenantId` field; a few config
// collections use the tenant id as the document id. Push tokens belong to a
// user, so they're cleared by the removed users' uids.
// NOTE: `payments` is intentionally excluded — financial records are kept even
// on full delete (they may be needed later for accounting/reference).
const TENANT_FIELD_COLLECTIONS = [
  'reservations', 'guestLogs', 'guestDirectory', 'tickets',
  'presence', 'notifications', 'requestCatalog', 'guestOrders', 'roomAccess',
  'restMenu', 'restChecks', 'folioCharges', 'issueTopics', 'guestMenus', 'errorLogs'
];
const TENANT_DOC_COLLECTIONS = [
  'maintenance', 'financeConfig', 'pmsConfig', 'guestConfig',
  'notifyConfig', 'issueConfig', 'restConfig', 'restCounters'
];

// Permanently remove ALL of a hotel's data (used by "Tamamen Sil").
async function purgeTenantData(tenantId, userUids) {
  let removed = 0;
  for (const col of TENANT_FIELD_COLLECTIONS) {
    removed += await deleteByQuery(db.collection(col).where('tenantId', '==', tenantId));
  }
  for (const col of TENANT_DOC_COLLECTIONS) {
    await db.collection(col).doc(tenantId).delete().catch(() => {});
  }
  for (const uid of userUids) {
    removed += await deleteByQuery(db.collection('pushTokens').where('uid', '==', uid));
  }
  return removed;
}

// Superadmin-only: remove a hotel. Always deletes the staff Auth accounts,
// their systemUsers docs and the tenant document (so the code can be reused).
// When { purgeData: true }, ALSO permanently deletes every hotel-scoped record
// (reservations, guests, orders, logs, settings…) — the "Tamamen Sil" option.
exports.deleteHotel = onCall({ region: REGION }, async (request) => {
  await requireSuperAdmin(request);
  const tenantId = request.data && request.data.tenantId;
  if (!tenantId || typeof tenantId !== 'string') {
    throw new HttpsError('invalid-argument', 'Otel kodu gerekli.');
  }
  const purge = !!(request.data && request.data.purgeData);

  const usersSnap = await db.collection('systemUsers').where('tenantId', '==', tenantId).get();
  const userUids = usersSnap.docs.map((doc) => doc.id);

  let purgedDocs = 0;
  if (purge) purgedDocs = await purgeTenantData(tenantId, userUids);

  // Remove each staff member's Auth account (UID == doc id), then their record.
  await Promise.all(userUids.map((uid) => deleteAuthUser(uid)));
  if (!usersSnap.empty) {
    const batch = db.batch();
    usersSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  await db.collection('tenants').doc(tenantId).delete();

  return { deleted: true, removedUsers: usersSnap.size, purged: purge, purgedDocs };
});

// Superadmin-only: remove a single staff member — Auth account + systemUsers
// doc — so the same username can be issued again.
exports.deleteUser = onCall({ region: REGION }, async (request) => {
  await requireSuperAdmin(request);
  const uid = request.data && request.data.uid;
  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'Kullanıcı kimliği gerekli.');
  }
  await deleteAuthUser(uid);
  await db.collection('systemUsers').doc(uid).delete();
  // Yalnızca tam otel silme akışı (purgeTenantData) pushTokens'ı temizliyordu;
  // tekil kullanıcı silmede bu ve kullanıcıya yönelik notifications kayıtları
  // yetim kalıyordu (artık var olmayan bir uid'e push denemesi/bildirim listesi).
  await deleteByQuery(db.collection('pushTokens').where('uid', '==', uid));
  await deleteByQuery(db.collection('notifications').where('toUid', '==', uid));
  return { deleted: true };
});

// ── Misafir adı (QR self-servis) — güvenli ad çözümleme ─────────────
// Misafir sayfası anonim giriş yapar ve guestDirectory'yi OKUYAMAZ (kurallar
// personel-only). Bu callable, verilen (tenant, oda, soyadı) bilgisini SUNUCU
// tarafında guestDirectory ile eşleştirir ve tam adı YALNIZCA soyadı eşleşirse
// döndürür. Böylece misafir adları toplu olarak sızdırılamaz: adı almak için
// zaten o odanın soyadını bilmek gerekir.
function _normTr(s) {
  return String(s == null ? '' : s).trim().toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's')
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function _nameTokens(name) {
  return _normTr(name).split(/\s+/).filter((t) => t.length >= 2);
}
function _istanbulToday() {
  const d = new Date(Date.now() + 3 * 3600 * 1000); // UTC+3 (Europe/Istanbul)
  return d.toISOString().slice(0, 10);
}

exports.getGuestName = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const tenant = String(d.tenant || '').trim().toLowerCase().slice(0, 40);
  const room = String(d.room || '').trim().slice(0, 40);
  const surname = String(d.surname || '').trim().slice(0, 60);
  if (!tenant || !room || !surname) return { ok: false };

  // Tek alan (room) sorgusu → bileşik index gerektirmez; tenant kodda süzülür.
  let snap;
  try {
    snap = await db.collection('guestDirectory').where('room', '==', room).limit(25).get();
  } catch (e) {
    return { ok: false };
  }
  const today = _istanbulToday();
  const sTokens = _nameTokens(surname);
  // Birden fazla misafir eşleşirse (ör. checkout hatası nedeniyle aynı odada
  // kalan eski bir kayıt) ilk bulunanı seçmek YANLIŞ misafiri döndürebilirdi.
  // Aynı isimdeki tekrarlar zararsızdır; FARKLI isimlerde çoklu eşleşme
  // belirsizdir ve güvenli tarafta kalmak için reddedilir (fail-closed).
  const matchedNames = new Set();
  snap.forEach((doc) => {
    const g = doc.data() || {};
    const gTenant = String(g.tenantId || '').toLowerCase();
    if (!gTenant || gTenant !== tenant) return; // etiketsiz misafir kaydı hiçbir tenant'a eşleşmez (fail-closed)
    if (g.status && g.status !== 'in_house') return;
    if (g.checkOut && String(g.checkOut) < today) return; // çıkış yapmış
    const gTokens = _nameTokens(g.name);
    if (sTokens.some((t) => gTokens.indexOf(t) !== -1)) matchedNames.add(String(g.name || '').trim());
  });

  if (matchedNames.size !== 1) return { ok: false };
  return { ok: true, name: Array.from(matchedNames)[0] };
});

// ── Konaklama bilgilerim (Folio + Rezervasyonlar + tarihler) — güvenli özet ──
// firestore.rules'da folioCharges/reservations/guestDirectory yalnızca
// personel tarafından okunabilir; anonim misafirin doğrudan sorgu atıp başka
// bir odanın/misafirin verisini okumasını önlemek için bu kurallar
// DEĞİŞTİRİLMEDİ. Bunun yerine getGuestName ile AYNI sunucu-taraflı doğrulama
// (oda + soyadı → guestDirectory'de in-house eşleşmesi) burada tekrarlanır;
// yalnızca eşleşme başarılıysa Admin SDK ile üç bilgi tek çağrıda toplanır:
// check-in/check-out tarihleri, açık (status='open') oda hesabı kalemleri ve
// misafirin (guestDirectory'deki KANONİK adıyla) Concierge rezervasyonları.
exports.getGuestStay = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const tenant = String(d.tenant || '').trim().toLowerCase().slice(0, 40);
  const room = String(d.room || '').trim().slice(0, 40);
  const surname = String(d.surname || '').trim().slice(0, 60);
  if (!tenant || !room || !surname) return { ok: false };

  let dirSnap;
  try {
    dirSnap = await db.collection('guestDirectory').where('room', '==', room).limit(25).get();
  } catch (e) {
    return { ok: false };
  }
  const today = _istanbulToday();
  const sTokens = _nameTokens(surname);
  // getGuestName'deki gibi: FARKLI isimli birden çok eşleşme belirsizdir
  // (yanlış misafirin oda hesabı/rezervasyonları sızabilir) — fail-closed.
  const candidates = [];
  const matchedNames = new Set();
  dirSnap.forEach((doc) => {
    const g = doc.data() || {};
    const gTenant = String(g.tenantId || '').toLowerCase();
    if (!gTenant || gTenant !== tenant) return; // etiketsiz misafir kaydı hiçbir tenant'a eşleşmez (fail-closed)
    if (g.status && g.status !== 'in_house') return;
    if (g.checkOut && String(g.checkOut) < today) return; // çıkış yapmış
    const gTokens = _nameTokens(g.name);
    if (sTokens.some((t) => gTokens.indexOf(t) !== -1)) {
      candidates.push(g);
      matchedNames.add(String(g.name || '').trim());
    }
  });
  if (matchedNames.size !== 1) return { ok: false };
  const guest = candidates[0];

  let chargesSnap;
  try {
    chargesSnap = await db.collection('folioCharges')
      .where('tenantId', '==', tenant)
      .where('room', '==', room)
      .where('status', '==', 'open')
      .limit(100)
      .get();
  } catch (e) {
    chargesSnap = null;
  }
  // Para birimleri ASLA karıştırılmadan gruplanır (ör. Concierge'in EUR
  // rezervasyonu ile restoranın ₺ adisyonu tek bir sayıda toplanamaz — bu,
  // misafirin oda hesabında yanlış tutar/birim görmesine yol açan hataydı).
  // Eski (bu düzeltmeden önce yazılmış) kayıtlarda `currency` alanı yoktur;
  // kaynağa göre o zamanki gerçek varsayılana düşülür (concierge→EUR,
  // restaurant→TRY) — yeni yazımların hepsi artık currency taşıyor.
  const folioGroups = {}; // { EUR: {total,count,items}, TRY: {...} }
  if (chargesSnap) {
    chargesSnap.forEach((doc) => {
      const c = doc.data() || {};
      const amount = Number(c.amount) || 0;
      const currency = c.currency || (c.source === 'restaurant' ? 'TRY' : 'EUR');
      const g = folioGroups[currency] || (folioGroups[currency] = { currency, total: 0, count: 0, items: [] });
      g.total += amount;
      g.count += 1;
      g.items.push({
        amount,
        source: String(c.source || '').slice(0, 40),
        tableName: String(c.tableName || '').slice(0, 40),
        createdAt: c.createdAt && c.createdAt.toMillis ? c.createdAt.toMillis() : null
      });
    });
    Object.values(folioGroups).forEach((g) => g.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  }
  const folioByCurrency = Object.values(folioGroups).sort((a, b) => b.total - a.total);

  let resSnap;
  try {
    resSnap = await db.collection('reservations')
      .where('tenantId', '==', tenant)
      .where('guestName', '==', String(guest.name || ''))
      .limit(50)
      .get();
  } catch (e) {
    resSnap = null;
  }
  const reservations = [];
  if (resSnap) {
    resSnap.forEach((doc) => {
      const r = doc.data() || {};
      reservations.push({
        type: String(r.type || '').slice(0, 30),
        date: String(r.date || '').slice(0, 20),
        time: String(r.time || '').slice(0, 20),
        status: String(r.status || 'Pending').slice(0, 20),
        resName: String(r.resName || '').slice(0, 80),
        from: String(r.from || '').slice(0, 80),
        to: String(r.to || '').slice(0, 80),
        vehicle: String(r.vehicle || '').slice(0, 60),
        vessel: String(r.vessel || '').slice(0, 60),
        provider: String(r.provider || '').slice(0, 60),
        pax: String(r.pax || '').slice(0, 10),
        otherType: String(r.otherType || '').slice(0, 60)
      });
    });
    reservations.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
  }

  return {
    ok: true,
    checkIn: String(guest.checkIn || ''),
    checkOut: String(guest.checkOut || ''),
    // Para birimi başına ayrı grup — bkz. yukarıdaki not. Her grup en fazla
    // 30 kalem taşır.
    folio: folioByCurrency.map((g) => Object.assign({}, g, { items: g.items.slice(0, 30) })),
    reservations: reservations.slice(0, 30)
  };
});

// ═══════════════════════════════════════════════════════════════════
//  Lemon Squeezy ödeme entegrasyonu (PayTR'a alternatif)
//
//  Kurulum:
//   1) Lemon Squeezy'de Starter/Pro/Enterprise için birer ÜRÜN (tek seferlik,
//      "custom price" / pay-what-you-want açık) oluşturun.
//   2) siteConfig/billing dokümanına ekleyin:
//        lemonStoreId, lemonVariantStarter, lemonVariantPro, lemonVariantEnterprise
//   3) Secret'ları tanımlayın: LEMON_API_KEY, LEMON_WEBHOOK_SECRET
//   4) Lemon Squeezy webhook'unu şu olaylarla kaydedin (order_created +
//      subscription_payment_success), URL:
//        https://stayos.org/api/lemon-webhook
//      (veya doğrudan https://us-central1-panel-d25c9.cloudfunctions.net/lemonWebhook)
// ═══════════════════════════════════════════════════════════════════

// Fiyatlandırma sayfasındaki hesap ile birebir (js/utils/pricing.js).
const LS_PLANS = {
  starter:    { base: 49,  perRoom: 0.8, inclMods: 1, allMods: false },
  pro:        { base: 99,  perRoom: 1.2, inclMods: 2, allMods: false },
  enterprise: { base: 199, perRoom: 1.5, inclMods: 4, allMods: true }
};
const LS_PMS = 99, LS_EXTRA = 19, LS_DISCOUNT = 0.18, LS_MIN_ROOMS = 25, LS_MAX_ROOMS = 500;

function normalizePlan(plan) {
  const p = String(plan || '').toLowerCase();
  if (p === 'business' || p === 'enterprise') return 'enterprise';
  if (p === 'starter') return 'starter';
  return 'pro';
}
// Sunucu-otoritatif tutar (€). İstemciden gelen tutara GÜVENİLMEZ.
function computeQuoteEUR(plan, rooms, modsCount, pms, cycle) {
  const p = LS_PLANS[normalizePlan(plan)] || LS_PLANS.pro;
  const r = Math.min(LS_MAX_ROOMS, Math.max(LS_MIN_ROOMS, parseInt(rooms, 10) || LS_MIN_ROOMS));
  const isBiz = !!p.allMods;
  const billableRooms = Math.max(0, r - LS_MIN_ROOMS);
  const x = isBiz ? 0 : Math.max(0, (parseInt(modsCount, 10) || 1) - p.inclMods);
  const pmsCost = isBiz ? 0 : (pms ? LS_PMS : 0);
  const monthly = p.base + billableRooms * p.perRoom + x * LS_EXTRA + pmsCost;
  const total = cycle === 'annual' ? Math.round(monthly * 12 * (1 - LS_DISCOUNT)) : Math.round(monthly * 100) / 100;
  return { rooms: r, monthly: Math.round(monthly * 100) / 100, total, cycle: cycle === 'annual' ? 'annual' : 'monthly' };
}
function lemonConfig(cfg) {
  cfg = cfg || {};
  return {
    storeId: cfg.lemonStoreId ? String(cfg.lemonStoreId) : '',
    variants: {
      starter: cfg.lemonVariantStarter ? String(cfg.lemonVariantStarter) : '',
      pro: cfg.lemonVariantPro ? String(cfg.lemonVariantPro) : '',
      enterprise: cfg.lemonVariantEnterprise ? String(cfg.lemonVariantEnterprise) : ''
    }
  };
}
// Lemon Squeezy Checkout API → ödeme sayfası URL'i döndürür.
async function lsCreateCheckout(opts) {
  // NOT: custom_price, attributes içinde ÜST SEVİYEDE olmalı (resmi SDK gibi);
  // checkout_data içine konursa "The checkout data field must be an array" hatası alınır.
  const attrs = {
    product_options: { redirect_url: opts.redirectUrl },
    checkout_options: { embed: true },   // lemon.js overlay (modal) için
    checkout_data: { custom: opts.custom || {} }
  };
  if (opts.email) attrs.checkout_data.email = opts.email;
  if (opts.name) attrs.checkout_data.name = opts.name;
  if (opts.priceCents && opts.priceCents > 0) attrs.custom_price = Math.round(opts.priceCents);
  const body = {
    data: {
      type: 'checkouts',
      attributes: attrs,
      relationships: {
        store: { data: { type: 'stores', id: String(opts.storeId) } },
        variant: { data: { type: 'variants', id: String(opts.variantId) } }
      }
    }
  };
  const resp = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': 'Bearer ' + opts.apiKey
    },
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.data || !data.data.attributes || !data.data.attributes.url) {
    const msg = (data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].title)) || ('HTTP ' + resp.status);
    throw new Error('Lemon Squeezy: ' + msg);
  }
  return data.data.attributes.url;
}

// Custom data değerleri Lemon Squeezy'de string olmalı.
function strMap(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => { if (obj[k] != null) out[k] = String(obj[k]); });
  return out;
}

// ── In-app abonelik yenileme (yetkili otel yöneticisi) ──────────────
exports.createLemonCheckout = onCall(
  { secrets: [LEMON_API_KEY], region: REGION },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
    const uid = request.auth.uid;
    const userSnap = await db.collection('systemUsers').doc(uid).get();
    if (!userSnap.exists) throw new HttpsError('permission-denied', 'Kullanıcı bulunamadı.');
    const user = userSnap.data();
    if ((user.role || '').toLowerCase() !== 'admin') {
      throw new HttpsError('permission-denied', 'Sadece otel yöneticisi ödeme yapabilir.');
    }
    const tenantId = user.tenantId || 'mgallery';
    const tenantSnap = await db.collection('tenants').doc(tenantId).get();
    const tenant = tenantSnap.exists ? tenantSnap.data() : {};
    const plan = normalizePlan(tenant.plan || 'pro');
    const billingSnap = await db.collection('siteConfig').doc('billing').get();
    const cfg = billingSnap.exists ? billingSnap.data() : {};
    const ls = lemonConfig(cfg);
    const apiKey = LEMON_API_KEY.value();
    const variantId = ls.variants[plan];
    if (!apiKey || !ls.storeId || !variantId) {
      throw new HttpsError('failed-precondition', 'Lemon Squeezy henüz yapılandırılmamış.');
    }
    const price = configuredPlanPrice(plan, cfg); // EUR
    const oid = 'LS' + tenantId.replace(/[^a-zA-Z0-9]/g, '') + Date.now();
    await db.collection('payments').doc(oid).set({
      oid, tenantId, plan, amount: price, currency: 'EUR', status: 'pending',
      provider: 'lemonsqueezy', cycle: 'monthly', createdBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    try {
      const url = await lsCreateCheckout({
        apiKey, storeId: ls.storeId, variantId, priceCents: Math.round(price * 100),
        email: user.email || '', name: tenant.name || user.username || 'StayOS',
        custom: strMap({ tenant_id: tenantId, plan, cycle: 'monthly', oid }),
        redirectUrl: BASE_URL + '/payment-result.html?status=ok&provider=lemon'
      });
      return { url, oid };
    } catch (e) {
      await db.collection('payments').doc(oid).update({ status: 'error', error: String(e.message || e) });
      throw new HttpsError('internal', e.message || 'Ödeme başlatılamadı.');
    }
  }
);

// ── Fiyatlandırma sayfası: herkese açık ödeme başlatma ──────────────
exports.lemonCheckout = onRequest(
  { secrets: [LEMON_API_KEY], region: REGION },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
    try {
      const b = req.body || {};
      const plan = normalizePlan(b.plan);
      const cycle = b.cycle === 'annual' ? 'annual' : 'monthly';
      const modsCount = Array.isArray(b.mods) ? b.mods.length : (parseInt(b.mods, 10) || 1);
      const quote = computeQuoteEUR(plan, b.rooms, modsCount, !!b.pms, cycle);

      const billingSnap = await db.collection('siteConfig').doc('billing').get();
      const cfg = billingSnap.exists ? billingSnap.data() : {};
      const ls = lemonConfig(cfg);
      const apiKey = LEMON_API_KEY.value();
      const variantId = ls.variants[plan];
      if (!apiKey || !ls.storeId || !variantId) {
        res.status(503).json({ error: 'Online ödeme şu an kullanılamıyor. Lütfen "Teklif Al" ile iletişime geçin.' });
        return;
      }
      const buyer = b.buyer || {};
      const email = String(buyer.email || '').trim();
      const oid = 'LSC' + Date.now() + Math.floor(Math.random() * 1000);
      await db.collection('lemonOrders').doc(oid).set({
        oid, plan, cycle, rooms: quote.rooms, mods: Array.isArray(b.mods) ? b.mods : [], pms: !!b.pms,
        amount: quote.total, currency: 'EUR', status: 'pending', provider: 'lemonsqueezy',
        buyer: { email, name: String(buyer.name || ''), hotel: String(buyer.hotel || '') },
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const url = await lsCreateCheckout({
        apiKey, storeId: ls.storeId, variantId, priceCents: Math.round(quote.total * 100),
        email, name: String(buyer.name || ''),
        custom: strMap({ plan, cycle, oid, rooms: quote.rooms, signup: '1' }),
        redirectUrl: BASE_URL + '/payment-result.html?status=ok&provider=lemon'
      });
      res.json({ url, oid, amount: quote.total, cycle });
    } catch (e) {
      res.status(500).json({ error: e.message || 'hata' });
    }
  }
);

// ── Lemon Squeezy webhook (imza doğrulamalı) ────────────────────────
exports.lemonWebhook = onRequest(
  { secrets: [LEMON_WEBHOOK_SECRET], region: REGION },
  async (req, res) => {
    try {
      const secret = LEMON_WEBHOOK_SECRET.value();
      const sig = req.get('X-Signature') || '';
      const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const a = Buffer.from(digest, 'utf8');
      const c = Buffer.from(sig, 'utf8');
      if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) {
        res.status(401).send('bad signature');
        return;
      }
      const payload = JSON.parse(raw.toString('utf8'));
      const event = (payload.meta && payload.meta.event_name) || '';
      const custom = (payload.meta && payload.meta.custom_data) || {};
      const attr = (payload.data && payload.data.attributes) || {};
      const dataId = (payload.data && payload.data.id) || '';

      const paidOrder = event === 'order_created' && attr.status === 'paid';
      const subPay = event === 'subscription_payment_success';
      const subCreated = event === 'subscription_created' && (attr.status === 'active' || attr.status === 'on_trial');
      if (!(paidOrder || subPay || subCreated)) { res.status(200).send('ignored'); return; }

      // İdempotans: her olayı bir kez işle.
      const evRef = db.collection('lemonEvents').doc(event + '_' + dataId);
      const fresh = await db.runTransaction(async (tx) => {
        const s = await tx.get(evRef);
        if (s.exists) return false;
        tx.set(evRef, { event, dataId, at: admin.firestore.FieldValue.serverTimestamp() });
        return true;
      });
      if (!fresh) { res.status(200).send('dup'); return; }

      const months = String(custom.cycle || 'monthly') === 'annual' ? 12 : 1;
      const tenantId = custom.tenant_id ? String(custom.tenant_id) : '';
      const oid = custom.oid ? String(custom.oid) : '';

      if (tenantId) {
        const tRef = db.collection('tenants').doc(tenantId);
        const tSnap = await tRef.get();
        const now = new Date();
        let base = now;
        if (tSnap.exists && tSnap.data().subscriptionEnd) {
          const cur = tSnap.data().subscriptionEnd.toDate();
          if (cur > now) base = cur;
        }
        const newEnd = new Date(base);
        newEnd.setMonth(newEnd.getMonth() + months);
        await tRef.set({
          subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd), suspended: false
        }, { merge: true });
        if (oid) await db.collection('payments').doc(oid).set({
          status: 'success', paidAt: admin.firestore.FieldValue.serverTimestamp(), lemonId: dataId
        }, { merge: true });
      } else if (oid) {
        // Fiyatlandırma sayfasından yeni kayıt → operatör otelin kurulumunu yapar.
        await db.collection('lemonOrders').doc(oid).set({
          status: 'success', paidAt: admin.firestore.FieldValue.serverTimestamp(),
          lemonId: dataId, buyerEmail: attr.user_email || ''
        }, { merge: true });
      }
      res.status(200).send('OK');
    } catch (e) {
      res.status(500).send('error');
    }
  }
);

// ── Tek seferlik göç: tenantId'siz (etiketsiz) eski dokümanları kurucu otele
//    ('mgallery') etiketle. Fail-closed kurallara/koda geçmeden ÖNCE superadmin
//    bunu çalıştırmalı; aksi halde çok-kiracılık öncesi etiketsiz veriler ve
//    kullanıcılar fail-closed sonrası erişilemez kalır. İdempotent: zaten
//    etiketli dokümanlara dokunmaz. İstenirse {tenant, collections} verilebilir.
const BACKFILL_COLLECTIONS = [
  'systemUsers', 'reservations', 'guestLogs', 'guestDirectory',
  'guestOrders', 'restChecks', 'tickets', 'notifications', 'presence', 'issueTopics'
];
exports.backfillTenantTags = onCall({ region: REGION, timeoutSeconds: 540 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (!su.exists) throw new HttpsError('permission-denied', 'Yalnızca platform operatörü.');

  const d = request.data || {};
  const tenant = (typeof d.tenant === 'string' && /^[a-z0-9-]{2,24}$/.test(d.tenant)) ? d.tenant : 'mgallery';
  const cols = (Array.isArray(d.collections) && d.collections.length)
    ? d.collections.filter((c) => BACKFILL_COLLECTIONS.includes(c))
    : BACKFILL_COLLECTIONS;

  const result = {};
  for (const col of cols) {
    let scanned = 0; let tagged = 0; let last = null;
    // Doküman-id sırasıyla sayfalayarak tüm koleksiyonu tara (Firestore'da
    // "alan yok" sorgusu olmadığından istemci-tarafı kontrol gerekir).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = db.collection(col).orderBy(admin.firestore.FieldPath.documentId()).limit(400);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      const batch = db.batch();
      let n = 0;
      snap.forEach((doc) => {
        scanned++;
        const dd = doc.data() || {};
        if (dd.tenantId === undefined || dd.tenantId === null || dd.tenantId === '') {
          batch.set(doc.ref, { tenantId: tenant }, { merge: true });
          n++;
        }
      });
      if (n) { await batch.commit(); tagged += n; }
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < 400) break;
    }
    result[col] = { scanned, tagged };
  }
  return { ok: true, tenant, result };
});
