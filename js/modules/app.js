// Giriş sayfası bir App Shell iframe'i içinde (oturum düşmesi vb.) yüklenirse,
// üst pencerede tam ekran açılmalı — iframe içinde login gösterme.
(function () { try { if (window.top !== window.self) window.top.location.replace('login'); } catch (e) {} })();

// Maintenance enforcement — runs on the login page (and as a fallback on cached
// pages). Pre-auth, the relevant hotel comes from the URL (subdomain / ?tenant),
// NOT a previous session's localStorage, so switching hotels isn't blocked by
// another hotel's maintenance.
(function () {
    if (typeof db === 'undefined') return;
    db.collection('maintenance').doc(resolveTenant()).onSnapshot((doc) => {
        if (!doc.exists) return;
        const d = doc.data();
        const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
        if (d.enabled && ends && ends > new Date()) window.location.replace('maintenance');
    }, function () {});
})();

// Returns true if the given hotel (tenant) has an active subscription.
// Reads the tenant document first; falls back to the legacy systemConfig
// document during the multi-tenancy transition.
async function isSubscriptionActive(tenantId) {
    const now = new Date();
    try {
        const tDoc = await db.collection('tenants').doc(tenantId).get();
        if (tDoc.exists) {
            const t = tDoc.data();
            if (t.suspended === true) return false;          // suspended by the operator
            if (t.subscriptionEnd) return t.subscriptionEnd.toDate() > now;
        }
    } catch (e) { /* fall through to legacy */ }
    try {
        const subDoc = await db.collection('systemConfig').doc('subscription').get();
        if (subDoc.exists && subDoc.data().subscriptionEnd) {
            return subDoc.data().subscriptionEnd.toDate() > now;
        }
    } catch (e) { /* ignore */ }
    return false;
}

document.addEventListener('DOMContentLoaded', () => {
    const mainCard = document.getElementById('mainCard');
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const paymentOverlay = document.getElementById('paymentOverlay');
    const paymentCloseBtn = document.getElementById('paymentCloseBtn');
    const forcePwCard = document.getElementById('forcePwCard');
    const forcePwForm = document.getElementById('forcePwForm');
    const pwError = document.getElementById('pwError');
    const fnbCard = document.getElementById('fnbForm');
    const fnbForm = document.getElementById('fnbForm');
    const fnbError = document.getElementById('fnbError');

    let loginContext = 'hotel';   // 'hotel' | 'fnb'

    // Otel / F&B sekmeleri — kurumsal, animasyonsuz giriş: ayrı bir "seçici"
    // ekranına geçmek yerine aynı kartın içinde formu değiştirir.
    function switchTab(name) {
        loginContext = name;
        document.getElementById('tabHotel').classList.toggle('active', name === 'hotel');
        document.getElementById('tabFnb').classList.toggle('active', name === 'fnb');
        loginForm.classList.toggle('active', name === 'hotel');
        fnbForm.classList.toggle('active', name === 'fnb');
        const toFocus = name === 'hotel' ? document.getElementById('username') : document.getElementById('fnbCode');
        setTimeout(() => { if (toFocus) toFocus.focus(); }, 60);
    }
    document.getElementById('tabHotel').onclick = () => switchTab('hotel');
    document.getElementById('tabFnb').onclick = () => switchTab('fnb');

    // Kullanıcı adı alanları HER KOŞULDA küçük harf — Caps Lock açık olsa,
    // mobil klavye baş harfi büyütse ya da yapıştırılan metin büyük olsa bile.
    // Eşleme kuralı: kullanıcı adları e-posta ürettiğinden (userEmail) fiilen
    // ASCII'dir; bu yüzden hem 'İ' (TR klavye caps) hem 'I' (EN klavye caps)
    // 'i'ye iner — tr-TR locale'in I→ı eşlemesi burada "ADMIN"→"admın" yapıp
    // girişi bozardı. Diğer Türkçe harfler (Ş→ş, Ğ→ğ…) normal küçülür.
    function lowerUsername(s) { return String(s || '').replace(/İ/g, 'i').toLowerCase(); }
    function forceLowercase(el) {
        if (!el) return;
        el.addEventListener('input', () => {
            const lower = lowerUsername(el.value);
            if (el.value === lower) return;
            const pos = el.selectionStart;
            el.value = lower;
            try { el.setSelectionRange(pos, pos); } catch (e) {}
        });
    }
    forceLowercase(document.getElementById('username'));
    forceLowercase(document.getElementById('fnbUsername'));

    // Caps Lock açık uyarısı (şifre alanında).
    (function () {
        const pw = document.getElementById('password');
        const hint = document.getElementById('capsHint');
        if (!pw || !hint) return;
        function check(e) {
            try { hint.hidden = !e.getModifierState || !e.getModifierState('CapsLock'); }
            catch (err) { hint.hidden = true; }
        }
        pw.addEventListener('keydown', check);
        pw.addEventListener('keyup', check);
        pw.addEventListener('blur', () => { hint.hidden = true; });
    })();

    function fnbShake(msg) { fnbCard.classList.add('shake'); fnbError.textContent = msg; fnbError.classList.add('show'); setTimeout(() => fnbCard.classList.remove('shake'), 500); }

    if (document.getElementById('fnbMgrToggle')) document.getElementById('fnbMgrToggle').onclick = () => {
        const g = document.getElementById('fnbUserGroup');
        const lbl = document.getElementById('fnbCodeLabel');
        const tgl = document.getElementById('fnbMgrToggle');
        const show = g.style.display === 'none';
        g.style.display = show ? '' : 'none';
        if (lbl) lbl.textContent = show ? 'Şifre / Kod' : '5 Haneli Kod';
        tgl.textContent = show ? 'Yalnızca kod ile giriş' : 'Yönetici girişi (kullanıcı adı + şifre)';
        if (show) setTimeout(() => { const u = document.getElementById('fnbUsername'); if (u) u.focus(); }, 50);
    };

    // Holds the authenticated session while we force a password change.
    let pendingPwUser = null;
    let pendingPwUid = null;
    let pendingUserData = null;
    let pendingUserInput = '';

    let pendingViaFaceId = false;
    const offerCard = document.getElementById('faceIdOfferCard');
    const fnCall = (name) => firebase.app().functions('us-central1').httpsCallable(name);
    const fnCode = (e) => String((e && e.code) || '').replace(/^functions\//, '');

    function showLoginError(msg) {
        mainCard.classList.add('shake');
        errorMessage.textContent = msg;
        errorMessage.classList.add('show');
        setTimeout(() => mainCard.classList.remove('shake'), 500);
    }

    // ── Ortak giriş sonrası akış (şifre ve Face ID aynı yoldan geçer) ──
    // Otel (tenant) yapılandırması → abonelik → zorunlu şifre değişimi →
    // (şifreyle girildiyse) Face ID önerisi → panel.
    async function continueAfterSignIn(user, userInput, viaFaceId) {
        const uid = user.uid;

        // Resolve the user's hotel (tenant). Falls back to the default during transition.
        const userDoc = await db.collection('systemUsers').doc(uid).get();
        const userData = userDoc.exists ? userDoc.data() : null;
        const tenantId = (userData && userData.tenantId) ? userData.tenantId : resolveTenant();
        // Persist the active hotel so every page stamps writes with the right tenant.
        localStorage.setItem('hotelTenantId', tenantId);

        // Load hotel plan/modules/limits so every page can gate features.
        try {
            const tSnap = await db.collection('tenants').doc(tenantId).get();
            applyTenantConfig(tSnap.exists ? tSnap.data() : null);
        } catch (e) { applyTenantConfig(null); }

        // Check this hotel's subscription (tenant document first, legacy config as fallback).
        const subActive = await isSubscriptionActive(tenantId);
        if (!subActive) {
            showPaymentOverlay();
            return;
        }

        // Admin requested a password reset: force a new password before continuing.
        if (userData && userData.mustChangePassword === true) {
            pendingPwUser = user;
            pendingPwUid = uid;
            pendingUserData = userData;
            pendingUserInput = userInput;
            pendingViaFaceId = !!viaFaceId;
            mainCard.style.display = 'none';
            forcePwCard.style.display = 'block';
            return;
        }

        await completeLogin(userData, userInput, uid, viaFaceId);
    }

    async function completeLogin(userData, userInput, uid, viaFaceId) {
        if (window.Passkey && viaFaceId) Passkey.markDevice(uid);
        else if (await shouldOfferFaceId(userData, uid)) { showFaceIdOffer(userData, userInput, uid); return; }
        finishLogin(userData, userInput);
    }

    // ── Face ID önerisi: yalnızca yönetici bu kullanıcıya izin verdiyse ──
    // (systemUsers.faceIdAllowed — kişisel telefon kullanan personel; ortak
    // hesaplarda kapalı). "Şimdi değil" bu cihazda 14 gün sormaz.
    const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
    const snoozeKey = (uid) => 'hz_pk_snooze_' + uid;
    async function shouldOfferFaceId(userData, uid) {
        if (!window.Passkey || !userData || userData.faceIdAllowed !== true || loginContext !== 'hotel') return false;
        try { if (Date.now() - Number(localStorage.getItem(snoozeKey(uid)) || 0) < SNOOZE_MS) return false; } catch (e) {}
        if (!(await Passkey.available())) return false;
        if (Passkey.userHasKeyHere(uid)) {
            // Yerel işaret var; ama kayıt sunucuda silinmiş olabilir (şifre
            // sıfırlama ya da yönetici kaldırdı) — o zaman yeniden öner.
            try {
                const r = await fnCall('passkeyManage')({ action: 'list' });
                const here = ((r.data && r.data.devices) || []).some((d) => d.rpID === location.hostname);
                if (here) return false;
                Passkey.forgetUser(uid);
            } catch (e) { return false; }
        }
        return true;
    }

    let offerCtx = null, regOpts = null, regTimer = null;
    const fidYes = document.getElementById('fidOfferYes');
    const fidNo = document.getElementById('fidOfferNo');
    const fidErr = document.getElementById('fidOfferErr');
    function offerError(msg) { fidErr.textContent = msg; fidErr.classList.add('show'); }
    // Seçenekler önceden alınır: Safari, Face ID penceresini yalnızca dokunuşla
    // AYNI anda istenirse açar (arada ağ isteği olursa reddeder).
    async function prefetchRegistration() {
        try {
            const r = await fnCall('passkeyRegisterOptions')({});
            regOpts = r.data;
            fidYes.disabled = false;
        } catch (e) {
            regOpts = null;
            fidYes.disabled = true;
            offerError((e && e.message) || 'Face ID şu an açılamıyor.');
        }
    }
    function showFaceIdOffer(userData, userInput, uid) {
        offerCtx = { userData, userInput, uid };
        const lbl = Passkey.label();
        document.getElementById('fidOfferTitle').textContent = lbl + ' ile hızlı giriş';
        document.getElementById('fidOfferLabel').textContent = lbl;
        fidYes.textContent = lbl + ' ile girişi aç';  // Türkçe ek sorunu yok (Face ID'yi / Windows Hello'yu)
        fidYes.disabled = true;
        fidErr.classList.remove('show');
        mainCard.style.display = 'none';
        forcePwCard.style.display = 'none';
        offerCard.style.display = 'block';
        prefetchRegistration();
        let n = 0;  // doğrulama dizesi 5 dk geçerli; kart açık kaldıkça (en çok 30 dk) yenile
        regTimer = setInterval(() => { if (++n > 7) { clearInterval(regTimer); return; } prefetchRegistration(); }, 4 * 60 * 1000);
    }
    function leaveOffer() {
        clearInterval(regTimer);
        finishLogin(offerCtx.userData, offerCtx.userInput);
    }
    fidYes.addEventListener('click', async () => {
        if (!regOpts || !offerCtx) return;
        const opts = regOpts;
        regOpts = null;
        fidYes.disabled = true;
        fidErr.classList.remove('show');
        let att;
        try { att = await Passkey.create(opts); }
        catch (e) {
            if (e && e.name === 'InvalidStateError') { Passkey.markDevice(offerCtx.uid); leaveOffer(); return; } // zaten kayıtlı
            offerError(Passkey.isCancel(e) ? 'İptal edildi. İsterseniz tekrar deneyin.' : (Passkey.label() + ' açılamadı. Tekrar deneyin.'));
            prefetchRegistration();
            return;
        }
        try {
            await fnCall('passkeyRegisterVerify')({ response: att });
            Passkey.markDevice(offerCtx.uid);
            const ok = document.createElement('div');
            ok.className = 'fid-ok';
            ok.textContent = Passkey.label() + ' açıldı. Bir dahaki girişte kullanabilirsiniz.';
            fidErr.after(ok);
            setTimeout(leaveOffer, 900);
        } catch (e) {
            offerError((e && e.message) || 'Face ID kaydı tamamlanamadı.');
            prefetchRegistration();
        }
    });
    fidNo.addEventListener('click', () => {
        try { localStorage.setItem(snoozeKey(offerCtx.uid), String(Date.now())); } catch (e) {}
        leaveOffer();
    });

    // ── Face ID ile giriş düğmesi: bu cihazda daha önce açıldıysa görünür ──
    const fidBox = document.getElementById('faceIdBox');
    const fidBtn = document.getElementById('faceIdBtn');
    let authOpts = null, authOptsAt = 0;
    const OPTS_FRESH_MS = 4 * 60 * 1000;   // sunucuda 5 dk geçerli
    async function prefetchLogin() {
        try { const r = await fnCall('passkeyLoginOptions')({}); authOpts = r.data; authOptsAt = Date.now(); }
        catch (e) { authOpts = null; }
    }
    (async function initFaceIdLogin() {
        if (!window.Passkey || !fidBox || !Passkey.deviceHasKey()) return;
        if (!(await Passkey.available())) return;
        document.getElementById('faceIdLabel').textContent = Passkey.label() + ' ile giriş';
        fidBox.hidden = false;
        prefetchLogin();
        // Seçenekler taze tutulur (Safari dokunuş anında hazır ister) — ama
        // açık bırakılmış bir giriş ekranı sürekli istek atmasın: 30 dk sonra
        // durur; sonrasında dokunuşta yenilenir.
        let n = 0;
        const t = setInterval(() => { if (++n > 7) { clearInterval(t); return; } if (!document.hidden) prefetchLogin(); }, OPTS_FRESH_MS);
    })();
    if (fidBtn) fidBtn.addEventListener('click', async () => {
        errorMessage.classList.remove('show');
        if (!authOpts || Date.now() - authOptsAt > OPTS_FRESH_MS) await prefetchLogin();   // yedek yol (bayat / bağlantı geç geldiyse)
        if (!authOpts) { showLoginError('Bağlantı kurulamadı. Şifrenizle giriş yapın.'); return; }
        const o = authOpts;
        authOpts = null;
        fidBtn.disabled = true;
        let assertion;
        try { assertion = await Passkey.get(o.options); }
        catch (e) {
            fidBtn.disabled = false;
            prefetchLogin();
            if (!Passkey.isCancel(e)) showLoginError(Passkey.label() + ' ile giriş yapılamadı. Şifrenizle deneyin.');
            return;
        }
        try {
            const r = await fnCall('passkeyLoginVerify')({ challengeId: o.challengeId, response: assertion });
            const cred = await auth.signInWithCustomToken(r.data.token);
            loginContext = 'hotel';
            await continueAfterSignIn(cred.user, '', true);
            fidBtn.disabled = false;
        } catch (e) {
            const code = fnCode(e);
            if (code === 'not-found') {
                // Kayıt sunucuda yok (kaldırılmış) — düğmeyi gizle, cihaza bildir.
                Passkey.forgetDevice();
                Passkey.signalUnknown(assertion.id);
                fidBox.hidden = true;
            }
            showLoginError((e && e.message) || (Passkey.label() + ' ile giriş yapılamadı.'));
            try { if (auth.currentUser) await auth.signOut(); } catch (e2) {}
            fidBtn.disabled = false;
            prefetchLogin();
        }
    });

    function finishLogin(userData, userInput) {
        if (userData) {
            localStorage.setItem('hotelUsername', userData.username);
            localStorage.setItem('hotelDept', userData.department);
            localStorage.setItem('hotelRole', userData.role);
        } else {
            localStorage.setItem('hotelUsername', userInput);
        }
        // Per-user module access (admin-managed). Absent = full access.
        localStorage.setItem('userModules', JSON.stringify((userData && userData.modules) || {}));
        localStorage.setItem('loginContext', loginContext);
        mainCard.classList.add('fade-hide');
        forcePwCard.classList.add('fade-hide');
        if (offerCard) offerCard.classList.add('fade-hide');
        setTimeout(() => {
            window.location.href = 'app';
        }, 250);
    }

    paymentCloseBtn.addEventListener('click', () => {
        paymentOverlay.classList.remove('show');
        auth.signOut();
    });

    function showPaymentOverlay() {
        paymentOverlay.classList.add('show');
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginContext = 'hotel';
        const userInput = document.getElementById('username').value.trim().replace(/İ/g, 'i').toLowerCase();
        const email = userInput.includes('@') ? userInput : userEmail(userInput, resolveTenant());
        const password = document.getElementById('password').value;

        try {
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            await continueAfterSignIn(userCredential.user, userInput, false);
        } catch (error) {
            console.error("Login Error:", error.message);
            showLoginError("Kullanıcı adı veya şifre yanlış");
        }
    });

    // Şifremi Unuttum: personel e-postaları gerçek bir kutuya gitmediğinden
    // (kullanici@oteladi.com, yalnızca Firebase Auth için türetilmiş bir ad)
    // standart e-posta bazlı sıfırlama linki burada işe yaramaz. Bunun
    // yerine otelin admin'ine bildirim gönderilir (bkz. forgotPasswordRequest,
    // functions/index.js); admin panelden gerçek bir şifre sıfırlaması yapıp
    // yeni şifreyi çalışana iletir. Kullanıcı adının var/yok olduğu hiçbir
    // zaman sızdırılmaz — her durumda aynı mesaj gösterilir.
    const forgotPwBtn = document.getElementById('forgotPwBtn');
    const forgotMsg = document.getElementById('forgotMsg');
    if (forgotPwBtn) forgotPwBtn.addEventListener('click', async () => {
        const userInput = (document.getElementById('username').value || '').trim().replace(/İ/g, 'i').toLowerCase();
        if (!userInput || userInput.includes('@')) {
            showLoginError('Önce kullanıcı adınızı yazın');
            return;
        }
        forgotPwBtn.disabled = true;
        const orig = forgotPwBtn.textContent;
        forgotPwBtn.textContent = 'Gönderiliyor…';
        try {
            const call = firebase.app().functions('us-central1').httpsCallable('forgotPasswordRequest');
            await call({ tenant: resolveTenant(), username: userInput });
        } catch (e) { /* jenerik mesaj her durumda gösterilir, hata sızdırılmaz */ }
        forgotMsg.textContent = 'İsteğiniz otel yöneticinize iletildi. Ulaşamıyorsanız yöneticinizle doğrudan iletişime geçin.';
        forgotMsg.classList.add('show');
        forgotPwBtn.disabled = false;
        forgotPwBtn.textContent = orig;
    });

    // Hotizy F&B girişi: kullanıcı adı + 5 haneli kod (veya admin/yönetici şifresi).
    // 5 haneliyse türetilmiş Firebase şifresi (FB + kod), değilse ham şifre denenir.
    if (fnbForm) fnbForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        fnbError.classList.remove('show');
        const userInput = (document.getElementById('fnbUsername').value || '').trim().replace(/İ/g, 'i').toLowerCase();
        const code = document.getElementById('fnbCode').value.trim();
        const tenant = resolveTenant();
        let email, attempts = [];
        if (userInput) {
            // Yönetici/personel: kullanıcı adı + şifre (5 haneliyse türetilmiş de denenir).
            email = userInput.includes('@') ? userInput : userEmail(userInput, tenant);
            if (/^\d{5}$/.test(code)) attempts.push(fnbPassword(code));
            attempts.push(code);
        } else {
            // PIN-only: yalnızca 5 haneli kod → koddan türetilmiş hesap (kullanıcı adı gerekmez).
            if (!/^\d{5}$/.test(code)) { fnbShake('5 haneli kodu girin'); return; }
            email = fnbEmail(code, tenant);
            attempts.push(fnbPassword(code));
        }

        // 5 haneli kod, sabit 'FB' önekiyle yalnızca 100.000 kombinasyon —
        // gerçek Firebase Auth denemesinden ÖNCE sunucu-taraflı bir hız
        // sınırından geçiriyoruz (bkz. auth denetimi); aşılırsa Auth
        // denemesi hiç yapılmaz. Kapı fonksiyonu başarısız olursa (ağ vb.)
        // girişi engellemiyoruz — best-effort ek koruma, tek savunma değil.
        if (/^\d{5}$/.test(code)) {
            try {
                const gate = firebase.app().functions('us-central1').httpsCallable('fnbLoginGate');
                const res = await gate({ tenant, code });
                if (!res.data || !res.data.allowed) {
                    fnbShake('Çok fazla deneme. Lütfen birkaç dakika sonra tekrar deneyin.');
                    return;
                }
            } catch (e) { /* kapı ulaşılamazsa engellemeyelim */ }
        }

        let cred = null;
        for (const pw of attempts) {
            try { cred = await auth.signInWithEmailAndPassword(email, pw); break; } catch (err) { /* sonraki denemeye geç */ }
        }
        if (!cred) { fnbShake(userInput ? 'Kullanıcı adı veya şifre yanlış' : 'Kod yanlış'); return; }
        try {
            const uid = cred.user.uid;
            const userDoc = await db.collection('systemUsers').doc(uid).get();
            const userData = userDoc.exists ? userDoc.data() : null;
            const dept = (userData && userData.department) || '';
            const role = ((userData && userData.role) || '').toLowerCase();
            if (!isFnbDept(dept) && role !== 'admin') {
                await auth.signOut();
                fnbShake('Bu giriş yalnızca F&B personeli içindir.');
                return;
            }
            const tenantId = (userData && userData.tenantId) ? userData.tenantId : resolveTenant();
            localStorage.setItem('hotelTenantId', tenantId);
            try { const tSnap = await db.collection('tenants').doc(tenantId).get(); applyTenantConfig(tSnap.exists ? tSnap.data() : null); } catch (e2) { applyTenantConfig(null); }
            const subActive = await isSubscriptionActive(tenantId);
            if (!subActive) { showPaymentOverlay(); return; }
            loginContext = 'fnb';
            finishLogin(userData, userInput);
        } catch (err) {
            console.error('F&B login error:', err);
            fnbShake('Giriş başarısız.');
        }
    });

    forcePwForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw1 = document.getElementById('newPassword').value;
        const pw2 = document.getElementById('newPassword2').value;

        pwError.classList.remove('show');

        if (pw1.length < 6) {
            pwError.textContent = "Şifre en az 6 karakter olmalı";
            pwError.classList.add('show');
            return;
        }
        if (pw1 !== pw2) {
            pwError.textContent = "Şifreler eşleşmiyor";
            pwError.classList.add('show');
            return;
        }
        if (!pendingPwUser) {
            window.location.href = 'login';
            return;
        }

        try {
            await pendingPwUser.updatePassword(pw1);
            await db.collection('systemUsers').doc(pendingPwUid).update({
                mustChangePassword: false
            });
            await completeLogin(pendingUserData, pendingUserInput, pendingPwUid, pendingViaFaceId);
        } catch (error) {
            console.error("Password update error:", error.message);
            pwError.textContent = "Şifre güncellenemedi. Lütfen tekrar giriş yapın.";
            pwError.classList.add('show');
        }
    });
});
