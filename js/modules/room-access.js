/* StayOS — room-access.js
 *
 * Staff-side mirror that keeps a PUBLIC, per-room access doc in sync with the
 * hotel's live occupancy (guestDirectory), so the guest QR page can verify
 * "surname + room" and a checked-out room can no longer place requests.
 *
 * For each room it maintains  roomAccess/{tenantId}__{room}:
 *   { tenantId, room, open, nameKeys: [hash…], updatedAt }
 * where `open` = an in-house guest (checkOut >= today) exists, and `nameKeys`
 * are salted SHA-256 hashes of those guests' name tokens — never plaintext.
 *
 * Drop-in: include AFTER firebase-config.js on staff pages (concierge, crm,
 * panel, admin). Self-contained; only writes when something actually changes.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof auth === 'undefined' || typeof firebase === 'undefined') return;
    if (!(window.crypto && window.crypto.subtle)) return; // needs a secure context

    const TENANT = (typeof TENANT_ID !== 'undefined' && TENANT_ID) || localStorage.getItem('hotelTenantId') || 'mgallery';

    // Shared with the guest page — MUST stay identical on both sides.
    function norm(s) {
        return String(s == null ? '' : s).trim().toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's')
            .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o')
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
    }
    function tokens(name) {
        return norm(name).split(/\s+/).filter(t => t.length >= 2);
    }
    async function hash(str) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }
    const today = () => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    let lastDocs = [];                 // most recent guestDirectory snapshot
    const cache = Object.create(null); // room -> signature, to skip no-op writes
    let timer = null;

    // Recompute every room's desired state from the current directory + today's
    // date, then upsert only the rooms whose state changed.
    async function reconcile() {
        const t = today();
        const rooms = Object.create(null); // room -> { inHouse:bool, tokenSet:Set }
        lastDocs.forEach(g => {
            const room = String(g.room || '').trim();
            if (!room || room.toLowerCase() === 'pre-arrival') return;
            if (!rooms[room]) rooms[room] = { inHouse: false, tokenSet: new Set() };
            const live = g.status === 'in_house' && (!g.checkOut || String(g.checkOut) >= t);
            if (live) {
                rooms[room].inHouse = true;
                tokens(g.name).forEach(tok => rooms[room].tokenSet.add(tok));
            }
        });

        // Hash all unique tokens (salted with tenant+room) in one pass.
        const jobs = [];
        Object.keys(rooms).forEach(room => {
            rooms[room].keys = [];
            rooms[room].tokenSet.forEach(tok => {
                jobs.push(hash(TENANT + '|' + room + '|' + tok).then(h => rooms[room].keys.push(h)));
            });
        });
        await Promise.all(jobs);

        // Rooms we previously opened that no longer appear at all (guest record
        // deleted) must be closed too.
        Object.keys(cache).forEach(room => {
            if (!rooms[room] && cache[room] && cache[room].charAt(0) === '1') {
                rooms[room] = { inHouse: false, keys: [] };
            }
        });

        for (const room of Object.keys(rooms)) {
            const open = rooms[room].inHouse;
            const nameKeys = (rooms[room].keys || []).sort();
            const sig = (open ? '1' : '0') + ':' + nameKeys.join(',');
            if (cache[room] === sig) continue;     // unchanged → skip write
            cache[room] = sig;
            const id = TENANT + '__' + room;
            db.collection('roomAccess').doc(id).set({
                tenantId: TENANT,
                room: room,
                open: open,
                nameKeys: nameKeys,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(err => console.error('roomAccess sync failed', room, err));
        }
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
