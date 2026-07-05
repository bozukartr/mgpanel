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
// mgallery.hotizy.com -> "mgallery". Apex domains, *.web.app previews and
// localhost fall back to the default tenant.
function resolveTenant() {
    // Explicit ?tenant= override — lets you test any hotel before custom-domain
    // subdomains exist (e.g. .../login?tenant=testhotel).
    try {
        const q = (new URLSearchParams(window.location.search).get('tenant') || '').toLowerCase();
        if (/^[a-z0-9-]{2,24}$/.test(q)) return q;
    } catch (e) { /* ignore */ }

    const host = (window.location.hostname || '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
        return DEFAULT_TENANT;
    }
    const parts = host.split('.');
    if (parts.length < 3) return DEFAULT_TENANT;            // apex, e.g. hotizy.com
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
const ALL_MODULES = { concierge: true, crm: true, guestIssues: true, reports: true, guestOrders: true, restaurant: true };

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

// --- Hotizy F&B (restaurant) access ---
// F&B staff sign in with a 5-digit numeric code. Firebase Auth requires a
// password of at least 6 chars, so the actual auth password is derived from the
// code with this fixed prefix. Staff only ever type the 5 digits; the system
// derives the same value for both account creation (admin) and login (F&B door).
const FNB_DEPT = 'Food & Beverage';
function fnbPassword(code) { return 'FB' + String(code || ''); }
// F&B personeli yalnızca 5 haneli koduyla (kullanıcı adı girmeden) giriş yapar.
// Hem e-posta hem şifre koddan türetildiği için giriş öncesi sorguya gerek yok.
// Kod tenant içinde benzersizdir (Firebase e-posta benzersizliği zorlar).
function fnbEmail(code, tenantId) { return userEmail('fb-' + String(code || ''), tenantId); }

// Read the cached module flags. A module counts as enabled unless explicitly
// disabled, so legacy hotels keep full access.
function hotelModules() {
    try { return JSON.parse(localStorage.getItem('hotelModules')) || {}; }
    catch (e) { return {}; }
}
// Per-user module access, set at login from the user's systemUsers doc. A module
// is allowed unless explicitly set to false, so users without a restriction keep
// full access (backward compatible).
function userModules() {
    try { return JSON.parse(localStorage.getItem('userModules')) || {}; }
    catch (e) { return {}; }
}
// A module is usable only if the hotel's plan includes it AND the signed-in
// user is allowed to see it.
function moduleEnabled(key) {
    return hotelModules()[key] !== false && userModules()[key] !== false;
}
