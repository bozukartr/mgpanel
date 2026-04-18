document.addEventListener('DOMContentLoaded', () => {
    // 1. Auth Guard
    const loggedUsername = localStorage.getItem('hotelUsername') || '';
    const toast = document.getElementById('toast');

    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => { toast.className = 'toast-notification'; }, 3000);
    }

    if (loggedUsername.toLowerCase() !== 'admin') {
        showToast('Unauthorized Access. Redirecting...', true);
        setTimeout(() => window.location.href = 'panel.html', 1500);
        return;
    }

    // Elements
    const usersTableBody = document.querySelector('#usersTable tbody');
    const activityLogsContainer = document.getElementById('activityLogs');
    const userModal = document.getElementById('userModal');
    const openUserModalBtn = document.getElementById('openUserModal');
    const closeUserModalBtn = document.getElementById('closeUserModal');
    const userForm = document.getElementById('userForm');

    let currentEditingUserId = null;

    // 2. Fetch Users
    const fetchUsers = () => {
        db.collection('systemUsers').onSnapshot(snapshot => {
            usersTableBody.innerHTML = '';
            snapshot.forEach(doc => {
                const user = doc.data();
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                tr.innerHTML = `
                    <td><strong>${user.username}</strong></td>
                    <td><span class="role-badge">${user.role}</span></td>
                    <td>${user.department}</td>
                    <td>
                        <button class="delete-user-btn" onclick="event.stopPropagation(); deleteUser('${doc.id}')">Remove Access</button>
                    </td>
                `;
                tr.onclick = () => openEditUser(doc.id, user);
                usersTableBody.appendChild(tr);
            });
        });
    };

    const openEditUser = (id, data) => {
        currentEditingUserId = id;
        document.getElementById('adminNewUsername').value = data.username;
        document.getElementById('adminNewPassword').value = "********";
        document.getElementById('adminNewPassword').disabled = true;
        document.getElementById('adminUserRole').value = data.role;
        document.getElementById('adminUserDept').value = data.department;
        userModal.style.display = 'flex';
    };

    userForm.onsubmit = async (e) => {
        e.preventDefault();
        const username = document.getElementById('adminNewUsername').value.trim();
        const role = document.getElementById('adminUserRole').value;
        const department = document.getElementById('adminUserDept').value;
        const passwordInput = document.getElementById('adminNewPassword');

        try {
            if (currentEditingUserId) {
                // UPDATE MODE
                await db.collection('systemUsers').doc(currentEditingUserId).update({
                    username: username,
                    role: role,
                    department: department,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast('Permissions updated for ' + username);
            } else {
                // CREATE MODE
                const password = passwordInput.value;
                const email = username + "@hotel.com";

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

                await db.collection('systemUsers').doc(uid).set({
                    uid: uid,
                    username: username,
                    email: email,
                    role: role,
                    department: department,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast('New Account Created: ' + username);
            }
            userModal.style.display = 'none';
            userForm.reset();
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message, true);
        }
    };

    // 3. Fetch Activity
    const fetchActivity = () => {
        db.collection('guestLogs').orderBy('createdAt', 'desc').limit(15).onSnapshot(snapshot => {
            activityLogsContainer.innerHTML = '';
            snapshot.forEach(doc => {
                const log = doc.data();
                const logItem = document.createElement('div');
                logItem.className = 'log-item';
                logItem.innerHTML = `
                    <p><strong>${log.staffInitial}</strong> modified record for room <strong>${log.room}</strong></p>
                    <span>${log.date || 'Today'} - ${log.department}</span>
                `;
                activityLogsContainer.innerHTML += logItem.outerHTML;
            });
        });
    };

    // Modal Handlers
    openUserModalBtn.onclick = () => {
        userModal.style.display = 'flex';
        currentEditingUserId = null;
        userForm.reset();
        document.getElementById('adminNewPassword').disabled = false;
    };

    closeUserModalBtn.onclick = () => userModal.style.display = 'none';

    window.deleteUser = (id) => {
        if (confirm('Are you sure you want to remove this user?')) {
            db.collection('systemUsers').doc(id).delete();
            showToast('User removed from system.');
        }
    };

    fetchUsers();
    fetchActivity();
});
