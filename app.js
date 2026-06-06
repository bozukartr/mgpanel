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
        if (d.enabled && ends && ends > new Date()) window.location.replace('maintenance.html');
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
    const logoWrapper = document.getElementById('logoWrapper');
    const loginCard = document.getElementById('loginCard');
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const paymentOverlay = document.getElementById('paymentOverlay');
    const paymentCloseBtn = document.getElementById('paymentCloseBtn');
    const forcePwCard = document.getElementById('forcePwCard');
    const forcePwForm = document.getElementById('forcePwForm');
    const pwError = document.getElementById('pwError');

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
        logoWrapper.classList.add('expand');
        loginCard.classList.add('fade-out');
        forcePwCard.classList.add('fade-out');
        setTimeout(() => {
            window.location.href = 'concierge.html';
        }, 800);
    }

    setTimeout(() => {
        logoWrapper.classList.add('active');
        setTimeout(() => {
            loginCard.classList.add('show');
        }, 400);
    }, 1200);

    paymentCloseBtn.addEventListener('click', () => {
        paymentOverlay.classList.remove('show');
        auth.signOut();
    });

    function showPaymentOverlay() {
        paymentOverlay.classList.add('show');
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const userInput = document.getElementById('username').value.trim();
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
                loginCard.classList.remove('show');
                forcePwCard.style.display = 'block';
                requestAnimationFrame(() => forcePwCard.classList.add('show'));
                return;
            }

            finishLogin(userData, userInput);

        } catch (error) {
            console.error("Login Error:", error.message);
            loginCard.classList.add('shake');
            errorMessage.textContent = "Kullanıcı adı veya şifre yanlış";
            errorMessage.classList.add('show');

            setTimeout(() => {
                loginCard.classList.remove('shake');
            }, 500);
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
            window.location.href = 'login.html';
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
