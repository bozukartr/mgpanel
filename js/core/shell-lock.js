/* Hotizy — shell-lock.js · Ortak cihaz ekran kilidi (App Shell)
 *
 * Resepsiyon tableti gibi ortak kullanılan hesaplarda personel ayrıldığında
 * ekran açık kalıyordu: masaya gelen bir misafir paneli kullanabilirdi.
 * Yönetici kullanıcı ayarlarından açar (screenLocks/{uid}: idleMin + PIN'in
 * tuzlu SHA-256 özeti). Belirtilen süre boyunca dokunuş / tuş / kaydırma
 * olmazsa (kabukta ya da herhangi bir modül çerçevesinde) ekran kilitlenir;
 * ekip kısa PIN ile açar. Profil menüsünden "Ekranı kilitle" ile elle de
 * kilitlenir.
 *
 *   · Kilit sayfa yenilemeyle aşılamaz (durum localStorage'da).
 *   · 5 yanlış denemeden sonra tuş takımı kapanır: yalnızca hesaptan çıkıp
 *     şifreyle giriş.
 *   · Arka planda bildirimler gelmeye devam eder; kilit ekranında sayısı görünür.
 * Not: bu bir kolaylık kilididir (misafirin ekranı kullanmasını önler);
 * hesabın asıl güvenliği giriş şifresidir.
 */
(function () {
    'use strict';
    if (typeof auth === 'undefined' || typeof db === 'undefined') return;
    var MAX_FAILS = 5;
    var cfg = null, uid = '', lastAct = Date.now(), timer = null, el = null, pin = '';
    var LK = function () { return 'hz_locked_' + uid; };
    var FK = function () { return 'hz_lock_fail_' + uid; };
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
    function fails() { return Number(lsGet(FK()) || 0); }
    function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
    function hashOf(salt, p) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + p)).then(hex); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function isLocked() { return document.documentElement.classList.contains('hz-locked'); }

    function build() {
        el = document.createElement('div');
        el.className = 'lk-root';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Ekran kilitli');
        var name = localStorage.getItem('hotelUsername') || '';
        var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map(function (k) {
            if (!k) return '<span></span>';
            if (k === 'del') return '<button type="button" class="lk-key lk-del" data-k="del" aria-label="Sil"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="m18 9-6 6M12 9l6 6"/></svg></button>';
            return '<button type="button" class="lk-key" data-k="' + k + '">' + k + '</button>';
        }).join('');
        el.innerHTML =
            '<div class="lk-card">' +
            '  <div class="lk-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>' +
            '  <div class="lk-time" id="lkTime"></div>' +
            '  <div class="lk-who">Ekran kilitli · <b>' + esc(name) + '</b></div>' +
            '  <div class="lk-note" id="lkNote"></div>' +
            '  <div class="lk-dots" id="lkDots" aria-live="polite"></div>' +
            '  <div class="lk-msg" id="lkMsg"></div>' +
            '  <div class="lk-pad" id="lkPad">' + keys + '</div>' +
            '  <button type="button" class="lk-out" id="lkOut">Hesaptan çık · şifreyle gir</button>' +
            '</div>';
        document.body.appendChild(el);
        el.addEventListener('click', function (e) {
            var k = e.target.closest('[data-k]');
            if (k) press(k.dataset.k);
        });
        el.querySelector('#lkOut').addEventListener('click', function () {
            this.disabled = true;
            lsSet(LK(), null); lsSet(FK(), null);
            if (typeof hotelSignOut === 'function') hotelSignOut('login'); else location.replace('login');
        });
        document.addEventListener('keydown', function (e) {
            if (!isLocked()) return;
            e.stopPropagation();
            if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
            else if (e.key === 'Backspace') { e.preventDefault(); press('del'); }
        }, true);
    }
    function render(msg, bad) {
        if (!el) return;
        var len = (cfg && cfg.pinLength) || 4;
        var dots = '';
        for (var i = 0; i < len; i++) dots += '<i class="' + (i < pin.length ? 'on' : '') + '"></i>';
        el.querySelector('#lkDots').innerHTML = dots;
        var m = el.querySelector('#lkMsg');
        m.textContent = msg || '';
        m.className = 'lk-msg' + (bad ? ' bad' : '');
        var blocked = fails() >= MAX_FAILS;
        el.querySelector('#lkPad').classList.toggle('off', blocked);
        if (blocked) { m.textContent = 'Çok fazla yanlış deneme. Hesaptan çıkıp şifreyle giriş yapın.'; m.className = 'lk-msg bad'; }
        clock();
    }
    // Saat ve bekleyen bildirim sayısı (kilitliyken 15 sn'de bir tazelenir).
    function clock() {
        if (!el) return;
        el.querySelector('#lkTime').textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        var badge = document.getElementById('rt-badge');
        var n = badge ? parseInt(badge.textContent, 10) || 0 : 0;
        el.querySelector('#lkNote').textContent = n && badge.offsetParent !== null ? n + ' yeni bildirim' : '';
    }
    function press(k) {
        if (!cfg || fails() >= MAX_FAILS) return;
        var len = cfg.pinLength || 6;
        if (k === 'del') { pin = pin.slice(0, -1); render(); return; }
        if (pin.length >= len) return;
        pin += k;
        render();
        if (pin.length === len) check();
    }
    function check() {
        var tryPin = pin;
        hashOf(cfg.salt || '', tryPin).then(function (h) {
            if (h === cfg.pinHash) { unlock(); return; }
            var f = fails() + 1;
            lsSet(FK(), String(f));
            pin = '';
            el.querySelector('.lk-card').classList.remove('shake');
            void el.offsetWidth;
            el.querySelector('.lk-card').classList.add('shake');
            try { navigator.vibrate && navigator.vibrate([40, 30, 40]); } catch (e) {}
            render(f < MAX_FAILS ? 'Yanlış PIN · ' + (MAX_FAILS - f) + ' deneme hakkı kaldı' : '', true);
        });
    }
    function lock() {
        if (!cfg || isLocked()) return;
        if (!el) build();
        pin = '';
        lsSet(LK(), '1');
        // Odak çerçevede kalmasın: tuşlar kilit ekranına gelsin.
        try { (window.Shell ? Shell.frames() : []).forEach(function (f) { try { var a = f.contentDocument && f.contentDocument.activeElement; if (a && a.blur) a.blur(); } catch (e) {} }); } catch (e) {}
        try { if (window.ShellSearch) ShellSearch.close(); if (window.ShellProfile) ShellProfile.close(); } catch (e) {}
        document.documentElement.classList.add('hz-locked');
        render();
        try { el.querySelector('.lk-key').focus(); } catch (e) {}
    }
    function unlock() {
        document.documentElement.classList.remove('hz-locked');
        lsSet(LK(), null); lsSet(FK(), null);
        pin = '';
        lastAct = Date.now();
    }
    function tick() {
        if (!cfg) return;
        if (isLocked()) { clock(); return; }
        if (Date.now() - lastAct >= cfg.idleMin * 60000) lock();
    }
    function addMenuItem() {
        var list = document.querySelector('#shProfileMenu .pm-list');
        if (!list || document.getElementById('pmLock')) return;
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'pm-item'; b.id = 'pmLock'; b.setAttribute('role', 'menuitem');
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path d="M12 15v2"/></svg><span>Ekranı kilitle</span><em class="pm-meta">' + cfg.idleMin + ' dk boşta</em>';
        b.addEventListener('click', function () { if (window.ShellProfile) ShellProfile.close(); lock(); });
        list.insertBefore(b, list.firstChild);
    }
    function loadCfg() {
        return db.collection('screenLocks').doc(uid).get().then(function (s) {
            var c = s.exists ? s.data() : null;
            cfg = (c && c.idleMin > 0 && c.pinHash) ? c : null;
            if (!cfg) { if (isLocked()) unlock(); var mi = document.getElementById('pmLock'); if (mi) mi.remove(); return; }
            addMenuItem();
            if (!timer) timer = setInterval(tick, 15000);
            if (lsGet(LK()) === '1') lock();   // yenilemeyle aşılamaz
        }).catch(function () { /* ayar okunamadı: kilit yok */ });
    }

    if (window.Shell && Shell.onActivity) Shell.onActivity(function () { if (!isLocked()) lastAct = Date.now(); });
    auth.onAuthStateChanged(function (u) {
        if (!u) return;
        uid = u.uid;
        loadCfg();
        setInterval(loadCfg, 10 * 60 * 1000);   // yönetici ayarı değiştirirse
    });
    window.ShellLock = { lock: lock, isLocked: isLocked, _cfg: function () { return cfg; } };
})();
