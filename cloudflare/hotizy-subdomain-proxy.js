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
 * ── Deploy ───────────────────────────────────────────────────────────────
 * Bu Worker (`hotizy-proxy`), Cloudflare'in GitHub entegrasyonu ile bu
 * repoya bağlı — `main`'e her push otomatik yeniden deploy eder (repo
 * kökündeki wrangler.jsonc, giriş noktası olarak bu dosyayı gösterir).
 * Manuel "kod yapıştır" adımı yok. Diğer tüm kurulum adımları (DNS wildcard
 * kaydı, Worker route'u, SSL modu, Firebase Console'da YAPILMAMASI
 * gerekenler) için: docs/cloudflare-hotizy-kurulum.md
 *
 * FIREBASE_PROJECT_ID değişirse (yeni bir Firebase projesine taşınırsa)
 * yalnızca aşağıdaki sabiti güncelleyin.
 *
 * ── Misafir tenant imzası (TENANT_SIG_SECRET) ───────────────────────────
 * Bu Worker, gerçek gelen subdomain'i (`incomingUrl.hostname`) HMAC-SHA256
 * ile imzalayıp X-Hotizy-Tenant-* header'ları olarak iletir. Bu, anonim
 * misafir oturumlarına (guest-order.js) sunucu-tarafında DOĞRULANABİLİR bir
 * tenant kimliği bağlamayı sağlar — functions/index.js'teki mintGuestClaim
 * bu imzayı kontrol edip Firebase Auth custom claim'i olarak yazar, ardından
 * firestore.rules o claim'i kullanarak "bu misafir gerçekten bu otelin
 * subdomain'inden mi geldi" diye doğrular. Aksi halde (yalnızca istemci
 * tarafında window.location.hostname okunuyor olsaydı) herhangi biri
 * doğrudan Firestore/Functions SDK çağrısıyla istediği tenant'ı iddia
 * edebilirdi. Secret hem burada (Cloudflare Worker secret) hem de Firebase
 * Functions secret olarak AYNI değerle tanımlanmalı — kurulum için:
 * docs/cloudflare-hotizy-kurulum.md
 *
 * Secret henüz tanımlı değilse imza sessizce atlanır; mintGuestClaim bu
 * durumda reddeder ve misafir tarafı eski (claim'siz, firestore.rules'daki
 * geriye dönük uyumlu) davranışa düşer — kademeli, kırılmasız devreye alma.
 */

const FIREBASE_PROJECT_ID = 'panel-d25c9';
const FIREBASE_ORIGIN = `https://${FIREBASE_PROJECT_ID}.web.app`;

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
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

    if (env && env.TENANT_SIG_SECRET) {
      const ts = Date.now().toString();
      const sig = await hmacHex(env.TENANT_SIG_SECRET, incomingUrl.hostname + '.' + ts);
      outboundHeaders.set('X-Hotizy-Tenant-Host', incomingUrl.hostname);
      outboundHeaders.set('X-Hotizy-Tenant-Ts', ts);
      outboundHeaders.set('X-Hotizy-Tenant-Sig', sig);
    }

    const init = {
      method: request.method,
      headers: outboundHeaders,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    };

    return fetch(targetUrl, init);
  },
};
