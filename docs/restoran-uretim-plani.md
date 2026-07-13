# Restoran Modülü — Üretim Sertleştirme Planı

Bu doküman, restoran (POS) modülünü üretime uygun ve finansal olarak
güvenilir hale getirme çalışmasının analizi, teknik planı ve faz
raporlarıdır. **Faz 1–4 bu çalışmada uygulanır; Faz 5–9 backlog'dur.**

## 1. Mevcut durum analizi (özet)

İncelenen yüzeyler: `js/modules/restaurant.js` (~1900 satır, tüm akış),
`firestore.rules` (rest* koleksiyonları), `functions/index.js`
(deleteHotel/purge, mevcut callable desenleri), CRM/Concierge/Raporlar
bağlantıları (folioCharges, guestId/stayId, reports.js restSales),
superadmin (restConfig'e dokunmuyor; tenant silme buradan tetikleniyor).

Bilinen zayıflıklar (önceki denetimler + bu keşif):

| # | Zayıflık | Etki |
|---|---|---|
| Z1 | Adisyon açma/ödeme/iptal/bölme/birleştirme/taşıma **tamamen istemcide** — kurallar herhangi bir personelin her rest* dokümanına tam CRUD'una izin veriyor | Finansal bütünlük istemci disiplinine emanet |
| Z2 | Durum makinesi yok: `paid`/`void` adisyon SDK ile değiştirilebilir/silinebilir | Ödenmiş adisyon sonradan oynanabilir |
| Z3 | İdempotency yok: çift tıklama/tekrar istek çift adisyon, çift ödeme üretebilir (paySettle/openTableCheck istemci-içi bayraklarla sınırlı) | Çift tahsilat, çift stok düşümü |
| Z4 | İptal yetkisi düz metin `cancelCode` (restConfig'te, HERKES okuyabilir) | Yetki kontrolü yok sayılır |
| Z5 | Masa kilidi (restTables) var ama masa adı normalize edilmiyor ("Masa 1" ≠ "masa 1"), bayat kilit onarım yolu yok | Yanlış "masa dolu" veya kilidin delinmesi |
| Z6 | Gecikmeli `saveCheck()` (450ms debounce) ödemeden SONRA çalışıp ödenmiş adisyonun kalemlerini değiştirebilir | Ödeme sonrası tutar oynaması |
| Z7 | Bölme (`doSplitEqual`) sıralı add zinciri, birleştirme (`doMerge`) delete+save ayrı — ağ kesintisinde yarım kalır | Kayıp/çift kalem |
| Z8 | Ödemede due/tendered/applied/change ayrımı yok; kart/oda fazla ödeme engellenmiyor; nakit para üstü ciroya karışabiliyor | Z raporu/mutabakat imkânsız |
| Z9 | Audit log yok (kim iptal etti, kim ikram verdi, sebep) | İzlenebilirlik yok |
| Z10 | Tenant silme (purgeTenantData) `restTables`, `restSessions`, `stays`, `migrationReview` koleksiyonlarını temizlemiyor | Çöp veri + slug yeniden kullanımında hayalet kilitler |
| Z11 | `restSessions` koleksiyonu kurallarda var, kodda HİÇ kullanılmıyor (ölü) | Kafa karışıklığı; Faz 5 kasa vardiyası burada yaşayacak |
| Z12 | Hatalar kullanıcıya tek tip "Açılamadı/Kapatılamadı" — teşhis edilemez | Destek maliyeti |

Sağlam olan taraflar (bu oturumdaki önceki işler): kalem birleştirme
transaction'ı (`saveCheck`), settle'ın tek-transaction paid+folio+stok
yazımı, sunucu filtreli dinleyiciler, checkNo sayacı transaction'ı,
folioCharges'ta guestId/stayId/sourceId, sıralı checkNo.

## 2. Hedef mimari

```
İstemci (restaurant.js)
   │  yalnızca: kalem düzenleme (open/sent), görüntüleme, çağrılar
   ▼
Cloud Functions (onCall, ince sarmalayıcılar)
   restOpenCheck · restSettleCheck · restVoidCheck · restSettleFolio · restRepairTableLocks
   │  rol kontrolü + operationId + hata kodları
   ▼
functions/rest-core.js  ←— EMÜLATÖRDE TEST EDİLEBİLİR saf çekirdek
   openCheckCore / settleCore / voidCore / folioSettleCore
   (db enjekte edilir; tüm iş kuralları + transaction'lar burada)
   │
   ▼
Firestore  +  firestore.rules (durum makinesi: istemci paid/void YAZAMAZ,
              paid/void DEĞİŞTİRİLEMEZ; menü yazımı manager/admin)
```

- **restOps/{tenantId}_{operationId}**: idempotency defteri. Kritik her
  çağrı operationId taşır; aynı operationId ikinci kez gelirse ilk
  sonucun aynısı döner (`{kind, result, uid, at}`). Yalnızca Admin SDK yazar.
- **restAudit/{autoId}**: append-only denetim izi
  `{tenantId, action, checkId, checkNo, uid, username, role, reason,
  amount, meta, at}`. Yalnızca Admin SDK yazar; tenant admin okur.
- **tableKey**: `trLower(trim(collapseWhitespace(tableName)))`, `/`→`_`;
  kilit dokümanı `restTables/{tenantId}__{tableKey}`.

### Rol matrisi

| İşlem | staff (Garson) | manager (Süpervizör/Müdür) | admin | superadmin |
|---|---|---|---|---|
| Adisyon aç / kalem ekle-değiştir (open/sent) | ✓ | ✓ | ✓ | ✓ |
| Mutfağa gönder | ✓ | ✓ | ✓ | ✓ |
| Ödeme al (settle) | ✓ | ✓ | ✓ | ✓ |
| İptal (void) — gönderilmiş kalemli | ✗ | ✓ (sebep zorunlu) | ✓ | ✓ |
| İptal — hiç gönderilmemiş boş adisyon | ✓ | ✓ | ✓ | ✓ |
| İkram/indirim ≤ %10 | ✓ (audit'e yazılır) | ✓ | ✓ | ✓ |
| İkram/indirim > %10 | ✗ | ✓ | ✓ | ✓ |
| Folio tahsil & kapat | ✗ | ✓ | ✓ | ✓ |
| Menü/stok tanımı değiştir | ✗ | ✓ | ✓ | ✓ |
| restConfig | ✗ | ✗ | ✓ | ✓ |
| Kilit onarımı (migration) | ✗ | ✗ | ✓ | ✓ |

Not: Kasiyer/Mutfak-Bar ayrı roller olarak `systemUsers.role`'de bugün yok;
matris bugünkü üç rolle (staff/manager/admin) eşlenir. Kasiyer=staff+settle
(bugün staff settle edebilir; Faz 5 kasa vardiyasıyla kasiyer rolü ayrışır),
Mutfak/Bar=KDS fazında (F7) salt-okur ticket rolü.

### Hata kodu kataloğu

`HttpsError(code, mesaj, {errCode, opId})` — istemci `errCode`'a göre
Türkçe, eyleme dönük mesaj gösterir:

| errCode | Anlam |
|---|---|
| REST/TABLE_OCCUPIED | Masada zaten açık adisyon var (mevcut checkNo döner) |
| REST/CHECK_NOT_FOUND | Adisyon yok/silinmiş |
| REST/CHECK_IMMUTABLE | Adisyon ödenmiş/iptal — değiştirilemez |
| REST/INVALID_TRANSITION | Yasadışı durum geçişi |
| REST/OVERPAY_NONCASH | Kart/oda ödemesi kalanı aşıyor |
| REST/NO_PAYMENT | Ödeme satırı yok/istenen tutar karşılanmadı |
| REST/ROLE_DENIED | Rol bu işleme yetkili değil |
| REST/REASON_REQUIRED | Sebep zorunlu (void/indirim) |
| REST/TENANT_MISMATCH | Başka otelin verisi |
| REST/OP_REPLAY | (bilgi) Aynı operationId — önceki sonuç döndü |

## 3. Fazlar ve kabul kriterleri

### Faz 1 — Test zemini ✅(bu çalışmada)
`tests/` paketi: Firestore Emulator (jar, gitignored `tests/bin/`),
`@firebase/rules-unit-testing` + `firebase-admin` + Node yerleşik
`node:test`. `tests/run.sh` emülatörü açar, testleri koşar, kapatır.
Seed: 2 tenant (goldeneye-test, mgallery-test), her tenantta
admin/manager/staff kullanıcı, masa/menü(stok takipli)/misafir(+stay)/
açık adisyon/folio. **Kabul:** `bash tests/run.sh` yeşil; tenant
izolasyonu kural testleri geçer.

### Faz 2 — Sunucu tarafı adisyon açma ✅(bu çalışmada)
`rest-core.openCheckCore`: TEK transaction'da restOps kontrolü + tableKey
kilidi + checkNo + adisyon dokümanı. `restOpenCheck` callable;
`restRepairTableLocks` (admin): bayat/normalize-olmamış kilitleri onarır
(eski kilit SİLİNMEZ, rapor edilir + openCheckId'si kapalı/yok ise
temizlenir — geri döndürülebilir). İstemci: callable'ı çağırır; fonksiyon
henüz deploy edilmemişse (`not-found`) ESKİ istemci yoluna düşer (geçiş
dönemi); hata kodları kullanıcıya anlaşılır metinle. purgeTenantData'ya
restTables/restSessions/stays/migrationReview/restOps/restAudit eklenir.
**Kabul:** emülatör testleri — eşzamanlı iki açma → tek adisyon + diğerine
TABLE_OCCUPIED; aynı operationId × 2 → tek adisyon, aynı sonuç; farklı
tenant kilidi etkilemez.

### Faz 3 — Veri bütünlüğü ✅(bu çalışmada)
Rules durum makinesi: istemci güncellemesi yalnız `open|sent` adisyonda;
istemci `status` yalnız `open|sent` yazabilir (paid/void YALNIZ Admin SDK);
paid/void güncellenemez + silinemez (delete yalnız open/sent + admin değilse
de mevcut davranış korunur → open/sent silme staff'a açık kalır — merge
akışı için; Faz 4'te audit'li merge fonksiyona alınabilir). `version`
alanı: her istemci güncellemesi `version = mevcut+1` yazmak zorunda
(rules doğrular) → bayat cihaz yazımı reddedilir. İstemci: saveCheck
paid/void görürse no-op + kullanıcı uyarısı; ödeme modalı açılmadan
flushSave; doTransfer/doMerge/doSplitEqual tek transaction (kilitler dahil).
**Kabul:** kural testleri — paid adisyona kalem yazma RED; open→paid
istemciden RED; open→sent istemciden OK; paid delete RED; version'sız /
yanlış version'lu güncelleme RED.

### Faz 4 — Yetkilendirme + sunucu tarafı para işlemleri ✅(bu çalışmada)
`settleCore`: due/applied/tendered/change ayrımı — nakit dışı (kart+oda)
toplamı kalanı AŞAMAZ (REST/OVERPAY_NONCASH); nakit fazlası `change`
olarak hesaplanır, ciroya girmez (`payments[].applied` alanı); toplam
applied ≥ due şartı; operationId ile çift ödeme koruması; folio + stok
düşümü aynı transaction; audit kaydı. `voidCore`: rol kontrolü (sent
kalemli void → manager/admin) + sebep zorunlu + stok iadesi değil düşümü
(mevcut politika korunur: servis edilen tüketilmiştir) + audit.
`folioSettleCore`: manager/admin, audit. cancelCode UI + akışı kaldırılır.
Rules: restMenu create/update/delete manager/admin; folioCharges istemci
update/delete kapalı (create concierge/settle-fallback için açık kalır —
geçiş); restAudit/restOps istemciye tamamen kapalı (okuma: admin kendi
tenant'ı — audit).
**Kabul:** emülatör testleri — staff void RED / manager OK + audit;
çift settle (aynı opId) tek tahsilat + stok TEK düşüm; kart fazla RED;
nakit fazla → doğru change, applied=due; folio kapatma staff RED.

### Faz 5–9 (backlog — uygulanmadı)
5) Kasa/vardiya (restSessions canlanır), Z raporu mutabakatı.
6) Folio-checkout kilidi (CRM checkout'u açık folio'da sunucu tarafında
   engelle), PMS aktarım kuyruğu.
7) KDS (mutfak ekranı) — durumlar, yeni-ticket, gecikme uyarısı.
8) Append-only stok defteri, reçete/BOM, negatif stok politikası.
9) Rapor mutabakatı (ikram=0, indirim dağıtımı, para birimi snapshot).

## 4. Zorunlu test senaryoları → kapsama

| Senaryo | Faz | Test |
|---|---|---|
| İki cihaz aynı masada aynı anda adisyon | F2 | concurrent openCheckCore |
| Çift tıklama / tekrar istek | F2/F4 | operationId replay |
| Ödeme sırasında ürün ekleme | F3/F4 | settle tx status+version kontrolü; kural testi |
| Eski cihaz ödenmiş adisyonu kaydetmeye çalışır | F3 | rules: paid immutable + version |
| Çift ödeme | F4 | settle opId replay → tek tahsilat |
| Fazla nakit / para üstü | F4 | change hesaplama testi |
| Kart/oda fazla ödeme | F4 | OVERPAY_NONCASH |
| Ağ kesintisinde bölme/birleştirme | F3 | tek transaction (ya hepsi ya hiçbiri) |
| Farklı para birimli folio | F6 (backlog) — bugün folio kaydı currency taşıyor, toplama tek kalemde | — |
| Açık borçla checkout | F6 (backlog) | — |
| Yetkisiz iptal/indirim/ikram | F4 | staff void RED |
| Stok hareketi yalnız bir kez | F4 | settle replay → stok tek düşüm |
| Tenant izolasyonu | F1 | rules smoke |

## FAZ RAPORU (Faz 1–4 tamamlandı)

**Test sonuçları:** `bash tests/run.sh` → **54/54 yeşil** (Firestore
Emulator v1.19.8, gerçek firestore.rules + gerçek transaction semantiği).
Kapsanan zorunlu senaryolar: eşzamanlı iki cihazda aynı masa (tek adisyon,
diğerine TABLE_OCCUPIED) · çift tıklama/tekrar istek (operationId replay)
· çift ödeme (tek tahsilat + STOK TEK DÜŞÜM) · eşzamanlı iki ödeme
(ikincisi CHECK_IMMUTABLE) · kart/oda fazla ödeme reddi · fazla nakit →
doğru para üstü (applied=due, change ciroya girmez) · bayat cihazın
ödenmiş adisyona yazması (rules RED) · yetkisiz void/indirim (staff RED,
manager OK + audit) · folio kapatma yetkisi · tenant izolasyonu (okuma/
yazma/liste/sahtecilik) · paid/void silinemez/değiştirilemez.

**Değişen dosyalar:** functions/rest-core.js (yeni, ~500 satır çekirdek),
functions/index.js (+5 callable: restOpenCheck, restSettleCheck,
restVoidCheck, restSettleFolio, restRepairTableLocks; purge genişletildi),
firestore.rules (restChecks durum makinesi+version; restMenu manager/admin;
folioCharges update/delete kapalı; restOps/restAudit), js/modules/
restaurant.js (callable entegrasyonları, atomik split/merge/transfer,
version disiplini, cancelCode kaldırıldı), restaurant.html (functions SDK,
cancelCode alanı kaldırıldı), tests/ (4 test dosyası, 54 test).

**Migration ihtiyacı:**
1. Deploy TEK komutta: `firebase deploy --only firestore:rules,functions,hosting`
   (rules istemci ödeme/iptalini kapatır — functions'sız deploy ödemeyi kilitler).
2. Deploy sonrası her otel için bir kez: restRepairTableLocks çağrısı
   (admin hesabıyla; eski biçimli/bayat kilitleri onarır — geri döndürülebilir).
3. Veri silme YOK; geri döndürülemez işlem YOK.

**Kalan riskler (kritiklik sırasıyla) — F4.5 güncellemesi:**
- YÜKSEK (operasyonel, kod dışı): İş akışı değişikliği — gönderilmiş
  adisyon iptali artık iptal KODU ile değil, manager/admin HESABIYLA
  yapılır. Garson cihazında yönetici kendi hesabıyla girmeli. Personele
  duyurulmalı; deploy öncesi systemUsers.role atamaları gözden geçirilmeli.
- ~~ORTA: kalem fiyat manipülasyonu~~ → **KAPATILDI (F4.5)**: settle
  artık kalem fiyatlarını MENÜ fiyatıyla karşılaştırır; toplam %2'den
  fazla altındaysa manager gerekir, sapma audit'e yazılır. (Artık DÜŞÜK:
  yalnız menuId'siz özel satırlar karşılaştırma dışı.)
- ~~ORTA: concierge applyToFolio istemciden folio CREATE~~ →
  **KAPATILDI (F4.5)**: applyReservationFolio fonksiyonu — bakiye
  sunucuda, folioApplied + operationId çift yansıtmayı engeller, audit'li;
  folioCharges CREATE dahil TÜM yazımlar istemciye kapandı.
- ~~DÜŞÜK: split/merge/transfer istemcide~~ → **KAPATILDI (F4.5)**:
  restTransferCheck/restMergeChecks/restSplitCheck fonksiyonları (kilit
  tutarlılığı + audit + idempotency; bölme stoğu tx içinde tek kez düşer);
  fonksiyon deploy edilene kadar Faz 3'ün kural-korumalı istemci
  transaction'ları fallback.
- DÜŞÜK: Emülatör testleri onCall sarmalayıcılarını değil ÇEKİRDEKLERİ
  çağırır (kimlik çözümü requireStaffUser ince ve gözle doğrulandı).
- DÜŞÜK: menuId'siz kalemler (özel satırlar) fiyat karşılaştırması
  dışında — bölme payları artık sunucuda üretildiğinden ana kaynak kapandı.

**F4.5 sonrası test durumu: 63/63 yeşil** (9 yeni test: fiyat sapması ×3,
transfer ×2, merge ×1, split ×1, folio yansıtma ×2).

## 5. Migration & deploy notları

- **Geri döndürülemez işlem YOK.** restRepairTableLocks yalnız
  bayat/işaretsiz kilit temizler + normalize kopya yazar; rapor döner.
- Deploy SIRASI önemli (tek komutta birlikte):
  `firebase deploy --only firestore:rules,functions,hosting`
  Rules istemcinin paid yazmasını kapattığı için functions'la AYNI
  deploy'da gitmeli; hosting'teki yeni istemci de aynı anda.
- İstemcide `not-found` (fonksiyon yok) → legacy yol yalnızca
  restOpenCheck'te vardır (okuma-yazma açısından zararsız). Ödeme/void
  için legacy yol YOKTUR (rules zaten kapatır) — fonksiyonsuz deploy
  edilirse ödeme alınamaz; bu bilinçli bir emniyettir.
- Faz raporları bu dosyanın sonuna eklenir.
