function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth Guard
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    const toast = document.getElementById('toast');

    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => { toast.className = 'toast-notification'; }, 3000);
    }

    if (loggedUsername.toLowerCase() !== 'admin') {
        showToast('Unauthorized Access. Redirecting...', true);
        setTimeout(() => window.location.href = 'concierge.html', 1500);
        return;
    }

    // Elements
    const usersTableBody = document.querySelector('#usersTable tbody');
    const activityLogsContainer = document.getElementById('activityLogs');
    const userModal = document.getElementById('userModal');
    const openUserModalBtn = document.getElementById('openUserModal');
    const closeUserModalBtn = document.getElementById('closeUserModal');
    const userForm = document.getElementById('userForm');

    let currentEditingUserId = null;

    // 2. Fetch Users
    const fetchUsers = () => {
        db.collection('systemUsers').onSnapshot(snapshot => {
            usersTableBody.innerHTML = '';
            snapshot.forEach(doc => {
                const user = doc.data();
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                tr.innerHTML = `
                    <td><strong>${esc(user.username)}</strong></td>
                    <td><span class="role-badge">${esc(user.role)}</span></td>
                    <td>${esc(user.department)}</td>
                    <td>
                        <button class="reset-pw-btn" onclick="event.stopPropagation(); resetUserPassword('${doc.id}', '${esc(user.username).replace(/'/g, "\\'")}')">Reset Password</button>
                        <button class="delete-user-btn" onclick="event.stopPropagation(); deleteUser('${doc.id}')">Remove Access</button>
                    </td>
                `;
                tr.onclick = () => openEditUser(doc.id, user);
                usersTableBody.appendChild(tr);
            });
        });
    };

    const openEditUser = (id, data) => {
        currentEditingUserId = id;
        document.getElementById('adminNewUsername').value = data.username;
        document.getElementById('adminNewPassword').value = "********";
        document.getElementById('adminNewPassword').disabled = true;
        document.getElementById('adminUserRole').value = data.role;
        document.getElementById('adminUserDept').value = data.department;
        userModal.style.display = 'flex';
    };

    userForm.onsubmit = async (e) => {
        e.preventDefault();
        const username = document.getElementById('adminNewUsername').value.trim();
        const role = document.getElementById('adminUserRole').value;
        const department = document.getElementById('adminUserDept').value;
        const passwordInput = document.getElementById('adminNewPassword');

        try {
            if (currentEditingUserId) {
                // UPDATE MODE
                await db.collection('systemUsers').doc(currentEditingUserId).update({
                    username: username,
                    role: role,
                    department: department,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast('Permissions updated for ' + username);
            } else {
                // CREATE MODE
                const password = passwordInput.value;
                const email = username + "@hotel.com";

                // Ensure Secondary app is fresh
                let secondaryApp;
                const existingApp = firebase.apps.find(app => app.name === 'Secondary');
                if (existingApp) {
                    secondaryApp = existingApp;
                } else {
                    secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
                }

                const userCredential = await secondaryApp.auth().createUserWithEmailAndPassword(email, password);
                const uid = userCredential.user.uid;
                
                await secondaryApp.auth().signOut();

                await db.collection('systemUsers').doc(uid).set({
                    uid: uid,
                    username: username,
                    email: email,
                    role: role,
                    department: department,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast('New Account Created: ' + username);
            }
            userModal.style.display = 'none';
            userForm.reset();
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message, true);
        }
    };

    // 3. Fetch Activity
    const fetchActivity = () => {
        db.collection('guestLogs').orderBy('createdAt', 'desc').limit(15).onSnapshot(snapshot => {
            activityLogsContainer.innerHTML = '';
            snapshot.forEach(doc => {
                const log = doc.data();
                const logItem = document.createElement('div');
                logItem.className = 'log-item';
                logItem.innerHTML = `
                    <p><strong>${esc(log.staffInitial)}</strong> modified record for room <strong>${esc(log.room)}</strong></p>
                    <span>${esc(log.date || 'Today')} - ${esc(log.department)}</span>
                `;
                activityLogsContainer.innerHTML += logItem.outerHTML;
            });
        });
    };

    // Modal Handlers
    openUserModalBtn.onclick = () => {
        userModal.style.display = 'flex';
        currentEditingUserId = null;
        userForm.reset();
        document.getElementById('adminNewPassword').disabled = false;
    };

    closeUserModalBtn.onclick = () => userModal.style.display = 'none';

    window.deleteUser = (id) => {
        if (confirm('Are you sure you want to remove this user?')) {
            db.collection('systemUsers').doc(id).delete();
            showToast('User removed from system.');
        }
    };

    // Force the user to set a new password on their next login.
    window.resetUserPassword = async (id, username) => {
        if (!confirm(`Reset password for ${username}?\n\nThey will keep their current password to log in once, then be required to set a new password before continuing.`)) {
            return;
        }
        try {
            await db.collection('systemUsers').doc(id).update({
                mustChangePassword: true,
                passwordResetAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            showToast(`${username} will be asked to set a new password on next login.`);
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message, true);
        }
    };

    // System Eject (Backup & Wipe)
    const ejectBtn = document.getElementById('adminEjectBtn');
    if (ejectBtn) {
        ejectBtn.onclick = async () => {
            if (!confirm("⚠️ DANGER: This will permanently WIPE all system data (Reservations, Guests, Logs, Staff accounts)!\n\nA backup file will be generated and downloaded before the deletion.\n\nAre you sure you want to proceed?")) {
                return;
            }
            if (!confirm("⚠️ FINAL WARNING: This action cannot be undone. Are you absolutely certain you want to wipe the system?")) {
                return;
            }

            showToast("Generating system backup...", false);

            try {
                // Fetch all operational data
                const [resSnap, dirSnap, logsSnap, usersSnap] = await Promise.all([
                    db.collection('reservations').get(),
                    db.collection('guestDirectory').get(),
                    db.collection('guestLogs').get(),
                    db.collection('systemUsers').get()
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
                a.download = `hotel_system_eject_backup_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`;
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

                showToast("💥 System Ejected Successfully! All data wiped.", false);
                setTimeout(() => {
                    window.location.reload();
                }, 2000);

            } catch (err) {
                console.error(err);
                showToast("Eject Failed: " + err.message, true);
            }
        };
    }

        // Subscription Management
    const subStatus = document.getElementById('subStatus');
    const subExpiry = document.getElementById('subExpiry');

    const loadSubscription = () => {
        db.collection('systemConfig').doc('subscription').onSnapshot(doc => {
            if (doc.exists) {
                const data = doc.data();
                const end = data.subscriptionEnd ? data.subscriptionEnd.toDate() : null;
                const now = new Date();
                if (end && end > now) {
                    const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
                    subStatus.textContent = `Active — ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`;
                    subStatus.className = 'sub-status active';
                    subExpiry.textContent = `Expires: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
                } else {
                    subStatus.textContent = 'Expired';
                    subStatus.className = 'sub-status expired';
                    subExpiry.textContent = end ? `Expired: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}` : 'No subscription set';
                }
                if (end) subDateInput.value = end.toISOString().slice(0, 10);
            } else {
                subStatus.textContent = 'Not Set';
                subStatus.className = 'sub-status expired';
                subExpiry.textContent = 'No subscription document found';
            }
        });
    };

    fetchUsers();
    fetchActivity();
    loadSubscription();
});
