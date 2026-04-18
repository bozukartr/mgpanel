document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth & Initial Setting
    const staffInitialInput = document.getElementById('staffInitial');
    const displayUsername = document.getElementById('displayUsername');
    const loggedUsername = localStorage.getItem('hotelUsername') || 'Admin';
    const toast = document.getElementById('toast');
    
    if(staffInitialInput) staffInitialInput.value = loggedUsername;
    if(displayUsername) displayUsername.textContent = loggedUsername;

    // Show Admin Link if user is admin
    const adminNavLink = document.getElementById('adminNavLink');
    const mobAdminBtn = document.getElementById('mobAdminBtn');
    if (loggedUsername.toLowerCase() === 'admin') {
        if (adminNavLink) adminNavLink.style.display = 'inline-block';
        if (mobAdminBtn) mobAdminBtn.style.display = 'flex';
    }

    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if(logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            auth.signOut().then(() => {
                localStorage.removeItem('hotelUsername');
                window.location.href = 'index.html';
            });
        });
    }

    auth.onAuthStateChanged(user => {
        if (!user) window.location.href = 'index.html';
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
    const mobFab          = document.getElementById('mobFab');
    const mobSheet        = document.getElementById('mobSheet');
    const mobSheetClose   = document.getElementById('mobSheetClose');
    const mobBackdrop     = document.getElementById('mobSheetBackdrop');
    const mobSubmitBtn    = document.getElementById('mobSubmitBtn');

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
        const date       = document.getElementById('mob-date')?.value;
        const room       = document.getElementById('mob-room')?.value?.trim();
        const guestName  = document.getElementById('mob-guestName')?.value?.trim();
        const department = document.getElementById('mob-department')?.value;
        const complaint  = document.getElementById('mob-complaint')?.value?.trim();
        const solution   = document.getElementById('mob-solution')?.value?.trim();

        if (!date || !room || !guestName) {
            showToast('Date, Room and Guest Name are required.', true);
            return;
        }

        try {
            await db.collection('guestLogs').add({
                date, room, guestName, department,
                complaint: complaint || '',
                solution:  solution  || '',
                staffInitial: loggedUsername,
                status: 'Following',
                updates: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            // Reset & close
            ['mob-date','mob-room','mob-guestName','mob-complaint','mob-solution'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            closeMobSheet();
            showToast('Issue logged successfully.');
        } catch (err) {
            showToast('Error: ' + err.message, true);
        }
    });

    // Elements
    const issueForm = document.getElementById('guestIssueForm');
    const recordsTableBody = document.querySelector('#recordsTable tbody');
    const recordCountElement = document.getElementById('recordCount');
    const globalSearch = document.getElementById('globalSearch');
    const dateSearch = document.getElementById('dateSearch');
    const resetFilters = document.getElementById('resetFilters');

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

    // 2. Data Persistence
    const fetchRecords = () => {
        db.collection('guestLogs').orderBy('createdAt', 'desc').onSnapshot(snapshot => {
            records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateView();
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
            await db.collection('guestLogs').add(formData);
            issueForm.reset();
            staffInitialInput.value = loggedUsername;
            document.getElementById('date').valueAsDate = new Date();
            document.getElementById('successModal').style.display = 'flex';
        } catch (err) {
            showToast('Error: ' + err.message, true);
        }
    });

    // Export Excel
    document.getElementById('exportExcel').onclick = () => {
        if (records.length === 0) return showToast('No records to export.', true);
        const worksheet = XLSX.utils.json_to_sheet(records.map(r => ({
            Date: r.date,
            Status: r.status || 'Following',
            Room: r.room,
            Guest: r.guestName,
            Department: r.department,
            Complaint: r.complaint,
            Solution: r.solution,
            Staff: r.staffInitial
        })));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Records");
        XLSX.writeFile(workbook, `Guest_Logs_${new Date().toISOString().slice(0, 10)}.xlsx`);
        showToast('Excel exported successfully.');
    };

    // Export PDF
    document.getElementById('exportPDF').onclick = () => {
        if (records.length === 0) return showToast('No records to export.', true);
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        doc.text("Guest Issues Log Report", 14, 15);
        const tableData = records.map(r => [
            r.date, r.room, r.guestName, r.department, r.staffInitial, r.status || 'Following'
        ]);
        doc.autoTable({
            head: [['Date', 'Room', 'Guest', 'Dept', 'Staff', 'Status']],
            body: tableData,
            startY: 20,
            theme: 'grid',
            headStyles: { fillColor: [0, 0, 0] }
        });
        doc.save(`Guest_Logs_${new Date().toISOString().slice(0, 10)}.pdf`);
        showToast('PDF exported successfully.');
    };

    const triggerSearch = () => updateView(globalSearch.value, dateSearch.value);
    globalSearch.addEventListener('input', triggerSearch);
    dateSearch.addEventListener('change', triggerSearch);
    resetFilters.addEventListener('click', () => {
        globalSearch.value = ''; dateSearch.value = ''; updateView();
    });

    // 3. View Logic
    function formatDateShort(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const options = { day: '2-digit', month: 'short', year: '2-digit' };
        return date.toLocaleDateString('en-GB', options).replace(/ /g, ' ');
    }

    // Helper: Check if record is older than 4 hours
    function isOverdue(record) {
        if (!record.createdAt || record.status === 'Solved') return false;
        const createdTime = record.createdAt.toDate ? record.createdAt.toDate() : new Date(record.createdAt);
        const diffHours = (new Date() - createdTime) / (1000 * 60 * 60);
        return diffHours > 4;
    }

    function updateView(textFilter = '', dateFilter = '') {
        recordsTableBody.innerHTML = '';
        const lowerText = textFilter.toLowerCase();
        let stats = { total: 0, following: 0, solved: 0, overdue: 0 };

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

            const statusClass = status.toLowerCase();
            const noteCount = record.updates ? record.updates.length : 0;
            const noteIndicator = noteCount > 0 ? `<span class="note-indicator" title="${noteCount} updates">💬 ${noteCount}</span>` : '';
            const lateBadgeStatus = status !== 'Solved' && isOverdue(record);
            const lateBadge = lateBadgeStatus ? '<span class="late-warning" title="Pending more than 4 hours">⚠️ Late</span>' : '';

            const row = document.createElement('tr');
            if (lateBadgeStatus) row.classList.add('urgent-row');

            row.innerHTML = `
                <td class="date-cell">${formatDateShort(record.date)}</td>
                <td class="room-cell"><span>${record.room}</span></td>
                <td class="guest-cell"><strong>${record.guestName}</strong> ${noteIndicator} ${lateBadge}</td>
                <td><span class="dept-badge">${record.department}</span></td>
                <td class="staff-cell">${record.staffInitial}</td>
                <td><span class="status-badge ${statusClass}">${status}</span></td>
            `;
            row.onclick = () => openModal(record);
            recordsTableBody.appendChild(row);
        });

        // Update Stats Dashboard UI
        if(document.getElementById('statTotal')) document.getElementById('statTotal').textContent = stats.total;
        if(document.getElementById('statFollowing')) document.getElementById('statFollowing').textContent = stats.following;
        if(document.getElementById('statSolved')) document.getElementById('statSolved').textContent = stats.solved;
        if(document.getElementById('statOverdue')) document.getElementById('statOverdue').textContent = stats.overdue;
        
        recordCountElement.textContent = stats.total;
    }

    function openModal(record) {
        selectedRecord = record;
        editingId = record.id;
        modalGuestRoom.textContent = `${record.guestName} - Room ${record.room}`;
        modalDept.textContent = record.department;
        modalDesc.innerHTML = `<strong>Complaint:</strong> ${record.complaint}<br><strong>Solution:</strong> ${record.solution}`;
        
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
                    <span class="timeline-author">${note.user} ${note.isEdited ? '<span class="edited-tag">(edited)</span>' : ''}</span>
                    <span class="timeline-time">${note.time}</span>
                </div>
                <div class="timeline-body">
                    <div class="timeline-text">${note.text}</div>
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
                <textarea id="edit-note-input-${index}" class="inline-textarea">${originalText}</textarea>
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

    confirmDeleteBtn.onclick = () => {
        if (recordToDelete) {
            db.collection('guestLogs').doc(recordToDelete).delete().then(() => {
                confirmModal.style.display = 'none';
                closeModalFunc();
                showToast('Record deleted.');
                recordToDelete = null;
            });
        }
    };

    cancelDeleteBtn.onclick = () => { confirmModal.style.display = 'none'; recordToDelete = null; };

    function draftEmail(record) {
        const subject = encodeURIComponent(`Guest Issue Report: ${record.room} - ${record.guestName}`);
        const body = encodeURIComponent(`Date: ${record.date}\nRoom: ${record.room}\nGuest: ${record.guestName}\nDept: ${record.department}\n\nComplaint: ${record.complaint}\nSolution: ${record.solution}\nStatus: ${record.status}`);
        window.location.href = `mailto:?subject=${subject}&body=${body}`;
    }

    function updateInsights() {
        const today = new Date().toISOString().split('T')[0];
        const todayLogs = records.filter(r => r.date === today);
        document.getElementById('todayCount').textContent = todayLogs.length;
        const deptCounts = {};
        records.forEach(r => deptCounts[r.department] = (deptCounts[r.department] || 0) + 1);
        const topDept = Object.keys(deptCounts).reduce((a, b) => deptCounts[a] > deptCounts[b] ? a : b, '-');
        document.getElementById('topDept').textContent = topDept === '-' ? '-' : topDept.split(' ')[0];
        const activityFeed = document.getElementById('activityFeed');
        activityFeed.innerHTML = '';
        records.slice(0, 5).forEach(r => {
            const item = document.createElement('div');
            item.className = 'feed-item';
            item.innerHTML = `
                <div class="feed-icon" style="background: ${getDeptColor(r.department)}"></div>
                <div class="feed-content">
                    <p><strong>${r.guestName}</strong> (${r.room}) set to ${r.status || 'Following'}.</p>
                    <span>${r.date}</span>
                </div>
            `;
            activityFeed.appendChild(item);
        });
    }

    function getDeptColor(dept) {
        const colors = { 'Housekeeping': '#1976d2', 'Front Desk': '#7b1fa2', 'Engineering': '#ef6c00', 'Food & Beverage': '#2e7d32', 'Security': '#c62828' };
        return colors[dept] || '#333';
    }

    document.getElementById('successEmailBtn').onclick = () => {
        if(selectedRecord) draftEmail(selectedRecord);
        document.getElementById('successModal').style.display = 'none';
    };
    document.getElementById('successSkipBtn').onclick = () => document.getElementById('successModal').style.display = 'none';
    
    function closeModalFunc() { modal.style.display = 'none'; selectedRecord = null; }
    closeModal.onclick = closeModalFunc;
    window.onclick = (e) => { 
        if (e.target == modal) closeModalFunc(); 
        if (e.target == confirmModal) { confirmModal.style.display = 'none'; recordToDelete = null; }
    };
    document.getElementById('date').valueAsDate = new Date();
});
