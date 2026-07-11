/* Test yardımcıları — kural testleri (rules-unit-testing) ve çekirdek
 * testleri (firebase-admin, kurallar BYPASS) aynı emülatörü paylaşır.
 * FIRESTORE_EMULATOR_HOST run.sh tarafından verilir. */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const EMU = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8791';
const [EMU_HOST, EMU_PORT] = EMU.split(':');

// ── Kural test ortamı ─────────────────────────────────────────────
async function rulesEnv(projectId) {
  return initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
      host: EMU_HOST,
      port: Number(EMU_PORT)
    }
  });
}
// Personel (anonim olmayan) oturum bağlamı — kurallardaki isStaff()
// sign_in_provider'a bakar.
function staffCtx(env, uid) {
  return env.authenticatedContext(uid, { firebase: { sign_in_provider: 'password' } });
}
function anonCtx(env, uid) {
  return env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } });
}

// ── Admin SDK (çekirdek testleri — kurallar geçilmez) ─────────────
let adminApps = {};
function adminDb(projectId) {
  if (!adminApps[projectId]) {
    const admin = require('firebase-admin');
    adminApps[projectId] = admin.initializeApp({ projectId }, 'admin-' + projectId);
  }
  return adminApps[projectId].firestore();
}

// ── Seed ──────────────────────────────────────────────────────────
// Bir tenant için gerçekçi taban veri: roller, misafir(+stay), menü,
// masa kilidi olmayan temiz zemin, açık bir adisyon, açık bir folio.
async function seedTenant(db, t) {
  const b = db.batch();
  const col = (c, id) => db.collection(c).doc(id);

  // Kullanıcılar (uid = doc id — gerçek modeldeki gibi)
  b.set(col('systemUsers', `${t}-admin`), { tenantId: t, username: `${t}.admin`, role: 'admin', department: 'Yönetim' });
  b.set(col('systemUsers', `${t}-manager`), { tenantId: t, username: `${t}.manager`, role: 'manager', department: 'F&B' });
  b.set(col('systemUsers', `${t}-staff`), { tenantId: t, username: `${t}.garson`, role: 'staff', department: 'Restoran' });

  // Misafir + aktif konaklama
  b.set(col('guestDirectory', `${t}-guest1`), {
    tenantId: t, name: 'Test Misafir', nameKey: 'test misafir', room: '101',
    status: 'in_house', checkIn: '2026-07-10', checkOut: '2026-07-20', activeStayId: `${t}-stay1`
  });
  b.set(col('stays', `${t}-stay1`), {
    tenantId: t, guestId: `${t}-guest1`, guestName: 'Test Misafir', room: '101',
    checkIn: '2026-07-10', checkOut: '2026-07-20', status: 'in_house'
  });

  // Menü (stok takipli 1 ürün + takipsiz 1 ürün)
  b.set(col('restMenu', `${t}-menu-kofte`), {
    tenantId: t, name: 'Köfte', category: 'Ana Yemek', price: 200, unitPrice: 200,
    trackStock: true, stock: 10, active: true
  });
  b.set(col('restMenu', `${t}-menu-cay`), {
    tenantId: t, name: 'Çay', category: 'İçecek', price: 20, unitPrice: 20,
    trackStock: false, active: true
  });

  // Konfig + sayaç
  b.set(col('restConfig', t), { name: t + ' Restoran', currency: '₺', vatRate: 10, vatMode: 'included' });
  b.set(col('restCounters', t), { tenantId: t, checkNo: 100 });

  // Açık bir adisyon (masa 5) + kilidi
  b.set(col('restChecks', `${t}-check-open`), {
    tenantId: t, status: 'open', checkNo: 100, tableName: 'Masa 5', tableKey: 'masa 5',
    section: 'Genel', pax: 2, room: '', name: '', version: 1,
    items: [{ lineId: 'l1', menuId: `${t}-menu-cay`, name: 'Çay', qty: 2, unitPrice: 20, sent: false }],
    subtotal: 40, vat: 3.64, total: 40
  });
  b.set(col('restTables', `${t}__masa 5`), { tenantId: t, table: 'Masa 5', tableKey: 'masa 5', openCheckId: `${t}-check-open` });

  // Açık bir folio kaydı
  b.set(col('folioCharges', `${t}-folio1`), {
    tenantId: t, room: '101', guestName: 'Test Misafir', guestId: `${t}-guest1`, stayId: `${t}-stay1`,
    source: 'restaurant', checkId: `${t}-check-open`, sourceId: `${t}-check-open`, tableName: 'Masa 5',
    amount: 150, currency: 'TRY', status: 'open'
  });

  await b.commit();
}

module.exports = { rulesEnv, staffCtx, anonCtx, adminDb, seedTenant, EMU };
