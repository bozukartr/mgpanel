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
            const uid = userCredential.user.uid;

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
                pendingPwUser = userCredential.user;
                pendingPwUid = uid;
                pendingUserData = userData;
                pendingUserInput = userInput;
                mainCard.style.display = 'none';
                forcePwCard.style.display = 'block';
                return;
            }

            finishLogin(userData, userInput);

        } catch (error) {
            console.error("Login Error:", error.message);
            mainCard.classList.add('shake');
            errorMessage.textContent = "Kullanıcı adı veya şifre yanlış";
            errorMessage.classList.add('show');

            setTimeout(() => {
                mainCard.classList.remove('shake');
            }, 500);
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
            mainCard.classList.add('shake');
            errorMessage.textContent = 'Önce kullanıcı adınızı yazın';
            errorMessage.classList.add('show');
            setTimeout(() => mainCard.classList.remove('shake'), 500);
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
            if (dept !== FNB_DEPT && role !== 'admin') {
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
            finishLogin(pendingUserData, pendingUserInput);
        } catch (error) {
            console.error("Password update error:", error.message);
            pwError.textContent = "Şifre güncellenemedi. Lütfen tekrar giriş yapın.";
            pwError.classList.add('show');
        }
    });
});
