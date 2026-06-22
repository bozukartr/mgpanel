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
    function userMods() {
        try { return JSON.parse(localStorage.getItem('userModules')) || {}; }
        catch (e) { return {}; }
    }
    const m = modules();
    const um = userMods();
    // Enabled only if the hotel's plan includes it AND the user is allowed to see it.
    const enabled = (key) => m[key] !== false && um[key] !== false;

    // module key -> page + nav selector
    const MAP = [
        { key: 'concierge',  page: 'concierge.html', sel: 'a[href="concierge.html"]' },
        { key: 'crm',        page: 'crm.html',       sel: 'a[href="crm.html"]' },
        { key: 'guestIssues', page: 'panel.html',    sel: 'a[href="panel.html"]' }
    ];

    // 1) Guard the current page — redirect to the first enabled module.
    //    Extension-agnostic (cleanUrls) and treats panel-mobile as panel.
    const base = (window.location.pathname || '').toLowerCase().replace(/\/$/, '').split('/').pop().replace(/\.html$/, '').replace(/-mobile$/, '');
    const current = MAP.find(x => base === x.page.replace(/\.html$/, ''));
    // App Shell iframe'i içinde gömülüyken yönlendirmeyi kabuk yapar; burada sadece nav gizlenir.
    if (current && !enabled(current.key) && !window.__EMBED__) {
        const dest = MAP.find(x => enabled(x.key));
        window.location.replace(dest ? dest.page : 'login.html');
        return;
    }

    // 2) Hide nav links to disabled modules once the DOM is ready.
    function hideNav() {
        MAP.forEach(x => {
            if (!enabled(x.key)) {
                document.querySelectorAll(x.sel).forEach(a => { a.style.display = 'none'; });
                document.querySelectorAll('[data-module="' + x.key + '"]').forEach(a => { a.style.display = 'none'; });
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hideNav);
    } else {
        hideNav();
    }
})();
