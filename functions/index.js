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

// Monthly price per plan, in TRY (server-authoritative — clients can't tamper).
const PLAN_PRICE = { starter: 7500, pro: 15000, enterprise: 30000 };

// Public website pricing (Core + extra modules), in TRY. Server-authoritative.
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
    const priceTRY = PLAN_PRICE[plan];
    if (!priceTRY) {
      throw new HttpsError('failed-precondition', 'Bu paket için online ödeme tanımlı değil. Lütfen iletişime geçin.');
    }
    const amount = priceTRY * 100; // PayTR expects the amount in kuruş

    const email = user.email || (user.username + '@' + tenantId + '.com');
    const oid = tenantId.replace(/[^a-zA-Z0-9]/g, '') + Date.now(); // alphanumeric only
    const req = request.rawRequest;
    const userIp = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || '127.0.0.1';
    const basket = Buffer.from(JSON.stringify([
      ['StayOS ' + plan + ' aboneliği (1 ay)', priceTRY.toFixed(2), 1]
    ])).toString('base64');

    const noInstallment = '1';
    const maxInstallment = '0';
    const currency = 'TL';

    const mid = MERCHANT_ID.value();
    const key = MERCHANT_KEY.value();
    const salt = MERCHANT_SALT.value();

    const hashStr = mid + userIp + oid + email + amount + basket + noInstallment + maxInstallment + currency + TEST_MODE;
    const paytrToken = crypto.createHmac('sha256', key).update(hashStr + salt).digest('base64');

    // Record the pending order before redirecting to PayTR.
    await db.collection('payments').doc(oid).set({
      oid, tenantId, plan, amountTRY: priceTRY, status: 'pending',
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
    const message = {
      notification: { title: n.title || 'StayOS', body: n.body || '' },
      data: {
        recordId: recordId,
        type: n.type || 'request',
        url: '/panel.html?open=' + encodeURIComponent(recordId)
      },
      webpush: {
        notification: { icon: '/logo.png', badge: '/logo.png' },
        fcmOptions: { link: '/panel.html?open=' + encodeURIComponent(recordId) }
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
