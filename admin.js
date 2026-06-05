function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth Guard
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    const loggedRole = (localStorage.getItem('hotelRole') || '').toLowerCase();
    const isAdminUser = loggedRole === 'admin' || loggedUsername.toLowerCase() === 'admin';
    const toast = document.getElementById('toast');

    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => { toast.className = 'toast-notification'; }, 3000);
    }

    // Verify admin access against Firestore (source of truth), not just localStorage.
    auth.onAuthStateChanged(async (u) => {
        if (!u) { window.location.href = 'login.html'; return; }
        try {
            const doc = await db.collection('systemUsers').doc(u.uid).get();
            const role = doc.exists ? (doc.data().role || '').toLowerCase() : '';
            const uname = doc.exists ? (doc.data().username || '').toLowerCase() : '';
            if (role !== 'admin' && uname !== 'admin' && !isAdminUser) {
                showToast('Unauthorized Access. Redirecting...', true);
                setTimeout(() => window.location.href = 'concierge.html', 1500);
            }
        } catch (e) {
            console.error('Auth check failed', e);
            window.location.href = 'concierge.html';
        }
    });

    // Elements
    const usersTableBody = document.querySelector('#usersTable tbody');
    const statUsers = document.getElementById('statUsers');
    const statTickets = document.getElementById('statTickets');
    const statMaintenance = document.getElementById('statMaintenance');
    const userModal = document.getElementById('userModal');
    const openUserModalBtn = document.getElementById('openUserModal');
    const closeUserModalBtn = document.getElementById('closeUserModal');
    const userForm = document.getElementById('userForm');

    let currentEditingUserId = null;

    // 2. Fetch Users
    const fetchUsers = () => {
        db.collection('systemUsers').onSnapshot(snapshot => {
            usersTableBody.innerHTML = '';
            if (statUsers) statUsers.textContent = snapshot.size;
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
                const email = userEmail(username, TENANT_ID);

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
                    tenantId: TENANT_ID,
                    mustChangePassword: true,
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
    const subDateInput = document.getElementById('subDateInput');

    const renderSubscription = (end) => {
        const now = new Date();
        if (end && end > now) {
            const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
            subStatus.textContent = `Active — ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`;
            subStatus.className = 'sub-status active';
            subExpiry.textContent = `Expires: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
        } else if (end) {
            subStatus.textContent = 'Expired';
            subStatus.className = 'sub-status expired';
            subExpiry.textContent = `Expired: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
        } else {
            subStatus.textContent = 'Not Set';
            subStatus.className = 'sub-status expired';
            subExpiry.textContent = 'No subscription set';
        }
        if (end && subDateInput) subDateInput.value = end.toISOString().slice(0, 10);
    };

    const loadSubscription = () => {
        // Read this hotel's subscription from its tenant document (realtime),
        // falling back to the legacy systemConfig doc during the transition.
        db.collection('tenants').doc(TENANT_ID).onSnapshot(async doc => {
            let end = (doc.exists && doc.data().subscriptionEnd) ? doc.data().subscriptionEnd.toDate() : null;
            if (!end) {
                try {
                    const legacy = await db.collection('systemConfig').doc('subscription').get();
                    if (legacy.exists && legacy.data().subscriptionEnd) end = legacy.data().subscriptionEnd.toDate();
                } catch (e) { /* ignore */ }
            }
            renderSubscription(end);
        }, () => {});
    };

    // ── SUPPORT TICKETS ────────────────────────────────────────
    const ticketList = document.getElementById('ticketList');
    const ticketModal = document.getElementById('ticketModal');
    const ticketDetailModal = document.getElementById('ticketDetailModal');
    let currentTicketId = null;

    const fetchTickets = () => {
        db.collection('tickets').orderBy('createdAt', 'desc').onSnapshot(snap => {
            ticketList.innerHTML = '';
            let openCount = 0;
            snap.forEach(doc => {
                if ((doc.data().status || 'Open') !== 'Closed') openCount++;
            });
            if (statTickets) statTickets.textContent = openCount;
            if (snap.empty) {
                ticketList.innerHTML = '<p style="color:#94a3b8; font-size:13px; padding:10px;">No tickets yet.</p>';
                return;
            }
            snap.forEach(doc => {
                const t = doc.data();
                const item = document.createElement('div');
                item.className = 'ticket-item';
                const statusClass = (t.status || 'Open').toLowerCase().replace(/\s+/g, '-');
                const prioClass = (t.priority || 'Medium').toLowerCase();
                const when = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleString('tr-TR') : '';
                const replyCount = Array.isArray(t.replies) ? t.replies.length : 0;
                item.innerHTML = `
                    <div class="ticket-item-top">
                        <span class="ticket-subject">${esc(t.subject)}</span>
                        <span class="ticket-status ${statusClass}">${esc(t.status || 'Open')}</span>
                    </div>
                    <div class="ticket-meta">
                        <span class="ticket-priority ${prioClass}">${esc(t.priority || 'Medium')}</span>
                        ${esc(t.createdBy || 'Unknown')} • ${when}${replyCount ? ` • ${replyCount} reply${replyCount > 1 ? 's' : ''}` : ''}
                    </div>
                `;
                item.onclick = () => openTicketDetail(doc.id, t);
                ticketList.appendChild(item);
            });
        });
    };

    function openTicketDetail(id, t) {
        currentTicketId = id;
        document.getElementById('tdSubject').textContent = t.subject || 'Ticket';
        const when = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleString('tr-TR') : '';
        document.getElementById('tdMeta').textContent = `${t.priority || 'Medium'} • Opened by ${t.createdBy || 'Unknown'} • ${when}`;
        document.getElementById('tdStatus').value = t.status || 'Open';
        document.getElementById('tdReply').value = '';

        let html = `<div class="td-msg"><div class="who">${esc(t.createdBy || 'Unknown')}</div><div class="text">${esc(t.message || '')}</div></div>`;
        (t.replies || []).forEach(r => {
            const rwhen = r.at ? new Date(r.at).toLocaleString('tr-TR') : '';
            html += `<div class="td-msg"><div class="who">${esc(r.by || '')} <span class="when">${rwhen}</span></div><div class="text">${esc(r.text || '')}</div></div>`;
        });
        document.getElementById('tdThread').innerHTML = html;
        ticketDetailModal.style.display = 'flex';
    }

    document.getElementById('openTicketModal').onclick = () => {
        document.getElementById('ticketForm').reset();
        ticketModal.style.display = 'flex';
    };
    document.getElementById('closeTicketModal').onclick = () => ticketModal.style.display = 'none';
    document.getElementById('closeTicketDetail').onclick = () => ticketDetailModal.style.display = 'none';

    document.getElementById('ticketForm').onsubmit = async (e) => {
        e.preventDefault();
        const subject = document.getElementById('ticketSubject').value.trim();
        const priority = document.getElementById('ticketPriority').value;
        const message = document.getElementById('ticketMessage').value.trim();
        if (!subject || !message) return;
        try {
            await db.collection('tickets').add({
                subject, message, priority,
                status: 'Open',
                tenantId: TENANT_ID,
                createdBy: loggedUsername,
                createdByUid: auth.currentUser ? auth.currentUser.uid : '',
                replies: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            ticketModal.style.display = 'none';
            showToast('Ticket created.');
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message, true);
        }
    };

    document.getElementById('tdSendReply').onclick = async () => {
        const text = document.getElementById('tdReply').value.trim();
        if (!text || !currentTicketId) return;
        try {
            await db.collection('tickets').doc(currentTicketId).update({
                replies: firebase.firestore.FieldValue.arrayUnion({
                    by: loggedUsername,
                    byUid: auth.currentUser ? auth.currentUser.uid : '',
                    text,
                    at: new Date().toISOString()
                }),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            showToast('Reply sent.');
            const fresh = await db.collection('tickets').doc(currentTicketId).get();
            if (fresh.exists) openTicketDetail(currentTicketId, fresh.data());
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message, true);
        }
    };

    document.getElementById('tdUpdateStatus').onclick = async () => {
        if (!currentTicketId) return;
        const status = document.getElementById('tdStatus').value;
        try {
            await db.collection('tickets').doc(currentTicketId).update({
                status,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            showToast('Status updated.');
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message, true);
        }
    };

    // ── MAINTENANCE MODE ───────────────────────────────────────
    const mtEnabled = document.getElementById('mtEnabled');
    const mtEndsAt = document.getElementById('mtEndsAt');
    const mtMessage = document.getElementById('mtMessage');
    const mtStatus = document.getElementById('mtStatus');

    // Convert a Date to the value format a datetime-local input expects (local time).
    const toLocalInput = (date) => {
        const tz = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - tz).toISOString().slice(0, 16);
    };

    const loadMaintenance = () => {
        db.collection('systemConfig').doc('maintenance').onSnapshot(doc => {
            if (doc.exists) {
                const d = doc.data();
                mtEnabled.checked = !!d.enabled;
                if (d.endsAt && d.endsAt.toDate) mtEndsAt.value = toLocalInput(d.endsAt.toDate());
                mtMessage.value = d.message || '';
                const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
                const active = d.enabled && ends && ends > new Date();
                mtStatus.textContent = active ? 'Active' : 'Inactive';
                mtStatus.classList.toggle('active', active);
                mtStatus.title = active && ends ? `Active until ${ends.toLocaleString('tr-TR')}` : '';
                if (statMaintenance) statMaintenance.textContent = active ? 'On' : 'Off';
            } else {
                mtStatus.textContent = 'Inactive';
                mtStatus.classList.remove('active');
                if (statMaintenance) statMaintenance.textContent = 'Off';
            }
        });
    };

    document.getElementById('mtSave').onclick = async () => {
        const enabled = mtEnabled.checked;
        const endsVal = mtEndsAt.value;
        if (enabled && !endsVal) return showToast('Please set an end time.', true);
        try {
            await db.collection('systemConfig').doc('maintenance').set({
                enabled,
                endsAt: endsVal ? firebase.firestore.Timestamp.fromDate(new Date(endsVal)) : null,
                message: mtMessage.value.trim(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            showToast('Maintenance settings saved.');
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message, true);
        }
    };

    fetchUsers();
    loadSubscription();
    fetchTickets();
    loadMaintenance();
});
