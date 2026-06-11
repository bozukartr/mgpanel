/* StayOS — FCM web push registration (client).
 *
 * SETUP (one-time): paste your Web Push certificate public key below.
 *   Firebase Console → Project settings → Cloud Messaging →
 *   "Web Push certificates" → Key pair (copy the public key).
 * Until this is filled, OS push stays off and the in-app bell keeps working.
 *
 * Requires firebase-messaging.js (compat) to be loaded before this script, and
 * firebase-messaging-sw.js to exist at the site root.
 */
const PUSH_VAPID_KEY = ''; // ← paste your VAPID public key here

(function () {
    'use strict';
    if (!PUSH_VAPID_KEY) { console.info('[push] VAPID key not set — OS push disabled (in-app notifications still work).'); return; }
    if (typeof firebase === 'undefined' || !firebase.messaging || typeof db === 'undefined' || typeof auth === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
    try { if (firebase.messaging.isSupported && !firebase.messaging.isSupported()) return; } catch (e) { return; }

    let inFlight = false;

    async function enable() {
        if (inFlight) return;
        inFlight = true;
        try {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { inFlight = false; return; }
            const messaging = firebase.messaging();
            messaging.usePublicVapidKey(PUSH_VAPID_KEY);
            const token = await messaging.getToken();
            const uid = auth.currentUser && auth.currentUser.uid;
            if (!token || !uid) { inFlight = false; return; }
            await db.collection('pushTokens').doc(token).set({
                token: token,
                uid: uid,
                tenantId: (typeof TENANT_ID !== 'undefined' && TENANT_ID) || localStorage.getItem('hotelTenantId') || 'mgallery',
                platform: (navigator.userAgent || '').slice(0, 180),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.info('[push] device registered for OS notifications.');
        } catch (e) {
            console.warn('[push]', e && e.message);
        }
        inFlight = false;
    }

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
})();
