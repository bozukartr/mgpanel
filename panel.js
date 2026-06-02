function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            auth.signOut().then(() => {
                localStorage.removeItem('hotelUsername');
                window.location.href = 'index.html';
            });
        });
    }

    // ── AUTO LOGOUT LOGIC (15 MINS) ────────────────────────────
    let logoutTimer;
    function resetLogoutTimer() {
        clearTimeout(logoutTimer);
        logoutTimer = setTimeout(() => {
            auth.signOut().then(() => {
                localStorage.removeItem('hotelUsername');
                window.location.href = 'index.html';
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
        if (!user) window.location.href = 'index.html';
    });

    // ── GUEST DIRECTORY & STATUS LOGIC ────────────────────────
    let guestDirectory = [];
    async function loadGuestDirectory() {
        try {
            const snap = await db.collection('guestDirectory').get();
            guestDirectory = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Auto Check-Out past guests
            const today = new Date().toISOString().split('T')[0];
            const batch = db.batch();
            let needsCommit = false;

            guestDirectory.forEach(g => {
                if (g.status === 'in_house' && g.checkOut && g.checkOut < today) {
                    batch.update(db.collection('guestDirectory').doc(g.id), { status: 'checked_out' });
                    g.status = 'checked_out';
                    needsCommit = true;
                }
            });

            if (needsCommit) await batch.commit();

            renderGuestProfileList();
        } catch (e) { console.error("Error loading directory", e); }
    }

    async function syncGuestStatus(name, room, status = 'in_house') {
        if (!name) return;
        const normalized = name.trim();
        const existing = guestDirectory.find(g => g.name.toLowerCase() === normalized.toLowerCase());

        if (!existing) {
            const newGuest = {
                name: normalized,
                room: room || '',
                status: status,
                lastUpdated: new Date().toISOString()
            };
            const docRef = await db.collection('guestDirectory').add(newGuest);
            guestDirectory.push({ id: docRef.id, ...newGuest });
        } else {
            // Force status update and update room number if they changed
            if (existing.status !== status || existing.room !== room) {
                const updates = {
                    status: status,
                    room: room || existing.room,
                    lastUpdated: new Date().toISOString()
                };
                await db.collection('guestDirectory').doc(existing.id).update(updates);

                // Update local state
                existing.status = 'in_house';
                existing.room = room || existing.room;
                existing.lastUpdated = updates.lastUpdated;

                renderGuestProfileList();
                updateView(globalSearch.value, dateSearch.value);
            }
        }
    }

    function getGuestStatus(name) {
        const guest = guestDirectory.find(g => g.name.toLowerCase() === (name || '').toLowerCase());
        return guest ? guest.status : 'in_house';
    }

    loadGuestDirectory();

    // ── LEGACY SYNC: Backfill directory from existing logs ──
    async function backfillGuestDirectory() {
        if (!records.length) return;

        try {
            // Load all current reservations to include concierge-only guests
            const resSnap = await db.collection('reservations').get();
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
                    room: g.room || '',
                    status: 'checked_out', // Assume historical ones are checked out
                    lastUpdated: new Date().toISOString()
                };
                batch.set(newRef, data);
                guestDirectory.push({ id: newRef.id, ...data });
            });

            await batch.commit();
            renderGuestProfileList();
            updateGuestMap();
            showToast(`${guestsToAdd.length} legacy guests added to registry.`);
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
    exportDataBtn?.addEventListener('click', async () => {
        try {
            const logsSnap = await db.collection('guestLogs').get();
            const resSnap = await db.collection('reservations').get();

            const fullBackup = {
                guestLogs: logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                reservations: resSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                backupDate: new Date().toISOString(),
                version: "2.0"
            };

            const blob = new Blob([JSON.stringify(fullBackup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Full_System_Backup_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Full system backup exported.');
        } catch (e) { showToast('Export failed', true); }
    });

    // IMPORT: JSON (Full System Restore)
    if (!isAdminUser) {
        if (importDataBtn) importDataBtn.style.display = 'none';
    }

    importDataBtn?.addEventListener('click', () => {
        if (!isAdminUser) {
            return showToast('Only Admin can import backups.', true);
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

                // Case 1: New Unified Backup Format
                if (data.guestLogs || data.reservations) {
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
                showToast(`Import Success: ${logCount} logs, ${resCount} reservations.`);
                e.target.value = '';
            } catch (err) { showToast('Import failed: ' + err.message, true); }
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
        const date = document.getElementById('mob-date')?.value;
        const room = document.getElementById('mob-room')?.value?.trim();
        const guestName = document.getElementById('mob-guestName')?.value?.trim();
        const department = document.getElementById('mob-department')?.value;
        const complaint = document.getElementById('mob-complaint')?.value?.trim();
        const solution = document.getElementById('mob-solution')?.value?.trim();

        if (!date || !room || !guestName) {
            showToast('Date, Room and Guest Name are required.', true);
            return;
        }

        try {
            await syncGuestStatus(guestName, room);
            await db.collection('guestLogs').add({
                date, room, guestName, department,
                complaint: complaint || '',
                solution: solution || '',
                staffInitial: loggedUsername,
                status: 'Following',
                updates: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            // Reset & close
            ['mob-date', 'mob-room', 'mob-guestName', 'mob-complaint', 'mob-solution'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            closeMobSheet();
            showToast('Issue logged successfully.');
        } catch (err) {
            showToast('Error: ' + err.message, true);
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

    let records = [];
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
    const fetchRecords = () => {
        db.collection('guestLogs').orderBy('createdAt', 'desc').onSnapshot(snapshot => {
            records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateGuestMap();
            updateView(globalSearch.value, dateSearch.value);

            // Trigger backfill check
            if (guestDirectory.length >= 0) backfillGuestDirectory();

            // Sync selectedRecord to avoid undefined errors in editNote
            if (selectedRecord) {
                const refreshed = records.find(r => r.id === selectedRecord.id);
                if (refreshed) {
                    selectedRecord = refreshed; // Sync variable
                    renderTimeline(refreshed);  // Refresh UI
                }
            }
        });
    };
    fetchRecords();

    // Guest auto-fill logic
    document.getElementById('guestName')?.addEventListener('input', (e) => {
        const g = guestDirectory.find(x => x.name === e.target.value);
        if (g && g.room) document.getElementById('room').value = g.room;
    });
    document.getElementById('mob-guestName')?.addEventListener('input', (e) => {
        const g = guestDirectory.find(x => x.name === e.target.value);
        if (g && g.room) document.getElementById('mob-room').value = g.room;
    });

    issueForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const formData = {
                date: document.getElementById('date').value,
                room: document.getElementById('room').value,
                guestName: document.getElementById('guestName').value,
                department: document.getElementById('department').value,
                complaint: document.getElementById('complaint').value,
                solution: document.getElementById('solution').value,
                staffInitial: document.getElementById('staffInitial').value,
                status: 'Following',
                updates: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            await syncGuestStatus(formData.guestName, formData.room);
            await db.collection('guestLogs').add(formData);
            issueForm.reset();
            staffInitialInput.value = loggedUsername;
            document.getElementById('date').valueAsDate = new Date();
            document.getElementById('successModal').style.display = 'flex';
        } catch (err) {
            showToast('Error: ' + err.message, true);
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
        updateRptUI(); // Reset UI state on open
    });

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

        // Reset all
        specificDateCont.style.display = 'none';
        rangeGroup.style.display = 'none';
        deptCont.style.display = 'none';
        guestCont.style.display = 'none';

        // Show based on type
        if (type === 'summary' || type === 'byDate' || type === 'department') {
            specificDateCont.style.display = 'block';
            if (type === 'department') deptCont.style.display = 'block';
        } else if (type === 'dateRange' || type === 'historicalStatus' || type === 'deptHistorical' || type === 'status') {
            rangeGroup.style.display = 'flex';
            if (type === 'deptHistorical') deptCont.style.display = 'block';
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
            guest: document.getElementById('rpt-guestSearch')?.value || ''
        };
    }

    function filterByRange(data, from, to) {
        return data.filter(r => {
            if (from && r.date < from) return false;
            if (to && r.date > to) return false;
            return true;
        });
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
            Status: r.status || 'Following'
        };
    }

    // ── Excel Helpers ──────────────────────────────────────────

    function exportExcel(rows, filename, sheetName = 'Report', summaryData = null) {
        if (!rows || rows.length === 0) return showToast('No data for this report.', true);

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

        showToast('Styled Excel report downloaded.');
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
        if (!rows || rows.length === 0) return showToast('No data for this report.', true);
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
        showToast('PDF report downloaded.');
    }

    // ── Report Engine ──────────────────────────────────────────
    window.generateReport = function (type, format) {
        const { from, to, specific, dept, guest } = getRptDates();

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
                showToast('Excel report downloaded.');
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
                const rows = data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 35), r.staffInitial, r.status || 'Following']);
                exportPDF('In-House Guest Issues', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Status'], rows, 'In_House_Issues',
                    `Total Active In-House Issues: ${data.length} | ` + Object.entries(deptSummary).map(([d, c]) => `${d}:${c}`).join(' | '));
            }
        }

        else if (type === 'department') {
            const date = specific || getLocalDate();
            let data = records.filter(r => r.date === date);
            if (dept !== 'All') data = data.filter(r => r.department === dept);

            const grouped = {};
            data.forEach(r => {
                const d = r.department || 'Unknown';
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
                showToast('Excel report downloaded.');
            } else {
                const rows = Object.entries(grouped).flatMap(([d, arr]) =>
                    arr.map(r => [d, r.date, r.room, r.guestName, r.complaint?.substring(0, 40), r.status || 'Following'])
                );
                exportPDF(`Issues by Department (${dept})`, ['Department', 'Date', 'Room', 'Guest', 'Complaint', 'Status'], rows, `By_Department_${dept}`);
            }
        }

        else if (type === 'byDate') {
            const date = specific || getLocalDate();
            const data = records.filter(r => r.date === date);
            if (format === 'excel') exportExcel(data.map(rowBase), `Issues_${date}`, date);
            else exportPDF(`Issues — ${date}`, ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Status'],
                data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 40), r.staffInitial, r.status || 'Following']),
                `Issues_${date}`);
        }

        else if (type === 'dateRange') {
            if (!from || !to) return showToast('Please set From and To dates.', true);
            const data = filterByRange(records, from, to);
            if (format === 'excel') exportExcel(data.map(rowBase), `Issues_${from}_to_${to}`, 'Date Range');
            else exportPDF(`Issues: ${from} → ${to}`, ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Status'],
                data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 40), r.staffInitial, r.status || 'Following']),
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
                showToast('Excel report downloaded.');
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
                showToast('Excel report downloaded.');
            } else {
                const rows = data.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 35), r.status || 'Following']);
                exportPDF('Issues by Status', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Status'], rows, 'By_Status',
                    `Total: ${data.length} | Solved: ${solved.length} | Following: ${following.length}`);
            }
        }

        else if (type === 'historicalStatus') {
            if (!from || !to) return showToast('Please set From and To dates.', true);
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
                showToast('Excel report downloaded.');
            } else {
                const rows = dailyRows.map(d => [d.date, d.total, d.solved, d.following, d.overdue]);
                exportPDF(`Historical + Status: ${from} → ${to}`, ['Date', 'Total', 'Solved', 'Following', 'Overdue'], rows,
                    `Historical_Status_${from}_${to}`);
            }
        }

        else if (type === 'deptHistorical') {
            let data = (from || to) ? filterByRange(records, from, to) : records;
            if (dept !== 'All') data = data.filter(r => r.department === dept);

            const matrix = {};
            data.forEach(r => {
                const d = r.department || 'Unknown';
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
            if (lastRenderedRows.length === 0) return showToast('No visible records to export.', true);
            if (format === 'excel') exportExcel(lastRenderedRows.map(rowBase), 'Current_View', 'Filtered');
            else {
                const rows = lastRenderedRows.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 40), r.staffInitial, r.status || 'Following']);
                exportPDF('Current Filtered View', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Status'], rows, 'Current_View');
            }
        }

        else if (type === 'fullArchive') {
            if (format === 'excel') exportExcel(records.map(rowBase), 'Full_Archive', 'Archive');
            else {
                const rows = records.map(r => [r.date, r.room, r.guestName, r.department, r.complaint?.substring(0, 35), r.staffInitial, r.status || 'Following']);
                exportPDF('Full Archive — All Records', ['Date', 'Room', 'Guest', 'Department', 'Complaint', 'Staff', 'Status'], rows, 'Full_Archive',
                    `Total Records: ${records.length}`);
            }
        }
    };

    function isOverdueFn(record) {
        if (!record.createdAt || record.status === 'Solved') return false;
        const t = record.createdAt.toDate ? record.createdAt.toDate() : new Date(record.createdAt);
        return (Date.now() - t) / 60000 > 15;
    }

    const triggerSearch = () => updateView(globalSearch.value, dateSearch.value);
    globalSearch.addEventListener('input', triggerSearch);
    dateSearch.addEventListener('change', triggerSearch);

    let activeStatusFilter = null;
    document.getElementById('filterTotal').addEventListener('click', () => { activeStatusFilter = null; triggerSearch(); });
    document.getElementById('filterFollowing').addEventListener('click', () => { activeStatusFilter = 'Following'; triggerSearch(); });
    document.getElementById('filterSolved').addEventListener('click', () => { activeStatusFilter = 'Solved'; triggerSearch(); });
    document.getElementById('filterOverdue').addEventListener('click', () => { activeStatusFilter = 'Overdue'; triggerSearch(); });

    resetFilters.addEventListener('click', () => {
        globalSearch.value = '';
        dateSearch.value = getLocalDate();
        activeStatusFilter = null;
        updateView(globalSearch.value, dateSearch.value);
    });

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
            guestProfileList.innerHTML = '<p style="padding:20px; text-align:center; color:#888;">No guests found.</p>';
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
                    <div style="font-size: 12px; color: #888;">Room: ${esc(guest.room || 'N/A')} • <span style="color:${isInHouse ? '#27ae60' : '#7f8c8d'}; font-weight:700;">${esc(guest.status.replace('_', ' ').toUpperCase())}</span></div>
                </div>
                <button onclick="toggleGuestStatus('${guest.id}', '${guest.status === 'in_house' ? 'checked_out' : 'in_house'}')"
                        style="padding: 6px 12px; border-radius: 4px; border: none; font-size: 11px; font-weight: 700; cursor: pointer; 
                               background: ${isInHouse ? '#fef2f2' : '#f0fdf4'}; color: ${isInHouse ? '#991b1b' : '#166534'};">
                    ${isInHouse ? 'CHECK OUT' : 'SET IN-HOUSE'}
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
            showToast(`Guest marked as ${newStatus.replace('_', ' ')}`);
        } catch (e) { showToast('Update failed', true); }
    };

    profileSearchInput?.addEventListener('input', renderGuestProfileList);

    window.selectGuestProfile = function (name) {
        guestProfileModal.style.display = 'none';
        globalSearch.value = name;
        dateSearch.value = ''; // clear date to show all history
        activeStatusFilter = null;
        triggerSearch();
    };


    // 3. View Logic
    function formatDateShort(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const options = { day: '2-digit', month: 'short', year: '2-digit' };
        return date.toLocaleDateString('en-GB', options).replace(/ /g, ' ');
    }

    // Helper: Check if record is older than 15 minutes
    function isOverdue(record) {
        if (!record.createdAt || record.status === 'Solved') return false;
        const createdTime = record.createdAt.toDate ? record.createdAt.toDate() : new Date(record.createdAt);
        const diffMinutes = (new Date() - createdTime) / (1000 * 60);
        return diffMinutes > 15;
    }

    function updateView(textFilter = '', dateFilter = '') {
        recordsTableBody.innerHTML = '';
        const lowerText = textFilter.toLowerCase();
        let stats = { total: 0, following: 0, solved: 0, overdue: 0 };

        const tableTitle = document.getElementById('tableTitle');
        if (tableTitle) {
            if (dateFilter) {
                const today = getLocalDate();
                tableTitle.textContent = (dateFilter === today) ? "Today's Logs" : "Logs for " + formatDateShort(dateFilter);
            } else {
                tableTitle.textContent = "All Logs";
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
                stats.following++;
                if (isOverdue(record)) stats.overdue++;
            }
        });

        const finalFiltered = filtered.filter(r => {
            if (!activeStatusFilter) return true;
            if (activeStatusFilter === 'Overdue') return r.status !== 'Solved' && isOverdue(r);
            return r.status === activeStatusFilter;
        });

        lastRenderedRows = finalFiltered;

        finalFiltered.forEach(record => {
            const status = record.status || 'Following';
            const statusClass = status.toLowerCase();
            const noteCount = record.updates ? record.updates.length : 0;
            const noteIndicator = noteCount > 0 ? `<span class="note-indicator" title="${noteCount} updates">💬 ${noteCount}</span>` : '';
            const lateBadgeStatus = status !== 'Solved' && isOverdue(record);
            const lateBadge = lateBadgeStatus ? '<span class="late-warning" title="Pending more than 15 minutes">⚠️ Late</span>' : '';

            const gStatus = getGuestStatus(record.guestName);
            const gStatusLabel = gStatus === 'in_house' ? 'IN HOUSE' : 'CHECKED OUT';
            const gStatusClass = gStatus === 'in_house' ? 'in-house-badge' : 'checked-out-badge';

            const row = document.createElement('tr');
            if (lateBadgeStatus) row.classList.add('urgent-row');

            row.innerHTML = `
                <td class="date-cell">${formatDateShort(record.date)}</td>
                <td class="room-cell"><span>${esc(record.room)}</span></td>
                <td class="guest-cell">
                    <div style="display:flex; flex-direction:column;">
                        <strong>${esc(record.guestName)} ${noteIndicator}</strong>
                        <span class="${gStatusClass}" style="font-size:9px; font-weight:800; width:fit-content; margin-top:2px;">${gStatusLabel}</span>
                    </div>
                    ${lateBadge}
                </td>
                <td><span class="dept-badge">${esc(record.department)}</span></td>
                <td class="staff-cell">${esc(record.staffInitial)}</td>
                <td><span class="status-badge ${statusClass}">${esc(status)}</span></td>
            `;
            row.onclick = () => openModal(record);
            recordsTableBody.appendChild(row);
        });

        // Update Stats Dashboard UI
        if (document.getElementById('statTotal')) document.getElementById('statTotal').textContent = stats.total;
        if (document.getElementById('statFollowing')) document.getElementById('statFollowing').textContent = stats.following;
        if (document.getElementById('statSolved')) document.getElementById('statSolved').textContent = stats.solved;
        if (document.getElementById('statOverdue')) document.getElementById('statOverdue').textContent = stats.overdue;

        recordCountElement.textContent = finalFiltered.length;
    }

    function openModal(record) {
        selectedRecord = record;
        editingId = record.id;
        modalGuestRoom.textContent = `${record.guestName} - Room ${record.room}`;
        modalDept.textContent = record.department;
        modalDesc.innerHTML = `<strong>Complaint:</strong> ${esc(record.complaint)}<br><strong>Solution:</strong> ${esc(record.solution)}`;

        updateStatusBadge(record.status || 'Following');
        renderTimeline(record);

        modalViewMode.style.display = 'block';
        modalEditForm.style.display = 'none';
        modal.style.display = 'flex';

        // Bind Status Update Buttons
        document.getElementById('setFollowingBtn').onclick = () => updateRecordStatus('Following');
        document.getElementById('setSolvedBtn').onclick = () => updateRecordStatus('Solved');

        document.getElementById('emailModalBtn').onclick = () => draftEmail(record);
        document.getElementById('editModalBtn').onclick = () => startModalEdit(record);
        document.getElementById('deleteModalBtn').onclick = () => {
            if (record.staffInitial !== loggedUsername) {
                showToast('Only the creator can delete this log!', true);
                return;
            }
            recordToDelete = record.id;
            confirmModal.style.display = 'flex';
        };
    }

    function updateStatusBadge(status) {
        modalStatusBadge.textContent = status;
        modalStatusBadge.className = 'status-badge ' + status.toLowerCase();
    }

    async function updateRecordStatus(newStatus) {
        try {
            await db.collection('guestLogs').doc(editingId).update({ status: newStatus });
            updateStatusBadge(newStatus); // Immediate UI update
            showToast(`Status updated to ${newStatus}`);
        } catch (e) { showToast('Update failed', true); }
    }

    // Timeline Logic
    function renderTimeline(record) {
        timelineFeed.innerHTML = '';
        const updates = record.updates || [];
        updates.forEach((note, index) => {
            const item = document.createElement('div');
            item.className = 'timeline-item';
            item.id = `note-${index}`;
            const isOwner = note.user === loggedUsername;

            item.innerHTML = `
                <div class="timeline-header">
                    <span class="timeline-author">${esc(note.user)} ${note.isEdited ? '<span class="edited-tag">(edited)</span>' : ''}</span>
                    <span class="timeline-time">${esc(note.time)}</span>
                </div>
                <div class="timeline-body">
                    <div class="timeline-text">${esc(note.text)}</div>
                </div>
                ${isOwner ? `
                <div class="timeline-actions">
                    <button class="timeline-edit-btn" onclick="startInlineEdit(${index})">Edit</button>
                    <button class="timeline-delete-btn" onclick="deleteNote(${index})">Delete</button>
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
            <span class="confirm-msg">Delete?</span>
            <button class="timeline-confirm-btn" onclick="confirmDeleteNote(${index})">Yes</button>
            <button class="timeline-cancel-btn" onclick="renderTimeline(selectedRecord)">No</button>
        `;
    };

    window.confirmDeleteNote = async (index) => {
        const updatedUpdates = [...selectedRecord.updates];
        updatedUpdates.splice(index, 1);
        await db.collection('guestLogs').doc(editingId).update({ updates: updatedUpdates });
        showToast('Note removed.');
    };

    window.startInlineEdit = (index) => {
        const item = document.getElementById(`note-${index}`);
        const body = item.querySelector('.timeline-body');
        const originalText = selectedRecord.updates[index].text;

        body.innerHTML = `
            <div class="inline-edit-area">
                <textarea id="edit-note-input-${index}" class="inline-textarea">${esc(originalText)}</textarea>
                <div class="inline-actions">
                    <button class="inline-save-btn" onclick="saveInlineEdit(${index})">Save</button>
                    <button class="inline-cancel-btn" onclick="cancelInlineEdit(${index})">Cancel</button>
                </div>
            </div>
        `;
        item.querySelector('.timeline-actions').style.display = 'none';
    };

    window.cancelInlineEdit = (index) => renderTimeline(selectedRecord);

    window.saveInlineEdit = async (index) => {
        const newText = document.getElementById(`edit-note-input-${index}`).value.trim();
        if (newText && newText !== selectedRecord.updates[index].text) {
            const updatedUpdates = [...selectedRecord.updates];
            updatedUpdates[index] = { ...updatedUpdates[index], text: newText, isEdited: true };
            await db.collection('guestLogs').doc(editingId).update({ updates: updatedUpdates });
            showToast('Note updated.');
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
        const updatedUpdates = [...(selectedRecord.updates || []), newNote];
        await db.collection('guestLogs').doc(editingId).update({ updates: updatedUpdates });
        noteInput.value = '';
    };

    function startModalEdit(record) {
        document.getElementById('editDate').value = record.date;
        document.getElementById('editRoom').value = record.room;
        document.getElementById('editGuestName').value = record.guestName;
        document.getElementById('editDepartment').value = record.department;
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
            complaint: document.getElementById('editComplaint').value,
            solution: document.getElementById('editSolution').value,
            staffInitial: document.getElementById('editStaffInitial').value,
            status: document.getElementById('editStatus').value
        };
        await db.collection('guestLogs').doc(editingId).update(updatedData);
        closeModalFunc();
        showToast('Changes saved.');
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
