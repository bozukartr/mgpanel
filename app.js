document.addEventListener('DOMContentLoaded', () => {
    const logoWrapper = document.getElementById('logoWrapper');
    const loginCard = document.getElementById('loginCard');

    // Başlangıç animasyonu
    // Logo göründükten (1.2s) sonra yukarı kaymaya başlasın
    setTimeout(() => {
        logoWrapper.classList.add('active');
        
        // Logo yukarı kaymaya başladığında login kartı aşağıdan gelsin
        setTimeout(() => {
            loginCard.classList.add('show');
        }, 400); // 400ms gecikme logo hareketine derinlik katar
        
    }, 1200); 

    // Form gönderimi
    const loginForm = document.getElementById('loginForm');
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        // Firebase Auth uses Email, we append @hotel.com as a convention
        const email = username.includes('@') ? username : `${username}@hotel.com`;

        auth.signInWithEmailAndPassword(email, password)
            .then(() => {
                localStorage.setItem('hotelUsername', username);
                window.location.href = 'panel.html';
            })
            .catch((error) => {
                alert('Invalid credentials or Firebase error: ' + error.message);
            });
    });
});
