/* Misafir QR ekranı (guest-order) — tasarım sistemi korkulukları.
 *
 * 1) KONTRAST: css/modules/guest-order.css'teki renk token'ları AÇIK ve
 *    KOYU temada okunur (WCAG AA ≥ 4.5:1). Yarı saydam "soft" zeminler
 *    gerçekte bastıkları yüzeyle karıştırılarak ölçülür. Bir token
 *    değiştirildiğinde (ör. vurgu rengi) okunurluk sessizce bozulamaz.
 * 2) YAPI: Sohbet sekmesi kaldırıldı (3 sekme), tarayıcının confirm()
 *    penceresi yerine uygulama içi onay kullanılıyor, her iki tema için
 *    theme-color tanımlı.
 *
 * Saf mantık — CSS/HTML/JS KAYNAKTAN okunur (kopyası değil). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const css = read('css/modules/guest-order.css');
const html = read('guest-order.html');
const js = read('js/modules/guest-order.js');

function tokens(block) {
    const out = {};
    const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(block))) out[m[1]] = m[2].trim();
    return out;
}
// İlk :root bloğu = açık tema; prefers-color-scheme: dark içindeki :root = koyu.
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkRoot = css.indexOf(':root {', darkStart);
const darkBlock = css.slice(darkRoot, css.indexOf('}', darkRoot));
const LIGHT = tokens(lightBlock);
const DARK = Object.assign({}, LIGHT, tokens(darkBlock));

function parse(c) {
    c = c.trim();
    let m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
    m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    throw new Error('renk ayrıştırılamadı: ' + c);
}
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function ratio(theme, fgName, bgName, baseName) {
    const base = parse(theme[baseName || 'bg']);
    const bg = over(parse(theme[bgName]), base);
    const fg = over(parse(theme[fgName]), bg);
    const a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// [metin, zemin, (soft zeminin bastığı yüzey)]
const PAIRS = [
    ['ink', 'bg'], ['ink-2', 'bg'], ['ink-3', 'bg'],
    ['ink', 'surface'], ['ink-2', 'surface'], ['ink-3', 'surface'],
    ['ink-3', 'bg-2'], ['ink-2', 'bg-2'],
    ['accent-ink', 'accent-soft', 'surface'], ['accent-ink', 'bg'], ['accent', 'bg'],
    ['on-accent', 'accent'],
    ['warn', 'warn-soft', 'surface'], ['info', 'info-soft', 'surface'],
    ['ok', 'ok-soft', 'surface'], ['danger', 'danger-soft', 'surface'],
    ['danger', 'bg'], ['bg', 'ink']   // toast: ters renk
];

for (const [name, theme] of [['açık', LIGHT], ['koyu', DARK]]) {
    test(`${name} tema: metin token'ları WCAG AA (≥4.5:1)`, () => {
        const fails = [];
        for (const [fg, bg, base] of PAIRS) {
            assert.ok(theme[fg] && theme[bg], `token eksik: --${fg} / --${bg}`);
            const r = ratio(theme, fg, bg, base);
            if (r < 4.5) fails.push(`--${fg} / --${bg}: ${r.toFixed(2)}:1`);
        }
        assert.deepEqual(fails, [], 'yetersiz kontrast');
    });
}

test('token değerleri yalnızca ASCII (görünmez/benzer harf hatasına karşı)', () => {
    // Bir kez "#949bа8" (Kiril 'а') yazıldı: tarayıcı token'ı sessizce yok sayar.
    for (const [k, v] of Object.entries(DARK)) assert.match(v, /^[\x20-\x7e]+$/, `--${k}: ${v}`);
});

test('alt menü 3 sekme; Sohbet sekmesi ve ekranı kaldırıldı', () => {
    const tabs = html.match(/class="go-nav-b[^"]*" data-go="(\w+)"/g) || [];
    assert.deepEqual(tabs.map(s => s.match(/data-go="(\w+)"/)[1]), ['home', 'orders', 'profile']);
    assert.doesNotMatch(html, /id="scChat"|data-go="chat"/);
    assert.doesNotMatch(js, /renderChat|goChatBody/);
});

test("tarayıcının confirm() penceresi yerine uygulama içi onay", () => {
    // Tek izinli kullanım: onay sheet'i DOM'da yoksa (eski önbellekli HTML) yedek.
    const code = js.replace(/\/\/[^\n]*/g, '');   // yorum satırlarını ele
    const uses = code.match(/(^|[^.\w])confirm\(/g) || [];
    assert.equal(uses.length, 0, 'çıplak confirm() kullanımı kaldı');
    assert.match(html, /id="goConfirm"/);
});

test('her iki tema için theme-color ve color-scheme tanımlı', () => {
    assert.match(html, /name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"/);
    assert.match(html, /name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/);
    assert.match(html, /name="color-scheme" content="light dark"/);
});

test('yakınlaştırma engellenmiyor (erişilebilirlik)', () => {
    assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});
