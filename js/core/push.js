/* Hotizy — FCM web push registration (client).
 *
 * SETUP (one-time): paste your Web Push certificate public key below.
 *   Firebase Console → Project settings → Cloud Messaging →
 *   "Web Push certificates" → Key pair (copy the public key).
 * Until this is filled, OS push stays off and the in-app bell keeps working.
 *
 * Requires firebase-messaging.js (compat) to be loaded before this script, and
 * firebase-messaging-sw.js to exist at the site root.
 */
const PUSH_VAPID_KEY = 'BLjczT1bCMbeOFJqW5DZw_sC7uMMRWY-v4jUWaf9FuVZLuXJP_TrPHaewjMx_niwjFT1WxCU3yAe_-a-YgKh__o'; // Firebase Web Push certificate (public key)

(function () {
    'use strict';
    // Durum, zil panelindeki "Cihaz Bildirimleri" satırında gösterilir —
    // kayıt sorunları artık sessiz kalmaz, personel tek dokunuşla onarır.
    function stubPush(reason) {
        window.Push = { supported: false, reason: reason, state: function () { return { supported: false, reason: reason }; }, repair: async function () { return { supported: false, reason: reason }; } };
    }
    if (!PUSH_VAPID_KEY) { stubPush('VAPID anahtarı ayarlı değil'); console.info('[push] VAPID key not set — OS push disabled (in-app notifications still work).'); return; }
    if (typeof firebase === 'undefined' || !firebase.messaging || typeof db === 'undefined' || typeof auth === 'undefined') { stubPush('Bildirim altyapısı yüklenemedi'); return; }
    if (!('serviceWorker' in navigator) || !('Notification' in window)) { stubPush('Bu tarayıcı cihaz bildirimini desteklemiyor (iOS\'ta uygulamayı Ana Ekrana ekleyin)'); return; }
    try { if (firebase.messaging.isSupported && !firebase.messaging.isSupported()) { stubPush('Bu tarayıcı cihaz bildirimini desteklemiyor'); return; } } catch (e) { stubPush('Bu tarayıcı cihaz bildirimini desteklemiyor'); return; }

    let inFlight = false;
    let refreshHooked = false;
    // Teşhis durumu: bu oturumda token HANGI kullanıcı için kaydedildi?
    const pstate = { savedUid: '', token: '', error: '', savedAt: 0 };

    async function saveToken(token) {
        const uid = auth.currentUser && auth.currentUser.uid;
        if (!token || !uid) return;
        await db.collection('pushTokens').doc(token).set({
            token: token,
            uid: uid,
            tenantId: (typeof TENANT_ID !== 'undefined' && TENANT_ID) || localStorage.getItem('hotelTenantId') || 'mgallery',
            platform: (navigator.userAgent || '').slice(0, 180),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        pstate.savedUid = uid; pstate.token = token; pstate.savedAt = Date.now(); pstate.error = '';
    }

    async function enable() {
        if (inFlight) return;
        inFlight = true;
        try {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { inFlight = false; return; }

            // FCM service worker'ını KENDİ scope'unda açıkça kaydet. pwa.js önbellek
            // amaçlı sw.js'i kök scope'ta ('/') kaydediyor; FCM'in otomatik kaydına
            // güvenmek bu çakışma yüzünden arka plan push'unu sessizce bozabiliyor.
            // Ayrı scope + useServiceWorker push'u güvenceye alır (kayıt başarısızsa
            // otomatik kayda düşülür).
            let reg = null;
            try {
                reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' });
            } catch (e) { reg = null; }

            const messaging = firebase.messaging();
            messaging.usePublicVapidKey(PUSH_VAPID_KEY);
            if (reg) messaging.useServiceWorker(reg);

            const token = await messaging.getToken();
            const uid = auth.currentUser && auth.currentUser.uid;
            if (!token || !uid) { inFlight = false; return; }
            await saveToken(token);

            // Token döndüğünde (rotasyon) yeniden kaydet — yoksa eski/ölü token'a
            // push düşmez. Yalnızca bir kez bağla.
            if (!refreshHooked && typeof messaging.onTokenRefresh === 'function') {
                refreshHooked = true;
                messaging.onTokenRefresh(async () => {
                    try { await saveToken(await messaging.getToken()); }
                    catch (e) { if (window.Monitor) Monitor.capture(e, { where: 'push.onTokenRefresh' }); }
                });
            }
            console.info('[push] device registered for OS notifications.');
        } catch (e) {
            pstate.error = (e && e.message) || 'bilinmeyen hata';
            console.warn('[push]', e && e.message);
            if (window.Monitor) Monitor.capture(e, { where: 'push.enable' });
        }
        inFlight = false;
    }

    // Zil panelinin kullandığı teşhis/onarım API'si.
    window.Push = {
        supported: true,
        state: function () {
            const uid = auth.currentUser && auth.currentUser.uid;
            return {
                supported: true,
                permission: Notification.permission,
                // "Kayıtlı" = bu oturumda token ŞU ANKİ kullanıcı adına yazıldı.
                registered: !!pstate.savedUid && pstate.savedUid === uid,
                error: pstate.error
            };
        },
        repair: async function () {
            pstate.error = '';
            await enable();
            return window.Push.state();
        }
    };

    auth.onAuthStateChanged(function (u) {
        if (!u) return;
        if (Notification.permission === 'granted') {
            enable();
        } else if (Notification.permission === 'default') {
            // iOS requires the permission prompt to come from a user gesture.
            const once = function () {
                enable();
                window.removeEventListener('pointerdown', once);
                window.removeEventListener('click', once);
            };
            window.addEventListener('pointerdown', once, { once: true });
            window.addEventListener('click', once, { once: true });
        }
    });

    // Ortak cihazlarda hesap değişimi: pushTokens dokümanı token başına TEK uid
    // taşır (cihazda en son kaydolan kazanır). Sekme öne her geldiğinde, token
    // hâlâ mevcut kullanıcı adına kayıtlı değilse yeniden bağla — aksi halde
    // "admin girince personelin push'u kesildi" durumu sessizce kalıcılaşıyordu.
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        const uid = auth.currentUser && auth.currentUser.uid;
        if (!uid || Notification.permission !== 'granted') return;
        if (pstate.savedUid !== uid) enable();
    });
})();
