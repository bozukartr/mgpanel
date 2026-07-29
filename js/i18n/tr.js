/* Hotizy — Türkçe arayüz sözlüğü (kaynak dil).
 *
 * KURALLAR
 *  · Anahtar isimlendirmesi: <ekran>.<bileşen>.<amaç>  (ör. guest.cart.submit)
 *  · Yer tutucular {süslü} biçimindedir; İngilizce karşılığında AYNI yer
 *    tutucular bulunmalıdır (tests/i18n.test.js bunu zorunlu kılar).
 *  · Bu dosya KAYNAK dildir: bir anahtar burada varsa en.js'te de olmalıdır.
 *  · Otelin kendi girdiği içerik (katalog talep adları, restoran menüsü,
 *    departman adları, demo katalog verisi) BURAYA GİRMEZ — o veri otele
 *    aittir ve çevrilmez.
 */
window.I18N_TR = {
    // ── Ortak ────────────────────────────────────────────────────────────
    'guest.home.guestShort': 'Misafirimiz',
    'common.justNow': 'az önce',
    'guest.gate.noConnectionDemo': 'Bağlantı kurulamadı. ?demo ile test edebilirsiniz.',
    'guest.gate.noConnectionRetry': 'Bağlantı kurulamadı. Lütfen tekrar deneyin.',
    'guest.track.noneInTab': 'Bu sekmede talep yok',
    'common.back': 'Geri',
    'guest.services.title': 'Hizmetler',
    'guest.services.searchPlaceholder': 'Hizmet ara…',
    'guest.cart.title': 'Sepetim',
    'guest.cart.clear': 'Temizle',
    'guest.cart.goToCart': 'Sepete git',
    'guest.cart.countLabel': '{n} talep',
    'guest.home.legalNotice': 'Talebinizi oluşturarak verilerinizin hizmet amacıyla işlenmesini kabul edersiniz.',
    'guest.track.active': 'Aktif talepleriniz',
    'common.cancel': 'Vazgeç',
    'common.close': 'Kapat',
    'common.send': 'Gönder',
    'common.sending': 'Gönderiliyor…',
    'common.edit': 'Düzenle',
    'common.select': 'Seç',
    'common.all': 'Tümü',
    'common.other': 'Diğer',
    'common.copied': 'Kopyalandı',
    'common.retry': 'Lütfen tekrar deneyin.',
    'common.noConnection': 'Bağlantı kurulamadı.',
    'common.people': 'kişi',
    'common.minAgo': '{n} dk önce',
    'common.hourAgo': '{n} sa önce',

    // ── Misafir · kabuk / navigasyon ─────────────────────────────────────
    'guest.title': 'Misafir Hizmetleri · Hotizy',
    'guest.nav.home': 'Ana Sayfa',
    'guest.nav.orders': 'Taleplerim',
    'guest.nav.chat': 'Sohbet',
    'guest.nav.profile': 'Profil',
    'guest.lang.switch': 'Dil / Language',

    // ── Misafir · ana sayfa ──────────────────────────────────────────────
    'guest.home.welcome': 'Hoş geldiniz,',
    'guest.home.guestFallback': 'Değerli Misafirimiz',
    'guest.home.greetMorning': 'Günaydın,',
    'guest.home.greetEvening': 'İyi akşamlar,',
    'guest.home.quickActions': 'HIZLI İŞLEMLER',
    'guest.home.subtitle': 'Konaklamanızın keyfini çıkarın — ihtiyacınız olan her şey bir dokunuş uzağınızda.',
    'guest.home.seeAllOrders': 'Tüm taleplerimi gör',
    'guest.home.legal': 'KVKK Aydınlatma Metni',

    // ── Misafir · hizmetler ──────────────────────────────────────────────
    'guest.services.howCanWeHelp': 'Size nasıl yardımcı olabiliriz?',
    'guest.services.notReady': 'Bu otel için talepler henüz hazır değil.',
    'guest.services.noResult': 'Sonuç yok',
    'guest.services.noMatch': 'Aramanızla eşleşen hizmet bulunamadı.',
    'guest.services.emptyCategory': 'Bu kategoride hizmet yok.',
    'guest.services.offHours': 'Saat dışı',
    'guest.services.onlyBetween': 'Bu talep yalnızca {window} saatleri arasında verilebilir.',
    'guest.services.unavailableWindow': 'Bu hizmet yalnızca {window} saatleri arasında verilebilir.',

    // ── Misafir · kalem sayfası (detay) ──────────────────────────────────
    'guest.item.quantity': 'Adet',
    'guest.item.option': 'Seçenek',
    'guest.item.customize': 'Özelleştir',
    'guest.item.customizeHint': '(opsiyonel, birden fazla seçebilirsiniz)',
    'guest.item.note': 'Not (opsiyonel)',
    'guest.item.notePlaceholder': 'Örn. 2 büyük havlu',
    'guest.item.preferredTime': 'Tercih saati (opsiyonel)',
    'guest.item.addToCart': 'Sepete Ekle',
    'guest.item.updateCart': 'Sepeti Güncelle',
    'guest.item.removeFromCart': 'Sepetten Çıkar',
    'guest.item.pickOption': 'Bir seçenek seçin',
    'guest.item.pickOptionToast': 'Lütfen bir seçenek seçin.',
    'guest.item.added': 'Sepete eklendi ✓',
    'guest.item.addedShort': 'Sepete eklendi',
    'guest.item.removed': 'Sepetten çıkarıldı',
    'guest.item.maxDistinct': 'En fazla {n} farklı talep ekleyebilirsiniz.',
    'guest.item.maxQtyItem': 'Bu talepten en fazla {n} adet verilebilir.',
    'guest.item.maxQtyGeneric': 'Bir talepten en fazla {n} adet.',

    // ── Misafir · transfer alanları ──────────────────────────────────────
    'guest.transfer.from': 'Nereden',
    'guest.transfer.to': 'Nereye',
    'guest.transfer.date': 'Tarih',
    'guest.transfer.time': 'Saat',
    'guest.transfer.vehicle': 'Araç',
    'guest.transfer.fromPlaceholder': 'Örn. Otel Lobisi',
    'guest.transfer.toPlaceholder': 'Örn. Havalimanı',
    'guest.transfer.vehiclePlaceholder': 'Örn. Vito',
    'guest.transfer.needVehicle': 'Lütfen araç tipini girin.',
    'guest.transfer.needFrom': "Lütfen 'Nereden' bilgisini girin.",
    'guest.transfer.needTo': "Lütfen 'Nereye' bilgisini girin.",
    'guest.transfer.needDate': 'Lütfen transfer tarihini seçin.',
    'guest.transfer.needTime': 'Lütfen transfer saatini seçin.',
    'guest.transfer.tooEarly': 'Transfer saati en erken {time} ({date}) olabilir.',
    'guest.transfer.stale': '"{name}" için seçilen transfer saati geçti, lütfen güncelleyin.',

    // ── Misafir · sepet ──────────────────────────────────────────────────
    'guest.cart.empty': 'Sepetiniz boş',
    'guest.cart.emptyHint': 'Hizmetler sekmesinden talep ekleyin.',
    'guest.cart.browse': 'Hizmetlere Göz At',
    'guest.cart.submit': 'Talebi Gönder',
    'guest.cart.submitted': 'Talebiniz alındı! 🎉',
    'guest.cart.submittedDemo': 'Talebiniz alındı! 🎉 (demo)',
    'guest.cart.failed': 'Gönderilemedi. Tekrar deneyin.',
    'guest.cart.tooFast': 'Çok hızlı! Lütfen {n} sn sonra deneyin.',
    'guest.cart.pendingExists': 'Zaten onay bekleyen bir talebiniz var. Önce o sonuçlansın 🙏',

    // ── Misafir · talep takibi ───────────────────────────────────────────
    'guest.track.none': 'Henüz talep yok',
    'guest.track.noneHint': 'Oluşturduğunuz talepleri buradan canlı takip edebilirsiniz.',
    'guest.track.create': 'Talep Oluştur',
    'guest.track.createNew': 'Yeni Talep Oluştur',
    'guest.track.yourRequests': 'TALEPLERİNİZ',
    'guest.track.cancelItem': 'İptal Et',
    'guest.track.cancelOrder': 'Talebi İptal Et',
    'guest.track.confirmCancelItem': 'Bu kalemi iptal etmek istediğinize emin misiniz?',
    'guest.track.confirmCancelOrder': 'Talebinizi iptal etmek istediğinize emin misiniz?',
    'guest.track.itemCancelled': 'Kalem iptal edildi.',
    'guest.track.orderCancelled': 'Talebiniz iptal edildi.',
    'guest.track.cancelFailed': 'İptal edilemedi.',
    'guest.track.cancelFailedTaken': 'İptal edilemedi. Personel muhtemelen zaten üstlendi.',
    'guest.track.itemUpdated': 'Kalem güncellendi ✓',
    'guest.track.updateFailedTaken': 'Güncellenemedi. Personel muhtemelen zaten üstlendi.',
    'guest.track.tabRequests': 'Talepler',
    'guest.track.tabConcierge': 'Concierge',

    // ── Misafir · sipariş durumları ──────────────────────────────────────
    'guest.status.pending': 'Bekliyor',
    'guest.status.pendingSub': 'Talebiniz resepsiyona iletildi.',
    'guest.status.confirmed': 'Onaylandı',
    'guest.status.confirmedSub': 'Talebiniz onaylandı, hazırlanıyor.',
    'guest.status.inProgress': 'İşlemde',
    'guest.status.inProgressSub': 'Ekibimiz talebinizi hazırlıyor.',
    'guest.status.completed': 'Tamamlandı',
    'guest.status.completedSub': 'Talebiniz tamamlandı. Teşekkürler!',
    'guest.status.cancelled': 'İptal Edildi',
    'guest.status.cancelledSub': 'Bu talep iptal edildi.',

    // ── Misafir · kimlik doğrulama ───────────────────────────────────────
    'guest.gate.title': 'Sizi tanıyalım',
    'guest.gate.sub': 'Talep oluşturmak için rezervasyondaki <b>soyadınızı</b> ve <b>doğum yılınızı</b> doğrulayın.',
    'guest.gate.surname': 'Soyadı',
    'guest.gate.surnamePlaceholder': 'Örn. YILMAZ',
    'guest.gate.birthYear': 'Doğum yılı',
    'guest.gate.birthYearPlaceholder': 'Örn. 1990',
    'guest.gate.submit': 'Doğrula ve Devam Et',
    'guest.gate.help': 'Sorun mu yaşıyorsunuz? Lütfen resepsiyon ile iletişime geçin.',
    'guest.gate.needSurname': 'Lütfen soyadınızı girin.',
    'guest.gate.needBirthYear': 'Lütfen geçerli bir doğum yılı girin.',
    'guest.gate.mismatch': 'Soyadı ve doğum yılı eşleşmedi. Lütfen resepsiyona başvurun.',
    'guest.gate.failed': 'Doğrulama yapılamadı. Lütfen tekrar deneyin.',
    'guest.gate.verified': 'Doğrulandı 👋',
    'guest.gate.required': 'Doğrulama gerekli',
    'guest.gate.requiredHint': 'Konaklama bilgilerinizi görmek için önce soyadı ve doğum yılınızla doğrulanmanız gerekir.',

    // ── Misafir · otel bilgileri ─────────────────────────────────────────
    'guest.info.title': 'Otel Bilgileri',
    'guest.info.none': 'Bilgi yok',
    'guest.info.noneHint': 'Henüz otel bilgisi eklenmemiş.',
    'guest.info.reception': 'Resepsiyon',
    'guest.info.wifiName': 'Wi-Fi ağı',
    'guest.info.wifiPass': 'Wi-Fi şifresi',
    'guest.info.checkout': 'Check-out',
    'guest.info.breakfast': 'Kahvaltı',
    'guest.info.address': 'Adres',
    'guest.info.copy': 'Kopyala',
    'guest.info.receptionHint': 'Resepsiyon ekibimiz hizmetinizde. Aşağıdan ulaşın ya da hızlıca bir talep oluşturun.',

    // ── Misafir · menüler ────────────────────────────────────────────────
    'guest.menus.title': 'Menüler',
    'guest.menus.none': 'Menü yok',
    'guest.menus.noneHint': 'Bu otel için henüz menü eklenmemiş.',
    'guest.menus.noLink': 'Bu menü için bağlantı tanımlı değil.',

    // ── Misafir · konaklama / oda hesabı ─────────────────────────────────
    'guest.stay.title': 'Konaklama',
    'guest.stay.checkIn': 'Giriş',
    'guest.stay.checkOut': 'Çıkış',
    'guest.stay.folio': 'Oda Hesabım',
    'guest.stay.folioShort': 'Oda Hesabı',
    'guest.stay.reservations': 'Rezervasyonlarım',
    'guest.stay.noReservations': 'Kayıtlı rezervasyon yok.',
    'guest.stay.noDetail': 'Detay yok',
    'guest.stay.noItems': 'Kalem yok',
    'guest.stay.loadFailed': 'Bilgi alınamadı',
    'guest.stay.configError': 'Yapılandırma hatası',

    // ── Misafir · değerlendirme ──────────────────────────────────────────
    'guest.rating.title': 'Nasıldı?',
    'guest.rating.skip': 'Geç',
    'guest.rating.stars': '{n} yıldız',
    'guest.rating.thanks': 'Teşekkürler! Değerlendirmeniz alındı. ⭐',
    'guest.rating.thanksDemo': 'Teşekkürler! ⭐ (demo)',
    'guest.rating.failed': 'Gönderilemedi.',

    // ── Misafir · departman kartları ─────────────────────────────────────
    'guest.dept.housekeeping': 'Temizlik, havlu, buklet ve daha fazlası.',
    'guest.dept.engineering': 'Teknik sorunları hızla çözelim.',
    'guest.dept.concierge': 'Konaklamanızı keyifli kılan detaylar.'
};
