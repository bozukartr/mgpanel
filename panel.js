document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth & Initial Setting
    const staffInitialInput = document.getElementById('staffInitial');
    const displayUsername = document.getElementById('displayUsername');
    const loggedUsername = localStorage.getItem('hotelUsername') || 'Admin';
    
    if(staffInitialInput) staffInitialInput.value = loggedUsername;
    if(displayUsername) displayUsername.textContent = loggedUsername;

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
    const photoInput = document.getElementById('photoInput');
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
    const modalImage = document.getElementById('modalImage');
    const modalViewMode = document.getElementById('modalViewMode');
    const modalEditForm = document.getElementById('modalEditForm');
    const cancelEditBtn = document.getElementById('cancelEditBtn');

    // Success Modal
    const successModal = document.getElementById('successModal');
    const successEmailBtn = document.getElementById('successEmailBtn');
    const successSkipBtn = document.getElementById('successSkipBtn');

    let records = [];
    let editingId = null;
    let lastSavedRecord = null;

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

        let photoData = null;
        if (photoInput.files && photoInput.files[0]) {
            photoData = await toBase64(photoInput.files[0]);
        }

        const formData = {
            date: document.getElementById('date').value,
            room: document.getElementById('room').value,
            guestName: document.getElementById('guestName').value,
            department: document.getElementById('department').value,
            complaint: document.getElementById('complaint').value,
            solution: document.getElementById('solution').value,
            staffInitial: document.getElementById('staffInitial').value,
            photo: photoData || null,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        db.collection('guestLogs').add(formData).then(() => {
            lastSavedRecord = formData;
            issueForm.reset();
            staffInitialInput.value = loggedUsername;
            document.getElementById('date').valueAsDate = new Date();
            document.querySelector('.file-label .text').textContent = 'Choose a photo';
            successModal.style.display = 'flex';
        }).catch(err => alert('Error: ' + err.message));
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
    }

    // Modal CRUD
    function openModal(record) {
        editingId = record.id;
        modalGuestRoom.textContent = `${record.guestName} - Room ${record.room}`;
        modalDept.textContent = record.department;
        modalDesc.innerHTML = `<strong>Complaint:</strong> ${record.complaint}<br><strong>Solution:</strong> ${record.solution}`;
        
        if (record.photo) {
            modalImage.src = record.photo;
            modalImage.style.display = 'block';
        } else {
            modalImage.style.display = 'none';
        }

        modalViewMode.style.display = 'block';
        modalEditForm.style.display = 'none';
        modal.style.display = 'flex';

        document.getElementById('editModalBtn').onclick = () => startModalEdit(record);
        document.getElementById('deleteModalBtn').onclick = () => {
            if (confirm('Delete this record?')) {
                db.collection('guestLogs').doc(record.id).delete().then(() => closeModalFunc());
            }
        };
    }

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
        });
    });

    // Helpers
    const toBase64 = file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
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
    window.onclick = (e) => { if (e.target == modal) closeModalFunc(); };

    photoInput.addEventListener('change', () => {
        document.querySelector('.file-label .text').textContent = photoInput.files[0] ? 'Photo selected' : 'Choose a photo';
    });

    document.getElementById('date').valueAsDate = new Date();
});
