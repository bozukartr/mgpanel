function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth Guard
    const toast = document.getElementById('toast');

    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => { toast.className = 'toast-notification'; }, 3000);
    }

    // Kullanıcı departman seçenekleri issueConfig'ten gelir → bir kez yükle ve canlı tut.
    if (window.IssueConfig) {
        IssueConfig.load().catch(() => {});
        if (IssueConfig.listen) IssueConfig.listen(() => {});
    }

    // Verify admin access against Firestore (source of truth) ONLY — a
    // localStorage-derived flag was previously ORed into this check, letting
    // anyone who edited localStorage.hotelRole in devtools bypass the
    // redirect regardless of their real Firestore role; bkz. güvenlik
    // denetimi.
    auth.onAuthStateChanged(async (u) => {
        if (!u) { window.location.href = 'login'; return; }
        try {
            const doc = await db.collection('systemUsers').doc(u.uid).get();
            const role = doc.exists ? (doc.data().role || '').toLowerCase() : '';
            const uname = doc.exists ? (doc.data().username || '').toLowerCase() : '';
            if (role !== 'admin' && uname !== 'admin') {
                showToast('Unauthorized Access. Redirecting...', true);
                setTimeout(() => window.location.href = 'app', 1500);
            }
        } catch (e) {
            console.error('Auth check failed', e);
            window.location.href = 'app';
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
    let currentEditingUserRole = null; // role değişip değişmediğini tespit etmek için (bkz. revokeUserSessions çağrısı)
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
                        <button class="reset-pw-btn">Reset Password</button>
                        <button class="delete-user-btn">Remove Access</button>
                    </td>
                `;
                // Tıklama işleyicileri gerçek JS closure'ları ile bağlanır, bir
                // onclick="..." HTML attribute string'ine gömülmez — kullanıcı adı
                // hiçbir zaman HTML olarak serileştirilip tekrar JS olarak
                // ayrıştırılmıyor. esc() yalnızca HTML metin/attribute bağlamı için
                // güvenlidir; inline event-handler string'lerine değer gömmek
                // (tarayıcı attribute'u decode edip JS olarak derlediğinden) esc()
                // ile bile atlatılabilir bir XSS'e yol açar — bkz. güvenlik denetimi.
                tr.querySelector('.reset-pw-btn').onclick = (e) => { e.stopPropagation(); resetUserPassword(doc.id, user.username); };
                tr.querySelector('.delete-user-btn').onclick = (e) => { e.stopPropagation(); deleteUser(doc.id); };
                tr.onclick = () => openEditUser(doc.id, user);
                usersTableBody.appendChild(tr);
            });
        });
    };

    // ── Per-user module access ─────────────────────────────────
    const MOD_KEYS = ['concierge', 'guestIssues', 'reports', 'crm', 'guestOrders', 'restaurant'];
    function setUserModuleSel(modules) {
        MOD_KEYS.forEach(k => {
            const cb = document.querySelector('#userModules input[data-mod="' + k + '"]');
            if (cb) cb.checked = !modules || modules[k] !== false; // absent → full access
        });
    }
    function getUserModuleSel() {
        const m = {};
        MOD_KEYS.forEach(k => {
            const cb = document.querySelector('#userModules input[data-mod="' + k + '"]');
            m[k] = cb ? cb.checked : true;
        });
        return m;
    }

    const openEditUser = (id, data) => {
        currentEditingUserId = id;
        currentEditingUserRole = (data.role || '').toLowerCase();
        document.getElementById('adminNewUsername').value = data.username;
        document.getElementById('adminNewPassword').value = "********";
        document.getElementById('adminNewPassword').disabled = true;
        document.getElementById('adminUserRole').value = data.role;
        deptOptions(data.department);
        setUserModuleSel(data.modules);
        applyDeptPwUI();
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
                const roleChanged = (role || '').toLowerCase() !== currentEditingUserRole;
                await db.collection('systemUsers').doc(currentEditingUserId).update({
                    username: username,
                    role: role,
                    department: department,
                    modules: getUserModuleSel(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                // Rol fiilen değiştiyse aktif oturum token'larını iptal et —
                // aksi halde eski (daha yetkili) rol, mevcut ID token'ın süresi
                // dolana kadar (~1 saate kadar) geçerli kalabilirdi; bkz. auth
                // denetimi. Best-effort: başarısız olursa Firestore güncellemesi
                // zaten uygulandığı için sessizce yutulur.
                if (roleChanged) {
                    try {
                        const revoke = firebase.app().functions('us-central1').httpsCallable('revokeUserSessions');
                        await revoke({ uid: currentEditingUserId });
                    } catch (e) { console.error('revokeUserSessions failed', e); }
                }
                showToast('Permissions updated for ' + username);
            } else {
                // CREATE MODE
                const lim = maxUsers();
                if (lim > 0 && userCount >= lim) {
                    showToast(`Kullanıcı limitine ulaşıldı (${lim}). Daha fazlası için paketinizi yükseltin.`, true);
                    return;
                }
                const isFnb = isFnbDept(department);
                const fnbCode = (passwordInput.value || '').trim();
                let password = passwordInput.value;
                if (isFnb) {
                    if (!/^\d{5}$/.test(fnbCode)) { showToast('F&B kullanıcısı için 5 haneli (yalnızca rakam) kod girin.', true); return; }
                    password = fnbPassword(fnbCode);   // Firebase ≥6 char gerektirir → türetilmiş şifre
                }
                // F&B kullanıcısı kullanıcı adı GİRMEDEN yalnızca koduyla girer →
                // e-posta da koddan türetilir (kod tenant içinde benzersiz olur).
                const email = isFnb ? fnbEmail(fnbCode, TENANT_ID) : userEmail(username, TENANT_ID);

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

                const newUser = {
                    uid: uid,
                    username: username,
                    email: email,
                    role: role,
                    department: department,
                    modules: getUserModuleSel(),
                    tenantId: TENANT_ID,
                    mustChangePassword: !isFnb,   // F&B sabit kodla girer, değişim istenmez
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                if (isFnb) newUser.fnbCode = fnbCode;
                await db.collection('systemUsers').doc(uid).set(newUser);
                showToast('New Account Created: ' + username);
            }
            userModal.style.display = 'none';
            userForm.reset();
        } catch (err) {
            console.error(err);
            if (err && err.code === 'auth/email-already-in-use') showToast('Bu kullanıcı adı / F&B kodu zaten kullanımda.', true);
            else showToast('Error: ' + err.message, true);
        }
    };

    // Modal Handlers
    // Kullanıcı departmanı seçenekleri = issueConfig departmanları (talepler bu
    // departmanlara yönlendirildiği için aynı liste) + F&B her zaman seçilebilir.
    function deptOptions(currentValue) {
        const sel = document.getElementById('adminUserDept');
        if (!sel) return;
        const names = [];
        try {
            (window.IssueConfig ? IssueConfig.departments() : []).forEach(d => {
                if (d && d.name && names.indexOf(d.name) === -1) names.push(d.name);
            });
        } catch (e) { /* ignore */ }
        // FNB_DEPT artık IssueConfig'in kanonik "Yiyecek & İçecek" departmanıyla
        // AYNI string — normalde zaten listede olduğu için burası yalnızca otel
        // bu departmanı kendi ayarlarından silmişse F&B girişini geri ekler
        // (tekrar bir "Food & Beverage" kopyası oluşturmaz).
        if (names.indexOf(FNB_DEPT) === -1) names.push(FNB_DEPT);
        if (currentValue && names.indexOf(currentValue) === -1) names.unshift(currentValue); // mevcut değeri koru
        sel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
        sel.value = currentValue || (names[0] || '');
    }

    // Departman = F&B seçilince şifre alanı 5 haneli (yalnızca rakam) kod olur.
    function applyDeptPwUI() {
        const dept = document.getElementById('adminUserDept').value;
        const pw = document.getElementById('adminNewPassword');
        const label = document.getElementById('adminPwLabel');
        const hint = document.getElementById('adminPwHint');
        if (isFnbDept(dept)) {
            pw.setAttribute('inputmode', 'numeric'); pw.setAttribute('maxlength', '5'); pw.setAttribute('pattern', '\\d{5}');
            pw.placeholder = '5 haneli kod';
            if (label) label.textContent = '5 Haneli Kod (F&B)';
            if (hint) hint.style.display = '';
        } else {
            pw.removeAttribute('inputmode'); pw.removeAttribute('maxlength'); pw.removeAttribute('pattern');
            pw.placeholder = '';
            if (label) label.textContent = 'Şifre';
            if (hint) hint.style.display = 'none';
        }
    }
    document.getElementById('adminUserDept').addEventListener('change', applyDeptPwUI);

    openUserModalBtn.onclick = () => {
        userModal.style.display = 'flex';
        currentEditingUserId = null;
        userForm.reset();
        setUserModuleSel(null); // new users default to full access (all checked)
        document.getElementById('adminNewPassword').disabled = false;
        deptOptions('');
        applyDeptPwUI();
    };

    closeUserModalBtn.onclick = () => userModal.style.display = 'none';

    window.deleteUser = (id) => {
        if (confirm('Are you sure you want to remove this user?')) {
            db.collection('systemUsers').doc(id).delete();
            showToast('User removed from system.');
        }
    };

    // Şifreyi GERÇEKTEN geçersiz kılar (yeni rastgele bir geçici şifre +
    // oturum iptali) — önceden yalnızca bir bayrak yazılıyordu ve eski şifre
    // kullanıcı elle değiştirene kadar geçerli kalıyordu; bkz. auth denetimi.
    window.resetUserPassword = async (id, username) => {
        if (!confirm(`Reset password for ${username}?\n\nA new temporary password will be generated and their current password/sessions will stop working immediately. They will be required to set a new password on next login.`)) {
            return;
        }
        try {
            const call = firebase.app().functions('us-central1').httpsCallable('resetUserPassword');
            const res = await call({ uid: id });
            const tempPw = res.data && res.data.tempPassword;
            if (tempPw) {
                prompt(`${username} için geçici şifre (bu kişiye iletin — bir daha gösterilmeyecek):`, tempPw);
            }
            showToast(`${username} will be asked to set a new password on next login.`);
        } catch (err) {
            console.error(err);
            showToast('Error: ' + (err.message || 'hata'), true);
        }
    };

    // System Eject (Backup & Wipe)
    const ejectBtn = document.getElementById('adminEjectBtn');
    if (ejectBtn) {
        ejectBtn.onclick = async () => {
            if (!confirm("⚠️ DİKKAT: Tüm sistem verileri (rezervasyonlar, misafirler, kayıtlar, personel hesapları) KALICI olarak silinecek!\n\nSilmeden önce bir yedek dosyası indirilecek.\n\nDevam etmek istediğinize emin misiniz?")) {
                return;
            }
            if (!confirm("⚠️ SON UYARI: Bu işlem geri alınamaz. Sistemi sıfırlamak istediğinize kesinlikle emin misiniz?")) {
                return;
            }

            showToast("Sistem yedeği oluşturuluyor...", false);

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

                showToast("Yedek indirildi! Veriler siliniyor...", false);

                // Silinecek tüm referansları tek bir listede topla.
                const allDeletes = [];
                resSnap.forEach(doc => allDeletes.push(doc.ref));
                dirSnap.forEach(doc => allDeletes.push(doc.ref));
                logsSnap.forEach(doc => allDeletes.push(doc.ref));
                usersSnap.forEach(doc => {
                    const u = doc.data();
                    if (u.username && u.username.toLowerCase() === 'admin') {
                        return; // Safeguard admin account
                    }
                    allDeletes.push(doc.ref);
                });

                // Firestore batch limiti 500 işlemdir — birkaç yıl çalışmış bir
                // otelde bu dört koleksiyonun toplamı kolayca aşabilir; tek batch
                // bu durumda TÜMÜYLE reddedilirdi (kullanıcı "siliniyor" mesajını
                // görmüş olmasına rağmen hiçbir şey silinmezdi). 450'lik parçalara
                // bölüp sırayla commit ederek her büyüklükteki otelde çalışmasını
                // sağlıyoruz.
                const CHUNK = 450;
                for (let i = 0; i < allDeletes.length; i += CHUNK) {
                    const b = db.batch();
                    allDeletes.slice(i, i + CHUNK).forEach(ref => b.delete(ref));
                    await b.commit();
                }

                showToast("💥 Sistem sıfırlandı! Tüm veriler silindi.", false);
                setTimeout(() => {
                    window.location.reload();
                }, 2000);

            } catch (err) {
                console.error(err);
                showToast("Sıfırlama başarısız: " + err.message, true);
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
            subStatus.textContent = `Aktif — ${daysLeft} gün kaldı`;
            subStatus.className = 'sub-status active';
            subExpiry.textContent = `Bitiş: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
        } else if (end) {
            subStatus.textContent = 'Süresi Doldu';
            subStatus.className = 'sub-status expired';
            subExpiry.textContent = `Bitti: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
        } else {
            subStatus.textContent = 'Not Set';
            subStatus.className = 'sub-status expired';
            subExpiry.textContent = 'Abonelik tanımsız';
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
                        ${t.type ? `<span class="ticket-priority" style="background:#eef2ff;color:#4f46e5;">${esc(t.type)}</span>` : ''}
                        <span class="ticket-priority ${prioClass}">${esc(t.priority || 'Medium')}</span>
                        ${esc(t.createdBy || 'Unknown')} • ${when}${replyCount ? ` • ${replyCount} yanıt` : ''}
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
        const type = (document.getElementById('ticketType') || {}).value || 'Sorun';
        const message = document.getElementById('ticketMessage').value.trim();
        if (!subject || !message) return;
        try {
            await db.collection('tickets').add({
                subject, message, priority, type,
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
                mtStatus.textContent = active ? 'Aktif' : 'Pasif';
                mtStatus.classList.toggle('active', active);
                mtStatus.title = active && ends ? `${ends.toLocaleString('tr-TR')} tarihine kadar aktif` : '';
                if (statMaintenance) statMaintenance.textContent = active ? 'Açık' : 'Kapalı';
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

    // ── VARDİYA KONUMU (shiftConfig) ────────────────────────────
    // Etkinleştirilirse panel.js/realtime.js bu konum+yarıçapı kullanarak
    // personelin "işbaşında" olup olmadığını (onShift) belirler — bkz.
    // realtime.js startPresence() ve panel.js canTakeRecord/notifyRequestTeam.
    // Ham personel koordinatları HİÇBİR ZAMAN Firestore'a yazılmaz (gizlilik) —
    // yalnızca bu MERKEZ konum + yarıçap saklanır, mesafe hesabı her
    // istemcide kendi cihazının konumuyla yerel olarak yapılır.
    const shEnabled = document.getElementById('shEnabled');
    const shLat = document.getElementById('shLat');
    const shLng = document.getElementById('shLng');
    const shRadius = document.getElementById('shRadius');
    const shStatus = document.getElementById('shStatus');
    const shHint = document.getElementById('shHint');

    const loadShiftConfig = () => {
        if (!shEnabled) return;
        db.collection('shiftConfig').doc(TENANT_ID).onSnapshot(doc => {
            const d = doc.exists ? doc.data() : {};
            shEnabled.checked = !!d.enabled;
            shLat.value = (d.lat != null) ? d.lat : '';
            shLng.value = (d.lng != null) ? d.lng : '';
            shRadius.value = d.radiusM || 150;
            shStatus.textContent = d.enabled ? 'Aktif' : 'Pasif';
            shStatus.classList.toggle('active', !!d.enabled);
        });
    };

    document.getElementById('shUseHere') && (document.getElementById('shUseHere').onclick = () => {
        if (!navigator.geolocation) { showToast('Bu tarayıcı konum bilgisini desteklemiyor.', true); return; }
        shHint.style.display = ''; shHint.textContent = 'Konum alınıyor…';
        navigator.geolocation.getCurrentPosition(
            pos => {
                shLat.value = pos.coords.latitude.toFixed(6);
                shLng.value = pos.coords.longitude.toFixed(6);
                shHint.textContent = 'Şu anki konumunuz dolduruldu (± ' + Math.round(pos.coords.accuracy) + ' m doğruluk). "Kaydet"e basmayı unutmayın.';
            },
            err => { shHint.textContent = 'Konum alınamadı: ' + (err && err.message || 'izin verilmedi'); },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    });

    document.getElementById('shSave') && (document.getElementById('shSave').onclick = async () => {
        const enabled = shEnabled.checked;
        const lat = parseFloat(shLat.value), lng = parseFloat(shLng.value);
        const radiusM = Math.max(30, parseInt(shRadius.value, 10) || 150);
        if (enabled && (!isFinite(lat) || !isFinite(lng))) { showToast('Vardiya kontrolünü açmak için otel konumunu girin (veya "Şu anki konumumu kullan"a basın).', true); return; }
        try {
            await db.collection('shiftConfig').doc(TENANT_ID).set({
                tenantId: TENANT_ID, enabled,
                lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null, radiusM,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            showToast('Vardiya konumu ayarları kaydedildi.');
        } catch (err) { console.error(err); showToast('Hata: ' + err.message, true); }
    });

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
        if (e.data && e.data.source === 'hotizy-payment') {
            closePay();
            showToast(e.data.status === 'ok' ? 'Ödeme alındı, aboneliğiniz güncellendi.' : 'Ödeme tamamlanamadı.', e.data.status !== 'ok');
        }
    });

    if (payBtn) {
        payBtn.addEventListener('click', async () => {
            // Senkron disable — çift tıklamanın iki ayrı payments dokümanı/
            // PayTR token'ı oluşturmasını engeller (bkz. idempotency denetimi;
            // payLemonBtn'de zaten bu koruma vardı, buraya da eklendi).
            if (payBtn.disabled) return;
            payBtn.disabled = true;
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
            } finally {
                payBtn.disabled = false;
            }
        });
    }

    // ── SUBSCRIPTION PAYMENT (Lemon Squeezy) ───────────────────
    // Lemon Squeezy harici barındırılan bir ödeme sayfası kullanır; iframe yerine
    // yönlendiririz. Ödeme sonrası webhook aboneliği uzatır, kullanıcı dönüş
    // sayfasına gelir.
    const payLemonBtn = document.getElementById('payLemonBtn');
    if (payLemonBtn) {
        let lemonReady = false;
        const ensureLemon = () => {
            if (lemonReady) return !!(window.LemonSqueezy && window.LemonSqueezy.Url);
            if (typeof window.createLemonSqueezy === 'function') {
                try {
                    window.createLemonSqueezy();
                    if (window.LemonSqueezy && window.LemonSqueezy.Setup) {
                        window.LemonSqueezy.Setup({ eventHandler: (e) => {
                            const name = e && (e.event || e.type || e.name);
                            if (name === 'Checkout.Success') {
                                showToast('Ödeme alındı, aboneliğiniz güncelleniyor…');
                                setTimeout(() => location.reload(), 2500);
                            }
                        } });
                    }
                    lemonReady = true;
                } catch (err) { /* yok say */ }
            }
            return !!(window.LemonSqueezy && window.LemonSqueezy.Url);
        };
        // Overlay'i tıklamadan ÖNCE init et (yoksa lemon.js yeni sekmeye düşer).
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureLemon);
        else ensureLemon();
        window.addEventListener('load', ensureLemon);
        const openCheckout = (url) => {
            const u = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'embed=1';
            if (ensureLemon() && window.LemonSqueezy.Url.Open) { window.LemonSqueezy.Url.Open(u); }
            else { window.location.href = url; } // fallback
        };
        payLemonBtn.addEventListener('click', async () => {
            const orig = payLemonBtn.textContent;
            payLemonBtn.disabled = true;
            payLemonBtn.textContent = 'Hazırlanıyor…';
            const reset = () => { payLemonBtn.disabled = false; payLemonBtn.textContent = orig; };
            try {
                const fn = firebase.app().functions('us-central1').httpsCallable('createLemonCheckout');
                const res = await fn({});
                if (res && res.data && res.data.url) { openCheckout(res.data.url); reset(); return; }
                throw new Error('URL alınamadı');
            } catch (err) {
                reset();
                showToast('Ödeme başlatılamadı: ' + (err.message || 'bilinmeyen hata'), true);
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
    loadShiftConfig();
});
