/* maintenance.js — Maintenance screen: live countdown + admin unlock */
document.addEventListener('DOMContentLoaded', () => {
    const cdDays = document.getElementById('cdDays');
    const cdHours = document.getElementById('cdHours');
    const cdMins = document.getElementById('cdMins');
    const cdSecs = document.getElementById('cdSecs');

    let endsAt = null;
    let timer = null;

    const pad = (n) => String(n).padStart(2, '0');
    const goToLogin = () => window.location.replace('login.html');

    function tick() {
        if (!endsAt) return;
        const remaining = endsAt.getTime() - Date.now();
        if (remaining <= 0) {
            clearInterval(timer);
            goToLogin();
            return;
        }
        const s = Math.floor(remaining / 1000);
        cdDays.textContent = pad(Math.floor(s / 86400));
        cdHours.textContent = pad(Math.floor((s % 86400) / 3600));
        cdMins.textContent = pad(Math.floor((s % 3600) / 60));
        cdSecs.textContent = pad(s % 60);
    }

    // Live-watch maintenance state; auto-return to login when it ends or is disabled.
    db.collection('systemConfig').doc('maintenance').onSnapshot((doc) => {
        if (!doc.exists) { goToLogin(); return; }
        const d = doc.data();
        const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
        const active = d.enabled && ends && ends > new Date();
        if (!active) { goToLogin(); return; }
        endsAt = ends;
        if (d.message) document.getElementById('mMessage').textContent = d.message;
        tick();
        if (!timer) timer = setInterval(tick, 1000);
    }, (err) => { console.error('Maintenance watch failed', err); });

    // Double-click the logo to reveal the admin unlock form.
    document.getElementById('mLogo').addEventListener('dblclick', () => {
        const u = document.getElementById('mUnlock');
        u.style.display = (u.style.display === 'none') ? 'block' : 'none';
        if (u.style.display === 'block') document.getElementById('mUser').focus();
    });

    // Any Admin-role user's credentials unlock the admin panel only.
    document.getElementById('mUnlockForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('mError');
        errEl.textContent = '';
        const userInput = document.getElementById('mUser').value.trim();
        const email = userInput.includes('@') ? userInput : userInput + '@hotel.com';
        const password = document.getElementById('mPass').value;

        try {
            const cred = await auth.signInWithEmailAndPassword(email, password);
            const userDoc = await db.collection('systemUsers').doc(cred.user.uid).get();
            const data = userDoc.exists ? userDoc.data() : null;
            const role = data ? (data.role || '').toLowerCase() : '';
            const uname = data ? (data.username || '').toLowerCase() : '';

            if (role === 'admin' || uname === 'admin') {
                if (data) {
                    localStorage.setItem('hotelUsername', data.username || userInput);
                    if (data.role) localStorage.setItem('hotelRole', data.role);
                    if (data.department) localStorage.setItem('hotelDept', data.department);
                } else {
                    localStorage.setItem('hotelUsername', userInput);
                }
                window.location.href = 'admin.html';
            } else {
                await auth.signOut();
                errEl.textContent = 'Yalnızca yöneticiler erişebilir.';
            }
        } catch (err) {
            console.error('Unlock failed', err);
            errEl.textContent = 'Kullanıcı adı veya şifre yanlış.';
        }
    });
});
