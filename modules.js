/* modules.js — per-hotel feature gating.
   Reads the plan's enabled modules (cached at login) and:
     1) hides nav links to modules this hotel doesn't have,
     2) redirects away from a module page the hotel isn't entitled to.
   A module counts as enabled unless explicitly disabled, so legacy hotels
   (no plan config) keep full access. This is feature-gating, not a security
   boundary — data isolation is enforced separately by tenantId + rules. */
(function () {
    function modules() {
        try { return JSON.parse(localStorage.getItem('hotelModules')) || {}; }
        catch (e) { return {}; }
    }
    const m = modules();
    const enabled = (key) => m[key] !== false;

    // module key -> page + nav selector
    const MAP = [
        { key: 'concierge',  page: 'concierge.html', sel: 'a[href="concierge.html"]' },
        { key: 'crm',        page: 'crm.html',       sel: 'a[href="crm.html"]' },
        { key: 'guestIssues', page: 'panel.html',    sel: 'a[href="panel.html"]' }
    ];

    // 1) Guard the current page — redirect to the first enabled module.
    const path = (window.location.pathname || '').toLowerCase();
    const current = MAP.find(x => path.endsWith('/' + x.page) || path.endsWith(x.page));
    if (current && !enabled(current.key)) {
        const dest = MAP.find(x => enabled(x.key));
        window.location.replace(dest ? dest.page : 'login.html');
        return;
    }

    // 2) Hide nav links to disabled modules once the DOM is ready.
    function hideNav() {
        MAP.forEach(x => {
            if (!enabled(x.key)) {
                document.querySelectorAll(x.sel).forEach(a => { a.style.display = 'none'; });
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hideNav);
    } else {
        hideNav();
    }
})();
