# Lemon Squeezy Kurulum Rehberi (Hotizy)

Bu rehber, Hotizy'taki Lemon Squeezy ödeme entegrasyonunu **sıfırdan, uçtan uca**
yapılandırmak içindir. Entegrasyon kodu zaten projede mevcut; burada yapman
gereken yalnızca **hesap/ürün/anahtar ayarları + deploy**.

> Proje: `panel-d25c9` · Bölge: `us-central1` · Site: `https://hotizy.com`

---

## 0) Mimari — nasıl çalışıyor?

İki ödeme akışı var, ikisi de aynı webhook'a bağlanır:

1. **Fiyatlandırma sayfası (herkese açık)** — `fiyatlandirma.html`'deki **"Hemen Öde"**
   butonu → `/api/lemon-checkout` (Cloud Function `lemonCheckout`) → tutar **sunucuda
   yeniden hesaplanır** → Lemon Squeezy ödeme sayfası açılır. Ödeme sonrası `lemonOrders`
   koleksiyonuna kayıt düşer (operatör oteli kurar).
2. **Panel içi yenileme (giriş yapmış otel yöneticisi)** — admin panelindeki **"Lemon
   Squeezy ile Öde"** butonu → callable `createLemonCheckout` → ödeme sayfası → ödeme
   sonrası `tenants/{id}.subscriptionEnd` **+1 ay** uzatılır.

Her iki akış da ödeme sonucu için **`lemonWebhook`** fonksiyonunu kullanır (imza
doğrulamalı). Webhook, `custom_data.tenant_id` varsa aboneliği uzatır; yoksa yeni
kayıt olarak `lemonOrders`'a yazar.

**Bileşenler:**

| Parça | Ne | Nerede |
|---|---|---|
| `lemonCheckout` | Herkese açık ödeme başlatma | Function (rewrite: `/api/lemon-checkout`) |
| `createLemonCheckout` | Panel içi yenileme | Callable function |
| `lemonWebhook` | Ödeme sonucu işleme | Function (rewrite: `/api/lemon-webhook`) |
| `LEMON_API_KEY` | LS API anahtarı | Firebase secret |
| `LEMON_WEBHOOK_SECRET` | Webhook imza anahtarı | Firebase secret |
| `lemonStoreId`, `lemonVariant*` | Store + plan variant ID'leri | `siteConfig/billing` (Süper Konsol → Muhasebe → Ayarlar) |

---

## 1) Lemon Squeezy hesabı & mağaza

1. [lemonsqueezy.com](https://www.lemonsqueezy.com) → kayıt ol.
2. Bir **Store** oluştur (mağaza adı, ülke, para birimi). Lemon Squeezy **Merchant of
   Record**'tur; KDV/sales tax'ı **o** toplar ve öder — sen ayrıca vergi entegrasyonu
   kurmazsın.
3. **Test Mode**'u aç (Dashboard sağ üst köşede test/live anahtarı). Tüm kurulumu
   önce test modunda yap. Test kartı: `4242 4242 4242 4242`, ileri tarih, herhangi CVC.

---

## 2) Ürünler (planlar) oluştur

3 ürün oluştur: **Starter**, **Pro**, **Enterprise**.

- **Products → New Product**.
- **Pricing model**: **Single payment (one-time / tek seferlik)** öneririz — Hotizy modeli
  "her ödeme = +1 ay" mantığında çalışır ve bu en sade eşleşmedir. (Abonelik de
  kullanılabilir; bkz. Notlar.)
- **Fiyat**: taban fiyatı gir (Starter €49 / Pro €99 / Enterprise €199). **Gerçek tahsilat
  tutarı API tarafından `custom_price` ile ezilir** (oda sayısı + modüllere göre hesaplanan
  toplam). Yani buradaki fiyat yalnızca "taban"dır.
  - Not: Bazı durumlarda `custom_price` ancak ürün **"Pay What You Want"** (PWYW) olarak
    işaretliyse uygulanır. Tutarın hesaplanan toplamla birebir gelmesini istiyorsan, ürünü
    PWYW yapıp önerilen fiyatı taban değer olarak ayarlaman en garantili yoldur.
- Ürünü **Publish** et.

### Variant ID'lerini al
Her ürün için: **Products → (ürünü aç) → Variants** sekmesi → ilgili variant'ın yanındaki
**⋯ → Copy ID** (sayısal bir değerdir). Üçünü not al:
`Starter variant ID`, `Pro variant ID`, `Enterprise variant ID`.

---

## 3) Store ID'yi al

Dashboard **sağ üst köşedeki mağaza menüsü** veya **Settings → Stores** altında sayısal
**Store ID** görünür. Not al.

> Alternatif: `curl -H "Authorization: Bearer <API_KEY>" -H "Accept: application/vnd.api+json" https://api.lemonsqueezy.com/v1/stores`

---

## 4) API anahtarı oluştur

**Settings → API → Create API key** → anahtarı **hemen kopyala** (bir daha tam haliyle
gösterilmez). Bu `LEMON_API_KEY` olacak.

---

## 5) Webhook oluştur

**Settings → Webhooks → Add endpoint**:

- **Callback URL**: `https://hotizy.com/api/lemon-webhook`
  - (Alternatif/doğrudan URL: `https://us-central1-panel-d25c9.cloudfunctions.net/lemonWebhook`)
- **Signing secret**: uzun, rastgele bir dize belirle (örn. 32+ karakter). Bunu **not al** —
  `LEMON_WEBHOOK_SECRET` olacak.
- **Events** (en azından ilki zorunlu):
  - ✅ `order_created` (tek seferlik ürünlerde ödeme bu olayla gelir)
  - ✅ `subscription_payment_success` (abonelik kullanırsan)
  - ✅ `subscription_created` (abonelik kullanırsan)

---

## 6) Firebase secret'larını ayarla

Proje kökünde (terminal):

```bash
firebase functions:secrets:set LEMON_API_KEY
# → 4. adımdaki API anahtarını yapıştır

firebase functions:secrets:set LEMON_WEBHOOK_SECRET
# → 5. adımdaki signing secret'ı yapıştır
```

> Secret'lar koda asla yazılmaz; yalnızca sunucuda saklanır.

---

## 7) Süper Konsol'da Store/Variant ID'lerini gir

**Süper Konsol (`/superadmin`) → Muhasebe → Ayarlar → "Lemon Squeezy (Online Ödeme)"**:

- **Store ID** → 3. adım
- **Starter / Pro / Enterprise Variant ID** → 2. adım
- **Kaydet**.

(Bunlar `siteConfig/billing` dokümanına yazılır.)

---

## 8) Deploy

```bash
firebase deploy --only functions,hosting
```

- `functions`: 3 yeni fonksiyon + secret bağlantıları.
- `hosting`: `/api/lemon-checkout` ve `/api/lemon-webhook` rewrite'ları + güncel sayfalar.

---

## 9) Test (test modunda)

1. **Fiyatlandırma akışı**: `https://hotizy.com/fiyatlandirma.html` → plan/oda/modül seç →
   **Hemen Öde** → LS ödeme sayfası açılmalı → test kartı (`4242…`) ile öde →
   `payment-result.html` "Ödemeniz Alındı" göstermeli.
2. **Webhook**: LS → **Settings → Webhooks → (endpoint) → Recent deliveries** → `200 OK`
   görmeli. (401 = imza uyuşmuyor, bkz. Sorun Giderme.)
3. **Sonuç**:
   - Fiyatlandırma akışı → Firestore'da `lemonOrders/{id}` `status: success` olmalı.
   - Panel içi yenileme → `tenants/{id}.subscriptionEnd` ileri tarihe kaymalı,
     `payments/{oid}` `success` olmalı.

---

## 10) Canlıya geçiş

1. LS'de **Test Mode'u kapat** (Live'a geç).
2. **Canlı bir API key** oluştur ve **canlı bir webhook** ekle (yeni signing secret ile) —
   test ve canlı anahtarlar farklıdır.
3. Secret'ları güncelle:
   ```bash
   firebase functions:secrets:set LEMON_API_KEY
   firebase functions:secrets:set LEMON_WEBHOOK_SECRET
   ```
4. **Redeploy**: `firebase deploy --only functions`.
5. Küçük bir gerçek ödemeyle uçtan uca doğrula.

---

## 11) Sorun giderme

| Belirti | Olası neden / çözüm |
|---|---|
| Webhook **401 bad signature** | `LEMON_WEBHOOK_SECRET`, LS'deki signing secret ile birebir aynı değil. Düzelt → `firebase deploy --only functions`. Test/canlı secret'ları karıştırma. |
| Buton **"Online ödeme şu an kullanılamıyor / yapılandırılmamış"** | `Store ID`/`Variant ID` (Ayarlar) veya `LEMON_API_KEY` eksik. Gir/ayarla ve redeploy. |
| **Tutar yanlış** (taban fiyat geliyor) | `custom_price` uygulanmıyor → ilgili ürünü **Pay What You Want** yap (2. adım notu). |
| **Abonelik uzamadı** | Webhook'ta `order_created` seçili mi? Panel içi ödemede `custom_data.tenant_id` taşınır; LS → Recent deliveries payload'unda `meta.custom_data` var mı kontrol et. |
| **Butonlar hiç çalışmıyor** | `firebase deploy --only functions,hosting` yapılmadı. |
| Webhook çağrısı hiç gelmiyor | Callback URL yanlış ya da hosting deploy edilmemiş. Doğrudan fonksiyon URL'sini dene. |

---

## Notlar

- **Tek seferlik vs abonelik**: Hotizy "her ödeme = +1 ay (yıllıkta +12 ay)" modelindedir.
  En basit eşleşme **tek seferlik ürün + `order_created`**'dır. Abonelik ürünü kullanırsan
  ilk ödeme `order_created` ile yine uzatır; otomatik yenileme ödemeleri
  `subscription_payment_success` ile gelir (bu olayda `custom_data` her zaman taşınmayabilir).
- **Para birimi**: tahsilat **EUR**'dur (planlar €). LS mağaza para birimini EUR seçmen önerilir.
- **Güvenlik**: tutarlar her zaman **sunucuda** yeniden hesaplanır; istemciden gelen fiyata
  güvenilmez. Webhook imza ile doğrulanır. Firestore kuralları değişmedi; `lemonOrders` /
  `lemonEvents` yalnızca sunucu (admin SDK) tarafından yazılır.
- **PayTR ile birlikte**: Lemon Squeezy PayTR'ı değiştirmez; ikisi yan yana çalışır. Müşteri
  hangisini isterse onu kullanır.

---

### Hızlı kontrol listesi

- [ ] LS store açıldı, test mode aktif
- [ ] 3 ürün (Starter/Pro/Enterprise) + variant ID'leri kopyalandı
- [ ] Store ID alındı
- [ ] API key oluşturuldu
- [ ] Webhook eklendi (URL + signing secret + `order_created`)
- [ ] `LEMON_API_KEY`, `LEMON_WEBHOOK_SECRET` secret olarak set edildi
- [ ] Süper Konsol → Ayarlar'a Store/Variant ID girildi
- [ ] `firebase deploy --only functions,hosting`
- [ ] Test ödemesi + webhook 200 + abonelik/lemonOrders doğrulandı
- [ ] Canlıya geçişte anahtarlar yenilendi + redeploy
