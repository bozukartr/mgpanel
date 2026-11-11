/* Hotizy — Face ID / Touch ID / Windows Hello (passkey) istemci yardımcısı.
 *
 * Sunucu (functions/passkey-core.js) seçenekleri base64url metinlerle döner;
 * tarayıcının WebAuthn API'si ArrayBuffer bekler. Bu dosya iki yön arasında
 * çevirir ve tarayıcı yanıtını sunucunun beklediği JSON'a dönüştürür.
 * Harici kütüphane yok.
 *
 *   Passkey.available()   → Promise<boolean>  (cihazda biyometrik doğrulayıcı var mı)
 *   Passkey.create(opts)  → Promise<RegistrationResponseJSON>
 *   Passkey.get(opts)     → Promise<AuthenticationResponseJSON>
 *   Passkey.label()       → 'Face ID' | 'Touch ID' | 'Windows Hello' | 'Parmak izi'
 *   Passkey.markDevice(uid), deviceHasKey(), userHasKeyHere(uid), forgetDevice(), forgetUser(uid)
 *     → bu cihazda bu adres için Face ID girişi açıldı mı (yalnızca düğmeyi
 *       gösterip göstermemek için bir ipucu; güvenlik sunucudadır).
 *   Passkey.signalUnknown(id) → sunucuda silinmiş kaydı cihaza bildirir.
 */
(function (global) {
    'use strict';
    function b64urlToBuf(s) {
        s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
        const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
        const bin = atob(s + '='.repeat(pad));
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return u.buffer;
    }
    function bufToB64url(buf) {
        const u = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const supported = () => !!(global.PublicKeyCredential && global.navigator && navigator.credentials && navigator.credentials.create);

    async function available() {
        if (!supported() || !global.isSecureContext) return false;
        try {
            return !!(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
                && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
        } catch (e) { return false; }
    }

    function extResults(cred) {
        try { return cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}; } catch (e) { return {}; }
    }

    async function create(opts) {
        const pk = Object.assign({}, opts, {
            challenge: b64urlToBuf(opts.challenge),
            user: Object.assign({}, opts.user, { id: b64urlToBuf(opts.user.id) }),
            excludeCredentials: (opts.excludeCredentials || []).map(c => Object.assign({}, c, { id: b64urlToBuf(c.id) }))
        });
        delete pk.hints;
        const cred = await navigator.credentials.create({ publicKey: pk });
        if (!cred) throw new Error('Kayıt iptal edildi.');
        const r = cred.response;
        return {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            authenticatorAttachment: cred.authenticatorAttachment || undefined,
            clientExtensionResults: extResults(cred),
            response: {
                clientDataJSON: bufToB64url(r.clientDataJSON),
                attestationObject: bufToB64url(r.attestationObject),
                transports: (r.getTransports ? r.getTransports() : []) || []
            }
        };
    }

    async function get(opts) {
        const pk = Object.assign({}, opts, {
            challenge: b64urlToBuf(opts.challenge),
            allowCredentials: (opts.allowCredentials || []).map(c => Object.assign({}, c, { id: b64urlToBuf(c.id) }))
        });
        delete pk.hints;
        const cred = await navigator.credentials.get({ publicKey: pk });
        if (!cred) throw new Error('Giriş iptal edildi.');
        const r = cred.response;
        return {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            authenticatorAttachment: cred.authenticatorAttachment || undefined,
            clientExtensionResults: extResults(cred),
            response: {
                clientDataJSON: bufToB64url(r.clientDataJSON),
                authenticatorData: bufToB64url(r.authenticatorData),
                signature: bufToB64url(r.signature),
                userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined
            }
        };
    }

    function label() {
        const ua = (global.navigator && navigator.userAgent) || '';
        const touchMac = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1; // iPadOS masaüstü kipi
        if (/iPhone|iPad|iPod/.test(ua) || touchMac) return 'Face ID';
        if (/Macintosh|Mac OS X/.test(ua)) return 'Touch ID';
        if (/Windows/.test(ua)) return 'Windows Hello';
        return 'Parmak izi';  // Android ve diğerleri (ekran kilidi: parmak izi / yüz / PIN)
    }
    // Kullanıcı vazgeçti mi (iptal / süre doldu) — hata yerine sakin mesaj için.
    function isCancel(e) { return !!e && (e.name === 'NotAllowedError' || e.name === 'AbortError'); }

    const KEY = () => 'hz_pk_' + location.host;
    function markDevice(uid) {
        try {
            localStorage.setItem(KEY(), '1');
            if (uid) localStorage.setItem('hz_pk_u_' + uid, '1');
        } catch (e) {}
    }
    function deviceHasKey() { try { return localStorage.getItem(KEY()) === '1'; } catch (e) { return false; } }
    function userHasKeyHere(uid) { try { return localStorage.getItem('hz_pk_u_' + uid) === '1'; } catch (e) { return false; } }
    function forgetDevice() { try { localStorage.removeItem(KEY()); } catch (e) {} }
    function forgetUser(uid) { try { localStorage.removeItem('hz_pk_u_' + uid); } catch (e) {} }

    // Sunucuda silinmiş bir passkey'i cihaza bildir (destekleyen tarayıcılar
    // — Safari 26+, Chrome 132+ — cihazdaki kaydı da kaldırır). Best-effort.
    function signalUnknown(credentialId) {
        try {
            if (global.PublicKeyCredential && PublicKeyCredential.signalUnknownCredential && credentialId) {
                PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: credentialId }).catch(function () {});
            }
        } catch (e) {}
    }

    global.Passkey = { available, create, get, label, isCancel, markDevice, deviceHasKey, userHasKeyHere, forgetDevice, forgetUser, signalUnknown, _b64: { b64urlToBuf, bufToB64url } };
})(window);
