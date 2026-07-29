/* i18n sözlük bütünlüğü — saf mantık, emülatörsüz.
 *
 * Çevirinin en sinsi hatası "sessiz eksik": bir anahtar tr.js'e eklenir,
 * en.js'e eklenmesi unutulur ve İngilizce konuşan misafir o satırı Türkçe
 * görür. Motor bilinçli olarak Türkçe'ye düşer (kullanıcı boş ekran görmez),
 * dolayısıyla hata ÇALIŞMA ANINDA görünmez — bu yüzden burada mekanik
 * olarak yakalanır.
 *
 * Sözlükler tarayıcı script'idir (window.I18N_*, module.exports yok), bu
 * yüzden kaynak dosya okunup kendi kapsamında değerlendirilir — kopyası
 * değil, GERÇEK dosya test edilir. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadDict(file, globalName) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n', file), 'utf8');
    const win = {};
    new Function('window', src)(win);
    const d = win[globalName];
    assert.ok(d && typeof d === 'object', `${file} içinde window.${globalName} bulunamadı`);
    return d;
}

const TR = loadDict('tr.js', 'I18N_TR');
const EN = loadDict('en.js', 'I18N_EN');

const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();

test('sözlükler boş değil', () => {
    assert.ok(Object.keys(TR).length > 50, 'tr.js beklenenden az anahtar taşıyor');
    assert.ok(Object.keys(EN).length > 50, 'en.js beklenenden az anahtar taşıyor');
});

test('TR ve EN BİREBİR aynı anahtar kümesine sahip', () => {
    const trKeys = Object.keys(TR).sort();
    const enKeys = Object.keys(EN).sort();
    const missingInEn = trKeys.filter((k) => !(k in EN));
    const missingInTr = enKeys.filter((k) => !(k in TR));
    assert.deepEqual(missingInEn, [], 'en.js\'te EKSİK anahtarlar (İngilizce kullanıcı bunları Türkçe görür)');
    assert.deepEqual(missingInTr, [], 'tr.js\'te olmayan FAZLA anahtarlar (ölü çeviri)');
});

test('hiçbir çeviri boş değil', () => {
    for (const [k, v] of Object.entries(TR)) {
        assert.ok(typeof v === 'string' && v.trim() !== '', `tr.js "${k}" boş`);
    }
    for (const [k, v] of Object.entries(EN)) {
        assert.ok(typeof v === 'string' && v.trim() !== '', `en.js "${k}" boş`);
    }
});

test('{yer tutucular} iki dilde AYNI', () => {
    // Uyuşmazlık, çalışma anında doldurulmamış bir "{room}" veya kaybolmuş
    // bir değer olarak kullanıcıya yansır.
    for (const k of Object.keys(TR)) {
        assert.deepEqual(placeholders(EN[k]), placeholders(TR[k]),
            `"${k}" anahtarının yer tutucuları uyuşmuyor — TR: ${TR[k]} | EN: ${EN[k]}`);
    }
});

test('İngilizce değerlerde Türkçe\'ye özgü harf kalmamış (kopyala-yapıştır kontrolü)', () => {
    // Çeviri yapılmadan TR değeri EN'e kopyalanmışsa bu yakalar. Emoji ve
    // ortak Latin harfleri sorun değil; yalnızca TR'ye özgü karakterlere bakılır.
    const trOnly = /[ğışĞİŞ]/;   // ü/ö/ç Almanca/Fransızca'da da geçebilir, dışarıda bırakıldı
    const suspects = Object.keys(EN).filter((k) => trOnly.test(EN[k]));
    assert.deepEqual(suspects, [], 'en.js içinde çevrilmemiş görünen anahtarlar');
});

test('anahtar isimlendirme kuralı: <alan>.<...> nokta ayraçlı', () => {
    for (const k of Object.keys(TR)) {
        assert.match(k, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, `"${k}" anahtar biçimi kurala uymuyor`);
    }
});
