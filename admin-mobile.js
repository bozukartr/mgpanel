/* admin-mobile.js — Admin Console Mobile Logic */
document.addEventListener('DOMContentLoaded', () => {

    // ── AUTH GUARD ─────────────────────────────────────────────
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    if (loggedUsername.toLowerCase() !== 'admin') {
        window.location.href = 'panel-mobile.html';
        return;
    }
    auth.onAuthStateChanged(u => { if (!u) window.location.href = 'index.html'; });

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
                if (!password || password.length < 6) {
                    showToast('Password must be at least 6 characters.', true); return;
                }
                const email = username + '@hotel.com';

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

    db.collection('systemUsers').onSnapshot(snap => {
        userList.innerHTML = '';
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
                        ${u.username}
                        <span class="role-badge ${roleLower}">${u.role}</span>
                    </div>
                    <div class="user-card-meta">${u.department}</div>
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

    db.collection('guestLogs').orderBy('createdAt', 'desc').limit(20).onSnapshot(snap => {
        activityList.innerHTML = '';
        snap.forEach(doc => {
            const log = doc.data();
            const item = document.createElement('div');
            item.className = 'activity-item';
            item.innerHTML = `
                <div class="activity-item-top">
                    <span class="activity-staff">${log.staffInitial || '—'}</span>
                    <span class="activity-dept">${log.department || ''}</span>
                </div>
                <div class="activity-desc">
                    Room <strong>${log.room}</strong> — ${log.guestName} 
                    <span style="color: var(--text-muted);">[${log.status || 'Following'}]</span>
                </div>
                <div class="activity-date">${log.date || ''}</div>
            `;
            activityList.appendChild(item);
        });
    });
});
