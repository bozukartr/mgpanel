/* Hotizy — Bildirim ayarları (admin paneli "Bildirimler" sekmesi).
 *
 * Otelin yeni-misafir-talebi bildirimlerini özelleştirir:
 *   notifyConfig/{tenantId} = {
 *     tenantId,
 *     guestOrderEnabled,        // bildirim gönderilsin mi (varsayılan: evet)
 *     guestOrderTitle,          // bildirim başlığı (boşsa varsayılan)
 *     guestOrderShowItems,      // talep içeriği gösterilsin mi (varsayılan: evet)
 *     guestOrderRecipients,     // 'all' | 'managers'
 *     updatedAt
 *   }
 * Cloud Function (onGuestOrderCreate) bu dokümanı admin SDK ile okuyup uygular.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;

    var COL = 'notifyConfig';
    var $ = function (id) { return document.getElementById(id); };
    var cfg = {};

    function fill() {
        if ($('ntEnabled')) $('ntEnabled').checked = cfg.guestOrderEnabled !== false;       // varsayılan açık
        if ($('ntTitle')) $('ntTitle').value = cfg.guestOrderTitle || '';
        if ($('ntShowItems')) $('ntShowItems').checked = cfg.guestOrderShowItems !== false;  // varsayılan açık
        if ($('ntRecipients')) $('ntRecipients').value = (cfg.guestOrderRecipients === 'managers') ? 'managers' : 'all';
    }

    function load() {
        db.collection(COL).doc(TENANT_ID).get().then(function (doc) {
            cfg = doc.exists ? (doc.data() || {}) : {};
            fill();
        }).catch(function (e) { if (window.Monitor) Monitor.capture(e, { where: 'notifyConfig.load' }); });
    }

    function save() {
        var btn = $('ntSave');
        var data = {
            tenantId: TENANT_ID,
            guestOrderEnabled: $('ntEnabled') ? $('ntEnabled').checked : true,
            guestOrderTitle: ($('ntTitle') ? $('ntTitle').value : '').trim().slice(0, 80),
            guestOrderShowItems: $('ntShowItems') ? $('ntShowItems').checked : true,
            guestOrderRecipients: ($('ntRecipients') && $('ntRecipients').value === 'managers') ? 'managers' : 'all',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (btn) { btn.disabled = true; btn.textContent = 'Kaydediliyor…'; }
        db.collection(COL).doc(TENANT_ID).set(data, { merge: true }).then(function () {
            cfg = data;
            if (btn) { btn.textContent = 'Kaydedildi ✓'; setTimeout(function () { btn.disabled = false; btn.textContent = 'Kaydet'; }, 1500); }
        }).catch(function (e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Kaydet'; }
            if (window.Monitor) Monitor.capture(e, { where: 'notifyConfig.save' });
            alert('Kaydedilemedi. Yetkiniz olmayabilir (yalnızca yönetici).');
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (!$('view-notify')) return;
        if ($('ntSave')) $('ntSave').onclick = save;
        if (typeof auth !== 'undefined') {
            auth.onAuthStateChanged(function (u) { if (u) load(); });
        } else { load(); }
    });
})();
