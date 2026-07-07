# Cloudflare + Firebase Hosting Kurulum Rehberi (Hotizy)

Bu rehber, `hotizy.com` alan adını Firebase Hosting'e bağlarken **her otel için
ayrı bir subdomain** (ör. `grandhotel.hotizy.com`, `mgallery.hotizy.com`)
otomatik çalışacak şekilde Cloudflare'i yapılandırmak içindir.

> Proje: `panel-d25c9` · Firebase varsayılan adresi: `panel-d25c9.web.app`

---

## 0) Neden düz "Firebase Custom Domain" yetmiyor?

Firebase Hosting'in Console'daki "Custom Domain" özelliği **wildcard
subdomain desteklemiyor**:

- Her alt alan adı **tek tek** eklenip doğrulanmalı (Firebase her biri için
  ayrı bir SSL sertifikası üretiyor).
- Bir apex domain (`hotizy.com`) başına **en fazla 20 subdomain** sınırı var.

`superadmin.js`'deki otel oluşturma akışı, yeni bir otel kaydedildiğinde bir
`slug` (subdomain) üretir — **hiçbir manuel DNS/Firebase adımı içermez**. Düz
Firebase Custom Domain kullanılırsa, 20. otelden sonra (hatta öncesinde, her
biri elle Firebase Console'a eklenmesi gerektiğinden) yeni otel kaydı süreci
tıkanır.

**Çözüm:** Cloudflare, `*.hotizy.com` için ücretsiz planda bile wildcard SSL +
wildcard proxy destekliyor. Bir Cloudflare Worker, gelen **her** subdomain
isteğini (hangi otel olduğuna bakmaksızın) Firebase Hosting'in **sabit**
varsayılan adresine (`panel-d25c9.web.app`) yönlendirir. Tenant ayrımı zaten
istemci tarafında yapıldığından (`js/core/firebase-config.js:resolveTenant()`,
`location.hostname` okuyarak), tarayıcı adres çubuğunda gerçek subdomain
görünmeye devam eder — Firebase hiçbir zaman `hotizy.com`'u bir custom domain
olarak tanımak zorunda kalmaz.

Worker kodu: [`cloudflare/hotizy-subdomain-proxy.js`](../cloudflare/hotizy-subdomain-proxy.js)

---

## 1) Cloudflare'de DNS kaydı (wildcard)

Cloudflare panelinde **DNS** sekmesine gidin, şu kaydı ekleyin:

| Tür | İsim | İçerik | Proxy durumu |
|---|---|---|---|
| AAAA | `*` | `100::` | **Proxied** (turuncu bulut açık) |

`100::` bir IPv6 "discard" adresidir — gerçek bir sunucuya gitmez, yalnızca
Cloudflare'in isteği yakalayıp aşağıdaki Worker'a yönlendirmesi için
placeholder bir DNS kaydıdır (gerçek yanıtı Worker üretir, bu kayda hiç
gidilmez).

Apex (`hotizy.com`) ve `www.hotizy.com` için de aynı şekilde ayrı `A`/`AAAA`
veya `CNAME` kayıtları ekleyin (Proxied), böylece `index.html`'deki apex
yönlendirme mantığı da bu Worker üzerinden çalışır.

---

## 2) Worker'ı oluştur (GitHub ile bağlı — otomatik deploy)

Worker, Cloudflare'in **GitHub entegrasyonu** ile `bozukartr/mgpanel` reposuna
bağlanmış (`Workers & Pages → Create → Import a repository`). Bu sayede kod
manuel yapıştırılmıyor — repoda `main` dalına her push, Worker'ı otomatik
yeniden deploy ediyor.

Bu bağlantının çalışması için repo kökünde iki dosya bulunur:

- **`wrangler.jsonc`** — Worker adı (`hotizy-proxy`) ve giriş noktası
  (`cloudflare/hotizy-subdomain-proxy.js`) burada tanımlı.
- **`cloudflare/hotizy-subdomain-proxy.js`** — asıl reverse-proxy kodu.

> ⚠️ Cloudflare'in GitHub entegrasyonu repoyu ilk bağladığınızda otomatik bir
> `wrangler.jsonc` **PR'ı** açar ve genelde Worker'ı "statik dosya sunucusu"
> (`"assets": {"directory": "."}`) olarak yapılandırmayı önerir — bu, tüm
> repoyu doğrudan Cloudflare'den servis edip **Firebase Hosting'i (ve
> `/api/lemon-checkout`, `/api/lemon-webhook` rewrite'larını) bypass eder**.
> Bu PR'ı **merge etmeyin** — bu repodaki `wrangler.jsonc` zaten doğru
> (reverse-proxy) yapılandırmayı içeriyor; bot'un önerdiği versiyon yerine
> bu dosya kullanılmalı.

Worker'ın **Settings → Domains & Routes → Add → Route** kısmından:
- Route: `*.hotizy.com/*`
- Zone: `hotizy.com`

Apex ve `www` için de trafiğin bu Worker'dan geçmesini istiyorsanız aynı
route deseniyle kapsanır (`*.hotizy.com/*` yalnızca gerçek subdomain'leri
kapsar — apex için ayrıca `hotizy.com/*` route'u da ekleyin).

---

## 3) SSL/TLS modu

Cloudflare panelinde **SSL/TLS → Overview** → mod: **Full**.

(Worker, Firebase'e her zaman `https://panel-d25c9.web.app` üzerinden
doğrudan `fetch()` ile gittiğinden — discard DNS kaydına hiç gidilmediğinden
— bu ayar öncelikle istemci ↔ Cloudflare bacağını ilgilendirir; Universal SSL
`*.hotizy.com`'u otomatik kapsar.)

---

## 4) Firebase Hosting Console'da YAPILMAMASI gerekenler

`hotizy.com`'u veya herhangi bir `*.hotizy.com` subdomain'ini Firebase
Hosting Console'da **custom domain olarak eklemeyin** — bu Worker onun
yerine geçiyor. Firebase yalnızca kendi varsayılan `panel-d25c9.web.app`
adresini normal şekilde sunmaya devam eder; `firebase.json`'daki
`/api/lemon-checkout` ve `/api/lemon-webhook` rewrite'ları (Cloud Functions'a
giden ödeme webhook'ları dahil) bu adres üzerinden değişmeden çalışır.

---

## 5) Doğrulama

1. `https://mgallery.hotizy.com` (henüz var olmayan/test bir subdomain dahil)
   açıldığında Hotizy uygulamasının normal şekilde yüklendiğini doğrulayın.
2. Tarayıcı adres çubuğunun `panel-d25c9.web.app`'e değil, girdiğiniz
   subdomain'e sabit kaldığını kontrol edin.
3. Yeni bir otel oluşturup (`superadmin.js` → Otel Oluştur) üretilen slug'ın
   **hiçbir ek DNS/Firebase adımı olmadan** anında `slug.hotizy.com` üzerinden
   erişilebilir olduğunu doğrulayın.
4. Fiyatlandırma sayfasındaki ödeme akışının (`/api/lemon-checkout`,
   `/api/lemon-webhook`) hâlâ çalıştığını doğrulayın.

---

## 6) Misafir tenant imzası (`TENANT_SIG_SECRET`) — güvenlik sıkılaştırması

Bu Worker, gelen **gerçek** subdomain'i (`incomingUrl.hostname`) artık
HMAC-SHA256 ile imzalayıp `X-Hotizy-Tenant-*` header'ları olarak Firebase'e
iletiyor (`cloudflare/hotizy-subdomain-proxy.js`). `functions/index.js`'teki
`mintGuestClaim` bu imzayı doğrulayıp anonim misafir oturumuna **sunucu
tarafında doğrulanmış** bir tenant kimliği (Firebase Auth custom claim)
yazıyor; `firestore.rules` bu claim'i kullanarak bir misafirin gerçekten o
otelin subdomain'inden geldiğini teyit ediyor (bkz. `guestClaimTenant()`).

Bu mekanizmanın çalışması için **aynı gizli değer** iki yerde de tanımlı
olmalı — biri eksikse veya değerler uyuşmuyorsa `mintGuestClaim` imza
doğrulamasını reddeder ve sistem otomatik olarak eski (claim'siz) davranışa
düşer, **hiçbir şey kırılmaz**, yalnızca bu ek sıkılaştırma devre dışı kalır.

**a) Rastgele bir sır üretin** (yerel terminalinizde, tek seferlik):
```
openssl rand -hex 32
```

**b) Cloudflare Worker tarafı** — Cloudflare panelinde `hotizy-proxy` Worker'ı
açın → **Settings → Variables and Secrets → Add** → Type: **Secret** →
İsim: `TENANT_SIG_SECRET` → Value: (yukarıda ürettiğiniz değer). Kaydedin —
Worker otomatik yeniden başlar, ek bir deploy gerekmez.

**c) Firebase Functions tarafı** — aynı değeri Firebase'e tanımlayın:
```
firebase functions:secrets:set TENANT_SIG_SECRET
```
(İstenince aynı değeri yapıştırın.) Ardından fonksiyonu deploy edin:
```
firebase deploy --only functions:mintGuestClaim,hosting,firestore:rules
```

**d) Doğrulama:** Bir otelin `guest-order` sayfasını (`https://<slug>.hotizy.com/guest-order?room=1`)
açın, tarayıcı DevTools → Network sekmesinde `mint-guest-claim` isteğinin
`200` döndüğünü kontrol edin. Bu istek başarısız olsa bile sayfa normal
çalışmaya devam eder (geriye dönük uyumlu düşüş) — bu adım yalnızca ek bir
sıkılaştırmadır, misafir deneyimini bloklamaz.
