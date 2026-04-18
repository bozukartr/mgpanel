/* concierge.js — Concierge Logic */

document.addEventListener('DOMContentLoaded', () => {
    
    // ── AUTH ───────────────────────────────────────────────────
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
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
                    
                    // Admin sekmesi SADECE "admin" kullanıcı adına
                    if (uname === 'admin') {
                        if (document.getElementById('c-adminNav')) document.getElementById('c-adminNav').style.display = 'flex';
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

    // ── CONFIG ────────────────────────────────────────────────
    const SERVICE_ICONS = {
        'Restaurant': '🍽️',
        'Transfer': '🚗',
        'Flower': '🌸',
        'Cake': '🎂',
        'Boat': '🛥️',
        'Tour': '🗺️',
        'Other': '✨'
    };

    // ── STATE ─────────────────────────────────────────────────
    let reservations = [];
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

    const openSheet  = (s, b) => { s.classList.add('open'); b.classList.add('open'); };
    const closeSheet = (s, b) => { s.classList.remove('open'); b.classList.remove('open'); };

    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }) : '';

    // ── DATA SYNC ─────────────────────────────────────────────
    db.collection('reservations').orderBy('date', 'asc').onSnapshot(snap => {
        reservations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // Update Guest Map for Autocomplete
        guestMap = {};
        reservations.forEach(r => { if(r.guestName && r.room) guestMap[r.guestName] = r.room; });
        updateAutocompletes();

        renderReservations();
        if (window.selectedReservation) {
            const up = reservations.find(r => r.id === window.selectedReservation.id);
            if (up) {
                window.selectedReservation = up; // Update global state with latest data
                populateDetail(up);
            }
        }
    });

    function updateAutocompletes() {
        const list = document.getElementById('guest-list');
        const repList = document.getElementById('rep-guest-list');
        const names = Object.keys(guestMap).sort();
        
        const html = names.map(n => `<option value="${n}">${guestMap[n]}</option>`).join('');
        if(list) list.innerHTML = html;
        if(repList) repList.innerHTML = html;
    }

    document.getElementById('c-search').oninput = renderReservations;
    document.getElementById('c-dateFilter').onchange = renderReservations;

    document.getElementById('c-pillPending').onclick = () => {
        statusFilter = (statusFilter === 'Pending') ? null : 'Pending';
        renderReservations();
    };
    document.getElementById('c-pillConfirmed').onclick = () => {
        statusFilter = (statusFilter === 'Confirmed') ? null : 'Confirmed';
        renderReservations();
    };
    document.getElementById('c-pillToday').onclick = () => {
        document.getElementById('c-dateFilter').value = todayStr;
        statusFilter = null;
        renderReservations();
    };
    
    // Default to Today
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('c-dateFilter').value = todayStr;

    function renderReservations() {
        const search  = document.getElementById('c-search').value.toLowerCase();
        const dateVal = document.getElementById('c-dateFilter').value;
        const feed    = document.getElementById('c-feed');
        const empty   = document.getElementById('c-emptyState');
        const today   = new Date().toISOString().split('T')[0];

        // Update Stats & Active states
        document.getElementById('c-pillPending')?.classList.toggle('active', statusFilter === 'Pending');
        document.getElementById('c-pillConfirmed')?.classList.toggle('active', statusFilter === 'Confirmed');

        let todayCount = 0, pending = 0, confirmed = 0;
        reservations.forEach(r => {
            if (r.date === today) todayCount++;
            if (r.status === 'Pending') pending++;
            if (r.status === 'Confirmed') confirmed++;
        });
        if(document.getElementById('c-statToday')) document.getElementById('c-statToday').textContent = todayCount;
        if(document.getElementById('c-statPending')) document.getElementById('c-statPending').textContent = pending;
        if(document.getElementById('c-statConfirmed')) document.getElementById('c-statConfirmed').textContent = confirmed;

        feed.innerHTML = '';

        // ── LIST MODE (Search or Status Filter Active) ─────────────
        if (search || statusFilter) {
            const results = reservations.filter(r => {
                const matchesText = !search || [
                    r.guestName, r.room, r.type, r.resName, r.vessel, r.provider, r.from, r.to, r.notes
                ].some(val => val && val.toString().toLowerCase().includes(search));
                
                const matchesStatus = !statusFilter || r.status === statusFilter;
                return matchesText && matchesStatus;
            });

            if (results.length === 0) { empty.style.display = 'flex'; return; }
            empty.style.display = 'none';

            // Global Sort: Date then Time
            results.sort((a,b) => {
                if(a.date !== b.date) return a.date.localeCompare(b.date);
                return (a.time || '00:00').localeCompare(b.time || '00:00');
            });

            results.forEach(r => feed.appendChild(createResCard(r)));
            return;
        }

        // ── AGENDA MODE (Default) ─────────────────────────
        const filtered = reservations.filter(r => {
            const matchesDate = !dateVal || r.date === dateVal;
            const matchesStatus = !statusFilter || r.status === statusFilter;
            return matchesDate && matchesStatus;
        });

        if (filtered.length === 0) { empty.style.display = 'flex'; return; }
        empty.style.display = 'none';

        // Dynamic Slots: Start with core 08-23
        let slots = [];
        for(let h=8; h<=23; h++) slots.push(h.toString().padStart(2, '0') + ':00');

        // Add extra hours that have reservations (e.g. 05:00, 01:00)
        filtered.forEach(r => {
            if (r.time) {
                const h = r.time.split(':')[0] + ':00';
                if (!slots.includes(h)) slots.push(h);
            }
        });

        // Sort slots numerically
        slots.sort((a, b) => a.localeCompare(b));

        const grouped = {};
        slots.forEach(s => grouped[s] = []);
        const noTimeItems = [];

        filtered.forEach(r => {
            if (!r.time) noTimeItems.push(r);
            else {
                const hour = r.time.split(':')[0] + ':00';
                if(grouped[hour]) grouped[hour].push(r);
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
            items.sort((a,b) => (a.time || '').localeCompare(b.time || ''));
            items.forEach(r => {
                const card = createResCard(r);
                itemsHtml += card.outerHTML;
            });

            slotEl.innerHTML = `
                <div class="slot-time">${slot}</div>
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
        
        card.innerHTML = `
            <div class="res-card-icon">${SERVICE_ICONS[r.type] || '✨'}</div>
            <div class="res-card-info">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span class="res-card-guest">${r.guestName}</span>
                    <span style="font-size:9px; color:var(--text-muted);">${fmtDate(r.date)}</span>
                </div>
                <span class="res-card-room">Room ${r.room} ${r.time ? '• ' + r.time : ''}</span>
            </div>
            <div class="res-card-status">
                <span class="status-badge ${r.status.toLowerCase()}">${r.status}</span>
            </div>
        `;
        return card;
    }


    // Helper for onclick in generated HTML
    window.openDetailById = (id) => {
        const r = reservations.find(res => res.id === id);
        if(r) openDetail(r);
    };

    // Guest name auto-room-fill
    document.getElementById('rs-guest').addEventListener('input', (e) => {
        const val = e.target.value;
        if(guestMap[val]) {
            document.getElementById('rs-room').value = guestMap[val];
        }
    });

    // ── DYNAMIC FORM LOGIC ────────────────────────────────────
    const dynamicFields = document.getElementById('rs-dynamic-fields');
    const typeSelect = document.getElementById('rs-type');

    function updateFormFields() {
        const type = typeSelect.value;
        const voucherGroup = document.getElementById('rs-voucher-group');
        const financeGroup = document.getElementById('rs-finance-group');
        const paidTypes = ['Transfer', 'Flower', 'Cake', 'Boat', 'Tour'];
        
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
        } else if (type === 'Transfer') {
            html = `
                <div class="field-row">
                    <div class="field-group"><label>From</label><input type="text" id="rs-from"></div>
                    <div class="field-group"><label>To</label><input type="text" id="rs-to"></div>
                </div>
                <div class="field-group"><label>Vehicle Type / Flight No</label><input type="text" id="rs-vehicle"></div>`;
        } else if (type === 'Boat' || type === 'Tour') {
            html = `
                <div class="field-group"><label>Vessel / Tour Name</label><input type="text" id="rs-vessel"></div>
                <div class="field-group"><label>Provider / Guide</label><input type="text" id="rs-provider"></div>`;
        }
        dynamicFields.innerHTML = html;
    };
    typeSelect.onchange = updateFormFields;
    updateFormFields();

    // ── NEW RESERVATION ───────────────────────────────────────
    const resSheet = document.getElementById('resSheet');
    const resBackdrop = document.getElementById('resBackdrop');

    document.getElementById('c-fab').onclick = () => {
        document.getElementById('rs-date').valueAsDate = new Date();
        openSheet(resSheet, resBackdrop);
    };
    document.getElementById('resClose').onclick = () => closeSheet(resSheet, resBackdrop);
    resBackdrop.onclick = () => closeSheet(resSheet, resBackdrop);

    document.getElementById('rs-submit').onclick = async () => {
        const type = typeSelect.value;
        const guestName = document.getElementById('rs-guest').value.trim();
        const room = document.getElementById('rs-room').value.trim();
        const date = document.getElementById('rs-date').value;
        const time = document.getElementById('rs-time').value;
        const price   = parseFloat(document.getElementById('rs-price').value)   || 0;
        const deposit = parseFloat(document.getElementById('rs-deposit').value) || 0;
        const voucher = document.getElementById('rs-voucher').value.trim();
        const notes   = document.getElementById('rs-notes').value.trim();

        if (!guestName || !room || !date) { showToast('Please fill required fields', true); return; }

        const dynamicData = {};
        dynamicFields.querySelectorAll('input').forEach(inp => {
            dynamicData[inp.id.replace('rs-', '')] = inp.value;
        });

        const data = {
            type, guestName, room, date, time, notes,
            totalPrice: price, deposit: deposit,
            voucherNo: voucher,
            ...dynamicData,
            status: 'Pending',
            staffInitial: loggedUsername,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
            await db.collection('reservations').add(data);
            showToast('Reservation logged');
            closeSheet(resSheet, resBackdrop);
            ['rs-guest','rs-room','rs-price','rs-deposit','rs-voucher','rs-notes'].forEach(id => {
                const el = document.getElementById(id); if(el) el.value = '';
            });
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
        if (r.type === 'Restaurant') dynHtml = `<p><strong>${r.resName || '—'}</strong> (${r.pax || '?'} Pax)</p>`;
        else if (r.type === 'Transfer') dynHtml = `<p><strong>${r.from || '?'} ➔ ${r.to || '?'}</strong><br><small>${r.vehicle || ''}</small></p>`;
        else if (r.type === 'Boat' || r.type === 'Tour') dynHtml = `<p><strong>${r.vessel || ''}</strong><br><small>Provider: ${r.provider || ''}</small></p>`;
        document.getElementById('d-dynamic-info').innerHTML = dynHtml;
    };

    document.getElementById('detailClose').onclick = () => closeSheet(detailSheet, detailBackdrop);
    detailBackdrop.onclick = () => closeSheet(detailSheet, detailBackdrop);

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

    document.getElementById('d-confirmDelete').onclick = async () => {
        if (!window.selectedReservation) return;
        try {
            await db.collection('reservations').doc(window.selectedReservation.id).delete();
            showToast('Deleted');
            dConfirmBox.style.display = 'none';
            closeSheet(detailSheet, detailBackdrop);
        } catch (e) { showToast('Error', true); }
    };

    // ── EDIT SHEET LOGIC ─────────────────────────────────────
    const editSheet = document.getElementById('editSheet');
    const editBackdrop = document.getElementById('editBackdrop');

    document.getElementById('d-editBtn').onclick = () => {
        if (!window.selectedReservation) return;
        const r = window.selectedReservation;
        document.getElementById('ed-guest').value   = r.guestName;
        document.getElementById('ed-room').value    = r.room;
        document.getElementById('ed-date').value    = r.date;
        document.getElementById('ed-time').value    = r.time || '';
        document.getElementById('ed-price').value   = r.totalPrice;
        document.getElementById('ed-deposit').value = r.deposit;
        document.getElementById('ed-voucher').value = r.voucherNo || '';
        document.getElementById('ed-notes').value   = r.notes || '';
        openSheet(editSheet, editBackdrop);
    };

    document.getElementById('editClose').onclick = () => closeSheet(editSheet, editBackdrop);
    editBackdrop.onclick = () => closeSheet(editSheet, editBackdrop);

    document.getElementById('ed-submit').onclick = async () => {
        if (!window.selectedReservation) return;
        const updated = {
            guestName:  document.getElementById('ed-guest').value.trim(),
            room:       document.getElementById('ed-room').value.trim(),
            date:       document.getElementById('ed-date').value,
            time:       document.getElementById('ed-time').value,
            totalPrice: parseFloat(document.getElementById('ed-price').value) || 0,
            deposit:    parseFloat(document.getElementById('ed-deposit').value) || 0,
            voucherNo:  document.getElementById('ed-voucher').value.trim(),
            notes:      document.getElementById('ed-notes').value.trim()
        };
        try {
            await db.collection('reservations').doc(window.selectedReservation.id).update(updated);
            showToast('Updated successfully');
            closeSheet(editSheet, editBackdrop);
        } catch (e) { showToast('Error updating', true); }
    };

    // ── REPORTING SHEET ───────────────────────────────────────
    const repSheet = document.getElementById('reportSheet');
    const repBackdrop = document.getElementById('reportBackdrop');
    const repGuestSearch = document.getElementById('rep-guest-search');

    document.getElementById('c-openReport').onclick = () => openSheet(repSheet, repBackdrop);
    document.getElementById('reportClose').onclick = () => closeSheet(repSheet, repBackdrop);
    repBackdrop.onclick = () => closeSheet(repSheet, repBackdrop);

    repGuestSearch.oninput = () => {
        const val = repGuestSearch.value.trim();
        const box = document.getElementById('rep-guest-info');
        if(guestMap[val]) {
            const guestItems = reservations.filter(r => r.guestName === val && r.status !== 'Cancelled');
            document.getElementById('rep-sel-guest').textContent = val;
            document.getElementById('rep-sel-room').textContent = 'Room ' + guestMap[val];
            document.getElementById('rep-sel-count').textContent = `${guestItems.length} active reservation(s)`;
            box.style.display = 'block';
        } else {
            box.style.display = 'none';
        }
    };


    document.getElementById('d-itineraryBtn').onclick = () => {
        if (!window.selectedReservation) return;
        // Directly generate for the SINGLE selected reservation
        generatePDF(window.selectedReservation.guestName, window.selectedReservation.room, [window.selectedReservation]);
    };

    // ── GUEST REPORT SELECTION LOGIC ──────────────────
    const selSheet = document.getElementById('selSheet');
    const selBackdrop = document.getElementById('selBackdrop');
    const selOptions = document.getElementById('sel-options-list');
    
    document.getElementById('selClose').onclick = () => closeSheet(selSheet, selBackdrop);
    selBackdrop.onclick = () => closeSheet(selSheet, selBackdrop);

    document.getElementById('rep-gen-btn').onclick = () => {
        const guestName = repGuestSearch.value.trim();
        if(!guestName) return;

        const guestItems = reservations.filter(r => r.guestName === guestName && r.status !== 'Cancelled');
        if(guestItems.length === 0) { showToast('No active reservations found', true); return; }

        // Populate the Selection Sheet with stylized CARD-like labels
        selOptions.innerHTML = guestItems.map(item => `
            <label class="sel-item-row">
                <div class="sel-item-icon-wrap">${SERVICE_ICONS[item.type] || '✨'}</div>
                <div class="sel-item-info">
                    <span class="sel-item-type">${item.type}</span>
                    <span class="sel-item-date">${fmtDate(item.date)} ${item.time || ''}</span>
                    ${item.resName ? `<span class="sel-item-sub">${item.resName}</span>` : ''}
                </div>
                <input type="checkbox" name="iti-item" value="${item.id}" checked>
            </label>
        `).join('');

        openSheet(selSheet, selBackdrop);
        
        document.getElementById('sel-confirm-btn').onclick = () => {
            const checked = Array.from(document.querySelectorAll('input[name="iti-item"]:checked')).map(cb => cb.value);
            if(checked.length === 0) { showToast('Please select at least one item', true); return; }
            
            const selectedItems = guestItems.filter(r => checked.includes(r.id));
            generatePDF(guestName, guestMap[guestName], selectedItems);
            closeSheet(selSheet, selBackdrop);
        };
    };

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

            if(!catMap[r.type]) catMap[r.type] = 0;
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
                    <span class="f-cat-label">${cat}</span>
                    <span class="f-cat-val">€${catMap[cat].toLocaleString()}</span>
                </div>
            `).join('');
    }

    // ── PDF GENERATOR ────────────────────────────────────────
    const generatePDF = (guest, room, itemsOverride = null) => {
        let guestItems = itemsOverride || reservations.filter(r => r.guestName === guest && r.status !== 'Cancelled');
        if(guestItems.length === 0) { showToast('No active reservations found', true); return; }
        
        guestItems.sort((a,b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

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
                    <p>Dear <strong>${guest}</strong>,</p>
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
            if (item.type === 'Restaurant') details = `<strong>${item.resName}</strong><br>Pax: ${item.pax}`;
            else if (item.type === 'Transfer') details = `<strong>Path:</strong> ${item.from} ➔ ${item.to}<br><strong>Vehicle:</strong> ${item.vehicle || 'Standard'}`;
            else if (item.type === 'Boat' || item.type === 'Tour') details = `<strong>Service:</strong> ${item.vessel || 'Private Tour'}<br><strong>Provider:</strong> ${item.provider || 'Hotel Direct'}`;
            else details = `<strong>Request:</strong> ${item.resName || item.type}`;

            html += `
                <tr>
                    <td class="pdf-date-cell">${dateStr}<br><span style="font-weight: normal; color: #7f8c8d;">${timeStr}</span></td>
                    <td>
                        <span class="pdf-service-type">${item.type.toUpperCase()}</span>
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
});
