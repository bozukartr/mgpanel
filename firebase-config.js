// Firebase Configuration - Replace with your own config from Firebase Console
const firebaseConfig = {
    apiKey: "AIzaSyA9gr0enNzAxFNVcWAn9oiLLMJn5DfgCac",
    authDomain: "panel-d25c9.firebaseapp.com",
    projectId: "panel-d25c9",
    storageBucket: "panel-d25c9.firebasestorage.app",
    messagingSenderId: "201774041360",
    appId: "1:201774041360:web:b7725c119584a03c643d95",
    measurementId: "G-6T3QV04GDS"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// --- Multi-tenancy ---
// The first hotel. Used as the fallback when no tenant can be resolved
// (apex domain, *.web.app previews, localhost).
const DEFAULT_TENANT = 'mgallery';

// Active tenant for new writes in this session. Set at login and persisted in
// localStorage, so every page stamps documents with the signed-in user's hotel.
const TENANT_ID = localStorage.getItem('hotelTenantId') || DEFAULT_TENANT;

// Resolve the hotel (tenant) from the host's subdomain, e.g.
// mgallery.stayos.org -> "mgallery". Apex domains, *.web.app previews and
// localhost fall back to the default tenant.
function resolveTenant() {
    const host = (window.location.hostname || '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
        return DEFAULT_TENANT;
    }
    const parts = host.split('.');
    if (parts.length < 3) return DEFAULT_TENANT;            // apex, e.g. stayos.org
    const sub = parts[0];
    if (sub === 'www' || sub === 'app') return DEFAULT_TENANT;
    return sub;
}

// Synthetic e-mail domain for a tenant. The first hotel keeps its original
// domain so existing Firebase Auth accounts are not affected; new hotels get
// their own namespace so usernames never collide across hotels.
function tenantEmailDomain(tenantId) {
    return tenantId === 'mgallery' ? 'hotel.com' : tenantId + '.com';
}

// Build the login e-mail for a username within a tenant, e.g.
// ("reception", "grandhotel") -> "reception@grandhotel.com".
function userEmail(username, tenantId) {
    return username + '@' + tenantEmailDomain(tenantId);
}
