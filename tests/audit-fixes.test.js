/* Denetim düzeltmeleri — Admin paneli, PWA bildirimleri, Misafir Kayıtları.
 *
 * Saf mantık, emülatörsüz. Her blok KAYNAKTAN okunup değerlendirilir
 * (kopyası değil): bu dosyalar tarayıcı script'i, module.exports taşımıyor.
 * Böylece düzeltme geri alınırsa test gerçekten kırılır. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
function slice(src, startMarker, endMarker) {
    const a = src.indexOf(startMarker);
    const b = src.indexOf(endMarker, a + startMarker.length);
    assert.ok(a > -1 && b > a, 'blok bulunamadı: ' + startMarker);
    return src.slice(a, b);
}

// ════════════════════════════════════════════════════════════════
//  Admin → kullanıcı düzenleme: rol seçici
// ════════════════════════════════════════════════════════════════
// Superadmin rolleri küçük harfle yazar ('admin'); seçici 'Admin' değerli.
// `select.value = 'admin'` eşleşmeyince seçici boş kalıyor, kaydet
// `role: ''` yazıyordu → otel admini kendi yetkisini kaybediyordu.
const adminSrc = read('js/modules/admin.js');
function fakeRoleSelect() {
    const options = ['Staff', 'Manager', 'Admin'].map(v => ({ value: v, dataset: {}, remove() {} }));
    const sel = {
        options,
        _value: '',
        // Gerçek <select> gibi: eşleşmeyen değer → '' (Chromium'da doğrulandı).
        set value(v) { this._value = options.some(o => o.value === v) ? v : ''; },
        get value() { return this._value; },
        querySelectorAll() {
            return { forEach: (fn) => options.filter(o => o.dataset.extra).forEach(o => fn({ remove: () => options.splice(options.indexOf(o), 1) })) };
        },
        appendChild(o) { options.push(o); }
    };
    return sel;
}
function loadSetRoleSelect(sel) {
    const block = slice(adminSrc, '    function setRoleSelect(role) {', '    // Kullanıcı adı giriş kimliğidir');
    const doc = { getElementById: () => sel, createElement: () => ({ value: '', textContent: '', dataset: {} }) };
    return new Function('document', block + '\nreturn setRoleSelect;')(doc);
}

test('rol seçici küçük harfli kayıttaki rolü doğru seçer (boş bırakmaz)', () => {
    const sel = fakeRoleSelect();
    const setRoleSelect = loadSetRoleSelect(sel);
    setRoleSelect('admin');
    assert.equal(sel.value, 'Admin');
    setRoleSelect('staff');
    assert.equal(sel.value, 'Staff');
    setRoleSelect('MANAGER');
    assert.equal(sel.value, 'Manager');
});

test('bilinmeyen rol kaybolmaz; seçiciye eklenip seçilir', () => {
    const sel = fakeRoleSelect();
    const setRoleSelect = loadSetRoleSelect(sel);
    setRoleSelect('auditor');
    assert.equal(sel.value, 'auditor');
});

test('düzenleme kaydı role ASLA boş değer yazmaz, kullanıcı adını yazmaz', () => {
    const upd = slice(adminSrc, '// UPDATE MODE', 'await db.collection(\'systemUsers\').doc(currentEditingUserId).update(upd);');
    assert.match(upd, /const newRole = role \|\| currentEditingUserRole;/);
    assert.match(upd, /if \(roleChanged\) upd\.role = newRole;/);
    assert.doesNotMatch(upd, /username:/, 'kullanıcı adı giriş kimliği — düzenlemede yazılmamalı');
});

// ════════════════════════════════════════════════════════════════
//  Admin → yeni kullanıcı adı normalizasyonu
// ════════════════════════════════════════════════════════════════
test('kullanıcı adı giriş ekranıyla AYNI şekilde küçültülür ve doğrulanır', () => {
    const block = slice(adminSrc, '    const USERNAME_RE =', '    let currentEditingUserId');
    const api = new Function(block + '\nreturn { USERNAME_RE, normalizeUsername };')();
    assert.equal(api.normalizeUsername('  İlker '), 'ilker');
    assert.equal(api.normalizeUsername('ADMIN'), 'admin'); // tr-TR'nin I→ı eşlemesi değil
    assert.ok(api.USERNAME_RE.test('ali.veli_1'));
    assert.ok(!api.USERNAME_RE.test('ali veli'));
    assert.ok(!api.USERNAME_RE.test('ayşe'));
    assert.ok(!api.USERNAME_RE.test('a'));
});

// ════════════════════════════════════════════════════════════════
//  Admin → Finans tarih aralığı (yerel takvim günü)
// ════════════════════════════════════════════════════════════════
// toISOString() UTC'ye çeviriyordu: İstanbul'da "Bu Ay" 31 Ekim → 29 Kasım.
test('finans "Bu Ay"/"Bugün" aralığı UTC+3 saat diliminde kaymaz', () => {
    const prevTZ = process.env.TZ;
    process.env.TZ = 'Europe/Istanbul';
    try {
        const block = slice(adminSrc, '        const iso = (d) =>', '        function render() {');
        const RealDate = Date;
        const mk = (fixedIso) => {
            const fixed = new RealDate(fixedIso).getTime();
            function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
            FakeDate.prototype = RealDate.prototype;
            FakeDate.now = () => fixed;
            return FakeDate;
        };
        const run = (rangeValue, nowIso) => new Function('Date', 'finRange', 'finFrom', 'finTo',
            block + '\nreturn rangeBounds();')(mk(nowIso), { value: rangeValue }, { value: '' }, { value: '' });
        assert.deepEqual(run('month', '2026-11-10T12:00:00+03:00'), ['2026-11-01', '2026-11-30']);
        assert.deepEqual(run('today', '2026-11-10T01:30:00+03:00'), ['2026-11-10', '2026-11-10']);
        assert.deepEqual(run('week', '2026-11-10T01:30:00+03:00'), ['2026-11-04', '2026-11-10']);
    } finally {
        if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ;
    }
});

test('finans para birimlerini karıştırmaz: aralık süzgeci para birimine bakar', () => {
    const r = slice(adminSrc, '        function render() {', '        function renderCommInputs()');
    assert.match(r, /curOf\(r\) === curSel/);
    assert.doesNotMatch(adminSrc, /const money = \(n\) => '€'/);
});

// ════════════════════════════════════════════════════════════════
//  Hazır Talepler → CSV seçenek ek ücreti gidiş-dönüş
// ════════════════════════════════════════════════════════════════
const catSrc = read('js/modules/request-catalog.js');
const catApi = new Function(
    slice(catSrc, '    function normalizeOption(o) {', '\n    }\n') + '\n    }\n' +
    slice(catSrc, '    function optionCsv(o) {', '    function itemKey(name, category) {') +
    '\nreturn { optionCsv, parseCsvOptions, normalizeOption };')();

test('dışa aktarılan seçenek ek ücreti geri yüklemede korunur', () => {
    const opts = [{ name: 'Büyük', priceDelta: 20 }, { name: 'Küçük', priceDelta: -5 }, { name: 'Normal', priceDelta: 0 }];
    const cell = opts.map(catApi.optionCsv).join(', ');
    assert.equal(cell, 'Büyük (+20), Küçük (-5), Normal');
    assert.deepEqual(catApi.parseCsvOptions(cell, null), opts);
});

test('ücretsiz biçimde (eski şablon) yüklenen seçenek mevcut ücreti SİLMEZ; "(0)" siler', () => {
    const existing = { options: [{ name: 'Büyük', priceDelta: 20 }, 'Eski'] };
    assert.deepEqual(catApi.parseCsvOptions('Büyük, Eski, Yeni', existing),
        [{ name: 'Büyük', priceDelta: 20 }, { name: 'Eski', priceDelta: 0 }, { name: 'Yeni', priceDelta: 0 }]);
    assert.deepEqual(catApi.parseCsvOptions('Büyük (0)', existing), [{ name: 'Büyük', priceDelta: 0 }]);
});

test('CSV seçenekleri: en fazla 10, tekrarlar atlanır', () => {
    const many = Array.from({ length: 14 }, (_, i) => 'S' + i).join(', ') + ', S1';
    const out = catApi.parseCsvOptions(many, null);
    assert.equal(out.length, 10);
    assert.equal(new Set(out.map(o => o.name)).size, 10);
});

// ════════════════════════════════════════════════════════════════
//  Misafir Kayıtları → Türkçe arama
// ════════════════════════════════════════════════════════════════
const panelSrc = read('js/modules/panel.js');
test('kayıt araması Türkçe İ/ı ve sayı alanlarıyla çalışır', () => {
    const line = panelSrc.split('\n').find(l => l.includes('const searchFold = '));
    assert.ok(line, 'searchFold bulunamadı');
    const searchFold = new Function(line.trim() + '\nreturn searchFold;')();
    const hit = (hay, q) => searchFold(hay).includes(searchFold(q));
    assert.ok(hit('İlker Şahin', 'ilker'));   // önceden false
    assert.ok(hit('İlker Şahin', 'İLKER'));
    assert.ok(hit('IŞIK', 'ışık'));
    assert.ok(hit(305, '30'));                 // önceden TypeError
});

test('kayıt araması durumun TÜRKÇE etiketini de kapsar', () => {
    const f = slice(panelSrc, 'const matchesText =', 'const matchesDate');
    assert.match(f, /statusLabelOf\(r\.status\)/);
    assert.match(f, /searchFold\(field\)/);
});

test('ulaşılamayan Raporlar / Misafir Kayıt Defteri modalı kaldırıldı', () => {
    const html = read('panel.html');
    assert.doesNotMatch(html, /id="reportsModal"|id="guestProfileModal"|generateReportFromUI/);
    assert.doesNotMatch(panelSrc, /openReportsBtn|guestProfilesBtn|renderGuestProfileList|lastRenderedRows/);
});

// ════════════════════════════════════════════════════════════════
//  PWA → push kaydı (firebase-messaging 8.10.0 davranışıyla)
// ════════════════════════════════════════════════════════════════
// SDK'da useServiceWorker() ikinci kez çağrılınca 'use-sw-after-get-token'
// fırlatır (gstatic 8.10.0 kaynağından doğrulandı). Önceden ilk denemeden
// sonraki her enable() — "Onar/Yenile", hesap değişiminde yeniden bağlama —
// bu hatayla düşüyordu.
function loadPush({ uid = 'u1', permission = 'granted' } = {}) {
    const src = read('js/core/push.js');
    const writes = [], deletes = [];
    let swReg = null, vapid = null;
    const messaging = {
        usePublicVapidKey(k) { if (vapid !== null) throw new Error('use-vapid-key-after-get-token'); vapid = k; },
        useServiceWorker(r) { if (swReg) throw new Error('messaging/use-sw-after-get-token'); swReg = r; },
        async getToken() { if (!swReg) swReg = { auto: true }; return 'tok-1'; },
        onTokenRefresh() { return function () {}; }
    };
    const auth = { currentUser: uid ? { uid } : null, onAuthStateChanged() {} };
    const db = {
        collection: () => ({
            doc: (id) => ({
                set: async (d) => { writes.push(Object.assign({ id }, d)); },
                delete: async () => { deletes.push(id); }
            })
        })
    };
    const firebase = {
        messaging: Object.assign(() => messaging, { isSupported: () => true }),
        firestore: { FieldValue: { serverTimestamp: () => 'ts' } }
    };
    const reg = { active: {}, installing: null, waiting: null };
    const navigator = {
        userAgent: 'test',
        serviceWorker: { register: async () => reg, getRegistration: async () => reg }
    };
    const Notification = { permission, requestPermission: async () => permission };
    const window = { Notification, addEventListener() {}, removeEventListener() {} };
    const document = { hidden: false, addEventListener() {} };
    const localStorage = { getItem: () => null };
    const consoleStub = { info() {}, warn() {}, log() {} };
    new Function('firebase', 'db', 'auth', 'navigator', 'Notification', 'window', 'document', 'localStorage', 'TENANT_ID', 'console',
        src)(firebase, db, auth, navigator, Notification, window, document, localStorage, 'otel', consoleStub);
    // 'serviceWorker' in navigator / 'Notification' in window kontrolleri için
    return { Push: window.Push, writes, deletes, auth };
}

test('"Onar" ilk kayıttan sonra da çalışır (useServiceWorker yalnızca bir kez)', async () => {
    const { Push, writes } = loadPush();
    await Push.repair();
    let st = Push.state();
    assert.equal(st.registered, true);
    assert.equal(st.error, '');
    await Push.repair(); // önceden: use-sw-after-get-token
    st = Push.state();
    assert.equal(st.error, '', 'ikinci onarım hata vermemeli');
    assert.equal(st.registered, true);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].uid, 'u1');
});

test('elle çıkışta bu cihazın token kaydı silinir (ortak cihaz sızıntısı)', async () => {
    const { Push, deletes } = loadPush();
    await Push.repair();
    assert.equal(await Push.detach(), true);
    assert.deepEqual(deletes, ['tok-1']);
    assert.equal(Push.state().registered, false);
});

test('detach, bu sayfada enable() hiç çalışmamışsa da token\'ı bulur', async () => {
    const { Push, deletes } = loadPush();
    assert.equal(await Push.detach(), true);
    assert.deepEqual(deletes, ['tok-1']);
});

test('izin yoksa / oturum yoksa detach hiçbir şey silmez', async () => {
    const a = loadPush({ permission: 'default' });
    assert.equal(await a.Push.detach(), false);
    assert.deepEqual(a.deletes, []);
    const b = loadPush({ uid: null });
    assert.equal(await b.Push.detach(), false);
    assert.deepEqual(b.deletes, []);
});

test('iOS: izin istemi dokunmatikte etkileşim sayılmayan pointerdown\'a bağlı değil', () => {
    const src = read('js/core/push.js');
    assert.doesNotMatch(src, /addEventListener\('pointerdown'/);
    assert.match(src, /addEventListener\('touchend', once/);
});

test('elle çıkış butonları hotelSignOut kullanır (push kaydını ayırır)', () => {
    const files = ['js/core/app-shell.js', 'js/modules/dashboard.js', 'js/modules/crm.js', 'js/modules/panel.js', 'js/modules/concierge.js'];
    files.forEach(f => assert.match(read(f), /hotelSignOut\('login'\)/, f + ' elle çıkışta hotelSignOut çağırmalı'));
    assert.match(read('js/core/firebase-config.js'), /async function hotelSignOut\(redirect\)/);
});

test('şifre sıfırlama bildirimi admin paneline gider, kayıt açmaz', () => {
    const fn = read('functions/index.js');
    assert.doesNotMatch(fn, /'\/app\.html#admin'/);
    assert.match(fn, /\? '\/admin#users'/);
    const rt = read('js/core/realtime.js');
    const open = slice(rt, 'RT.openRecord = function', 'RT.markRead');
    assert.ok(open.indexOf("type === 'passwordReset'") > -1 && open.indexOf("type === 'passwordReset'") < open.indexOf('RT.onOpen(recordId)'),
        'passwordReset, kayıt açıcıdan ÖNCE ele alınmalı');
});
