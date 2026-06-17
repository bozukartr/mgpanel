/* StayOS — pricing.js · Kompakt hibrit fiyat hesaplayıcı.
   Tek panel: paket + oda (maks 500) + modül seçimi (checkbox) + PMS.
   Sayfada .pr-section varsa kendini bağlar. */
(function () {
    'use strict';
    var section = document.querySelector('.pr-section');
    if (!section) return;

    var PLANS = {
        starter:  { base: 49,  perRoom: 0.8 },
        pro:      { base: 99,  perRoom: 1.2 },
        business: { base: 199, perRoom: 1.5 }
    };
    var PMS = 99, EXTRA = 19, DISCOUNT = 0.18, MAX_ROOMS = 500;
    var billing = 'monthly';
    var curPlan = 'pro';

    function eur(n) { return '€' + (Math.round(n * 100) / 100).toLocaleString('tr-TR'); }
    function eur0(n) { return '€' + Math.round(n).toLocaleString('tr-TR'); }
    var q = function (sel) { return section.querySelector(sel); };
    var qa = function (sel) { return section.querySelectorAll(sel); };

    var rooms = q('#prRooms'), roomsVal = q('#prRoomsVal'), pms = q('#prPms');
    var pmsWrap = q('.pr-check[data-pms]'), extraWrap = q('[data-extra]');
    var totalEl = q('#prTotal'), subEl = q('#prSub'), saveEl = q('#prSave');

    function modChecks() { return qa('.pr-modchk'); }
    function checkedMods() { var n = 0; modChecks().forEach(function (c) { if (c.checked) n++; }); return n; }

    // ── Aylık / Yıllık ─────────────────────────────────────────
    qa('.pr-tg').forEach(function (t) {
        t.addEventListener('click', function () {
            billing = t.getAttribute('data-billing');
            qa('.pr-tg').forEach(function (x) { x.classList.toggle('active', x === t); });
            updatePlanCards(); calc();
        });
    });

    // Paket seçeneklerindeki fiyatı döneme göre güncelle
    function updatePlanCards() {
        qa('.pr-plan-opt').forEach(function (opt) {
            var p = PLANS[opt.getAttribute('data-plan')]; if (!p) return;
            var amt = opt.querySelector('.amt');
            if (amt) amt.textContent = eur(billing === 'annual' ? Math.round(p.base * (1 - DISCOUNT)) : p.base);
        });
    }

    // ── Paket seçimi ───────────────────────────────────────────
    function setPlan(plan) {
        if (!PLANS[plan]) return;
        curPlan = plan;
        qa('.pr-plan-opt').forEach(function (o) { o.classList.toggle('active', o.getAttribute('data-plan') === plan); });
        var isBiz = plan === 'business';
        // Business: tüm modüller + PMS dahil → seçimleri kilitle
        if (pms) { if (isBiz) pms.checked = true; pms.disabled = isBiz; }
        if (pmsWrap) pmsWrap.classList.toggle('disabled', isBiz);
        modChecks().forEach(function (c) { if (isBiz) c.checked = true; c.disabled = isBiz; });
        if (extraWrap) extraWrap.classList.toggle('disabled', isBiz);
        calc();
    }
    qa('.pr-plan-opt').forEach(function (o) { o.addEventListener('click', function () { setPlan(o.getAttribute('data-plan')); }); });

    // ── Oda (slider, maks 500) ─────────────────────────────────
    function paintRange() {
        if (!rooms) return;
        var r = Math.min(MAX_ROOMS, Math.max(0, parseInt(rooms.value, 10) || 0));
        rooms.style.setProperty('--pr-fill', Math.round(r / MAX_ROOMS * 100) + '%');
        if (roomsVal) roomsVal.textContent = (r >= MAX_ROOMS ? '500+' : r);
    }
    if (rooms) {
        rooms.addEventListener('input', function () { paintRange(); calc(); });
    }
    modChecks().forEach(function (c) { c.addEventListener('change', calc); });
    if (pms) pms.addEventListener('change', calc);

    // ── Hesap ──────────────────────────────────────────────────
    function calc() {
        var p = PLANS[curPlan]; if (!p || !totalEl) return;
        var r = Math.min(MAX_ROOMS, Math.max(0, parseInt(rooms && rooms.value, 10) || 0));
        var isBiz = curPlan === 'business';
        var x = isBiz ? 0 : checkedMods();
        var pmsCost = isBiz ? 0 : ((pms && pms.checked) ? PMS : 0);
        var monthly = p.base + r * p.perRoom + x * EXTRA + pmsCost;
        var roomTxt = (r >= MAX_ROOMS ? '500+' : r) + ' oda';
        if (billing === 'annual') {
            var annual = monthly * 12 * (1 - DISCOUNT);
            totalEl.innerHTML = eur0(annual) + '<span>/yıl</span>';
            if (subEl) subEl.textContent = '≈ ' + eur(annual / 12) + '/ay · ' + roomTxt;
            var saved = monthly * 12 - annual;
            if (saveEl) { saveEl.style.display = saved > 0 ? 'inline-block' : 'none'; saveEl.textContent = 'Yıllık ' + eur0(saved) + ' tasarruf'; }
        } else {
            totalEl.innerHTML = eur(monthly) + '<span>/ay</span>';
            if (subEl) subEl.textContent = p.base + '€ base + ' + roomTxt + ' × ' + p.perRoom + '€' + (x ? (' + ' + x + ' modül') : '') + (pmsCost ? ' + PMS' : '');
            if (saveEl) saveEl.style.display = 'none';
        }
    }

    // ── Teklif Al (CTA) ────────────────────────────────────────
    // index.html'de quote modal kendi handler'ıyla açılır (data-quote);
    // standalone fiyatlandirma sayfasında ana siteye yönlendiririz.
    qa('[data-quote]').forEach(function (b) {
        b.addEventListener('click', function (e) {
            if (!document.getElementById('quoteModal')) { e.preventDefault(); window.location.href = '/#teklif'; }
        });
    });

    setPlan('pro'); updatePlanCards(); paintRange(); calc();
})();
