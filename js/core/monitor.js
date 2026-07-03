/* Hotizy — Hafif istemci-tarafı hata izleme (kendi içinde, 3. taraf yok).
 *
 * Global hataları ve yakalanmamış promise reddini yakalar; ayrıca catch
 * bloklarından Monitor.capture(err, ctx) ile çağrılır. Hatalar tenant-scoped
 * `errorLogs` koleksiyonuna yazılır (superadmin görüntüler) ve her zaman
 * console'a yapılandırılmış biçimde basılır.
 *
 * Tasarım ilkeleri:
 *  - İzleme katmanı UYGULAMAYI ASLA BOZMAZ: tüm yollar kendi içinde yutulur.
 *  - Döngü/kota güvenliği: aynı (mesaj+rota) 60 sn içinde tekilleştirilir,
 *    dakikada en çok RATE_MAX yazım yapılır.
 *  - Yalnızca gerçek (anonim olmayan) personel oturumları Firestore'a yazar;
 *    anonim QR misafirleri yalnızca console'a düşer (kötüye kullanım/gürültü
 *    önlenir). Oturum yoksa yine yalnızca console.
 *
 * firebase-config.js'den SONRA yüklenir; `db`, `auth`, `firebase`, `TENANT_ID`
 * global'lerine güvenir (hiçbiri yoksa zarifçe console-only çalışır).
 */
(function (global) {
    'use strict';

    var COL = 'errorLogs';
    var RATE_MAX = 20;          // dakika başına en çok yazım
    var DEDUP_MS = 60000;       // aynı imza bu süre içinde tek yazılır
    var MSG_MAX = 1000;         // mesaj kırpma
    var STACK_MAX = 4000;       // stack kırpma
    var CTX_MAX = 2000;         // context JSON kırpma

    var recent = {};            // imza -> son yazım zamanı (ms)
    var windowStart = 0;        // geçerli dakika penceresi başlangıcı
    var windowCount = 0;        // bu penceredeki yazım sayısı

    function nowMs() { return new Date().getTime(); }

    function trunc(s, n) {
        s = (s == null) ? '' : String(s);
        return s.length > n ? s.slice(0, n) + '…' : s;
    }

    // Hata-benzeri her şeyden mesaj+stack çıkarır.
    function describe(err) {
        if (err == null) return { message: '(boş hata)', stack: '' };
        if (typeof err === 'string') return { message: err, stack: '' };
        if (err instanceof Error || (err && err.message)) {
            return { message: err.message || String(err), stack: err.stack || '' };
        }
        try { return { message: JSON.stringify(err), stack: '' }; }
        catch (e) { return { message: String(err), stack: '' }; }
    }

    function safeCtx(ctx) {
        if (ctx == null) return null;
        try { return trunc(JSON.stringify(ctx), CTX_MAX); }
        catch (e) { return '(serileştirilemeyen context)'; }
    }

    function curUid() {
        try { return (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser.uid : null; }
        catch (e) { return null; }
    }
    function isAnon() {
        try { return (typeof auth !== 'undefined' && auth.currentUser) ? !!auth.currentUser.isAnonymous : true; }
        catch (e) { return true; }
    }
    function curUsername() {
        try { return localStorage.getItem('hotelUsername') || null; } catch (e) { return null; }
    }
    function curTenant() {
        try { return (typeof TENANT_ID !== 'undefined') ? TENANT_ID : null; } catch (e) { return null; }
    }

    // Yalnızca anonim olmayan oturum + db hazırsa Firestore'a yaz.
    function canPersist() {
        try {
            if (typeof db === 'undefined' || typeof firebase === 'undefined' || !firebase.firestore) return false;
            if (!auth || !auth.currentUser || auth.currentUser.isAnonymous) return false;
            if (!curTenant()) return false;
            return true;
        } catch (e) { return false; }
    }

    function allowWrite(sig) {
        var t = nowMs();
        // dakika penceresi
        if (t - windowStart > 60000) { windowStart = t; windowCount = 0; }
        if (windowCount >= RATE_MAX) return false;
        // dedup
        if (recent[sig] && (t - recent[sig]) < DEDUP_MS) return false;
        recent[sig] = t;
        windowCount++;
        // recent haritasını sınırla
        var keys = Object.keys(recent);
        if (keys.length > 200) { delete recent[keys[0]]; }
        return true;
    }

    function persist(level, message, stack, route, ctxStr) {
        if (!canPersist()) return;
        var sig = level + '|' + route + '|' + message;
        if (!allowWrite(sig)) return;
        try {
            db.collection(COL).add({
                tenantId: curTenant(),
                level: level,
                message: trunc(message, MSG_MAX),
                stack: trunc(stack, STACK_MAX),
                route: route,
                context: ctxStr,
                uid: curUid(),
                username: curUsername(),
                userAgent: trunc((global.navigator && navigator.userAgent) || '', 300),
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(function () { /* izleme yazımı sessizce başarısız olabilir */ });
        } catch (e) { /* asla fırlatma */ }
    }

    function route() {
        try { return (global.location ? (location.pathname + location.search) : ''); } catch (e) { return ''; }
    }

    function emit(level, err, ctx) {
        var d = describe(err);
        var r = route();
        var ctxStr = safeCtx(ctx);
        // Her zaman console'a yapılandırılmış çıktı.
        try {
            var fn = (level === 'error') ? 'error' : (level === 'warn' ? 'warn' : 'log');
            (console[fn] || console.log).call(console, '[Hotizy:' + level + ']', d.message, ctx || '', d.stack || '');
        } catch (e) { /* yoksay */ }
        persist(level, d.message, d.stack, r, ctxStr);
    }

    var Monitor = {
        capture: function (err, ctx) { emit('error', err, ctx); },
        warn: function (msg, ctx) { emit('warn', msg, ctx); },
        info: function (msg, ctx) { emit('info', msg, ctx); }
    };

    // Global yakalayıcılar (uygulama kodu çağırmasa bile).
    try {
        global.addEventListener('error', function (e) {
            var err = e.error || (e.message ? { message: e.message, stack: (e.filename || '') + ':' + (e.lineno || '') } : e);
            emit('error', err, { type: 'window.onerror' });
        });
        global.addEventListener('unhandledrejection', function (e) {
            emit('error', e.reason || e, { type: 'unhandledrejection' });
        });
    } catch (e) { /* eski tarayıcı — yoksay */ }

    global.Monitor = Monitor;
})(window);
