document.addEventListener('DOMContentLoaded', () => {
    const logoWrapper = document.getElementById('logoWrapper');
    const loginCard = document.getElementById('loginCard');
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const paymentOverlay = document.getElementById('paymentOverlay');
    const paymentCloseBtn = document.getElementById('paymentCloseBtn');

    setTimeout(() => {
        logoWrapper.classList.add('active');
        setTimeout(() => {
            loginCard.classList.add('show');
        }, 400);
    }, 1200);

    paymentCloseBtn.addEventListener('click', () => {
        paymentOverlay.classList.remove('show');
        auth.signOut();
    });

    function showPaymentOverlay() {
        paymentOverlay.classList.add('show');
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const userInput = document.getElementById('username').value.trim();
        const email = userInput.includes('@') ? userInput : userInput + "@hotel.com";
        const password = document.getElementById('password').value;

        try {
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            const uid = userCredential.user.uid;

            // Check team-wide subscription
            const subDoc = await db.collection('systemConfig').doc('subscription').get();
            if (subDoc.exists) {
                const subData = subDoc.data();
                const now = new Date();
                const end = subData.subscriptionEnd ? subData.subscriptionEnd.toDate() : null;
                if (!end || end < now) {
                    showPaymentOverlay();
                    return;
                }
            } else {
                showPaymentOverlay();
                return;
            }

            const userDoc = await db.collection('systemUsers').doc(uid).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                localStorage.setItem('hotelUsername', userData.username);
                localStorage.setItem('hotelDept', userData.department);
                localStorage.setItem('hotelRole', userData.role);
            } else {
                localStorage.setItem('hotelUsername', userInput);
            }

            logoWrapper.classList.add('expand');
            loginCard.classList.add('fade-out');

            setTimeout(() => {
                window.location.href = 'concierge.html';
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
