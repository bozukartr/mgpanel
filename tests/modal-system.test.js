/* Ortak modal tasarım sistemi — sistemlerin yeniden ayrışmasını engelleyen
 * mekanik kilitler.
 *
 * BAŞLANGIÇ DURUMU: modallar beş ayrı CSS sisteminde yazılmıştı ve ikisi
 * (panel.css + admin.css) AYNI sınıf adlarını çakışan değerlerle tanımlıyordu.
 * admin.html her iki dosyayı da yüklediği için doğru görünüm ancak `!important`
 * ile elde edilebiliyordu. Ölçülen sonuç: panel modallarında başlık ve etiket
 * kontrastı 1.92:1 (WCAG AA eşiği 4.5), kapat düğmesi 14px, kaydet düğmesi
 * uzun formda kaydırılıp gözden kayboluyordu.
 *
 * Bu testler o duruma geri dönüşü yakalar. Görünümü değil, SİSTEMİ korurlar. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = (...p) => path.join(__dirname, '..', ...p);
const CORE = R('css', 'core', 'modal.css');
const core = fs.readFileSync(CORE, 'utf8');

// Ortak sistemin sahiplendiği sınıflar. Sayfa stil dosyaları bunları YENİDEN
// TANIMLAMAMALI — aksi halde beş sistem yeniden ayrışır.
const OWNED = [
    '.modal-content', '.modal-header', '.modal-body', '.modal-actions',
    '.modal-head', '.modal-foot', '.modal-grid', '.modal-section-h',
    '.close-modal', '.rst-modal-card', '.rst-modal-head'
];
// Aşama 2 tamamlandı: beş sayfanın hepsi ortak sistemde.
const PENDING = new Set([]);
const PAGES_HTML = ['panel.html', 'admin.html', 'superadmin.html', 'crm.html', 'restaurant.html'];
const PAGE_CSS = ['panel.css', 'admin.css', 'superadmin.css', 'crm-theme.css', 'restaurant.css'];

// Bir seçicinin KURAL BAŞI olarak geçtiği satırları bulur (yorum/başka
// seçicinin parçası olan geçişler sayılmaz).
function redefines(src, sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^\\s*' + esc + '\\s*(\\{|,)', 'm');
    return re.test(src);
}

test('sayfa stil dosyaları ortak modal sınıflarını YENİDEN TANIMLAMIYOR', () => {
    const offenders = [];
    for (const file of PAGE_CSS) {
        if (PENDING.has(file)) continue;      // Aşama 2
        const src = fs.readFileSync(R('css', 'modules', file), 'utf8');
        for (const sel of OWNED) {
            if (redefines(src, sel)) offenders.push(file + ' → ' + sel);
        }
    }
    assert.deepEqual(offenders, [],
        'Bu kurallar css/core/modal.css ile çakışıyor; ortak dosyaya taşıyın:\n' + offenders.join('\n'));
});

test('ortak modal dosyası !important KULLANMIYOR', () => {
    // `!important` tam olarak eski ezme savaşının izidir: admin.css onu
    // yalnızca panel.css'i ezmek için taşıyordu. Ortak dosya tek kaynak
    // olduğundan hiçbir yerde gerekmez.
    // Yorumlar hariç: bu dosyanın başlığı zaten eski `!important` savaşını
    // ANLATIYOR; aranan şey gerçek bir bildirimde geçmesi.
    const code = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = code.split('\n').map(l => l.trim()).filter(l => l.indexOf('!important') !== -1);
    assert.deepEqual(hits, []);
});

test('kapsam-içi sayfalar modal.css\'i YÜKLÜYOR ve sayfa stilinden SONRA', () => {
    // Sıra kritik: modal.css sonra gelmezse sayfa stilleri onu ezer ve
    // düzeltmek için yine `!important` gerekir.
    for (const page of PAGES_HTML) {
        const html = fs.readFileSync(R(page), 'utf8');
        const core_i = html.indexOf('css/core/modal.css');
        assert.ok(core_i > -1, page + ' css/core/modal.css yüklemiyor');
        for (const m of html.matchAll(/href="css\/modules\/([\w-]+\.css)"/g)) {
            assert.ok(m.index < core_i,
                `${page}: css/modules/${m[1]} modal.css'ten SONRA yükleniyor — ezme savaşı geri döner`);
        }
    }
});

test('mobil sheet sözleşmesi (≤768px) bozulmadı', () => {
    // css/core/mobile-sheet.css modalları alttan açılan sheet'e çevirir ve
    // tamamı !important'tır; ortak dosya onunla yarışmamalı.
    const sheet = fs.readFileSync(R('css', 'core', 'mobile-sheet.css'), 'utf8');
    assert.match(sheet, /@media \(max-width: 768px\)/);
    assert.match(sheet, /\.modal \.modal-content[\s\S]*border-radius: 22px 22px 0 0 !important/);
    for (const page of PAGES_HTML) {
        assert.ok(fs.readFileSync(R(page), 'utf8').indexOf('css/core/mobile-sheet.css') > -1,
            page + ' mobile-sheet.css yüklemiyor');
    }
});

test('ortak dosya dört açma mekanizmasını da destekliyor', () => {
    // JS'e dokunulmadı: panel/admin/crm satır içi display:flex, superadmin
    // .show, restoran .open kullanıyor. Taban display:none olmalı ki satır
    // içi stil onu ezebilsin; .show/.open ise açıkça flex yapmalı.
    assert.match(core, /\.modal,\s*\n\.modal-backdrop,\s*\n\.rst-modal \{[\s\S]*?display: none;/);
    assert.match(core, /\.modal\.show,[\s\S]*?\.modal-backdrop\.show,[\s\S]*?\.rst-modal\.open,[\s\S]*?display: flex;/);
});

test('etiket ve başlık renkleri WCAG AA eşiğini geçiyor', () => {
    // Ölçüm tarayıcıda yapılıyor (Playwright); burada TOKEN değerleri
    // kilitlenir — #bbb/#ccc/#94a3b8 gibi eşik altı tonlar geri sızmasın.
    const lum = (hex) => {
        const c = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255)
            .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
        return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
    };
    const ratio = (hex) => Math.round(((Math.max(lum(hex), lum('#ffffff')) + .05) /
        (Math.min(lum(hex), lum('#ffffff')) + .05)) * 100) / 100;
    for (const name of ['--mdl-ink', '--mdl-ink-soft', '--mdl-ink-faint']) {
        const m = core.match(new RegExp(name + ':\\s*(#[0-9a-fA-F]{6})'));
        assert.ok(m, name + ' tanımlı değil');
        assert.ok(ratio(m[1]) >= 4.5,
            `${name} = ${m[1]} → beyaz üstünde ${ratio(m[1])}:1, WCAG AA (4.5:1) altında`);
    }
});

test('mobilde dokunma hedefi 44px', () => {
    assert.match(core, /@media \(max-width: 768px\)[\s\S]*?--mdl-field-h: 44px/);
});
