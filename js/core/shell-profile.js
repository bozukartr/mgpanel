/* Hotizy — shell-profile.js · Profil menüsü (App Shell)
 *
 * Kullanıcı adına dokununca açılır. Önceden başlıkta yalnızca bir çıkış
 * düğmesi vardı (yanlışlıkla basılabiliyordu) ve kişi kendi şifresini
 * isteyerek değiştiremiyor, Face ID cihazlarını göremiyordu.
 *
 *   · Görünüm: Açık / Koyu / Sistem (theme.js)
 *   · Şifremi değiştir: mevcut şifreyle yeniden doğrulama → yeni şifre
 *     (F&B kodla giriş hesaplarında gizli: şifre koddan türetilir)
 *   · Face ID / Touch ID: yönetici izin verdiyse — bu cihazda aç, kayıtlı
 *     cihazları gör / kaldır (passkeyManage)
 *   · Cihaz bildirimleri: durum + tek dokunuşla aç / onar (push.js)
 *   · Klavye kısayolları (masaüstü) · Çıkış yap (app-shell.js bağlar)
 * Masaüstünde açılır menü, mobilde alttan açılan sayfa.
 */
(function () {
    'use strict';
    if (typeof auth === 'undefined') return;
    var $ = function (id) { return document.getElementById(id); };
    var btn = $('shProfileBtn'), menu = $('shProfileMenu'), scrim = $('shProfileScrim');
    if (!btn || !menu) return;
    var USERNAME = localStorage.getItem('hotelUsername') || '';
    var ROLE = (localStorage.getItem('hotelRole') || '').toLowerCase();
    var DEPT = localStorage.getItem('hotelDept') || '';
    var CTX = localStorage.getItem('loginContext') || 'hotel';
    var ROLE_TR = { admin: 'Yönetici (admin)', manager: 'Yönetici', staff: 'Personel' };
    var fn = function (name) { return firebase.app().functions('us-central1').httpsCallable(name); };
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    // ── Menü aç / kapat ────────────────────────────────────────────
    function isOpen() { return !menu.hidden; }
    function open() {
        refresh();
        menu.hidden = false;
        if (scrim) scrim.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        var first = menu.querySelector('.pm-seg button[aria-checked="true"]') || menu.querySelector('.pm-item');
        if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 0);
    }
    function close() {
        menu.hidden = true;
        if (scrim) scrim.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('click', function () { isOpen() ? close() : open(); });
    if (scrim) scrim.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) { close(); btn.focus(); } });

    // ── Üst bilgi ──────────────────────────────────────────────────
    var name = USERNAME ? USERNAME.charAt(0).toUpperCase() + USERNAME.slice(1) : 'Ekip';
    $('pmName').textContent = name;
    $('pmAv').textContent = (USERNAME.slice(0, 2) || '··').toUpperCase();
    $('pmRole').textContent = [ROLE_TR[ROLE] || (ROLE ? ROLE : 'Personel'), DEPT].filter(Boolean).join(' · ');

    // ── Görünüm ────────────────────────────────────────────────────
    function syncTheme() {
        var cur = window.Theme ? Theme.get() : 'light';
        menu.querySelectorAll('.pm-seg button').forEach(function (b) { b.setAttribute('aria-checked', b.dataset.theme === cur ? 'true' : 'false'); });
    }
    menu.querySelectorAll('.pm-seg button').forEach(function (b) {
        b.addEventListener('click', function () { if (window.Theme) Theme.set(b.dataset.theme); syncTheme(); });
    });
    window.addEventListener('storage', function (e) { if (e.key === 'hz_theme') syncTheme(); });

    // ── Cihaz bildirimleri ─────────────────────────────────────────
    function syncPush() {
        var meta = $('pmPushMeta');
        if (!meta) return;
        var s = window.Push && Push.state ? Push.state() : { supported: false };
        meta.className = 'pm-meta';
        if (!s.supported) meta.textContent = 'Desteklenmiyor';
        else if (s.permission === 'denied') { meta.textContent = 'Engelli'; meta.classList.add('bad'); }
        else if (s.permission === 'granted' && s.registered) { meta.textContent = 'Açık'; meta.classList.add('on'); }
        else { meta.textContent = 'Kapalı'; meta.classList.add('warn'); }
    }
    $('pmPush').addEventListener('click', async function () {
        var s = window.Push && Push.state ? Push.state() : { supported: false };
        if (!s.supported) { toast('Bu tarayıcı cihaz bildirimlerini desteklemiyor.'); return; }
        if (s.permission === 'denied') { toast('Bildirimler engelli — tarayıcı / telefon ayarlarından bu site için bildirim iznini açın.'); return; }
        var meta = $('pmPushMeta'); meta.textContent = '…';
        try { await Push.repair(); } catch (e) {}
        syncPush();
        var st = Push.state();
        toast(st.permission === 'granted' && st.registered ? 'Cihaz bildirimleri açık — uygulama kapalıyken de bildirim alırsınız.' : 'Bildirimler açılamadı.');
    });

    // ── Klavye kısayolları ─────────────────────────────────────────
    $('pmKeys').addEventListener('click', function () { close(); if (window.ShellKeys) ShellKeys.openHelp(); });

    // ── Küçük pencere altyapısı (arama paletiyle aynı katman stilleri) ──
    function dialog(title, bodyHtml) {
        close();
        var root = document.createElement('div');
        root.className = 'ss-root';
        root.innerHTML = '<div class="ss-scrim" data-close></div>' +
            '<div class="ss-panel pd-panel" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
            '<div class="pd-head"><h2>' + esc(title) + '</h2><button class="ss-close" data-close aria-label="Kapat"><span class="ss-kbd">Esc</span><span class="ss-x"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span></button></div>' +
            '<div class="pd-body">' + bodyHtml + '</div></div>';
        document.body.appendChild(root);
        var done = function () { root.remove(); document.removeEventListener('keydown', onKey, true); };
        var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
        document.addEventListener('keydown', onKey, true);
        root.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) done(); });
        return { root: root, close: done, q: function (s) { return root.querySelector(s); } };
    }
    var toastEl = null, toastT = null;
    function toast(msg) {
        if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'pm-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastT);
        toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 4200);
    }

    // ── Şifremi değiştir ───────────────────────────────────────────
    var fnbAccount = CTX === 'fnb' || (typeof isFnbDept === 'function' && isFnbDept(DEPT));
    if (fnbAccount) $('pmPassword').hidden = true;   // F&B şifresi koddan türetilir; değişirse kodla giriş bozulur
    $('pmPassword').addEventListener('click', function () {
        var d = dialog('Şifremi değiştir',
            '<p class="pd-note">Güvenlik için önce mevcut şifrenizi girin. Yeni şifre en az 6 karakter olmalı.</p>' +
            '<label for="pdCur">Mevcut şifre</label><input type="password" id="pdCur" autocomplete="current-password">' +
            '<label for="pdNew">Yeni şifre</label><input type="password" id="pdNew" autocomplete="new-password">' +
            '<label for="pdNew2">Yeni şifre (tekrar)</label><input type="password" id="pdNew2" autocomplete="new-password">' +
            '<p class="pd-err" id="pdErr"></p><button class="pd-btn" id="pdSave">Şifreyi kaydet</button>');
        setTimeout(function () { d.q('#pdCur').focus(); }, 30);
        var err = d.q('#pdErr'), save = d.q('#pdSave');
        var submit = async function () {
            var cur = d.q('#pdCur').value, n1 = d.q('#pdNew').value, n2 = d.q('#pdNew2').value;
            err.textContent = '';
            if (!cur) { err.textContent = 'Mevcut şifrenizi girin.'; return; }
            if (n1.length < 6) { err.textContent = 'Yeni şifre en az 6 karakter olmalı.'; return; }
            if (n1 !== n2) { err.textContent = 'Yeni şifreler eşleşmiyor.'; return; }
            if (n1 === cur) { err.textContent = 'Yeni şifre mevcut şifreyle aynı.'; return; }
            var u = auth.currentUser;
            if (!u || !u.email) { err.textContent = 'Oturum bulunamadı, yeniden giriş yapın.'; return; }
            save.disabled = true; save.textContent = 'Kaydediliyor…';
            try {
                await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, cur));
                await u.updatePassword(n1);
                d.close();
                toast('Şifreniz değiştirildi.');
            } catch (e) {
                var c = (e && e.code) || '';
                err.textContent = (c === 'auth/wrong-password' || c === 'auth/invalid-credential' || c === 'auth/invalid-login-credentials') ? 'Mevcut şifre yanlış.'
                    : c === 'auth/too-many-requests' ? 'Çok fazla deneme. Birkaç dakika sonra tekrar deneyin.'
                    : c === 'auth/weak-password' ? 'Yeni şifre çok zayıf.'
                    : 'Şifre değiştirilemedi. Tekrar deneyin.';
                save.disabled = false; save.textContent = 'Şifreyi kaydet';
            }
        };
        save.addEventListener('click', submit);
        d.root.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
    });

    // ── Face ID / Touch ID ─────────────────────────────────────────
    var faceIdAllowed = false, available = false;
    var label = window.Passkey ? Passkey.label() : 'Face ID';
    $('pmFaceIdLabel').textContent = label;
    function uid() { return (auth.currentUser || {}).uid || ''; }
    function syncFaceId() {
        var item = $('pmFaceId');
        item.hidden = !faceIdAllowed || CTX !== 'hotel';
        var meta = $('pmFaceIdMeta');
        meta.className = 'pm-meta';
        if (!available) meta.textContent = 'Bu cihazda yok';
        else if (window.Passkey && Passkey.userHasKeyHere(uid())) { meta.textContent = 'Bu cihazda açık'; meta.classList.add('on'); }
        else meta.textContent = 'Kapalı';
    }
    auth.onAuthStateChanged(async function (u) {
        if (!u) return;
        try {
            var snap = await db.collection('systemUsers').doc(u.uid).get();
            faceIdAllowed = !!(snap.exists && snap.data().faceIdAllowed === true);
        } catch (e) { faceIdAllowed = false; }
        try { available = !!(window.Passkey && await Passkey.available()); } catch (e) { available = false; }
        syncFaceId();
    });
    function fmtDate(ms) { if (!ms) return '—'; var d = new Date(ms); return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }); }
    $('pmFaceId').addEventListener('click', function () {
        var d = dialog(label + ' ile giriş',
            '<p class="pd-note">Açık olan cihazlarda şifre yazmadan girersiniz. Yüz / parmak izi bilginiz cihazınızdan hiç çıkmaz.</p>' +
            '<div id="pdDevs"><p class="pd-note">Yükleniyor…</p></div>' +
            '<p class="pd-err" id="pdErr"></p>' +
            '<div class="pd-actions">' + (available ? '<button class="pd-btn" id="pdHere" disabled>Bu cihazda aç</button>' : '') + '</div>');
        var err = d.q('#pdErr'), here = d.q('#pdHere'), opts = null;
        async function load() {
            try {
                var r = await fn('passkeyManage')({ action: 'list' });
                var list = (r.data && r.data.devices) || [];
                d.q('#pdDevs').innerHTML = list.length ? list.map(function (x) {
                    return '<div class="pd-dev"><span>' + esc(x.deviceLabel || 'Cihaz') + '<small>Eklendi ' + esc(fmtDate(x.createdAt)) + ' · son giriş ' + esc(fmtDate(x.lastUsedAt)) + '</small></span><button data-rm="' + esc(x.id) + '">Kaldır</button></div>';
                }).join('') : '<p class="pd-note">Henüz hiçbir cihazda açık değil.</p>';
                var onThis = list.some(function (x) { return x.rpID === location.hostname; }) && window.Passkey && Passkey.userHasKeyHere(uid());
                if (here) here.hidden = !!onThis;
            } catch (e) { d.q('#pdDevs').innerHTML = '<p class="pd-err">Cihazlar yüklenemedi.</p>'; }
        }
        // Kayıt seçenekleri önceden alınır: Safari Face ID penceresini yalnızca
        // dokunuşla aynı anda istenirse açar.
        async function prefetch() {
            if (!here) return;
            try { var r = await fn('passkeyRegisterOptions')({}); opts = r.data; here.disabled = false; }
            catch (e) { here.disabled = true; err.textContent = (e && e.message) || label + ' şu an açılamıyor.'; }
        }
        d.q('#pdDevs').addEventListener('click', async function (e) {
            var b = e.target.closest('[data-rm]');
            if (!b) return;
            b.disabled = true;
            try {
                await fn('passkeyManage')({ action: 'revoke', id: b.dataset.rm });
                if (window.Passkey) { Passkey.forgetUser(uid()); }
                toast('Cihaz kaldırıldı.');
                load(); syncFaceId(); prefetch();
            } catch (er) { err.textContent = 'Kaldırılamadı.'; b.disabled = false; }
        });
        if (here) here.addEventListener('click', async function () {
            if (!opts) return;
            var o = opts; opts = null; here.disabled = true; err.textContent = '';
            var att;
            try { att = await Passkey.create(o); }
            catch (e) {
                if (e && e.name === 'InvalidStateError') { Passkey.markDevice(uid()); syncFaceId(); load(); return; }
                err.textContent = Passkey.isCancel(e) ? 'İptal edildi.' : label + ' açılamadı.';
                prefetch(); return;
            }
            try {
                await fn('passkeyRegisterVerify')({ response: att });
                Passkey.markDevice(uid());
                toast(label + ' bu cihazda açıldı.');
                syncFaceId(); load();
            } catch (e) { err.textContent = (e && e.message) || 'Kayıt tamamlanamadı.'; prefetch(); }
        });
        load(); prefetch();
    });

    function refresh() { syncTheme(); syncPush(); syncFaceId(); }
    refresh();
    window.ShellProfile = { open: open, close: close };
})();
