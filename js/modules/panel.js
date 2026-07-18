function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Maintenance enforcement — also runs here so it works even if a cached page
// didn't load the guard script.
(function () {
    if (typeof db === 'undefined') return;
    db.collection('maintenance').doc(guardTenant()).onSnapshot((doc) => {
        if (!doc.exists) return;
        const d = doc.data();
        const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
        if (d.enabled && ends && ends > new Date()) window.location.replace('maintenance');
    }, function () {});
})();

document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth & Initial Setting
    const staffInitialInput = document.getElementById('staffInitial');
    const displayUsername = document.getElementById('displayUsername');
    const loggedUsername = localStorage.getItem('hotelUsername') || 'Admin';
    const loggedRole = (localStorage.getItem('hotelRole') || '').toLowerCase();
    const isAdminUser = loggedRole === 'admin' || loggedUsername.toLowerCase() === 'admin';
    const toast = document.getElementById('toast');

    if (staffInitialInput) staffInitialInput.value = loggedUsername;
    if (displayUsername) displayUsername.textContent = loggedUsername;

    // Top bar identity chip + quick search focus (shared app header).
    const userAvatar = document.getElementById('userAvatar');
    if (userAvatar) userAvatar.textContent = loggedUsername.slice(0, 2).toUpperCase();
    const roleLabel = document.getElementById('roleLabel');
    if (roleLabel) roleLabel.textContent = loggedRole === 'admin' ? 'Yönetici' : (loggedRole === 'manager' ? 'Müdür' : 'Personel');
    document.getElementById('hdSearchBtn')?.addEventListener('click', () => {
        document.getElementById('globalSearch')?.focus();
    });

    // Show Admin Link if user is admin
    const adminNavLink = document.getElementById('adminNavLink');
    const mobAdminBtn = document.getElementById('mobAdminBtn');
    if (isAdminUser) {
        if (adminNavLink) adminNavLink.style.display = 'inline-block';
        if (mobAdminBtn) mobAdminBtn.style.display = 'flex';
    }

    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // ── Department workflow: status model & duration helpers ──
    // Stored values stay English (legacy data + reports); only labels are Turkish.
    // Lifecycle: Following (waiting) → InProgress (taken) → Solved (completed).
    const STATUS_LABELS = { Following: 'Bekliyor', InProgress: 'İşlemde', Solved: 'Tamamlandı' };
    const statusLabelOf = (s) => STATUS_LABELS[s] || STATUS_LABELS.Following;

    function tsToDate(v) {
        if (!v) return null;
        if (v.toDate) return v.toDate();
        const d = new Date(v);
        return isNaN(d) ? null : d;
    }
    function tsMillis(v) { const d = tsToDate(v); return d ? d.getTime() : 0; }
    function fmtDuration(ms) {
        if (ms == null || ms < 0) return '—';
        const mins = Math.round(ms / 60000);
        if (mins < 1) return '<1 dk';
        if (mins < 60) return mins + ' dk';
        const h = Math.floor(mins / 60), m = mins % 60;
        if (h < 24) return m ? `${h} sa ${m} dk` : `${h} sa`;
        const d = Math.floor(h / 24), hr = h % 24;
        return hr ? `${d} g ${hr} sa` : `${d} g`;
    }
    function fmtClock(d) {
        return d ? d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }) + ' ' +
            d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—';
    }
    // Minutes between two firestore/date values; '' when either is missing.
    function minutesBetween(a, b) {
        const da = tsToDate(a), dbb = tsToDate(b);
        return (da && dbb) ? Math.max(0, Math.round((dbb - da) / 60000)) : '';
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            auth.signOut().then(() => {
                clearSessionStorage();
                window.location.href = 'login';
            });
        });
    }

    // ── AUTO LOGOUT LOGIC (15 MINS) ────────────────────────────
    let logoutTimer;
    function resetLogoutTimer() {
        clearTimeout(logoutTimer);
        logoutTimer = setTimeout(() => {
            auth.signOut().then(() => {
                clearSessionStorage();
                window.location.href = 'login';
            });
        }, 15 * 60 * 1000); // 15 minutes
    }

    // Reset on typing, changing inputs, scrolling, or touching
    ['keydown', 'input', 'change', 'scroll', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, resetLogoutTimer, true);
    });

    // Reset only on functional clicks (buttons, table rows, cards, inputs, etc.)
    document.addEventListener('click', (e) => {
        const isInteractive = e.target.closest('button, input, select, textarea, a, tr, .stat-pill, .nav-btn, .mob-nav-btn, .mob-fab, .sheet-backdrop, .sheet-pill');
        if (isInteractive) resetLogoutTimer();
    }, true);

    resetLogoutTimer(); // Start timer on load

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = 'login'; return; }
        listenShift(user.uid);
    });

    // ── GUEST DIRECTORY & STATUS LOGIC ────────────────────────
    let guestDirectory = [];
    async function loadGuestDirectory() {
        try {
            const snap = await db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get();
            guestDirectory = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Auto Check-Out past guests
            const today = new Date().toISOString().split('T')[0];
            const batch = db.batch();
            let needsCommit = false;
            const toClose = [];

            guestDirectory.forEach(g => {
                if (g.status === 'in_house' && g.checkOut && g.checkOut < today) {
                    batch.update(db.collection('guestDirectory').doc(g.id), { status: 'checked_out' });
                    g.status = 'checked_out';
                    if (g.activeStayId) toClose.push({ id: g.id, activeStayId: g.activeStayId });
                    needsCommit = true;
                }
            });

            if (needsCommit) await batch.commit();
            // Konaklamayı da kapat (stays.status=checked_out + activeStayId temizle).
            // İdempotent — iki personel ekranı eşzamanlı süpürse de aynı sonuca yazar.
            for (const g of toClose) { await GuestDirectory.closeStay(g, 'auto-checkout'); }

            renderGuestProfileList();
        } catch (e) { console.error("Error loading directory", e); }
    }

    // Paylaşımlı yardımcıya devrediyor (bkz. js/core/guest-directory.js) —
    // concierge.js'deki bağımsız kopyayla birleştirildi (tutarlılık denetimi).
    // Dönen misafir {id: guestId, stayId, ...} — yeni kayıtlar bu ID'lerle
    // ilişkilendirilir (kimlik migrasyonu).
    async function syncGuestStatus(name, room, status = 'in_house') {
        if (!name) return null;
        const result = await GuestDirectory.syncGuestStatus(name, { room, status });
        if (!result) return null;
        const idx = guestDirectory.findIndex(g => g.id === result.id);
        if (idx === -1) guestDirectory.push(result); else Object.assign(guestDirectory[idx], result);
        renderGuestProfileList();
        updateView(globalSearch.value, dateSearch.value);
        return result;
    }

    function getGuestStatus(name) {
        const guest = guestDirectory.find(g => g.name.toLowerCase() === (name || '').toLowerCase());
        return guest ? guest.status : 'in_house';
    }

    loadGuestDirectory();

    // ── LEGACY SYNC: Backfill directory from existing logs ──
    // Oturum başına BİR kez çalışır. Önceden canlı dinleyicinin her
    // snapshot'ında tetikleniyordu (koşul `length >= 0` hep true) — her
    // personel hareketinde tüm reservations koleksiyonu baştan okunuyordu
    // (bkz. hız denetimi). Ayrıca yazdığı dokümanlarda tenantId eksikti;
    // fail-closed kurallar yazımı reddedip fonksiyonu sessizce boşa
    // çalıştırıyordu — o da düzeltildi.
    let backfillDone = false;
    async function backfillGuestDirectory() {
        if (backfillDone || !records.length) return;
        backfillDone = true;

        try {
            // Load all current reservations to include concierge-only guests
            const resSnap = await db.collection('reservations').where('tenantId', '==', TENANT_ID).get();
            const resData = resSnap.docs.map(doc => doc.data());

            // Combine guest names from both logs and reservations
            const allSourceGuests = [
                ...records.map(r => ({ name: r.guestName, room: r.room })),
                ...resData.map(r => ({ name: r.guestName, room: r.room }))
            ];

            // Find unique guest names from sources that aren't in directory
            const existingNames = new Set(guestDirectory.map(g => g.name.toLowerCase()));
            const guestsToAddMap = {};

            allSourceGuests.forEach(g => {
                if (g.name && !existingNames.has(g.name.toLowerCase())) {
                    guestsToAddMap[g.name.toLowerCase()] = { name: g.name, room: g.room };
                }
            });

            const guestsToAdd = Object.values(guestsToAddMap);
            if (guestsToAdd.length === 0) return;

            console.log(`Backfilling ${guestsToAdd.length} guests into directory...`);
            const batch = db.batch();

            guestsToAdd.forEach(g => {
                const newRef = db.collection('guestDirectory').doc();
                const data = {
                    name: g.name,
                    nameKey: String(g.name).toLocaleLowerCase('tr-TR'),
                    room: g.room || '',
                    status: 'checked_out', // Assume historical ones are checked out
                    tenantId: TENANT_ID,
                    lastUpdated: new Date().toISOString()
                };
                batch.set(newRef, data);
                guestDirectory.push({ id: newRef.id, ...data });
            });

            await batch.commit();
            renderGuestProfileList();
            updateGuestMap();
            showToast(`${guestsToAdd.length} eski misafir kayıt defterine eklendi.`);
        } catch (e) { console.error("Backfill failed", e); }
    }

    // ── BACKUP LOGIC (JSON IMPORT/EXPORT) ──────────────────────
    const backupToggleBtn = document.getElementById('backupToggleBtn');
    const backupMenu = document.getElementById('backupMenu');
    const exportDataBtn = document.getElementById('exportDataBtn');
    const importDataBtn = document.getElementById('importDataBtn');
    const importFileInput = document.getElementById('importFileInput');

    if (backupToggleBtn) {
        backupToggleBtn.onclick = (e) => {
            e.stopPropagation();
            backupMenu?.classList.toggle('show');
        };
    }

    document.addEventListener('click', () => {
        backupMenu?.classList.remove('show');
    });

    // EXPORT: JSON (Full System Backup)
    // NOT: concierge.js'deki eşdeğer export (v3.0) guestDirectory'yi de
    // içeriyordu, burası (v2.0) eklenmemiş kalmıştı — panel.html'den alınan
    // "Tam Sistem Yedeği" misafir dizinini KAYBEDİYORDU (operasyonel denetim
    // bulgusu). concierge.js ile AYNI şema/versiyon numarasına hizalandı.
    exportDataBtn?.addEventListener('click', async () => {
        try {
            const logsSnap = await db.collection('guestLogs').where('tenantId', '==', TENANT_ID).get();
            const resSnap = await db.collection('reservations').where('tenantId', '==', TENANT_ID).get();
            const dirSnap = await db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get();

            const fullBackup = {
                guestLogs: logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                reservations: resSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                guestDirectory: dirSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                backupDate: new Date().toISOString(),
                version: "3.0"
            };

            const blob = new Blob([JSON.stringify(fullBackup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Full_System_Backup_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Sistem yedeği dışa aktarıldı.');
        } catch (e) { showToast('Dışa aktarma başarısız', true); }
    });

    // IMPORT: JSON (Full System Restore)
    if (!isAdminUser) {
        if (importDataBtn) importDataBtn.style.display = 'none';
    }

    importDataBtn?.addEventListener('click', () => {
        if (!isAdminUser) {
            return showToast('Yedek içe aktarmayı yalnızca Admin yapabilir.', true);
        }
        importFileInput.click();
    });

    importFileInput?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const data = JSON.parse(event.target.result);
                const batch = db.batch();
                let logCount = 0;
                let resCount = 0;
                let dirCount = 0;

                // Case 1: New Unified Backup Format
                if (data.guestLogs || data.reservations || data.guestDirectory) {
                    if (data.guestLogs) {
                        data.guestLogs.forEach(item => {
                            const { id, ...rest } = item;
                            batch.set(db.collection('guestLogs').doc(id), rest, { merge: true });
                            logCount++;
                        });
                    }
                    if (data.reservations) {
                        data.reservations.forEach(item => {
                            const { id, ...rest } = item;
                            batch.set(db.collection('reservations').doc(id), rest, { merge: true });
                            resCount++;
                        });
                    }
                    if (data.guestDirectory) {
                        data.guestDirectory.forEach(item => {
                            const { id, ...rest } = item;
                            batch.set(db.collection('guestDirectory').doc(id), rest, { merge: true });
                            dirCount++;
                        });
                    }
                }
                // Case 2: Legacy GuestLogs-only Array Format
                else if (Array.isArray(data)) {
                    data.forEach(item => {
                        const { id, ...rest } = item;
                        batch.set(db.collection('guestLogs').doc(id), rest, { merge: true });
                        logCount++;
                    });
                } else {
                    throw new Error('Unsupported backup format');
                }

                await batch.commit();
                showToast(`İçe aktarma başarılı: ${logCount} kayıt, ${resCount} rezervasyon, ${dirCount} CRM profili.`);
                e.target.value = '';
            } catch (err) { showToast('İçe aktarma başarısız: ' + err.message, true); }
        };
        reader.readAsText(file);
    });

    // Tab switching — works for both desktop nav and mobile bottom nav
    const switchTab = (tabId) => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        const targetTab = document.getElementById(tabId);
        if (targetTab) targetTab.classList.add('active');

        document.querySelectorAll(`[data-tab="${tabId}"]`).forEach(b => b.classList.add('active'));
    };

    document.querySelectorAll('.nav-btn[data-tab], .mob-nav-btn[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            if (tabId) switchTab(tabId);
        });
    });

    // ── MOBILE FAB & BOTTOM SHEET ──────────────────────────────
    const mobFab = document.getElementById('mobFab');
    const mobSheet = document.getElementById('mobSheet');
    const mobSheetClose = document.getElementById('mobSheetClose');
    const mobBackdrop = document.getElementById('mobSheetBackdrop');
    const mobSubmitBtn = document.getElementById('mobSubmitBtn');

    const openMobSheet = () => {
        // Pre-fill today's date
        const todayInput = document.getElementById('mob-date');
        if (todayInput && !todayInput.value) {
            todayInput.valueAsDate = new Date();
        }
        mobSheet?.classList.add('open');
        mobBackdrop?.classList.add('active');
        document.body.style.overflow = 'hidden';
    };

    const closeMobSheet = () => {
        mobSheet?.classList.remove('open');
        mobBackdrop?.classList.remove('active');
        document.body.style.overflow = '';
    };

    mobFab?.addEventListener('click', openMobSheet);
    mobSheetClose?.addEventListener('click', closeMobSheet);
    mobBackdrop?.addEventListener('click', closeMobSheet);

    // Mobile form submit — mirrors the desktop guestIssueForm
    mobSubmitBtn?.addEventListener('click', async () => {
        if (mobSubmitBtn.disabled) return; // çift tıklamada mükerrer kayıt önlenir
        const date = document.getElementById('mob-date')?.value;
        const room = document.getElementById('mob-room')?.value?.trim();
        const guestName = document.getElementById('mob-guestName')?.value?.trim();
        const department = document.getElementById('mob-department')?.value;
        const complaint = document.getElementById('mob-complaint')?.value?.trim();
        const solution = document.getElementById('mob-solution')?.value?.trim();

        if (!date || !room || !guestName) {
            showToast('Tarih, Oda ve Misafir Adı zorunludur.', true);
            return;
        }

        mobSubmitBtn.disabled = true;
        try {
            const guest = await syncGuestStatus(guestName, room);
            const payload = {
                date, room, guestName, department,
                complaint: complaint || '',
                solution: solution || '',
                staffInitial: loggedUsername,
                type: 'complaint', // mobil form şikayet formudur — tip damgası eksikti
                tenantId: TENANT_ID,
                status: 'Following',
                updates: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            // Kimlik: guestName/room gösterim snapshot'ı; ilişki guestId/stayId ile.
            if (guest) { payload.guestId = guest.id; if (guest.stayId) payload.stayId = guest.stayId; }
            const mobRef = await db.collection('guestLogs').add(payload);
            // Mobil yol da departmana bildirir (masaüstüyle aynı davranış).
            notifyRequestTeam(payload, mobRef.id, null);
            // Reset & close
            ['mob-date', 'mob-room', 'mob-guestName', 'mob-complaint', 'mob-solution'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            closeMobSheet();
            showToast('Kayıt başarıyla oluşturuldu.');
        } catch (err) {
            showToast('Error: ' + err.message, true);
        } finally {
            mobSubmitBtn.disabled = false;
        }
    });

    // ── PASSIVE INLINE ROOM CONFLICT DETECTOR ──
    const checkRoomConflict = (nameId, roomId, alertId) => {
        const alertEl = document.getElementById(alertId);
        if (!alertEl) return;

        const guestName = document.getElementById(nameId)?.value.trim().toLowerCase();
        const room = document.getElementById(roomId)?.value.trim();

        if (!room) {
            alertEl.style.display = 'none';
            return;
        }

        const conflict = guestDirectory.find(g =>
            g.room === room &&
            g.status === 'in_house' &&
            guestName && g.name.toLowerCase() !== guestName
        );

        if (conflict) {
            alertEl.innerHTML = `
                <div style="font-weight:bold; display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                    ⚠️ ODA ÇAKIŞMASI UYARISI
                </div>
                <div style="opacity:0.9;">Oda <b>${esc(room)}</b> şu an sistemde <b>${esc(conflict.name)}</b> (In-House) üzerine kayıtlı görünüyor.</div>
            `;
            alertEl.style.display = 'block';
        } else {
            alertEl.style.display = 'none';
        }
    };

    ['guestName', 'room'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => checkRoomConflict('guestName', 'room', 'gi-conflict-alert'));
        document.getElementById(id)?.addEventListener('blur', () => checkRoomConflict('guestName', 'room', 'gi-conflict-alert'));
    });

    ['mob-guestName', 'mob-room'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => checkRoomConflict('mob-guestName', 'mob-room', 'mob-conflict-alert'));
        document.getElementById(id)?.addEventListener('blur', () => checkRoomConflict('mob-guestName', 'mob-room', 'mob-conflict-alert'));
    });

    // Elements
    const issueForm = document.getElementById('guestIssueForm');
    const recordsTableBody = document.querySelector('#recordsTable tbody');
    const recordCountElement = document.getElementById('recordCount');
    const globalSearch = document.getElementById('globalSearch');
    const dateSearch = document.getElementById('dateSearch');
    const resetFilters = document.getElementById('resetFilters');

    // Helper for local timezone date (YYYY-MM-DD)
    function getLocalDate() {
        const d = new Date();
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // Default view to today's date
    if (!dateSearch.value) dateSearch.value = getLocalDate();

    // Modal
    const modal = document.getElementById('recordModal');
    const closeModal = document.getElementById('closeModal');
    const modalGuestRoom = document.getElementById('modalGuestRoom');
    const modalDept = document.getElementById('modalDept');
    const modalDesc = document.getElementById('modalDesc');
    const modalStatusBadge = document.getElementById('modalStatusBadge');
    const timelineFeed = document.getElementById('timelineFeed');
    const noteInput = document.getElementById('noteInput');
    const postNoteBtn = document.getElementById('postNoteBtn');
    const modalViewMode = document.getElementById('modalViewMode');
    const modalEditForm = document.getElementById('modalEditForm');

    // Confirm Modal
    const confirmModal = document.getElementById('confirmModal');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');

    let records = [];          // Görünen birleşik liste: canlı pencere + yüklenen eski kayıtlar (createdAt desc)
    let liveRecords = [];      // Son WINDOW_DAYS günü gerçek-zamanlı dinleyen pencere
    let olderRecords = [];     // "Daha eskisini yükle" / tam arşiv ile sayfalanan eski kayıtlar
    let fullyLoaded = false;   // Tüm arşiv (her kayıt) yüklendiyse true
    let loadingOlder = false;  // Eş zamanlı çift sayfalamayı önler
    const WINDOW_DAYS = 90;    // Canlı pencere genişliği (gün)
    const OLDER_PAGE = 200;    // "Daha eskisini yükle" sayfa boyutu
    let editingId = null;
    let selectedRecord = null;
    let recordToDelete = null;

    let globalGuestsHTML = ''; // Local cache for guests
    let reportsHTML = '';      // Local cache for reports list

    function updateGuestMap() {
        // Prepare the HTML snapshot in memory first
        globalGuestsHTML = guestDirectory.sort((a, b) => a.name.localeCompare(b.name))
            .map(g => `<option value="${esc(g.name)}">${esc(g.room || '')}</option>`).join('');

        // Live sync running components only if they have active content
        document.querySelectorAll('#guest-list').forEach(list => {
            if (list.children.length > 0) list.innerHTML = globalGuestsHTML;
        });
    }

    // Advanced Reactive Autocompletion: only expand after 3 chars
    function setupDynamicAutolist(inputId, listId, src = 'main') {
        const inputEl = document.getElementById(inputId);
        const listEl = document.getElementById(listId);
        if (!inputEl || !listEl) return;

        listEl.innerHTML = ''; // Start safely locked down

        inputEl.addEventListener('input', (e) => {
            const typedVal = e.target.value.trim();
            if (typedVal.length >= 3) {
                // Only render crossover when actually required
                if (listEl.children.length === 0) {
                    listEl.innerHTML = (src === 'reports') ? reportsHTML : globalGuestsHTML;
                }
            } else {
                // Auto-suppress upon partial delete
                listEl.innerHTML = '';
            }
        });
    }

    // Instigate gating hooks immediately
    setupDynamicAutolist('guestName', 'guest-list');
    setupDynamicAutolist('rpt-guestSearch', 'guestNamesList', 'reports');

    // 2. Data Persistence
    //
    // Kayan pencere: canlı dinleyici yalnızca son WINDOW_DAYS günü gerçek
    // zamanlı izler (tüm koleksiyonu sürekli streaming etmek yerine). Daha eski
    // kayıtlar gizlenmez — "Daha eskisini yükle" ile sayfalanır, raporlar/
    // arşiv dışa aktarımı ise ensureFullArchive() ile tüm arşivi talep üzerine
    // yükler. Böylece geçmiş veri her zaman erişilebilir kalır.
    function mergeRecords() {
        const map = new Map();
        olderRecords.forEach(r => map.set(r.id, r));
        liveRecords.forEach(r => map.set(r.id, r)); // canlı sürüm güncel olduğundan eskisini ezer
        records = Array.from(map.values()).sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    }

    function syncLoadOlderBtn() {
        const btn = document.getElementById('loadOlderBtn');
        if (!btn) return;
        btn.style.display = fullyLoaded ? 'none' : '';
        btn.disabled = loadingOlder;
        btn.textContent = loadingOlder ? 'Yükleniyor…' : 'Daha eskisini yükle';
    }

    // Bir sonraki eski sayfayı (en eski yüklü kayıttan öncesini) tek seferlik çeker.
    function loadOlder() {
        if (loadingOlder || fullyLoaded) return Promise.resolve();
        loadingOlder = true; syncLoadOlderBtn();
        let q = db.collection('guestLogs').where('tenantId', '==', TENANT_ID).orderBy('createdAt', 'desc');
        // __deepLinked kayıtları cursor hesabından hariç tut — bkz. yukarıdaki not.
        const pagedRecords = records.filter(r => !r.__deepLinked);
        const oldest = pagedRecords[pagedRecords.length - 1];
        if (oldest && oldest.createdAt) q = q.startAfter(oldest.createdAt);
        return q.limit(OLDER_PAGE).get().then(snap => {
            olderRecords = olderRecords.concat(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
            if (snap.size < OLDER_PAGE) fullyLoaded = true; // arşivin sonuna gelindi
            mergeRecords();
            updateView(globalSearch.value, dateSearch.value);
        }).catch(() => {}).finally(() => { loadingOlder = false; syncLoadOlderBtn(); });
    }

    // Raporlar/arşiv dışa aktarımı ve performans paneli için tüm arşivi (bir kez)
    // garanti eder. fullyLoaded ise anında çözülür.
    function ensureFullArchive() {
        if (fullyLoaded) return Promise.resolve();
        return db.collection('guestLogs').where('tenantId', '==', TENANT_ID).orderBy('createdAt', 'desc').get()
            .then(snap => {
                olderRecords = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                fullyLoaded = true;
                mergeRecords();
                syncLoadOlderBtn();
            }).catch(() => {});
    }

    const fetchRecords = () => {
        const cutoff = firebase.firestore.Timestamp.fromMillis(Date.now() - WINDOW_DAYS * 86400000);
        db.collection('guestLogs').where('tenantId', '==', TENANT_ID)
            .where('createdAt', '>=', cutoff)
            .orderBy('createdAt', 'desc').onSnapshot(snapshot => {
            liveRecords = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            mergeRecords();
            syncLoadOlderBtn();
            updateGuestMap();
            refreshTopicDatalists();
            updateView(globalSearch.value, dateSearch.value);
            autoEscalateSweep();

            // Trigger backfill check — dizin yüklendikten sonra, oturumda bir kez.
            // (Önceki `length >= 0` koşulu her zaman true'ydu; dizin boşken
            // çalışırsa tüm misafirleri mükerrer eklerdi.)
            if (guestDirectory.length) backfillGuestDirectory();

            // Sync selectedRecord to avoid undefined errors in editNote
            if (selectedRecord) {
                const refreshed = records.find(r => r.id === selectedRecord.id);
                if (refreshed) {
                    selectedRecord = refreshed; // Sync variable
                    renderTimeline(refreshed);  // Refresh UI
                    // renderWorkflow()/updateStatusBadge() de yenilenmeli — aksi
                    // halde bir başka personel bu kaydı üstlenir/tamamlarsa, bu
                    // modal hâlâ eski butonları (ör. "Üstlen") gösterip tıklanmaya
                    // izin verir; transitionRecordImpl artık sunucu tarafında
                    // reddediyor ama kullanıcı bunu görmeden önce tıklayabilirdi.
                    updateStatusBadge(refreshed.status);
                    renderWorkflow(refreshed);
                }
            }

            // Deep-link from a notification: ?open=<recordId> opens it once.
            // Pencere dışındaki (eski) bir kayda işaret ediyorsa doğrudan getir.
            if (!openHandled) {
                const openId = new URLSearchParams(location.search).get('open');
                if (openId) {
                    const rec = records.find(r => r.id === openId);
                    if (rec) { openHandled = true; openModal(rec); }
                    else {
                        openHandled = true;
                        db.collection('guestLogs').doc(openId).get().then(d => {
                            if (d.exists) {
                                const data = { id: d.id, ...d.data() };
                                if ((data.tenantId || '') === TENANT_ID) {
                                    // Sayfalanan pencere dışından tek bir kayıt — loadOlder()'ın
                                    // cursor hesabından hariç tutulur (bkz. __deepLinked filtresi),
                                    // aksi halde bu kayıt yanlışlıkla yeni "en eski" sayılıp
                                    // gerçek pencere sınırı ile bu kayıt arasındaki tarih aralığı
                                    // sonraki "Daha eskisini yükle" tıklamalarında atlanırdı.
                                    data.__deepLinked = true;
                                    olderRecords.push(data); mergeRecords();
                                    updateView(globalSearch.value, dateSearch.value);
                                    openModal(data);
                                }
                            }
                        }).catch(() => {});
                    }
                }
            }
        });
    };
    let openHandled = false;
    fetchRecords();
    document.getElementById('loadOlderBtn')?.addEventListener('click', loadOlder);

    // Guest auto-fill logic
    document.getElementById('guestName')?.addEventListener('input', (e) => {
        const g = guestDirectory.find(x => x.name === e.target.value);
        if (g && g.room) document.getElementById('room').value = g.room;
    });
    document.getElementById('mob-guestName')?.addEventListener('input', (e) => {
        const g = guestDirectory.find(x => x.name === e.target.value);
        if (g && g.room) document.getElementById('mob-room').value = g.room;
    });

    // PMS live lookup on the new-request guest/room fields.
    if (window.PMS) {
        PMS.attach({
            nameInput: document.getElementById('guestName'),
            roomInput: document.getElementById('room')
        });
    }

    issueForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtnEl = document.getElementById('submitBtn');
        if (submitBtnEl && submitBtnEl.disabled) return; // çift tıklamada mükerrer kayıt önlenir
        if (submitBtnEl) submitBtnEl.disabled = true;
        try {
            const recordType = document.getElementById('recordType').value || 'complaint';
            const isRequest = recordType === 'request';
            const formData = {
                date: document.getElementById('date').value,
                room: document.getElementById('room').value,
                guestName: document.getElementById('guestName').value,
                department: document.getElementById('department').value,
                topic: isRequest ? '' : ((document.getElementById('topic').value || '').trim() || 'Genel'),
                complaint: document.getElementById('complaint').value,
                solution: isRequest ? '' : document.getElementById('solution').value,
                staffInitial: document.getElementById('staffInitial').value,
                type: recordType,
                status: 'Following',
                updates: [],
                tenantId: TENANT_ID,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            // For requests, capture the picked online teammate (if any).
            if (isRequest && selectedAssignee) {
                formData.assignedTo = selectedAssignee.uid;
                formData.assignedToName = selectedAssignee.username;
            }
            // Kimlik: guestName/room artık yalnızca gösterim snapshot'ı —
            // kalıcı ilişkilendirme guestId + stayId ile yapılır (bkz.
            // js/core/guest-directory.js). Çift-yazım dönemi: eski alanlar
            // da yazılmaya devam eder.
            const guest = await syncGuestStatus(formData.guestName, formData.room);
            if (guest) {
                formData.guestId = guest.id;
                if (guest.stayId) formData.stayId = guest.stayId;
            }
            const ref = await db.collection('guestLogs').add(formData);

            // Remember a freshly-typed complaint topic for future suggestions.
            if (!isRequest && formData.topic && formData.topic !== 'Genel' && window.IssueConfig) {
                IssueConfig.addTopic(formData.topic);
            }

            // Kaydı ilgili departmandaki tüm kullanıcılara (+ varsa atanan
            // kişiye) bildir — önceden YALNIZCA talepler bildiriliyordu;
            // şikayetler sessiz kalıyordu (klima arızasını teknik servisin
            // haber alamaması). Artık her iki tür de departmana gider.
            notifyRequestTeam(formData, ref.id, isRequest ? selectedAssignee : null);

            const assignedName = formData.assignedToName || '';
            issueForm.reset();
            selectedAssignee = null;
            staffInitialInput.value = loggedUsername;
            document.getElementById('date').valueAsDate = new Date();
            const niModal = document.getElementById('newIssueModal');
            if (niModal) niModal.style.display = 'none';
            const successTitle = document.querySelector('#successModal h3');
            const successText = document.querySelector('#successModal p');
            if (successTitle) successTitle.textContent = isRequest ? 'Talep İletildi!' : 'Şikayet Kaydedildi!';
            if (successText) successText.textContent = isRequest
                ? 'Talep ' + (assignedName ? assignedName + ' personeline atandı ve bildirim gönderildi.' : 'departman kuyruğuna eklendi.') + ' E-posta taslağı hazırlamak ister misiniz?'
                : 'Bu kayıt için şimdi bir e-posta taslağı hazırlamak ister misiniz?';
            document.getElementById('successModal').style.display = 'flex';
        } catch (err) {
            showToast('Hata: ' + err.message, true);
        } finally {
            if (submitBtnEl) submitBtnEl.disabled = false;
        }
    });

    // ── Department select + global topic suggestions ───────────
    // Department comes from the per-hotel config (issueConfig), filtered by type.
    // A legacy/current value not in the config is kept so old records still
    // display and edit correctly.
    function fillDeptSelect(sel, type, current) {
        if (!sel) return;
        const list = (window.IssueConfig ? IssueConfig.departmentsFor(type) : []);
        const names = list.map(d => d.name);
        if (current && names.indexOf(current) === -1) names.unshift(current);
        sel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
        if (current && names.indexOf(current) !== -1) sel.value = current;
    }

    // Konu (topic) is typed manually for complaints. Suggestions come from the
    // persisted, admin-curatable topic list (issueTopics) — global, not tied to a
    // department. A newly typed topic is persisted on save, so next time it is a
    // suggestion (like picking a returning guest by name).
    function knownTopics() {
        return (window.IssueConfig ? IssueConfig.topics() : []);
    }
    function refreshTopicDatalists() {
        const html = knownTopics().map(t => `<option value="${esc(t)}"></option>`).join('');
        ['topicOptions', 'editTopicOptions'].forEach(id => {
            const dl = document.getElementById(id);
            if (dl) dl.innerHTML = html;
        });
        // Keep the report's topic filter in sync if present.
        if (typeof populateReportTopics === 'function') populateReportTopics();
    }
    if (window.IssueConfig) {
        IssueConfig.listenTopics(() => refreshTopicDatalists());
    }

    // ── Request vs complaint toggle + live assignee picker ─────
    let selectedAssignee = null;
    const reqTypeToggle = document.getElementById('reqTypeToggle');
    const departmentSel = document.getElementById('department');

    function refreshNewFormDepts() {
        const type = document.getElementById('recordType').value || 'complaint';
        fillDeptSelect(departmentSel, type, departmentSel ? departmentSel.value : '');
    }

    // Populate now (defaults) and refresh once the per-hotel config is loaded,
    // then keep listening so admin edits reflect live.
    if (window.IssueConfig) {
        refreshNewFormDepts();
        IssueConfig.load().then(refreshNewFormDepts);
        IssueConfig.listen(() => refreshNewFormDepts());
    }

    function setRecordType(type) {
        document.getElementById('recordType').value = type;
        reqTypeToggle.querySelectorAll('.type-opt').forEach(b => b.classList.toggle('active', b.dataset.type === type));
        const isReq = type === 'request';
        document.getElementById('solutionGroup').style.display = isReq ? 'none' : 'block';
        document.getElementById('assigneeGroup').style.display = isReq ? 'block' : 'none';
        // Konu only applies to complaints — hide it for requests.
        const topicGroup = document.getElementById('topicGroup');
        if (topicGroup) topicGroup.style.display = isReq ? 'none' : 'block';
        document.getElementById('complaintLabel').textContent = isReq ? 'Talep Detayı' : 'Şikayet Detayı';
        document.getElementById('complaint').placeholder = isReq ? 'Misafirin talebini yazın' : 'Sorunu açıklayın';
        const niTitle = document.getElementById('newIssueTitle');
        if (niTitle) niTitle.textContent = isReq ? 'Yeni Talep' : 'Yeni Şikayet';
        document.querySelector('#submitBtn').textContent = isReq ? 'Talebi Departmana İlet' : 'Şikayeti Kaydet';
        fillDeptSelect(departmentSel, type, departmentSel ? departmentSel.value : '');
        if (isReq) loadAssignees();
    }
    reqTypeToggle?.querySelectorAll('.type-opt').forEach(btn => {
        btn.addEventListener('click', () => setRecordType(btn.dataset.type));
    });

    async function loadAssignees() {
        const picker = document.getElementById('assigneePicker');
        const empty = document.getElementById('assigneeEmpty');
        picker.innerHTML = '<span class="muted-sm" style="color:#94a3b8;font-size:12px;">Yükleniyor…</span>';
        const users = window.RT ? await RT.getActiveUsers(true) : [];
        if (!users.length) {
            picker.innerHTML = '';
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';
        picker.innerHTML = users.map(u => `
            <button type="button" class="assignee-chip" data-uid="${esc(u.uid)}" data-name="${esc(u.username)}">
                <span class="av">${esc((u.username || '?').slice(0, 2).toUpperCase())}</span>
                ${esc(u.username)}
                <span class="live-dot" title="Çevrimiçi"></span>
            </button>`).join('');
        picker.querySelectorAll('.assignee-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const already = chip.classList.contains('selected');
                picker.querySelectorAll('.assignee-chip').forEach(c => c.classList.remove('selected'));
                if (already) { selectedAssignee = null; return; }
                chip.classList.add('selected');
                selectedAssignee = { uid: chip.dataset.uid, username: chip.dataset.name };
            });
        });
    }

    // ── New Issue modal (Concierge-style creation flow) ────────
    const newIssueModal = document.getElementById('newIssueModal');
    // Mobil FAB → aynı "yeni kayıt" akışı
    document.getElementById('giFabNew')?.addEventListener('click', () => {
        document.getElementById('newIssueBtn')?.click();
    });
    document.getElementById('newIssueBtn')?.addEventListener('click', () => {
        const dateInput = document.getElementById('date');
        if (dateInput && !dateInput.value) dateInput.valueAsDate = new Date();
        if (staffInitialInput && !staffInitialInput.value) staffInitialInput.value = loggedUsername;
        selectedAssignee = null;
        setRecordType('complaint');
        newIssueModal.style.display = 'flex';
        document.getElementById('guestName')?.focus();
    });

    // Open a record straight from a notification (bell/toast click).
    if (window.RT) {
        RT.onOpen = (recordId) => {
            const rec = records.find(r => r.id === recordId);
            if (rec) openModal(rec);
            else showToast('Kayıt bulunamadı (silinmiş olabilir).', true);
        };
    }
    document.getElementById('closeNewIssue')?.addEventListener('click', () => {
        newIssueModal.style.display = 'none';
    });
    newIssueModal?.addEventListener('click', (e) => {
        if (e.target === newIssueModal) newIssueModal.style.display = 'none';
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && newIssueModal && newIssueModal.style.display === 'flex') {
            newIssueModal.style.display = 'none';
        }
    });

    // ═══════════════════════════════════════════════════════════
    // REPORTS MODAL
    // ═══════════════════════════════════════════════════════════
    const reportsModal = document.getElementById('reportsModal');
    const rptTypeSelect = document.getElementById('reportTypeSelect');

    document.getElementById('openReportsBtn')?.addEventListener('click', () => {
        reportsModal.style.display = 'flex';
        populateGuestDatalist();
        populateReportTopics();
        updateRptUI(); // Reset UI state on open
    });

    // Fill the report "Konu" filter from the persisted topic list.
    function populateReportTopics() {
        const sel = document.getElementById('rpt-topicSelect');
        if (!sel) return;
        const current = sel.value;
        const topics = (window.IssueConfig ? IssueConfig.topics() : []);
        sel.innerHTML = '<option value="All">Tüm Konular</option>'
            + topics.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
        if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
    }
    window.populateReportTopics = populateReportTopics;

    function populateGuestDatalist() {
        // Construct the latest unique names string
        const uniqueNames = [...new Set(records.map(r => r.guestName).filter(Boolean))].sort();
        reportsHTML = uniqueNames.map(name => `<option value="${esc(name)}">`).join('');

        // Sync live component if active
        const list = document.getElementById('guestNamesList');
        if (list && list.children.length > 0) list.innerHTML = reportsHTML;
    }

    document.getElementById('closeReportsModal')?.addEventListener('click', () => {
        reportsModal.style.display = 'none';
    });

    // Dynamic UI Toggles
    rptTypeSelect?.addEventListener('change', updateRptUI);

    function updateRptUI() {
        const type = rptTypeSelect.value;
        const specificDateCont = document.getElementById('rpt-specificDateContainer');
        const rangeGroup = document.getElementById('rpt-rangeGroup');
        const deptCont = document.getElementById('rpt-deptContainer');
        const guestCont = document.getElementById('rpt-guestContainer');
        const topicCont = document.getElementById('rpt-topicContainer');

        // Reset all
        specificDateCont.style.display = 'none';
        rangeGroup.style.display = 'none';
        deptCont.style.display = 'none';
        guestCont.style.display = 'none';
        if (topicCont) topicCont.style.display = 'none';

        // Show based on type
        if (type === 'summary' || type === 'byDate' || type === 'department') {
            specificDateCont.style.display = 'block';
            if (type === 'department') deptCont.style.display = 'block';
        } else if (type === 'dateRange' || type === 'historicalStatus' || type === 'deptHistorical' || type === 'status' || type === 'deptPerformance' || type === 'taskDurations') {
            rangeGroup.style.display = 'flex';
            if (type === 'deptHistorical') deptCont.style.display = 'block';
        } else if (type === 'topic') {
            rangeGroup.style.display = 'flex';
            if (topicCont) topicCont.style.display = 'block';
        } else if (type === 'guest') {
            guestCont.style.display = 'block';
        }
    }

    // Proxy function called from HTML buttons
    window.generateReportFromUI = function (format) {
        const type = rptTypeSelect.value;
        generateReport(type, format);
    };

    // Track last rendered rows for "Current View" export
    let lastRenderedRows = [];

    // ── Helpers ────────────────────────────────────────────────
    function getRptDates() {
        return {
            from: document.getElementById('rpt-dateFrom')?.value || '',
            to: document.getElementById('rpt-dateTo')?.value || '',
            specific: document.getElementById('rpt-specificDate')?.value || getLocalDate(),
            dept: document.getElementById('rpt-departmentSelect')?.value || 'All',
            guest: document.getElementById('rpt-guestSearch')?.value || '',
            topic: document.getElementById('rpt-topicSelect')?.value || 'All'
        };
    }

    function filterByRange(data, from, to) {
        return data.filter(r => {
            if (from && r.date < from) return false;
            if (to && r.date > to) return false;
            return true;
        });
    }

    // İşi kimin yaptığı: üstlenen > tamamlayan > atanan; eski tamamlanmış
    // kayıtlarda kaydı giren; açık ve sahipsizse "Üstlenilmedi".
    function reportWorker(r) {
        if (r.acknowledgedBy) return r.acknowledgedBy;
        if (r.completedBy) return r.completedBy;
        if (r.assignedToName) return r.assignedToName;
        if ((r.status || 'Following') === 'Solved') return r.staffInitial || '—';
        return 'Üstlenilmedi';
    }
    function rowBase(r) {
        return {
            Date: r.date,
            Room: r.room,
            'Guest Name': r.guestName,
            Department: r.department,
            Complaint: r.complaint,
            Solution: r.solution || '',
            Staff: r.staffInitial,
            'Üstlenen': reportWorker(r),
            Status: r.status || 'Following'
        };
    }

    // ── Excel Helpers ──────────────────────────────────────────

    function exportExcel(rows, filename, sheetName = 'Report', summaryData = null) {
        if (!rows || rows.length === 0) return showToast('Bu rapor için veri yok.', true);

        const keys = Object.keys(rows[0]);

        // Build Summary Table if provided
        let summaryHtml = '';
        if (summaryData) {
            summaryHtml = `
                <table style="margin-bottom: 25px;">
                    <thead>
                        <tr><th colspan="2" style="background: #2563eb; color: white;">OPERATIONAL SUMMARY</th></tr>
                    </thead>
                    <tbody>
                        ${Object.entries(summaryData).map(([k, v]) => `
                            <tr>
                                <td style="font-weight: bold; background: #f8fafc; width: 180px;">${k}</td>
                                <td style="text-align: center; width: 100px; font-weight: bold;">${v}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                <div style="height: 20px;"></div>
            `;
        }

        // Build Excel-compatible XML/HTML String for full styling support
        let excelHtml = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
            <head>
                <meta charset="UTF-8">
                <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${sheetName}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
                <style>
                    table { border-collapse: collapse; margin-bottom: 10px; }
                    td, th { 
                        border: 0.5pt solid #000000; 
                        padding: 8px; 
                        vertical-align: middle; 
                        word-wrap: break-word; 
                        white-space: normal;
                        font-family: "Segoe UI", Arial, sans-serif;
                        font-size: 10pt;
                    }
                    th { 
                        background-color: #1a1a1a; 
                        color: #ffffff;
                        font-weight: bold; 
                        text-align: center;
                    }
                    .text-center { text-align: center; }
                    /* Column widths for A4 fit */
                    .col-date { width: 80px; }
                    .col-room { width: 60px; }
                    .col-guest { width: 150px; }
                    .col-desc { width: 300px; }
                </style>
            </head>
            <body>
                ${summaryHtml}
                <table>
                    <thead>
                        <tr>${keys.map(k => `<th>${k}</th>`).join('')}</tr>
                    </thead>
                    <tbody>
                        ${rows.map(r => `
                            <tr>
                                ${keys.map(k => {
            const val = r[k] || '';
            let className = '';
            if (k.toLowerCase().includes('date')) className = 'col-date text-center';
            if (k.toLowerCase().includes('room')) className = 'col-room text-center';
            if (k.toLowerCase().includes('guest')) className = 'col-guest';
            if (k.toLowerCase().includes('complaint') || k.toLowerCase().includes('solution') || k.toLowerCase().includes('notes')) className = 'col-desc';

            return `<td class="${className}">${val}</td>`;
        }).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </body>
            </html>
        `;

        const blob = new Blob([excelHtml], { type: 'application/vnd.ms-excel' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}_${getLocalDate()}.xls`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Excel raporu indirildi.');
    }

    function fixTurkishChars(str) {
        if (typeof str !== 'string') return str;
        return str
            .replace(/ı/g, 'i').replace(/İ/g, 'I')
            .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
            .replace(/ü/g, 'u').replace(/Ü/g, 'U')
            .replace(/ş/g, 's').replace(/Ş/g, 'S')
            .replace(/ö/g, 'o').replace(/Ö/g, 'O')
            .replace(/ç/g, 'c').replace(/Ç/g, 'C');
    }

    // ── PDF export ─────────────────────────────────────────────
    function exportPDF(title, headers, rows, filename, subtitle = '') {
        if (!rows || rows.length === 0) return showToast('Bu rapor için veri yok.', true);
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: rows[0].length > 6 ? 'landscape' : 'portrait' });

        // Fix Turkish chars
        const fixedTitle = fixTurkishChars(title);
        const fixedSubtitle = fixTurkishChars(subtitle);
        const fixedHeaders = headers.map(h => fixTurkishChars(h));
        const fixedRows = rows.map(row => row.map(cell => fixTurkishChars(cell)));

        // Header band
        doc.setFillColor(21, 101, 192);
        doc.rect(0, 0, doc.internal.pageSize.getWidth(), 28, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text(fixedTitle, 14, 12);
        doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        doc.text(fixedSubtitle || `Generated: ${getLocalDate()}`, 14, 20);
        doc.setTextColor(0, 0, 0);
        doc.autoTable({
            head: [fixedHeaders],
            body: fixedRows,
            startY: 32,
            theme: 'grid',
            headStyles: { fillColor: [43, 58, 74], textColor: 255, fontStyle: 'bold', fontSize: 9 },
            bodyStyles: { fontSize: 8.5 },
            alternateRowStyles: { fillColor: [245, 248, 255] },
            margin: { left: 14, right: 14 }
        });
        // Footer
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8); doc.setTextColor(150);
            doc.text(`Page ${i} of ${pageCount} — Guest Issues Management System`, 14, doc.internal.pageSize.getHeight() - 8);
        }
        doc.save(`${filename}_${getLocalDate()}.pdf`);
        showToast('PDF raporu indirildi.');
    }

    // ── Report Engine ──────────────────────────────────────────
    // Raporlar tüm arşivi gerektirir (rastgele tarih/aralık). Canlı liste 90
    // günlük pencereyle çalıştığından, rapor üretmeden önce tüm arşivi talep
    // üzerine yükleriz — böylece eski tarihli raporlar/arşiv eksiksiz olur.
    // Dışa-aktarma kütüphaneleri TEMBEL yüklenir (bkz. js/core/lazy-load.js) —
    // önceden sayfa açılışında ~800KB (jspdf+autotable+xlsx) eager iniyordu,
    // oysa yalnızca rapor indirme anında lazım (hız denetimi). Tüm rapor
    // çıktıları bu tek giriş noktasından geçtiği için burada yüklemek yeterli.
    const PDF_LIB_URLS = [
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js'
    ];
    const XLSX_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    async function ensureExportLibs(format) {
        try {
            if (format === 'pdf') await loadScriptsOnce(PDF_LIB_URLS);
            else if (format === 'excel') await loadScriptOnce(XLSX_LIB_URL);
        } catch (e) {
            showToast('Rapor kütüphanesi yüklenemedi — bağlantınızı kontrol edin.', true);
            throw e;
        }
    }
    window.generateReport = async function (type, format) {
        await ensureExportLibs(format);
        if (!fullyLoaded) { showToast('Arşiv yükleniyor…'); await ensureFullArchive(); }
        const { from, to, specific, dept, guest, topic } = getRptDates();

        if (type === 'summary') {
            const date = specific || getLocalDate();
            let data = records.filter(r => r.date === date);

            // Optional: apply dept filter even here if user selected one? 
            // Usually summary is general, but let's stick to the specific date.

            const total = data.length, solved = data.filter(r => r.status === 'Solved').length;
            const following = total - solved, overdue = data.filter(r => isOverdueFn(r)).length;
            const deptCounts = {};
            data.forEach(r => deptCounts[r.department] = (deptCounts[r.department] || 0) + 1);
            const summaryRows = [
                { Metric: 'Total Issues', Value: total },
                { Metric: 'Solved', Value: solved },
                { Metric: 'Following', Value: following },
                { Metric: 'Overdue (>15 min)', Value: overdue },
                ...Object.entries(deptCounts).map(([d, cnt]) => ({ Metric: `Dept: ${d}`, Value: cnt }))
            ];
            const detailRows = data.map(r => rowBase(r));
            if (format === 'excel') {
                const wb = XLSX.utils.book_new();
                const wsSum = XLSX.utils.json_to_sheet(summaryRows);
                const wsDet = XLSX.utils.json_to_sheet(detailRows);
                autoSizeSheet(wsSum, summaryRows);
                autoSizeSheet(wsDet, detailRows);
                XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');
                XLSX.utils.book_append_sheet(wb, wsDet, 'Detail');
                XLSX.writeFile(wb, `General_Summary_${date}.xlsx`);
                showToast('Excel raporu indirildi.');
            } else {
                exportPDF(`General Summary — ${date}`,
                    ['Date', 'Room', 'Guest Name', 'Department', 'Complaint', 'Solution', 'Staff', 'Status'],
                    detailRows.map(r => Object.values(r)),
                    `General_Summary_${date}`,
                    `Total: ${total} | Solved: ${solved} | Following: ${following} | Overdue: ${overdue}`
                );
            }
        }

        else if (type === 'inHouseIssues') {
            const inHouseNames = new Set(guestDirectory.filter(g => g.status === 'in_house').map(g => g.name.toLowerCase()));
            const data = records.filter(r => inHouseNames.has(r.guestName?.toLowerCase()));

            const deptSummary = {};
            data.forEach(r => deptSummary[r.department] = (deptSummary[r.department] || 0) + 1);

            const summaryData = {
                'Total In-House Issues': data.length,
                ...Object.entries(deptSummary).reduce((acc, [d, c]) => { acc[`Dept: ${d}`] = c; return acc; }, {})
            };

            if (format === 'excel') {
                exportExcel(data.map(rowBase), 'In_House_Issues', 'InHouse', summaryData);
            } else {
                const rows = data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 35), r.staffInitial, reportWorker(r), r.status || 'Following']);
                exportPDF('In-House Guest Issues', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Üstlenen', 'Status'], rows, 'In_House_Issues',
                    `Total Active In-House Issues: ${data.length} | ` + Object.entries(deptSummary).map(([d, c]) => `${d}:${c}`).join(' | '));
            }
        }

        else if (type === 'department') {
            const date = specific || getLocalDate();
            let data = records.filter(r => r.date === date);
            if (dept !== 'All') data = data.filter(r => sameDept(r.department, dept));

            const grouped = {};
            data.forEach(r => {
                const d = canonicalDept(r.department) || 'Unknown';
                if (!grouped[d]) grouped[d] = [];
                grouped[d].push(r);
            });
            if (format === 'excel') {
                const wb = XLSX.utils.book_new();
                const summary = Object.entries(grouped).map(([d, arr]) => ({
                    Solved: arr.filter(r => r.status === 'Solved').length,
                    Following: arr.filter(r => r.status !== 'Solved').length
                }));
                const wsSum = XLSX.utils.json_to_sheet(summary);
                autoSizeSheet(wsSum, summary);
                XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');
                Object.entries(grouped).forEach(([d, arr]) => {
                    const sheetName = d.substring(0, 31);
                    const rowsData = arr.map(rowBase);
                    const wsDept = XLSX.utils.json_to_sheet(rowsData);
                    autoSizeSheet(wsDept, rowsData);
                    XLSX.utils.book_append_sheet(wb, wsDept, sheetName);
                });
                XLSX.writeFile(wb, `By_Department_${dept}_${getLocalDate()}.xlsx`);
                showToast('Excel raporu indirildi.');
            } else {
                const rows = Object.entries(grouped).flatMap(([d, arr]) =>
                    arr.map(r => [d, r.date, r.room, r.guestName, r.complaint?.substring(0, 40), r.status || 'Following'])
                );
                exportPDF(`Issues by Department (${dept})`, ['Department', 'Date', 'Room', 'Guest', 'Complaint', 'Status'], rows, `By_Department_${dept}`);
            }
        }

        // ── Konu bazlı rapor (yalnızca şikayetler): hangi konular ne sıklıkla
        //    tekrar ediyor, çözülme oranı ne? Tarih aralığı + konu filtresi opsiyonel.
        else if (type === 'topic') {
            let data = records.filter(r => (r.type || 'complaint') === 'complaint');
            if (from || to) data = filterByRange(data, from, to);
            if (topic && topic !== 'All') data = data.filter(r => (r.topic || 'Genel') === topic);

            // Group by topic → counts + status + department breakdown.
            const grouped = {};
            data.forEach(r => {
                const t = (r.topic || 'Genel');
                if (!grouped[t]) grouped[t] = [];
                grouped[t].push(r);
            });
            const topicNames = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length || a.localeCompare(b, 'tr'));

            if (!data.length) { showToast('Bu rapor için veri yok.', true); return; }

            const rangeLabel = (from || to) ? `${from || '…'} → ${to || '…'}` : 'Tüm Zamanlar';
            const summaryTable = topicNames.map(t => {
                const arr = grouped[t];
                const solved = arr.filter(r => r.status === 'Solved').length;
                const open = arr.length - solved;
                const depts = [...new Set(arr.map(r => r.department || '—'))].join(', ');
                return { Konu: t, Toplam: arr.length, Çözüldü: solved, Açık: open, Departmanlar: depts };
            });

            if (format === 'excel') {
                const wb = XLSX.utils.book_new();
                const wsSum = XLSX.utils.json_to_sheet(summaryTable);
                autoSizeSheet(wsSum, summaryTable);
                XLSX.utils.book_append_sheet(wb, wsSum, 'Konu Özeti');
                const detail = data.map(r => ({
                    Konu: r.topic || 'Genel', Tarih: r.date, Oda: r.room, Misafir: r.guestName,
                    Departman: r.department, Şikayet: r.complaint, Çözüm: r.solution || '',
                    Personel: r.staffInitial, 'Üstlenen': reportWorker(r), Durum: statusLabelOf(r.status || 'Following')
                }));
                const wsDet = XLSX.utils.json_to_sheet(detail);
                autoSizeSheet(wsDet, detail);
                XLSX.utils.book_append_sheet(wb, wsDet, 'Detay');
                XLSX.writeFile(wb, `Konu_Bazli_${topic === 'All' ? 'Tum' : topic}_${getLocalDate()}.xlsx`);
                showToast('Excel raporu indirildi.');
            } else {
                const rows = summaryTable.map(s => [s.Konu, s.Toplam, s.Çözüldü, s.Açık, (s.Departmanlar || '').substring(0, 40)]);
                exportPDF(`Konu Bazlı Şikayet Raporu (${rangeLabel})`, ['Konu', 'Toplam', 'Çözüldü', 'Açık', 'Departmanlar'], rows, `Konu_Bazli_${topic === 'All' ? 'Tum' : topic}`);
            }
        }

        else if (type === 'byDate') {
            const date = specific || getLocalDate();
            const data = records.filter(r => r.date === date);
            if (format === 'excel') exportExcel(data.map(rowBase), `Issues_${date}`, date);
            else exportPDF(`Issues — ${date}`, ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Üstlenen', 'Status'],
                data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 40), r.staffInitial, reportWorker(r), r.status || 'Following']),
                `Issues_${date}`);
        }

        // ── Department performance: how fast each department responds,
        //    handles and completes its requests. Range optional (default all).
        else if (type === 'deptPerformance') {
            const data = (from || to) ? filterByRange(records, from, to) : records;
            const byDept = {};
            data.forEach(r => {
                const dept = canonicalDept(r.department) || 'Diğer';
                const d = byDept[dept] = byDept[dept] || { total: 0, done: 0, open: 0, resp: [], hand: [], tot: [] };
                d.total++;
                if (r.status === 'Solved') d.done++; else d.open++;
                const c = tsToDate(r.createdAt), a = tsToDate(r.acknowledgedAt), f = tsToDate(r.completedAt);
                if (c && a) d.resp.push((a - c) / 60000);
                if (a && f) d.hand.push((f - a) / 60000);
                if (c && f) d.tot.push((f - c) / 60000);
            });
            const avg = arr => arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : '';
            const rows = Object.entries(byDept).map(([dept, d]) => ({
                'Departman': dept,
                'Talep': d.total,
                'Tamamlanan': d.done,
                'Açık': d.open,
                'Ort. Yanıt (dk)': avg(d.resp),
                'Ort. İşlem (dk)': avg(d.hand),
                'Ort. Toplam (dk)': avg(d.tot)
            })).sort((a, b) => b['Talep'] - a['Talep']);
            const sub = (from && to) ? `${from} → ${to}` : 'Tüm zamanlar';
            if (format === 'excel') exportExcel(rows, `Departman_Performans_${from || 'tum'}_${to || 'zamanlar'}`, 'Performans');
            else exportPDF('Departman Performansı (Süreler)', ['Departman', 'Talep', 'Tamamlanan', 'Açık', 'Ort. Yanıt (dk)', 'Ort. İşlem (dk)', 'Ort. Toplam (dk)'],
                rows.map(r => Object.values(r)), 'Departman_Performans', sub);
        }

        // ── Per-request duration breakdown: every request with its
        //    created/taken/completed timestamps and computed durations.
        else if (type === 'taskDurations') {
            const data = (from || to) ? filterByRange(records, from, to) : records;
            const rows = data.map(r => {
                const c = tsToDate(r.createdAt), a = tsToDate(r.acknowledgedAt), f = tsToDate(r.completedAt);
                return {
                    'Tarih': r.date || '',
                    'Oda': r.room || '',
                    'Misafir': r.guestName || '',
                    'Departman': canonicalDept(r.department) || '',
                    'Durum': statusLabelOf(r.status),
                    'Oluşturma': fmtClock(c),
                    'İşleme Alınma': fmtClock(a),
                    'Tamamlanma': fmtClock(f),
                    'Yanıt (dk)': minutesBetween(r.createdAt, r.acknowledgedAt),
                    'İşlem (dk)': minutesBetween(r.acknowledgedAt, r.completedAt),
                    'Toplam (dk)': minutesBetween(r.createdAt, r.completedAt),
                    'Üstlenen': r.acknowledgedBy || '',
                    'Tamamlayan': r.completedBy || ''
                };
            });
            const sub = (from && to) ? `${from} → ${to}` : 'Tüm zamanlar';
            if (format === 'excel') exportExcel(rows, `Gorev_Sureleri_${from || 'tum'}_${to || 'zamanlar'}`, 'Süreler');
            else exportPDF('Görev Süreleri Dökümü',
                ['Tarih', 'Oda', 'Misafir', 'Departman', 'Durum', 'Yanıt (dk)', 'İşlem (dk)', 'Toplam (dk)'],
                data.map(r => [r.date || '', r.room || '', r.guestName || '', r.department || '', statusLabelOf(r.status),
                    String(minutesBetween(r.createdAt, r.acknowledgedAt)), String(minutesBetween(r.acknowledgedAt, r.completedAt)), String(minutesBetween(r.createdAt, r.completedAt))]),
                'Gorev_Sureleri', sub);
        }

        else if (type === 'dateRange') {
            if (!from || !to) return showToast('Başlangıç ve bitiş tarihlerini seçin.', true);
            const data = filterByRange(records, from, to);
            if (format === 'excel') exportExcel(data.map(rowBase), `Issues_${from}_to_${to}`, 'Date Range');
            else exportPDF(`Issues: ${from} → ${to}`, ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Üstlenen', 'Status'],
                data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 40), r.staffInitial, reportWorker(r), r.status || 'Following']),
                `DateRange_${from}_${to}`, `From: ${from}  To: ${to}`);
        }

        else if (type === 'guest') {
            let data = records;
            if (guest) data = records.filter(r => r.guestName && r.guestName.toLowerCase().includes(guest.toLowerCase()));

            const grouped = {};
            data.forEach(r => {
                const key = r.guestName || 'Unknown';
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(r);
            });
            if (format === 'excel') {
                const wb = XLSX.utils.book_new();
                const summary = Object.entries(grouped).map(([name, arr]) => ({
                    'Guest Name': name, Room: arr[0]?.room || '', 'Total Issues': arr.length,
                    Solved: arr.filter(r => r.status === 'Solved').length
                }));
                const wsSum = XLSX.utils.json_to_sheet(summary);
                const wsAll = XLSX.utils.json_to_sheet(data.map(rowBase));
                autoSizeSheet(wsSum, summary);
                autoSizeSheet(wsAll, data.map(rowBase));
                XLSX.utils.book_append_sheet(wb, wsSum, 'Guest Summary');
                XLSX.utils.book_append_sheet(wb, wsAll, 'All Records');
                XLSX.writeFile(wb, `By_Guest_${guest || 'All'}_${getLocalDate()}.xlsx`);
                showToast('Excel raporu indirildi.');
            } else {
                const rows = Object.entries(grouped).flatMap(([name, arr]) =>
                    arr.map(r => [name, r.room, r.date, r.department, r.complaint?.substring(0, 35), r.status || 'Following'])
                );
                exportPDF(`Issues by Guest: ${guest || 'All'}`, ['Guest Name', 'Room', 'Date', 'Department', 'Complaint', 'Status'], rows, `By_Guest_${guest || 'All'}`);
            }
        }

        else if (type === 'status') {
            const data = (from || to) ? filterByRange(records, from, to) : records;
            const solved = data.filter(r => r.status === 'Solved');
            const following = data.filter(r => r.status !== 'Solved');
            if (format === 'excel') {
                const wb = XLSX.utils.book_new();
                const wsFollow = XLSX.utils.json_to_sheet(following.map(rowBase));
                const wsSolved = XLSX.utils.json_to_sheet(solved.map(rowBase));
                autoSizeSheet(wsFollow, following.map(rowBase));
                autoSizeSheet(wsSolved, solved.map(rowBase));
                XLSX.utils.book_append_sheet(wb, wsFollow, 'Following');
                XLSX.utils.book_append_sheet(wb, wsSolved, 'Solved');
                XLSX.writeFile(wb, `By_Status_${getLocalDate()}.xlsx`);
                showToast('Excel raporu indirildi.');
            } else {
                const rows = data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 35), r.status || 'Following']);
                exportPDF('Issues by Status', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Status'], rows, 'By_Status',
                    `Total: ${data.length} | Solved: ${solved.length} | Following: ${following.length}`);
            }
        }

        else if (type === 'historicalStatus') {
            if (!from || !to) return showToast('Başlangıç ve bitiş tarihlerini seçin.', true);
            const data = filterByRange(records, from, to);
            // Group by date + status
            const dailyMap = {};
            data.forEach(r => {
                if (!dailyMap[r.date]) dailyMap[r.date] = { date: r.date, total: 0, solved: 0, following: 0, overdue: 0 };
                dailyMap[r.date].total++;
                if (r.status === 'Solved') dailyMap[r.date].solved++;
                else { dailyMap[r.date].following++; if (isOverdueFn(r)) dailyMap[r.date].overdue++; }
            });
            const dailyRows = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
            if (format === 'excel') {
                const wb = XLSX.utils.book_new();
                const summaryData = dailyRows.map(d => ({
                    Date: d.date, Total: d.total, Solved: d.solved, Following: d.following, Overdue: d.overdue
                }));
                const wsSum = XLSX.utils.json_to_sheet(summaryData);
                const wsDet = XLSX.utils.json_to_sheet(data.map(rowBase));
                autoSizeSheet(wsSum, summaryData);
                autoSizeSheet(wsDet, data.map(rowBase));
                XLSX.utils.book_append_sheet(wb, wsSum, 'Daily Summary');
                XLSX.utils.book_append_sheet(wb, wsDet, 'Detail');
                XLSX.writeFile(wb, `Historical_Status_${from}_${to}.xlsx`);
                showToast('Excel raporu indirildi.');
            } else {
                const rows = dailyRows.map(d => [d.date, d.total, d.solved, d.following, d.overdue]);
                exportPDF(`Historical + Status: ${from} → ${to}`, ['Date', 'Total', 'Solved', 'Following', 'Overdue'], rows,
                    `Historical_Status_${from}_${to}`);
            }
        }

        else if (type === 'deptHistorical') {
            let data = (from || to) ? filterByRange(records, from, to) : records;
            if (dept !== 'All') data = data.filter(r => sameDept(r.department, dept));

            const matrix = {};
            data.forEach(r => {
                const d = canonicalDept(r.department) || 'Unknown';
                if (!matrix[d]) matrix[d] = {};
                if (!matrix[d][r.date]) matrix[d][r.date] = 0;
                matrix[d][r.date]++;
            });
            const allDates = [...new Set(data.map(r => r.date))].sort();
            if (format === 'excel') {
                const sheetRows = Object.entries(matrix).map(([d, dates]) => {
                    const row = { Department: d };
                    allDates.forEach(dt => row[dt] = dates[dt] || 0);
                    row['Total'] = Object.values(dates).reduce((a, b) => a + b, 0);
                    return row;
                });
                exportExcel(sheetRows, `Dept_Historical_${dept}_${getLocalDate()}`, 'Dept vs Date');
            } else {
                const rows = Object.entries(matrix).map(([d, dates]) => [d, ...allDates.map(dt => dates[dt] || 0), Object.values(dates).reduce((a, b) => a + b, 0)]);
                exportPDF(`Department × Historical (${dept})`, ['Department', ...allDates, 'Total'], rows, `Dept_Historical_${dept}`);
            }
        }

        else if (type === 'currentView') {
            if (lastRenderedRows.length === 0) return showToast('Dışa aktarılacak görünür kayıt yok.', true);
            if (format === 'excel') exportExcel(lastRenderedRows.map(rowBase), 'Current_View', 'Filtered');
            else {
                const rows = lastRenderedRows.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 40), r.staffInitial, reportWorker(r), r.status || 'Following']);
                exportPDF('Current Filtered View', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Üstlenen', 'Status'], rows, 'Current_View');
            }
        }

        else if (type === 'fullArchive') {
            if (format === 'excel') exportExcel(records.map(rowBase), 'Full_Archive', 'Archive');
            else {
                const rows = records.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 35), r.staffInitial, reportWorker(r), r.status || 'Following']);
                exportPDF('Full Archive — All Records', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Üstlenen', 'Status'], rows, 'Full_Archive',
                    `Total Records: ${records.length}`);
            }
        }
    };

    // ── SLA / gecikme ──────────────────────────────────────────
    const DEFAULT_SLA_MIN = 15;
    function slaOf(record) {
        const m = window.IssueConfig ? IssueConfig.slaFor(record.department) : null;
        return (m && m > 0) ? m : DEFAULT_SLA_MIN;
    }
    // { state:'ok'|'soon'|'breached', remaining (dk; negatif=aşıldı), elapsedMin, sla }
    function slaState(record) {
        const created = tsToDate(record.createdAt);
        const sla = slaOf(record);
        if (!created || (record.status || 'Following') === 'Solved') return { state: 'ok', remaining: null, elapsedMin: 0, sla };
        const elapsed = (Date.now() - created.getTime()) / 60000;
        let state = 'ok';
        if (elapsed >= sla) state = 'breached';
        else if (elapsed >= sla * 0.8) state = 'soon';
        return { state: state, remaining: sla - elapsed, elapsedMin: elapsed, sla: sla };
    }
    function isOverdueFn(record) { return slaState(record).state === 'breached'; }

    // ── Eskalasyon (istemci tarafı; çift bildirim için transaction guard) ──
    // Tek paylaşımlı personel önbelleği (5 dk): getManagers ve
    // notifyRequestTeam önceden aynı systemUsers koleksiyonunu ayrı ayrı,
    // her bildirimde baştan okuyordu (bkz. hız denetimi).
    let staffCache = null, staffCacheAt = 0;
    async function getStaff() {
        if (staffCache && Date.now() - staffCacheAt < 300000) return staffCache; // 5 dk cache
        try {
            const snap = await db.collection('systemUsers').where('tenantId', '==', TENANT_ID).get();
            staffCache = snap.docs.map(d => ({
                uid: d.id,
                username: (d.data().username || d.id),
                role: (d.data().role || '').toLowerCase(),
                department: ((d.data().department || '')).trim().toLowerCase()
            }));
            staffCacheAt = Date.now();
        } catch (e) { staffCache = staffCache || []; }
        return staffCache;
    }
    async function getManagers() {
        return (await getStaff()).filter(u => u.role === 'admin' || u.role === 'manager');
    }
    // Talebi departmanına göre yönlendir: department alanı eşleşen tüm
    // kullanıcılara (+ açıkça atanan kişiye) bildirim gönder. Kendine bildirmez.
    async function notifyRequestTeam(record, recordId, assignee) {
        const dept = (record.department || '').trim().toLowerCase();
        const me = (firebase.auth().currentUser || {}).uid;
        const recips = {}; // uid -> username
        try {
            // sameDept: "Food & Beverage" (eski F&B departman adı) ile kanonik
            // "Yiyecek & İçecek" aynı departman sayılır — aksi halde legacy
            // isimle kayıtlı bir F&B personeli yeni kayıtlar için bildirim
            // ALAMAZDI.
            const staff = await getStaff();
            // Vardiya kontrolü etkinse: yönetici/admin muaf, diğer personelden
            // yalnızca KANITLANMIŞ şekilde otel dışında olanlar (onShift===false)
            // bildirim listesine hiç girmez — kayıt yok/izin yok durumunda
            // (fail-open) normal şekilde bildirim alır.
            const shiftOn = shiftControlActive();
            const presenceMap = shiftOn ? await getPresenceMap() : null;
            staff.forEach(u => {
                if (!(dept && sameDept(u.department, dept))) return;
                if (shiftOn && u.role !== 'admin' && u.role !== 'manager' && !isUidOnShift(u.uid, presenceMap)) return;
                recips[u.uid] = u.username;
            });
        } catch (e) { /* yine de atanan kişiye gider */ }
        if (assignee && assignee.uid) recips[assignee.uid] = assignee.username || recips[assignee.uid] || assignee.uid;
        if (me) delete recips[me];
        const isCmp = record.type === 'complaint';
        const title = (isCmp ? '⚠️ Yeni şikayet: ' : 'Yeni talep: ') + (record.department || '');
        const body = `Oda ${record.room || '—'} · ${record.guestName || ''} — ${(record.complaint || '').slice(0, 80)}`;
        Object.keys(recips).forEach(uid => {
            if (window.RT) RT.sendNotification({ toUid: uid, toUsername: recips[uid], type: isCmp ? 'complaint' : 'request', title: title, body: body, recordId: recordId }).catch(() => {});
        });
    }
    async function escalateRecord(record, reason) {
        const ref = db.collection('guestLogs').doc(record.id);
        let didFlip = false;
        try {
            await db.runTransaction(async tx => {
                const snap = await tx.get(ref);
                if (!snap.exists) return;
                const d = snap.data();
                if (d.status === 'Solved' || d.escalated === true) return; // başka istemci çevirmiş
                tx.update(ref, {
                    escalated: true,
                    escalatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    escalatedReason: reason || 'sla'
                });
                didFlip = true;
            });
        } catch (e) { return false; }
        if (!didFlip) return false;            // yalnız flag'i çeviren istemci bildirir
        record.escalated = true;               // optimistik
        const mgrs = await getManagers();
        const me = (firebase.auth().currentUser || {}).uid;
        mgrs.filter(m => m.uid !== me).forEach(m => {
            if (window.RT) RT.sendNotification({
                toUid: m.uid, toUsername: m.username, type: 'complaint',
                title: 'SLA aşımı: ' + (record.department || ''),
                body: `Oda ${record.room || '—'} · ${record.guestName || ''} — ${slaOf(record)} dk SLA aşıldı`,
                recordId: record.id
            }).catch(() => {});
        });
        return true;
    }
    let sweeping = false;
    async function autoEscalateSweep() {
        if (sweeping) return; sweeping = true;
        try {
            const due = records.filter(r => (r.status || 'Following') !== 'Solved' && r.escalated !== true && slaState(r).state === 'breached');
            for (const r of due) { await escalateRecord(r, 'sla'); }
        } finally { sweeping = false; }
    }

    // ── Performans paneli (kütüphanesiz CSS bar grafik) ────────
    function perfAvg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }
    function computePerformance(data) {
        const byDept = {}, byStaff = {};
        data.forEach(r => {
            const dept = canonicalDept(r.department) || 'Diğer';
            const d = byDept[dept] = byDept[dept] || { total: 0, done: 0, open: 0, resp: [], hand: [], breach: 0, slaMet: 0, slaEval: 0 };
            d.total++;
            const solved = (r.status === 'Solved');
            if (solved) d.done++; else d.open++;
            const c = tsToDate(r.createdAt), a = tsToDate(r.acknowledgedAt), f = tsToDate(r.completedAt);
            if (c && a) d.resp.push((a - c) / 60000);
            if (a && f) d.hand.push((f - a) / 60000);
            if (solved && c && f) { d.slaEval++; if ((f - c) / 60000 <= slaOf(r)) d.slaMet++; }
            const overBreach = solved ? (c && f && (f - c) / 60000 > slaOf(r)) : (slaState(r).state === 'breached');
            if (overBreach) d.breach++;
            const who = r.completedBy || r.acknowledgedBy;
            if (who) { const s = byStaff[who] = byStaff[who] || { handled: 0, hand: [] }; s.handled++; if (a && f) s.hand.push((f - a) / 60000); }
        });
        return { byDept, byStaff };
    }
    function perfBarRow(label, val, max, meta, sub) {
        const w = Math.round(val / max * 100);
        return `<div class="perf-row"><span class="perf-label" title="${esc(label)}">${esc(label)}</span><span class="perf-bar"><i style="width:${w}%"></i></span><span class="perf-val">${esc(val)}</span></div>`
            + (meta ? `<div class="perf-meta">${meta}</div>` : '') + (sub || '');
    }
    function renderPerf() {
        const from = document.getElementById('perfFrom').value, to = document.getElementById('perfTo').value;
        const data = (from || to) ? filterByRange(records, from, to) : records;
        const { byDept, byStaff } = computePerformance(data);
        const drows = Object.entries(byDept).map(([k, d]) => ({
            dept: k, total: d.total, open: d.open, done: d.done, resp: perfAvg(d.resp), hand: perfAvg(d.hand),
            slaPct: d.slaEval ? Math.round(d.slaMet / d.slaEval * 100) : null, breach: d.breach
        })).sort((a, b) => b.total - a.total);
        const maxT = Math.max(1, ...drows.map(r => r.total));
        document.getElementById('perfDeptChart').innerHTML = drows.length ? drows.map(r => {
            const slaSub = r.slaPct != null ? `<div class="perf-row sub"><span class="perf-label">SLA uyumu</span><span class="perf-bar sla"><i style="width:${r.slaPct}%"></i></span><span class="perf-val">%${r.slaPct}</span></div>` : '';
            const meta = `Açık ${r.open} · Çözülen ${r.done}` + (r.resp != null ? ` · Ort. yanıt ${r.resp} dk` : '') + (r.hand != null ? ` · işlem ${r.hand} dk` : '') + (r.breach ? ` · <span class="perf-breach">${r.breach} SLA aşımı</span>` : '');
            return perfBarRow(r.dept, r.total, maxT, meta, slaSub);
        }).join('') : '<div class="perf-empty">Bu aralıkta kayıt yok.</div>';
        const srows = Object.entries(byStaff).map(([k, s]) => ({ name: k, handled: s.handled, hand: perfAvg(s.hand) })).sort((a, b) => b.handled - a.handled);
        const maxH = Math.max(1, ...srows.map(s => s.handled));
        document.getElementById('perfStaffChart').innerHTML = srows.length ? srows.map(s => perfBarRow(s.name, s.handled, maxH, s.hand != null ? `Ort. işlem ${s.hand} dk` : '')).join('') : '<div class="perf-empty">Kayıt yok.</div>';
    }
    async function openPerf() {
        const m = document.getElementById('perfModal'); if (!m) return;
        m.style.display = 'flex';
        if (!fullyLoaded) await ensureFullArchive(); // performans tüm arşiv üzerinden hesaplanır
        renderPerf();
    }
    (function wirePerf() {
        const canSee = isAdminUser || loggedRole === 'manager';
        const btn = document.getElementById('openPerfBtn');
        if (btn && canSee) { btn.style.display = ''; btn.addEventListener('click', openPerf); }
        const close = document.getElementById('closePerfModal');
        if (close) close.addEventListener('click', () => { document.getElementById('perfModal').style.display = 'none'; });
        ['perfFrom', 'perfTo'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('change', renderPerf); });
        const clr = document.getElementById('perfClear');
        if (clr) clr.addEventListener('click', () => { document.getElementById('perfFrom').value = ''; document.getElementById('perfTo').value = ''; renderPerf(); });
        const modal = document.getElementById('perfModal');
        if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    })();

    const triggerSearch = () => updateView(globalSearch.value, dateSearch.value);
    globalSearch.addEventListener('input', triggerSearch);
    // Seçilen tarih canlı pencereden (90 gün) eski ve arşiv henüz yüklenmediyse,
    // o tarihin kayıtlarını gösterebilmek için tüm arşivi yükle.
    async function ensureArchiveForDate(iso) {
        if (fullyLoaded || !iso) return;
        const cutoffIso = giDateToIso(new Date(Date.now() - WINDOW_DAYS * 86400000));
        if (iso < cutoffIso) { showToast('Arşiv yükleniyor…'); await ensureFullArchive(); }
    }
    dateSearch.addEventListener('change', async () => { await ensureArchiveForDate(dateSearch.value); triggerSearch(); });

    let activeStatusFilter = null;
    function setActivePill(id) {
        document.querySelectorAll('.gi-pill').forEach(p => p.classList.toggle('active', p.id === id));
    }
    document.getElementById('filterTotal').addEventListener('click', () => { activeStatusFilter = null; setActivePill('filterTotal'); triggerSearch(); });
    document.getElementById('filterFollowing').addEventListener('click', () => { activeStatusFilter = 'Following'; setActivePill('filterFollowing'); triggerSearch(); });
    document.getElementById('filterInProgress')?.addEventListener('click', () => { activeStatusFilter = 'InProgress'; setActivePill('filterInProgress'); triggerSearch(); });
    document.getElementById('filterSolved').addEventListener('click', () => { activeStatusFilter = 'Solved'; setActivePill('filterSolved'); triggerSearch(); });
    document.getElementById('filterOverdue').addEventListener('click', () => { activeStatusFilter = 'Overdue'; setActivePill('filterOverdue'); triggerSearch(); });
    document.getElementById('filterMine')?.addEventListener('click', () => { activeStatusFilter = 'Mine'; setActivePill('filterMine'); triggerSearch(); });

    // Refresh elapsed-time chips and overdue states every minute while visible;
    // ayrıca SLA aşan kayıtları otomatik eskale et.
    setInterval(() => { if (!document.hidden) { triggerSearch(); autoEscalateSweep(); } }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoEscalateSweep(); });

    // "Tüm Zamanlar": clear the date filter so every record is listed.
    // Gerçekten tüm kayıtlar listelenmeli; canlı pencere dışındaki eski kayıtlar
    // için tüm arşivi yükle.
    document.getElementById('allTimeBtn')?.addEventListener('click', async () => {
        dateSearch.value = '';
        if (!fullyLoaded) { showToast('Arşiv yükleniyor…'); await ensureFullArchive(); }
        triggerSearch();
    });

    resetFilters.addEventListener('click', () => {
        globalSearch.value = '';
        dateSearch.value = getLocalDate();
        activeStatusFilter = null;
        document.querySelectorAll('.gi-pill').forEach(p => p.classList.toggle('active', p.id === 'filterTotal'));
        updateView(globalSearch.value, dateSearch.value);
    });

    // ═══ Console: month calendar (left) + "Bugün" header button ═══
    let giCalCursor = null; // Date of the month currently shown in the sidebar
    const giIsoToDate = (iso) => { const p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
    const giDateToIso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    function giRenderCalendar() {
        const grid = document.getElementById('giCalGrid');
        const title = document.getElementById('giCalTitle');
        if (!grid || !title) return;
        const todayIso = getLocalDate();
        const selIso = dateSearch.value;
        if (!giCalCursor) giCalCursor = selIso ? giIsoToDate(selIso) : new Date();
        const y = giCalCursor.getFullYear(), m = giCalCursor.getMonth();
        title.textContent = giCalCursor.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });

        const marked = new Set();
        records.forEach(r => { if (r.date) marked.add(r.date); });

        const first = new Date(y, m, 1);
        const startOffset = (first.getDay() + 6) % 7; // Monday-first
        const start = new Date(y, m, 1 - startOffset);
        const cells = [];
        for (let i = 0; i < 42; i++) cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
        const rows = cells.slice(35).every(d => d.getMonth() !== m) ? cells.slice(0, 35) : cells;

        grid.innerHTML = rows.map(d => {
            const iso = giDateToIso(d);
            const cls = ['cz-day'];
            if (d.getMonth() !== m) cls.push('dim');
            if (iso === todayIso) cls.push('today');
            if (iso === selIso) cls.push('sel');
            return `<button class="${cls.join(' ')}" data-iso="${iso}">${d.getDate()}${marked.has(iso) ? '<span class="dot"></span>' : ''}</button>`;
        }).join('');
    }
    document.getElementById('giCalGrid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.cz-day');
        if (!btn) return;
        giCalCursor = giIsoToDate(btn.dataset.iso);
        dateSearch.value = btn.dataset.iso;
        ensureArchiveForDate(btn.dataset.iso).then(triggerSearch);
    });
    document.getElementById('giCalPrev')?.addEventListener('click', () => {
        giCalCursor = new Date(giCalCursor.getFullYear(), giCalCursor.getMonth() - 1, 1);
        giRenderCalendar();
    });
    document.getElementById('giCalNext')?.addEventListener('click', () => {
        giCalCursor = new Date(giCalCursor.getFullYear(), giCalCursor.getMonth() + 1, 1);
        giRenderCalendar();
    });
    function giGoToday() {
        giCalCursor = new Date();
        dateSearch.value = getLocalDate();
        triggerSearch();
    }
    document.getElementById('giGoToday')?.addEventListener('click', giGoToday);
    document.getElementById('giGoTodaySide')?.addEventListener('click', giGoToday);

    // Right panel: per-day summary + global overdue list.
    function giRenderSummary(stats) {
        const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        set('sumTotal', stats.total); set('sumPending', stats.following);
        set('sumProg', stats.inprogress); set('sumSolved', stats.solved); set('sumOverdue', stats.overdue);

        const box = document.getElementById('giOverdueList');
        if (!box) return;
        const od = records
            .filter(r => (r.status || 'Following') !== 'Solved' && isOverdue(r))
            .sort((a, b) => {
                const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
                const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
                return ta - tb; // oldest (most overdue) first
            }).slice(0, 6);
        if (!od.length) { box.innerHTML = '<div class="gi-od-empty">Geciken iş yok 🎉</div>'; return; }
        box.innerHTML = od.map(r => {
            const created = tsToDate(r.createdAt);
            const dur = created ? fmtDuration(Date.now() - created) : '';
            return `<div class="gi-od-item" data-id="${esc(r.id)}">
                <b>${esc(r.guestName)} · Oda ${esc(r.room)}</b>
                <div class="gi-od-meta"><span>${esc(r.department || '')}</span><span class="gi-od-dur">⌛ ${dur}</span></div>
            </div>`;
        }).join('');
        box.querySelectorAll('.gi-od-item').forEach(it => it.addEventListener('click', () => {
            const rec = records.find(r => r.id === it.dataset.id);
            if (rec) openModal(rec);
        }));
    }

    // Guest Profiles Modal Logic
    const guestProfileModal = document.getElementById('guestProfileModal');
    const closeProfileModal = document.getElementById('closeProfileModal');
    const profileSearchInput = document.getElementById('profileSearchInput');
    const guestProfileList = document.getElementById('guestProfileList');
    const statusPills = document.querySelectorAll('.status-pill');

    let currentProfileFilter = 'all';

    document.getElementById('guestProfilesBtn')?.addEventListener('click', () => {
        profileSearchInput.value = '';
        currentProfileFilter = 'all';
        statusPills.forEach(p => p.classList.toggle('active', p.dataset.filter === 'all'));
        renderGuestProfileList();
        guestProfileModal.style.display = 'flex';
    });

    closeProfileModal?.addEventListener('click', () => {
        guestProfileModal.style.display = 'none';
    });

    statusPills.forEach(pill => {
        pill.addEventListener('click', () => {
            statusPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentProfileFilter = pill.dataset.filter;
            renderGuestProfileList();
        });
    });

    profileSearchInput?.addEventListener('input', renderGuestProfileList);

    function renderGuestProfileList() {
        if (!guestProfileList) return;
        const search = profileSearchInput.value.toLowerCase();

        let filtered = guestDirectory.filter(g => {
            const matchesSearch = g.name.toLowerCase().includes(search) || (g.room && g.room.includes(search));
            const matchesStatus = currentProfileFilter === 'all' || g.status === currentProfileFilter;
            return matchesSearch && matchesStatus;
        });

        guestProfileList.innerHTML = '';
        if (filtered.length === 0) {
            guestProfileList.innerHTML = '<p style="padding:20px; text-align:center; color:#888;">Misafir bulunamadı.</p>';
            return;
        }

        filtered.forEach(guest => {
            const item = document.createElement('div');
            item.className = 'guest-profile-item';
            item.style = `
                display: flex; justify-content: space-between; align-items: center; 
                padding: 12px 15px; border-bottom: 1px solid #f0f0f0; transition: background 0.2s;
            `;

            const isInHouse = guest.status === 'in_house';

            item.innerHTML = `
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: #333;">${esc(guest.name)}</div>
                    <div style="font-size: 12px; color: #888;">Oda: ${esc(guest.room || '—')} • <span style="color:${isInHouse ? '#27ae60' : '#7f8c8d'}; font-weight:700;">${isInHouse ? 'OTELDE' : 'ÇIKIŞ YAPTI'}</span></div>
                </div>
                <button onclick="toggleGuestStatus('${guest.id}', '${guest.status === 'in_house' ? 'checked_out' : 'in_house'}')"
                        style="padding: 6px 12px; border-radius: 4px; border: none; font-size: 11px; font-weight: 700; cursor: pointer; 
                               background: ${isInHouse ? '#fef2f2' : '#f0fdf4'}; color: ${isInHouse ? '#991b1b' : '#166534'};">
                    ${isInHouse ? 'ÇIKIŞ VER' : 'OTELDE İŞARETLE'}
                </button>
            `;
            guestProfileList.appendChild(item);
        });
    }

    window.toggleGuestStatus = async (guestId, newStatus) => {
        try {
            await db.collection('guestDirectory').doc(guestId).update({
                status: newStatus,
                lastUpdated: new Date().toISOString()
            });
            // Update local state
            const idx = guestDirectory.findIndex(g => g.id === guestId);
            if (idx !== -1) guestDirectory[idx].status = newStatus;
            renderGuestProfileList();
            updateView(globalSearch.value, dateSearch.value); // Refresh table badges
            showToast('Misafir durumu güncellendi');
        } catch (e) { showToast('Güncelleme başarısız', true); }
    };

    profileSearchInput?.addEventListener('input', renderGuestProfileList);

    window.selectGuestProfile = async function (name) {
        guestProfileModal.style.display = 'none';
        globalSearch.value = name;
        dateSearch.value = ''; // clear date to show all history
        activeStatusFilter = null;
        if (!fullyLoaded) { showToast('Arşiv yükleniyor…'); await ensureFullArchive(); } // misafirin tüm geçmişi
        triggerSearch();
    };


    // 3. View Logic
    function formatDateShort(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const options = { day: '2-digit', month: 'short', year: '2-digit' };
        return date.toLocaleDateString('en-GB', options).replace(/ /g, ' ');
    }

    // Helper: SLA aşıldı mı (departman SLA'sına göre)
    function isOverdue(record) { return slaState(record).state === 'breached'; }

    // ── Recurring-issue detection ──────────────────────────────
    // Flags repeat problems: same room + same department logged 2+ times
    // within a 7-day window. Returns the OTHER related records (excl. self),
    // most recent first.
    const RECUR_WINDOW_DAYS = 7;
    function parseDateStr(s) {
        if (!s) return null;
        const p = String(s).split('-');
        if (p.length === 3) { const d = new Date(+p[0], +p[1] - 1, +p[2]); return isNaN(d) ? null : d; }
        const d = new Date(s); return isNaN(d) ? null : d;
    }
    // "Tekrarlayan sorun" applies to COMPLAINTS only — a guest re-requesting a
    // service (talep) isn't a recurring problem. Matches the same room +
    // department + topic so distinct issues in one room aren't merged.
    //
    // recurringRelated() eskiden HER satır için tüm `records` dizisini baştan
    // tarıyordu (O(n²) — render listesindeki her kayıt × tüm kayıtlar).
    // buildRecurringIndex() bunu bir kez (room|dept|topic) anahtarına göre
    // grupluyor; updateView()'daki render döngüsü bu index'i geçirerek her
    // satırda yalnızca kendi (çok daha küçük) grubunu tarar.
    function buildRecurringIndex(all) {
        const idx = new Map();
        (all || []).forEach(r => {
            if ((r.type || 'complaint') !== 'complaint') return;
            const room = String(r.room || '').trim().toLowerCase();
            if (!room) return;
            const key = room + '|' + (r.department || '').toLowerCase() + '|' + (r.topic || '').toLowerCase();
            if (!idx.has(key)) idx.set(key, []);
            idx.get(key).push(r);
        });
        return idx;
    }
    function recurringRelated(record, idx) {
        if (!record || !record.room) return [];
        if ((record.type || 'complaint') !== 'complaint') return [];
        const rd = parseDateStr(record.date);
        if (!rd) return [];
        const room = String(record.room).trim().toLowerCase();
        const dept = (record.department || '').toLowerCase();
        const topic = (record.topic || '').toLowerCase();
        const key = room + '|' + dept + '|' + topic;
        const bucket = (idx || buildRecurringIndex(records)).get(key) || [];
        return bucket
            .filter(r => r.id !== record.id)
            .filter(r => { const od = parseDateStr(r.date); return od && Math.abs((rd - od) / 86400000) <= RECUR_WINDOW_DAYS; })
            .sort((a, b) => (parseDateStr(b.date) || 0) - (parseDateStr(a.date) || 0));
    }

    function updateView(textFilter = '', dateFilter = '') {
        recordsTableBody.innerHTML = '';
        const lowerText = textFilter.toLowerCase();
        let stats = { total: 0, following: 0, inprogress: 0, solved: 0, overdue: 0, mine: 0 };

        const tableTitle = document.getElementById('tableTitle');
        if (tableTitle) {
            if (dateFilter) {
                const today = getLocalDate();
                tableTitle.textContent = (dateFilter === today) ? 'Bugünün Kayıtları' : formatDateShort(dateFilter) + ' Kayıtları';
            } else {
                tableTitle.textContent = 'Tüm Kayıtlar';
            }
        }

        const filtered = records.filter(r => {
            const matchesText = !textFilter || [r.guestName, r.room, r.department, r.staffInitial, r.status]
                .some(field => field && field.toLowerCase().includes(lowerText));
            const matchesDate = !dateFilter || r.date === dateFilter;
            return matchesText && matchesDate;
        });

        filtered.forEach(record => {
            stats.total++;
            const status = record.status || 'Following';
            if (status === 'Solved') stats.solved++;
            else {
                if (status === 'InProgress') stats.inprogress++;
                else stats.following++;
                if (isOverdue(record)) stats.overdue++;
                if (isMineRecord(record)) stats.mine++;
            }
        });

        const finalFiltered = filtered.filter(r => {
            if (!activeStatusFilter) return true;
            if (activeStatusFilter === 'Overdue') return r.status !== 'Solved' && isOverdue(r);
            if (activeStatusFilter === 'Mine') return r.status !== 'Solved' && isMineRecord(r);
            return (r.status || 'Following') === activeStatusFilter;
        });

        lastRenderedRows = finalFiltered;

        if (!finalFiltered.length) {
            recordsTableBody.innerHTML = `
                <tr class="gi-empty-row"><td colspan="7">
                    <div class="gi-empty">
                        <span class="gi-empty-ico">🛎️</span>
                        <span>Kayıt bulunamadı</span>
                    </div>
                </td></tr>`;
        }

        const now = Date.now();
        const recurIdx = buildRecurringIndex(records);
        finalFiltered.forEach(record => {
            const status = record.status || 'Following';
            const statusClass = status.toLowerCase();
            const statusLabel = statusLabelOf(status);
            const noteCount = record.updates ? record.updates.length : 0;
            const noteIndicator = noteCount > 0 ? `<span class="note-indicator" title="${noteCount} güncelleme">💬 ${noteCount}</span>` : '';
            const ss = slaState(record);
            const lateBadgeStatus = status !== 'Solved' && ss.state === 'breached';
            let lateBadge = '';
            if (status !== 'Solved') {
                if (ss.state === 'breached') lateBadge = `<span class="late-warning" title="SLA (${ss.sla} dk) aşıldı">⚠️ Gecikti · ${Math.round(-ss.remaining)}dk</span>`;
                else if (ss.state === 'soon') lateBadge = `<span class="sla-soon" title="SLA (${ss.sla} dk) yaklaşıyor">⏳ ${Math.max(0, Math.round(ss.remaining))}dk kaldı</span>`;
            }
            const escBadge = record.escalated === true ? '<span class="esc-badge" title="Yöneticiye eskale edildi">🚨 Eskale</span>' : '';

            const gStatus = getGuestStatus(record.guestName);
            const gStatusLabel = gStatus === 'in_house' ? 'OTELDE' : 'ÇIKIŞ YAPTI';
            const gStatusClass = gStatus === 'in_house' ? 'in-house-badge' : 'checked-out-badge';

            const recurCount = recurringRelated(record, recurIdx).length;
            const recurBadge = recurCount >= 1
                ? `<span class="recurring-badge" title="Bu odada son ${RECUR_WINDOW_DAYS} günde aynı departmanda ${recurCount + 1} kayıt">🔁 Tekrarlayan</span>`
                : '';

            // Duration cell: final total for completed work, live elapsed otherwise.
            const created = tsToDate(record.createdAt);
            const acked = tsToDate(record.acknowledgedAt);
            const done = tsToDate(record.completedAt);
            let durHtml = '<span class="dur-chip dur-none">—</span>';
            if (status === 'Solved') {
                if (created && done) durHtml = `<span class="dur-chip dur-done" title="Oluşturmadan tamamlanmaya toplam süre">✓ ${fmtDuration(done - created)}</span>`;
            } else if (status === 'InProgress' && acked) {
                durHtml = `<span class="dur-chip dur-active" title="İş üstlenileli geçen süre">⏱ ${fmtDuration(now - acked)}</span>`;
            } else if (created) {
                durHtml = `<span class="dur-chip dur-wait" title="Talep oluşturulalı geçen süre">⌛ ${fmtDuration(now - created)}</span>`;
            }

            // Mobil kartlarda tek dokunuşla iş akışı: bekleyen kaydı kendi
            // departmanının personeli (veya yönetici) modal açmadan üstlenir;
            // işlemdeki kaydı YALNIZ üstlenen personel veya yönetici tamamlar.
            // Masaüstünde bu hücre hiç görünmez.
            let quickAct = '';
            if (status === 'Following' && canTakeRecord(record)) {
                quickAct = `<button class="qa-btn take" data-qa="take">🔧 İşi Üstlen</button>`;
            } else if (status === 'InProgress' && canCompleteRecord(record)) {
                quickAct = `<button class="qa-btn complete" data-qa="complete">✓ Tamamlandı</button>`;
            }
            // Üstlenilmiş iş her ekranda sahibiyle görünür — iş karışıklığı önlenir.
            const ownerBadge = (status === 'InProgress' && record.acknowledgedBy)
                ? `<span class="owner-badge">🔧 ${esc(record.acknowledgedBy)} üstlendi</span>` : '';

            const row = document.createElement('tr');
            row.classList.add('st-' + statusClass); // mobil kartta sol durum şeridi
            if (lateBadgeStatus) row.classList.add('urgent-row');

            row.innerHTML = `
                <td class="date-cell">${formatDateShort(record.date)}</td>
                <td class="room-cell"><span>${esc(record.room)}</span></td>
                <td class="guest-cell">
                    <div style="display:flex; flex-direction:column;">
                        <strong>${esc(record.guestName)}${record.type === 'request' ? '<span class="req-type-badge">TALEP</span>' : ''} ${noteIndicator}</strong>
                        <span class="${gStatusClass}" style="font-size:9px; font-weight:800; width:fit-content; margin-top:2px;">${gStatusLabel}</span>
                        ${record.type === 'request' && record.assignedToName ? `<span style="font-size:10px;color:var(--primary);font-weight:600;margin-top:2px;">↳ ${esc(record.assignedToName)}</span>` : ''}
                        ${ownerBadge}
                    </div>
                    ${recurBadge}
                    ${lateBadge}
                    ${escBadge}
                </td>
                <td><span class="dept-badge">${esc(record.department)}</span></td>
                <td class="staff-cell">${esc(record.staffInitial)}</td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                <td class="dur-cell">${durHtml}</td>
                <td class="act-cell">${quickAct}</td>
            `;
            row.onclick = () => openModal(record);
            const qa = row.querySelector('[data-qa]');
            if (qa) qa.onclick = (e) => { e.stopPropagation(); quickTransition(record, qa.dataset.qa, qa); };
            recordsTableBody.appendChild(row);
        });

        // Update Stats Dashboard UI
        if (document.getElementById('statTotal')) document.getElementById('statTotal').textContent = stats.total;
        if (document.getElementById('statFollowing')) document.getElementById('statFollowing').textContent = stats.following;
        if (document.getElementById('statInProgress')) document.getElementById('statInProgress').textContent = stats.inprogress;
        if (document.getElementById('statSolved')) document.getElementById('statSolved').textContent = stats.solved;
        if (document.getElementById('statOverdue')) document.getElementById('statOverdue').textContent = stats.overdue;
        if (document.getElementById('statMine')) document.getElementById('statMine').textContent = stats.mine;

        recordCountElement.textContent = finalFiltered.length;

        // Console chrome: sidebar calendar (dots + selected day) and the
        // right-hand day summary + overdue list.
        if (typeof giRenderCalendar === 'function') giRenderCalendar();
        if (typeof giRenderSummary === 'function') giRenderSummary(stats);
    }

    function openModal(record) {
        selectedRecord = record;
        editingId = record.id;
        modalGuestRoom.textContent = `${record.guestName} - Oda ${record.room}`;
        modalDept.textContent = record.department + ((record.topic && record.topic !== 'Genel') ? ' · ' + record.topic : '');
        if (record.type === 'request') {
            modalDesc.innerHTML = `<strong>Talep:</strong> ${esc(record.complaint)}`
                + (record.assignedToName ? `<br><strong>Atanan:</strong> ${esc(record.assignedToName)}` : '');
        } else {
            modalDesc.innerHTML = `<strong>Şikayet:</strong> ${esc(record.complaint)}<br><strong>Çözüm:</strong> ${esc(record.solution)}`;
        }

        // Recurring-issue panel: prior records for the same room+department.
        const related = recurringRelated(record);
        if (related.length >= 1) {
            const items = related.slice(0, 6).map(r => {
                const st = statusLabelOf(r.status);
                return `<div class="recur-item">
                    <span class="recur-date">${formatDateShort(r.date)}</span>
                    <span class="recur-text">${esc((r.complaint || '').slice(0, 60) || '—')}</span>
                    <span class="recur-status ${(r.status || 'Following').toLowerCase()}">${st}</span>
                </div>`;
            }).join('');
            modalDesc.innerHTML += `
                <div class="recur-box">
                    <div class="recur-head">🔁 Tekrarlayan sorun · ${esc(record.room)} · ${esc(record.department)}${(record.topic && record.topic !== 'Genel') ? ' · ' + esc(record.topic) : ''}
                        <span class="recur-count">son ${RECUR_WINDOW_DAYS} günde ${related.length + 1} kayıt</span></div>
                    ${items}
                </div>`;
        }

        updateStatusBadge(record.status || 'Following');
        renderTimeline(record);
        renderWorkflow(record);

        modalViewMode.style.display = 'block';
        modalEditForm.style.display = 'none';
        modal.style.display = 'flex';

        // Bind workflow transition buttons
        document.getElementById('wfTakeBtn').onclick = () => transitionRecord('take');
        document.getElementById('wfCompleteBtn').onclick = () => transitionRecord('complete');
        document.getElementById('wfReopenBtn').onclick = () => transitionRecord('reopen');
        const escBtn = document.getElementById('wfEscalateBtn');
        if (escBtn) escBtn.onclick = () => {
            escalateRecord(record, 'manual').then(ok => {
                if (ok) { record.escalated = true; renderWorkflow(record); showToast('Yöneticiye eskale edildi.'); }
                else showToast('Zaten eskale edilmiş veya çözülmüş.', true);
            });
        };

        document.getElementById('emailModalBtn').onclick = () => draftEmail(record);
        document.getElementById('editModalBtn').onclick = () => startModalEdit(record);
        document.getElementById('deleteModalBtn').onclick = () => {
            if (record.staffInitial !== loggedUsername) {
                showToast('Bu kaydı yalnızca oluşturan kişi silebilir!', true);
                return;
            }
            recordToDelete = record.id;
            confirmModal.style.display = 'flex';
        };
    }

    function updateStatusBadge(status) {
        modalStatusBadge.textContent = statusLabelOf(status);
        modalStatusBadge.className = 'status-badge ' + (status || 'Following').toLowerCase();
    }

    // ── Workflow rendering & transitions ───────────────────────
    // Shows the request lifecycle with timestamps and computed durations,
    // and exposes only the actions valid for the current state.
    function renderWorkflow(record) {
        const status = record.status || 'Following';
        const created = tsToDate(record.createdAt);
        const acked = tsToDate(record.acknowledgedAt);
        const done = tsToDate(record.completedAt);

        const steps = [];
        steps.push({
            cls: 'done', label: 'Talep oluşturuldu',
            meta: fmtClock(created) + (record.staffInitial ? ' · ' + esc(record.staffInitial) : '')
        });
        if (acked) {
            steps.push({
                cls: 'done', label: 'İşleme alındı',
                meta: fmtClock(acked) + (record.acknowledgedBy ? ' · ' + esc(record.acknowledgedBy) : '')
                    + (created ? ` · yanıt: ${fmtDuration(acked - created)}` : '')
            });
        } else {
            steps.push({
                cls: status === 'Solved' ? 'skipped' : 'pending',
                label: status === 'Solved' ? 'İşleme alınmadan tamamlandı' : 'Departman bekleniyor',
                meta: status === 'Solved' ? '' : (created ? `${fmtDuration(Date.now() - created)} oldu` : '')
            });
        }
        if (done) {
            const parts = [];
            if (acked) parts.push(`işlem: ${fmtDuration(done - acked)}`);
            if (created) parts.push(`toplam: ${fmtDuration(done - created)}`);
            steps.push({
                cls: 'done', label: 'Tamamlandı',
                meta: fmtClock(done) + (record.completedBy ? ' · ' + esc(record.completedBy) : '')
                    + (parts.length ? ' · ' + parts.join(' · ') : '')
            });
        } else {
            steps.push({
                cls: 'pending', label: 'Tamamlanacak',
                meta: (status === 'InProgress' && acked) ? `${fmtDuration(Date.now() - acked)}dir işlemde` : ''
            });
        }

        document.getElementById('wfSteps').innerHTML = steps.map(s => `
            <div class="wf-step ${s.cls}">
                <span class="wf-dot"></span>
                <div class="wf-step-text"><b>${s.label}</b>${s.meta ? `<span>${s.meta}</span>` : ''}</div>
            </div>`).join('');

        const takeBtn = document.getElementById('wfTakeBtn');
        takeBtn.style.display = (status === 'Following') ? 'inline-flex' : 'none';
        // Katı departman/vardiya kuralı görünürlüğü: engellenen personel
        // butonu devre dışı + neden açıklamalı görür (gizlemek kafa karıştırır).
        const takeReason = takeBlockReason(record);
        takeBtn.disabled = !!takeReason;
        takeBtn.style.opacity = takeReason ? '0.45' : '';
        takeBtn.title = takeReason || '';
        // Tamamlama yalnızca işi üstlenen personelde ve yönetici/admin'de açık —
        // buton görünür kalır ama devre dışı + açıklamalı (gizlemek kafa karıştırır).
        const completeBtn = document.getElementById('wfCompleteBtn');
        completeBtn.style.display = (status !== 'Solved') ? 'inline-flex' : 'none';
        const completeReason = completeBlockReason(record);
        completeBtn.disabled = !!completeReason;
        completeBtn.style.opacity = completeReason ? '0.45' : '';
        completeBtn.title = completeReason || '';
        document.getElementById('wfReopenBtn').style.display = (status === 'Solved') ? 'inline-flex' : 'none';
        const escBtn2 = document.getElementById('wfEscalateBtn');
        const escTag = document.getElementById('wfEscTag');
        const canEsc = status !== 'Solved' && record.escalated !== true;
        if (escBtn2) escBtn2.style.display = canEsc ? 'inline-flex' : 'none';
        if (escTag) escTag.style.display = (record.escalated === true) ? 'inline-flex' : 'none';
    }

    // Appends an entry to the record's timeline (same shape as manual notes).
    function workflowNote(text) {
        return {
            user: loggedUsername,
            text: text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: Date.now(),
            isEdited: false,
            isSystem: true
        };
    }

    // Çift-tıklama/çift-gönderim koruması: buton await çözülüp arayüz
    // yeniden render edilene kadar devre dışı bırakılmıyordu — neredeyse
    // eşzamanlı iki tıklama, her biri bağımsız hesaplanan farklı bir süre
    // metniyle zaman çizelgesine MÜKERRER not ekleyebiliyor, ayrıca
    // completedAt ikinci çağrının timestamp'iyle üzerine yazılabiliyordu;
    // bkz. idempotency denetimi. Üç geçiş de (take/complete/reopen) aynı
    // riski taşıdığından tek paylaşımlı bayrak yeterli.
    let transitionInFlight = false;
    async function transitionRecord(action) {
        if (!selectedRecord || transitionInFlight) return;
        transitionInFlight = true;
        try {
            await transitionRecordImpl(action);
        } finally {
            transitionInFlight = false;
        }
    }
    // Mobil karttan tek dokunuşla üstlen/tamamla — modal açılmaz. Aynı
    // transaction'lı transitionRecord çekirdeğini kullanır (katı departman
    // kuralı ve bayat-durum koruması aynen geçerli); ardından liste tazelenir.
    async function quickTransition(record, action, btn) {
        if (transitionInFlight) return;
        selectedRecord = record;
        editingId = record.id;
        if (btn) btn.disabled = true;
        try {
            await transitionRecord(action);
        } finally {
            if (btn) btn.disabled = false;
            triggerSearch(); // kart durumu ve hızlı buton yeniden hesaplanır
        }
    }
    // take/complete/reopen artık bir transaction içinde, kaydın SUNUCUDAKİ
    // güncel status'unu okuyup doğruladıktan sonra yazıyor — önceki plain
    // .update() iki personelin aynı kaydı aynı anda üstlenmesi/tamamlaması
    // durumunda son yazanın kazandığı, kaybedenin bundan habersiz kaldığı
    // sessiz bir yarış koşuluydu (bkz. tutarlılık denetimi). transitionInFlight
    // yalnızca AYNI sekmeyi korur; bu transaction farklı sekme/cihazları da
    // kapsar.
    // KATI departman kuralı: kaydı yalnızca kaydın departmanındaki personel
    // üstlenebilir; manager/admin her kaydı üstlenebilir. Böylece "klima
    // şikayetini teknik servisten biri üstlenir" akışı disipline bağlanır.
    // "İşlerim": üstlendiğim VEYA bana atanan işler — saha personelinin
    // kendi iş listesi (birden fazla işi tek bakışta takip için).
    function isMineRecord(r) {
        if (!r) return false;
        if (r.acknowledgedBy === loggedUsername) return true;
        if (r.assignedToName === loggedUsername) return true;
        const me = (firebase.auth().currentUser || {}).uid;
        return !!(me && r.assignedTo && r.assignedTo === me);
    }
    function deptOf(s) { return String(s || '').trim().toLocaleLowerCase('tr-TR'); }

    // ── Vardiya konumu kontrolü (opsiyonel — admin "Sistem" ayarına bağlı) ──
    // realtime.js'in presence heartbeat'i, admin bir otel konumu+yarıçapı
    // tanımlamışsa personelin cihaz konumunu buna göre ölçüp presence/{uid}
    // içine SONUCU (onShift boolean) yazar — ham koordinat asla buraya
    // inmez. Kayıt yoksa (kontrol kapalı/izin verilmemiş/henüz ölçülmemiş)
    // varsayılan HER ZAMAN "vardiyada" sayılır: bu kontrol yalnızca
    // KANITLANMIŞ şekilde otel dışında olan personeli kısıtlar — aşamalı/
    // güvenli devreye alım (bkz. admin.js shiftConfig kaydı).
    let shiftConfig = null, myOnShift = true;
    function shiftControlActive() { return !!(shiftConfig && shiftConfig.enabled); }
    function listenShift(myUid) {
        db.collection('shiftConfig').doc(TENANT_ID).onSnapshot(doc => { shiftConfig = doc.exists ? doc.data() : null; }, () => {});
        if (!myUid) return;
        db.collection('presence').doc(myUid).onSnapshot(doc => {
            myOnShift = !(doc.exists && doc.data().onShift === false);
        }, () => {});
    }
    let presenceCache = null, presenceCacheAt = 0;
    async function getPresenceMap() {
        if (presenceCache && Date.now() - presenceCacheAt < 60000) return presenceCache; // 1 dk cache — konum daha sık değişebilir
        const map = {};
        try {
            const snap = await db.collection('presence').where('tenantId', '==', TENANT_ID).get();
            snap.forEach(d => { map[d.id] = d.data() || {}; });
            presenceCache = map; presenceCacheAt = Date.now();
        } catch (e) { presenceCache = presenceCache || {}; }
        return presenceCache;
    }
    function isUidOnShift(uid, presenceMap) {
        const p = presenceMap && presenceMap[uid];
        return !(p && p.onShift === false); // kayıt yok/true → vardiyada (fail-open)
    }
    const SHIFT_BLOCK_MSG = 'Vardiya dışısınız — bu işlem için otel konumunda olmanız gerekir (yönetici/admin muaftır).';

    // Dönüş: null (izinli) veya kullanıcıya gösterilecek Türkçe gerekçe.
    // Üç çağrı yeri (kart butonu, modal butonu, transitionRecordImpl) aynı
    // mantığı ve mesajı paylaşsın diye tek yerde toplanır.
    function takeBlockReason(record) {
        const role = (localStorage.getItem('hotelRole') || '').toLowerCase();
        if (role === 'admin' || role === 'manager' || loggedUsername.toLowerCase() === 'admin') return null;
        const myDept = localStorage.getItem('hotelDept');
        const recDept = record && record.department;
        // sameDept (js/core/firebase-config.js): ham string eşitliği değil —
        // "Food & Beverage" (eski F&B departman adı) ile kanonik
        // "Yiyecek & İçecek" aynı departman sayılır (geçiş dönemi verisi).
        if (deptOf(recDept) && !(deptOf(myDept) && sameDept(myDept, recDept))) {
            return 'Bu kayıt "' + (record.department || '—') + '" departmanına ait — yalnızca o departman personeli veya yönetici üstlenebilir.';
        }
        if (shiftControlActive() && !myOnShift) return SHIFT_BLOCK_MSG;
        return null;
    }
    function canTakeRecord(record) { return takeBlockReason(record) == null; }

    // İş sahipliği: üstlenilmiş bir işi yalnızca ÜSTLENEN personel (veya
    // yönetici/admin) tamamlayabilir — iki kişinin aynı işi karıştırması
    // önlenir. Üstlenen bilgisi olmayan eski kayıtlar departman/vardiya
    // kuralına düşer (takeBlockReason). Zaten üstlenilmiş bir işi kendi
    // sahibi vardiya dışına çıksa bile tamamlayabilir — kısıt yalnızca
    // YENİ iş ÜSTLENMEYİ hedefler (kullanıcının talebi).
    function completeBlockReason(record) {
        const role = (localStorage.getItem('hotelRole') || '').toLowerCase();
        if (role === 'admin' || role === 'manager' || loggedUsername.toLowerCase() === 'admin') return null;
        const owner = String(record && record.acknowledgedBy || '').trim().toLocaleLowerCase('tr-TR');
        if (!owner) return takeBlockReason(record);
        if (owner !== loggedUsername.toLocaleLowerCase('tr-TR')) {
            return 'Bu işi ' + (record.acknowledgedBy || 'başka bir personel') + ' üstlendi — yalnızca o veya bir yönetici tamamlayabilir.';
        }
        return null;
    }
    function canCompleteRecord(record) { return completeBlockReason(record) == null; }
    async function transitionRecordImpl(action) {
        const r = selectedRecord;
        if (action === 'take') {
            const reason = takeBlockReason(r);
            if (reason) { showToast(reason, true); return; }
        }
        if (action === 'complete') {
            const reason = completeBlockReason(r);
            if (reason) { showToast(reason, true); return; }
        }
        const TS = firebase.firestore.FieldValue.serverTimestamp();
        const nowDate = new Date();
        const ref = db.collection('guestLogs').doc(editingId);

        try {
            const result = await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists) return { error: 'not-found' };
                const cur = snap.data();
                const curStatus = cur.status || 'Following';

                if (action === 'take' && curStatus !== 'Following') return { error: 'stale', data: cur };
                if (action === 'complete' && curStatus === 'Solved') return { error: 'stale', data: cur };
                if (action === 'reopen' && curStatus !== 'Solved') return { error: 'stale', data: cur };

                const payload = {};
                let note, toastMsg;
                if (action === 'take') {
                    payload.status = 'InProgress';
                    payload.acknowledgedAt = TS;
                    payload.acknowledgedBy = loggedUsername;
                    // Üstlenenin departmanı raporlama için kayda işlenir
                    // (kaydın departmanıyla eşleşmesi canTakeRecord ile garanti;
                    // manager/admin üstlenmişse kendi departmanı görünür).
                    payload.acknowledgedDept = (localStorage.getItem('hotelDept') || '').trim();
                    note = workflowNote('🔧 İşi üstlendi — süre başladı');
                    toastMsg = 'İş üstlenildi, süre başladı';
                } else if (action === 'complete') {
                    payload.status = 'Solved';
                    payload.completedAt = TS;
                    payload.completedBy = loggedUsername;
                    const acked = tsToDate(cur.acknowledgedAt), created = tsToDate(cur.createdAt);
                    const durText = acked ? fmtDuration(nowDate - acked) : (created ? fmtDuration(nowDate - created) + ' (toplam)' : '');
                    note = workflowNote('✅ Tamamlandı' + (durText ? ` — ${durText}` : ''));
                    toastMsg = 'Talep tamamlandı' + (durText ? ` · ${durText}` : '');
                } else if (action === 'reopen') {
                    payload.status = 'Following';
                    payload.completedAt = null;
                    payload.completedBy = null;
                    note = workflowNote('↩️ Talep yeniden açıldı');
                    toastMsg = 'Talep yeniden açıldı';
                } else return { error: 'invalid-action' };

                // arrayUnion: sunucu tarafında atomik ekleme — istemcinin okuduğu
                // (bayat olabilecek) `updates` dizisini tam olarak geri yazmak, aynı
                // kayda eşzamanlı eklenen başka bir notu sessizce ezebilirdi.
                payload.updates = firebase.firestore.FieldValue.arrayUnion(note);
                tx.update(ref, payload);
                return { ok: true, status: payload.status, note, toastMsg };
            });

            if (result.error === 'not-found') { showToast('Kayıt bulunamadı — silinmiş olabilir.', true); return; }
            if (result.error === 'invalid-action') return;
            if (result.error === 'stale') {
                // Sunucudaki güncel durumu yerel state'e ve arayüze yansıt —
                // buton artık tıklanabilir kalmaz; kaybeden personel az önce
                // başka birinin bu kaydı devraldığını/tamamladığını görür.
                Object.assign(r, result.data);
                updateStatusBadge(r.status);
                renderWorkflow(r);
                renderTimeline(r);
                showToast('Bu kayıt az önce başka biri tarafından güncellendi — ekran yenilendi.', true);
                return;
            }

            // Optimistic local update so the modal reflects the change instantly
            // (the snapshot listener will reconcile with server timestamps).
            r.status = result.status;
            if (action === 'take') { r.acknowledgedAt = nowDate; r.acknowledgedBy = loggedUsername; }
            if (action === 'complete') { r.completedAt = nowDate; r.completedBy = loggedUsername; }
            if (action === 'reopen') { r.completedAt = null; r.completedBy = null; }
            r.updates = [...(r.updates || []), result.note];
            updateStatusBadge(r.status);
            renderWorkflow(r);
            renderTimeline(r);
            showToast(result.toastMsg);
            // QR köprüsü senkronu: bu kayıt bir QR siparişinin kalemiyse,
            // üstlenince kalem "işlemde", tamamlanınca "tamamlandı" olur;
            // tüm kalemler bitince sipariş kapanır — misafir kendi ekranında
            // talebinin anlık durumunu görür (çift yönetim tutarsızlığı kalmaz).
            if (r.source === 'guest-order' && r.orderId && r.itemId) {
                if (action === 'take') syncOrderItem(r.orderId, r.itemId, 'in_progress');
                else if (action === 'complete') syncOrderItem(r.orderId, r.itemId, 'completed');
            }
        } catch (e) { showToast('Güncelleme başarısız: ' + e.message, true); }
    }
    // phase: 'in_progress' (iş üstlenildi) | 'completed' (iş bitti).
    // in_progress yalnızca bekleyen/onaylı kalemi ilerletir; tamamlanmış veya
    // iptal edilmiş kaleme asla geri gitmez.
    async function syncOrderItem(orderId, itemId, phase) {
        try {
            const oRef = db.collection('guestOrders').doc(orderId);
            await db.runTransaction(async (tx) => {
                const snap = await tx.get(oRef);
                if (!snap.exists) return;
                const o = snap.data();
                if (o.status === 'cancelled') return;
                const items = (o.items || []).map(it => {
                    if (!it || it.id !== itemId || it.status === 'cancelled') return it;
                    if (phase === 'completed') return Object.assign({}, it, { status: 'completed' });
                    // in_progress: yalnız ileri yönde (pending/confirmed → in_progress)
                    return (it.status === 'pending' || it.status === 'confirmed' || !it.status)
                        ? Object.assign({}, it, { status: 'in_progress' }) : it;
                });
                const allDone = items.length && items.every(it => it.status === 'completed' || it.status === 'cancelled');
                tx.update(oRef, {
                    items,
                    status: allDone ? 'completed' : (o.status === 'pending' ? 'in_progress' : o.status),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            });
        } catch (e) { console.error('order sync', e); /* sipariş silinmiş olabilir — kritik değil */ }
    }

    // Timeline Logic
    function renderTimeline(record) {
        timelineFeed.innerHTML = '';
        const updates = record.updates || [];
        updates.forEach((note, index) => {
            const item = document.createElement('div');
            item.className = 'timeline-item' + (note.isSystem ? ' system' : '');
            item.id = `note-${index}`;
            // System (workflow) entries are an audit trail — not editable.
            const isOwner = note.user === loggedUsername && !note.isSystem;

            item.innerHTML = `
                <div class="timeline-header">
                    <span class="timeline-author">${esc(note.user)} ${note.isEdited ? '<span class="edited-tag">(düzenlendi)</span>' : ''}</span>
                    <span class="timeline-time">${esc(note.time)}</span>
                </div>
                <div class="timeline-body">
                    <div class="timeline-text">${esc(note.text)}</div>
                </div>
                ${isOwner ? `
                <div class="timeline-actions">
                    <button class="timeline-edit-btn" onclick="startInlineEdit(${index})">Düzenle</button>
                    <button class="timeline-delete-btn" onclick="deleteNote(${index})">Sil</button>
                </div>` : ''}
            `;
            timelineFeed.appendChild(item);
        });
        timelineFeed.scrollTop = timelineFeed.scrollHeight;
    }

    window.deleteNote = (index) => {
        const item = document.getElementById(`note-${index}`);
        const actions = item.querySelector('.timeline-actions');

        actions.innerHTML = `
            <span class="confirm-msg">Silinsin mi?</span>
            <button class="timeline-confirm-btn" onclick="confirmDeleteNote(${index})">Evet</button>
            <button class="timeline-cancel-btn" onclick="renderTimeline(selectedRecord)">Hayır</button>
        `;
    };

    window.confirmDeleteNote = async (index) => {
        const target = selectedRecord.updates[index];
        if (!target) return;
        try {
            await db.runTransaction(async (tx) => {
                const ref = db.collection('guestLogs').doc(editingId);
                const snap = await tx.get(ref);
                if (!snap.exists) return;
                const cur = snap.data().updates || [];
                // index yerine timestamp+user ile eşleştir: transaction başlarken
                // dizi başka bir istemci tarafından değişmiş olabilir, bu durumda
                // ham index kayıp/yanlış notu silebilirdi.
                const freshIdx = cur.findIndex(u => u.timestamp === target.timestamp && u.user === target.user);
                if (freshIdx === -1) return; // not zaten silinmiş/değişmiş
                const next = cur.slice();
                next.splice(freshIdx, 1);
                tx.update(ref, { updates: next });
            });
            showToast('Note removed.');
        } catch (e) { showToast('Silinemedi: ' + e.message, true); }
    };

    window.startInlineEdit = (index) => {
        const item = document.getElementById(`note-${index}`);
        const body = item.querySelector('.timeline-body');
        const originalText = selectedRecord.updates[index].text;

        body.innerHTML = `
            <div class="inline-edit-area">
                <textarea id="edit-note-input-${index}" class="inline-textarea">${esc(originalText)}</textarea>
                <div class="inline-actions">
                    <button class="inline-save-btn" onclick="saveInlineEdit(${index})">Kaydet</button>
                    <button class="inline-cancel-btn" onclick="cancelInlineEdit(${index})">Vazgeç</button>
                </div>
            </div>
        `;
        item.querySelector('.timeline-actions').style.display = 'none';
    };

    window.cancelInlineEdit = (index) => renderTimeline(selectedRecord);

    window.saveInlineEdit = async (index) => {
        const newText = document.getElementById(`edit-note-input-${index}`).value.trim();
        const original = selectedRecord.updates[index];
        if (newText && original && newText !== original.text) {
            try {
                await db.runTransaction(async (tx) => {
                    const ref = db.collection('guestLogs').doc(editingId);
                    const snap = await tx.get(ref);
                    if (!snap.exists) return;
                    const cur = snap.data().updates || [];
                    const freshIdx = cur.findIndex(u => u.timestamp === original.timestamp && u.user === original.user);
                    if (freshIdx === -1) return;
                    const next = cur.slice();
                    next[freshIdx] = Object.assign({}, next[freshIdx], { text: newText, isEdited: true });
                    tx.update(ref, { updates: next });
                });
                showToast('Note updated.');
            } catch (e) { showToast('Güncellenemedi: ' + e.message, true); }
        } else {
            renderTimeline(selectedRecord);
        }
    };

    postNoteBtn.onclick = async () => {
        const text = noteInput.value.trim();
        if (!text) return;
        const newNote = {
            user: loggedUsername,
            text: text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: Date.now(),
            isEdited: false
        };
        try {
            // arrayUnion: eşzamanlı eklenen başka bir notu ezmeden atomik ekler.
            await db.collection('guestLogs').doc(editingId).update({
                updates: firebase.firestore.FieldValue.arrayUnion(newNote)
            });
            noteInput.value = '';
        } catch (e) { showToast('Not eklenemedi: ' + e.message, true); }
    };

    const editDeptSel = document.getElementById('editDepartment');
    const editTopicSel = document.getElementById('editTopic');

    function startModalEdit(record) {
        document.getElementById('editDate').value = record.date;
        document.getElementById('editRoom').value = record.room;
        document.getElementById('editGuestName').value = record.guestName;
        fillDeptSelect(editDeptSel, record.type, record.department);
        // Konu is complaint-only: hide the field for requests.
        const editTopicGroup = document.getElementById('editTopicGroup');
        const isReqRec = (record.type === 'request');
        if (editTopicGroup) editTopicGroup.style.display = isReqRec ? 'none' : 'block';
        if (editTopicSel) editTopicSel.value = (record.topic && record.topic !== 'Genel') ? record.topic : '';
        document.getElementById('editComplaint').value = record.complaint;
        document.getElementById('editSolution').value = record.solution;
        document.getElementById('editStaffInitial').value = record.staffInitial;
        document.getElementById('editStatus').value = record.status || 'Following';
        modalViewMode.style.display = 'none';
        modalEditForm.style.display = 'block';
    }

    document.getElementById('cancelEditBtn').onclick = () => {
        modalEditForm.style.display = 'none';
        modalViewMode.style.display = 'block';
    };

    modalEditForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const updatedData = {
            date: document.getElementById('editDate').value,
            room: document.getElementById('editRoom').value,
            guestName: document.getElementById('editGuestName').value,
            department: document.getElementById('editDepartment').value,
            topic: (selectedRecord && selectedRecord.type === 'request')
                ? '' : ((document.getElementById('editTopic').value || '').trim() || 'Genel'),
            complaint: document.getElementById('editComplaint').value,
            solution: document.getElementById('editSolution').value,
            staffInitial: document.getElementById('editStaffInitial').value,
            status: document.getElementById('editStatus').value
        };
        try {
            await db.collection('guestLogs').doc(editingId).update(updatedData);
            if (updatedData.topic && updatedData.topic !== 'Genel' && window.IssueConfig) {
                IssueConfig.addTopic(updatedData.topic);
            }
            closeModalFunc();
            showToast('Changes saved.');
        } catch (err) {
            // Bu handler'ın tek istisnası olarak try/catch yoktu — yazım
            // reddedilirse (çevrimdışı, izin hatası) kullanıcı ne başarı ne
            // hata mesajı görmeden modal donuk kalıyor, veri sessizce
            // kayboluyordu (bkz. tutarlılık denetimi).
            showToast('Kaydedilemedi: ' + (err && err.message ? err.message : 'hata'), true);
        }
    });

    const authModal = document.getElementById('authModal');
    const authPassInput = document.getElementById('auth-password');
    const authVerifyBtn = document.getElementById('auth-verify-btn');

    document.getElementById('authClose').onclick = () => authModal.style.display = 'none';

    confirmDeleteBtn.onclick = () => {
        if (!recordToDelete) return;
        confirmModal.style.display = 'none';
        authPassInput.value = '';
        authModal.style.display = 'flex';
    };

    authVerifyBtn.onclick = async () => {
        const password = authPassInput.value;
        if (!password) return showToast('Please enter your password', true);

        authVerifyBtn.disabled = true;
        authVerifyBtn.textContent = 'Verifying...';

        try {
            const user = firebase.auth().currentUser;
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
            await user.reauthenticateWithCredential(credential);

            // Success: Proceed with deletion
            await db.collection('guestLogs').doc(recordToDelete).delete();
            authModal.style.display = 'none';
            closeModalFunc();
            showToast('Record deleted.');
            recordToDelete = null;
        } catch (e) {
            showToast('Authentication failed. Incorrect password.', true);
        } finally {
            authVerifyBtn.disabled = false;
            authVerifyBtn.textContent = 'Verify & Delete';
        }
    };

    cancelDeleteBtn.onclick = () => { confirmModal.style.display = 'none'; recordToDelete = null; };

    function draftEmail(record) {
        const subject = encodeURIComponent(`Guest Issue Report: ${record.room} - ${record.guestName}`);
        const body = encodeURIComponent(`Date: ${record.date}\nRoom: ${record.room}\nGuest: ${record.guestName}\nDept: ${record.department}\n\nComplaint: ${record.complaint}\nSolution: ${record.solution}\nStatus: ${record.status}`);
        window.location.href = `mailto:?subject=${subject}&body=${body}`;
    }


    document.getElementById('successEmailBtn').onclick = () => {
        if (selectedRecord) draftEmail(selectedRecord);
        document.getElementById('successModal').style.display = 'none';
    };
    document.getElementById('successSkipBtn').onclick = () => document.getElementById('successModal').style.display = 'none';

    function closeModalFunc() { modal.style.display = 'none'; selectedRecord = null; }
    closeModal.onclick = closeModalFunc;
    window.onclick = (e) => {
        if (e.target == modal) closeModalFunc();
        if (e.target == confirmModal) { confirmModal.style.display = 'none'; recordToDelete = null; }
        if (e.target == authModal) authModal.style.display = 'none';
    };
    document.getElementById('date').valueAsDate = new Date();
});
