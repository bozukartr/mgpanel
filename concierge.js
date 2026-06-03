/* concierge.js — Concierge Logic */

// Escapes user-supplied text before it is inserted into innerHTML, preventing stored XSS.
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Maintenance enforcement — also runs here (not only in maintenance-guard.js) so it
// works even if a cached page didn't load the guard script.
(function () {
    if (typeof db === 'undefined') return;
    db.collection('systemConfig').doc('maintenance').onSnapshot((doc) => {
        if (!doc.exists) return;
        const d = doc.data();
        const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
        if (d.enabled && ends && ends > new Date()) window.location.replace('maintenance.html');
    }, function () {});
})();

document.addEventListener('DOMContentLoaded', () => {

    // ── AUTH ───────────────────────────────────────────────────
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    const loggedRole = (localStorage.getItem('hotelRole') || '').toLowerCase();
    const isAdminUser = loggedRole === 'admin' || loggedUsername.toLowerCase() === 'admin';
    if (!loggedUsername) { window.location.href = 'index.html'; return; }
    auth.onAuthStateChanged(async (u) => {
        if (!u) {
            window.location.href = 'index.html';
        } else {
            // Doğrudan Firestore'dan güncel yetkiyi çek
            try {
                const doc = await db.collection('systemUsers').doc(u.uid).get();
                if (doc.exists) {
                    const data = doc.data();
                    const role = (data.role || '').toLowerCase();
                    const uname = (data.username || '').toLowerCase();

                    // Keep localStorage role fresh so other pages (admin, panel) gate correctly.
                    if (data.role) localStorage.setItem('hotelRole', data.role);

                    // Admin sekmesi: admin rolündeki (veya "admin" kullanıcı adlı) herkese
                    if (role === 'admin' || uname === 'admin') {
                        if (document.getElementById('c-adminNav')) document.getElementById('c-adminNav').style.display = 'flex';
                        if (document.getElementById('c-adminNavMobile')) document.getElementById('c-adminNavMobile').style.display = 'flex';
                    }

                    // Finans butonu admin ve manager rollerine
                    if (role === 'admin' || role === 'manager' || uname === 'admin') {
                        if (document.getElementById('c-openFinance')) document.getElementById('c-openFinance').style.display = 'flex';
                    }
                }
            } catch (e) { console.error("Auth error", e); }
        }
    });

    document.querySelectorAll('.app-username').forEach(el => el.textContent = loggedUsername);

    document.getElementById('c-logoutBtn')?.addEventListener('click', () => {
        auth.signOut().then(() => {
            localStorage.removeItem('hotelUsername');
            window.location.href = 'index.html';
        });
    });

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

    // Reset only on functional clicks (buttons, cards, inputs, etc.)
    document.addEventListener('click', (e) => {
        const isInteractive = e.target.closest('button, input, select, textarea, a, .res-card, .stat-pill, .nav-btn, .app-icon-btn, .sheet-backdrop, .sheet-pill');
        if (isInteractive) resetLogoutTimer();
    }, true);

    resetLogoutTimer(); // Start timer on load

    // ── BACKUP LOGIC (JSON IMPORT/EXPORT) ──────────────────────
    const backupToggleBtn = document.getElementById('c-backupToggleBtn');
    const backupMenu = document.getElementById('c-backupMenu');
    const exportDataBtn = document.getElementById('c-exportDataBtn');
    const importDataBtn = document.getElementById('c-importDataBtn');
    const importFileInput = document.getElementById('c-importFileInput');

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
            const dirSnap = await db.collection('guestDirectory').get();

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
                let dirCount = 0;

                // Case 1: Unified Backup Format
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
                showToast(`Import Success: ${logCount} logs, ${resCount} res, ${dirCount} CRM profiles.`);
                e.target.value = '';
                setTimeout(() => window.location.reload(), 1500);
            } catch (err) { showToast('Import failed: ' + err.message, true); }
        };
        reader.readAsText(file);
    });

    // ── CONFIG ────────────────────────────────────────────────
    const SERVICE_ICONS = {
        'Restaurant': '🍽️',
        'Beach': '🏖️',
        'Transfer': '🚗',
        'Flower': '🌸',
        'Cake': '🎂',
        'Boat': '🛥️',
        'Tour': '🗺️',
        'Other': '✨'
    };

    // ── STATE ─────────────────────────────────────────────────
    let reservations = [];
    let filteredReservations = [];
    let guestMap = {}; // { guestName: roomNumber }
    let statusFilter = null; // 'Pending' or 'Confirmed'
    window.selectedReservation = null;

    // ── HELPERS ───────────────────────────────────────────────
    const showToast = (msg, isError = false) => {
        const t = document.getElementById('c-toast');
        t.textContent = msg;
        t.className = 'app-toast show' + (isError ? ' error' : '');
        setTimeout(() => t.classList.remove('show'), 2800);
    };

    const openSheet = (s, b) => { s.classList.add('open'); b.classList.add('open'); };
    const closeSheet = (s, b) => { s.classList.remove('open'); b.classList.remove('open'); };

    // ── PASSIVE INLINE COLLISION WARNING SYSTEM ──
    // Passively scans cached reservations in real-time as inputs mutate. Does NOT block save.
    const checkConflictInline = () => {
        const alertEl = document.getElementById('rs-conflict-alert');
        if (!alertEl) return;

        const guestName = document.getElementById('rs-guest').value.trim();
        const time = document.getElementById('rs-time').value;
        const rawD = document.getElementById('rs-date').value;

        // Insufficient information to run logic
        if (!guestName || !time || !rawD) {
            alertEl.style.display = 'none';
            return;
        }

        // Match data in standard persisted format
        const date = toIsoDate(smartExpandDate(rawD)); 
        const entryMins = parseTimeToMins(time);

        const conflicts = reservations.filter(r => {
            if (editResId && r.id === editResId) return false; // exclude self
            if (r.status === 'Cancelled') return false;
            if (r.date !== date || !r.time) return false;
            if (r.guestName.trim().toLowerCase() !== guestName.toLowerCase()) return false;

            const existingMins = parseTimeToMins(r.time);
            return entryMins !== null && existingMins !== null && Math.abs(entryMins - existingMins) <= 120;
        });

        if (conflicts.length > 0) {
            const markup = conflicts.map(c => `&bull; <b>${esc(c.type)}</b> (${esc(c.time)})`).join('<br>');
            alertEl.innerHTML = `
                <div style="font-weight:bold; display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                    ⚠️ YAKIN SAATTE BAŞKA KAYIT VAR
                </div>
                <div style="opacity:0.9; font-size:11.5px;">Bu misafirin ±2 saat diliminde şu kayıtları mevcut:<br>${markup}</div>
            `;
            alertEl.style.display = 'block';
        } else {
            alertEl.style.display = 'none';
        }
    };

    const resetConflictAlert = () => {
        const box = document.getElementById('rs-conflict-alert');
        if (box) box.style.display = 'none';
        // Notice: Submit button is static, no need to manipulate colors anymore
    };

    // Global Helpers & Universal Formats
    const fmtDate = (d) => {
        if (!d) return '';
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return d;
        const dd = String(dt.getDate()).padStart(2, '0');
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        const yyyy = dt.getFullYear();
        return `${dd}/${mm}/${yyyy}`; // Global Standard Set
    };

    // Realtime UI Input Converter Utilities (View <-> Persisted Storage)
    const toIsoDate = (val) => {
        if (!val) return '';
        const p = val.split('/');
        if (p.length === 3) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
        return val;
    };
    const toDisplayDate = (iso) => {
        if (!iso) return '';
        const p = iso.split('-');
        if (p.length === 3) return `${p[2]}/${p[1]}/${p[0]}`;
        return iso;
    };
    // Converts 'HH:MM' strings into an absolute integer count of minutes from midnight for math
    const parseTimeToMins = (t) => {
        if (!t || !t.includes(':')) return null;
        const p = t.split(':');
        return (parseInt(p[0]) * 60) + parseInt(p[1] || 0);
    };

    // Dynamic Smart Reactive Masking Logic (Time only now, Date uses Expansion on Blur)
    function initMask(id, type) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', (e) => {
            let val = e.target.value.replace(/\D/g, '');
            let formatted = val;
            if (type === 'time') {
                if (val.length > 4) val = val.slice(0, 4);
                if (val.length > 2) formatted = val.slice(0, 2) + ':' + val.slice(2);
            }
            e.target.value = formatted;
        });
    }

    // High-End Predictive Date Expansion Engine (Handles ALL abbreviations flawlessly)
    function smartExpandDate(raw) {
        if (!raw) return raw;
        const currentYear = new Date().getFullYear();

        // OPTION 1: EXPLICIT AMBIGUITY RESOLVER (Uses dots or slashes to strictly interpret)
        // Example: "11.2" -> "11/02/2026"
        let delimiter = raw.includes('/') ? '/' : (raw.includes('.') ? '.' : null);
        if (delimiter) {
            const p = raw.split(delimiter).map(i => i.trim()).filter(i => i !== "");
            if (p.length === 2) { // Manual overrides automatically append current year
                let d = String(parseInt(p[0])).padStart(2, '0');
                let m = String(parseInt(p[1])).padStart(2, '0');
                if (parseInt(d) <= 31 && parseInt(m) <= 12) return `${d}/${m}/${currentYear}`;
            } else if (p.length === 3) { // Full segmented date normalization
                let d = String(parseInt(p[0])).padStart(2, '0');
                let m = String(parseInt(p[1])).padStart(2, '0');
                let y = p[2];
                if (y.length === 2) y = "20" + y;
                return `${d}/${m}/${y}`;
            }
        }

        // OPTION 2: CONSECUTIVE NUMERICAL EXPANDER
        const s = raw.replace(/\D/g, '');
        if (s.length < 4 || s.length > 8) return raw;

        let d, m, y;
        if (s.length === 8) {
            // Fully typed: 15052026
            d = s.slice(0, 2); m = s.slice(2, 4); y = s.slice(4);
        } else if (s.length === 6) {
            // UNAMBIGUOUS 6 DIGIT FALLBACK: 110226 -> 11/02/2026
            d = s.slice(0, 2); m = s.slice(2, 4); y = "20" + s.slice(4);
        } else {
            // Shorthand prioritized heuristics
            y = "20" + s.slice(-2);
            const rest = s.slice(0, -2);
            
            if (rest.length === 2) { // 6726 -> 06/07
                d = rest[0]; m = rest[1];
            } else if (rest.length === 3) {
                // The requested "11226" vs "12826" scenario resolution
                const lastTwo = parseInt(rest.slice(1));
                if (lastTwo <= 12 && lastTwo > 0) {
                    // Right-dominant Month priority logic (Matches explicitly requested 11226 -> Month 12)
                    m = rest.slice(1); d = rest[0];
                } else {
                    // Fallback logic (Matches explicitly requested 12826 -> Month 8)
                    m = rest[2]; d = rest.slice(0, 2);
                }
            } else {
                return raw;
            }
        }

        // Final Format Validations
        d = String(parseInt(d)).padStart(2, '0');
        m = String(parseInt(m)).padStart(2, '0');
        const dayNum = parseInt(d); const monNum = parseInt(m);
        if (dayNum > 31 || dayNum < 1 || monNum > 12 || monNum < 1) return raw; 
        
        return `${d}/${m}/${y}`;
    }

    // ── DATA SYNC ─────────────────────────────────────────────
    let guestDirectory = [];

    // Load Guest Directory for Global Autocomplete
    db.collection('guestDirectory').onSnapshot(snap => {
        guestDirectory = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // Auto Check-Out past guests
        const today = new Date().toISOString().split('T')[0];
        const batch = db.batch();
        let needsCommit = false;

        guestDirectory.forEach(g => {
            if (g.status === 'in_house' && g.checkOut && g.checkOut < today) {
                batch.update(db.collection('guestDirectory').doc(g.id), { status: 'checked_out' });
                needsCommit = true;
            }
        });

        if (needsCommit) batch.commit().catch(e => console.error("Auto-checkout error", e));

        updateAutocompletes();
    });

    db.collection('reservations').orderBy('date', 'asc').onSnapshot(snap => {
        reservations = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Update Guest Map for Autocomplete
        guestMap = {};
        reservations.forEach(r => { if (r.guestName && r.room) guestMap[r.guestName] = r.room; });
        updateAutocompletes();

        if (dateFilterFp) dateFilterFp.redraw();
        renderReservations();
        if (window.selectedReservation) {
            const up = reservations.find(r => r.id === window.selectedReservation.id);
            if (up) {
                window.selectedReservation = up; // Update global state with latest data
                populateDetail(up);
            }
        }
    });

    let allGuestOptionsHTML = ''; // Cached system guests
    let reportsGuestHTML = '';    // Cached reports names

    function updateAutocompletes() {
        // Collate unique list of searchable guest names
        const namesSet = new Set([...Object.keys(guestMap), ...guestDirectory.map(g => g.name)]);
        const names = Array.from(namesSet).sort();

        allGuestOptionsHTML = names.map(n => {
            const room = guestDirectory.find(g => g.name === n)?.room || guestMap[n] || '';
            return `<option value="${esc(n)}">${esc(room)}</option>`;
        }).join('');
        
        // Push live sync to active datalists only if they are currently visible/inflated
        ['guest-list', 'iti-guest-list'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.children.length > 0) el.innerHTML = allGuestOptionsHTML;
        });
    }

    // ── SMART AUTOCOMPLETE ENGINE ──────────────────────────────
    // Throttles population to suppress native dropdown until 3 chars typed
    function setupDynamicAutolist(inputId, listId, type = 'general') {
        const inputEl = document.getElementById(inputId);
        const listEl = document.getElementById(listId);
        if (!inputEl || !listEl) return;

        // Ensure initially absolutely empty to prevent browser instant pop-down
        listEl.innerHTML = '';

        inputEl.addEventListener('input', (e) => {
            const cleanVal = e.target.value.trim();
            if (cleanVal.length >= 3) {
                // Inflate only on crossover to prevent CPU thrashing
                if (listEl.children.length === 0) {
                    listEl.innerHTML = (type === 'reports') ? reportsGuestHTML : allGuestOptionsHTML;
                }
            } else {
                // Purge on underflow to completely hide the component
                listEl.innerHTML = ''; 
            }
        });
    }

    // Activate throttling on all 3 key entry inputs
    setupDynamicAutolist('rs-guest', 'guest-list');
    setupDynamicAutolist('iti-guest-search', 'iti-guest-list');
    setupDynamicAutolist('rpt-guestSearch', 'guestNamesList', 'reports');

    // Instantly analyze and project passive conflict warnings as fields evolve
    ['rs-guest', 'rs-date', 'rs-time'].forEach(id => {
        const target = document.getElementById(id);
        if (target) {
            target.addEventListener('input', checkConflictInline);
            target.addEventListener('blur', checkConflictInline);
        }
    });

    // Auto-fill Details & Sync Pre-Arrival state when guest name is selected from directory
    document.getElementById('rs-guest')?.addEventListener('input', (e) => {
        const name = e.target.value.trim();
        const found = guestDirectory.find(g => g.name.toLowerCase() === name.toLowerCase());
        const paCheckbox = document.getElementById('rs-isPreArrival');
        const roomInput = document.getElementById('rs-room');
        const datesWrapper = document.getElementById('rs-dates-wrapper');
        const checkInInput = document.getElementById('rs-checkIn');
        const checkOutInput = document.getElementById('rs-checkOut');

        if (found) {
            const isPreArrival = found.status === 'pre_arrival' || found.room === 'Pre-Arrival';
            
            paCheckbox.checked = isPreArrival;
            roomInput.disabled = isPreArrival;

            if (isPreArrival) {
                roomInput.value = 'Pre-Arrival'; // Set visually clear value
                document.getElementById('rs-pa-box').style.display = 'none'; // Hide the ENTIRE outer wrapper box
                
                // Sync existing dates silently from directory
                if (found.checkIn) checkInInput.value = found.checkIn;
                if (found.checkOut) checkOutInput.value = found.checkOut;
            } else {
                roomInput.value = (found.room && found.room !== 'Pre-Arrival') ? found.room : '';
                document.getElementById('rs-pa-box').style.display = 'block'; // Restore outer wrapper
            }
        }
    });

    async function syncGuestStatus(name, room, isPreArrival, checkIn, checkOut) {
        if (!name) return;
        const normalized = name.trim();
        const existing = guestDirectory.find(g => g.name.toLowerCase() === normalized.toLowerCase());
        
        const determineStatus = () => {
            if (isPreArrival) return 'pre_arrival';
            // Auto check-out logic might run and override, but we set in_house by default if room is assigned
            return 'in_house';
        };

        const statusToSet = determineStatus();

        if (!existing) {
            const newGuest = {
                name: normalized,
                room: room || '',
                status: statusToSet,
                checkIn: checkIn || '',
                checkOut: checkOut || '',
                lastUpdated: new Date().toISOString()
            };
            await db.collection('guestDirectory').add(newGuest);
        } else {
            // Update room and dates if provided, or if status needs shifting
            let updates = { lastUpdated: new Date().toISOString() };
            
            // If they were checked out, bring them back in house/pre-arrival
            if (existing.status === 'checked_out') updates.status = statusToSet;
            // Or if explicitly marking as pre_arrival
            else if (isPreArrival && existing.status !== 'pre_arrival') updates.status = 'pre_arrival';
            // Or moving from pre_arrival to in_house by providing a room
            else if (!isPreArrival && existing.status === 'pre_arrival' && room) updates.status = 'in_house';

            if (room && existing.room !== room) updates.room = room;
            if (checkIn) updates.checkIn = checkIn;
            if (checkOut) updates.checkOut = checkOut;

            if (Object.keys(updates).length > 1) {
                await db.collection('guestDirectory').doc(existing.id).update(updates);
            }
        }
    }

    document.getElementById('c-search').oninput = renderReservations;

    const todayStr = new Date().toISOString().split('T')[0];
    let dateFilterFp = null;

    if (window.flatpickr) {
        dateFilterFp = flatpickr("#c-dateFilter", {
            inline: true,
            defaultDate: todayStr,
            onChange: function(selectedDates, dateStr, instance) {
                renderReservations();
            },
            onDayCreate: function(dObj, dStr, fp, dayElem) {
                const dateStr = fp.formatDate(dayElem.dateObj, "Y-m-d");
                const hasRes = reservations.some(r => r.date === dateStr);
                if (hasRes) {
                    dayElem.innerHTML += '<span class="fp-dot"></span>';
                }
            }
        });

        // 1. Instant Manual-Typing Date & Time Enhancers
        flatpickr("#rs-date", {
            dateFormat: "d/m/Y",
            allowInput: true,
            disableMobile: "true"
        });
        flatpickr("#rs-time", {
            enableTime: true,
            noCalendar: true,
            dateFormat: "H:i",
            time_24hr: true,
            allowInput: true
        });

        // 2. Bind Proactive Interactive Mechanisms
        const dateEl = document.getElementById('rs-date');
        if (dateEl) {
            // Expand shorthand input instantly when the user steps out of the field
            dateEl.addEventListener('blur', (e) => {
                e.target.value = smartExpandDate(e.target.value);
            });
        }
        initMask('rs-time', 'time');
    } else {
        document.getElementById('c-dateFilter').value = todayStr;
        document.getElementById('c-dateFilter').onchange = renderReservations;
    }

    document.getElementById('c-pillPending').onclick = () => {
        statusFilter = (statusFilter === 'Pending') ? null : 'Pending';
        renderReservations();
    };
    document.getElementById('c-pillConfirmed').onclick = () => {
        statusFilter = (statusFilter === 'Confirmed') ? null : 'Confirmed';
        renderReservations();
    };
    document.getElementById('c-pillToday').onclick = () => {
        if (dateFilterFp) {
            dateFilterFp.setDate(todayStr);
        } else {
            document.getElementById('c-dateFilter').value = todayStr;
        }
        statusFilter = null;
        renderReservations();
    };
    document.getElementById('c-pillAllTime')?.addEventListener('click', () => {
        if (dateFilterFp) dateFilterFp.clear();
        else document.getElementById('c-dateFilter').value = '';
        statusFilter = null;
        renderReservations();
    });

    function renderReservations() {
        const search = document.getElementById('c-search').value.toLowerCase();
        const dateVal = document.getElementById('c-dateFilter').value;
        const feed = document.getElementById('c-feed');
        const empty = document.getElementById('c-emptyState');
        const today = new Date().toISOString().split('T')[0];

        // Update Stats & Active states
        document.getElementById('c-pillPending')?.classList.toggle('active', statusFilter === 'Pending');
        document.getElementById('c-pillConfirmed')?.classList.toggle('active', statusFilter === 'Confirmed');

        let todayCount = 0, pending = 0, confirmed = 0;
        reservations.forEach(r => {
            if (r.date === today) todayCount++;
            
            // Pending is GLOBAL (show all outstanding tasks)
            if (r.status === 'Pending') pending++;
            
            // Confirmed is DAILY (show today's operations)
            if (r.date === dateVal && r.status === 'Confirmed') confirmed++;
        });
        if (document.getElementById('c-statToday')) document.getElementById('c-statToday').textContent = todayCount;
        if (document.getElementById('c-statPending')) document.getElementById('c-statPending').textContent = pending;
        if (document.getElementById('c-statConfirmed')) document.getElementById('c-statConfirmed').textContent = confirmed;

        feed.innerHTML = '';

        // ── LIST MODE (Search or Status Filter Active) ─────────────
        if (search || statusFilter) {
            const results = reservations.filter(r => {
                const matchesText = !search || [
                    r.guestName, r.room, r.type, r.resName, r.vessel, r.provider, r.from, r.to, r.notes
                ].some(val => val && val.toString().toLowerCase().includes(search));

                const matchesStatus = !statusFilter || r.status === statusFilter;
                const matchesDate = !dateVal || r.date === dateVal;   // ← değiştirilen kısım

                return matchesText && matchesStatus && matchesDate;   // ← bu satır olmalı
            });

            if (results.length === 0) { empty.style.display = 'flex'; return; }
            empty.style.display = 'none';

            // Global Sort: Date then Time
            results.sort((a, b) => {
                if (a.date !== b.date) return a.date.localeCompare(b.date);
                return (a.time || '00:00').localeCompare(b.time || '00:00');
            });

            filteredReservations = results;
            results.forEach(r => feed.appendChild(createResCard(r)));
            return;
        }

        // ── AGENDA MODE (Default) ─────────────────────────
        // All Time mode: no date selected, show flat list of all
    if (!dateVal) {
        const allRes = [...reservations].sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return (a.time || '00:00').localeCompare(b.time || '00:00');
        });
            if (allRes.length === 0) { empty.style.display = 'flex'; return; }
            empty.style.display = 'none';
            filteredReservations = allRes;
            allRes.forEach(r => feed.appendChild(createResCard(r)));
            return;
        }
        const parts = dateVal.split('-');
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        d.setDate(d.getDate() + 1);
        const nextDayStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

        const filtered = [];
        reservations.forEach(r => {
            const matchesStatus = !statusFilter || r.status === statusFilter;
            if (!matchesStatus) return;

            // Today's actual reservations
            if (r.date === dateVal) {
                filtered.push({ ...r, isNextDayVirtual: false });
            }
            // Tomorrow's early morning reservations (00:00 to 07:59)
            else if (r.date === nextDayStr && r.time) {
                const hour = parseInt(r.time.split(':')[0]);
                if (hour >= 0 && hour < 8) {
                    filtered.push({ ...r, isNextDayVirtual: true });
                }
            }
        });
        
        filteredReservations = filtered;
        if (filtered.length === 0) { empty.style.display = 'flex'; return; }
        empty.style.display = 'none';

        // Dynamic Slots: Start with core 08-23
        let slots = [];
        for (let h = 8; h <= 23; h++) slots.push(h.toString().padStart(2, '0') + ':00');

        // Add extra hours that have reservations (e.g. 05:00, 01:00, and virtual hours like 25:00 for next day early morning)
        filtered.forEach(r => {
            if (r.time) {
                let hourNum = parseInt(r.time.split(':')[0]);
                if (r.isNextDayVirtual) {
                    hourNum += 24;
                }
                const h = hourNum.toString().padStart(2, '0') + ':00';
                if (!slots.includes(h)) slots.push(h);
            }
        });

        // Sort slots numerically
        slots.sort((a, b) => a.localeCompare(b));

        const grouped = {};
        slots.forEach(s => grouped[s] = []);
        const noTimeItems = [];

        filtered.forEach(r => {
            if (!r.time) {
                noTimeItems.push(r);
            } else {
                let hourNum = parseInt(r.time.split(':')[0]);
                if (r.isNextDayVirtual) {
                    hourNum += 24;
                }
                const hourSlot = hourNum.toString().padStart(2, '0') + ':00';
                if (grouped[hourSlot]) grouped[hourSlot].push(r);
            }
        });

        // Render "Anytime" items at the very top if they exist
        if (noTimeItems.length > 0) {
            const anyEl = document.createElement('div');
            anyEl.className = 'agenda-slot has-items';
            let itemsHtml = noTimeItems.map(r => createResCard(r).outerHTML).join('');
            anyEl.innerHTML = `
                <div class="slot-time">Any</div>
                <div class="slot-content">${itemsHtml}</div>
            `;
            feed.appendChild(anyEl);
        }

        slots.forEach(slot => {
            const items = grouped[slot];
            const isCore = parseInt(slot) >= 8 && parseInt(slot) <= 23;
            if (!isCore && items.length === 0) return; // Don't show empty non-core slots

            const slotEl = document.createElement('div');
            slotEl.className = 'agenda-slot' + (items.length > 0 ? ' has-items' : '');
            let itemsHtml = '';
            items.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
            items.forEach(r => {
                const card = createResCard(r);
                itemsHtml += card.outerHTML;
            });

            // If slot is virtual (>= 24), display as e.g. "01:00 (+1)"
            let displayTime = slot;
            const hourVal = parseInt(slot);
            if (hourVal >= 24) {
                displayTime = (hourVal - 24).toString().padStart(2, '0') + ':00 (+1)';
            }

            slotEl.innerHTML = `
                <div class="slot-time">${displayTime}</div>
                <div class="slot-content">${itemsHtml || '<div class="empty-slot-msg">No entries</div>'}</div>
            `;
            feed.appendChild(slotEl);
        });
    }

    function createResCard(r) {
        const card = document.createElement('div');
        card.className = 'res-card';
        card.dataset.type = r.type;
        card.dataset.status = r.status;
        card.setAttribute('onclick', `openDetailById('${r.id}')`);

        const isVirtual = r.isNextDayVirtual;
        const nextDayBadge = isVirtual ? ' <span style="font-size:9px; background:#f97316; color:white; padding:1px 4px; border-radius:3px; font-weight:700; margin-left:4px;">+1 DAY</span>' : '';

        card.innerHTML = `
            <div class="res-card-icon">${SERVICE_ICONS[r.type] || '✨'}</div>
            <div class="res-card-info">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span class="res-card-guest">${esc(r.guestName)}${nextDayBadge}</span>
                    <span style="font-size:9px; color:var(--text-muted);">${fmtDate(r.date)}</span>
                </div>
                <span class="res-card-room">Room ${esc(r.room)} ${r.time ? '• ' + esc(r.time) : ''}</span>
            </div>
            <div class="res-card-status">
                <span class="status-badge ${esc(r.status.toLowerCase())}">${esc(r.status)}</span>
            </div>
        `;
        return card;
    }


    // Helper for onclick in generated HTML
    window.openDetailById = (id) => {
        const r = reservations.find(res => res.id === id);
        if (r) openDetail(r);
    };



    // ── DYNAMIC FORM LOGIC ────────────────────────────────────
    const dynamicFields = document.getElementById('rs-dynamic-fields');
    const typeSelect = document.getElementById('rs-type');

    function updateFormFields() {
        const type = typeSelect.value;
        const voucherGroup = document.getElementById('rs-voucher-group');
        const financeGroup = document.getElementById('rs-finance-group');
        const paidTypes = ['Transfer', 'Flower', 'Cake', 'Boat', 'Tour', 'Other'];

        const isPaidType = paidTypes.includes(type);
        if (voucherGroup) voucherGroup.style.display = isPaidType ? 'block' : 'none';
        if (financeGroup) financeGroup.style.display = isPaidType ? 'flex' : 'none';

        let html = '';
        if (type === 'Restaurant') {
            html = `
                <div class="field-row">
                    <div class="field-group"><label>Restaurant Name</label><input type="text" id="rs-resName"></div>
                    <div class="field-group"><label>Pax</label><input type="number" id="rs-pax" inputmode="numeric"></div>
                </div>`;
        } else if (type === 'Beach') {
            html = `
        <div class="field-row">
            <div class="field-group"><label>Beach / Venue Name</label><input type="text" id="rs-resName"></div>
            <div class="field-group"><label>Pax</label><input type="number" id="rs-pax" inputmode="numeric"></div>
        </div>`;
        } else if (type === 'Transfer') {
            html = `
                <div class="field-row">
                    <div class="field-group"><label>From</label><input type="text" id="rs-from"></div>
                    <div class="field-group"><label>To</label><input type="text" id="rs-to"></div>
                </div>
                <div class="field-row">
                    <div class="field-group"><label>Vehicle / Flight No</label><input type="text" id="rs-vehicle"></div>
                    <div class="field-group" style="max-width: 80px;"><label>Pax</label><input type="number" id="rs-pax" inputmode="numeric"></div>
                </div>`;
        } else if (type === 'Boat' || type === 'Tour') {
            html = `
                <div class="field-group"><label>Vessel / Tour Name</label><input type="text" id="rs-vessel"></div>
                <div class="field-row">
                    <div class="field-group"><label>Provider / Guide</label><input type="text" id="rs-provider"></div>
                    <div class="field-group" style="max-width: 80px;"><label>Pax</label><input type="number" id="rs-pax" inputmode="numeric"></div>
                </div>`;
        } else if (type === 'Other') {
            html = `
                <div class="field-row">
                    <div class="field-group"><label>Service Name</label><input type="text" id="rs-otherType" placeholder="e.g. Spa, Rent a Car, Babysitter"></div>
                </div>`;
        }
        dynamicFields.innerHTML = html;
    };
    typeSelect.onchange = updateFormFields;
    updateFormFields();

    let editResId = null;

    const openNewRes = () => {
        editResId = null;
        resetConflictAlert(); // Wipe existing alerts
        document.querySelector('#resSheet h3').textContent = 'New Reservation';
        document.getElementById('rs-submit').textContent = 'Log Reservation';
        
        // Reset fields
        ['rs-guest', 'rs-room', 'rs-date', 'rs-time', 'rs-price', 'rs-deposit', 'rs-voucher', 'rs-notes', 'rs-checkIn', 'rs-checkOut'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        const paCb = document.getElementById('rs-isPreArrival');
        paCb.checked = false;
        document.getElementById('rs-pa-box').style.display = 'block'; // Ensure total container visibility restored
        document.getElementById('rs-room').disabled = false;
        
        typeSelect.value = 'Restaurant';
        updateFormFields();
        document.getElementById('rs-date').value = fmtDate(new Date());
        openSheet(resSheet, resBackdrop);
    };

    const fabDesktop = document.getElementById('c-fab');
    const fabMobile = document.getElementById('c-fab-mobile');
    if (fabDesktop) fabDesktop.onclick = openNewRes;
    if (fabMobile) fabMobile.onclick = openNewRes;
    document.getElementById('resClose').onclick = () => closeSheet(resSheet, resBackdrop);
    resBackdrop.onclick = () => closeSheet(resSheet, resBackdrop);

    document.getElementById('rs-submit').onclick = async () => {
        const type = typeSelect.value;
        const guestName = document.getElementById('rs-guest').value.trim();
        const isPreArrival = document.getElementById('rs-isPreArrival').checked;
        const room = document.getElementById('rs-room').value.trim();
        let displayD = document.getElementById('rs-date').value;
        displayD = smartExpandDate(displayD); // Ensure latest expansion ran
        document.getElementById('rs-date').value = displayD; // Visually push fix
        const date = toIsoDate(displayD);
        const time = document.getElementById('rs-time').value;
        const checkIn = document.getElementById('rs-checkIn').value;
        const checkOut = document.getElementById('rs-checkOut').value;
        const price = parseFloat(document.getElementById('rs-price').value) || 0;
        const deposit = parseFloat(document.getElementById('rs-deposit').value) || 0;
        const voucher = document.getElementById('rs-voucher').value.trim();
        const notes = document.getElementById('rs-notes').value.trim();

        if (!guestName || date === '') { showToast('Please fill Guest Name and Date', true); return; }
        if (!isPreArrival && !room) { showToast('Room is required unless Pre-Arrival is checked', true); return; }

        // 🛡️ Informational Collision checks now trigger live via event listeners above.
        // We allow direct single-click commits without obstructing UX flows now.

        const dynamicData = {};
        dynamicFields.querySelectorAll('input').forEach(inp => {
            dynamicData[inp.id.replace('rs-', '')] = inp.value;
        });

        const data = {
            type, guestName, room: isPreArrival ? 'Pre-Arrival' : room, date, time, notes,
            totalPrice: price, deposit: deposit,
            voucherNo: voucher,
            ...dynamicData
        };

        try {
            if (editResId) {
                // Update existing
                await db.collection('reservations').doc(editResId).update(data);
                showToast('Reservation updated');
            } else {
                // Create new
                data.status = 'Pending';
                data.staffInitial = loggedUsername;
                data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                await db.collection('reservations').add(data);
                await syncGuestStatus(guestName, isPreArrival ? '' : room, isPreArrival, checkIn, checkOut); // Sync with directory
                showToast('Reservation logged');
            }
            
            resetConflictAlert(); // Clear transient alerts
            closeSheet(resSheet, resBackdrop);
            ['rs-guest', 'rs-room', 'rs-date', 'rs-time', 'rs-price', 'rs-deposit', 'rs-voucher', 'rs-notes', 'rs-checkIn', 'rs-checkOut'].forEach(id => {
                const el = document.getElementById(id); if (el) el.value = '';
            });
            document.getElementById('rs-isPreArrival').checked = false;
            document.getElementById('rs-pa-box').style.display = 'block'; // Ensure visible
            document.getElementById('rs-room').disabled = false;
        } catch (e) { showToast('Error', true); }
    };

    // ── DETAIL SHEET ──────────────────────────────────────────
    const detailSheet = document.getElementById('detailSheet');
    const detailBackdrop = document.getElementById('detailBackdrop');

    const openDetail = (r) => {
        window.selectedReservation = r;
        populateDetail(r);
        openSheet(detailSheet, detailBackdrop);
    };

    function populateDetail(r) {
        document.getElementById('d-guest').textContent = r.guestName;
        document.getElementById('d-room').textContent = 'Room ' + r.room;
        document.getElementById('d-type').textContent = r.type;
        document.getElementById('d-date').textContent = fmtDate(r.date);
        document.getElementById('d-time').textContent = r.time || '—';
        document.getElementById('d-price').textContent = '€' + r.totalPrice;
        document.getElementById('d-deposit').textContent = '€' + r.deposit;

        const isPaid = r.status === 'Confirmed' || (r.totalPrice - r.deposit <= 0);
        const balance = r.totalPrice - r.deposit;
        const bEl = document.getElementById('d-balance');
        bEl.textContent = isPaid ? 'PAID' : '€' + balance;
        bEl.className = 'balance-text' + (isPaid ? ' paid' : '');

        document.getElementById('d-staff').textContent = r.staffInitial;
        document.getElementById('d-voucher').textContent = r.voucherNo || '—';
        document.getElementById('d-notes').textContent = r.notes || 'No notes.';

        document.querySelectorAll('.status-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.status === r.status);
        });

        let dynHtml = '';
        if (r.type === 'Restaurant' || r.type === 'Beach') dynHtml = `<p><strong>${esc(r.resName || '—')}</strong> (${esc(r.pax || '?')} Pax)</p>`;
        else if (r.type === 'Transfer') dynHtml = `<p><strong>${esc(r.from || '?')} ➔ ${esc(r.to || '?')}</strong><br><small>${esc(r.vehicle || '')} (${esc(r.pax || '?')} Pax)</small></p>`;
        else if (r.type === 'Boat' || r.type === 'Tour') dynHtml = `<p><strong>${esc(r.vessel || '')}</strong><br><small>Provider: ${esc(r.provider || '')} (${esc(r.pax || '?')} Pax)</small></p>`;
        else if (r.type === 'Other') dynHtml = `<p><strong>${esc(r.otherType || 'Other Service')}</strong></p>`;
        document.getElementById('d-dynamic-info').innerHTML = dynHtml;
    };

    document.getElementById('detailClose').onclick = () => closeSheet(detailSheet, detailBackdrop);
    detailBackdrop.onclick = () => closeSheet(detailSheet, detailBackdrop);

    document.getElementById('d-confirmLetterBtn').onclick = () => {
        if (!window.selectedReservation) return;
        generateConfirmationPDF(window.selectedReservation);
    };

    ['Pending', 'Confirmed', 'Cancelled'].forEach(st => {
        document.getElementById('d-set' + st).onclick = async () => {
            if (!window.selectedReservation) return;
            const r = window.selectedReservation;

            // Security check for 'Confirmed'
            if (st === 'Confirmed') {
                const paidTypes = ['Transfer', 'Flower', 'Cake', 'Boat', 'Tour'];
                if (paidTypes.includes(r.type) && !r.voucherNo) {
                    showToast('Voucher No required to confirm!', true);
                    return;
                }
            }

            try {
                await db.collection('reservations').doc(r.id).update({ status: st });
                showToast('Status: ' + st);
            } catch (e) { showToast('Error', true); }
        };
    });

    const dConfirmBox = document.getElementById('d-delete-confirm');

    document.getElementById('d-deleteBtn').onclick = () => {
        dConfirmBox.style.display = 'flex';
    };

    document.getElementById('d-cancelDelete').onclick = () => {
        dConfirmBox.style.display = 'none';
    };

    const authSheet = document.getElementById('authSheet');
    const authBackdrop = document.getElementById('authBackdrop');
    const authPassInput = document.getElementById('auth-password');

    document.getElementById('authClose').onclick = () => closeSheet(authSheet, authBackdrop);
    authBackdrop.onclick = () => closeSheet(authSheet, authBackdrop);

    document.getElementById('d-confirmDelete').onclick = () => {
        if (!window.selectedReservation) return;

        // Security Check: Only creator can delete
        if (window.selectedReservation.staffInitial !== loggedUsername) {
            showToast('Only the creator can delete this log!', true);
            return;
        }

        dConfirmBox.style.display = 'none';
        authPassInput.value = '';
        openSheet(authSheet, authBackdrop);
    };

    document.getElementById('auth-confirm-btn').onclick = async () => {
        const password = authPassInput.value;
        if (!password) return showToast('Please enter your password', true);

        const btn = document.getElementById('auth-confirm-btn');
        btn.disabled = true;
        btn.textContent = 'Verifying...';

        try {
            const user = firebase.auth().currentUser;
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
            await user.reauthenticateWithCredential(credential);

            // Success: Proceed with deletion
            await db.collection('reservations').doc(window.selectedReservation.id).delete();
            showToast('Deleted');
            closeSheet(authSheet, authBackdrop);
            closeSheet(detailSheet, detailBackdrop);
        } catch (e) {
            showToast('Authentication failed. Incorrect password.', true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Verify & Delete';
        }
    };

    // ── EDIT LOGIC ───────────────────────────────────────────
    document.getElementById('d-editBtn').onclick = () => {
        if (!window.selectedReservation) return;
        const r = window.selectedReservation;
        const openDetails = window.selectedReservation; // not relevant, r passed via caller
        
        editResId = r.id;
        resetConflictAlert(); // Clear logic caches
        document.querySelector('#resSheet h3').textContent = 'Edit Reservation';
        document.getElementById('rs-submit').textContent = 'Save Changes';

        typeSelect.value = r.type;
        updateFormFields();

        document.getElementById('rs-guest').value = r.guestName;
        
        const isPreArrival = r.room === 'Pre-Arrival';
        const paCheckbox = document.getElementById('rs-isPreArrival');
        paCheckbox.checked = isPreArrival;
        document.getElementById('rs-room').disabled = isPreArrival;
        document.getElementById('rs-room').value = isPreArrival ? 'Pre-Arrival' : r.room;
        
        // Hide/Show total container box based on context
        document.getElementById('rs-pa-box').style.display = isPreArrival ? 'none' : 'block';

        // Pre-fill check-in/out if available from directory
        if (isPreArrival) {
            const guest = guestDirectory.find(g => g.name.toLowerCase() === r.guestName.toLowerCase());
            if (guest) {
                document.getElementById('rs-checkIn').value = guest.checkIn || '';
                document.getElementById('rs-checkOut').value = guest.checkOut || '';
            }
        }

        document.getElementById('rs-date').value = toDisplayDate(r.date);
        document.getElementById('rs-time').value = r.time || '';
        document.getElementById('rs-price').value = r.totalPrice || '';
        document.getElementById('rs-deposit').value = r.deposit || '';
        document.getElementById('rs-voucher').value = r.voucherNo || '';
        document.getElementById('rs-notes').value = r.notes || '';

        // Populate dynamic fields
        dynamicFields.querySelectorAll('input').forEach(inp => {
            const key = inp.id.replace('rs-', '');
            if (r[key]) inp.value = r[key];
        });

        checkConflictInline(); // Passive logic sync check instantly
        
        // Close detail sheet, open res sheet
        closeSheet(detailSheet, detailBackdrop);
        openSheet(resSheet, resBackdrop);
    };

    // ── ITINERARY GENERATOR ──────────────────────────────────
    const itiSheet = document.getElementById('itiSheet');
    const itiBackdrop = document.getElementById('itiBackdrop');
    const itiGuestSearch = document.getElementById('iti-guest-search');

    document.getElementById('c-openItinerary')?.addEventListener('click', () => {
        openSheet(itiSheet, itiBackdrop);
    });
    document.getElementById('itiClose')?.addEventListener('click', () => closeSheet(itiSheet, itiBackdrop));
    itiBackdrop.onclick = () => closeSheet(itiSheet, itiBackdrop);

    itiGuestSearch.oninput = () => {
        const val = itiGuestSearch.value.trim();
        const box = document.getElementById('iti-guest-info');
        if (guestMap[val]) {
            const guestItems = reservations.filter(r => r.guestName === val && r.status !== 'Cancelled');
            document.getElementById('iti-sel-guest').textContent = val;
            document.getElementById('iti-sel-room').textContent = 'Room ' + guestMap[val];
            document.getElementById('iti-sel-count').textContent = `${guestItems.length} active reservation(s)`;
            box.style.display = 'block';
        } else {
            box.style.display = 'none';
        }
    };

    document.getElementById('iti-gen-btn').onclick = () => {
        const guestName = itiGuestSearch.value.trim();
        if (!guestName) return;
        const guestItems = reservations.filter(r => r.guestName === guestName && r.status !== 'Cancelled');
        if (guestItems.length === 0) { showToast('No active reservations found', true); return; }

        selOptions.innerHTML = guestItems.map(item => `
            <label class="sel-item-row">
                <div class="sel-item-icon-wrap">${SERVICE_ICONS[item.type] || '✨'}</div>
                <div class="sel-item-info">
                    <span class="sel-item-type">${esc(item.type)}</span>
                    <span class="sel-item-date">${fmtDate(item.date)} ${esc(item.time || '')}</span>
                    ${item.resName ? `<span class="sel-item-sub">${esc(item.resName)}</span>` : ''}
                </div>
                <div class="sel-item-check">
                    <input type="checkbox" name="iti-item" value="${item.id}" checked>
                    <div class="custom-check"></div>
                </div>
            </label>
        `).join('');

        openSheet(selSheet, selBackdrop);

        document.getElementById('sel-confirm-btn').onclick = () => {
            const checked = Array.from(document.querySelectorAll('input[name="iti-item"]:checked')).map(cb => cb.value);
            if (checked.length === 0) { showToast('Please select at least one item', true); return; }

            const selectedItems = guestItems.filter(r => checked.includes(r.id));
            generatePDF(guestName, guestMap[guestName], selectedItems);
            closeSheet(selSheet, selBackdrop);
        };
    };

    // ── REPORTS CENTER ───────────────────────────────────────
    const reportsModal = document.getElementById('reportSheet');
    const rptTypeSelect = document.getElementById('reportTypeSelect');

    document.getElementById('c-openReport')?.addEventListener('click', () => {
        openSheet(reportsModal, document.getElementById('reportBackdrop'));
        populateGuestDatalist();
        updateRptUI();
    });
    document.getElementById('reportClose')?.addEventListener('click', () => {
        closeSheet(reportsModal, document.getElementById('reportBackdrop'));
    });
    document.getElementById('reportBackdrop').onclick = () => closeSheet(reportsModal, document.getElementById('reportBackdrop'));

    // Dynamic UI Toggles
    rptTypeSelect?.addEventListener('change', updateRptUI);

    function updateRptUI() {
        const type = rptTypeSelect.value;
        const specificDateCont = document.getElementById('rpt-specificDateContainer');
        const rangeGroup = document.getElementById('rpt-rangeGroup');
        const catCont = document.getElementById('rpt-catContainer');
        const guestCont = document.getElementById('rpt-guestContainer');

        // Reset all
        specificDateCont.style.display = 'none';
        rangeGroup.style.display = 'none';
        catCont.style.display = 'none';
        guestCont.style.display = 'none';

        // Show based on type
        if (type === 'summary') {
            specificDateCont.style.display = 'block';
        } else if (type === 'dateRange' || type === 'revenue' || type === 'activity') {
            rangeGroup.style.display = 'flex';
            if (type === 'activity') catCont.style.display = 'block';
        } else if (type === 'guest') {
            guestCont.style.display = 'block';
        }
    }

    function populateGuestDatalist() {
        const uniqueNames = [...new Set(reservations.map(r => r.guestName).filter(Boolean))].sort();
        reportsGuestHTML = uniqueNames.map(name => `<option value="${esc(name)}">`).join('');
        
        // Sync if currently displayed
        const list = document.getElementById('guestNamesList');
        if (list && list.children.length > 0) list.innerHTML = reportsGuestHTML;
    }

    window.generateReportFromUI = function (format) {
        const type = rptTypeSelect.value;
        generateReport(type, format);
    };

    function getRptDates() {
        return {
            from: document.getElementById('rpt-dateFrom')?.value || '',
            to: document.getElementById('rpt-dateTo')?.value || '',
            specific: document.getElementById('rpt-specificDate')?.value || new Date().toISOString().split('T')[0],
            cat: document.getElementById('rpt-categorySelect')?.value || 'All',
            guest: document.getElementById('rpt-guestSearch')?.value || ''
        };
    }

    function rowBase(r) {
        let details = '';
        if (r.type === 'Restaurant' || r.type === 'Beach') details = r.resName || '';
        else if (r.type === 'Transfer') details = `${r.from || ''} -> ${r.to || ''} (${r.vehicle || ''})`;
        else if (r.type === 'Boat' || r.type === 'Tour') details = `${r.vessel || ''} (${r.provider || ''})`;
        else details = r.notes || '';

        return {
            Date: r.date,
            Time: r.time || '',
            Room: r.room,
            'Guest Name': r.guestName,
            Type: r.type,
            Details: details,
            Pax: r.pax || '',
            Price: r.totalPrice || 0,
            Deposit: r.deposit || 0,
            Status: r.status || 'Pending'
        };
    }

    function autoSizeSheet(ws, rows) {
        if (!rows || rows.length === 0) return;
        const keys = Object.keys(rows[0]);
        const widths = keys.map(k => {
            let maxLen = k.length;
            rows.forEach(r => {
                const val = r[k] ? String(r[k]) : '';
                if (val.length > maxLen) maxLen = val.length;
            });
            return { wch: maxLen + 2 };
        });
        ws['!cols'] = widths;
        if (ws['!ref']) {
            const range = XLSX.utils.decode_range(ws['!ref']);
            ws['!autofilter'] = { ref: XLSX.utils.encode_range(range) };
        }
    }

    function exportExcel(rows, filename, sheetName = 'Report') {
        if (!rows || rows.length === 0) return showToast('No data for this report.', true);
        const ws = XLSX.utils.json_to_sheet(rows);
        autoSizeSheet(ws, rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        XLSX.writeFile(wb, `${filename}_${new Date().toISOString().split('T')[0]}.xlsx`);
        showToast('Excel report downloaded.');
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

    function exportPDF(title, headers, rows, filename, subtitle = '') {
        if (!rows || rows.length === 0) return showToast('No data for this report.', true);
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: rows[0].length > 6 ? 'landscape' : 'portrait' });

        // Fix Turkish chars for title, subtitle and headers
        const fixedTitle = fixTurkishChars(title);
        const fixedSubtitle = fixTurkishChars(subtitle);
        const fixedHeaders = headers.map(h => fixTurkishChars(h));
        const fixedRows = rows.map(row => row.map(cell => fixTurkishChars(cell)));

        doc.setFillColor(21, 101, 192);
        doc.rect(0, 0, doc.internal.pageSize.getWidth(), 28, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text(fixedTitle, 14, 12);
        doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        doc.text(fixedSubtitle || `Generated: ${new Date().toISOString().split('T')[0]}`, 14, 20);
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
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8); doc.setTextColor(150);
            doc.text(`Page ${i} of ${pageCount} — Concierge Management System`, 14, doc.internal.pageSize.getHeight() - 8);
        }
        doc.save(`${filename}_${new Date().toISOString().split('T')[0]}.pdf`);
        showToast('PDF report downloaded.');
    }

    window.generateReport = function (type, format) {
        const { from, to, specific, cat, guest } = getRptDates();
        let data = reservations;

        if (type === 'summary') {
            data = reservations.filter(r => r.date === specific && r.status !== 'Cancelled');
            const summaryRows = [
                { Metric: 'Total Reservations', Value: data.length },
                { Metric: 'Total Revenue', Value: data.reduce((a, b) => a + (Number(b.totalPrice) || 0), 0) + ' €' },
                { Metric: 'Total Deposits', Value: data.reduce((a, b) => a + (Number(b.deposit) || 0), 0) + ' €' }
            ];
            if (format === 'excel') {
                const wb = XLSX.utils.book_new();
                const wsSum = XLSX.utils.json_to_sheet(summaryRows);
                const wsDet = XLSX.utils.json_to_sheet(data.map(rowBase));
                autoSizeSheet(wsSum, summaryRows);
                autoSizeSheet(wsDet, data.map(rowBase));
                XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');
                XLSX.utils.book_append_sheet(wb, wsDet, 'Details');
                XLSX.writeFile(wb, `Daily_Summary_${specific}.xlsx`);
            } else {
                const rows = data.map(r => {
                    const rb = rowBase(r);
                    return [rb.Date, rb.Time, rb.Room, rb['Guest Name'], rb.Type, rb.Details, rb.Pax, rb.Price, rb.Deposit, rb.Status];
                });
                exportPDF(`Daily Summary: ${specific}`, ['Date', 'Time', 'Room', 'Guest', 'Type', 'Details', 'Pax', 'Price', 'Deposit', 'Status'],
                    rows, `Daily_Summary_${specific}`);
            }
        } else if (type === 'activity') {
            data = reservations.filter(r => r.status !== 'Cancelled');
            if (from || to) data = data.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
            if (cat !== 'All') data = data.filter(r => r.type === cat);

            if (format === 'excel') exportExcel(data.map(rowBase), `By_Activity_${cat}`);
            else {
                const rows = data.map(r => {
                    const rb = rowBase(r);
                    return [rb.Date, rb.Time, rb.Room, rb['Guest Name'], rb.Type, rb.Details, rb.Pax, rb.Price, rb.Deposit, rb.Status];
                });
                exportPDF(`By Activity: ${cat}`, ['Date', 'Time', 'Room', 'Guest', 'Type', 'Details', 'Pax', 'Price', 'Deposit', 'Status'],
                    rows, `By_Activity_${cat}`);
            }
        } else if (type === 'guest') {
            if (!guest) return showToast('Please select a guest.', true);
            data = reservations.filter(r => r.guestName && r.guestName.toLowerCase().includes(guest.toLowerCase()) && r.status !== 'Cancelled');
            if (format === 'excel') exportExcel(data.map(rowBase), `Guest_Report_${guest}`);
            else {
                const rows = data.map(r => {
                    const rb = rowBase(r);
                    return [rb.Date, rb.Time, rb.Room, rb.Type, rb.Details, rb.Pax, rb.Price, rb.Deposit, rb.Status];
                });
                exportPDF(`Guest Report: ${guest}`, ['Date', 'Time', 'Room', 'Type', 'Details', 'Pax', 'Price', 'Deposit', 'Status'],
                    rows, `Guest_Report_${guest}`);
            }
        } else if (type === 'revenue') {
            data = reservations.filter(r => r.status !== 'Cancelled');
            if (from || to) data = data.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
            // Group by date
            const revenueMap = {};
            data.forEach(r => {
                if (!revenueMap[r.date]) revenueMap[r.date] = { Date: r.date, Reservations: 0, Price: 0, Deposit: 0 };
                revenueMap[r.date].Reservations++;
                revenueMap[r.date].Price += (Number(r.totalPrice) || 0);
                revenueMap[r.date].Deposit += (Number(r.deposit) || 0);
            });
            const revenueRows = Object.values(revenueMap).sort((a, b) => a.Date.localeCompare(b.Date));
            if (format === 'excel') exportExcel(revenueRows, 'Revenue_Matrix');
            else exportPDF('Revenue Matrix', ['Date', 'Count', 'Total Price', 'Total Deposit'],
                revenueRows.map(r => [r.Date, r.Reservations, r.Price + ' €', r.Deposit + ' €']),
                'Revenue_Matrix');
        } else if (type === 'currentView') {
            exportExcel(filteredReservations.map(rowBase), 'Current_View');
        } else if (type === 'fullArchive') {
            exportExcel(reservations.map(rowBase), 'Full_Archive');
        }
    };

    // Selection modal basics
    const selSheet = document.getElementById('selSheet');
    const selBackdrop = document.getElementById('selBackdrop');
    const selOptions = document.getElementById('sel-options-list');

    document.getElementById('selClose').onclick = () => closeSheet(selSheet, selBackdrop);
    selBackdrop.onclick = () => closeSheet(selSheet, selBackdrop);

    // ── FINANCE SHEET ────────────────────────────────────────
    const financeSheet = document.getElementById('financeSheet');
    const financeBackdrop = document.getElementById('financeBackdrop');

    document.getElementById('c-openFinance').onclick = () => {
        summarizeFinance();
        openSheet(financeSheet, financeBackdrop);
    };
    document.getElementById('financeClose').onclick = () => closeSheet(financeSheet, financeBackdrop);
    financeBackdrop.onclick = () => closeSheet(financeSheet, financeBackdrop);

    function summarizeFinance() {
        const confirmed = reservations.filter(r => r.status === 'Confirmed');
        let totalRev = 0, totalDep = 0, totalBal = 0;
        const catMap = {};

        confirmed.forEach(r => {
            const p = parseFloat(r.totalPrice) || 0;
            const d = parseFloat(r.deposit) || 0;
            const b = p - d;

            totalRev += p;
            totalDep += d;
            totalBal += b;

            if (!catMap[r.type]) catMap[r.type] = 0;
            catMap[r.type] += p;
        });

        document.getElementById('f-totalRev').textContent = '€' + totalRev.toLocaleString();
        document.getElementById('f-totalDep').textContent = '€' + totalDep.toLocaleString();
        document.getElementById('f-totalBal').textContent = '€' + totalBal.toLocaleString();

        const catList = document.getElementById('f-category-list');
        catList.innerHTML = Object.keys(catMap)
            .filter(cat => catMap[cat] > 0) // Only show categories with actual income
            .sort()
            .map(cat => `
                <div class="f-cat-item">
                    <span class="f-cat-label">${esc(cat)}</span>
                    <span class="f-cat-val">€${catMap[cat].toLocaleString()}</span>
                </div>
            `).join('');
    }

    // ── PDF GENERATOR ────────────────────────────────────────
    const generatePDF = (guest, room, itemsOverride = null) => {
        let guestItems = itemsOverride || reservations.filter(r => r.guestName === guest && r.status !== 'Cancelled');
        if (guestItems.length === 0) { showToast('No active reservations found', true); return; }

        guestItems.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

        const pdfEl = document.getElementById('itinerary-pdf');
        pdfEl.style.display = 'block';

        let html = `
            <style>
                .pdf-container { padding: 30px; font-family: 'Helvetica', 'Arial', sans-serif; color: #2c3e50; line-height: 1.4; }
                .pdf-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #34495e; padding-bottom: 15px; margin-bottom: 20px; }
                .pdf-title h1 { margin: 0; font-size: 24px; text-transform: uppercase; letter-spacing: 1px; color: #34495e; }
                .pdf-guest-info { margin-bottom: 20px; background: #fafafa; padding: 15px; border-radius: 6px; border-left: 3px solid #34495e; }
                .pdf-guest-info h2 { margin: 0; font-size: 18px; color: #1a1a1a; }
                .pdf-guest-info p { margin: 0; font-size: 12px; color: #7f8c8d; }
                .pdf-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                .pdf-table th { text-align: left; padding: 10px; background: #34495e; color: #fff; font-size: 11px; text-transform: uppercase; }
                .pdf-table td { padding: 10px; border-bottom: 1px solid #ecf0f1; vertical-align: top; font-size: 13px; }
                .pdf-date-cell { white-space: nowrap; font-weight: bold; }
                .pdf-service-type { font-weight: 800; color: #2980b9; display: block; }
                .pdf-item-details { color: #34495e; }
                .pdf-footer { text-align: center; margin-top: 30px; border-top: 1px solid #ecf0f1; padding-top: 15px; font-size: 10px; color: #95a5a6; }
            </style>
            <div class="pdf-container">
                <div class="pdf-header">
                    <img src="logo.png" style="height: 40px; width: auto;" alt="Logo">
                    <div class="pdf-title">
                        <h1>Guest Itinerary</h1>
                    </div>
                </div>

                <div class="pdf-guest-info">
                    <p>Dear <strong>${esc(guest)}</strong>,</p>
                    <p style="margin-top: 5px;">We hope you are enjoying your stay. Please find below the updated details of your arrangements. We remain at your full disposal for any further assistance.</p>
                </div>

                <table class="pdf-table">
                    <thead>
                        <tr>
                            <th style="width: 20%;">Date & Time</th>
                            <th style="width: 30%;">Service</th>
                            <th style="width: 50%;">Details & Arrangements</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        guestItems.forEach(item => {
            const dateStr = fmtDate(item.date);
            const timeStr = item.time || '—';

            let details = '';
            if (item.type === 'Restaurant' || item.type === 'Beach') details = `<strong>${esc(item.resName)}</strong><br>Pax: ${esc(item.pax)}`;
            else if (item.type === 'Transfer') details = `<strong>Path:</strong> ${esc(item.from)} ➔ ${esc(item.to)}<br><strong>Vehicle:</strong> ${esc(item.vehicle || 'Standard')}`;
            else if (item.type === 'Boat' || item.type === 'Tour') details = `<strong>Service:</strong> ${esc(item.vessel || 'Private Tour')}<br><strong>Provider:</strong> ${esc(item.provider || 'Hotel Direct')}`;
            else details = `<strong>Request:</strong> ${esc(item.resName || item.type)}`;

            html += `
                <tr>
                    <td class="pdf-date-cell">${dateStr}<br><span style="font-weight: normal; color: #7f8c8d;">${esc(timeStr)}</span></td>
                    <td>
                        <span class="pdf-service-type">${esc(item.type.toUpperCase())}</span>
                    </td>
                    <td class="pdf-item-details">${details}</td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>

                <div style="margin-top: 40px; padding: 20px; border: 1px solid #ecf0f1; border-radius: 8px;">
                    <h4 style="margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase;">A Note from Management</h4>
                    <p style="margin: 0; font-size: 12px; font-style: italic; color: #7f8c8d;">
                        "We hope you enjoy your stay with us. If there are any changes to this schedule, please do not hesitate to contact our Concierge team at any time."
                    </p>
                </div>

                </div>
            </div>
        `;

        pdfEl.innerHTML = html;

        const opt = {
            margin: 0,
            filename: `Itinerary_${guest.replace(/\s+/g, '_')}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 3, useCORS: true, letterRendering: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        html2pdf().set(opt).from(pdfEl).save().then(() => {
            pdfEl.style.display = 'none';
        });
    };

    const generateConfirmationPDF = (r) => {
        const pdfEl = document.getElementById('itinerary-pdf');
        pdfEl.style.display = 'block';

        let details = '';
        if (r.type === 'Restaurant' || r.type === 'Beach') details = `Restaurant: <strong>${esc(r.resName)}</strong><br>Guests: ${esc(r.pax)} Pax`;
        else if (r.type === 'Transfer') details = `Path: <strong>${esc(r.from)} ➔ ${esc(r.to)}</strong><br>Vehicle/Flight: ${esc(r.vehicle || 'Standard')}<br>Pax: ${esc(r.pax || '—')}`;
        else if (r.type === 'Boat' || r.type === 'Tour') details = `Service: <strong>${esc(r.vessel || r.type)}</strong><br>Provider: ${esc(r.provider || 'Hotel Direct')}<br>Pax: ${esc(r.pax || '—')}`;
        else details = `Arrangement: <strong>${esc(r.resName || r.type)}</strong>`;

        let html = `
            <style>
                .pdf-container { padding: 40px; font-family: 'Helvetica', 'Arial', sans-serif; color: #2c3e50; line-height: 1.6; }
                .pdf-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #34495e; padding-bottom: 20px; margin-bottom: 30px; }
                .pdf-title h1 { margin: 0; font-size: 28px; text-transform: uppercase; letter-spacing: 2px; color: #2c3e50; }
                .pdf-content { margin-top: 20px; }
                .conf-box { background: #f8f9fa; border: 1px solid #dee2e6; padding: 25px; border-radius: 8px; margin: 25px 0; }
                .conf-row { display: flex; border-bottom: 1px solid #eee; padding: 10px 0; }
                .conf-label { width: 150px; font-weight: bold; color: #7f8c8d; text-transform: uppercase; font-size: 11px; }
                .conf-value { flex: 1; color: #2c3e50; font-size: 14px; }
                .pdf-footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid #eee; font-size: 11px; color: #95a5a6; text-align: center; }
            </style>
            <div class="pdf-container">
                <div class="pdf-header">
                    <img src="logo.png" style="height: 50px; width: auto;">
                    <div class="pdf-title">
                        <h1>Confirmation</h1>
                        <p style="margin:5px 0 0 0; font-size:12px; color:#7f8c8d; text-align:right;">Ref: #${r.id.substring(0, 8).toUpperCase()}</p>
                    </div>
                </div>

                <div class="pdf-content">
                    <p>Dear <strong>${esc(r.guestName)}</strong>,</p>
                    <p>We are pleased to confirm your upcoming arrangement as follows:</p>

                    <div class="conf-box">
                        <div class="conf-row"><div class="conf-label">Service Type</div><div class="conf-value" style="font-weight:bold; color:#2980b9;">${esc(r.type.toUpperCase())}</div></div>
                        <div class="conf-row"><div class="conf-label">Date</div><div class="conf-value">${fmtDate(r.date)}</div></div>
                        <div class="conf-row"><div class="conf-label">Time</div><div class="conf-value">${esc(r.time || '—')}</div></div>
                        <div class="conf-row"><div class="conf-label">Details</div><div class="conf-value">${details}</div></div>
                        <div class="conf-row"><div class="conf-label">Status</div><div class="conf-value"><strong>${esc(r.status)}</strong></div></div>
                        ${r.voucherNo ? `<div class="conf-row"><div class="conf-label">Confirmation No</div><div class="conf-value">${esc(r.voucherNo)}</div></div>` : ''}
                    </div>

                    <p>Should you require any further assistance or wish to make changes, please contact the Concierge desk.</p>
                    <p style="margin-top:30px;">Warm regards,<br><strong>Concierge Team</strong></p>
                </div>

                <div class="pdf-footer">
                    MGallery The Bodrum Hotel Yalıkavak
                </div>
            </div>
        `;

        pdfEl.innerHTML = html;
        const opt = {
            margin: 0,
            filename: `Confirmation_${r.guestName.replace(/\s+/g, '_')}_${r.type}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 3, useCORS: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        html2pdf().set(opt).from(pdfEl).save().then(() => {
            pdfEl.style.display = 'none';
        });
    };
});
