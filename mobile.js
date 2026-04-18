/* mobile.js — Hotel Panel Mobile App — Full Feature Parity with panel.js */
document.addEventListener('DOMContentLoaded', () => {

    // ── AUTH ───────────────────────────────────────────────────
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    if (!loggedUsername) { window.location.href = 'index.html'; return; }
    auth.onAuthStateChanged(u => { if (!u) window.location.href = 'index.html'; });

    document.querySelectorAll('.app-username').forEach(el => el.textContent = loggedUsername);
    if (loggedUsername.toLowerCase() === 'admin') {
        const adminNav = document.getElementById('mob-adminNav');
        if (adminNav) adminNav.style.display = 'flex';
    }

    document.getElementById('mob-logoutBtn')?.addEventListener('click', () => {
        auth.signOut().then(() => { localStorage.removeItem('hotelUsername'); window.location.href = 'index.html'; });
    });

    // ── TOAST ──────────────────────────────────────────────────
    const toast = document.getElementById('mob-toast');
    let toastTimer;
    const showToast = (msg, isError = false) => {
        clearTimeout(toastTimer);
        toast.textContent = msg;
        toast.className = 'app-toast show' + (isError ? ' error' : '');
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
    };

    // ── SCREEN NAV ─────────────────────────────────────────────
    const switchScreen = (id) => {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.bnav-btn[data-screen]').forEach(b => b.classList.remove('active'));
        document.getElementById(id)?.classList.add('active');
        document.querySelectorAll(`.bnav-btn[data-screen="${id}"]`).forEach(b => b.classList.add('active'));
    };
    document.querySelectorAll('.bnav-btn[data-screen]').forEach(btn =>
        btn.addEventListener('click', () => switchScreen(btn.dataset.screen))
    );

    // ── SHEET HELPERS ──────────────────────────────────────────
    const openSheet  = (s, b) => { s.classList.add('open'); b.classList.add('open'); };
    const closeSheet = (s, b) => { s.classList.remove('open'); b.classList.remove('open'); };

    // ── HELPERS ────────────────────────────────────────────────
    const fmtDate = (str) => {
        if (!str) return '';
        return new Date(str).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
    };

    const isOverdue = (r) => {
        if (!r.createdAt || r.status === 'Solved') return false;
        const t = r.createdAt.toDate ? r.createdAt.toDate() : new Date(r.createdAt);
        return (Date.now() - t) / 3600000 > 4;
    };

    // ── DATA ───────────────────────────────────────────────────
    let records = [];
    // Exposed on window so global onclick handlers (renderTimeline, mobDeleteNote etc.) can access it
    window.selectedRecord = null;
    // Convenience proxy — reads/writes window.selectedRecord
    const getSelected = () => window.selectedRecord;
    const setSelected = (val) => { window.selectedRecord = val; return val; };

    const renderFeed = () => {
        const search  = (document.getElementById('mob-search')?.value || '').toLowerCase();
        const dateVal = document.getElementById('mob-dateFilter')?.value || '';
        const feed    = document.getElementById('mob-feed');
        const empty   = document.getElementById('mob-emptyState');

        const filtered = records.filter(r => {
            const matchText = !search || [r.guestName, r.room, r.department, r.staffInitial, r.status]
                .some(f => f && f.toLowerCase().includes(search));
            return matchText && (!dateVal || r.date === dateVal);
        });

        // Stats (always from full records)
        let total = 0, following = 0, solved = 0, overdue = 0;
        records.forEach(r => {
            total++;
            if ((r.status || 'Following') === 'Solved') solved++;
            else { following++; if (isOverdue(r)) overdue++; }
        });
        document.getElementById('m-statTotal').textContent     = total;
        document.getElementById('m-statFollowing').textContent = following;
        document.getElementById('m-statSolved').textContent    = solved;
        document.getElementById('m-statOverdue').textContent   = overdue;

        feed.innerHTML = '';
        if (filtered.length === 0) {
            empty.style.display = 'flex'; feed.style.display = 'none'; return;
        }
        empty.style.display = 'none'; feed.style.display = 'flex';

        filtered.forEach(r => {
            const status      = r.status || 'Following';
            const overdueFlag = isOverdue(r);
            const noteCount   = r.updates?.length || 0;

            const card = document.createElement('div');
            card.className = 'issue-card' + (overdueFlag ? ' overdue-card' : '');
            card.innerHTML = `
                <div class="card-date">${fmtDate(r.date)}</div>
                <div class="card-status">
                    ${overdueFlag ? '<span class="late-badge">⚠ Late</span>' : ''}
                    <span class="status-badge ${status.toLowerCase()}">${status}</span>
                </div>
                <div class="card-name">
                    ${r.guestName}
                    ${noteCount > 0 ? `<span class="note-badge">💬 ${noteCount}</span>` : ''}
                </div>
                <div class="card-room"><span class="room-badge">Room ${r.room}</span></div>
                <div class="card-meta">
                    <span class="dept-badge">${r.department}</span>
                    <span class="staff-badge">${r.staffInitial}</span>
                </div>
            `;
            card.addEventListener('click', () => openDetail(r));
            feed.appendChild(card);
        });
    };

    db.collection('guestLogs').orderBy('createdAt', 'desc').onSnapshot(snap => {
        records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderFeed();
        if (getSelected()) {
            const refreshed = records.find(r => r.id === getSelected().id);
            if (refreshed) { setSelected(refreshed); window.renderTimeline(refreshed); }
        }
    });

    document.getElementById('mob-search')?.addEventListener('input', renderFeed);
    document.getElementById('mob-dateFilter')?.addEventListener('change', renderFeed);

    // ── NEW ISSUE SHEET ────────────────────────────────────────
    const newSheet    = document.getElementById('newIssueSheet');
    const newBackdrop = document.getElementById('newIssueBackdrop');

    document.getElementById('mob-fab')?.addEventListener('click', () => {
        const di = document.getElementById('ni-date');
        if (di && !di.value) di.valueAsDate = new Date();
        openSheet(newSheet, newBackdrop);
    });
    document.getElementById('newIssueClose')?.addEventListener('click',  () => closeSheet(newSheet, newBackdrop));
    newBackdrop?.addEventListener('click', () => closeSheet(newSheet, newBackdrop));

    document.getElementById('ni-submit')?.addEventListener('click', async () => {
        const date  = document.getElementById('ni-date')?.value;
        const room  = document.getElementById('ni-room')?.value?.trim();
        const guest = document.getElementById('ni-guest')?.value?.trim();
        const dept  = document.getElementById('ni-dept')?.value;
        const comp  = document.getElementById('ni-complaint')?.value?.trim();
        const sol   = document.getElementById('ni-solution')?.value?.trim();

        if (!date || !room || !guest) { showToast('Date, Room & Guest are required.', true); return; }
        try {
            await db.collection('guestLogs').add({
                date, room, guestName: guest, department: dept,
                complaint: comp || '', solution: sol || '',
                staffInitial: loggedUsername,
                status: 'Following', updates: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            ['ni-date','ni-room','ni-guest','ni-complaint','ni-solution'].forEach(id => {
                const el = document.getElementById(id); if (el) el.value = '';
            });
            closeSheet(newSheet, newBackdrop);
            showToast('Issue logged.');
        } catch (e) { showToast('Error: ' + e.message, true); }
    });

    // ── DETAIL SHEET ───────────────────────────────────────────
    const detailSheet    = document.getElementById('detailSheet');
    const detailBackdrop = document.getElementById('detailBackdrop');

    const openDetail = (r) => {
        setSelected(r);
        populateDetail(r);
        openSheet(detailSheet, detailBackdrop);
    };

    const closeDetail = () => {
        closeSheet(detailSheet, detailBackdrop);
        setSelected(null);
    };

    document.getElementById('detailClose')?.addEventListener('click', closeDetail);
    detailBackdrop?.addEventListener('click', closeDetail);

    // ── TIMELINE ───────────────────────────────────────────────
    // Exposed on window so inline onclick="renderTimeline(...)" in injected HTML works
    window.renderTimeline = (r) => {
        const list = document.getElementById('d-timeline');
        list.innerHTML = '';
        const updates = r.updates || [];
        updates.forEach((note, idx) => {
            const isOwner = (note.user || note.author) === loggedUsername;
            const item = document.createElement('div');
            item.className = 'timeline-item';
            item.id = `mob-note-${idx}`;
            const author  = note.user || note.author || '—';
            const timeStr = note.time || (note.timestamp?.toDate
                ? note.timestamp.toDate().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                : '');
            item.innerHTML = `
                <div class="timeline-item-header">
                    <span class="timeline-item-author">${author}${note.isEdited ? ' <span class="edited-tag">(edited)</span>' : ''}</span>
                    <span class="timeline-item-time">${timeStr}</span>
                </div>
                <div class="timeline-item-body" id="mob-note-body-${idx}">
                    <div class="timeline-item-text">${note.text}</div>
                </div>
                ${isOwner ? `
                <div class="timeline-item-actions" id="mob-note-actions-${idx}">
                    <button class="note-action-btn" onclick="mobStartEdit(${idx})">Edit</button>
                    <button class="note-action-btn danger" onclick="mobDeleteNote(${idx})">Delete</button>
                </div>` : ''}
            `;
            list.appendChild(item);
        });
        list.scrollTop = list.scrollHeight;
    };

    const populateDetail = (r) => {
        const status = r.status || 'Following';
        document.getElementById('d-room').textContent      = `Room ${r.room}`;
        document.getElementById('d-name').textContent      = r.guestName;
        document.getElementById('d-dept').textContent      = r.department;
        document.getElementById('d-date').textContent      = fmtDate(r.date);
        document.getElementById('d-staff').textContent     = r.staffInitial;
        document.getElementById('d-complaint').textContent = r.complaint || '—';
        document.getElementById('d-solution').textContent  = r.solution  || '—';
        
        // Status Toggle UI
        document.querySelectorAll('.status-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.status === status);
        });

        window.renderTimeline(r);
    };



    // Note post
    document.getElementById('d-postNote')?.addEventListener('click', async () => {
        const input = document.getElementById('d-noteInput');
        const text  = input?.value?.trim();
        if (!text || !getSelected()) return;
        const note = {
            user: loggedUsername,
            text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: Date.now(),
            isEdited: false
        };
        try {
            const updated = [...(getSelected().updates || []), note];
            await db.collection('guestLogs').doc(getSelected().id).update({ updates: updated });
            input.value = '';
        } catch (e) { showToast('Error', true); }
    });

    // Note delete (with inline confirm)
    // Cancel/No inline buttons call this — avoids passing selectedRecord in onclick string
    window.mobCancelAction = () => {
        if (window.selectedRecord) window.renderTimeline(window.selectedRecord);
    };

    window.mobDeleteNote = (idx) => {
        const actions = document.getElementById(`mob-note-actions-${idx}`);
        if (!actions) return;
        actions.innerHTML = `
            <span class="confirm-inline">Remove?</span>
            <button class="note-action-btn danger" onclick="mobConfirmDeleteNote(${idx})">Yes</button>
            <button class="note-action-btn" onclick="mobCancelAction()">No</button>
        `;
    };

    window.mobConfirmDeleteNote = async (idx) => {
        if (!getSelected()) return;
        const updated = [...getSelected().updates];
        updated.splice(idx, 1);
        try {
            await db.collection('guestLogs').doc(getSelected().id).update({ updates: updated });
            showToast('Note removed.');
        } catch (e) { showToast('Error', true); }
    };

    window.mobStartEdit = (idx) => {
        const body    = document.getElementById(`mob-note-body-${idx}`);
        const actions = document.getElementById(`mob-note-actions-${idx}`);
        if (!getSelected()) return;
        const orig = getSelected().updates[idx].text;
        body.innerHTML = `
            <textarea class="inline-note-edit" id="mob-edit-input-${idx}">${orig}</textarea>
            <div class="inline-note-actions">
                <button class="note-action-btn" onclick="mobSaveEdit(${idx})">Save</button>
                <button class="note-action-btn" onclick="mobCancelAction()">Cancel</button>
            </div>
        `;
        if (actions) actions.style.display = 'none';
    };

    window.mobSaveEdit = async (idx) => {
        const newText = document.getElementById(`mob-edit-input-${idx}`)?.value?.trim();
        if (!newText || !getSelected()) return;
        const updated = [...getSelected().updates];
        updated[idx] = { ...updated[idx], text: newText, isEdited: true };
        try {
            await db.collection('guestLogs').doc(getSelected().id).update({ updates: updated });
            showToast('Note updated.');
        } catch (e) { showToast('Error', true); }
    };

    // ── STATUS UPDATE ──────────────────────────────────────────
    const updateStatus = async (newStatus) => {
        if (!getSelected()) return;
        try {
            await db.collection('guestLogs').doc(getSelected().id).update({ status: newStatus });
            
            // UI Update
            document.querySelectorAll('.status-toggle-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.status === newStatus);
            });

            showToast('Status → ' + newStatus);
        } catch (e) { showToast('Error', true); }
    };
    document.getElementById('d-setFollowing')?.addEventListener('click', () => updateStatus('Following'));
    document.getElementById('d-setSolved')?.addEventListener('click',    () => updateStatus('Solved'));

    // ── EMAIL DRAFT ────────────────────────────────────────────
    document.getElementById('d-emailBtn')?.addEventListener('click', () => {
        if (!getSelected()) return;
        const r = getSelected();
        const subject = encodeURIComponent(`Guest Issue: Room ${r.room} – ${r.guestName}`);
        const body = encodeURIComponent(
            `Date: ${r.date}\nRoom: ${r.room}\nGuest: ${r.guestName}\nDept: ${r.department}\n\nComplaint: ${r.complaint}\nSolution: ${r.solution}\nStatus: ${r.status || 'Following'}`
        );
        window.location.href = `mailto:?subject=${subject}&body=${body}`;
    });

    // ── EDIT RECORD ────────────────────────────────────────────
    const editSheet    = document.getElementById('editSheet');
    const editBackdrop = document.getElementById('editBackdrop');

    document.getElementById('d-editBtn')?.addEventListener('click', () => {
        if (!getSelected()) return;
        const r = getSelected();
        document.getElementById('ed-date').value      = r.date;
        document.getElementById('ed-room').value      = r.room;
        document.getElementById('ed-guest').value     = r.guestName;
        document.getElementById('ed-dept').value      = r.department;
        document.getElementById('ed-complaint').value = r.complaint || '';
        document.getElementById('ed-solution').value  = r.solution  || '';
        openSheet(editSheet, editBackdrop);
    });
    document.getElementById('editClose')?.addEventListener('click', () => closeSheet(editSheet, editBackdrop));
    editBackdrop?.addEventListener('click', () => closeSheet(editSheet, editBackdrop));

    document.getElementById('ed-submit')?.addEventListener('click', async () => {
        if (!getSelected()) return;
        const updatedData = {
            date:       document.getElementById('ed-date').value,
            room:       document.getElementById('ed-room').value.trim(),
            guestName:  document.getElementById('ed-guest').value.trim(),
            department: document.getElementById('ed-dept').value,
            complaint:  document.getElementById('ed-complaint').value.trim(),
            solution:   document.getElementById('ed-solution').value.trim(),
        };
        try {
            await db.collection('guestLogs').doc(getSelected().id).update(updatedData);
            closeSheet(editSheet, editBackdrop);
            showToast('Record updated.');
        } catch (e) { showToast('Error: ' + e.message, true); }
    });

    // ── DELETE RECORD (with confirm sheet) ─────────────────────
    const confirmSheet    = document.getElementById('confirmSheet');
    const confirmBackdrop = document.getElementById('confirmBackdrop');

    document.getElementById('d-deleteBtn')?.addEventListener('click', () => {
        openSheet(confirmSheet, confirmBackdrop);
    });
    document.getElementById('confirmDeleteNo')?.addEventListener('click', () => closeSheet(confirmSheet, confirmBackdrop));
    confirmBackdrop?.addEventListener('click', () => closeSheet(confirmSheet, confirmBackdrop));

    document.getElementById('confirmDeleteYes')?.addEventListener('click', async () => {
        if (!getSelected()) return;
        try {
            await db.collection('guestLogs').doc(getSelected().id).delete();
            closeSheet(confirmSheet, confirmBackdrop);
            closeDetail();
            showToast('Record deleted.');
        } catch (e) { showToast('Error', true); }
    });

    // ── Init ───────────────────────────────────────────────────
    const todayInput = document.getElementById('ni-date');
    if (todayInput) todayInput.valueAsDate = new Date();
});
