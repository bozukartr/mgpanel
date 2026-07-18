/* Hotizy — room-access.js
 *
 * Staff-side mirror that keeps a PUBLIC, per-room "is this room currently
 * occupied" flag in sync with the hotel's live occupancy (guestDirectory),
 * so a checked-out room can no longer place guest QR requests even with the
 * same physical QR code (roomIsExplicitlyClosed in firestore.rules).
 *
 * For each room it maintains  roomAccess/{tenantId}__{room}:
 *   { tenantId, room, open, updatedAt }
 * where `open` = an in-house guest (checkOut >= today) exists.
 *
 * Misafir kimliği artık burada DEĞİL, sunucu tarafında (functions/index.js:
 * verifyGuestIdentity → verifiedGuestSessions) doğrulanıyor — bu dosya
 * eskiden ayrıca isim token'larının tuzlanmış hash'lerini (`nameKeys`) da
 * tutuyordu (guest-order.js'in istemci tarafı soyad eşleştirmesi için); o
 * eşleştirme kaldırıldığından burada artık YALNIZCA `open` bayrağı tutulur.
 *
 * Drop-in: include AFTER firebase-config.js on staff pages (concierge, crm,
 * panel, admin). Self-contained; only writes when something actually changes.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof auth === 'undefined' || typeof firebase === 'undefined') return;

    const TENANT = (typeof TENANT_ID !== 'undefined' && TENANT_ID) || localStorage.getItem('hotelTenantId') || 'mgallery';

    const today = () => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    let lastDocs = [];                 // most recent guestDirectory snapshot
    const cache = Object.create(null); // room -> signature, to skip no-op writes
    let timer = null;

    // Recompute every room's open/closed state from the current directory +
    // today's date, then upsert only the rooms whose state changed.
    function reconcile() {
        const t = today();
        const rooms = Object.create(null); // room -> inHouse:bool
        lastDocs.forEach(g => {
            const room = String(g.room || '').trim();
            if (!room || room.toLowerCase() === 'pre-arrival') return;
            const live = g.status === 'in_house' && (!g.checkOut || String(g.checkOut) >= t);
            if (live) rooms[room] = true;
            else if (!(room in rooms)) rooms[room] = false;
        });

        // Rooms we previously opened that no longer appear at all (guest record
        // deleted) must be closed too.
        Object.keys(cache).forEach(room => {
            if (!(room in rooms) && cache[room] === '1') rooms[room] = false;
        });

        Object.keys(rooms).forEach(room => {
            const open = rooms[room];
            const sig = open ? '1' : '0';
            if (cache[room] === sig) return;     // unchanged → skip write
            cache[room] = sig;
            const id = TENANT + '__' + room;
            db.collection('roomAccess').doc(id).set({
                tenantId: TENANT,
                room: room,
                open: open,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(err => console.error('roomAccess sync failed', room, err));
        });
    }

    function start() {
        db.collection('guestDirectory').where('tenantId', '==', TENANT).onSnapshot(snap => {
            lastDocs = snap.docs.map(d => d.data());
            reconcile();
        }, err => console.error('roomAccess: guestDirectory listen failed', err));
        // Re-run on a timer so rooms whose checkOut date passes get closed even
        // without a directory change.
        if (timer) clearInterval(timer);
        timer = setInterval(reconcile, 10 * 60 * 1000);
    }

    // Only relevant for hotels that have the guest-requests module.
    if (typeof moduleEnabled === 'function' && !moduleEnabled('guestOrders')) return;
    auth.onAuthStateChanged(u => { if (u && !u.isAnonymous) start(); });
})();
