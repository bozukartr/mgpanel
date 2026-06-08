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
    let userCount = 0;
    const maxUsers = () => parseInt(localStorage.getItem('hotelMaxUsers') || '0', 10);

    // 2. Fetch Users
    const fetchUsers = () => {
        db.collection('systemUsers').where('tenantId', '==', TENANT_ID).onSnapshot(snapshot => {
            usersTableBody.innerHTML = '';
            userCount = snapshot.size;
            const lim = maxUsers();
            if (statUsers) statUsers.textContent = lim > 0 ? `${snapshot.size} / ${lim}` : snapshot.size;
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
                const lim = maxUsers();
                if (lim > 0 && userCount >= lim) {
                    showToast(`Kullanıcı limitine ulaşıldı (${lim}). Daha fazlası için paketinizi yükseltin.`, true);
                    return;
                }
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
        db.collection('tickets').where('tenantId', '==', TENANT_ID).orderBy('createdAt', 'desc').onSnapshot(snap => {
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
        db.collection('maintenance').doc(TENANT_ID).onSnapshot(doc => {
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
            await db.collection('maintenance').doc(TENANT_ID).set({
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

    // ── SUBSCRIPTION PAYMENT (PayTR) ───────────────────────────
    const payBtn = document.getElementById('payBtn');
    const payModal = document.getElementById('payModal');
    const paytriframe = document.getElementById('paytriframe');
    const payLoading = document.getElementById('payLoading');
    const closePay = () => {
        if (payModal) payModal.style.display = 'none';
        if (paytriframe) paytriframe.src = '';
    };
    document.getElementById('payClose')?.addEventListener('click', closePay);
    payModal?.addEventListener('click', (e) => { if (e.target === payModal) closePay(); });

    // Show the plan price on the renewal button.
    if (payBtn) {
        const price = (typeof PLAN_PRICES !== 'undefined') ? PLAN_PRICES[localStorage.getItem('hotelPlan')] : 0;
        if (price) payBtn.textContent = 'Aboneliği Yenile · ' + price.toLocaleString('tr-TR') + ' ₺';
    }

    // The result page (inside the iframe) posts back when payment finishes.
    window.addEventListener('message', (e) => {
        if (e.data && e.data.source === 'stayos-payment') {
            closePay();
            showToast(e.data.status === 'ok' ? 'Ödeme alındı, aboneliğiniz güncellendi.' : 'Ödeme tamamlanamadı.', e.data.status !== 'ok');
        }
    });

    if (payBtn) {
        payBtn.addEventListener('click', async () => {
            payModal.style.display = 'flex';
            payLoading.style.display = 'block';
            payLoading.textContent = 'PayTR güvenli ödeme hazırlanıyor…';
            paytriframe.style.display = 'none';
            try {
                const createPayment = firebase.app().functions('us-central1').httpsCallable('createPayment');
                const res = await createPayment({});
                paytriframe.onload = () => {
                    payLoading.style.display = 'none';
                    paytriframe.style.display = 'block';
                    if (window.iFrameResize) { try { iFrameResize({}, '#paytriframe'); } catch (e) {} }
                };
                paytriframe.src = res.data.iframeUrl;
            } catch (err) {
                payLoading.textContent = 'Ödeme başlatılamadı: ' + (err.message || 'bilinmeyen hata');
            }
        });
    }

    // ── PAYMENT HISTORY ─────────────────────────────────────────
    const payHistBody = document.getElementById('payHistBody');
    if (payHistBody) {
        const stMap = { success: ['Başarılı', '#16a34a'], pending: ['Bekliyor', '#d97706'], failed: ['Başarısız', '#dc2626'], error: ['Hata', '#dc2626'] };
        const planName = { starter: 'Başlangıç', pro: 'Profesyonel', enterprise: 'Kurumsal' };
        db.collection('payments').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            const rows = snap.docs.map(d => d.data())
                .sort((a, b) => ((b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0)));
            if (!rows.length) { payHistBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:20px;">Henüz ödeme yok</td></tr>'; return; }
            payHistBody.innerHTML = rows.map(p => {
                const d = p.createdAt && p.createdAt.toDate ? p.createdAt.toDate().toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
                const st = stMap[p.status] || [p.status || '—', '#64748b'];
                const amt = (p.amountTRY || 0).toLocaleString('tr-TR') + ' ₺';
                return `<tr><td>${d}</td><td>${esc(planName[p.plan] || p.plan || '—')}</td><td>${amt}</td><td><span style="color:${st[1]};font-weight:600;">${esc(st[0])}</span></td></tr>`;
            }).join('');
        }, () => {});
    }

    // ── FINANCE MODULE ──────────────────────────────────────────
    (function () {
        const CATS = [
            { key: 'Restaurant', label: 'Restoran' },
            { key: 'Transfer', label: 'Transfer' },
            { key: 'Flower', label: 'Çiçek' },
            { key: 'Cake', label: 'Pasta' },
            { key: 'Boat', label: 'Tekne' },
            { key: 'Tour', label: 'Tur' },
            { key: 'Beach', label: 'Plaj' },
            { key: 'Other', label: 'Diğer' }
        ];
        const labelOf = (k) => (CATS.find(c => c.key === k) || { label: k }).label;
        const money = (n) => '€' + Math.round(n || 0).toLocaleString('tr-TR');
        const num = (v) => parseFloat(v) || 0;

        let finReservations = [];
        let commissions = {};

        const finRange = document.getElementById('finRange');
        const finFrom = document.getElementById('finFrom');
        const finTo = document.getElementById('finTo');
        if (!finRange) return; // finance UI not present

        const iso = (d) => d.toISOString().slice(0, 10);
        function rangeBounds() {
            const v = finRange.value, today = new Date();
            if (v === 'all') return [null, null];
            if (v === 'custom') return [finFrom.value || null, finTo.value || null];
            if (v === 'today') { const t = iso(today); return [t, t]; }
            if (v === 'week') { const d = new Date(today); d.setDate(d.getDate() - 6); return [iso(d), iso(today)]; }
            const f = new Date(today.getFullYear(), today.getMonth(), 1);
            const l = new Date(today.getFullYear(), today.getMonth() + 1, 0);
            return [iso(f), iso(l)];
        }

        function render() {
            const [from, to] = rangeBounds();
            const inRange = finReservations.filter(r => r.date && (!from || r.date >= from) && (!to || r.date <= to));
            const active = inRange.filter(r => (r.status || '') !== 'Cancelled');

            let gross = 0, collected = 0, commission = 0;
            const cat = {};
            active.forEach(r => {
                const p = num(r.totalPrice), d = num(r.deposit), rate = num(commissions[r.type]);
                gross += p; collected += d; commission += p * rate / 100;
                const c = cat[r.type] || (cat[r.type] = { count: 0, gross: 0, collected: 0 });
                c.count++; c.gross += p; c.collected += d;
            });
            const balance = gross - collected, net = gross - commission;
            const collRate = gross > 0 ? (collected / gross * 100) : 0;

            const kpis = [
                { l: 'Brüt Gelir', v: money(gross), s: active.length + ' rezervasyon', cls: '' },
                { l: 'Tahsil Edilen', v: money(collected), s: '%' + collRate.toFixed(0) + ' tahsilat', cls: 'green' },
                { l: 'Açık Bakiye', v: money(balance), s: 'Bekleyen tahsilat', cls: balance > 0 ? 'amber' : '' },
                { l: 'Komisyon', v: money(commission), s: 'Toplam komisyon', cls: 'accent' },
                { l: 'Net Gelir', v: money(net), s: 'Brüt − komisyon', cls: '' },
                { l: 'Ortalama Tutar', v: money(active.length ? gross / active.length : 0), s: 'Rezervasyon başına', cls: '' }
            ];
            document.getElementById('finKpis').innerHTML = kpis.map(k =>
                `<div class="fin-kpi ${k.cls}"><div class="l">${k.l}</div><div class="v">${k.v}</div><div class="s">${k.s}</div></div>`).join('');

            const keys = CATS.map(c => c.key).filter(k => cat[k]);
            document.getElementById('finCatBody').innerHTML = keys.map(k => {
                const c = cat[k], rate = num(commissions[k]), comm = c.gross * rate / 100;
                return `<tr><td>${esc(labelOf(k))}</td><td>${c.count}</td><td>${money(c.gross)}</td><td>${money(c.collected)}</td><td>${money(c.gross - c.collected)}</td><td>%${rate}</td><td>${money(comm)}</td><td>${money(c.gross - comm)}</td></tr>`;
            }).join('') || `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">Bu aralıkta kayıt yok</td></tr>`;
            document.getElementById('finCatFoot').innerHTML = keys.length
                ? `<tr><td>Toplam</td><td>${active.length}</td><td>${money(gross)}</td><td>${money(collected)}</td><td>${money(balance)}</td><td>—</td><td>${money(commission)}</td><td>${money(net)}</td></tr>`
                : '';

            const byStatus = (s) => active.filter(r => r.status === s);
            const conf = byStatus('Confirmed'), pend = byStatus('Pending');
            const cancelled = inRange.filter(r => r.status === 'Cancelled');
            const sg = (arr) => arr.reduce((a, r) => a + num(r.totalPrice), 0);
            document.getElementById('finStatus').innerHTML =
                `<div class="fin-line"><span>✅ Onaylı</span><span><b>${money(sg(conf))}</b> <span class="muted">${conf.length} adet</span></span></div>` +
                `<div class="fin-line"><span>⏳ Bekleyen</span><span><b>${money(sg(pend))}</b> <span class="muted">${pend.length} adet</span></span></div>` +
                `<div class="fin-line"><span>✖ İptal</span><span><span class="muted">${cancelled.length} adet</span></span></div>`;

            const staff = {};
            active.forEach(r => { const s = r.staffInitial || '—'; const o = staff[s] || (staff[s] = { count: 0, gross: 0 }); o.count++; o.gross += num(r.totalPrice); });
            const staffRows = Object.keys(staff).sort((a, b) => staff[b].gross - staff[a].gross);
            document.getElementById('finStaff').innerHTML = staffRows.length
                ? staffRows.map(s => `<div class="fin-line"><span>${esc(s)}</span><span><b>${money(staff[s].gross)}</b> <span class="muted">${staff[s].count} adet</span></span></div>`).join('')
                : `<div class="fin-line"><span class="muted">Kayıt yok</span></div>`;

            const missingPrice = active.filter(r => num(r.totalPrice) <= 0);
            const missingVoucher = active.filter(r => r.status === 'Confirmed' && !(r.voucherNo && String(r.voucherNo).trim()));
            const overpaid = active.filter(r => num(r.deposit) > num(r.totalPrice) && num(r.totalPrice) > 0);
            const uncollected = active.filter(r => r.status === 'Confirmed' && (num(r.totalPrice) - num(r.deposit)) > 0);
            const uncollectedSum = uncollected.reduce((a, r) => a + (num(r.totalPrice) - num(r.deposit)), 0);
            const checks = [
                { label: 'Fiyatı girilmemiş rezervasyon', n: missingPrice.length, sev: missingPrice.length ? 'warn' : 'ok' },
                { label: 'Onaylı ama voucher/onay no eksik', n: missingVoucher.length, sev: missingVoucher.length ? 'warn' : 'ok' },
                { label: 'Fazla ödeme (kapora > fiyat)', n: overpaid.length, sev: overpaid.length ? 'bad' : 'ok' },
                { label: 'Onaylı ama tahsil edilmemiş bakiye · ' + money(uncollectedSum), n: uncollected.length, sev: uncollected.length ? 'bad' : 'ok' }
            ];
            document.getElementById('finChecks').innerHTML = checks.map(c =>
                `<div class="fin-check ${c.sev}"><span>${c.sev === 'ok' ? '✓' : '!'}</span> ${c.label}<span class="cnt">${c.n}</span></div>`).join('');
        }

        function renderCommInputs() {
            document.getElementById('commGrid').innerHTML = CATS.map(c =>
                `<div class="comm-item"><label>${esc(c.label)}</label><div class="inrow"><input type="number" min="0" max="100" step="0.5" data-cat="${c.key}" value="${num(commissions[c.key])}"><span>%</span></div></div>`).join('');
        }

        document.getElementById('commSave').addEventListener('click', async () => {
            const next = {};
            document.querySelectorAll('#commGrid input[data-cat]').forEach(inp => { next[inp.dataset.cat] = num(inp.value); });
            try {
                await db.collection('financeConfig').doc(TENANT_ID).set({ commissions: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
                showToast('Komisyon oranları kaydedildi.');
            } catch (e) { showToast('Hata: ' + e.message, true); }
        });

        finRange.addEventListener('change', () => {
            const custom = finRange.value === 'custom';
            finFrom.style.display = custom ? 'block' : 'none';
            finTo.style.display = custom ? 'block' : 'none';
            render();
        });
        finFrom.addEventListener('change', render);
        finTo.addEventListener('change', render);

        db.collection('reservations').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            finReservations = snap.docs.map(d => d.data());
            render();
        }, () => {});
        db.collection('financeConfig').doc(TENANT_ID).onSnapshot(doc => {
            commissions = (doc.exists && doc.data().commissions) ? doc.data().commissions : {};
            renderCommInputs();
            render();
        }, () => { renderCommInputs(); });
    })();

    fetchUsers();
    loadSubscription();
    fetchTickets();
    loadMaintenance();
});
