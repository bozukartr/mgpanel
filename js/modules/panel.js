function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Arayüz ikonu (js/core/ui-icons.js) — dosya önbellekten eski gelirse boş döner, sayfa kırılmaz.
const ic = (n) => (typeof window.UIcon === 'function' ? window.UIcon(n) : '');

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
    if (isAdminUser) {
        if (adminNavLink) adminNavLink.style.display = 'inline-block';
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
    // Arama katlaması: Türkçe küçük harf + 'I'/'ı' ile 'İ'/'i' ayrımını
    // kaldırır — "ilker", "İLKER", "Ilker" hepsi "İlker"i bulur.
    const searchFold = (v) => String(v).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').trim();

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
        logoutBtn.addEventListener('click', () => hotelSignOut('login'));
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

    // Tab switching (masaüstü üst navigasyonu)
    const switchTab = (tabId) => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        const targetTab = document.getElementById(tabId);
        if (targetTab) targetTab.classList.add('active');

        document.querySelectorAll(`[data-tab="${tabId}"]`).forEach(b => b.classList.add('active'));
    };

    document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            if (tabId) switchTab(tabId);
        });
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
                    listEl.innerHTML = globalGuestsHTML;
                }
            } else {
                // Auto-suppress upon partial delete
                listEl.innerHTML = '';
            }
        });
    }

    // Instigate gating hooks immediately
    setupDynamicAutolist('guestName', 'guest-list');

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
    // Kayıt oluşturma akışı tek yerde: masaüstü "Ekle", mobil FAB ve mobil
    // menüdeki "Talep Gir"/"Şikayet Gir" kartları aynı fonksiyonu çağırır —
    // tek fark açılış tipi. (Eskiden bu blok koşulsuz 'complaint' zorluyordu,
    // dolayısıyla tipe göre derin bağlantı mümkün değildi.)
    function openNewIssue(type) {
        if (!newIssueModal) return;
        const dateInput = document.getElementById('date');
        if (dateInput && !dateInput.value) dateInput.valueAsDate = new Date();
        if (staffInitialInput && !staffInitialInput.value) staffInitialInput.value = loggedUsername;
        selectedAssignee = null;
        setRecordType(type === 'request' ? 'request' : 'complaint');
        newIssueModal.style.display = 'flex';
        document.getElementById('guestName')?.focus();
    }
    document.getElementById('giFabNew')?.addEventListener('click', () => openNewIssue('complaint'));
    document.getElementById('newIssueBtn')?.addEventListener('click', () => openNewIssue('complaint'));

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

    // Tarih aralığı süzgeci (performans paneli kullanır). Raporlar modalı
    // kaldırıldı — hiçbir butonla açılamıyordu; kayıt raporları artık
    // Raporlar sayfasında (reports.js, Excel dışa aktarımı dahil).
    function filterByRange(data, from, to) {
        return data.filter(r => {
            if (from && r.date < from) return false;
            if (to && r.date > to) return false;
            return true;
        });
    }

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

    /* ══════════════════════════════════════════════════════════════════
       SAHA PERSONELİ MOBİL DENEYİMİ (yalnızca ≤768px)
       Telefonda açılış ekranı büyük butonlu bir menüdür; kayıt listesi
       oradan tek dokunuşla açılır. Masaüstünde bu bloğun HİÇBİR görünür
       etkisi yoktur: eklenen body sınıflarına yalnızca @media (max-width:768px)
       içindeki kurallar bağlıdır ve mobil elemanlar masaüstünde gizlidir.
       Filtreleme için yeni bir mantık YAZILMAZ — mevcut durum hapları
       programatik olarak tıklanır, böylece tek bir doğruluk kaynağı kalır.
       ══════════════════════════════════════════════════════════════════ */
    const MOB_MQ = window.matchMedia('(max-width: 768px)');
    const SEG_PILL = {
        all: 'filterTotal', Following: 'filterFollowing', InProgress: 'filterInProgress',
        Solved: 'filterSolved', Mine: 'filterMine', Overdue: 'filterOverdue'
    };

    function mobView(v) {
        document.body.classList.toggle('mv-home', v === 'home');
        document.body.classList.toggle('mv-list', v === 'list');
        if (v === 'home') {
            document.body.classList.remove('mob-filters');
            document.getElementById('mobSearchToggle')?.classList.remove('on');
            syncMobHome();
        } else {
            // Liste ekranına her girişte tepeden başla — kalıntı kaydırma konumu
            // "liste boş" izlenimi verir.
            const gl = document.getElementById('guest-log');
            if (gl) gl.scrollTop = 0;
        }
    }
    function mobSetSeg(seg) {
        document.querySelectorAll('.mlb-sg').forEach(b => b.classList.toggle('active', b.dataset.seg === seg));
    }
    function mobOpenList(seg, title) {
        document.getElementById(SEG_PILL[seg])?.click();   // mevcut filtre mantığını yeniden kullan
        mobSetSeg(seg);
        const t = document.getElementById('mobListTitle');
        if (t) t.textContent = title;
        mobView('list');
    }

    // Menü kartlarının canlı sayaçları: updateView'in HESAPLADIĞI istatistik
    // elemanlarından okunur — yeni Firestore sorgusu yok.
    function syncMobHome() {
        const txt = (id) => (document.getElementById(id) || {}).textContent || '0';
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        const mine = parseInt(txt('statMine'), 10) || 0;
        set('mhCountAll', txt('statTotal'));
        set('mhCountMine', mine);
        const od = parseInt(txt('statOverdue'), 10) || 0;
        set('mhCountOverdue', od);
        const alertEl = document.getElementById('mhOverdue');
        if (alertEl) alertEl.style.display = od ? 'flex' : 'none';
        const sub = document.getElementById('mhSub');
        if (sub) {
            const dept = localStorage.getItem('hotelDept') || '';
            sub.textContent = (dept ? dept + ' · ' : '') +
                (mine ? mine + ' açık işin var' : 'Açık işin yok');
        }
    }

    (function initMobHome() {
        const h = new Date().getHours();
        const greet = h < 6 ? 'İyi geceler' : (h < 12 ? 'Günaydın' : (h < 18 ? 'İyi günler' : 'İyi akşamlar'));
        const hello = document.getElementById('mhHello');
        if (hello) hello.textContent = greet + ', ' + (loggedUsername.charAt(0).toUpperCase() + loggedUsername.slice(1));

        document.querySelectorAll('#mobHome [data-mob]').forEach(card => {
            card.addEventListener('click', () => {
                switch (card.dataset.mob) {
                    case 'requests': mobOpenList('all', 'Talepler'); break;
                    case 'mine': mobOpenList('Mine', 'İşlerim'); break;
                    case 'new-request': openNewIssue('request'); break;
                    case 'new-complaint': openNewIssue('complaint'); break;
                    case 'qr':
                        if (window.GuestOrders) GuestOrders.open();
                        else showToast('QR talepleri henüz yüklenmedi, birazdan tekrar deneyin.', true);
                        break;
                    case 'settings': openMobSettings(); break;
                }
            });
        });
        document.getElementById('mhOverdue')?.addEventListener('click', () => mobOpenList('Overdue', 'Geciken İşler'));
        document.getElementById('mobBack')?.addEventListener('click', () => mobView('home'));
        document.querySelectorAll('.mlb-sg').forEach(b => {
            b.addEventListener('click', () => {
                document.getElementById(SEG_PILL[b.dataset.seg])?.click();
                mobSetSeg(b.dataset.seg);
            });
        });
        document.getElementById('mobSearchToggle')?.addEventListener('click', function () {
            const on = document.body.classList.toggle('mob-filters');
            this.classList.toggle('on', on);
            if (on) document.getElementById('globalSearch')?.focus();
        });

        // Açılış ekranı: mobilde menü, masaüstünde hiçbir şey.
        if (MOB_MQ.matches) mobView('home');
        // Döndürme / pencere boyutu değişimi: masaüstüne geçişte sınıfları
        // temizle ki masaüstü düzeni hiçbir kalıntı taşımasın.
        const onMQ = (e) => {
            if (e.matches) { if (!document.body.classList.contains('mv-list')) mobView('home'); }
            else document.body.classList.remove('mv-home', 'mv-list', 'mob-filters');
        };
        if (MOB_MQ.addEventListener) MOB_MQ.addEventListener('change', onMQ);
        else if (MOB_MQ.addListener) MOB_MQ.addListener(onMQ);
    })();

    // ── Mobil Ayarlar sheet'i ──────────────────────────────────────
    const mobSettingsModal = document.getElementById('mobSettingsModal');
    function openMobSettings() {
        if (!mobSettingsModal) return;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('msUser', loggedUsername);
        set('msRole', loggedRole === 'admin' ? 'Yönetici' : (loggedRole === 'manager' ? 'Müdür' : 'Personel'));
        set('msDept', localStorage.getItem('hotelDept') || '—');

        const cur = (window.I18n && I18n.lang) ? I18n.lang() : (localStorage.getItem('hotelLang') || 'tr');
        document.querySelectorAll('.ms-lang').forEach(b => b.classList.toggle('active', b.dataset.lang === cur));

        const perm = ('Notification' in window) ? Notification.permission : '';
        set('msNotifState', perm === 'granted' ? 'Açık' : (perm === 'denied' ? 'Engelli' : (perm ? 'Kapalı' : 'Desteklenmiyor')));

        // Performans paneli yalnızca yönetici/admin'e açık — wirePerf() ile aynı kural.
        const perfBtn = document.getElementById('msPerf');
        if (perfBtn) perfBtn.style.display = (isAdminUser || loggedRole === 'manager') ? 'flex' : 'none';
        const adminBtn = document.getElementById('msAdmin');
        if (adminBtn) adminBtn.style.display = isAdminUser ? 'flex' : 'none';

        mobSettingsModal.style.display = 'flex';
    }
    function closeMobSettings() { if (mobSettingsModal) mobSettingsModal.style.display = 'none'; }
    document.getElementById('mobSettingsClose')?.addEventListener('click', closeMobSettings);
    mobSettingsModal?.addEventListener('click', (e) => { if (e.target === mobSettingsModal) closeMobSettings(); });
    document.querySelectorAll('.ms-lang').forEach(b => {
        b.addEventListener('click', () => {
            if (window.I18n) I18n.setLang(b.dataset.lang);   // tercihi yazar + üst pencereyi yeniler
        });
    });
    document.getElementById('msNotif')?.addEventListener('click', async () => {
        if (!window.Push || !Push.supported) { showToast('Bu cihaz bildirimleri desteklemiyor.', true); return; }
        const st = await Push.repair();
        showToast(st && st.permission === 'granted' ? 'Bildirimler açık.' : 'Bildirim izni verilmedi.', st && st.permission !== 'granted');
        openMobSettings();   // durum satırını tazele
    });
    document.getElementById('msPerf')?.addEventListener('click', () => {
        closeMobSettings();
        document.getElementById('openPerfBtn')?.click();
    });
    document.getElementById('msAdmin')?.addEventListener('click', () => {
        // Yönetim paneli kabuğun DIŞINDA çalışır (bkz. js/core/app-shell.js).
        try { (window.top || window).location.href = 'admin'; }
        catch (e) { window.location.href = 'admin'; }
    });
    document.getElementById('msLogout')?.addEventListener('click', () => {
        closeMobSettings();
        document.getElementById('logoutBtn')?.click();
    });

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
        if (!od.length) { box.innerHTML = '<div class="gi-od-empty">' + ic('check') + ' Geciken iş yok</div>'; return; }
        box.innerHTML = od.map(r => {
            const created = tsToDate(r.createdAt);
            const dur = created ? fmtDuration(Date.now() - created) : '';
            return `<div class="gi-od-item" data-id="${esc(r.id)}">
                <b>${esc(r.guestName)} · Oda ${esc(r.room)}</b>
                <div class="gi-od-meta"><span>${esc(r.department || '')}</span><span class="gi-od-dur">${ic('hourglass')} ${dur}</span></div>
            </div>`;
        }).join('');
        box.querySelectorAll('.gi-od-item').forEach(it => it.addEventListener('click', () => {
            const rec = records.find(r => r.id === it.dataset.id);
            if (rec) openModal(rec);
        }));
    }

    // 3. View Logic
    function formatDateShort(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const options = { day: '2-digit', month: 'short', year: '2-digit' };
        // Türkçe ay adı ("11 Kas 26") — eskiden en-GB ile "11 Nov 26" yazıyordu.
        return date.toLocaleDateString('tr-TR', options);
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
        // Türkçe büyük/küçük harf: 'İlker'.toLowerCase() → 'i̇lker' (i + birleşik
        // nokta) olduğundan "ilker" araması bulamıyordu; tr-TR katlaması
        // İ→i, I→ı yapar. Sorgu da aynı katlamadan geçer.
        const lowerText = searchFold(textFilter);
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
            // Durum, ekranda görünen TÜRKÇE etiketiyle de aranır (veride
            // 'Solved' saklanıyor, kullanıcı "Tamamlandı" yazıyor). String()
            // sayı olarak kaydedilmiş oda gibi alanlarda çökmeyi önler.
            const matchesText = !textFilter || [r.guestName, r.room, r.department, r.staffInitial, r.status, r.status ? statusLabelOf(r.status) : '']
                .some(field => field != null && field !== '' && searchFold(field).includes(lowerText));
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

        if (!finalFiltered.length) {
            recordsTableBody.innerHTML = `
                <tr class="gi-empty-row"><td colspan="7">
                    <div class="gi-empty">
                        <span class="gi-empty-ico">${ic('clipboard')}</span>
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
            const noteIndicator = noteCount > 0 ? `<span class="note-indicator" title="${noteCount} güncelleme">${ic('message')} ${noteCount}</span>` : '';
            const ss = slaState(record);
            const lateBadgeStatus = status !== 'Solved' && ss.state === 'breached';
            let lateBadge = '';
            if (status !== 'Solved') {
                if (ss.state === 'breached') lateBadge = `<span class="late-warning" title="SLA (${ss.sla} dk) aşıldı">${ic('alert')} Gecikti · ${Math.round(-ss.remaining)}dk</span>`;
                else if (ss.state === 'soon') lateBadge = `<span class="sla-soon" title="SLA (${ss.sla} dk) yaklaşıyor">${ic('hourglass')} ${Math.max(0, Math.round(ss.remaining))}dk kaldı</span>`;
            }
            const escBadge = record.escalated === true ? '<span class="esc-badge" title="Yöneticiye eskale edildi">' + ic('siren') + ' Eskale</span>' : '';

            const gStatus = getGuestStatus(record.guestName);
            const gStatusLabel = gStatus === 'in_house' ? 'Otelde' : 'Çıkış yaptı';
            const gStatusClass = gStatus === 'in_house' ? 'in-house-badge' : 'checked-out-badge';

            const recurCount = recurringRelated(record, recurIdx).length;
            const recurBadge = recurCount >= 1
                ? `<span class="recurring-badge" title="Bu odada son ${RECUR_WINDOW_DAYS} günde aynı departmanda ${recurCount + 1} kayıt">${ic('repeat')} Tekrarlayan</span>`
                : '';

            // Duration cell: final total for completed work, live elapsed otherwise.
            const created = tsToDate(record.createdAt);
            const acked = tsToDate(record.acknowledgedAt);
            const done = tsToDate(record.completedAt);
            let durHtml = '<span class="dur-chip dur-none">—</span>';
            if (status === 'Solved') {
                if (created && done) durHtml = `<span class="dur-chip dur-done" title="Oluşturmadan tamamlanmaya toplam süre">${ic('check')} ${fmtDuration(done - created)}</span>`;
            } else if (status === 'InProgress' && acked) {
                durHtml = `<span class="dur-chip dur-active" title="İş üstlenileli geçen süre">${ic('timer')} ${fmtDuration(now - acked)}</span>`;
            } else if (created) {
                durHtml = `<span class="dur-chip dur-wait" title="Talep oluşturulalı geçen süre">${ic('hourglass')} ${fmtDuration(now - created)}</span>`;
            }

            // Mobil kartlarda tek dokunuşla iş akışı: bekleyen kaydı kendi
            // departmanının personeli (veya yönetici) modal açmadan üstlenir;
            // işlemdeki kaydı YALNIZ üstlenen personel veya yönetici tamamlar.
            // Masaüstünde bu hücre hiç görünmez.
            let quickAct = '';
            if (status === 'Following' && canTakeRecord(record)) {
                quickAct = `<button class="qa-btn take" data-qa="take">${ic('wrench')} İşi Üstlen</button>`;
            } else if (status === 'InProgress' && canCompleteRecord(record)) {
                quickAct = `<button class="qa-btn complete" data-qa="complete">${ic('check')} Tamamlandı</button>`;
            }
            // Üstlenilmiş iş her ekranda sahibiyle görünür — iş karışıklığı önlenir.
            const ownerBadge = (status === 'InProgress' && record.acknowledgedBy)
                ? `<span class="owner-badge">${ic('wrench')} ${esc(record.acknowledgedBy)} üstlendi</span>` : '';

            const row = document.createElement('tr');
            row.classList.add('st-' + statusClass); // mobil kartta sol durum şeridi
            if (lateBadgeStatus) row.classList.add('urgent-row');

            row.innerHTML = `
                <td class="date-cell">${formatDateShort(record.date)}</td>
                <td class="room-cell"><span>${esc(record.room)}</span></td>
                <td class="guest-cell">
                    <!-- Satır 1: ad + tür + not sayısı. Satır 2: tüm durum
                         rozetleri tek, kaydırmalı satırda (eskiden alt alta
                         5-6 rozet satırı uzatıyordu). -->
                    <div class="gc-top">
                        <strong>${esc(record.guestName)}</strong>
                        <span class="kind-badge ${record.type === 'request' ? 'req' : 'cmp'}">${record.type === 'request' ? 'Talep' : 'Şikayet'}</span>
                        ${noteIndicator}
                    </div>
                    <div class="gc-meta">
                        <span class="gstat ${gStatusClass}">${gStatusLabel}</span>
                        ${record.type === 'request' && record.assignedToName ? `<span class="gc-assign">↳ ${esc(record.assignedToName)}</span>` : ''}
                        ${ownerBadge}${recurBadge}${lateBadge}${escBadge}
                    </div>
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
        // Mobil ana menü kartlarının rozetleri aynı istatistikten beslenir.
        syncMobHome();

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
                    <div class="recur-head">${ic('repeat')} Tekrarlayan sorun · ${esc(record.room)} · ${esc(record.department)}${(record.topic && record.topic !== 'Genel') ? ' · ' + esc(record.topic) : ''}
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
                // 'reopen' EKSİKTİ — personel tamamlanmış bir QR talebini
                // yeniden açtığında misafirin ekranındaki kalem kalıcı olarak
                // 'completed'de donup kalıyordu (misafir talebi bitti sanıp
                // aktif takipten düşüyordu, personel hâlâ üzerinde çalışıyor
                // olsa bile) — bkz. QR Concierge denetimi.
                else if (action === 'reopen') syncOrderItem(r.orderId, r.itemId, 'reopen');
            }
        } catch (e) { showToast('Güncelleme başarısız: ' + e.message, true); }
    }
    // phase: 'in_progress' (iş üstlenildi) | 'completed' (iş bitti) |
    // 'reopen' (tamamlanmış iş yeniden açıldı). in_progress yalnızca
    // bekleyen/onaylı kalemi ilerletir; iptal edilmiş kaleme asla dokunmaz.
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
                    if (phase === 'reopen') {
                        return it.status === 'completed' ? Object.assign({}, it, { status: 'in_progress' }) : it;
                    }
                    // in_progress: yalnız ileri yönde (pending/confirmed → in_progress)
                    return (it.status === 'pending' || it.status === 'confirmed' || !it.status)
                        ? Object.assign({}, it, { status: 'in_progress' }) : it;
                });
                const allDone = items.length && items.every(it => it.status === 'completed' || it.status === 'cancelled');
                // Sipariş daha önce 'completed' damgalanmıştı ama bir kalem
                // 'reopen' ile geri açıldıysa artık TÜM kalemler bitmiş
                // değil — durumu 'in_progress'e geri almazsak sipariş kalıcı
                // olarak 'tamamlandı' görünmeye devam ederdi.
                let status = o.status;
                if (allDone) status = 'completed';
                else if (status === 'pending' || status === 'completed') status = 'in_progress';
                tx.update(oRef, {
                    items,
                    status,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            });
        } catch (e) { console.error('order sync', e); /* sipariş silinmiş olabilir — kritik değil */ }
    }

    // Timeline Logic
    function renderTimeline(record) {
        timelineFeed.innerHTML = '';
        const updates = record.updates || [];
        timelineFeed.classList.toggle('is-empty', updates.length === 0);
        if (!updates.length) {
            timelineFeed.innerHTML = '<div class="timeline-empty">Henüz not yok. Ekip için bir not bırakın.</div>';
        }
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
