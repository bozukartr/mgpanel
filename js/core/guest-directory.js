// Misafir dizini (guestDirectory) + konaklama (stays) senkronizasyonu.
//
// KİMLİK MODELİ (bkz. kimlik migrasyonu):
//   guestId = guestDirectory doküman ID'si — KİŞİYİ tanımlar
//   stayId  = stays doküman ID'si — TEK BİR KONAKLAMAYI tanımlar
// İş kayıtları (guestLogs, reservations, guestOrders, folioCharges,
// restChecks) artık bu ID'leri taşır; guestName/room alanları yalnızca
// GÖSTERİM amaçlı snapshot'tır, ilişkilendirme ID'lerle yapılır.
// guestDirectory dokümanındaki `activeStayId`, misafirin o anki açık
// konaklamasına denormalize bir işaretçidir — oda→misafir bulan her akış
// (restoran, QR sipariş) ek sorgu yapmadan her iki ID'ye ulaşır.
//
// "Bu misafir zaten var mı" kontrolü her çağrıda taze bir sunucu
// okumasından yapılır (yerel önbellek değil). Bu, eşzamanlı iki sekmenin
// mükerrer kayıt oluşturma riskini küçültür ama TAMAMEN kaldırmaz:
// Firebase 8.x compat SDK transaction içinde sorgu desteklemediğinden
// gerçek atomik "oku-sonra-yaz" burada mümkün değil. İsim eşleştirmesi
// zaten yalnızca LEGACY bir geri-düşüş — kayıtlar ID taşıdıkça bu yol
// önemsizleşir ve backfill sonrası kaldırılabilir.
window.GuestDirectory = (function () {
    function nowIso() { return new Date().toISOString(); }

    // Aktif konaklamayı garanti eder: guest.activeStayId varsa günceller,
    // yoksa yeni bir stays dokümanı açıp guestDirectory'ye işaretler.
    async function ensureActiveStay(guest, statusToSet, room, checkIn, checkOut) {
        if (statusToSet !== 'in_house' && statusToSet !== 'pre_arrival') return null;
        if (guest.activeStayId) {
            // guest objesi bu noktada YENİ değerleri taşıyor olabilir (çağıran
            // önce guestDirectory'yi günceller) — o yüzden "değişti mi" diye
            // guest ile kıyaslamak yanıltıcı; verilen değerler doğrudan yazılır
            // (idempotent).
            const upd = { status: statusToSet };
            if (room) upd.room = room;
            if (checkIn) upd.checkIn = checkIn;
            if (checkOut) upd.checkOut = checkOut;
            try { await db.collection('stays').doc(guest.activeStayId).update(upd); } catch (e) { /* stay silinmiş olabilir — işaretçi yine de korunur */ }
            return guest.activeStayId;
        }
        const stay = {
            tenantId: TENANT_ID,
            guestId: guest.id,
            guestName: guest.name || '',   // gösterim snapshot'ı
            room: room || guest.room || '',
            checkIn: checkIn || guest.checkIn || '',
            checkOut: checkOut || guest.checkOut || '',
            status: statusToSet,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        const ref = await db.collection('stays').add(stay);
        await db.collection('guestDirectory').doc(guest.id).update({ activeStayId: ref.id });
        return ref.id;
    }

    // Aktif konaklamayı kapatır (checkout). guestLike: {id, activeStayId}.
    // guestDirectory.status'u BURASI değiştirmez — çağıran akış (crm checkout,
    // panel auto-sweep) zaten kendi status yazımını yapıyor; bu yalnızca
    // stays tarafını tutarlı kapatır.
    async function closeStay(guestLike, by) {
        const stayId = guestLike && guestLike.activeStayId;
        if (!stayId) return;
        try {
            await db.collection('stays').doc(stayId).update({
                status: 'checked_out',
                checkedOutAt: firebase.firestore.FieldValue.serverTimestamp(),
                checkedOutBy: by || ''
            });
            await db.collection('guestDirectory').doc(guestLike.id).update({ activeStayId: firebase.firestore.FieldValue.delete() });
        } catch (e) { console.error('closeStay', e); }
    }

    async function syncGuestStatus(name, opts) {
        opts = opts || {};
        const normalized = String(name || '').trim();
        if (!normalized) return null;
        const key = normalized.toLocaleLowerCase('tr-TR');
        const room = opts.room || '';
        const isPreArrival = !!opts.isPreArrival;
        const forceStatus = opts.status || null; // panel.js: durumu doğrudan zorla
        const checkIn = opts.checkIn || '';
        const checkOut = opts.checkOut || '';

        // Hedefli arama (hız denetimi): önceden HER çağrıda tüm dizin
        // okunuyordu. Sıra: (1) opts.guestId → doğrudan doküman okuması;
        // (2) normalize isim anahtarı (nameKey) sunucu sorgusu; (3) LEGACY
        // geri-düşüş: nameKey'i henüz damgalanmamış eski dokümanlar için
        // tam tarama — eşleşen doküman bulunursa nameKey damgalanır, yani
        // aynı misafir için tam tarama bir daha yaşanmaz (kendi kendine
        // yakınsar).
        let existing = null;
        if (opts.guestId) {
            const ds = await db.collection('guestDirectory').doc(opts.guestId).get();
            if (ds.exists) existing = Object.assign({ id: ds.id }, ds.data());
        }
        if (!existing) {
            const q = await db.collection('guestDirectory')
                .where('tenantId', '==', TENANT_ID).where('nameKey', '==', key).limit(1).get();
            if (!q.empty) existing = Object.assign({ id: q.docs[0].id }, q.docs[0].data());
        }
        if (!existing) {
            const snap = await db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get();
            const docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
            existing = docs.find(function (g) { return (g.name || '').toLocaleLowerCase('tr-TR') === key; }) || null;
            if (existing && !existing.nameKey) {
                try { await db.collection('guestDirectory').doc(existing.id).update({ nameKey: key }); existing.nameKey = key; } catch (e) { /* damga başarısız — sonraki çağrı tekrar dener */ }
            }
        }
        const statusToSet = forceStatus || (isPreArrival ? 'pre_arrival' : 'in_house');

        if (!existing) {
            const newGuest = {
                name: normalized, nameKey: key, room: room, status: statusToSet,
                checkIn: checkIn, checkOut: checkOut,
                tenantId: TENANT_ID, lastUpdated: nowIso()
            };
            const ref = await db.collection('guestDirectory').add(newGuest);
            const guest = Object.assign({ id: ref.id }, newGuest);
            guest.stayId = await ensureActiveStay(guest, statusToSet, room, checkIn, checkOut);
            guest.activeStayId = guest.stayId;
            return guest;
        }

        const updates = { lastUpdated: nowIso() };
        if (forceStatus) {
            if (existing.status !== forceStatus) updates.status = forceStatus;
        } else {
            if (existing.status === 'checked_out') updates.status = statusToSet;
            else if (isPreArrival && existing.status !== 'pre_arrival') updates.status = 'pre_arrival';
            else if (!isPreArrival && existing.status === 'pre_arrival' && room) updates.status = 'in_house';
        }
        if (room && existing.room !== room) updates.room = room;
        if (checkIn) updates.checkIn = checkIn;
        if (checkOut) updates.checkOut = checkOut;

        let guest = existing;
        if (Object.keys(updates).length > 1) {
            await db.collection('guestDirectory').doc(existing.id).update(updates);
            guest = Object.assign({}, existing, updates);
        }
        // Nihai durum konaklama gerektiriyorsa aktif stay'i garanti et.
        // checked_out'tan geri dönüş (yeni konaklama) dahil: activeStayId
        // yoksa yeni stay açılır — önceki konaklama tarihçede kalır.
        const finalStatus = guest.status || statusToSet;
        guest.stayId = await ensureActiveStay(guest, finalStatus, room, checkIn, checkOut);
        if (guest.stayId) guest.activeStayId = guest.stayId;
        return guest;
    }

    return { syncGuestStatus: syncGuestStatus, closeStay: closeStay };
})();
