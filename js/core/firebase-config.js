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

// Canlı (prod) barındırma: hotizy.com ve tüm alt alan adları. ?tenant=
// override'ı yalnızca bunun DIŞINDAki ortamlarda (yerel geliştirme, Firebase
// önizleme kanalları) kabul edilir — aksi halde herhangi biri
// hotizy.com/guest-order?tenant=baskaOtel gibi bir URL ile misafir olarak
// başka bir otelin talep kuyruğuna sahte kayıt enjekte edebilirdi (kimlik
// doğrulaması gerekmeyen anonim misafir akışında). Prod'da tenant HER ZAMAN
// gerçek subdomain'den çözülür, client'ın iddia ettiği değerden değil.
function isProdHost() {
    const host = (window.location.hostname || '').toLowerCase();
    return host === 'hotizy.com' || host.endsWith('.hotizy.com');
}

// Resolve the hotel (tenant) from the host's subdomain, e.g.
// mgallery.hotizy.com -> "mgallery". Apex domains, *.web.app previews and
// localhost fall back to the default tenant.
function resolveTenant() {
    // Explicit ?tenant= override — yalnızca prod DIŞINDA: yerel/önizleme
    // ortamlarında custom-domain subdomain'i olmadan test etmeyi sağlar
    // (e.g. .../login?tenant=testhotel).
    if (!isProdHost()) {
        try {
            const q = (new URLSearchParams(window.location.search).get('tenant') || '').toLowerCase();
            if (/^[a-z0-9-]{2,24}$/.test(q)) return q;
        } catch (e) { /* ignore */ }
    }

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

// Which hotel's state (e.g. maintenance) applies to the current page: an
// explicit ?tenant override wins (non-prod only — see resolveTenant()), then
// the signed-in hotel, then the host.
function guardTenant() {
    if (!isProdHost()) {
        try {
            const q = (new URLSearchParams(window.location.search).get('tenant') || '').toLowerCase();
            if (/^[a-z0-9-]{2,24}$/.test(q)) return q;
        } catch (e) { /* ignore */ }
    }
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

// Oturum kapatılırken temizlenmesi gereken TÜM personel-oturumu anahtarları.
// Önceden her sayfanın kendi logout handler'ı yalnızca hotelUsername/
// hotelTenantId'yi temizliyordu; rol/modül/plan bayrakları bir sonraki
// oturuma (aynı tarayıcıda farklı biri giriş yapana kadar) sızabiliyordu —
// bkz. auth denetimi. Her logout handler'ı auth.signOut()'tan sonra bunu
// çağırmalı.
function clearSessionStorage() {
    ['hotelUsername', 'hotelTenantId', 'hotelDept', 'hotelRole', 'userModules', 'loginContext',
     'hotelModules', 'hotelMaxUsers', 'hotelPlan', 'hotelPmsEnabled'].forEach(k => localStorage.removeItem(k));
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
//
// Departman adı: kanonik değer "Yiyecek & İçecek" — otelin "Departman & Konu"
// ayarındaki (issue-config.js) varsayılan talep/şikayet departmanıyla AYNI
// string, kasıtlı. Önceden bu sabit ayrı bir İngilizce isimdi
// ("Food & Beverage"): kullanıcı oluşturma listesinde aynı departman İKİ
// AYRI seçenek gibi görünüyordu ve — daha ciddisi — panel.js'teki katı
// departman eşleştirmesi bu iki string'i FARKLI sayıp F&B personelinin
// bazı kayıtları üstlenmesini engelliyordu (kaynağa göre — QR vs elle
// giriş — aynı iş farklı departman string'iyle açılabiliyordu).
// FNB_DEPT_LEGACY, bu değişiklikten ÖNCE yazılmış hesap/kayıtlar için
// geriye dönük eşleştirme sağlar (isFnbDept/sameDept ikisini eş sayar) —
// var olan F&B personeli yeniden oluşturulmadan giriş yapmaya devam eder.
const FNB_DEPT = 'Yiyecek & İçecek';
const FNB_DEPT_LEGACY = 'Food & Beverage';
function deptKey(s) { return String(s || '').trim().toLocaleLowerCase('tr-TR'); }
function isFnbDept(name) {
    const k = deptKey(name);
    return k === deptKey(FNB_DEPT) || k === deptKey(FNB_DEPT_LEGACY);
}
// İki departman adı aynı departmanı mı ifade ediyor? (biri güncel, biri eski
// F&B ismi olabilir) — panel.js katı departman kuralı ve rapor gruplaması
// ham string eşitliği yerine bunu kullanır.
function sameDept(a, b) {
    const ka = deptKey(a), kb = deptKey(b);
    if (!ka || !kb) return ka === kb;
    if (ka === kb) return true;
    return isFnbDept(a) && isFnbDept(b);
}
// Görüntüleme/gruplama için TEK bir isme indirger: eski F&B adı ("Food &
// Beverage") kanonik "Yiyecek & İçecek"e döner, başka her şey olduğu gibi
// kalır. reports.js facet'leri bunu kullanır — aksi halde aynı departman
// filtre listesinde iki ayrı chip olarak görünmeye devam ederdi.
function canonicalDept(name) {
    return isFnbDept(name) ? FNB_DEPT : (name || '');
}
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
