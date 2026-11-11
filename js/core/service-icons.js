/* Hotizy — hizmet/talep kalemi ikonları (misafir QR + personel çekmecesi).
 *
 * Katalog kalemlerinin `icon` alanı otelin girdiği bir EMOJİ (🧺 ☕ ❄️ …).
 * Emoji platforma göre farklı çiziliyor, renklendirilemiyor ve sade çizgi
 * ikonlu arayüzün geri kalanıyla uyumsuz duruyordu. Bu dosya bir kalemi tek
 * tip (24×24, 2px çizgi) SVG ikona çözer:
 *   1) Kalemin ADI anahtar kelimelerle (TR/EN) → karşılığı — en özel bilgi
 *      ("Ekstra Yastık" ile "Çarşaf" hazır katalogda aynı 🛏️ emojisini taşır)
 *   2) Kalemin emojisi tanınıyorsa → karşılığı
 *   3) Kategori, sonra departman → grup ikonu
 *   4) Hiçbiri → resepsiyon zili
 * Veri (Firestore'daki emoji) DEĞİŞMEZ — yalnızca gösterim.
 *
 *   ServiceIcon.key(item)          → 'towel'
 *   ServiceIcon.svg(item, size)    → '<svg …>…</svg>'
 *   ServiceIcon.byKey('towel', 22) → '<svg …>…</svg>'
 */
(function (root) {
    'use strict';
    var P = {
        bell: '<path d="M3 18h18"/><path d="M5 18a7 7 0 0 1 14 0"/><path d="M12 11V8.5"/><path d="M10 8.5h4"/><path d="M2 21h20"/>',
        sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/>',
        towel: '<rect x="3" y="4" width="18" height="7" rx="2.5"/><rect x="3" y="13" width="18" height="7" rx="2.5"/><path d="M8 4v7M8 13v7"/>',
        bed: '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
        pillow: '<path d="M5 6.5C8 5 16 5 19 6.5c1.5 3.5 1.5 7.5 0 11-3 1.5-11 1.5-14 0-1.5-3.5-1.5-7.5 0-11z"/>',
        blanket: '<path d="M4 5h13a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3z"/><path d="M4 16a3 3 0 0 1 3-3h13"/>',
        trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
        hanger: '<path d="M12 7a2 2 0 1 1 2-2c0 1.2-2 1.8-2 3.2"/><path d="m12 8.2-9.4 7.1A1.5 1.5 0 0 0 3.5 18h17a1.5 1.5 0 0 0 .9-2.7z"/>',
        shirt: '<path d="M20.4 3.5 16 2a4 4 0 0 1-8 0L3.6 3.5a2 2 0 0 0-1.3 2.2l.6 3.5a1 1 0 0 0 1 .8H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.2a1 1 0 0 0 1-.8l.6-3.5a2 2 0 0 0-1.4-2.2z"/>',
        bottle: '<path d="M10 2h4"/><path d="M11 2v3h2V2"/><path d="M9 5h6l1 3v12a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V8z"/><path d="M8 12h8"/>',
        slippers: '<path d="M9 3C6.2 3 4 5.5 4 9v6a5 5 0 0 0 10 0V9c0-3.5-2.2-6-5-6z"/><path d="M4 10h10"/><path d="M17 7.5c1.8.6 3 2.5 3 5V16a4 4 0 0 1-3.5 4"/>',
        droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
        cup: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
        apple: '<path d="M12 20.9c1.5 0 2.8 1.1 4 1.1 3 0 6-8 6-12.2A4.9 4.9 0 0 0 17 5c-2.2 0-4 1.4-5 2-1-.6-2.8-2-5-2a4.9 4.9 0 0 0-5 4.8C2 14 5 22 8 22c1.3 0 2.5-1.1 4-1.1z"/><path d="M10 2c1 .5 2 2 2 5"/>',
        cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5h.01M16 15.5h.01M12 12h.01M11 17h.01M7 14h.01"/>',
        soda: '<path d="m6 8 1.8 12.3a2 2 0 0 0 2 1.7h4.4a2 2 0 0 0 2-1.7L18 8"/><path d="M5 8h14"/><path d="M7 15a6.5 6.5 0 0 1 5 0 6.5 6.5 0 0 0 5 0"/><path d="m12 8 1-6h2"/>',
        cube: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
        wine: '<path d="M8 22h8"/><path d="M12 15v7"/><path d="M7 2h10l1 6a6 6 0 0 1-12 0z"/>',
        utensils: '<path d="M3 2v7c0 1.1.9 2 2 2a2 2 0 0 0 2-2V2"/><path d="M5 11v11"/><path d="M19 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
        snowflake: '<path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2M4 9l2 3-2 3M20 9l-2 3 2 3"/>',
        thermometer: '<path d="M14 14.8V3.5a2.5 2.5 0 0 0-5 0v11.3a4.5 4.5 0 1 0 5 0z"/>',
        tv: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/>',
        wifi: '<path d="M5 12.6a11 11 0 0 1 14 0"/><path d="M1.4 9a16 16 0 0 1 21.2 0"/><path d="M8.5 16.1a6 6 0 0 1 7 0"/><path d="M12 20h.01"/>',
        bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.1 14c.2-1 .7-1.7 1.4-2.5A4.7 4.7 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.8 1.2 1.5 1.4 2.5"/>',
        shower: '<path d="m4 4 2.5 2.5"/><path d="M13.5 6.5a5 5 0 0 0-7 7"/><path d="M15 5 5 15"/><path d="M14 17h.01M10 16h.01M13 13h.01M16 10h.01M11 20h.01M17 14h.01M20 11h.01"/>',
        key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
        alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6M22 6l-3-3"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        car: '<path d="M5 17h14"/><path d="M3 17v-4l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 8l2 5v4"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/><path d="M3 13h18"/>',
        plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
        flower: '<path d="M12 22V12"/><circle cx="12" cy="8" r="4"/><path d="M12 16c-3 0-5-2-5-4"/><path d="M12 16c3 0 5-2 5-4"/>',
        anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v15"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>',
        cake: '<path d="M4 21h16"/><path d="M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7"/><path d="M5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0"/><path d="M12 12V8"/><path d="M12 5.5v.01"/>',
        luggage: '<rect x="6" y="6" width="12" height="15" rx="2"/><path d="M9 6V3h6v3"/><path d="M10 10v7M14 10v7"/><path d="M8 21v1M16 21v1"/>',
        medical: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
        wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.3 6.3a2.1 2.1 0 0 1-3-3l6.3-6.3a6 6 0 0 1 7.9-7.9z"/>',
        compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z"/>'
    };

    // Emoji → ikon. Anahtar, emojinin İLK kod noktasıdır (U+FE0F varyasyon
    // seçicisi ve ZWJ dizileri atılır: "🛏️" → "🛏", "💆‍♀️" → "💆").
    // 🛎 (genel zil) bilinçli olarak YOK: varsayılan ikon olduğundan bir şey
    // söylemez, ad/kategoriye bakılması gerekir.
    var EMOJI = {};
    function addEmoji(list, key) { Array.from(list).forEach(function (ch) { if (ch.trim()) EMOJI[ch] = key; }); }
    addEmoji('🧹🧽✨', 'sparkles');
    addEmoji('🧺', 'towel');
    addEmoji('🛏', 'bed');
    addEmoji('🧣', 'blanket');
    addEmoji('🗑', 'trash');
    addEmoji('🥼🧥', 'hanger');
    addEmoji('👔👕👗', 'shirt');
    addEmoji('🧴🧼🪥🪒', 'bottle');
    addEmoji('🥿🩴', 'slippers');
    addEmoji('💧🚰', 'droplet');
    addEmoji('☕🍵🫖', 'cup');
    addEmoji('🍎🍏🍓🍇🍉🍌🍊🍒🍑🍍', 'apple');
    addEmoji('🍫🍪🍿🥜🍬', 'cookie');
    addEmoji('🥤🧃🥛🍹🧋', 'soda');
    addEmoji('🧊', 'cube');
    addEmoji('🍷🍾🥂🍺🍻🍸🥃', 'wine');
    addEmoji('🍔🍕🍝🥗🥪🍳🥐🍽🍴🥣🍖🍗🐟🍤🌮🌯🍜🍲🥘🍱🍣🥞🧇🥓🍟🌭', 'utensils');
    addEmoji('🍮🍰🎂🧁🎉🎈🎊', 'cake');
    addEmoji('❄', 'snowflake');
    addEmoji('🌡🔥', 'thermometer');
    addEmoji('📺', 'tv');
    addEmoji('📶🛜', 'wifi');
    addEmoji('💡🔌', 'bulb');
    addEmoji('🚿🛁', 'shower');
    addEmoji('🔑🗝🔐🔒', 'key');
    addEmoji('⏰', 'alarm');
    addEmoji('🕐⏱⌛⏳', 'clock');
    addEmoji('🚕🚖🚗🚘🚐🚌🚙', 'car');
    addEmoji('✈🛫🛬', 'plane');
    addEmoji('💆💅🌸🧖🌺💐🌷', 'flower');
    addEmoji('⛵🚤🛥⚓🛳', 'anchor');
    addEmoji('🧳', 'luggage');
    addEmoji('💊🩺🏥🩹', 'medical');
    addEmoji('🔧🛠🔨🪛', 'wrench');
    addEmoji('🗺🧭🎫🎟', 'compass');

    // Ad + kategori anahtar kelimeleri — SIRA ÖNEMLİ (özelden genele):
    // "Sıcak Su Yok" önce duşa, "Banyo Malzemeleri" önce şişeye düşmeli;
    // düz "su" en sonlarda.
    var WORDS = [
        [/banyo malzeme|şampuan|sabun|amenit|toiletr|diş fırça|tıraş|shampoo|soap/, 'bottle'],
        [/sıcak su|duş|shower|musluk|lavabo|tıkan|gider|tuvalet|klozet|toilet/, 'shower'],
        [/klima|air ?con|\bac\b|soğut/, 'snowflake'],
        [/ısıtma|kalorifer|petek|heating|heater/, 'thermometer'],
        [/\btv\b|televizyon|kumanda|remote|kanal/, 'tv'],
        [/wi-?fi|internet|kablosuz/, 'wifi'],
        [/ampul|lamba|ışık|elektrik|priz|sigorta|light|bulb|power/, 'bulb'],
        [/kapı|kilit|anahtar|kart|kasa|\bkey\b|door|lock|safe/, 'key'],
        [/çöp|trash|garbage/, 'trash'],
        [/havlu|towel/, 'towel'],
        [/battaniye|blanket|yorgan|pike/, 'blanket'],
        [/yastık|pillow/, 'pillow'],
        [/çarşaf|yata[kğ]|nevresim|sheet|\bbed\b|crib|beşik/, 'bed'],
        [/terlik|slipper/, 'slippers'],
        [/bornoz|robe|askı|hanger/, 'hanger'],
        [/çamaşır|ütü|kuru temizle|laundry|iron|dry clean/, 'shirt'],
        [/temizli|clean|süpür|housekeep|toz/, 'sparkles'],
        [/kahve|çay|coffee|\btea\b/, 'cup'],
        [/meyve suyu|meşrubat|kola|soda|juice|içecek|drink|ayran|limonata/, 'soda'],
        [/meyve|fruit/, 'apple'],
        [/atıştırma|snack|çikolata|chocolate|kuruyemiş|cips|bisküvi|kurabiye/, 'cookie'],
        [/\bbuz\b|\bice\b/, 'cube'],
        [/şarap|wine|bira|beer|şampanya|champagne|rakı|viski|kokteyl|cocktail|minibar/, 'wine'],
        [/\bsu\b|water/, 'droplet'],
        [/uyandırma|wake|alarm/, 'alarm'],
        [/geç çıkış|late check|erken giriş|early check/, 'clock'],
        [/havalimanı|airport|uçuş|flight/, 'plane'],
        [/taksi|taxi|transfer|araç kirala|rent a car|shuttle|vale|valet|otopark|parking/, 'car'],
        [/spa|masaj|massage|hamam|sauna|güzellik|beauty|çiçek|flower/, 'flower'],
        [/tekne|\bboat\b|\byat\b|yacht|\btur\b|\btour\b|gezi|excursion|dalış|diving/, 'anchor'],
        [/pasta|cake|doğum günü|birthday|kutlama|celebrat|süsleme|decor|balayı|honeymoon/, 'cake'],
        [/bagaj|bavul|valiz|luggage|baggage|porter/, 'luggage'],
        [/doktor|ilaç|eczane|doctor|medic|ilk yardım|first aid|hemşire/, 'medical'],
        [/restoran|restaurant|yemek|food|kahvaltı|breakfast|akşam yemeği|dinner|lunch|öğle|burger|pizza|sandviç|tost|salata|çorba|menü|menu|oda servisi|room service|tatlı|dessert/, 'utensils'],
        [/arıza|sorun|bozuk|tamir|repair|broken|teknik|sızıntı|leak|gürültü|noise/, 'wrench'],
        [/rezervasyon|reservation|bilet|ticket|concierge|konsiyerj/, 'compass']
    ];
    var DEPTS = [
        [/kat hizmet|housekeep/, 'sparkles'],
        [/yiyecek|içecek|icecek|food|beverage|f&b|mutfak|oda servisi|room service/, 'utensils'],
        [/teknik|engineer|bakım|maintenance/, 'wrench'],
        [/concierge|konsiyerj/, 'compass'],
        [/ön ?büro|front|resepsiyon|reception/, 'bell']
    ];
    function lower(s) {
        try { return String(s || '').toLocaleLowerCase('tr-TR'); } catch (e) { return String(s || '').toLowerCase(); }
    }
    function firstGlyph(s) {
        var str = String(s || '').replace(/️/g, '').trim();
        if (!str) return '';
        return Array.from(str)[0] || '';
    }
    function match(list, text) {
        for (var i = 0; i < list.length; i++) if (list[i][0].test(text)) return list[i][1];
        return '';
    }
    // Ad, emojiden ve kategoriden ÖNCE ve AYRI değerlendirilir: "Meyve Tabağı" adı,
    // "Yiyecek & İçecek" kategorisindeki "içecek" kelimesine takılıp içecek
    // ikonu almamalı. Kategori önce departman gibi okunur (Oda Servisi →
    // çatal-bıçak), sonra kendi anahtar kelimeleriyle (Temizlik, Spa, Transfer).
    function key(item) {
        var it = item || {};
        var cat = lower((it.category || '') + ' ' + (it.subcategory || ''));
        return match(WORDS, lower(it.name))
            || EMOJI[firstGlyph(it.icon)]
            || match(DEPTS, cat)
            || match(WORDS, cat)
            || match(DEPTS, lower(it.department))
            || 'bell';
    }
    function byKey(k, size, sw) {
        var s = size || 22;
        return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="'
            + (sw || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
            + (P[k] || P.bell) + '</svg>';
    }
    function svg(item, size, sw) { return byKey(key(item), size, sw); }
    var api = { key: key, svg: svg, byKey: byKey, has: function (k) { return Object.prototype.hasOwnProperty.call(P, k); } };
    root.ServiceIcon = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
