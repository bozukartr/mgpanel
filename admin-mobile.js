/* admin-mobile.js — Admin Console Mobile Logic */
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
document.addEventListener('DOMContentLoaded', () => {

    // ── AUTH GUARD ─────────────────────────────────────────────
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    const loggedRole = (localStorage.getItem('hotelRole') || '').toLowerCase();
    const isAdminUser = loggedRole === 'admin' || loggedUsername.toLowerCase() === 'admin';
    // Verify admin access against Firestore (source of truth), not just localStorage.
    auth.onAuthStateChanged(async (u) => {
        if (!u) { window.location.href = 'login.html'; return; }
        try {
            const doc = await db.collection('systemUsers').doc(u.uid).get();
            const role = doc.exists ? (doc.data().role || '').toLowerCase() : '';
            const uname = doc.exists ? (doc.data().username || '').toLowerCase() : '';
            if (role !== 'admin' && uname !== 'admin' && !isAdminUser) {
                window.location.href = 'concierge.html';
            }
        } catch (e) {
            console.error('Auth check failed', e);
            window.location.href = 'concierge.html';
        }
    });

    // ── TOAST ──────────────────────────────────────────────────
    const toast = document.getElementById('adm-toast');
    let toastTimer;
    const showToast = (msg, isError = false) => {
        clearTimeout(toastTimer);
        toast.textContent = msg;
        toast.className = 'app-toast show' + (isError ? ' error' : '');
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
    };

    // ── SEGMENT TABS ───────────────────────────────────────────
    document.querySelectorAll('.seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.adm-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab)?.classList.add('active');
        });
    });

    // ── SHEET HELPERS ──────────────────────────────────────────
    const openSheet  = (s, b) => { s.classList.add('open');  b.classList.add('open'); };
    const closeSheet = (s, b) => { s.classList.remove('open'); b.classList.remove('open'); };

    // ── USER SHEET ─────────────────────────────────────────────
    const userSheet    = document.getElementById('userSheet');
    const userBackdrop = document.getElementById('userSheetBackdrop');
    let currentEditingId = null;

    const openAddUser = () => {
        currentEditingId = null;
        document.getElementById('sheetTitle').textContent = 'New User';
        document.getElementById('su-username').value = '';
        document.getElementById('su-password').value = '';
        document.getElementById('su-role').value = 'Staff';
        document.getElementById('su-dept').value = 'Housekeeping';
        document.getElementById('su-passwordGroup').style.display = 'flex';
        document.getElementById('su-password').disabled = false;
        document.getElementById('su-submit').textContent = 'Create User';
        openSheet(userSheet, userBackdrop);
    };

    const openEditUser = (id, data) => {
        currentEditingId = id;
        document.getElementById('sheetTitle').textContent = 'Edit User';
        document.getElementById('su-username').value = data.username;
        document.getElementById('su-password').value = '••••••••';
        document.getElementById('su-password').disabled = true;
        document.getElementById('su-role').value = data.role;
        document.getElementById('su-dept').value = data.department;
        document.getElementById('su-submit').textContent = 'Save Changes';
        openSheet(userSheet, userBackdrop);
    };

    document.getElementById('openAddUser').addEventListener('click', openAddUser);
    document.getElementById('closeUserSheet').addEventListener('click', () => closeSheet(userSheet, userBackdrop));
    userBackdrop.addEventListener('click', () => closeSheet(userSheet, userBackdrop));

    // ── SAVE USER ──────────────────────────────────────────────
    document.getElementById('su-submit').addEventListener('click', async () => {
        const username = document.getElementById('su-username').value.trim();
        const role     = document.getElementById('su-role').value;
        const dept     = document.getElementById('su-dept').value;
        const password = document.getElementById('su-password').value;

        if (!username) { showToast('Username is required.', true); return; }

        try {
            if (currentEditingId) {
                // UPDATE
                await db.collection('systemUsers').doc(currentEditingId).update({
                    username, role, department: dept,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast('Updated: ' + username);
            } else {
                // CREATE
                const lim = parseInt(localStorage.getItem('hotelMaxUsers') || '0', 10);
                if (lim > 0 && userCount >= lim) {
                    showToast(`Kullanıcı limitine ulaşıldı (${lim}). Paketinizi yükseltin.`, true); return;
                }
                if (!password || password.length < 6) {
                    showToast('Password must be at least 6 characters.', true); return;
                }
                const email = userEmail(username, TENANT_ID);

                // Secondary app — don't disturb main session
                let secondaryApp;
                const existing = firebase.apps.find(a => a.name === 'Secondary');
                secondaryApp = existing || firebase.initializeApp(firebaseConfig, 'Secondary');

                const cred = await secondaryApp.auth().createUserWithEmailAndPassword(email, password);
                const uid  = cred.user.uid;
                await secondaryApp.auth().signOut();

                await db.collection('systemUsers').doc(uid).set({
                    uid, username, email, role,
                    department: dept,
                    tenantId: TENANT_ID,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast('User created: ' + username);
            }
            closeSheet(userSheet, userBackdrop);
        } catch (e) {
            showToast('Error: ' + e.message, true);
        }
    });

    // ── RENDER USERS ───────────────────────────────────────────
    const userList  = document.getElementById('userList');
    const userEmpty = document.getElementById('userEmpty');
    let userCount = 0;

    db.collection('systemUsers').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
        userList.innerHTML = '';
        userCount = snap.size;
        if (snap.empty) {
            userEmpty.style.display = 'flex';
            return;
        }
        userEmpty.style.display = 'none';
        snap.forEach(doc => {
            const u = doc.data();
            const roleLower = (u.role || 'staff').toLowerCase();
            const card = document.createElement('div');
            card.className = 'user-card';
            card.innerHTML = `
                <div class="user-card-info">
                    <div class="user-card-name">
                        ${esc(u.username)}
                        <span class="role-badge ${roleLower}">${esc(u.role)}</span>
                    </div>
                    <div class="user-card-meta">${esc(u.department)}</div>
                </div>
                <button class="user-card-delete" data-id="${doc.id}" title="Remove access">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                </button>
            `;
            // Edit on card tap
            card.addEventListener('click', e => {
                if (e.target.closest('.user-card-delete')) return;
                openEditUser(doc.id, u);
            });
            // Delete via confirm sheet
            card.querySelector('.user-card-delete').addEventListener('click', e => {
                e.stopPropagation();
                pendingDeleteId = doc.id;
                openSheet(delSheet, delBackdrop);
            });
            userList.appendChild(card);
        });
    });

    // ── DELETE CONFIRM ─────────────────────────────────────────
    const delSheet    = document.getElementById('delSheet');
    const delBackdrop = document.getElementById('delBackdrop');
    let pendingDeleteId = null;

    document.getElementById('delConfirmNo').addEventListener('click',  () => closeSheet(delSheet, delBackdrop));
    delBackdrop.addEventListener('click', () => closeSheet(delSheet, delBackdrop));

    document.getElementById('delConfirmYes').addEventListener('click', async () => {
        if (!pendingDeleteId) return;
        try {
            await db.collection('systemUsers').doc(pendingDeleteId).delete();
            showToast('User removed.');
            closeSheet(delSheet, delBackdrop);
            pendingDeleteId = null;
        } catch (e) { showToast('Error: ' + e.message, true); }
    });

    // ── ACTIVITY FEED ──────────────────────────────────────────
    const activityList = document.getElementById('activityList');

    db.collection('guestLogs').where('tenantId', '==', TENANT_ID).orderBy('createdAt', 'desc').limit(20).onSnapshot(snap => {
        activityList.innerHTML = '';
        snap.forEach(doc => {
            const log = doc.data();
            const item = document.createElement('div');
            item.className = 'activity-item';
            item.innerHTML = `
                <div class="activity-item-top">
                    <span class="activity-staff">${esc(log.staffInitial || '—')}</span>
                    <span class="activity-dept">${esc(log.department || '')}</span>
                </div>
                <div class="activity-desc">
                    Room <strong>${esc(log.room)}</strong> — ${esc(log.guestName)}
                    <span style="color: var(--text-muted);">[${esc(log.status || 'Following')}]</span>
                </div>
                <div class="activity-date">${esc(log.date || '')}</div>
            `;
            activityList.appendChild(item);
        });
    });

    // ── SYSTEM EJECT (BACKUP & WIPE) ──────────────────────────
    const ejectMobileBtn = document.getElementById('adminEjectMobileBtn');
    if (ejectMobileBtn) {
        ejectMobileBtn.addEventListener('click', async () => {
            if (!confirm("⚠️ DANGER: This will permanently WIPE all system data (Reservations, Guests, Logs, Staff accounts)!\n\nA backup file will be generated and downloaded before the deletion.\n\nAre you sure you want to proceed?")) {
                return;
            }
            if (!confirm("⚠️ FINAL WARNING: This action cannot be undone. Are you absolutely certain?")) {
                return;
            }

            showToast("Generating system backup...", false);

            try {
                // Fetch all operational data
                const [resSnap, dirSnap, logsSnap, usersSnap] = await Promise.all([
                    db.collection('reservations').where('tenantId', '==', TENANT_ID).get(),
                    db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get(),
                    db.collection('guestLogs').where('tenantId', '==', TENANT_ID).get(),
                    db.collection('systemUsers').where('tenantId', '==', TENANT_ID).get()
                ]);

                const backupObj = {
                    timestamp: new Date().toISOString(),
                    backupVersion: "1.0",
                    reservations: resSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                    guestDirectory: dirSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                    guestLogs: logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                    systemUsers: usersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
                };

                // Trigger file download
                const blob = new Blob([JSON.stringify(backupObj, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `hotel_system_eject_backup_mobile_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                showToast("Backup downloaded! Initiating database wipe...", false);

                const batch = db.batch();

                // 1. Delete all reservations
                resSnap.forEach(doc => batch.delete(doc.ref));

                // 2. Delete all guests in directory
                dirSnap.forEach(doc => batch.delete(doc.ref));

                // 3. Delete all guest logs
                logsSnap.forEach(doc => batch.delete(doc.ref));

                // 4. Delete all system users EXCEPT the main admin account
                usersSnap.forEach(doc => {
                    const u = doc.data();
                    if (u.username && u.username.toLowerCase() === 'admin') {
                        return; // Safeguard admin account
                    }
                    batch.delete(doc.ref);
                });

                await batch.commit();

                showToast("System Ejected Successfully! All data wiped.", false);
                setTimeout(() => {
                    window.location.reload();
                }, 2000);

            } catch (err) {
                console.error(err);
                showToast("Eject Failed: " + err.message, true);
            }
        });
    }

    // ── SUBSCRIPTION + PAYMENT (PayTR) ──────────────────────────
    (function () {
        const subStatus = document.getElementById('m-subStatus');
        const subExpiry = document.getElementById('m-subExpiry');
        function renderSub(end) {
            const now = new Date();
            if (end && end > now) {
                const days = Math.ceil((end - now) / 86400000);
                subStatus.textContent = 'Aktif · ' + days + ' gün kaldı';
                subStatus.style.color = '#16a34a';
                subExpiry.textContent = 'Bitiş: ' + end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
            } else if (end) {
                subStatus.textContent = 'Süresi Doldu';
                subStatus.style.color = '#dc2626';
                subExpiry.textContent = 'Bitiş: ' + end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
            } else {
                subStatus.textContent = 'Tanımsız';
                subStatus.style.color = '#64748b';
                subExpiry.textContent = '';
            }
        }
        db.collection('tenants').doc(TENANT_ID).onSnapshot(async function (doc) {
            let end = (doc.exists && doc.data().subscriptionEnd) ? doc.data().subscriptionEnd.toDate() : null;
            if (!end) {
                try { const lg = await db.collection('systemConfig').doc('subscription').get(); if (lg.exists && lg.data().subscriptionEnd) end = lg.data().subscriptionEnd.toDate(); } catch (e) {}
            }
            renderSub(end);
        }, function () {});

        const payModal = document.getElementById('m-payModal');
        const iframe = document.getElementById('m-paytriframe');
        const loading = document.getElementById('m-payLoading');
        const closePay = function () { payModal.style.display = 'none'; iframe.src = ''; };
        document.getElementById('m-payClose')?.addEventListener('click', closePay);
        payModal?.addEventListener('click', function (e) { if (e.target === payModal) closePay(); });

        const mPayBtn = document.getElementById('m-payBtn');
        const mPrice = (typeof PLAN_PRICES !== 'undefined') ? PLAN_PRICES[localStorage.getItem('hotelPlan')] : 0;
        if (mPayBtn && mPrice) mPayBtn.textContent = 'Aboneliği Yenile · ' + mPrice.toLocaleString('tr-TR') + ' ₺';

        window.addEventListener('message', function (e) {
            if (e.data && e.data.source === 'stayos-payment') {
                closePay();
                showToast(e.data.status === 'ok' ? 'Ödeme alındı, aboneliğiniz güncellendi.' : 'Ödeme tamamlanamadı.', e.data.status !== 'ok');
            }
        });

        document.getElementById('m-payBtn')?.addEventListener('click', async function () {
            payModal.style.display = 'flex';
            loading.style.display = 'block';
            loading.textContent = 'PayTR güvenli ödeme hazırlanıyor…';
            iframe.style.display = 'none';
            try {
                const createPayment = firebase.app().functions('us-central1').httpsCallable('createPayment');
                const res = await createPayment({});
                iframe.onload = function () {
                    loading.style.display = 'none';
                    iframe.style.display = 'block';
                    if (window.iFrameResize) { try { iFrameResize({}, '#m-paytriframe'); } catch (e) {} }
                };
                iframe.src = res.data.iframeUrl;
            } catch (err) {
                loading.textContent = 'Ödeme başlatılamadı: ' + (err.message || 'hata');
            }
        });
    })();
});
