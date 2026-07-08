# Teklif Talebi E-posta Bildirimi Kurulumu (Resend)

Yeni bir teklif talebi (`quoteRequests`) geldiğinde `bu.gol@outlook.com`
adresine otomatik bir e-posta gönderilir. Firebase'in kendisi e-posta
göndermiyor — [Resend](https://resend.com)'in HTTP API'si kullanılıyor.
Kod tarafı (`functions/index.js` → `onQuoteRequestCreate`) zaten hazır;
aktif olması için tek bir secret tanımlamanız yeterli.

---

## 1) Resend hesabı + API key

1. [resend.com](https://resend.com) → ücretsiz kaydolun (günlük 100 e-posta,
   aylık 3.000 e-posta ücretsiz katman — bu kullanım için fazlasıyla yeterli).
2. Dashboard → **API Keys** → **Create API Key** → bir isim verin (ör.
   "Hotizy teklif bildirimi") → oluşan anahtarı kopyalayın (yalnızca bir kez
   gösterilir).

## 2) Secret'ı tanımlayın

Terminalde proje klasöründeyken:
```
firebase functions:secrets:set RESEND_API_KEY
```
İstenince Resend'den kopyaladığınız anahtarı yapıştırın.

## 3) Deploy edin

```
firebase deploy --only functions:onQuoteRequestCreate
```
(Zaten genel bir `firebase deploy` çalıştıracaksanız bu otomatik dahil olur.)

## 4) Doğrulama

`https://hotizy.com` üzerindeki "Teklif Al" formunu test verisiyle doldurup
gönderin. Birkaç saniye içinde `bu.gol@outlook.com`'a bir e-posta gelmeli —
**ilk zamanlarda spam/gereksiz klasörünü de kontrol edin**, `onboarding@resend.dev`
gönderen adresinden gelen e-postalar bazı sağlayıcılarda ilk seferde spam'e
düşebilir (aşağıdaki adım 5 bunu kalıcı olarak çözer).

Bir şey gelmezse Firebase Console → Functions → `onQuoteRequestCreate` →
Logs'a bakın; `RESEND_API_KEY` yanlış/tanımsızsa veya Resend API bir hata
döndürürse burada görünür.

## 5) (Önerilir) Kendi domaininizden gönderin

Şu an gönderen adres Resend'in test alanı (`onboarding@resend.dev`) —
hemen çalışır ama daha az profesyonel görünür ve bazı gelen kutularında
spam'e düşme ihtimali biraz daha yüksektir. Kendi domaininizi doğrularsanız
(ör. `bildirim@hotizy.com`) daha güvenilir teslimat sağlarsınız:

1. Resend Dashboard → **Domains** → **Add Domain** → `hotizy.com` girin.
2. Resend'in verdiği DNS kayıtlarını (birkaç TXT/CNAME/MX) Cloudflare'deki
   DNS ayarlarınıza ekleyin — `hotizy.com` DNS'ini zaten Cloudflare'de
   yönettiğiniz için (bkz. `docs/cloudflare-hotizy-kurulum.md`) tanıdık bir
   adım olacaktır. **Bu kayıtları "Proxied" değil "DNS only" (gri bulut)**
   olarak ekleyin.
3. Doğrulama tamamlanınca (genelde birkaç dakika–birkaç saat) bana haber
   verin — `functions/index.js`'teki `QUOTE_NOTIFY_FROM` sabitini
   `Hotizy <bildirim@hotizy.com>` gibi kendi domaininize güncelleyip
   deploy ederim.

## Alıcı e-postayı değiştirmek isterseniz

`functions/index.js`'teki `QUOTE_NOTIFY_EMAIL` sabitini güncelleyip
yeniden deploy etmek yeterli — isterseniz bana söyleyin, ben güncelleyip
deploy talimatını veririm.
