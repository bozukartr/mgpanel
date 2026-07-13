/* Hotizy — PayTR payment integration (one-time monthly subscription).
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

// Cloudflare Worker'ın (cloudflare/hotizy-subdomain-proxy.js) gerçek gelen
// subdomain'i imzalamak için kullandığı paylaşılan sır — mintGuestClaim bu
// imzayı doğrular. Worker'daki Cloudflare secret ile AYNI değer olmalı.
//   firebase functions:secrets:set TENANT_SIG_SECRET
const TENANT_SIG_SECRET = defineSecret('TENANT_SIG_SECRET');

// Resend (e-posta gönderimi) — yeni bir teklif talebi geldiğinde bildirim
// e-postası göndermek için. Kurulum: docs/e-posta-bildirim-kurulum.md
//   firebase functions:secrets:set RESEND_API_KEY
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

// Her otelin PMS API anahtarı/OAuth2 client secret'ı pmsConfig/{tenantId}'de
// saklanıyor — bu tek bir platform sırrı değil, otel başına farklı bir
// değer olduğundan defineSecret'a (deploy-zamanlı, tek değerli) doğrudan
// taşınamıyor. Bunun yerine bu TEK master anahtarla alan-seviyesinde
// (AES-256-GCM) şifrelenip Firestore'a öyle yazılıyor — bkz. pmsEncrypt/
// pmsDecrypt. Düz metin secret hiçbir zaman Firestore'a inmiyor.
//   firebase functions:secrets:set PMS_CRED_ENC_KEY
const PMS_CRED_ENC_KEY = defineSecret('PMS_CRED_ENC_KEY');

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

const BASE_URL = 'https://hotizy.com';
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
      ['Hotizy ' + plan + ' aboneliği (1 ay)', price.toFixed(2), 1]
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
      user_name: user.username || 'Hotizy',
      user_address: tenant.name || 'Hotizy',
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
      const name = String(buyer.name || '').trim().slice(0, 120);
      const email = String(buyer.email || '').trim().slice(0, 160);
      const phone = String(buyer.phone || '').trim().slice(0, 40);
      const hotel = String(buyer.hotel || '').trim().slice(0, 120);

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
        ['Hotizy ' + (cycle === 'annual' ? 'Yıllık' : 'Aylık') + ' Paket', priceTRY.toFixed(2), 1]
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
        // Ham PayTR hata metni herkese açık (kimliksiz) çağırana DÖNMEZ — yalnızca
        // sunucu tarafında (log + Firestore) tutulur; bkz. güvenlik denetimi.
        console.error('createCheckout PayTR error', data.reason || 'token');
        res.status(502).json({ error: 'Ödeme sağlayıcısına bağlanılamadı. Lütfen daha sonra tekrar deneyin.' });
        return;
      }
      res.json({ iframeUrl: 'https://www.paytr.com/odeme/guest/' + data.token + '/', oid, priceTRY, cycle });
    } catch (e) {
      // e.message ham hata metnini (Firestore/PayTR/fetch iç detayları) herkese
      // açık bir uca sızdırabileceğinden çağırana asla döndürülmez — yalnızca
      // sunucu log'una yazılır; bkz. güvenlik denetimi (paytrCallback/lemonWebhook
      // zaten bu deseni izliyordu, createCheckout/lemonCheckout de uyumlu hale
      // getirildi).
      console.error('createCheckout error', e);
      res.status(500).json({ error: 'Ödeme başlatılamadı. Lütfen daha sonra tekrar deneyin.' });
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
      // Sabit zamanlı karşılaştırma: dosyadaki diğer iki imza kontrolüyle
      // (lemonWebhook, mintGuestClaim) tutarlı — düz `!==` bir timing side-channel
      // bırakır; bkz. güvenlik denetimi.
      const tokenBuf = Buffer.from(token, 'utf8');
      const hashBuf = Buffer.from(String(p.hash || ''), 'utf8');
      const validHash = !!p.hash && tokenBuf.length === hashBuf.length && crypto.timingSafeEqual(tokenBuf, hashBuf);
      if (!validHash) {
        res.status(400).send('PAYTR notification failed: bad hash');
        return;
      }

      // Checkout orders (public website) are prefixed CHK; everything else is a
      // tenant subscription payment.
      const isCheckout = String(p.merchant_oid).startsWith('CHK');
      const ref = db.collection(isCheckout ? 'checkoutOrders' : 'payments').doc(p.merchant_oid);

      // İdempotans: durumu oku + 'success'/'failed'e çevirme, VE (başarılıysa)
      // aboneliği uzatma — HEPSİ AYNI transaction içinde. Önceki sürümde
      // abonelik uzatma transaction'ın DIŞINDA, ayrı bir yazımdı: transaction
      // 'success'ı commit ettikten hemen sonra bu ayrı yazım başarısız olursa
      // (geçici Firestore hatası, fonksiyon zaman aşımı), PayTR'ın sonraki
      // her yeniden denemesi artık status==='success' görüp erken çıkıyor —
      // ödeme alınmış ama abonelik hiç uzamamış, kalıcı olarak kurtarılamaz
      // bir durum (bkz. tutarlılık denetimi). Şimdi ya HEPSİ ya HİÇBİRİ
      // commit edilir: transaction'ın herhangi bir yerinde hata olursa
      // status hâlâ eski değerinde kalır, fonksiyon 500 döner, ve PayTR'ın
      // kendi yeniden deneme mekanizması işi gerçekten tekrar dener.
      let payData = null;
      let claimed = false;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        payData = snap.data();
        if (payData.status === 'success') return; // zaten işlenmiş — tekrar bildirim

        // Abonelik uzatma checkout siparişlerinde yok (operatör oteli elle
        // açar) — tenant dokümanı yalnızca gerekiyorsa, ve YAZIMLARDAN ÖNCE
        // okunur (Firestore transaction kuralı: tüm okumalar yazımlardan önce).
        let tRef = null, tSnap = null;
        if (p.status === 'success' && !isCheckout) {
          tRef = db.collection('tenants').doc(payData.tenantId);
          tSnap = await tx.get(tRef);
        }

        claimed = true;
        if (p.status === 'success') {
          tx.update(ref, {
            status: 'success',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            totalAmount: Number(p.total_amount)
          });
          if (tRef) {
            const now = new Date();
            let base = now;
            if (tSnap.exists && tSnap.data().subscriptionEnd) {
              const cur = tSnap.data().subscriptionEnd.toDate();
              if (cur > now) base = cur;
            }
            const newEnd = new Date(base);
            newEnd.setMonth(newEnd.getMonth() + 1);
            tx.set(tRef, {
              subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd),
              suspended: false
            }, { merge: true });
          }
        } else {
          tx.update(ref, { status: 'failed', failReason: p.failed_reason_msg || '' });
        }
      });

      // PayTR requires a plain "OK" response, otherwise it keeps retrying.
      res.send('OK');
    } catch (e) {
      // Hangi ödeme/otel için başarısız olduğu, yapılandırılmış olarak
      // loglanır — önceden yalnızca genel bir "error" vardı, bir operatör
      // sorunu ancak müşteri şikayet ederse fark ederdi (bkz. denetim).
      console.error('paytrCallback error', {
        merchantOid: (req.body && req.body.merchant_oid) || null,
        status: (req.body && req.body.status) || null,
        message: e && e.message
      });
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
      : (n.type === 'passwordReset')
      ? '/app.html#admin'
      : '/app.html#kayitlar' + (recordId ? '?open=' + encodeURIComponent(recordId) : '');
    const message = {
      notification: { title: n.title || 'Hotizy', body: n.body || '' },
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

    // Kimlik (kimlik migrasyonu): anonim misafir istemcisi guestDirectory'yi
    // okuyamaz (kurallar personele kilitli), bu yüzden guestId/stayId sipariş
    // OLUŞTURULURKEN eklenemiyor — burada, Admin SDK ile sunucu tarafında
    // odadaki konaklayan misafire çözülüp siparişe damgalanır. Oda o an bir
    // in_house misafire çözülemiyorsa damgalanmaz; backfill/inceleme kuyruğu
    // sonradan ele alır (asla tahmin edilmez).
    let stamped = { guestId: o.guestId || '', stayId: o.stayId || '', guestName: o.guestName || '' };
    if (room && !o.guestId) {
      try {
        const occSnap = await db.collection('guestDirectory')
          .where('tenantId', '==', tenantId).where('status', '==', 'in_house').get();
        const roomKey = room.toLowerCase();
        const matches = occSnap.docs.filter((d) =>
          String((d.data() || {}).room || '').trim().toLowerCase() === roomKey);
        if (matches.length === 1) { // tek eşleşme — belirsizlikte damgalama yok
          const occ = matches[0];
          const upd = { guestId: occ.id };
          const activeStayId = (occ.data() || {}).activeStayId;
          if (activeStayId) upd.stayId = activeStayId;
          await snap.ref.update(upd);
          stamped = { guestId: occ.id, stayId: activeStayId || '', guestName: stamped.guestName || (occ.data() || {}).name || '' };
        }
      } catch (e) { console.error('guest order identity stamp failed', e); }
    }

    // QR → Misafir Kayıtları köprüsü: SİPARİŞ GELDİĞİ ANDA kalem başına
    // guestLogs 'talep' kaydı açılır (istemci köprüsüyle aynı şema; logId
    // kalemlere geri yazılır — çekmecenin mevcut güncelleme yolu bozulmaz).
    // Böylece üstlenme/çözüm süreleri misafirin talep ETTİĞİ andan ölçülür;
    // SLA/eskalasyon/performans QR talepleri için de çalışır. Deterministik
    // kimlik (qr_{orderId}_{itemId}) → yeniden tetiklenme mükerrer üretmez.
    try {
      const bridge = orderBridge.buildOrderLogDocs(
        Object.assign({}, o, { guestName: stamped.guestName }),
        event.params.id,
        { guestId: stamped.guestId, stayId: stamped.stayId, guestName: stamped.guestName }
      );
      if (bridge.docs.length) {
        const lb = db.batch();
        bridge.docs.forEach((d) => lb.set(
          db.collection('guestLogs').doc(d.id),
          Object.assign({}, d.data, { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
          { merge: true }
        ));
        lb.update(snap.ref, { items: bridge.items });
        await lb.commit();
      }
    } catch (e) { console.error('order→log bridge failed', e); }

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

// ── Yeni teklif talebi → e-posta bildirimi ──────────────────────────
// hotizy.com'daki "Teklif Al" formu quoteRequests'e bir doküman yazınca
// (bkz. firestore.rules — herkese açık, alan-sınırlı create) platform
// operatörüne Resend üzerinden bir e-posta gönderilir. Firebase'in kendisi
// e-posta göndermiyor — Resend'in HTTP API'si kullanılıyor. Kurulum:
// docs/e-posta-bildirim-kurulum.md. RESEND_API_KEY henüz tanımlı değilse
// sessizce atlanır (quoteRequests yazımı hiçbir zaman buna bağımlı değil —
// süperadmin paneli e-postadan bağımsız olarak zaten canlı listeliyor).
const QUOTE_NOTIFY_EMAIL = 'bu.gol@outlook.com';
const QUOTE_NOTIFY_FROM = 'Hotizy <bildirim@hotizy.com>'; // hotizy.com Resend'de doğrulandı — artık herhangi bir alıcıya gönderilebilir

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

exports.onQuoteRequestCreate = onDocumentCreated(
  { document: 'quoteRequests/{id}', region: REGION, secrets: [RESEND_API_KEY] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const apiKey = RESEND_API_KEY.value();
    if (!apiKey) return; // henüz yapılandırılmadı — bkz. docs/e-posta-bildirim-kurulum.md

    const q = snap.data() || {};
    const subject = 'Yeni teklif talebi — ' + (q.hotel || q.name || 'İsimsiz');
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;">
        <h2 style="margin:0 0 14px;">Yeni Teklif Talebi</h2>
        <table style="border-collapse:collapse;width:100%;font-size:14px;">
          <tr><td style="color:#666;padding:4px 10px 4px 0;">Otel</td><td><b>${escapeHtml(q.hotel || '—')}</b></td></tr>
          <tr><td style="color:#666;padding:4px 10px 4px 0;">Yetkili</td><td>${escapeHtml(q.name || '—')}</td></tr>
          <tr><td style="color:#666;padding:4px 10px 4px 0;">E-posta</td><td>${escapeHtml(q.email || '—')}</td></tr>
          <tr><td style="color:#666;padding:4px 10px 4px 0;">Telefon</td><td>${escapeHtml(q.phone || '—')}</td></tr>
          <tr><td style="color:#666;padding:4px 10px 4px 0;">Oda sayısı</td><td>${escapeHtml(q.rooms || '—')}</td></tr>
          <tr><td style="color:#666;padding:4px 10px 4px 0;">Otel sayısı</td><td>${escapeHtml(q.hotels || '—')}</td></tr>
        </table>
        <p style="color:#666;margin:16px 0 4px;">Mesaj</p>
        <div style="white-space:pre-wrap;border:1px solid #e6eaf2;border-radius:8px;padding:12px;font-size:14px;">${escapeHtml(q.message || '(yok)')}</div>
        <p style="color:#999;font-size:12px;margin-top:18px;">Süperadmin panelinden görüntüleyip yanıtlayın: https://hotizy.com/superadmin</p>
      </div>`;

    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: QUOTE_NOTIFY_FROM, to: [QUOTE_NOTIFY_EMAIL], subject, html })
      });
      if (!resp.ok) console.error('quote email send failed', resp.status, await resp.text().catch(() => ''));
    } catch (e) {
      console.error('quote email send error', e);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// PMS INTEGRATION
// Per-hotel PMS config lives in pmsConfig/{tenantId} (superadmin-only via
// rules; the function reads it with the Admin SDK). Guest lookups are
// proxied here so the hotel's credentials never reach the browser and CORS
// is never an issue. Providers: 'mock' (demo, always works) and 'generic'
// (configurable REST adapter). 'generic' supports two auth shapes:
//   - authType 'apikey' (default, back-compat): static header (ör. otelin
//     verdiği sabit bir API anahtarı).
//   - authType 'oauth2': OAuth2 client-credentials akışı (ör. Oracle OPERA
//     Cloud/OHIP gibi süreli token isteyen sistemler) — token alınır,
//     süresine kadar önbelleklenir, süresi dolunca otomatik yenilenir.
// cfg.extraHeaders, sağlayıcının gerektirdiği sabit ek header'lar içindir
// (ör. OPERA'nın x-app-key'i) — auth türünden bağımsız, her zaman eklenir.
//
// Yalnızca OKUMA: bu adaptör hiçbir zaman PMS'e yazmaz (rezervasyon
// oluşturma/iptal yok) — kasıtlı bir kapsam sınırı, bkz. superadmin.js.
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

// Alan-seviyesi şifreleme (AES-256-GCM) — pmsConfig.apiKey / oauth2.clientSecret
// artık DÜZ METİN değil, bu master anahtarla (PMS_CRED_ENC_KEY) şifrelenmiş
// olarak saklanır. Çıktı "iv:tag:ciphertext" (üçü de base64) tek bir string.
// pmsDecrypt, bu üç parçalı biçimde OLMAYAN bir değeri (ör. henüz kaydedilmemiş,
// test edilmekte olan düz metin bir form girdisi, ya da göç öncesi eski bir
// kayıt) OLDUĞU GİBİ geri döner — hem geriye dönük uyumluluk hem de
// pmsTestConfig'in kaydedilmemiş form değerlerini şifresiz test edebilmesi
// için kasıtlı.
function pmsEncKeyBuf() {
  return crypto.createHash('sha256').update(PMS_CRED_ENC_KEY.value()).digest();
}
function pmsEncrypt(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', pmsEncKeyBuf(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}
function pmsDecrypt(blob) {
  if (!blob || typeof blob !== 'string') return blob || '';
  const parts = blob.split(':');
  if (parts.length !== 3) return blob; // şifreli biçimde değil — düz metin olarak kabul et
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', pmsEncKeyBuf(), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
  } catch (e) { return ''; } // yanlış anahtar/bozuk veri — sessizce boş dön (PMS 401'i olarak yüzeye çıkar)
}

// Tek bir HTTP denemesi, kendi zaman aşımı bütçesiyle.
async function pmsFetchOnce(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { headers, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
// Geçici hatalarda (ağ hatası veya 5xx) TEK bir yeniden deneme — harici otel
// PMS altyapısı sıkça daha az kararlı (genellikle on-prem/eski sistemler).
// Zaman aşımı (AbortError) veya 4xx'te tekrar denemek faydasız, o yüzden
// yalnızca bu iki sınıfta (ağ hatası, 5xx) tekrarlanır.
async function pmsFetchWithRetry(url, headers, timeoutMs) {
  try {
    const resp = await pmsFetchOnce(url, headers, timeoutMs);
    if (resp.status >= 500) {
      await new Promise((r) => setTimeout(r, 350));
      return pmsFetchOnce(url, headers, timeoutMs);
    }
    return resp;
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    await new Promise((r) => setTimeout(r, 350));
    return pmsFetchOnce(url, headers, timeoutMs);
  }
}

// PMS başarısızlıklarını yapılandırılmış şekilde logla — önceden yalnızca
// istemcinin genel bir catch'e düşmesiyle her şey sessizce kayboluyordu, ne
// personel ne süperadmin arızayı fark edebiliyordu. tenantId varsa (gerçek
// personel araması) mevcut errorLogs koleksiyonuna da yazılır — süperadmin
// panelinin "Hatalar" sekmesinde diğer istemci hatalarıyla birlikte görünür.
function logPmsFailure(tenantId, route, err) {
  const message = String((err && err.message) || err || 'bilinmeyen hata').slice(0, 500);
  console.error('[PMS]', route, tenantId || '(tenantsız/test)', message);
  if (!tenantId) return;
  db.collection('errorLogs').add({
    tenantId, level: 'error', message, stack: '', route, context: null,
    uid: null, username: 'PMS', userAgent: 'cloud-function',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
}

// Bellek-içi OAuth2 token önbelleği (aynı Cloud Functions instance'ı
// sıcakken tekrar tekrar token almayı önler). Kalıcı önbellek (soğuk
// başlangıçlar/instance'lar arası) için tenantId verildiğinde
// pmsConfig/{tenantId}._oauthCache kullanılır — bu alan yalnızca Admin
// SDK'dan yazılır/okunur, client'a hiç dönmez (pmsConfig zaten
// superadmin-only bir koleksiyon).
const oauthMemCache = new Map(); // key: tenantId || '_test' -> { token, expiresAt }

async function fetchOAuth2Token(oauth2) {
  if (!oauth2 || !oauth2.tokenUrl) throw new HttpsError('failed-precondition', 'OAuth2 token URL tanımlı değil.');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: oauth2.clientId || '',
    client_secret: oauth2.clientSecret || ''
  });
  if (oauth2.scope) body.set('scope', oauth2.scope);
  // Veri aramasındaki 7sn'lik zaman aşımı deseninin aynısı — önceden bu istek
  // hiç sınırlanmamıştı, PMS'in auth sunucusu asılırsa fonksiyon platform
  // varsayılanına (~60sn) kadar bloklanabiliyordu (bkz. tutarlılık denetimi).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  let resp;
  try {
    resp = await fetch(oauth2.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString(),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new HttpsError('unavailable', 'PMS OAuth2 token isteği başarısız: ' + (e.message || e.name));
  } finally { clearTimeout(timer); }
  if (!resp.ok) throw new HttpsError('unavailable', 'PMS OAuth2 token alınamadı: HTTP ' + resp.status);
  const data = await resp.json().catch(() => ({}));
  if (!data.access_token) throw new HttpsError('unavailable', 'PMS OAuth2 yanıtında access_token yok.');
  const expiresInMs = (Number(data.expires_in) || 300) * 1000;
  return { token: data.access_token, expiresAt: Date.now() + Math.max(30000, expiresInMs - 15000) };
}

async function getOAuth2Token(oauth2, tenantId) {
  const cacheKey = tenantId || '_test';
  const now = Date.now();
  const mem = oauthMemCache.get(cacheKey);
  if (mem && mem.expiresAt > now) return mem.token;

  if (tenantId) {
    try {
      const snap = await db.collection('pmsConfig').doc(tenantId).get();
      const cached = snap.exists ? (snap.data() || {})._oauthCache : null;
      if (cached && cached.expiresAt > now) {
        oauthMemCache.set(cacheKey, cached);
        return cached.token;
      }
    } catch (e) { /* önbellek okunamadı — sıfırdan token al */ }
  }

  const fresh = await fetchOAuth2Token(oauth2);
  oauthMemCache.set(cacheKey, fresh);
  if (tenantId) {
    db.collection('pmsConfig').doc(tenantId).set({ _oauthCache: fresh }, { merge: true }).catch(() => {});
  }
  return fresh.token;
}

// Run a lookup against a given config (used by both pmsLookup and the
// superadmin test). Returns a normalized array of guests. `tenantId` is
// only present for real (saved-config) calls — pmsTestConfig tests
// in-progress/unsaved form values and passes none, so OAuth2 tokens fetched
// during a test are only cached in-memory for that invocation.
async function pmsRunLookup(cfg, query, tenantId) {
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

  // generic REST adapter (statik anahtar VEYA OAuth2 client-credentials)
  if (provider === 'generic') {
    if (!cfg.baseUrl) throw new HttpsError('failed-precondition', 'PMS baseUrl tanımlı değil.');
    const path = (cfg.searchPath || '?q={q}').replace(/\{q\}/g, encodeURIComponent(q));
    const url = cfg.baseUrl.replace(/\/+$/, '') + (path.startsWith('/') || path.startsWith('?') ? path : '/' + path);
    const headers = { 'Accept': 'application/json' };

    if (cfg.authType === 'oauth2') {
      // cfg.oauth2.clientSecret Firestore'da şifreli — pmsDecrypt zaten
      // şifreli olmayan (ör. henüz kaydedilmemiş, test edilen) bir değeri
      // olduğu gibi geri döner, o yüzden burada kaynağın kaydedilmiş mi
      // yoksa taze mi olduğunu bilmemize gerek yok.
      const oauth2Cfg = Object.assign({}, cfg.oauth2, { clientSecret: pmsDecrypt(cfg.oauth2 && cfg.oauth2.clientSecret) });
      const token = await getOAuth2Token(oauth2Cfg, tenantId);
      headers[cfg.authHeader || 'Authorization'] = (cfg.authPrefix != null ? cfg.authPrefix : 'Bearer ') + token;
    } else if (cfg.apiKey) {
      headers[cfg.authHeader || 'Authorization'] = (cfg.authPrefix || '') + pmsDecrypt(cfg.apiKey);
    }
    if (cfg.extraHeaders && typeof cfg.extraHeaders === 'object') {
      Object.keys(cfg.extraHeaders).forEach((k) => {
        const v = cfg.extraHeaders[k];
        if (k && v) headers[k] = String(v);
      });
    }

    let data;
    try {
      const resp = await pmsFetchWithRetry(url, headers, 7000);
      if (!resp.ok) throw new HttpsError('unavailable', 'PMS yanıtı: HTTP ' + resp.status);
      data = await resp.json();
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('unavailable', 'PMS bağlantısı başarısız: ' + (e.message || e.name));
    }

    let arr = pmsDig(data, cfg.resultsPath);
    if (!Array.isArray(arr)) arr = Array.isArray(data) ? data : [];
    const results = arr.slice(0, 12).map(it => pmsNormalize(it, cfg.map)).filter(g => g.name || g.room);
    return { enabled: true, results, source: 'generic' };
  }

  return { enabled: true, results: [] };
}

// Hız sınırlama: mevcut _rateLimits deseni (getGuestName/fnbLoginGate'te
// olduğu gibi) — önceden pmsLookup'ta hiç yoktu. İki ayrı pencereli sayaç:
// tek bir personel hesabı (ele geçirilmişse) VE otelin tamamı (tüm personel
// toplamda) için — ikisi de otelin gerçek PMS API kotasını/maliyetini
// tüketebilecek toplu aramaya karşı (bkz. güvenlik denetimi).
const PMS_RATE_MAX_UID = 30;      // bir kullanıcı, pencere başına en fazla 30 arama
const PMS_RATE_MAX_TENANT = 90;   // bir otelin tüm personeli toplamda, pencere başına en fazla 90 arama

// Hotel users call this while typing a guest name / room number.
exports.pmsLookup = onCall({ region: REGION, timeoutSeconds: 20, secrets: [PMS_CRED_ENC_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const uid = request.auth.uid;
  const userSnap = await db.collection('systemUsers').doc(uid).get();
  if (!userSnap.exists) throw new HttpsError('permission-denied', 'Kullanıcı bulunamadı.');
  const tenantId = userSnap.data().tenantId;
  if (!tenantId) throw new HttpsError('failed-precondition', 'Kullanıcının oteli (tenant) tanımlı değil.'); // fail-closed

  if (!(await withinRateLimit('pms_uid_' + uid, PMS_RATE_MAX_UID))) {
    throw new HttpsError('resource-exhausted', 'Çok fazla PMS araması yaptınız. Lütfen birkaç dakika sonra tekrar deneyin.');
  }
  if (!(await withinRateLimit('pms_tenant_' + tenantId, PMS_RATE_MAX_TENANT))) {
    throw new HttpsError('resource-exhausted', 'Otel için PMS arama sınırı aşıldı. Lütfen birkaç dakika sonra tekrar deneyin.');
  }

  const cfgSnap = await db.collection('pmsConfig').doc(tenantId).get();
  if (!cfgSnap.exists) return { enabled: false, results: [] };
  try {
    return await pmsRunLookup(cfgSnap.data(), request.data && request.data.query, tenantId);
  } catch (e) {
    logPmsFailure(tenantId, 'pmsLookup', e);
    throw e;
  }
});

// Superadmin-only: validate a config (before saving) by running a live query.
// If `tenantId` is passed (testing an EXISTING hotel's already-saved config,
// as opposed to a brand-new/unsaved form), the outcome is persisted to
// pmsConfig/{tenantId}._lastTest so the modal can show "son test" next time
// it's opened without requiring another live call.
exports.pmsTestConfig = onCall({ region: REGION, timeoutSeconds: 20, secrets: [PMS_CRED_ENC_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (!su.exists) throw new HttpsError('permission-denied', 'Yalnızca platform operatörü.');
  const cfg = Object.assign({}, (request.data && request.data.config) || {});
  const query = (request.data && request.data.query) || 'a';
  const tenantId = (request.data && request.data.tenantId) || null;

  // superadmin.js artık kaydedilmiş secret'ları forma geri okumuyor (bkz.
  // openPmsModal) — alan boş bırakıldıysa ve zaten kaydedilmiş bir
  // yapılandırma varsa, o yapılandırmanın (hâlâ şifreli) secret'ı buraya
  // taşınır; pmsRunLookup'un tek decrypt adımı hem bunu hem taze/düz metin
  // test değerini doğru şekilde ele alır.
  let effectiveCfg = cfg;
  if (tenantId) {
    const existingSnap = await db.collection('pmsConfig').doc(tenantId).get();
    const existing = existingSnap.exists ? existingSnap.data() : null;
    if (existing) {
      if (!cfg.apiKey && existing.apiKey) effectiveCfg = Object.assign({}, effectiveCfg, { apiKey: existing.apiKey });
      if (cfg.authType === 'oauth2' && (!cfg.oauth2 || !cfg.oauth2.clientSecret) && existing.oauth2 && existing.oauth2.clientSecret) {
        effectiveCfg = Object.assign({}, effectiveCfg, { oauth2: Object.assign({}, cfg.oauth2, { clientSecret: existing.oauth2.clientSecret }) });
      }
    }
  }

  try {
    const result = await pmsRunLookup(Object.assign({}, effectiveCfg, { enabled: true }), query, tenantId);
    if (tenantId) {
      db.collection('pmsConfig').doc(tenantId).set({
        _lastTest: { ok: true, count: result.results.length, at: admin.firestore.FieldValue.serverTimestamp() }
      }, { merge: true }).catch(() => {});
    }
    return result;
  } catch (e) {
    if (tenantId) {
      db.collection('pmsConfig').doc(tenantId).set({
        _lastTest: { ok: false, message: String((e && e.message) || 'hata').slice(0, 200), at: admin.firestore.FieldValue.serverTimestamp() }
      }, { merge: true }).catch(() => {});
    }
    throw e;
  }
});

// Superadmin-only: persist a hotel's PMS config. apiKey/oauth2.clientSecret
// are encrypted here (never stored in plaintext, see PMS_CRED_ENC_KEY) — a
// blank secret field means "keep the existing one" (the client no longer
// reads secrets back to display them, see superadmin.js openPmsModal).
exports.pmsSaveConfig = onCall({ region: REGION, secrets: [PMS_CRED_ENC_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (!su.exists) throw new HttpsError('permission-denied', 'Yalnızca platform operatörü.');
  const tenantId = (request.data && request.data.tenantId) || '';
  if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId gerekli.');
  const cfg = (request.data && request.data.config) || {};

  const ref = db.collection('pmsConfig').doc(tenantId);
  const existing = (await ref.get()).data() || {};

  const out = {
    enabled: !!cfg.enabled,
    presetId: String(cfg.presetId || ''),
    provider: cfg.provider === 'generic' ? 'generic' : 'mock',
    authType: cfg.authType === 'oauth2' ? 'oauth2' : 'apikey',
    baseUrl: String(cfg.baseUrl || '').slice(0, 300),
    searchPath: String(cfg.searchPath || '').slice(0, 200),
    resultsPath: String(cfg.resultsPath || '').slice(0, 200),
    authHeader: String(cfg.authHeader || 'Authorization').slice(0, 80),
    authPrefix: String(cfg.authPrefix || '').slice(0, 40),
    extraHeaders: (cfg.extraHeaders && typeof cfg.extraHeaders === 'object') ? cfg.extraHeaders : {},
    map: (cfg.map && typeof cfg.map === 'object') ? cfg.map : {},
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  const newApiKey = String(cfg.apiKey || '').trim();
  out.apiKey = newApiKey ? pmsEncrypt(newApiKey) : (existing.apiKey || '');

  if (out.authType === 'oauth2') {
    const o = cfg.oauth2 || {};
    const newSecret = String(o.clientSecret || '').trim();
    out.oauth2 = {
      tokenUrl: String(o.tokenUrl || '').slice(0, 300),
      clientId: String(o.clientId || '').slice(0, 200),
      clientSecret: newSecret ? pmsEncrypt(newSecret) : ((existing.oauth2 && existing.oauth2.clientSecret) || ''),
      scope: String(o.scope || '').slice(0, 200)
    };
  } else {
    out.oauth2 = null;
  }

  await ref.set(out, { merge: true });
  // Cheap client gate lives on the tenant doc (hotel users can read it).
  await db.collection('tenants').doc(tenantId).update({ pmsEnabled: out.enabled });
  return { ok: true };
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
  'restMenu', 'restChecks', 'folioCharges', 'issueTopics', 'guestMenus', 'errorLogs',
  // Restoran sertleştirme + kimlik migrasyonu koleksiyonları — tenant
  // silmede bunlar da temizlenmeli (bkz. restoran denetimi Z10): aksi
  // halde slug yeniden kullanıldığında hayalet masa kilitleri kalıyordu.
  'restTables', 'restSessions', 'restOps', 'restAudit', 'stays', 'migrationReview'
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

// Otel admin'i kendi personelinin şifresini GERÇEKTEN geçersiz kılar (yeni
// rastgele bir geçici şifre üretip Auth'a yazar + oturum token'larını iptal
// eder). Öncesinde admin.js yalnızca bir `mustChangePassword` bayrağı
// yazıyordu — eski şifre kullanıcı elle değiştirene kadar tamamen geçerli
// kalıyordu; bkz. auth denetimi. Superadmin değil, YALNIZCA hedef
// kullanıcıyla aynı tenant'ın admin'i çağırabilir (client'ın önceki
// doğrudan-Firestore-yazma yetkisiyle aynı sınır, artık sunucuda uygulanıyor
// çünkü Admin SDK şifre değişikliği Firestore kurallarından geçmiyor).
function randomTempPassword() {
  return 'H' + crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9);
}
// Çağıranın, hedef kullanıcıyla AYNI tenant'ın admin'i olduğunu doğrular
// (superadmin değil — bu, hotel admin'in kendi personeli üzerindeki mevcut
// yetkisiyle aynı sınır, yalnızca Admin SDK gerektiren işlemler için sunucu
// tarafına taşındı). Hedef kullanıcının systemUsers verisini döndürür.
async function requireTenantAdminFor(request, targetUid) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  if (!targetUid || typeof targetUid !== 'string') {
    throw new HttpsError('invalid-argument', 'Kullanıcı kimliği gerekli.');
  }
  const targetSnap = await db.collection('systemUsers').doc(targetUid).get();
  if (!targetSnap.exists) throw new HttpsError('not-found', 'Kullanıcı bulunamadı.');

  // Süperadmin (platform operatörü) her tenant'taki her kullanıcıyı
  // sıfırlayabilir/oturumunu iptal edebilir — bir otelin TEK admin'i kendi
  // şifresini unuttuğunda, o otel içinde onu sıfırlayacak kimse
  // kalmadığından bu bir kaçış kapısı olarak gerekli.
  const superSnap = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (superSnap.exists) return targetSnap.data();

  const callerSnap = await db.collection('systemUsers').doc(request.auth.uid).get();
  if (!callerSnap.exists || (callerSnap.data().role || '').toLowerCase() !== 'admin') {
    throw new HttpsError('permission-denied', 'Yalnızca otel yöneticisi veya platform operatörü bu işlemi yapabilir.');
  }
  if (targetSnap.data().tenantId !== callerSnap.data().tenantId) {
    throw new HttpsError('permission-denied', 'Bu kullanıcı sizin otelinize ait değil.');
  }
  return targetSnap.data();
}
exports.resetUserPassword = onCall({ region: REGION }, async (request) => {
  const targetUid = request.data && request.data.uid;
  await requireTenantAdminFor(request, targetUid);
  const tempPassword = randomTempPassword();
  await admin.auth().updateUser(targetUid, { password: tempPassword });
  await admin.auth().revokeRefreshTokens(targetUid); // aktif oturumları da hemen sonlandır
  await db.collection('systemUsers').doc(targetUid).update({
    mustChangePassword: true,
    passwordResetAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { tempPassword };
});

// Bir personelin rolü düşürüldüğünde/değiştirildiğinde aktif oturum
// token'larını iptal eder. Bu uygulamada Firestore kuralları rolü HER
// SEFERİNDE canlı olarak systemUsers'tan okuduğundan yazma yetkisi zaten
// aninda güncel role göre uygulanıyor — bu çağrı ek bir sertleştirme:
// aksi halde ~1 saate kadar geçerli kalabilecek mevcut ID token'ın süresi
// dolduğunda YENİLENEMEMESİNİ sağlar (bkz. auth denetimi).
exports.revokeUserSessions = onCall({ region: REGION }, async (request) => {
  const targetUid = request.data && request.data.uid;
  await requireTenantAdminFor(request, targetUid);
  await admin.auth().revokeRefreshTokens(targetUid);
  return { revoked: true };
});

// ── Misafir tenant claim'i (anonim oturuma DOĞRULANMIŞ otel kimliği) ────
// Anonim misafir Auth token'ında hangi otele ait olduğuna dair hiçbir bilgi
// yok — client'ın window.location.hostname'den okuyup iddia ettiği tenant
// güvenilemez (biri doğrudan SDK çağrısıyla farklı bir tenant iddia edebilir).
// Cloudflare Worker (cloudflare/hotizy-subdomain-proxy.js) GERÇEK gelen
// subdomain'i HMAC ile imzalayıp X-Hotizy-Tenant-* header'ları olarak iletir;
// bu fonksiyon imzayı doğrulayıp doğrulanmış tenant'ı bir Firebase Auth
// custom claim'i olarak yazar. firestore.rules sonra bu claim'i kullanarak
// misafirin gerçekten o otelin subdomain'inden geldiğini teyit eder.
//
// ÖNEMLİ: onCall DEĞİL onRequest — Functions SDK'nın httpsCallable() çağrısı
// doğrudan cloudfunctions.net'e gider, Cloudflare Worker'ı ATLAR. Bu yüzden
// bu fonksiyon yalnızca bir Hosting rewrite'ı (/api/mint-guest-claim,
// firebase.json) üzerinden, aynı origin'den (hotizy.com) çağrılmalı — ancak
// o zaman istek Worker'dan geçip imzalı header'ları taşır.
//
// Secret henüz tanımlı değilse veya imza doğrulanamazsa istek reddedilir;
// client (guest-order.js) bunu best-effort çağırır ve hatayı yutar — claim
// yoksa firestore.rules eski (claim'siz) davranışa düşer, hiçbir şey kırılmaz.
exports.mintGuestClaim = onRequest({ region: REGION, secrets: [TENANT_SIG_SECRET] }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  try {
    const authHeader = String(req.headers.authorization || '');
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) { res.status(401).json({ error: 'Giriş gerekli.' }); return; }
    const decoded = await admin.auth().verifyIdToken(idToken);

    const host = req.headers['x-hotizy-tenant-host'];
    const ts = req.headers['x-hotizy-tenant-ts'];
    const sig = req.headers['x-hotizy-tenant-sig'];
    if (!host || !ts || !sig) { res.status(412).json({ error: 'Doğrulanabilir subdomain bulunamadı.' }); return; }
    const age = Date.now() - Number(ts);
    if (!(age >= 0 && age < 5 * 60 * 1000)) { res.status(412).json({ error: 'İmza süresi doldu.' }); return; }

    const expected = crypto.createHmac('sha256', TENANT_SIG_SECRET.value())
      .update(String(host) + '.' + String(ts)).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(sig), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Geçersiz imza.' });
      return;
    }

    const parts = String(host).toLowerCase().split('.');
    const tenantId = (parts.length >= 3 && parts[0] !== 'www' && parts[0] !== 'app') ? parts[0] : null;
    if (!tenantId || !/^[a-z0-9-]{2,24}$/.test(tenantId)) {
      res.status(412).json({ error: 'Alt alan adından otel çözülemedi.' });
      return;
    }

    await admin.auth().setCustomUserClaims(decoded.uid, { tenantId });
    res.json({ ok: true, tenantId });
  } catch (e) {
    res.status(500).json({ error: e.message || 'hata' });
  }
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

// ── Hız sınırlama: getGuestName/getGuestStay kimlik doğrulaması gerektirmez
//    (misafir henüz "doğrulanmadan" çağırıyor), bu yüzden kötüye kullanıma
//    karşı tek savunma budur. İki ayrı pencereli sayaç paylaşılır: IP başına
//    (kaynak rotasyonuna karşı) ve hedef oda başına (tek bir odaya karşı
//    otomatik soyadı denemesine karşı) — ikisi de aşılırsa istek reddedilir.
//    Firestore transaction ile atomik; `_rateLimits` yalnızca Admin SDK'dan
//    yazıldığından ayrı bir kural gerekmez (client'a hiç açık değil).
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 dakikalık kayan pencere
const RATE_MAX_IP = 20;                // bir IP, pencere başına iki fonksiyon toplamı en fazla 20 deneme
const RATE_MAX_TARGET = 8;             // aynı (tenant+oda) hedefi, pencere başına en fazla 8 deneme

function callerIp(request) {
  const req = request.rawRequest;
  if (!req) return 'unknown';
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || 'unknown';
}
async function withinRateLimit(key, max) {
  const ref = db.collection('_rateLimits').doc(key);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    if (cur && cur.windowStart && (now - cur.windowStart) < RATE_WINDOW_MS) {
      if (cur.count >= max) return false;
      tx.update(ref, { count: admin.firestore.FieldValue.increment(1) });
    } else {
      tx.set(ref, { windowStart: now, count: 1 });
    }
    return true;
  });
}
// İki misafir-arama fonksiyonu aynı bütçeyi paylaşır (aksi halde biri
// tükenince diğerine geçilip sınır iki katına çıkarılabilirdi).
async function checkGuestLookupRateLimit(request, tenant, room) {
  const ip = callerIp(request);
  const ipOk = await withinRateLimit('glookup_ip_' + ip, RATE_MAX_IP);
  if (!ipOk) return false;
  return withinRateLimit('glookup_target_' + tenant + '_' + room, RATE_MAX_TARGET);
}

// ── F&B girişi hız sınırlama ─────────────────────────────────────────
// F&B personeli yalnızca 5 haneli bir kod giriyor; türetilen Firebase Auth
// şifresi sabit bir önekle ('FB' + kod) yalnızca 100.000 kombinasyon —
// uygulama seviyesinde bir deneme sınırı olmadan brute-force edilebilir
// (bkz. auth denetimi). Client, gerçek signInWithEmailAndPassword
// çağrısından ÖNCE bu kapıyı çağırır; yukarıdaki _rateLimits mekanizmasını
// (aynı withinRateLimit/callerIp yardımcıları) paylaşır, kendi anahtar
// alanını kullanır. Kodun doğru olup olmadığını YANSITMAZ — yalnızca
// deneme hızını sınırlar.
const FNB_RATE_MAX_TARGET = 6;  // aynı (tenant+kod) hedefi, pencere başına en fazla 6 deneme
const FNB_RATE_MAX_IP = 15;     // bir IP, pencere başına en fazla 15 deneme (farklı kodlar dahil)
exports.fnbLoginGate = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const tenant = String(d.tenant || '').trim().toLowerCase().slice(0, 40);
  const code = String(d.code || '').trim().slice(0, 10);
  if (!tenant || !/^\d{5}$/.test(code)) return { allowed: false };
  const ip = callerIp(request);
  const ipOk = await withinRateLimit('fnb_ip_' + ip, FNB_RATE_MAX_IP);
  if (!ipOk) return { allowed: false };
  const targetOk = await withinRateLimit('fnb_target_' + tenant + '_' + code, FNB_RATE_MAX_TARGET);
  return { allowed: targetOk };
});

// ── Şifremi Unuttum ───────────────────────────────────────────────────
// Personel sentetik bir e-postayla (kullanici@oteladi.com) giriş yapıyor —
// bu gerçek bir kutuya gitmediğinden standart e-posta bazlı sıfırlama linki
// burada işe yaramaz. Bunun yerine: kullanıcı adı + otel bulunur, o otelin
// admin'lerine MEVCUT bildirim sistemiyle (notifications → onNotificationCreate
// push tetikler) bir bildirim gönderilir; admin panelden resetUserPassword
// ile gerçek bir sıfırlama yapıp yeni şifreyi çalışana iletir. Kimlik
// doğrulaması gerektirmez (login ekranında henüz giriş yapılmamış); kullanıcı
// adının var/yok olduğu bilgisini SIZDIRMAMAK için HER ZAMAN aynı jenerik
// yanıtı döner. Hız sınırlı — aksi halde biri var olan kullanıcı adlarını
// deneyerek adminleri bildirim spam'ine boğabilirdi.
const FORGOT_RATE_MAX_TARGET = 3;  // aynı (tenant+kullanıcı adı), pencere başına en fazla 3 istek
const FORGOT_RATE_MAX_IP = 10;     // bir IP, pencere başına en fazla 10 istek
exports.forgotPasswordRequest = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const tenant = String(d.tenant || '').trim().toLowerCase().slice(0, 40);
  const username = String(d.username || '').trim().toLowerCase().slice(0, 60);
  const generic = { ok: true }; // her koşulda aynı yanıt — kullanıcı adı sızdırma yok
  if (!tenant || !username) return generic;

  try {
    const ip = callerIp(request);
    if (!(await withinRateLimit('forgot_ip_' + ip, FORGOT_RATE_MAX_IP))) return generic;
    if (!(await withinRateLimit('forgot_target_' + tenant + '_' + username, FORGOT_RATE_MAX_TARGET))) return generic;

    const userQ = await db.collection('systemUsers')
      .where('tenantId', '==', tenant).where('username', '==', username).limit(1).get();
    if (userQ.empty) return generic;
    const targetId = userQ.docs[0].id;

    const adminsQ = await db.collection('systemUsers')
      .where('tenantId', '==', tenant).where('role', '==', 'admin').get();
    if (adminsQ.empty) return generic; // gönderecek admin yok (ör. tek admin kendisi unuttu)

    const batch = db.batch();
    let any = false;
    adminsQ.forEach((adminDoc) => {
      if (adminDoc.id === targetId) return; // kendine bildirim yok
      any = true;
      const ref = db.collection('notifications').doc();
      batch.set(ref, {
        toUid: adminDoc.id,
        toUsername: (adminDoc.data() || {}).username || '',
        title: '🔑 Şifre sıfırlama isteği',
        body: username + ' giriş yapamıyor, şifresini sıfırlamanız gerekiyor.',
        recordId: targetId,
        type: 'passwordReset',
        fromUid: 'system',
        fromUsername: 'Sistem',
        tenantId: tenant,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    if (any) await batch.commit();
  } catch (e) {
    console.error('forgotPasswordRequest error', e);
  }
  return generic;
});

exports.getGuestName = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const tenant = String(d.tenant || '').trim().toLowerCase().slice(0, 40);
  const room = String(d.room || '').trim().slice(0, 40);
  const surname = String(d.surname || '').trim().slice(0, 60);
  if (!tenant || !room || !surname) return { ok: false };
  if (!(await checkGuestLookupRateLimit(request, tenant, room))) return { ok: false };

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
  if (!(await checkGuestLookupRateLimit(request, tenant, room))) return { ok: false };

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
//        https://hotizy.com/api/lemon-webhook
//      (veya doğrudan https://us-central1-panel-d25c9.cloudfunctions.net/lemonWebhook)
// ═══════════════════════════════════════════════════════════════════

// Fiyatlandırma sayfasındaki hesap ile birebir (js/utils/pricing.js).
const LS_PLANS = {
  starter:    { base: 49,  perRoom: 0.8, inclMods: 1, allMods: false },
  pro:        { base: 99,  perRoom: 1.2, inclMods: 2, allMods: false },
  enterprise: { base: 199, perRoom: 1.5, inclMods: 4, allMods: true }
};
const LS_PMS = 99, LS_EXTRA = 19, LS_DISCOUNT = 0.18, LS_MIN_ROOMS = 25, LS_MAX_ROOMS = 500;

// Sitedeki tüm fiyatlar KDV hariç gösterilir; Lemon Squeezy ödeme ekranında
// gerçek tahsilat için üstüne KDV eklenir (muhasebedeki "amount" alanı KDV
// hariç kalır — devlete ödenecek KDV, şirket cirosu değildir).
const VAT_RATE = 0.20;
function withVat(eur) { return Math.round(eur * (1 + VAT_RATE) * 100) / 100; }

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
    const price = configuredPlanPrice(plan, cfg); // EUR, KDV hariç
    const priceWithVat = withVat(price);
    const oid = 'LS' + tenantId.replace(/[^a-zA-Z0-9]/g, '') + Date.now();
    await db.collection('payments').doc(oid).set({
      oid, tenantId, plan, amount: price, amountWithVat: priceWithVat, vatRate: VAT_RATE,
      currency: 'EUR', status: 'pending',
      provider: 'lemonsqueezy', cycle: 'monthly', createdBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    try {
      const url = await lsCreateCheckout({
        apiKey, storeId: ls.storeId, variantId, priceCents: Math.round(priceWithVat * 100),
        email: user.email || '', name: tenant.name || user.username || 'Hotizy',
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
      const quote = computeQuoteEUR(plan, b.rooms, modsCount, !!b.pms, cycle); // KDV hariç
      const totalWithVat = withVat(quote.total);

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
      const email = String(buyer.email || '').trim().slice(0, 160);
      const buyerName = String(buyer.name || '').trim().slice(0, 120);
      const buyerHotel = String(buyer.hotel || '').trim().slice(0, 120);
      const oid = 'LSC' + Date.now() + Math.floor(Math.random() * 1000);
      await db.collection('lemonOrders').doc(oid).set({
        oid, plan, cycle, rooms: quote.rooms, mods: Array.isArray(b.mods) ? b.mods : [], pms: !!b.pms,
        amount: quote.total, amountWithVat: totalWithVat, vatRate: VAT_RATE,
        currency: 'EUR', status: 'pending', provider: 'lemonsqueezy',
        buyer: { email, name: buyerName, hotel: buyerHotel },
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const url = await lsCreateCheckout({
        apiKey, storeId: ls.storeId, variantId, priceCents: Math.round(totalWithVat * 100),
        email, name: buyerName,
        custom: strMap({ plan, cycle, oid, rooms: quote.rooms, signup: '1' }),
        redirectUrl: BASE_URL + '/payment-result.html?status=ok&provider=lemon'
      });
      res.json({ url, oid, amount: quote.total, amountWithVat: totalWithVat, cycle });
    } catch (e) {
      // e.message, Lemon Squeezy'nin ham API hata gövdesini (lsCreateCheckout
      // içinde data.errors[0].detail) içerebilir — herkese açık, kimliksiz bir
      // uca asla döndürülmez; bkz. güvenlik denetimi.
      console.error('lemonCheckout error', e);
      res.status(500).json({ error: 'Ödeme başlatılamadı. Lütfen daha sonra tekrar deneyin.' });
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

      const months = String(custom.cycle || 'monthly') === 'annual' ? 12 : 1;
      const tenantId = custom.tenant_id ? String(custom.tenant_id) : '';
      const oid = custom.oid ? String(custom.oid) : '';

      // İdempotans kilidi (lemonEvents) ARTIK iş mantığıyla (abonelik uzatma +
      // ödeme kaydı) AYNI transaction içinde commit ediliyor. Önceki sürümde
      // kilit, TÜM iş mantığından ÖNCE, kendi ayrı transaction'ında yazılıyordu
      // — bilinçli olarak dedup için, ama tam da bu yüzden kısmi bir hatayı
      // geri dönülemez kılıyordu: kilit yazıldıktan hemen sonra abonelik
      // güncellemesi başarısız olursa, Lemon Squeezy'nin sonraki HER
      // yeniden denemesi kilidi bulup 200 "dup" alıyor, sağlayıcı "teslim
      // edildi" sanıp bir daha asla denemiyordu — ödeme alınmış ama abonelik
      // hiç uzamamış (bkz. tutarlılık denetimi). Şimdi ya HEPSİ ya HİÇBİRİ
      // commit edilir; gerçek bir hata olursa fonksiyon 500 döner ve Lemon
      // Squeezy'nin kendi yeniden deneme mekanizması işi gerçekten tekrar dener.
      const evRef = db.collection('lemonEvents').doc(event + '_' + dataId);
      const fresh = await db.runTransaction(async (tx) => {
        const s = await tx.get(evRef);
        if (s.exists) return false;

        let tRef = null, tSnap = null;
        if (tenantId) {
          tRef = db.collection('tenants').doc(tenantId);
          tSnap = await tx.get(tRef); // tüm okumalar yazımlardan önce
        }

        tx.set(evRef, { event, dataId, at: admin.firestore.FieldValue.serverTimestamp() });

        if (tRef) {
          const now = new Date();
          let base = now;
          if (tSnap.exists && tSnap.data().subscriptionEnd) {
            const cur = tSnap.data().subscriptionEnd.toDate();
            if (cur > now) base = cur;
          }
          const newEnd = new Date(base);
          newEnd.setMonth(newEnd.getMonth() + months);
          tx.set(tRef, {
            subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd), suspended: false
          }, { merge: true });
          if (oid) tx.set(db.collection('payments').doc(oid), {
            status: 'success', paidAt: admin.firestore.FieldValue.serverTimestamp(), lemonId: dataId
          }, { merge: true });
        } else if (oid) {
          // Fiyatlandırma sayfasından yeni kayıt → operatör otelin kurulumunu yapar.
          tx.set(db.collection('lemonOrders').doc(oid), {
            status: 'success', paidAt: admin.firestore.FieldValue.serverTimestamp(),
            lemonId: dataId, buyerEmail: attr.user_email || ''
          }, { merge: true });
        }
        return true;
      });
      if (!fresh) { res.status(200).send('dup'); return; }

      res.status(200).send('OK');
    } catch (e) {
      // Hangi olay/otel için başarısız olduğu yapılandırılmış olarak
      // loglanır — önceden yalnızca genel bir "error" vardı (bkz. denetim).
      console.error('lemonWebhook error', {
        event: (req.body && req.body.meta && req.body.meta.event_name) || null,
        tenantId: (req.body && req.body.meta && req.body.meta.custom_data && req.body.meta.custom_data.tenant_id) || null,
        oid: (req.body && req.body.meta && req.body.meta.custom_data && req.body.meta.custom_data.oid) || null,
        message: e && e.message
      });
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

// ── Kimlik migrasyonu backfill'i: eski kayıtlara guestId/stayId damgala ──
// Misafir adı + oda numarası kimlik OLARAK kullanılmayı bırakıyor (bkz.
// js/core/guest-directory.js): guestId kişiyi, stayId tek bir konaklamayı
// tanımlar; isim/oda yalnızca gösterim snapshot'ı. Bu fonksiyon (superadmin,
// tenant başına çalıştırılır):
//   1) guestDirectory'den stays açar: in_house/pre_arrival → aktif stay
//      (activeStayId işaretlenir); checked_out → kapalı tarihçe stay'i
//      (guest dokümanına stayBackfilled konur — idempotens).
//   2) guestLogs/reservations/guestOrders/folioCharges/restChecks içinde
//      guestId'siz kayıtları normalize edilmiş İSİM eşleşmesiyle damgalar.
//      stayId yalnızca kayıt tarihi konaklamanın checkIn/checkOut penceresine
//      düşüyorsa (veya konaklama hâlâ açıksa) eklenir.
//   3) Eşleşmeyen veya BİRDEN FAZLA misafire eşleşen kayıtlar ASLA tahmin
//      edilmez — migrationReview kuyruğuna yazılır (deterministik doc id:
//      tekrar çalıştırma mükerrer kuyruk kaydı üretmez). İsimsiz ve odasız
//      kayıtlar (ör. walk-in adisyonlar) misafire bağlı değildir, atlanır.
// İdempotent: guestId'si zaten olan dokümanlara dokunmaz. İsim-bazlı
// geri-düşüş, bu backfill + kuyruk temizliği bitene KADAR istemcilerde kalır.
const IDENTITY_COLS = [
  { col: 'guestLogs', nameField: 'guestName' },
  { col: 'reservations', nameField: 'guestName' },
  { col: 'guestOrders', nameField: 'guestName' },
  { col: 'folioCharges', nameField: 'guestName' },
  { col: 'restChecks', nameField: 'name' }
];
function trLower(s) { return String(s || '').trim().toLocaleLowerCase('tr-TR'); }
async function backfillGuestIdentityForTenant(tenant) {
  // 1) Misafirler + stays
  const guestSnap = await db.collection('guestDirectory').where('tenantId', '==', tenant).get();
  const guests = guestSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  let staysCreated = 0;
  for (const g of guests) {
    const active = g.status === 'in_house' || g.status === 'pre_arrival';
    if (active && !g.activeStayId) {
      const ref = await db.collection('stays').add({
        tenantId: tenant, guestId: g.id, guestName: g.name || '',
        room: g.room || '', checkIn: g.checkIn || '', checkOut: g.checkOut || '',
        status: g.status, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('guestDirectory').doc(g.id).update({ activeStayId: ref.id });
      g.activeStayId = ref.id; staysCreated++;
    } else if (!active && !g.stayBackfilled) {
      const ref = await db.collection('stays').add({
        tenantId: tenant, guestId: g.id, guestName: g.name || '',
        room: g.room || '', checkIn: g.checkIn || '', checkOut: g.checkOut || '',
        status: 'checked_out', createdAt: admin.firestore.FieldValue.serverTimestamp(),
        checkedOutAt: admin.firestore.FieldValue.serverTimestamp(), checkedOutBy: 'backfill'
      });
      await db.collection('guestDirectory').doc(g.id).update({ stayBackfilled: true });
      g._backfillStayId = ref.id; staysCreated++;
    }
  }
  // Guest başına bilinen stay (backfill en fazla bir tane açar/işaretler).
  const stayOf = {};
  guests.forEach((g) => {
    const sid = g.activeStayId || g._backfillStayId || null;
    if (sid) stayOf[g.id] = { stayId: sid, checkIn: g.checkIn || '', checkOut: g.checkOut || '', open: !!g.activeStayId };
  });
  // İsim indeksi — aynı normalize isim birden çok profile denk geliyorsa belirsizdir.
  const nameIndex = {};
  guests.forEach((g) => {
    const k = trLower(g.name); if (!k) return;
    (nameIndex[k] = nameIndex[k] || []).push(g);
  });

  function stayIdFor(guest, createdAt) {
    const s = stayOf[guest.id];
    if (!s) return null;
    if (s.open && !s.checkIn && !s.checkOut) return s.stayId; // açık, penceresiz — kabul
    const t = createdAt && createdAt.toDate ? createdAt.toDate() : null;
    if (!t) return s.open ? s.stayId : null;
    const day = t.toISOString().slice(0, 10);
    if (s.checkIn && day < s.checkIn) return null;
    if (s.checkOut && day > s.checkOut) return null;
    return s.stayId;
  }

  // 2) Koleksiyonları damgala
  const result = { staysCreated };
  for (const { col, nameField } of IDENTITY_COLS) {
    let scanned = 0, stamped = 0, queued = 0, skipped = 0, last = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = db.collection(col).where('tenantId', '==', tenant)
        .orderBy(admin.firestore.FieldPath.documentId()).limit(400);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      const batch = db.batch();
      let n = 0;
      snap.forEach((doc) => {
        scanned++;
        const dd = doc.data() || {};
        if (dd.guestId) return; // zaten damgalı — idempotens
        const key = trLower(dd[nameField]);
        const room = String(dd.room || '').trim();
        if (!key) {
          // İsimsiz: odası da yoksa misafire bağlı bir kayıt değil (walk-in) — atla.
          // Odası varsa isimsiz eşleştirme tahmin olur — inceleme kuyruğuna.
          if (!room) { skipped++; return; }
          batch.set(db.collection('migrationReview').doc(col + '_' + doc.id), {
            tenantId: tenant, collection: col, docId: doc.id,
            guestName: '', room, reason: 'no-name', candidates: [],
            status: 'open', createdAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          queued++; n++;
          return;
        }
        const matches = nameIndex[key] || [];
        if (matches.length === 1) {
          const g = matches[0];
          const upd = { guestId: g.id };
          const sid = stayIdFor(g, dd.createdAt);
          if (sid) upd.stayId = sid;
          batch.update(doc.ref, upd);
          stamped++; n++;
        } else {
          batch.set(db.collection('migrationReview').doc(col + '_' + doc.id), {
            tenantId: tenant, collection: col, docId: doc.id,
            guestName: dd[nameField] || '', room,
            reason: matches.length ? 'ambiguous' : 'no-match',
            candidates: matches.map((g) => g.id),
            status: 'open', createdAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          queued++; n++;
        }
      });
      if (n) await batch.commit();
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < 400) break;
    }
    result[col] = { scanned, stamped, queued, skipped };
  }
  return { tenant, result };
}
// Tenant belirtilmezse tenants koleksiyonundaki TÜM oteller sırayla işlenir
// (idempotent olduğundan tekrar çalıştırmak güvenli). Tek otel için
// {tenant: '<slug>'} hâlâ geçerli.
exports.backfillGuestIdentity = onCall({ region: REGION, timeoutSeconds: 540 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (!su.exists) throw new HttpsError('permission-denied', 'Yalnızca platform operatörü.');
  const one = (request.data && typeof request.data.tenant === 'string' && /^[a-z0-9-]{2,24}$/.test(request.data.tenant))
    ? request.data.tenant : null;
  const tenants = one ? [one] : (await db.collection('tenants').get()).docs.map((d) => d.id);
  if (!tenants.length) throw new HttpsError('failed-precondition', 'Hiç otel (tenant) bulunamadı.');
  const results = [];
  for (const t of tenants) results.push(await backfillGuestIdentityForTenant(t));
  return { ok: true, tenants: tenants.length, results };
});

// ── İnceleme kuyruğu çözümü ──────────────────────────────────────────
// migrationReview'deki bir kaydı süperadmin panelinden çözer:
//   action 'assign'  → hedef doküman seçilen misafirin guestId'siyle
//     damgalanır (stayId, misafirin konaklamalarından tarih penceresi
//     TEK bir stay'e oturuyorsa eklenir — yine tahmin yok); kuyruk kaydı
//     'resolved' olur.
//   action 'dismiss' → kayıt misafire bağlı değildir (ör. walk-in);
//     kuyruk kaydı 'dismissed' olur, hedef dokümana dokunulmaz.
// Sunucu tarafında (Admin SDK) yazılır — guestOrders gibi istemci
// kurallarının süperadmine izin vermediği koleksiyonlar da kapsanır.
exports.resolveMigrationReview = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  if (!su.exists) throw new HttpsError('permission-denied', 'Yalnızca platform operatörü.');
  const d = request.data || {};
  const reviewId = String(d.reviewId || '');
  const action = d.action === 'dismiss' ? 'dismiss' : 'assign';
  if (!reviewId) throw new HttpsError('invalid-argument', 'reviewId gerekli.');

  const revRef = db.collection('migrationReview').doc(reviewId);
  const revSnap = await revRef.get();
  if (!revSnap.exists) throw new HttpsError('not-found', 'Kuyruk kaydı bulunamadı.');
  const rev = revSnap.data();
  if (rev.status !== 'open') throw new HttpsError('failed-precondition', 'Bu kayıt zaten çözülmüş.');

  if (action === 'dismiss') {
    await revRef.update({
      status: 'dismissed',
      resolvedBy: request.auth.uid,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true, action: 'dismiss' };
  }

  const guestId = String(d.guestId || '');
  if (!guestId) throw new HttpsError('invalid-argument', 'assign için guestId gerekli.');
  const guestSnap = await db.collection('guestDirectory').doc(guestId).get();
  if (!guestSnap.exists) throw new HttpsError('not-found', 'Misafir bulunamadı.');
  const guest = guestSnap.data();
  if (guest.tenantId !== rev.tenantId) throw new HttpsError('invalid-argument', 'Misafir farklı bir otele ait.');

  const targetRef = db.collection(rev.collection).doc(rev.docId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    // Hedef silinmiş — kuyruğu kapat, yapılacak iş yok.
    await revRef.update({ status: 'dismissed', resolvedBy: request.auth.uid, resolvedAt: admin.firestore.FieldValue.serverTimestamp(), note: 'hedef doküman silinmiş' });
    return { ok: true, action: 'target-gone' };
  }

  const upd = { guestId };
  // stayId: misafirin konaklamaları içinde hedefin oluşturulma tarihi TEK
  // bir stay'in penceresine düşüyorsa bağla — birden fazlaysa bağlama.
  try {
    const staysSnap = await db.collection('stays')
      .where('tenantId', '==', rev.tenantId).where('guestId', '==', guestId).get();
    const created = targetSnap.data().createdAt;
    const day = (created && created.toDate) ? created.toDate().toISOString().slice(0, 10) : null;
    const fits = staysSnap.docs.filter((s) => {
      const sd = s.data();
      if (!day) return sd.status !== 'checked_out'; // tarihsiz hedef → yalnızca açık stay
      if (sd.checkIn && day < sd.checkIn) return false;
      if (sd.checkOut && day > sd.checkOut) return false;
      return true;
    });
    if (fits.length === 1) upd.stayId = fits[0].id;
  } catch (e) { /* stay bağlanamadı — guestId yeterli */ }

  await targetRef.update(upd);
  await revRef.update({
    status: 'resolved',
    resolvedGuestId: guestId,
    resolvedStayId: upd.stayId || null,
    resolvedBy: request.auth.uid,
    resolvedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { ok: true, action: 'assign', stayId: upd.stayId || null };
});

// ═══════════════════════════════════════════════════════════════════
//  RESTORAN ÇEKİRDEĞİ — sunucu tarafı adisyon işlemleri
//  İş kuralları functions/rest-core.js'te (emülatörde test edilir);
//  buradaki sarmalayıcılar yalnızca kimlik/rol çözümü + hata çevirisi.
//  Plan + rol matrisi + hata kataloğu: docs/restoran-uretim-plani.md
// ═══════════════════════════════════════════════════════════════════
const restCore = require('./rest-core');
const orderBridge = require('./order-bridge');

// RestError.errCode → HttpsError durum kodu
const REST_HTTPS_CODE = {
  'REST/INVALID_INPUT': 'invalid-argument',
  'REST/TABLE_OCCUPIED': 'failed-precondition',
  'REST/CHECK_NOT_FOUND': 'not-found',
  'REST/CHECK_IMMUTABLE': 'failed-precondition',
  'REST/INVALID_TRANSITION': 'failed-precondition',
  'REST/OVERPAY_NONCASH': 'invalid-argument',
  'REST/NO_PAYMENT': 'invalid-argument',
  'REST/ROLE_DENIED': 'permission-denied',
  'REST/REASON_REQUIRED': 'invalid-argument',
  'REST/TENANT_MISMATCH': 'permission-denied'
};
function throwRest(e) {
  if (e instanceof restCore.RestError) {
    throw new HttpsError(REST_HTTPS_CODE[e.errCode] || 'internal', e.message,
      Object.assign({ errCode: e.errCode }, e.details));
  }
  throw e;
}

// Çağıranın personel kimliğini çözer: {uid, tenantId, role, username}.
// Anonim oturumlar systemUsers kaydı taşımadığından otomatik reddedilir.
async function requireStaffUser(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const uid = request.auth.uid;
  const snap = await db.collection('systemUsers').doc(uid).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Personel kaydı bulunamadı.');
  const u = snap.data();
  if (!u.tenantId) throw new HttpsError('failed-precondition', 'Kullanıcının oteli tanımlı değil.');
  return { uid, tenantId: u.tenantId, role: String(u.role || 'staff').toLowerCase(), username: u.username || uid };
}

// Adisyon aç — TEK sunucu transaction'ı (checkNo + masa kilidi + doküman),
// operationId ile idempotent. Bkz. rest-core.openCheckCore + testleri.
exports.restOpenCheck = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.openCheckCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username,
      operationId,
      tableName: d.tableName, pax: d.pax, section: d.section,
      room: d.room, name: d.name, guestId: d.guestId, stayId: d.stayId,
      force: !!d.force
    });
  } catch (e) { throwRest(e); }
});

// Ödeme (Faz 4): due/applied/tendered/change ayrımı, kart/oda fazla
// ödeme reddi, folio + stok + audit AYNI transaction'da; operationId ile
// çift ödeme koruması. İstemci artık paid YAZAMAZ (rules).
exports.restSettleCheck = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.settleCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username, role: u.role,
      operationId, checkId: String(d.checkId || ''),
      payments: d.payments, discount: d.discount || null
    });
  } catch (e) { throwRest(e); }
});

// İptal (Faz 4): gönderilmiş kalemli iptal manager/admin + SEBEP zorunlu;
// yetkili UID + rol + sebep audit'e yazılır. Düz metin cancelCode kalktı.
exports.restVoidCheck = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.voidCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username, role: u.role,
      operationId, checkId: String(d.checkId || ''), reason: d.reason
    });
  } catch (e) { throwRest(e); }
});

// Oda hesabı tahsil & kapat (Faz 4): manager/admin; audit'li; idempotent.
exports.restSettleFolio = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.folioSettleCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username, role: u.role,
      operationId, chargeIds: d.chargeIds
    });
  } catch (e) { throwRest(e); }
});

// Masaya taşıma / birleştirme / eşit bölme (F4.5): kilit tutarlılığı +
// audit sunucuda garanti; operationId idempotent. İstemci fonksiyon yoksa
// (deploy öncesi) kendi transaction'lı legacy yoluna düşebilir — kurallar
// bu yolları zaten version+durum makinesiyle sınırlıyor.
exports.restTransferCheck = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.transferCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username, role: u.role,
      operationId, checkId: String(d.checkId || ''), newTable: d.newTable, newSection: d.newSection
    });
  } catch (e) { throwRest(e); }
});
exports.restMergeChecks = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.mergeCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username, role: u.role,
      operationId, checkId: String(d.checkId || ''), otherId: String(d.otherId || '')
    });
  } catch (e) { throwRest(e); }
});
exports.restSplitCheck = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.splitCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username, role: u.role,
      operationId, checkId: String(d.checkId || ''), parts: d.parts
    });
  } catch (e) { throwRest(e); }
});

// Rezervasyon bakiyesini oda hesabına yansıt (concierge — F4.5): folio
// CREATE istemciye kapandığından sunucuya taşındı; bakiye sunucuda
// hesaplanır, folioApplied + operationId çift yansıtmayı engeller.
exports.applyReservationFolio = onCall({ region: REGION }, async (request) => {
  const u = await requireStaffUser(request);
  const d = request.data || {};
  const operationId = String(d.operationId || '').slice(0, 64);
  if (!operationId) throw new HttpsError('invalid-argument', 'operationId gerekli.', { errCode: restCore.ERR.INVALID_INPUT });
  try {
    return await restCore.applyReservationFolioCore(db, {
      tenantId: u.tenantId, uid: u.uid, username: u.username, role: u.role,
      operationId, reservationId: String(d.reservationId || '')
    });
  } catch (e) { throwRest(e); }
});

// Masa kilidi onarımı (migration — geri döndürülebilir; rapor döner).
// Otel admini kendi tenant'ında, süperadmin herhangi bir tenant'ta.
exports.restRepairTableLocks = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Giriş gerekli.');
  const su = await db.collection('superAdmins').doc(request.auth.uid).get();
  let tenantId = (request.data && request.data.tenantId) || null;
  if (!su.exists) {
    const u = await requireStaffUser(request);
    if (u.role !== 'admin') throw new HttpsError('permission-denied', 'Yalnızca otel yöneticisi.', { errCode: restCore.ERR.ROLE_DENIED });
    tenantId = u.tenantId; // admin yalnız kendi otelini onarabilir
  }
  if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId gerekli.');
  const report = await restCore.repairTableLocksCore(db, tenantId);
  return { ok: true, tenantId, report };
});

// ═══════════════════════════════════════════════════════════════════
//  Süperadmin "Stres" sekmesi: dış servis izleme + kendi sağlık kontrolü
//  + izole yük testi. Hiçbiri kiracı (otel) verisine dokunmaz.
// ═══════════════════════════════════════════════════════════════════

// Herkese açık, kimliksiz, minimal canlılık ucu — yalnız Cloud Functions'ın
// kendi gecikmesini/soğuk başlangıcını ölçmek için. Gizli bilgi döndürmez.
exports.healthCheck = onRequest({ region: REGION }, (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now(), region: REGION });
});

// _stressTest koleksiyonu tenant verisinden tamamen ayrık; Admin SDK burada
// Firestore kurallarını atladığı için istemciye ayrı bir kural açmaya gerek
// yok — yalnızca bu fonksiyon (superadmin-gated) dokunabilir.
//
// Çoklu-otel KAPASİTE testi (kademeli rampa): sanal otel sayısını
// 2→5→10→20→40→… şeklinde artırarak her kademede gerçek operasyon
// şekillerini (masa kilidi tx, adisyon versiyon tx, kayıt create,
// hesap kapama + idempotency defteri) eş zamanlı çalıştırır. Bir kademe
// sağlık eşiklerini (hata oranı / p95 gecikme) aşınca durur ve son
// sağlıklı kademeyi "maksimum sürdürülebilir kapasite" olarak raporlar.
// Motor: ./stress-core.js. Artakalan belgeler için `_stressTest.expiresAt`
// alanına 1 saatlik TTL politikası önerilir (konsoldan tanımlanır).
const stressCore = require('./stress-core');

exports.stressTestRun = onCall({ region: REGION, timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  await requireSuperAdmin(request);
  const d = request.data || {};
  const maxHotels = Math.min(80, Math.max(1, parseInt(d.maxHotels, 10) || 40));
  const stageSeconds = Math.min(20, Math.max(5, parseInt(d.stageSeconds, 10) || 10));

  const runId = 'cap' + Date.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
  // Fonksiyon zaman aşımından önce temizliğe pay bırak: kademe + 45 sn tampon.
  const globalDeadline = Date.now() + 480000;

  const stages = [];
  const created = [];
  let stoppedBy = 'ladder-complete';
  for (const hotels of stressCore.ladder(maxHotels)) {
    if (Date.now() + stageSeconds * 1000 + 45000 > globalDeadline) { stoppedBy = 'time-budget'; break; }
    const st = await stressCore.runStage(db, {
      runId: runId + '_s' + hotels, hotels, seconds: stageSeconds, expiresAt
    });
    for (const id of st.created) created.push(id);
    delete st.created;
    st.healthy = stressCore.isHealthy(st);
    stages.push(st);
    if (!st.healthy) { stoppedBy = 'threshold'; break; }
  }

  const healthy = stages.filter((s) => s.healthy);
  const last = healthy.length ? healthy[healthy.length - 1] : null;
  const cleaned = await stressCore.cleanup(db, created, Math.min(globalDeadline, Date.now() + 60000));

  return {
    runId, stageSeconds,
    workersPerHotel: stressCore.WORKERS_PER_HOTEL,
    thresholds: stressCore.HEALTH,
    stages, stoppedBy,
    verdict: last ? { hotels: last.hotels, opsPerSec: last.opsPerSec, p50: last.p50, p95: last.p95 } : null,
    cleanup: cleaned
  };
});
