// Misafir dizini (guestDirectory) senkronizasyonu — daha önce concierge.js ve
// panel.js'de birbirinden bağımsız İKİ AYRI kopyası vardı (bkz. tutarlılık
// denetimi). Tek yerde toplanmış hâli.
//
// "Bu misafir zaten var mı" kontrolü artık yerel bir onSnapshot önbelleğinin
// taranması yerine HER ÇAĞRIDA taze bir sunucu okumasından yapılır — eski
// davranışta iki personel sekmesi az farkla eşzamanlı çağırdığında ikisi de
// önbellekte "yok" görüp mükerrer kayıt oluşturabiliyordu. Taze okuma bu
// riski küçültür ama TAMAMEN ortadan kaldırmaz: Firebase 8.x compat SDK
// transaction içinde sorguyu desteklemediğinden (yalnızca tek doküman
// referansı okunabilir) ve isim alanı deterministik bir doküman ID'si
// olmadığından, gerçek anlamda atomik bir "oku-sonra-yaz" burada mümkün
// değil. Tam garanti için guestDirectory doküman ID'sinin normalize edilmiş
// isimden türetilmesi gerekir — bu, var olan tüm kayıtlar için bir
// migrasyon gerektiren daha büyük bir değişiklik olduğundan bu geçişin
// kapsamı dışında bırakıldı.
window.GuestDirectory = (function () {
    function syncGuestStatus(name, opts) {
        opts = opts || {};
        const normalized = String(name || '').trim();
        if (!normalized) return Promise.resolve(null);
        const key = normalized.toLocaleLowerCase('tr-TR');
        const room = opts.room || '';
        const isPreArrival = !!opts.isPreArrival;
        const forceStatus = opts.status || null; // panel.js: durumu doğrudan zorla
        const checkIn = opts.checkIn || '';
        const checkOut = opts.checkOut || '';

        return db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get()
            .then(function (snap) {
                const docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
                const existing = docs.find(function (g) { return (g.name || '').toLocaleLowerCase('tr-TR') === key; });
                const statusToSet = forceStatus || (isPreArrival ? 'pre_arrival' : 'in_house');

                if (!existing) {
                    const newGuest = {
                        name: normalized, room: room, status: statusToSet,
                        checkIn: checkIn, checkOut: checkOut,
                        tenantId: TENANT_ID, lastUpdated: new Date().toISOString()
                    };
                    return db.collection('guestDirectory').add(newGuest)
                        .then(function (ref) { return Object.assign({ id: ref.id }, newGuest); });
                }

                const updates = { lastUpdated: new Date().toISOString() };
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

                if (Object.keys(updates).length <= 1) return existing;
                return db.collection('guestDirectory').doc(existing.id).update(updates)
                    .then(function () { return Object.assign({}, existing, updates); });
            });
    }
    return { syncGuestStatus: syncGuestStatus };
})();
