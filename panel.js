document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth & Initial Setting
    const staffInitialInput = document.getElementById('staffInitial');
    const displayUsername = document.getElementById('displayUsername');
    const loggedUsername = localStorage.getItem('hotelUsername') || 'Admin';
    const toast = document.getElementById('toast');
    
    if(staffInitialInput) staffInitialInput.value = loggedUsername;
    if(displayUsername) displayUsername.textContent = loggedUsername;

    // Toast Function
    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // Logout Functionality
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
        if (!user) {
            window.location.href = 'index.html';
        }
    });

    // Tab Switching Logic
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            navButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        });
    });

    // Elements
    const issueForm = document.getElementById('guestIssueForm');
    const recordsTableBody = document.querySelector('#recordsTable tbody');
    const recordCountElement = document.getElementById('recordCount');
    const globalSearch = document.getElementById('globalSearch');
    const dateSearch = document.getElementById('dateSearch');
    const resetFilters = document.getElementById('resetFilters');
    const submitBtn = document.getElementById('submitBtn');

    // Modal Elements
    const modal = document.getElementById('recordModal');
    const closeModal = document.getElementById('closeModal');
    const modalGuestRoom = document.getElementById('modalGuestRoom');
    const modalDept = document.getElementById('modalDept');
    const modalDesc = document.getElementById('modalDesc');
    const modalViewMode = document.getElementById('modalViewMode');
    const modalEditForm = document.getElementById('modalEditForm');
    const cancelEditBtn = document.getElementById('cancelEditBtn');

    // Success Modal
    const successModal = document.getElementById('successModal');
    const successEmailBtn = document.getElementById('successEmailBtn');
    const successSkipBtn = document.getElementById('successSkipBtn');

    // Confirm Modal
    const confirmModal = document.getElementById('confirmModal');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');

    let records = [];
    let editingId = null;
    let lastSavedRecord = null;
    let recordToDelete = null;

    // 2. Firebase Data Fetching
    const fetchRecords = () => {
        db.collection('guestLogs').orderBy('createdAt', 'desc').onSnapshot(snapshot => {
            records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateView();
        });
    };

    fetchRecords();

    // Form Submission (Add / Edit)
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
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            await db.collection('guestLogs').add(formData);
            
            lastSavedRecord = formData;
            issueForm.reset();
            staffInitialInput.value = loggedUsername;
            document.getElementById('date').valueAsDate = new Date();
            successModal.style.display = 'flex';

        } catch (err) {
            showToast('Save failed: ' + err.message, true);
        }
    });

    // Global Action Handlers
    const triggerSearch = () => updateView(globalSearch.value, dateSearch.value);
    globalSearch.addEventListener('input', triggerSearch);
    dateSearch.addEventListener('change', triggerSearch);
    resetFilters.addEventListener('click', () => {
        globalSearch.value = '';
        dateSearch.value = '';
        updateView();
    });

    // Export Excel
    document.getElementById('exportExcel').addEventListener('click', () => {
        if (records.length === 0) return showToast('No records to export.', true);
        const worksheet = XLSX.utils.json_to_sheet(records.map(r => ({
            Date: r.date,
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
    });

    // Export PDF
    document.getElementById('exportPDF').addEventListener('click', () => {
        if (records.length === 0) return showToast('No records to export.', true);
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        doc.text("Guest Issues Log Report", 14, 15);
        const tableData = records.map(r => [
            r.date, r.room, r.guestName, r.department, r.complaint, r.staffInitial
        ]);
        doc.autoTable({
            head: [['Date', 'Room', 'Guest', 'Dept', 'Complaint', 'Staff']],
            body: tableData,
            startY: 20,
            theme: 'grid',
            headStyles: { fillColor: [0, 0, 0] }
        });
        doc.save(`Guest_Logs_${new Date().toISOString().slice(0, 10)}.pdf`);
        showToast('PDF exported successfully.');
    });

    function updateView(textFilter = '', dateFilter = '') {
        recordsTableBody.innerHTML = '';
        const lowerText = textFilter.toLowerCase();

        const filteredRecords = records.filter(r => {
            const matchesText = !textFilter || [r.guestName, r.room, r.department, r.staffInitial]
                .some(field => field && field.toLowerCase().includes(lowerText));
            const matchesDate = !dateFilter || r.date === dateFilter;
            return matchesText && matchesDate;
        });

        filteredRecords.forEach(record => {
            const row = document.createElement('tr');
            row.setAttribute('data-dept', record.department);
            row.innerHTML = `
                <td>${record.date}</td>
                <td class="room-cell"><span>${record.room}</span></td>
                <td><strong>${record.guestName}</strong></td>
                <td><span class="dept-badge">${record.department}</span></td>
                <td class="staff-cell">${record.staffInitial}</td>
            `;
            row.addEventListener('click', () => openModal(record));
            recordsTableBody.appendChild(row);
        });
        recordCountElement.textContent = filteredRecords.length;

        // Update Insights
        updateInsights();
    }

    function updateInsights() {
        const today = new Date().toISOString().split('T')[0];
        const todayLogs = records.filter(r => r.date === today);
        document.getElementById('todayCount').textContent = todayLogs.length;

        const deptCounts = {};
        records.forEach(r => {
            deptCounts[r.department] = (deptCounts[r.department] || 0) + 1;
        });
        const topDept = Object.keys(deptCounts).reduce((a, b) => deptCounts[a] > deptCounts[b] ? a : b, '-');
        document.getElementById('topDept').textContent = topDept === '-' ? '-' : topDept.split(' ')[0];

        // Activity Feed (Last 5)
        const activityFeed = document.getElementById('activityFeed');
        activityFeed.innerHTML = '';
        records.slice(0, 5).forEach(r => {
            const item = document.createElement('div');
            item.className = 'feed-item';
            item.innerHTML = `
                <div class="feed-icon" style="background: ${getDeptColor(r.department)}"></div>
                <div class="feed-content">
                    <p><strong>${r.guestName}</strong> (${r.room}) was logged for ${r.department}.</p>
                    <span>${r.date}</span>
                </div>
            `;
            activityFeed.appendChild(item);
        });
    }

    function getDeptColor(dept) {
        const colors = {
            'Housekeeping': '#1976d2',
            'Front Desk': '#7b1fa2',
            'Engineering': '#ef6c00',
            'Food & Beverage': '#2e7d32',
            'Security': '#c62828'
        };
        return colors[dept] || '#333';
    }

    // Modal CRUD
    function openModal(record) {
        editingId = record.id;
        modalGuestRoom.textContent = `${record.guestName} - Room ${record.room}`;
        modalDept.textContent = record.department;
        modalDesc.innerHTML = `<strong>Complaint:</strong> ${record.complaint}<br><strong>Solution:</strong> ${record.solution}`;

        modalViewMode.style.display = 'block';
        modalEditForm.style.display = 'none';
        modal.style.display = 'flex';

        document.getElementById('emailModalBtn').onclick = () => draftEmail(record);
        document.getElementById('editModalBtn').onclick = () => startModalEdit(record);
        
        document.getElementById('deleteModalBtn').onclick = () => {
            recordToDelete = record.id;
            confirmModal.style.display = 'flex';
        };
    }

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

    cancelDeleteBtn.onclick = () => {
        confirmModal.style.display = 'none';
        recordToDelete = null;
    };

    function startModalEdit(record) {
        document.getElementById('editDate').value = record.date;
        document.getElementById('editRoom').value = record.room;
        document.getElementById('editGuestName').value = record.guestName;
        document.getElementById('editDepartment').value = record.department;
        document.getElementById('editComplaint').value = record.complaint;
        document.getElementById('editSolution').value = record.solution;
        document.getElementById('editStaffInitial').value = record.staffInitial;
        modalViewMode.style.display = 'none';
        modalEditForm.style.display = 'block';
    }

    modalEditForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const updatedData = {
            date: document.getElementById('editDate').value,
            room: document.getElementById('editRoom').value,
            guestName: document.getElementById('editGuestName').value,
            department: document.getElementById('editDepartment').value,
            complaint: document.getElementById('editComplaint').value,
            solution: document.getElementById('editSolution').value,
            staffInitial: document.getElementById('editStaffInitial').value
        };

        db.collection('guestLogs').doc(editingId).update(updatedData).then(() => {
            closeModalFunc();
            showToast('Changes saved.');
        });
    });

    function draftEmail(record) {
        const subject = encodeURIComponent(`Guest Issue Report: Room ${record.room} - ${record.guestName}`);
        const body = encodeURIComponent(`Date: ${record.date}\nRoom: ${record.room}\nGuest: ${record.guestName}\nDept: ${record.department}\n\nComplaint: ${record.complaint}\nSolution: ${record.solution}\nStaff: ${record.staffInitial}`);
        window.location.href = `mailto:?subject=${subject}&body=${body}`;
    }

    successEmailBtn.addEventListener('click', () => {
        if(lastSavedRecord) draftEmail(lastSavedRecord);
        successModal.style.display = 'none';
    });
    successSkipBtn.addEventListener('click', () => successModal.style.display = 'none');
    
    function closeModalFunc() { modal.style.display = 'none'; }
    closeModal.onclick = closeModalFunc;
    window.onclick = (e) => { 
        if (e.target == modal) closeModalFunc(); 
        if (e.target == confirmModal) { confirmModal.style.display = 'none'; recordToDelete = null; }
    };

    document.getElementById('date').valueAsDate = new Date();
});
