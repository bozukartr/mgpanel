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

// '1' uses PayTR test cards (no real charge). Switch to '0' when going live.
const TEST_MODE = '1';

const BASE_URL = 'https://panel-d25c9.web.app';
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

      const ref = db.collection('payments').doc(p.merchant_oid);
      const snap = await ref.get();

      // Idempotent: only act once per order.
      if (snap.exists && snap.data().status !== 'success') {
        if (p.status === 'success') {
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
