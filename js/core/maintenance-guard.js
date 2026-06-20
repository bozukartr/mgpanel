/* maintenance-guard.js — included on app pages (not admin pages, not maintenance.html).
   While maintenance is active, send everyone to the maintenance screen.
   Admin access during maintenance is granted only via the unlock on maintenance.html,
   which leads to the admin panel (admin.html has no guard). */
(function () {
    if (/maintenance(\.html)?$/i.test(window.location.pathname)) return;
    // App Shell iframe'i içinde gömülüyken bakım yönlendirmesini kabuk (üst pencere) yapar.
    if (window.__EMBED__) return;
    try {
        db.collection('maintenance').doc(guardTenant()).onSnapshot((doc) => {
            if (!doc.exists) return;
            const d = doc.data();
            const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
            const active = d.enabled && ends && ends > new Date();
            if (active) window.location.replace('maintenance.html');
        }, function () { /* ignore read errors */ });
    } catch (e) { /* firebase not ready — ignore */ }
})();
