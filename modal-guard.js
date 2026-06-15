/* StayOS — modal-guard.js
 *
 * Global guard: closing a modal by clicking OUTSIDE it (on the backdrop) asks
 * for confirmation IF the user has changed/typed something inside. Explicit
 * close buttons (×, Cancel) are untouched — only outside-clicks are guarded.
 *
 * Works across the app's modal patterns (`.modal`, `.modal-backdrop`) without
 * editing each one: it snapshots a modal's field values when it opens and only
 * prompts when the current values differ, so prefilled "edit" modals don't nag.
 *
 * Drop-in: include on any page that has modals. No dependencies.
 */
(function () {
    'use strict';
    var SEL = '.modal, .modal-backdrop';
    var MSG = 'Kaydedilmemiş değişiklikler var. Bu pencereyi kapatmak istiyor musunuz?';

    function isVisible(el) {
        if (!el) return false;
        var s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        return el.offsetParent !== null || s.position === 'fixed';
    }
    function editableFields(el) {
        var skip = { button: 1, submit: 1, reset: 1, file: 1, hidden: 1, image: 1, range: 1, color: 1 };
        var out = [];
        el.querySelectorAll('input, textarea, select').forEach(function (i) {
            var t = (i.type || 'text').toLowerCase();
            if (!skip[t]) out.push(i);
        });
        return out;
    }
    function valOf(i) {
        var t = (i.type || '').toLowerCase();
        return (t === 'checkbox' || t === 'radio') ? !!i.checked : (i.value || '');
    }
    function snapshot(el) {
        var map = [];
        editableFields(el).forEach(function (i) { map.push([i, valOf(i)]); });
        el.__mgSnap = map;
    }
    function isDirty(el) {
        var snap = el.__mgSnap;
        var fields = editableFields(el);
        if (snap) {
            // Compare against the values captured when the modal opened.
            for (var k = 0; k < snap.length; k++) {
                if (snap[k][0].isConnected !== false && valOf(snap[k][0]) !== snap[k][1]) return true;
            }
            return false;
        }
        // No snapshot (opened before guard saw it): treat any non-empty text as dirty.
        for (var j = 0; j < fields.length; j++) {
            var i = fields[j], t = (i.type || '').toLowerCase();
            if (t === 'checkbox' || t === 'radio') continue;
            if (String(i.value || '').trim() !== '') return true;
        }
        return false;
    }

    // ── Snapshot on open (track visibility transitions) ────────
    var visState = new WeakMap();
    function refresh(el) {
        var vis = isVisible(el);
        var was = visState.get(el) || false;
        if (vis && !was) snapshot(el);
        visState.set(el, vis);
    }
    var attrObserver = new MutationObserver(function (muts) {
        for (var n = 0; n < muts.length; n++) {
            var el = muts[n].target;
            if (el.matches && el.matches(SEL)) refresh(el);
        }
    });
    function watch(el) {
        refresh(el);
        attrObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }
    function watchAll(root) {
        (root || document).querySelectorAll(SEL).forEach(watch);
    }
    var addObserver = new MutationObserver(function (muts) {
        for (var m = 0; m < muts.length; m++) {
            var added = muts[m].addedNodes || [];
            for (var a = 0; a < added.length; a++) {
                var node = added[a];
                if (node.nodeType !== 1) continue;
                if (node.matches && node.matches(SEL)) watch(node);
                if (node.querySelectorAll) watchAll(node);
            }
        }
    });

    // ── Minimal in-page confirm (no native popup) ─────────────
    function injectStyles() {
        if (document.getElementById('mg-styles')) return;
        var css = '.mg-c-back{position:fixed;inset:0;background:rgba(15,23,42,.28);z-index:100000;display:flex;'
            + 'align-items:center;justify-content:center;opacity:0;transition:opacity .15s;font-family:Outfit,system-ui,sans-serif}'
            + '.mg-c-back.show{opacity:1}'
            + '.mg-c{background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.22);max-width:300px;width:calc(100% - 48px);'
            + 'padding:18px 18px 14px;transform:translateY(6px);transition:transform .15s}'
            + '.mg-c-back.show .mg-c{transform:none}'
            + '.mg-c-msg{font-size:14.5px;color:#1e293b;line-height:1.45;font-weight:500}'
            + '.mg-c-row{display:flex;gap:8px;margin-top:16px}'
            + '.mg-c-row button{flex:1;border:none;border-radius:10px;padding:11px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit}'
            + '.mg-no{background:#f1f5f9;color:#475569}.mg-yes{background:#ef4444;color:#fff}';
        var s = document.createElement('style'); s.id = 'mg-styles'; s.textContent = css; document.head.appendChild(s);
    }
    var confirmEl = null, onYesCb = null;
    function buildConfirm() {
        injectStyles();
        confirmEl = document.createElement('div');
        confirmEl.className = 'mg-c-back';
        confirmEl.innerHTML = '<div class="mg-c"><div class="mg-c-msg">' + MSG
            + '</div><div class="mg-c-row"><button class="mg-no" type="button">Vazgeç</button>'
            + '<button class="mg-yes" type="button">Kapat</button></div></div>';
        document.body.appendChild(confirmEl);
        var close = function () { confirmEl.classList.remove('show'); onYesCb = null; };
        confirmEl.querySelector('.mg-no').addEventListener('click', close);
        confirmEl.addEventListener('click', function (e) { if (e.target === confirmEl) close(); });
        confirmEl.querySelector('.mg-yes').addEventListener('click', function () {
            var cb = onYesCb; close(); if (cb) cb();
        });
    }
    function askClose(onYes) {
        if (!confirmEl) buildConfirm();
        onYesCb = onYes;
        confirmEl.classList.add('show');
    }
    function hideModal(el) {
        // Close the same way the modal itself would (class- or inline-based).
        el.classList.remove('show', 'active', 'open');
        if (isVisible(el)) el.style.display = 'none';
        el.__mgSnap = null;
        visState.set(el, false);
    }

    // ── Intercept outside-clicks (capture phase, before close handlers) ──
    document.addEventListener('click', function (e) {
        var el = e.target;
        if (!(el && el.matches && el.matches(SEL))) return;   // only direct backdrop clicks
        if (!isVisible(el)) return;
        if (isDirty(el)) {
            // Block the native close, ask with a minimal in-page dialog instead.
            e.stopImmediatePropagation();
            e.preventDefault();
            askClose(function () { hideModal(el); });
            return;
        }
        // Not dirty: let it close, just forget the snapshot.
        el.__mgSnap = null;
        visState.set(el, false);
    }, true);

    function init() {
        watchAll(document);
        if (document.body) addObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
