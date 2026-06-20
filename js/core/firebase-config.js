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
    // Explicit ?tenant= override — lets you test any hotel before custom-domain
    // subdomains exist (e.g. .../login.html?tenant=testhotel).
    try {
        const q = (new URLSearchParams(window.location.search).get('tenant') || '').toLowerCase();
        if (/^[a-z0-9-]{2,24}$/.test(q)) return q;
    } catch (e) { /* ignore */ }

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

// Which hotel's state (e.g. maintenance) applies to the current page:
// an explicit ?tenant override wins, then the signed-in hotel, then the host.
function guardTenant() {
    try {
        const q = (new URLSearchParams(window.location.search).get('tenant') || '').toLowerCase();
        if (/^[a-z0-9-]{2,24}$/.test(q)) return q;
    } catch (e) { /* ignore */ }
    return localStorage.getItem('hotelTenantId') || resolveTenant();
}

// --- Plan / package config ---
// Feature modules a hotel can have. Default (legacy hotels with no config):
// everything on, unlimited users — so nothing is restricted before a plan is set.
const ALL_MODULES = { concierge: true, crm: true, guestIssues: true, guestOrders: true };

// Monthly plan price in TRY (display only — the server is authoritative in
// functions/index.js). Used to show the amount on the renewal button.
const PLAN_PRICES = { starter: 7500, pro: 15000, enterprise: 30000 };

// Persist the hotel's plan/limits/modules at login so every page can gate
// features instantly without an extra read.
function applyTenantConfig(tenant) {
    const modules = (tenant && tenant.modules) ? tenant.modules : ALL_MODULES;
    localStorage.setItem('hotelModules', JSON.stringify(modules));
    localStorage.setItem('hotelMaxUsers', String((tenant && tenant.maxUsers) || 0));
    localStorage.setItem('hotelPlan', (tenant && tenant.plan) || '');
    // Cheap client gate: only attempt PMS lookups when the hotel has it on.
    localStorage.setItem('hotelPmsEnabled', (tenant && tenant.pmsEnabled) ? '1' : '0');
}

// Is PMS integration enabled for the signed-in hotel?
function pmsEnabled() {
    return localStorage.getItem('hotelPmsEnabled') === '1';
}

// Read the cached module flags. A module counts as enabled unless explicitly
// disabled, so legacy hotels keep full access.
function hotelModules() {
    try { return JSON.parse(localStorage.getItem('hotelModules')) || {}; }
    catch (e) { return {}; }
}
function moduleEnabled(key) {
    return hotelModules()[key] !== false;
}
