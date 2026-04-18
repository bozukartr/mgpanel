document.addEventListener('DOMContentLoaded', () => {
    const logoWrapper = document.getElementById('logoWrapper');
    const loginCard = document.getElementById('loginCard');
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');

    // Başlangıç animasyonu
    setTimeout(() => {
        logoWrapper.classList.add('active');
        setTimeout(() => {
            loginCard.classList.add('show');
        }, 400);
    }, 1200); 

    // Form gönderimi
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const userInput = document.getElementById('username').value.trim();
        const email = userInput.includes('@') ? userInput : userInput + "@hotel.com";
        const password = document.getElementById('password').value;

        try {
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            const uid = userCredential.user.uid;

            // Fetch extra info from Firestore (Roles/Dept)
            const userDoc = await db.collection('systemUsers').doc(uid).get();
            
            if (userDoc.exists) {
                const userData = userDoc.data();
                localStorage.setItem('hotelUsername', userData.username);
                localStorage.setItem('hotelDept', userData.department);
                localStorage.setItem('hotelRole', userData.role);
            } else {
                // Compatibility for users not yet in systemUsers
                localStorage.setItem('hotelUsername', userInput);
            }

            // Success Transition
            logoWrapper.classList.add('expand');
            loginCard.classList.add('fade-out');

            setTimeout(() => {
                window.location.href = 'panel.html';
            }, 800);

        } catch (error) {
            console.error("Login Error:", error.message);
            loginCard.classList.add('shake');
            errorMessage.textContent = "Kullanıcı adı veya şifre yanlış";
            errorMessage.classList.add('show');
            
            setTimeout(() => {
                loginCard.classList.remove('shake');
            }, 500);
        }
    });
});
