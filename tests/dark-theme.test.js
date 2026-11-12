/* Gece modu (koyu tema) — tools/dark-theme.js + js/core/theme.js
 *  · Üretilmiş css/dark/*.dark.css dosyaları kaynaklarla GÜNCEL (kaynak CSS
 *    değişip üreteç çalıştırılmadıysa test düşer: node tools/dark-theme.js).
 *  · Eşleme okunaklı: metin / zemin kontrastı WCAG AA (≥ 4.5) — ana yazı,
 *    soluk yazı ve renkli rozet yazıları; vurgu renkleri ve beyaz düğme
 *    yazısı korunur; kartlar sayfa zemininden açık (üstte) kalır.
 *  · Her personel sayfası theme.js'i stil dosyalarından ÖNCE (beyaz
 *    parlama olmaz) ve yüklediği her kaynak CSS'in koyu karşılığını yükler.
 *  · Varsayılan açık tema (kimse habersiz koyuya geçmez). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const D = require('../tools/dark-theme.js');

function lum(hex) {
  const c = D.parseColor(hex);
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const m = (hex, kind) => D.mapColor(D.parseColor(hex), kind);

test('üretilmiş koyu CSS dosyaları güncel', () => {
  for (const [out, src, kind] of D.TARGETS) {
    const expected = D.generate(read(src), kind);
    assert.equal(read(out), expected, out + ' güncel değil — node tools/dark-theme.js çalıştırın');
  }
});

test('okunaklılık: ana / soluk yazı ve renkli rozetler AA kontrastında', () => {
  const card = m('#ffffff', 'bg'), page = m('#f4f7f9', 'bg');
  for (const t of ['#0f172a', '#1e293b', '#334155', '#475569', '#64748b']) {
    assert.ok(contrast(m(t, 'fg'), card) >= 4.5, t + ' kart üstünde ' + contrast(m(t, 'fg'), card).toFixed(2));
    assert.ok(contrast(m(t, 'fg'), page) >= 4.5, t + ' sayfa üstünde');
  }
  const chips = [['#b91c1c', '#fef2f2'], ['#047857', '#ecfdf5'], ['#4338ca', '#eef2ff'], ['#b45309', '#fffbeb'], ['#1d4ed8', '#eff6ff']];
  for (const [fg, bg] of chips) {
    const c = contrast(m(fg, 'fg'), m(bg, 'bg'));
    assert.ok(c >= 4.5, fg + ' / ' + bg + ' → ' + c.toFixed(2));
  }
  // Beyaz düğme yazısı ve vurgu renkleri aynen kalır.
  assert.equal(m('#ffffff', 'fg'), '#ffffff');
  for (const a of ['#6366f1', '#16a34a', '#f59e0b', '#ef4444']) assert.equal(m(a, 'bg'), a);
  // Kart, sayfa zemininden açık (üstte) kalır; koyu zeminler kabarır.
  assert.ok(lum(card) > lum(page), 'kart sayfadan açık olmalı');
  assert.ok(lum(m('#0f172a', 'bg')) > lum(card), 'koyu bildirim zemini karttan ayrışmalı');
  // Alfa korunur, gölgeler güçlenir.
  assert.match(m('rgba(255,255,255,.88)', 'bg'), /^rgba\(\d+, \d+, \d+, 0\.88\)$/);
  assert.match(m('rgba(15,23,42,0.05)', 'shadow'), /0\.11\)$/);
});

test('seçici öneki', () => {
  assert.equal(D.prefixSelector(':root'), 'html.theme-dark');
  assert.equal(D.prefixSelector('html.embed .x'), 'html.theme-dark.embed .x');
  assert.equal(D.prefixSelector('.a, .b > .c'), 'html.theme-dark .a,\nhtml.theme-dark .b > .c');
  assert.equal(D.prefixSelector('body.mv-home .mob-home'), 'html.theme-dark body.mv-home .mob-home');
});

test('her personel sayfası theme.js\'i önce ve koyu stilleri yükler', () => {
  const pages = ['app', 'dashboard', 'panel', 'concierge', 'crm', 'reports', 'restaurant'];
  for (const p of pages) {
    const html = read(p + '.html');
    const t = html.indexOf('js/core/theme.js');
    const firstCss = html.indexOf('rel="stylesheet"');
    assert.ok(t > -1 && t < firstCss, p + ': theme.js stil dosyalarından önce');
    assert.match(html, /css\/core\/theme-dark-base\.css/);
    for (const [out, src, kind] of D.TARGETS) {
      if (kind === 'js') continue;
      if (html.indexOf('href="' + src) > -1) assert.ok(html.indexOf(out) > -1, p + ': ' + src + ' için ' + out + ' yok');
    }
  }
  for (const p of ['panel', 'concierge']) assert.match(read(p + '.html'), /css\/dark\/guest-orders\.dark\.css/);
  assert.match(read('app.html'), /css\/dark\/realtime\.dark\.css/);
});

test('tema motoru: varsayılan açık, sistem seçeneği, çerçeveler eşitlenir', () => {
  const js = read('js/core/theme.js');
  assert.match(js, /return localStorage\.getItem\(KEY\) \|\| 'light';/);
  assert.match(js, /p === 'auto' && !!\(mq && mq\.matches\)/);
  assert.match(js, /window\.addEventListener\('storage'/);
  assert.match(js, /f\.contentWindow\.Theme\.apply\(\)/);
});
