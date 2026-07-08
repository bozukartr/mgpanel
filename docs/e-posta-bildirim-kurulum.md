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
gönderin. Birkaç saniye içinde `bu.gol@outlook.com`'a bir e-posta gelmeli.

Bir şey gelmezse Firebase Console → Functions → `onQuoteRequestCreate` →
Logs'a bakın; `RESEND_API_KEY` yanlış/tanımsızsa veya Resend API bir hata
döndürürse burada görünür.

> **Bilinen tuzak (yaşandı):** Resend'in test göndereni (`onboarding@resend.dev`)
> yalnızca Resend HESABINA kayıtlı e-postaya gönderebilir, `bu.gol@outlook.com`'a
> DEĞİL — bu, gönderim 403 ile sessizce başarısız olduğunda e-postanın hiç
> gelmemesine yol açar. Aşağıdaki adım 5 (kendi domaininizi doğrulama) bu
> kısıtlamayı tamamen kaldırır ve artık uygulanmış durumda.

## 5) Kendi domaininizden gönderme — ✅ tamamlandı

`hotizy.com`, Resend'de doğrulandı (Cloudflare üzerinden DNS kayıtları
otomatik eklendi — DKIM/SPF/MX hepsi "Verified"). Gönderen adres artık
`Hotizy <bildirim@hotizy.com>` — kısıtlama kalktı, herhangi bir alıcıya
gönderilebiliyor. Yeniden yapılandırmaya gerek yok; yalnızca kod tarafındaki
`QUOTE_NOTIFY_FROM` sabitinin deploy edilmesi gerekiyor (bkz. adım 3).

## Alıcı e-postayı değiştirmek isterseniz

`functions/index.js`'teki `QUOTE_NOTIFY_EMAIL` sabitini güncelleyip
yeniden deploy etmek yeterli — isterseniz bana söyleyin, ben güncelleyip
deploy talimatını veririm.
