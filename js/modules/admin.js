function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth Guard
    // showToast: js/utils/toast.js (paylaşımlı — bkz. tasarım denetimi, 4 ayrı
    // kopya tek yerde toplandı). AppDialog: js/utils/app-dialog.js (native
    // confirm()/prompt() yerine, .modal üzerine kurulu, Promise tabanlı).

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
                showToast('Bu sayfaya erişim yetkiniz yok. Yönlendiriliyorsunuz…', true);
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

    // Superadmin (superadmin.js createDrawerUser) ile AYNI kullanıcı adı kuralı.
    const USERNAME_RE = /^[a-z0-9._-]{2,}$/;
    // Giriş ekranı (app.js lowerUsername) ile AYNI küçültme: 'İ'→'i', sonra
    // locale'siz toLowerCase ('I'→'i'; tr-TR'nin I→ı eşlemesi girişi bozardı).
    function normalizeUsername(s) { return String(s || '').trim().replace(/İ/g, 'i').toLowerCase(); }

    let currentEditingUserId = null;
    let currentEditingUserRole = null; // role değişip değişmediğini tespit etmek için (bkz. revokeUserSessions çağrısı)
    let userCount = 0;
    const maxUsers = () => parseInt(localStorage.getItem('hotelMaxUsers') || '0', 10);

    // Rol verisi İngilizce saklanır (Admin/Manager/Staff); arayüzde Türkçe.
    const ROLE_TR = { admin: 'Admin', manager: 'Yönetici', staff: 'Personel' };
    const roleLabel = (r) => ROLE_TR[String(r || '').toLowerCase()] || (r || '—');

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
                tr.dataset.uid = doc.id;
                tr.innerHTML = `
                    <td><strong>${esc(user.username)}</strong></td>
                    <td><span class="role-badge">${esc(roleLabel(user.role))}</span>${user.faceIdAllowed === true ? '<span class="tag tag-fid" title="Kişiye özel hesap — Face ID / Touch ID ile girebilir">Face ID</span>' : ''}</td>
                    <td>${esc(user.department)}</td>
                    <td>
                        <button class="reset-pw-btn">Şifre Sıfırla</button>
                        <button class="delete-user-btn">Erişimi Kaldır</button>
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
            syncLockTags();
        });
        // Ekran kilidi olan (ortak cihaz) hesaplara "Ekran kilidi" etiketi.
        db.collection('screenLocks').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            lockMap = {};
            snap.forEach(d => { const c = d.data() || {}; if (c.idleMin > 0) lockMap[d.id] = c; });
            syncLockTags();
        }, () => {});
    };
    let lockMap = {};
    function syncLockTags() {
        usersTableBody.querySelectorAll('tr[data-uid]').forEach(tr => {
            const cfg = lockMap[tr.dataset.uid];
            let tag = tr.querySelector('.tag-lock');
            if (cfg && !tag) {
                tag = document.createElement('span');
                tag.className = 'tag tag-lock';
                tr.children[1].appendChild(tag);
            }
            if (tag && !cfg) tag.remove();
            else if (tag) { tag.textContent = 'Kilit ' + cfg.idleMin + ' dk'; tag.title = 'Ortak cihaz: ' + cfg.idleMin + ' dk işlem olmazsa ekran kilitlenir'; }
        });
    }

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

    // Rol seçicisini kayıttaki role BÜYÜK/KÜÇÜK HARF DUYARSIZ eşler.
    // Superadmin kullanıcıları küçük harfli rolle ('admin', 'staff') açar,
    // bu seçicinin değerleri ise 'Admin'/'Staff'/'Manager'. `select.value =
    // 'admin'` eşleşmeyince seçici BOŞ kalıyor, kaydet `role: ''` yazıyordu —
    // otel admini kendi satırını açıp bir modül işaretleyip kaydettiğinde
    // admin yetkisini kaybedip panelden atılıyordu. Bilinmeyen bir rol
    // kaybolmasın diye seçiciye ayrıca eklenir.
    function setRoleSelect(role) {
        const sel = document.getElementById('adminUserRole');
        const want = String(role || '').trim();
        const key = want.toLowerCase();
        sel.querySelectorAll('option[data-extra]').forEach(o => o.remove());
        if (!want) { sel.value = 'Staff'; return; }
        const hit = Array.prototype.find.call(sel.options, o => o.value.toLowerCase() === key);
        if (hit) { sel.value = hit.value; return; }
        const o = document.createElement('option');
        o.value = want; o.textContent = want; o.dataset.extra = '1';
        sel.appendChild(o);
        sel.value = want;
    }

    // Kullanıcı adı giriş kimliğidir (e-posta ondan türetilir — bkz.
    // userEmail/app.js). Yalnızca Firestore'daki adı değiştirmek Auth
    // e-postasını değiştirmiyor, kişi yeni adıyla GİREMİYORDU. Bu yüzden
    // düzenlemede salt-okunur.
    function setUsernameLocked(locked) {
        const u = document.getElementById('adminNewUsername');
        u.readOnly = !!locked;
        const hint = document.getElementById('adminUserHint');
        if (hint) hint.style.display = locked ? '' : 'none';
    }

    // ── Face ID / Touch ID ile giriş (kişiye özel hesap) ─────────
    // Yönetici kullanıcı bazında açar; ortak kullanılan hesaplarda (resepsiyon
    // tableti vb.) kapalı kalır. Kapatılınca o kullanıcının cihaz kayıtları da
    // silinir (sunucu ayrıca faceIdAllowed=false iken girişi reddeder).
    // F&B personeli kodla girer → seçenek gizli.
    const faceIdCb = document.getElementById('adminUserFaceId');
    const faceIdGroup = document.getElementById('adminFaceIdGroup');
    const faceIdDev = document.getElementById('adminUserFaceIdDevices');
    const faceIdRevokeBtn = document.getElementById('adminUserFaceIdRevoke');
    const passkeyManage = (data) => firebase.app().functions('us-central1').httpsCallable('passkeyManage')(data);
    let faceIdWas = false;
    function setFaceIdSel(on) {
        if (faceIdCb) faceIdCb.checked = !!on;
        faceIdWas = !!on;
        if (faceIdDev) faceIdDev.hidden = true;
    }
    async function loadFaceIdDevices(uid) {
        if (!faceIdDev || !uid) return;
        try {
            const r = await passkeyManage({ action: 'list', uid });
            if (currentEditingUserId !== uid) return; // modal başka kullanıcıya geçti
            const list = (r.data && r.data.devices) || [];
            if (!list.length) return;
            const names = [...new Set(list.map(d => d.deviceLabel || 'Cihaz'))].join(', ');
            document.getElementById('adminUserFaceIdList').textContent = list.length + ' cihazda açık · ' + names;
            faceIdDev.hidden = false;
        } catch (e) { /* sunucu henüz yayınlanmadıysa sessiz geç */ }
    }
    if (faceIdRevokeBtn) faceIdRevokeBtn.onclick = async () => {
        const uid = currentEditingUserId;
        if (!uid) return;
        const ok = await AppDialog.confirm({
            title: 'Face ID cihazlarını kaldır', danger: true, confirmText: 'Kaldır',
            message: 'Bu kullanıcının Face ID / Touch ID açtığı tüm cihazlar kaldırılacak. Kişi bir sonraki girişte şifresini kullanır; izin açık kaldıkça yeniden açabilir.'
        });
        if (!ok) return;
        faceIdRevokeBtn.disabled = true;
        try {
            await passkeyManage({ action: 'revokeAll', uid });
            faceIdDev.hidden = true;
            showToast('Face ID cihazları kaldırıldı.');
        } catch (e) { showToast('Kaldırılamadı: ' + ((e && e.message) || 'bilinmeyen hata'), true); }
        faceIdRevokeBtn.disabled = false;
    };

    // ── Ortak cihaz ekran kilidi ─────────────────────────────────
    // screenLocks/{uid}: { tenantId, idleMin, pinHash, salt, pinLength }.
    // PIN tuzlu SHA-256 özeti olarak saklanır; kurallar gereği yalnızca o
    // hesap ve otel yöneticisi okur (shell-lock.js kilidi bununla açar).
    const lockIdle = document.getElementById('adminLockIdle');
    const lockPin = document.getElementById('adminLockPin');
    let lockExisting = null;
    function hex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
    async function pinHashOf(salt, pin) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin))); }
    function syncLockUI() {
        if (!lockIdle || !lockPin) return;
        const on = Number(lockIdle.value) > 0;
        lockPin.disabled = !on;
        lockPin.placeholder = !on ? 'PIN' : (lockExisting && lockExisting.pinHash ? 'Değiştirmek için yeni PIN' : 'PIN (4–6 rakam)');
    }
    lockIdle?.addEventListener('change', syncLockUI);
    lockPin?.addEventListener('input', () => { lockPin.value = lockPin.value.replace(/\D/g, '').slice(0, 6); });
    async function loadLock(uid) {
        lockExisting = null;
        if (lockIdle) lockIdle.value = '0';
        if (lockPin) lockPin.value = '';
        syncLockUI();
        if (!uid) return;
        try {
            const s = await db.collection('screenLocks').doc(uid).get();
            if (currentEditingUserId !== uid) return;
            if (s.exists) { lockExisting = s.data(); if (lockIdle) lockIdle.value = String(lockExisting.idleMin || 0); }
        } catch (e) { /* kural / ağ: ayar gösterilmez */ }
        syncLockUI();
    }
    // Kaydetmeden ÖNCE doğrula (kullanıcı kaydı yarım kalmasın).
    function lockValidationError() {
        if (!lockIdle) return null;
        const idle = Number(lockIdle.value) || 0;
        const pin = (lockPin.value || '').trim();
        if (!idle) return null;
        if (pin && !/^\d{4,6}$/.test(pin)) return 'Kilit PIN\'i 4–6 rakam olmalı.';
        if (!pin && !(lockExisting && lockExisting.pinHash)) return 'Ekran kilidi için bir PIN belirleyin (4–6 rakam).';
        return null;
    }
    async function saveLock(uid) {
        if (!lockIdle || !uid) return;
        const idle = Number(lockIdle.value) || 0;
        const pin = (lockPin.value || '').trim();
        const ref = db.collection('screenLocks').doc(uid);
        if (!idle) { if (lockExisting) await ref.delete(); return; }
        const data = { tenantId: TENANT_ID, idleMin: idle, updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedBy: localStorage.getItem('hotelUsername') || '' };
        if (pin) {
            const a = new Uint8Array(16); crypto.getRandomValues(a);
            data.salt = hex(a);
            data.pinHash = await pinHashOf(data.salt, pin);
            data.pinLength = pin.length;
        }
        await ref.set(data, { merge: true });
    }

    const openEditUser = (id, data) => {
        currentEditingUserId = id;
        currentEditingUserRole = (data.role || '').toLowerCase();
        document.getElementById('adminNewUsername').value = data.username || '';
        setUsernameLocked(true);
        document.getElementById('adminNewPassword').value = "********";
        document.getElementById('adminNewPassword').disabled = true;
        setRoleSelect(data.role);
        deptOptions(data.department);
        setUserModuleSel(data.modules);
        setFaceIdSel(data.faceIdAllowed === true);
        applyDeptPwUI();
        userModal.style.display = 'flex';
        loadFaceIdDevices(id);
        loadLock(id);
    };

    userForm.onsubmit = async (e) => {
        e.preventDefault();
        const usernameRaw = document.getElementById('adminNewUsername').value.trim();
        const role = document.getElementById('adminUserRole').value;
        const department = document.getElementById('adminUserDept').value;
        const passwordInput = document.getElementById('adminNewPassword');
        const faceIdOn = !isFnbDept(department) && !!(faceIdCb && faceIdCb.checked);
        const lockErr = lockValidationError();
        if (lockErr) { showToast(lockErr, true); return; }

        try {
            if (currentEditingUserId) {
                // UPDATE MODE — kullanıcı adı YAZILMAZ (giriş kimliği; bkz.
                // setUsernameLocked). Rol boş gelirse (beklenmedik bir seçici
                // durumu) mevcut rol korunur — asla `role: ''` yazılmaz.
                const newRole = role || currentEditingUserRole;
                const roleChanged = (newRole || '').toLowerCase() !== currentEditingUserRole;
                const me = auth.currentUser && auth.currentUser.uid;
                if (roleChanged && currentEditingUserId === me && currentEditingUserRole === 'admin') {
                    showToast('Kendi admin rolünüzü değiştiremezsiniz — panele erişiminizi kaybedersiniz.', true);
                    return;
                }
                const upd = {
                    department: department,
                    modules: getUserModuleSel(),
                    faceIdAllowed: faceIdOn,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                // Yalnızca harf büyüklüğü farkı rol değişikliği sayılmaz;
                // kayıttaki yazım korunur.
                if (roleChanged) upd.role = newRole;
                await db.collection('systemUsers').doc(currentEditingUserId).update(upd);
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
                // Face ID kapatıldı → cihaz kayıtlarını da sil (best-effort; sunucu
                // zaten faceIdAllowed=false iken Face ID girişini reddeder).
                if (faceIdWas && !faceIdOn) {
                    try { await passkeyManage({ action: 'revokeAll', uid: currentEditingUserId }); }
                    catch (e) { console.error('passkey revokeAll failed', e); }
                }
                try { await saveLock(currentEditingUserId); }
                catch (e) { console.error('screen lock save failed', e); showToast('Ekran kilidi kaydedilemedi: ' + ((e && e.message) || ''), true); }
                showToast(usernameRaw + ' için yetkiler güncellendi.');
            } else {
                // CREATE MODE
                const lim = maxUsers();
                if (lim > 0 && userCount >= lim) {
                    showToast(`Kullanıcı limitine ulaşıldı (${lim}). Daha fazlası için paketinizi yükseltin.`, true);
                    return;
                }
                const isFnb = isFnbDept(department);
                // Kullanıcı adından giriş e-postası türetilir → giriş ekranının
                // yaptığı gibi küçük harfe (İ→i) indirilir ve superadmin ile
                // AYNI kuralla doğrulanır. Önceden "Ayşe" / "ali veli" gibi
                // adlar ya İngilizce "badly formatted" hatası veriyor ya da
                // giriş ekranındaki İ→i dönüşümü yüzünden hesaba girilemiyordu.
                // F&B personeli koduyla girer — adı yalnızca görünen addır.
                const username = isFnb ? usernameRaw.slice(0, 40) : normalizeUsername(usernameRaw);
                if (!isFnb && !USERNAME_RE.test(username)) {
                    showToast('Kullanıcı adı yalnızca küçük harf (a-z), rakam ve . _ - içerebilir (en az 2 karakter, Türkçe karakter ve boşluk olmadan).', true);
                    return;
                }
                if (isFnb && !username) { showToast('Kullanıcı adı gerekli.', true); return; }
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
                    faceIdAllowed: faceIdOn,
                    tenantId: TENANT_ID,
                    mustChangePassword: !isFnb,   // F&B sabit kodla girer, değişim istenmez
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                if (isFnb) newUser.fnbCode = fnbCode;
                await db.collection('systemUsers').doc(uid).set(newUser);
                try { await saveLock(uid); }
                catch (e) { console.error('screen lock save failed', e); showToast('Ekran kilidi kaydedilemedi: ' + ((e && e.message) || ''), true); }
                showToast('Yeni hesap oluşturuldu: ' + username);
            }
            userModal.style.display = 'none';
            userForm.reset();
        } catch (err) {
            console.error(err);
            if (err && err.code === 'auth/email-already-in-use') showToast('Bu kullanıcı adı / F&B kodu zaten kullanımda.', true);
            else if (err && err.code === 'auth/invalid-email') showToast('Kullanıcı adı geçersiz (küçük harf, rakam ve . _ - kullanın).', true);
            else if (err && err.code === 'auth/weak-password') showToast('Şifre en az 6 karakter olmalı.', true);
            else showToast('Hata: ' + (err && err.message || 'bilinmeyen hata'), true);
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
            if (faceIdGroup) faceIdGroup.style.display = 'none';
        } else {
            pw.removeAttribute('inputmode'); pw.removeAttribute('maxlength'); pw.removeAttribute('pattern');
            pw.placeholder = '';
            if (label) label.textContent = 'Şifre';
            if (hint) hint.style.display = 'none';
            if (faceIdGroup) faceIdGroup.style.display = '';
        }
    }
    document.getElementById('adminUserDept').addEventListener('change', applyDeptPwUI);

    openUserModalBtn.onclick = () => {
        userModal.style.display = 'flex';
        currentEditingUserId = null;
        currentEditingUserRole = null;
        userForm.reset();
        setUsernameLocked(false);
        setRoleSelect('Staff');
        setUserModuleSel(null); // new users default to full access (all checked)
        setFaceIdSel(false);    // varsayılan: ortak kullanım (yalnızca şifre)
        loadLock(null);         // varsayılan: ekran kilidi kapalı
        document.getElementById('adminNewPassword').disabled = false;
        deptOptions('');
        applyDeptPwUI();
    };

    closeUserModalBtn.onclick = () => userModal.style.display = 'none';

    // Erişimi kaldır = Auth hesabı + systemUsers + push kayıtları (sunucuda,
    // deleteUser callable). Önceden yalnızca systemUsers dokümanı siliniyor
    // (üstelik beklenmeden "kaldırıldı" deniyordu) — Auth hesabı yetim
    // kalıyor, aynı kullanıcı adı / F&B kodu bir daha verilemiyordu.
    // Callable henüz yayınlanmamış/eski sürümse (yetki hatası) eski davranışa
    // düşülür ve bu açıkça söylenir.
    window.deleteUser = async (id) => {
        const me = auth.currentUser && auth.currentUser.uid;
        if (id === me) { showToast('Kendi hesabınızı kaldıramazsınız.', true); return; }
        const ok = await AppDialog.confirm({
            title: 'Kullanıcıyı kaldır', danger: true, confirmText: 'Kaldır',
            message: 'Bu kullanıcının erişimi ve giriş hesabı kaldırılacak. Emin misiniz?'
        });
        if (!ok) return;
        try {
            const call = firebase.app().functions('us-central1').httpsCallable('deleteUser');
            await call({ uid: id });
            showToast('Kullanıcı kaldırıldı.');
            return;
        } catch (err) {
            console.warn('deleteUser callable failed, falling back', err);
            if (err && err.code === 'failed-precondition') { showToast(err.message, true); return; }
        }
        try {
            await db.collection('systemUsers').doc(id).delete();
            showToast('Erişim kaldırıldı; giriş hesabı sunucuda silinemedi — aynı kullanıcı adı yeniden verilemeyebilir.', true);
        } catch (err) {
            console.error(err);
            showToast('Kullanıcı kaldırılamadı: ' + (err && err.message || 'hata'), true);
        }
    };

    // Şifreyi GERÇEKTEN geçersiz kılar (yeni rastgele bir geçici şifre +
    // oturum iptali) — önceden yalnızca bir bayrak yazılıyordu ve eski şifre
    // kullanıcı elle değiştirene kadar geçerli kalıyordu; bkz. auth denetimi.
    window.resetUserPassword = async (id, username) => {
        const ok = await AppDialog.confirm({
            title: 'Şifreyi sıfırla', confirmText: 'Sıfırla',
            message: `${username} için yeni bir geçici şifre üretilecek; mevcut şifre/oturumlar hemen geçersiz olacak. Bir sonraki girişte yeni şifre belirlemesi istenecek. Devam edilsin mi?`
        });
        if (!ok) return;
        try {
            const call = firebase.app().functions('us-central1').httpsCallable('resetUserPassword');
            const res = await call({ uid: id });
            const tempPw = res.data && res.data.tempPassword;
            if (tempPw) {
                await AppDialog.info({
                    title: 'Geçici şifre', copyValue: tempPw,
                    message: `${username} için geçici şifre — bu kişiye iletin, bir daha gösterilmeyecek:`
                });
            }
            showToast(`${username} bir sonraki girişte yeni şifre belirleyecek.`);
        } catch (err) {
            console.error(err);
            showToast('Hata: ' + (err.message || 'hata'), true);
        }
    };

    // System Eject (Backup & Wipe)
    // Native confirm() eskiden SENKRON/BLOKLAYICIYDI — açıkken sayfadaki
    // hiçbir buton (bu buton dahil) tıklanamazdı, o yüzden ek bir kilit
    // gerekmiyordu. AppDialog ASENKRON olduğundan bu güvenlik özelliği
    // kendiliğinden gelmiyor: buton ve sidebar navigasyonu burada AÇIKÇA
    // kilitlenir (bkz. tasarım denetimi — re-entrancy riski).
    const ejectBtn = document.getElementById('adminEjectBtn');
    if (ejectBtn) {
        const setNavLocked = (locked) => {
            document.querySelectorAll('.sb-link').forEach(b => { b.disabled = locked; b.style.opacity = locked ? '.45' : ''; b.style.pointerEvents = locked ? 'none' : ''; });
        };
        ejectBtn.onclick = async () => {
            if (ejectBtn.disabled) return; // çift tıklama koruması
            ejectBtn.disabled = true;
            try {
                const ok1 = await AppDialog.confirm({
                    title: 'Dikkat', danger: true, confirmText: 'Devam Et',
                    message: 'Tüm sistem verileri (rezervasyonlar, misafirler, kayıtlar, personel hesapları) KALICI olarak silinecek!\n\nSilmeden önce bir yedek dosyası indirilecek.\n\nDevam etmek istediğinize emin misiniz?'
                });
                if (!ok1) { ejectBtn.disabled = false; return; }
                const ok2 = await AppDialog.confirm({
                    title: 'Son uyarı', danger: true, confirmText: 'Sistemi Sıfırla',
                    message: 'Bu işlem geri alınamaz. Sistemi sıfırlamak istediğinize kesinlikle emin misiniz?'
                });
                if (!ok2) { ejectBtn.disabled = false; return; }
            } catch (e) { ejectBtn.disabled = false; return; }

            // Noktai dönüşsüz: yedekleme + silme başlıyor — sayfadan ayrılmayı/
            // başka bir işlemi tetiklemeyi (sidebar dahil) reload'a kadar engelle.
            setNavLocked(true);
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

                showToast("Sistem sıfırlandı. Tüm veriler silindi.", false);
                setTimeout(() => {
                    window.location.reload();
                }, 2000);

            } catch (err) {
                console.error(err);
                showToast("Sıfırlama başarısız: " + err.message, true);
                // Yarım kalan bir hata (ör. ağ sorunu) kullanıcıyı kalıcı kilitli
                // bırakmasın — yeniden denemesi/sayfadan çıkması mümkün olsun.
                ejectBtn.disabled = false;
                setNavLocked(false);
            }
        };
    }

        // Subscription Management
    const subStatus = document.getElementById('subStatus');
    const subExpiry = document.getElementById('subExpiry');

    // Genel Bakış'taki özet kart (ovSub*) Abonelik görünümündeki ayrıntıyı yansıtır.
    const ovSubStatus = document.getElementById('ovSubStatus');
    const ovSubExpiry = document.getElementById('ovSubExpiry');
    const mirrorSubscription = (ok) => {
        if (ovSubStatus) {
            ovSubStatus.textContent = subStatus.textContent;
            ovSubStatus.classList.toggle('is-ok', !!ok);
            ovSubStatus.classList.toggle('is-bad', !ok);
        }
        if (ovSubExpiry) ovSubExpiry.textContent = subExpiry.textContent;
    };
    const renderSubscription = (end) => {
        const now = new Date();
        if (end && end > now) {
            const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
            subStatus.textContent = `Aktif — ${daysLeft} gün kaldı`;
            subStatus.className = 'sub-status active';
            subExpiry.textContent = `Bitiş: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
            mirrorSubscription(true);
        } else if (end) {
            subStatus.textContent = 'Süresi doldu';
            subStatus.className = 'sub-status expired';
            subExpiry.textContent = `Bitti: ${end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
            mirrorSubscription(false);
        } else {
            subStatus.textContent = 'Tanımsız';
            subStatus.className = 'sub-status expired';
            subExpiry.textContent = 'Abonelik tanımsız';
            mirrorSubscription(false);
        }
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

    // Durum/öncelik VERİDE İngilizce saklanır (superadmin paneli de aynı
    // değerleri okur) — yalnızca görüntü Türkçeleştirilir.
    const TK_STATUS = { 'Open': 'Açık', 'In Progress': 'İşlemde', 'Closed': 'Kapalı' };
    const TK_PRIO = { 'Low': 'Düşük', 'Medium': 'Orta', 'High': 'Yüksek' };
    const TK_STATUS_LC = { 'open': 'Açık', 'in progress': 'İşlemde', 'in-progress': 'İşlemde', 'closed': 'Kapalı' };
    const tkStatus = (s) => TK_STATUS[s || 'Open'] || TK_STATUS_LC[String(s).toLowerCase()] || s;
    const tkPrio = (p) => TK_PRIO[p || 'Medium'] || p;

    const fetchTickets = () => {
        db.collection('tickets').where('tenantId', '==', TENANT_ID).orderBy('createdAt', 'desc').onSnapshot(snap => {
            ticketList.innerHTML = '';
            let openCount = 0;
            snap.forEach(doc => {
                if ((doc.data().status || 'Open') !== 'Closed') openCount++;
            });
            if (statTickets) statTickets.textContent = openCount;
            const tb = document.getElementById('ticketsBadge');
            if (tb) { tb.textContent = openCount; tb.hidden = openCount === 0; }
            if (snap.empty) {
                ticketList.innerHTML = '<div class="list-empty">Henüz destek talebi yok. Bir sorun, istek veya öneriniz olduğunda "Yeni talep" ile bize iletebilirsiniz.</div>';
                return;
            }
            snap.forEach(doc => {
                const t = doc.data();
                const item = document.createElement('div');
                item.className = 'ticket-item';
                const statusClass = (t.status || 'Open').toLowerCase().replace(/\s+/g, '-');
                const prioClass = (t.priority || 'Medium').toLowerCase();
                const when = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
                const replyCount = Array.isArray(t.replies) ? t.replies.length : 0;
                item.innerHTML = `
                    <div class="ticket-item-top">
                        <span class="ticket-subject">${esc(t.subject)}</span>
                        <span class="ticket-status ${statusClass}">${esc(tkStatus(t.status))}</span>
                    </div>
                    <div class="ticket-meta">
                        ${t.type ? `<span class="tag">${esc(t.type)}</span>` : ''}
                        <span class="ticket-priority ${prioClass}">${esc(tkPrio(t.priority))}</span>
                        <span>${esc(t.createdBy || 'Bilinmiyor')} · ${esc(when)}${replyCount ? ` · ${replyCount} yanıt` : ''}</span>
                    </div>
                `;
                item.onclick = () => openTicketDetail(doc.id, t);
                ticketList.appendChild(item);
            });
        });
    };

    function openTicketDetail(id, t) {
        currentTicketId = id;
        document.getElementById('tdSubject').textContent = t.subject || 'Destek talebi';
        const when = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        document.getElementById('tdMeta').textContent = `${tkPrio(t.priority)} öncelik · Açan: ${t.createdBy || 'Bilinmiyor'}${when ? ' · ' + when : ''}`;
        // Eski/elle girilmiş kayıtlarda durum küçük harfli olabiliyor ('open') —
        // seçici eşleşmeyince boş görünüyordu.
        const ST_NORM = { 'open': 'Open', 'in progress': 'In Progress', 'in-progress': 'In Progress', 'closed': 'Closed' };
        document.getElementById('tdStatus').value = ST_NORM[String(t.status || 'Open').toLowerCase()] || 'Open';
        document.getElementById('tdReply').value = '';

        let html = `<div class="td-msg"><div class="who">${esc(t.createdBy || 'Bilinmiyor')}</div><div class="text">${esc(t.message || '')}</div></div>`;
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
            showToast('Destek talebi oluşturuldu.');
        } catch (err) {
            console.error(err);
            showToast('Hata: ' + err.message, true);
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
            showToast('Yanıt gönderildi.');
            const fresh = await db.collection('tickets').doc(currentTicketId).get();
            if (fresh.exists) openTicketDetail(currentTicketId, fresh.data());
        } catch (err) {
            console.error(err);
            showToast('Hata: ' + err.message, true);
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
            showToast('Durum güncellendi.');
        } catch (err) {
            console.error(err);
            showToast('Hata: ' + err.message, true);
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
                // Bitiş kaldırıldıysa alan da temizlenir (önceden eski değer kalıyordu).
                mtEndsAt.value = (d.endsAt && d.endsAt.toDate) ? toLocalInput(d.endsAt.toDate()) : '';
                mtMessage.value = d.message || '';
                const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
                const active = d.enabled && ends && ends > new Date();
                mtStatus.textContent = active ? 'Aktif' : 'Pasif';
                mtStatus.classList.toggle('active', active);
                mtStatus.title = active && ends ? `${ends.toLocaleString('tr-TR')} tarihine kadar aktif` : '';
                if (statMaintenance) statMaintenance.textContent = active ? 'Açık' : 'Kapalı';
            } else {
                mtStatus.textContent = 'Pasif';
                mtStatus.classList.remove('active');
                if (statMaintenance) statMaintenance.textContent = 'Kapalı';
            }
        });
    };

    document.getElementById('mtSave').onclick = async () => {
        const enabled = mtEnabled.checked;
        const endsVal = mtEndsAt.value;
        if (enabled && !endsVal) return showToast('Lütfen bir bitiş zamanı girin.', true);
        try {
            await db.collection('maintenance').doc(TENANT_ID).set({
                enabled,
                endsAt: endsVal ? firebase.firestore.Timestamp.fromDate(new Date(endsVal)) : null,
                message: mtMessage.value.trim(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            showToast('Bakım ayarları kaydedildi.');
        } catch (err) {
            console.error(err);
            showToast('Hata: ' + err.message, true);
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

    // ── ABONELİK YENİLEME (çevrim dışı) ────────────────────────
    // Online ödeme (PayTR / Lemon Squeezy) üründen kaldırıldı: tahsilat artık
    // havale/EFT ile yapılıyor, operatör ödemeyi superadmin panelinden elle
    // kaydediyor ve abonelik bitiş tarihini uzatıyor. Otel yöneticisine burada
    // yalnızca banka bilgileri gösterilir — siteConfig/billing herkese açık
    // okunabilir (firestore.rules), ayrı bir yetki gerekmez.
    const subOffline = document.getElementById('subOffline');
    if (subOffline) {
        db.collection('siteConfig').doc('billing').get().then(doc => {
            const b = (doc.exists && doc.data()) || {};
            const iban = String(b.iban || '').trim();
            const name = String(b.name || '').trim();
            if (!iban) {
                subOffline.innerHTML = '<span class="sub-offline-note">Abonelik yenileme için lütfen bizimle iletişime geçin.</span>';
                return;
            }
            subOffline.innerHTML =
                '<span class="sub-offline-note">Yenileme havale/EFT ile yapılır:</span>' +
                (name ? '<b class="sub-offline-name">' + esc(name) + '</b>' : '') +
                '<button type="button" class="btn btn-ghost sub-offline-iban" id="subIbanBtn">' + esc(iban) + ' <span>Kopyala</span></button>';
            document.getElementById('subIbanBtn')?.addEventListener('click', () => {
                try { navigator.clipboard.writeText(iban); showToast('IBAN kopyalandı.'); }
                catch (e) { showToast('Kopyalanamadı.', true); }
            });
        }).catch(() => {
            subOffline.innerHTML = '<span class="sub-offline-note">Abonelik yenileme için lütfen bizimle iletişime geçin.</span>';
        });
    }

    // ── PAYMENT HISTORY ─────────────────────────────────────────
    const payHistBody = document.getElementById('payHistBody');
    if (payHistBody) {
        const stMap = { success: ['Başarılı', 'ok'], pending: ['Bekliyor', 'warn'], failed: ['Başarısız', 'bad'], error: ['Hata', 'bad'] };
        const planName = { starter: 'Başlangıç', pro: 'Profesyonel', enterprise: 'Kurumsal' };
        db.collection('payments').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            const rows = snap.docs.map(d => d.data())
                .sort((a, b) => ((b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0)));
            if (!rows.length) { payHistBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--ink-3);padding:24px 0;">Henüz ödeme kaydı yok.</td></tr>'; return; }
            payHistBody.innerHTML = rows.map(p => {
                const d = p.createdAt && p.createdAt.toDate ? p.createdAt.toDate().toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
                const st = stMap[p.status] || [p.status || '—', ''];
                const amt = (p.amountTRY || 0).toLocaleString('tr-TR') + ' ₺';
                return `<tr><td>${d}</td><td>${esc(planName[p.plan] || p.plan || '—')}</td><td>${amt}</td><td><span class="fin-dot ${st[1]}"></span>${esc(st[0])}</td></tr>`;
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
        // Rezervasyonlar EUR/TRY/USD olabilir (concierge.js `currency`; eski
        // kayıtlarda alan yok = EUR). Önceden hepsi toplanıp '€' ile
        // gösteriliyordu — 5.000 ₺'lik bir transfer €5.000 sayılıyordu.
        // Artık her para birimi AYRI raporlanır (finCur seçicisi).
        const CUR_SYM = { EUR: '€', TRY: '₺', USD: '$' };
        const curOf = (r) => String((r && r.currency) || 'EUR').toUpperCase();
        let curSel = 'EUR';
        const money = (n) => (CUR_SYM[curSel] || (curSel + ' ')) + Math.round(n || 0).toLocaleString('tr-TR');
        const num = (v) => parseFloat(v) || 0;

        let finReservations = [];
        let commissions = {};

        const finRange = document.getElementById('finRange');
        const finFrom = document.getElementById('finFrom');
        const finTo = document.getElementById('finTo');
        const finCur = document.getElementById('finCur');
        if (!finRange) return; // finance UI not present

        // YEREL takvim günü (YYYY-MM-DD). toISOString() UTC'ye çevirdiği için
        // Türkiye'de (UTC+3) "Bu Ay" 31 Ekim → 29 Kasım çıkıyor, 00:00–03:00
        // arası "Bugün" dünü gösteriyordu. Rezervasyon `date` alanı da yerel.
        const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
            const inRange = finReservations.filter(r => r.date && curOf(r) === curSel && (!from || r.date >= from) && (!to || r.date <= to));
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
                `<div class="fin-line"><span><span class="fin-dot ok"></span>Onaylı</span><span><b>${money(sg(conf))}</b> <span class="muted">${conf.length} adet</span></span></div>` +
                `<div class="fin-line"><span><span class="fin-dot warn"></span>Bekleyen</span><span><b>${money(sg(pend))}</b> <span class="muted">${pend.length} adet</span></span></div>` +
                `<div class="fin-line"><span><span class="fin-dot"></span>İptal</span><span><span class="muted">${cancelled.length} adet</span></span></div>`;

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
        if (finCur) finCur.addEventListener('change', () => { curSel = finCur.value || 'EUR'; render(); });

        // Verideki para birimleri (en sık kullanılan önce). Tek birim varsa
        // seçici gizlenir; seçili birim veride kalmadıysa en sık olana geçer.
        function syncCurrencies() {
            const count = {};
            finReservations.forEach(r => { const c = curOf(r); count[c] = (count[c] || 0) + 1; });
            const list = Object.keys(count).sort((a, b) => count[b] - count[a]);
            if (!list.length) list.push('EUR');
            if (list.indexOf(curSel) === -1) curSel = list[0];
            if (!finCur) return;
            finCur.innerHTML = list.map(c => `<option value="${esc(c)}">${esc(c)}${CUR_SYM[c] ? ' (' + CUR_SYM[c] + ')' : ''}</option>`).join('');
            finCur.value = curSel;
            finCur.style.display = list.length > 1 ? '' : 'none';
        }

        db.collection('reservations').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            finReservations = snap.docs.map(d => d.data());
            syncCurrencies();
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
