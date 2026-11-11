# Face ID / Touch ID ile giriş — kurulum ve işleyiş

Personel, otel yöneticisinin izin verdiği hesaplarda panele **şifre yazmadan**
telefonunun Face ID'si (Mac'te Touch ID, Windows'ta Windows Hello, Android'de
parmak izi) ile girebilir. Altyapı standart **passkey (WebAuthn)**'dir:
biyometrik veri cihazdan hiç çıkmaz; sunucu yalnızca cihazın açık anahtarını
saklar ve her girişte imzayı doğrular.

## Bir kerelik kurulum (Google Cloud)

Face ID girişi başarılı olunca sunucu bir Firebase özel token'ı imzalar. Cloud
Functions'ın bunu yapabilmesi için servis hesabına **Service Account Token
Creator** rolü gerekir. Cloud Shell'de bir kez çalıştırın.

Önce gcloud'da oturum açık olmalı (`firebase login` ayrıdır; firebase deploy
çalışıyor olsa da gcloud oturumsuz olabilir). `gcloud auth list` boşsa:

```bash
gcloud auth login          # bağlantıyı açın, projenin sahibi olan Google hesabıyla onaylayın, kodu yapıştırın
```

Ardından:

```bash
PROJECT=panel-d25c9
NUM=$(gcloud projects describe $PROJECT --format="value(projectNumber)")
SA="${NUM}-compute@developer.gserviceaccount.com"
echo "$SA"                 # 1234567890-compute@developer.gserviceaccount.com gibi görünmeli
gcloud services enable iamcredentials.googleapis.com --project $PROJECT
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="serviceAccount:$SA" --role="roles/iam.serviceAccountTokenCreator" --project $PROJECT
```

Komut satırı yerine konsoldan da yapılabilir: Google Cloud Console → IAM ve
Yönetici → IAM → "Compute Engine default service account" satırında düzenle
→ rol ekle: **Service Account Token Creator**; ayrıca API'ler → "IAM Service
Account Credentials API" → Etkinleştir.

Rol eksikse Face ID girişi "Face ID girişi sunucuda henüz etkin değil (kurulum
eksik)" uyarısı verir; şifreli giriş her durumda çalışmaya devam eder.

## Yayınlama

```bash
cd ~/mgpanel && git pull && cd functions && npm install && cd .. \
  && firebase deploy --only functions,hosting,firestore:rules --project panel-d25c9
```

`npm install` yeni bağımlılığı (`@simplewebauthn/server`) kurar.

## Yönetici tarafı (Ayarlar → Kullanıcılar)

- Kullanıcı oluştururken / düzenlerken **"Face ID / Touch ID ile girebilir"**
  anahtarı. Varsayılan **kapalı**.
- **Kişiye özel hesap** (kendi telefonunu kullanan personel) → açın.
- **Ortak kullanım hesabı** (resepsiyon tableti, vardiya hesabı) → kapalı
  bırakın; bu hesaplar yalnızca şifreyle girer.
- Açık hesaplar listede **Face ID** etiketiyle görünür.
- Düzenleme penceresinde kişinin Face ID açtığı cihazlar listelenir;
  **Cihazları kaldır** ile hepsi silinir.
- Anahtar kapatılıp kaydedilince cihaz kayıtları da silinir.
- **Şifre sıfırlama** ve **erişimi kaldırma** da cihaz kayıtlarını otomatik siler.
- F&B (kodla giriş) personelinde seçenek gösterilmez.

## Personel tarafı

1. Kişi her zamanki gibi kullanıcı adı + şifreyle girer.
2. Yönetici izin verdiyse ve cihaz destekliyorsa "Face ID ile hızlı giriş"
   kartı çıkar → **Face ID ile girişi aç** → cihaz Face ID ister → tamam.
   "Şimdi değil" derse aynı cihazda 14 gün sorulmaz.
3. Sonraki girişlerde giriş ekranının en üstünde **Face ID ile giriş** düğmesi
   görünür; dokununca doğrudan panele girer.

Face ID ile giriş, şifreli girişle **aynı denetimlerden** geçer: otel
aboneliği, askıya alma, modül izinleri, zorunlu şifre değişimi.

## Güvenlik notları

- Passkey otelin **kendi adresine** bağlıdır (ör. `grandotel.hotizy.com`);
  başka otelin giriş sayfasında kullanılamaz.
- Yalnızca izinli adresler: `hotizy.com` ve alt alan adları (https), projenin
  Firebase Hosting adresleri, yerel geliştirme (`localhost`).
- Her doğrulama dizesi tek kullanımlık ve 5 dakika geçerli; giriş denemeleri
  IP başına sınırlı.
- Kullanıcı doğrulaması (Face ID/PIN) zorunlu; geriye giden sayaç (kopyalanmış
  doğrulayıcı) reddedilir.
- Kayıtlar `webauthnCredentials`, doğrulama dizeleri `webauthnChallenges`
  koleksiyonundadır; Firestore kurallarıyla istemciye tamamen kapalıdır
  (yalnızca Cloud Functions erişir).
- Kullanıcı kendi `faceIdAllowed` alanını değiştiremez; yalnızca otel
  yöneticisi.

## Test

- `tests/passkey-core.test.js` — yazılım doğrulayıcıyla gerçek kriptografi:
  kayıt + giriş ve tüm ret durumları.
- `tests/passkey-rules.test.js` — Firestore kuralları (emülatör).
