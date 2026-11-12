/* Hotizy — shell-keys.js · Klavye kısayolları (App Shell)
 *
 * Masaüstündeki resepsiyon için: fareye uzanmadan modül değiştirme, yeni
 * kayıt, QR talepleri. Kısayollar yalnızca bir yazı alanında DEĞİLKEN ve
 * Ctrl/⌘/Alt olmadan çalışır (yazarken asla tetiklenmez). Odak bir modül
 * çerçevesinin içindeyken de çalışır (app-shell.js onKey her çerçeveye bağlı).
 *
 *   / veya Ctrl+K   Oda / misafir ara        (shell-search.js)
 *   1 – 9           Menüdeki n'inci modül
 *   N               Bu ekranda yeni kayıt (Kayıtlar: talep · Concierge:
 *                   rezervasyon · CRM: misafir · diğerleri: Kayıtlar'da talep)
 *   T               Misafir QR talepleri
 *   ?               Bu yardım
 */
(function () {
    'use strict';
    if (!window.Shell || !Shell.addKeyHandler) return;
    var on = function (k) { return typeof moduleEnabled !== 'function' || moduleEnabled(k); };
    var NEW = {
        kayitlar: { route: 'kayitlar', q: 'new=request', label: 'Yeni talep' },
        concierge: { route: 'concierge', q: 'new=1', label: 'Yeni rezervasyon' },
        crm: { route: 'crm', q: 'new=1', label: 'Yeni misafir' }
    };

    function visibleTabs() {
        return Array.prototype.filter.call(document.querySelectorAll('.sh-nav .sh-tab[data-route]'), function (el) {
            return el.style.display !== 'none' && el.offsetParent !== null;
        });
    }
    function newRecord() {
        var r = Shell.route();
        var t = NEW[r];
        if (!t && on('guestIssues')) t = NEW.kayitlar;   // Panel / Raporlar → Kayıtlar'da yeni talep
        if (!t) return false;
        Shell.navigate(t.route, t.q);
        return true;
    }
    function ordersVisible() {
        var el = document.querySelector('.sh-tab.sh-orders');
        return !!el && el.style.display !== 'none' && el.offsetParent !== null;
    }

    // ── Yardım penceresi ──────────────────────────────────────────
    var help = null;
    function kbd(k) { return '<kbd>' + k + '</kbd>'; }
    function buildHelp() {
        help = document.createElement('div');
        help.className = 'ss-root sk-root';
        help.hidden = true;
        var tabs = visibleTabs().slice(0, 9).map(function (el, i) {
            return '<li>' + kbd(String(i + 1)) + '<span>' + el.textContent.trim() + '</span></li>';
        }).join('');
        help.innerHTML =
            '<div class="ss-scrim" data-close></div>' +
            '<div class="ss-panel sk-panel" role="dialog" aria-modal="true" aria-labelledby="skTitle">' +
            '  <div class="sk-head"><h2 id="skTitle">Klavye kısayolları</h2><button class="ss-close" data-close aria-label="Kapat"><span class="ss-kbd">Esc</span></button></div>' +
            '  <div class="sk-body">' +
            '    <section><h3>Genel</h3><ul>' +
            '      <li>' + kbd('/') + '<i>ya da</i>' + kbd(/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K') + '<span>Oda veya misafir ara</span></li>' +
            '      <li>' + kbd('N') + '<span>Bu ekranda yeni kayıt</span></li>' +
            (ordersVisible() ? '      <li>' + kbd('T') + '<span>Misafir QR talepleri</span></li>' : '') +
            '      <li>' + kbd('?') + '<span>Bu pencere</span></li>' +
            '    </ul></section>' +
            '    <section><h3>Modüller</h3><ul>' + tabs + '</ul></section>' +
            '  </div>' +
            '  <p class="sk-note">Kısayollar yazı yazarken çalışmaz.</p>' +
            '</div>';
        document.body.appendChild(help);
        help.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeHelp(); });
    }
    function openHelp() { if (help) help.remove(); buildHelp(); help.hidden = false; help.querySelector('.ss-close').focus(); }
    function closeHelp() { if (help) help.hidden = true; }
    function helpOpen() { return !!help && !help.hidden; }

    Shell.addKeyHandler(function (e, typing) {
        if (helpOpen()) {
            if (e.key === 'Escape' || e.key === '?') { closeHelp(); return true; }
            return false;
        }
        if (typing || e.ctrlKey || e.metaKey || e.altKey) return false;
        if (window.ShellSearch && ShellSearch.isOpen()) return false;
        var k = e.key;
        if (k === '?') { openHelp(); return true; }
        if (/^[1-9]$/.test(k)) {
            var tab = visibleTabs()[Number(k) - 1];
            if (!tab) return false;
            tab.click();
            return true;
        }
        var lk = (k || '').toLowerCase();
        if (lk === 'n' && !e.shiftKey) return newRecord();
        if (lk === 't' && !e.shiftKey && ordersVisible()) { document.querySelector('.sh-tab.sh-orders').click(); return true; }
        return false;
    });

    // Menüde kısayolu ipucu olarak göster (fareyle üzerine gelince).
    function hints() {
        visibleTabs().slice(0, 9).forEach(function (el, i) { el.title = el.textContent.trim() + ' — kısayol: ' + (i + 1); });
        var o = document.querySelector('.sh-tab.sh-orders'); if (o) o.title = 'Misafir QR talepleri — kısayol: T';
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(hints, 0); });
    else setTimeout(hints, 0);
    window.ShellKeys = { openHelp: openHelp, closeHelp: closeHelp, _newRecord: newRecord };
})();
