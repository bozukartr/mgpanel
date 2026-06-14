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

    // ── Intercept outside-clicks (capture phase, before close handlers) ──
    document.addEventListener('click', function (e) {
        var el = e.target;
        if (!(el && el.matches && el.matches(SEL))) return;   // only direct backdrop clicks
        if (!isVisible(el)) return;
        if (isDirty(el)) {
            if (!window.confirm(MSG)) {
                e.stopImmediatePropagation();
                e.preventDefault();
                return;
            }
        }
        // Proceeding to close: forget the snapshot so the next open is clean.
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
