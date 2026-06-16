/* StayOS — pricing.js · Hibrit fiyat hesaplayıcı + aylık/yıllık geçiş.
   Sayfada .pr-section varsa kendini bağlar; index.html ve fiyatlandirma.html'de
   aynı şekilde çalışır. */
(function () {
    'use strict';
    var section = document.querySelector('.pr-section');
    if (!section) return;

    var PLANS = {
        starter:  { base: 49,  perRoom: 0.8 },
        pro:      { base: 99,  perRoom: 1.2 },
        business: { base: 199, perRoom: 1.5 }
    };
    var PMS = 99, EXTRA = 19, DISCOUNT = 0.18;
    var billing = 'monthly';
    var curPlan = 'pro';

    function eur(n) { return '€' + (Math.round(n * 100) / 100).toLocaleString('tr-TR'); }
    function eur0(n) { return '€' + Math.round(n).toLocaleString('tr-TR'); }
    var q = function (sel) { return section.querySelector(sel); };
    var qa = function (sel) { return section.querySelectorAll(sel); };

    var rooms = q('#prRooms'), extra = q('#prExtra'), pms = q('#prPms');
    var pmsWrap = q('.pr-check[data-pms]'), extraWrap = q('[data-extra]');
    var totalEl = q('#prTotal'), subEl = q('#prSub'), saveEl = q('#prSave');

    // ── Aylık / Yıllık ─────────────────────────────────────────
    function setBilling(b) {
        billing = b;
        qa('.pr-tg').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-billing') === b); });
        updateCards(); calc();
    }
    qa('.pr-tg').forEach(function (t) { t.addEventListener('click', function () { setBilling(t.getAttribute('data-billing')); }); });

    // Kart fiyatlarını döneme göre güncelle
    function updateCards() {
        qa('.pr-card[data-plan]').forEach(function (card) {
            var p = PLANS[card.getAttribute('data-plan')]; if (!p) return;
            var amt = card.querySelector('.amt'), note = card.querySelector('.pr-annual-note');
            if (billing === 'annual') {
                if (amt) amt.textContent = eur(Math.round(p.base * (1 - DISCOUNT)));
                if (note) note.textContent = 'yıllık ödemede aylık base · base';
            } else {
                if (amt) amt.textContent = eur(p.base);
                if (note) note.textContent = '';
            }
        });
    }

    // ── Paket seçimi ───────────────────────────────────────────
    function setPlan(plan) {
        if (!PLANS[plan]) return;
        curPlan = plan;
        qa('.pr-plan-opt').forEach(function (o) { o.classList.toggle('active', o.getAttribute('data-plan') === plan); });
        var isBiz = plan === 'business';
        // Business: tüm modüller + PMS dahil
        if (pms) { if (isBiz) pms.checked = true; pms.disabled = isBiz; }
        if (pmsWrap) pmsWrap.classList.toggle('disabled', isBiz);
        if (extra) { if (isBiz) extra.value = 0; extra.disabled = isBiz; }
        if (extraWrap) extraWrap.classList.toggle('disabled', isBiz);
        calc();
    }
    qa('.pr-plan-opt').forEach(function (o) { o.addEventListener('click', function () { setPlan(o.getAttribute('data-plan')); }); });

    // Stepper
    qa('[data-step]').forEach(function (b) {
        b.addEventListener('click', function () {
            if (!extra || extra.disabled) return;
            extra.value = Math.max(0, (parseInt(extra.value, 10) || 0) + (b.getAttribute('data-step') === 'up' ? 1 : -1));
            calc();
        });
    });
    [rooms, extra, pms].forEach(function (el) {
        if (!el) return;
        el.addEventListener('input', calc);
        el.addEventListener('change', calc);
    });

    // ── Hesap ──────────────────────────────────────────────────
    function calc() {
        var p = PLANS[curPlan]; if (!p || !totalEl) return;
        var r = Math.max(0, parseInt(rooms && rooms.value, 10) || 0);
        var x = (curPlan === 'business') ? 0 : Math.max(0, parseInt(extra && extra.value, 10) || 0);
        var pmsCost = (curPlan === 'business') ? 0 : ((pms && pms.checked) ? PMS : 0);
        var monthly = p.base + r * p.perRoom + x * EXTRA + pmsCost;
        if (billing === 'annual') {
            var annual = monthly * 12 * (1 - DISCOUNT);
            totalEl.innerHTML = eur0(annual) + '<span>/yıl</span>';
            if (subEl) subEl.textContent = '≈ ' + eur(annual / 12) + '/ay · ' + r + ' oda';
            var saved = monthly * 12 - annual;
            if (saveEl) { saveEl.style.display = saved > 0 ? 'inline-block' : 'none'; saveEl.textContent = 'Yıllık ' + eur0(saved) + ' tasarruf'; }
        } else {
            totalEl.innerHTML = eur(monthly) + '<span>/ay</span>';
            if (subEl) subEl.textContent = p.base + '€ base + ' + r + ' oda × ' + p.perRoom + '€' + (x ? (' + ' + x + ' modül') : '') + (pmsCost ? ' + PMS' : '');
            if (saveEl) saveEl.style.display = 'none';
        }
    }

    // ── Teklif Al (CTA) ────────────────────────────────────────
    // index.html'de quote modal kendi handler'ıyla açılır (data-quote);
    // standalone fiyatlandirma sayfasında ana siteye yönlendiririz.
    qa('[data-quote]').forEach(function (b) {
        b.addEventListener('click', function (e) {
            var card = b.closest('.pr-card');
            if (card && card.getAttribute('data-plan')) setPlan(card.getAttribute('data-plan'));
            if (!document.getElementById('quoteModal')) { e.preventDefault(); window.location.href = '/#fiyatlandirma'; }
        });
    });

    setPlan('pro'); updateCards(); calc();
})();
