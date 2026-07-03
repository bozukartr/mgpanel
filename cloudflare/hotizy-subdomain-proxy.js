/**
 * Hotizy — Cloudflare Worker: wildcard subdomain reverse-proxy → Firebase Hosting
 *
 * Neden gerekli: Firebase Hosting'in "Custom Domain" özelliği wildcard
 * subdomain desteklemiyor — her alt alan adı (grandhotel.hotizy.com,
 * mgallery.hotizy.com, ...) Firebase Console'da TEK TEK eklenip
 * doğrulanmalı, ve bir apex domain başına en fazla 20 subdomain sınırı var
 * (SSL sertifikası üretim limiti). Bu, superadmin.js'in yeni bir otel
 * oluştururken otomatik bir slug (subdomain) üretmesiyle ÇAKIŞIR — 20
 * otelden sonra (hatta öncesinde, her biri elle eklenmesi gerektiğinden)
 * yeni otel kaydı süreci tıkanır.
 *
 * Bu Worker, *.hotizy.com altındaki HER isteği (hangi otel/subdomain
 * olduğuna bakmaksızın) Firebase Hosting'in TEK, SABİT varsayılan adresine
 * yönlendirir. Firebase hiçbir zaman "hotizy.com"u bir custom domain olarak
 * tanımak zorunda kalmaz — Cloudflare tüm SSL/routing işini üstlenir,
 * Firebase normal *.web.app isteği gibi davranır. Tenant ayrımı zaten
 * istemci tarafında (js/core/firebase-config.js:resolveTenant(),
 * location.hostname okuyarak) yapıldığından, tarayıcı adres çubuğunda
 * gerçek subdomain (ör. grandhotel.hotizy.com) görünmeye devam eder — bu
 * Worker'ın arka planda hangi Firebase adresine gittiği tamamen görünmez.
 *
 * ── Deploy adımları (Cloudflare panelinde) ──────────────────────────────
 * 1. DNS  → wildcard kaydı ekle:
 *      Tür: AAAA   İsim: *   İçerik: 100::   Proxy: AÇIK (turuncu bulut)
 *    (100:: bir IPv6 "discard" adresidir — gerçek bir sunucuya gitmez;
 *    yalnızca Cloudflare'in isteği yakalayıp bu Worker'a yönlendirmesi
 *    için placeholder bir DNS kaydı gerekiyor.)
 * 2. Workers & Pages → Create Worker → bu dosyanın içeriğini yapıştır.
 * 3. Worker → Settings → Domains & Routes → Route ekle: *.hotizy.com/*
 * 4. SSL/TLS → Overview → mod: Full
 * 5. Firebase Hosting Console'da hotizy.com'u custom domain olarak
 *    EKLEMEYİN — bu Worker onun yerine geçiyor. (İsteğe bağlı: apex
 *    hotizy.com ve www.hotizy.com'u ayrıca Firebase'e custom domain olarak
 *    eklemek isterseniz sorun değil, wildcard limiti yalnızca subdomain
 *    SAYISINI etkiler; ama bu Worker zaten hepsini kapsadığından gerek yok.)
 *
 * FIREBASE_PROJECT_ID değişirse (yeni bir Firebase projesine taşınırsa)
 * yalnızca aşağıdaki sabiti güncelleyin.
 */

const FIREBASE_PROJECT_ID = 'panel-d25c9';
const FIREBASE_ORIGIN = `https://${FIREBASE_PROJECT_ID}.web.app`;

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    const targetUrl = FIREBASE_ORIGIN + incomingUrl.pathname + incomingUrl.search;

    const outboundHeaders = new Headers(request.headers);
    // Host header'ı hedefe (panel-d25c9.web.app) göre ayarla — aksi halde
    // gelen isteğin orijinal Host'u (ör. grandhotel.hotizy.com) taşınır ve
    // Firebase'in edge'i bu domaini tanımadığından isteği reddeder/404 döner.
    outboundHeaders.set('Host', `${FIREBASE_PROJECT_ID}.web.app`);
    // Orijinal subdomain'i (loglama/hata ayıklama amaçlı) sakla — uygulama
    // kodu buna bağımlı değil (tenant ayrımı istemci tarafında yapılıyor).
    outboundHeaders.set('X-Forwarded-Host', incomingUrl.hostname);

    const init = {
      method: request.method,
      headers: outboundHeaders,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    };

    return fetch(targetUrl, init);
  },
};
