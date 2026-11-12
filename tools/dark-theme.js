#!/usr/bin/env node
/* Hotizy — gece modu (koyu tema) üreteci.
 *
 * Personel ekranlarının CSS'inde ~1000 sabit renk var; bunları elle tek tek
 * koyulaştırmak hem çok uzun sürer hem kaçak bırakır. Bu araç her kaynak
 * CSS'i okur ve RENK içeren her bildirim için `html.theme-dark` önekli bir
 * karşılık üretir:
 *
 *   · Zeminler: beyaz kart → koyu yüzey; sayfa grisi → daha koyu (kartlar
 *     "üstte" kalır); açık renkli rozet zemini → aynı tonda koyu zemin;
 *     koyu (lacivert) zemin → bir kademe açık koyu (beyaz yazı okunur kalır).
 *   · Yazılar: koyu gri → açık gri; renkli koyu yazı (kırmızı, yeşil…) →
 *     aynı tonun açığı; beyaz yazı (renkli düğme üstünde) aynen.
 *   · Kenarlıklar: açık gri → koyu gri; renkli açık → koyu renkli.
 *   · Gölgeler: koyu zeminde görünsün diye biraz güçlenir.
 *   · Renkli vurgular (düğme mavisi, yeşil, turuncu) aynen kalır.
 *
 * Renk içermeyen ama renk ÖZELLİĞİ olan bildirimler (ör. `var(--primary)`)
 * de aynı değerle kopyalanır: her kaynak kural +(0,1,1) özgüllük kazanır,
 * böylece kurallar arasındaki öncelik sırası koyu temada da korunur.
 *
 * Kullanım:  node tools/dark-theme.js          (tüm hedefleri üret)
 *            node tools/dark-theme.js --check  (güncel mi; değilse çık 1)
 * Kaynak CSS değiştirildikten sonra yeniden çalıştırılmalı (test denetler).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// [çıktı, kaynak, (JS içindeki `const css = \`…\`` bloğu ise) 'js']
const TARGETS = [
  ['css/dark/app-shell.dark.css', 'css/core/app-shell.css'],
  ['css/dark/modal.dark.css', 'css/core/modal.css'],
  ['css/dark/mobile.dark.css', 'css/core/mobile.css'],
  ['css/dark/mobile-sheet.dark.css', 'css/core/mobile-sheet.css'],
  ['css/dark/embed.dark.css', 'css/core/embed.css'],
  ['css/dark/dashboard.dark.css', 'css/modules/dashboard.css'],
  ['css/dark/panel.dark.css', 'css/modules/panel.css'],
  ['css/dark/concierge.dark.css', 'css/modules/concierge.css'],
  ['css/dark/crm.dark.css', 'css/modules/crm.css'],
  ['css/dark/crm-theme.dark.css', 'css/modules/crm-theme.css'],
  ['css/dark/reports.dark.css', 'css/modules/reports.css'],
  ['css/dark/restaurant.dark.css', 'css/modules/restaurant.css'],
  ['css/dark/realtime.dark.css', 'js/core/realtime.js', 'js'],
  ['css/dark/guest-orders.dark.css', 'js/modules/guest-orders.js', 'js']
];

// ── Renk yardımcıları ─────────────────────────────────────────────
const NAMED = { white: [255, 255, 255], black: [0, 0, 0] };
function parseColor(tok) {
  const t = tok.toLowerCase();
  if (NAMED[t]) return { r: NAMED[t][0], g: NAMED[t][1], b: NAMED[t][2], a: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(t);
  if (m) {
    let a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
function fmt({ r, g, b }, a) {
  const hx = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  if (a == null || a >= 1) return '#' + hx(r) + hx(g) + hx(b);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}
const SLATE_H = 222, SLATE_S = 0.16;   // koyu nötrlerin tonu (hafif mavi-gri)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// kind: 'bg' | 'fg' | 'border' | 'shadow' | 'accent'
// Nötr (gri) mü? HSL doygunluğu uçlarda yanıltır (slate-900 ve slate-50
// "doygun" görünür); koyu/orta tonlarda kroma, çok açıklarda doygunluk.
function isNeutral(c, s, l) {
  const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
  if (l >= 0.985 || chroma < 0.03) return true;
  if (l >= 0.85) return s < 0.45;
  return chroma < 0.2;
}
function mapColor(c, kind) {
  const { h, s, l } = rgbToHsl(c);
  const neutral = isNeutral(c, s, l);
  let H = h, S = s, L = l;
  if (kind === 'shadow') {
    const dark = l < 0.35;
    return fmt(c, dark ? clamp(c.a * 2.2, 0, 0.75) : c.a);
  }
  if (kind === 'bg') {
    if (neutral) {
      H = SLATE_H; S = SLATE_S;
      if (l >= 0.995) L = 0.145;                       // beyaz kart / yüzey
      else if (l >= 0.94) L = 0.105 + (0.99 - l) * 0.4; // sayfa grisi, ince zeminler (kartın "altında")
      else if (l >= 0.6) L = 0.17 + (0.94 - l) * 0.6;   // açık gri dolgu, iz, çip
      else if (l >= 0.25) L = 1 - l * 0.75;              // orta gri → açık-orta
      else { L = 0.24 + l * 0.5; S = Math.min(s, 0.25); } // koyu lacivert zemin → bir kademe açık
    } else if (l >= 0.9) { S = Math.min(s, 0.38); L = 0.17; }      // açık renkli rozet zemini
    else if (l >= 0.75) { S = Math.min(s, 0.5); L = 0.28; }         // açık-orta renkli
    else return fmt(c, c.a);                                         // vurgu rengi: aynen
  } else if (kind === 'fg') {
    if (neutral) {
      H = SLATE_H; S = Math.min(s, 0.18);
      if (l >= 0.9) return fmt(c, c.a);                 // beyaz yazı (renkli düğme üstünde)
      if (l < 0.6) L = 0.93 - l * 0.75;                  // koyu yazı → açık
      else L = 0.62 - (l - 0.6) * 0.6;                   // soluk yazı → soluk
    } else if (l < 0.62) { S = Math.min(s, 0.7); L = 0.68 + l * 0.1; }  // renkli koyu yazı → açığı
    else return fmt(c, c.a);
  } else if (kind === 'accent') {
    if (neutral) return mapColor(c, 'fg');
    if (l < 0.6) { S = Math.min(s, 0.85); L = 0.62; } else return fmt(c, c.a);
  } else if (kind === 'border') {
    if (neutral) {
      H = SLATE_H; S = SLATE_S;
      if (l >= 0.4) L = 0.2 + (1 - l) * 0.5;
      else L = 0.65;                                     // koyu kenar (odak vb.) → açık
    } else if (l >= 0.75) { S = Math.min(s, 0.4); L = 0.28; }
    else return fmt(c, c.a);
  }
  return fmt(hslToRgb(((H % 360) + 360) % 360, clamp(S, 0, 1), clamp(L, 0, 1)), c.a);
}

// Bir değerdeki tüm renk belirteçlerini eşle.
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)|\b(?:white|black)\b/g;
function mapValue(value, kind) {
  return value.replace(COLOR_RE, (tok) => {
    const c = parseColor(tok);
    return c ? mapColor(c, kind) : tok;
  });
}
function hasColor(v) { COLOR_RE.lastIndex = 0; const r = COLOR_RE.test(v); COLOR_RE.lastIndex = 0; return r; }

const COLOR_PROPS = {
  color: 'fg', fill: 'fg', stroke: 'fg', 'caret-color': 'fg', 'text-decoration-color': 'fg', '-webkit-text-fill-color': 'fg',
  'accent-color': 'accent',
  background: 'bg', 'background-color': 'bg', 'background-image': 'bg',
  border: 'border', 'border-top': 'border', 'border-right': 'border', 'border-bottom': 'border', 'border-left': 'border',
  'border-color': 'border', 'border-top-color': 'border', 'border-right-color': 'border', 'border-bottom-color': 'border',
  'border-left-color': 'border', outline: 'border', 'outline-color': 'border', 'column-rule': 'border', 'column-rule-color': 'border',
  'box-shadow': 'shadow', 'text-shadow': 'shadow'
};
function varKind(name) {
  const n = name.toLowerCase();
  if (/shadow/.test(n)) return 'shadow';
  if (/border|line|ring|divider|outline|stroke/.test(n)) return 'border';
  if (/text|muted|faint|ink|fg|foreground|label|title|heading/.test(n)) return 'fg';
  if (/warn|bad|danger|error|ok\b|-ok|success|info|alert/.test(n) && !/bg|soft|tint|surface/.test(n)) return 'accent';
  if (/-dark$/.test(n)) return 'accent';   // ör. --primary-dark: hem hover zemini hem etkin yazı rengi
  return 'bg';
}

// ── Küçük CSS ayrıştırıcı (yorum, dize, iç içe @media/@supports) ──
function stripComments(css) {
  let out = '', i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const q = ch; let j = i + 1;
      while (j < css.length && css[j] !== q) { if (css[j] === '\\') j++; j++; }
      out += css.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e === -1 ? css.length : e + 2; continue; }
    out += ch; i++;
  }
  return out;
}
// Üst düzey blokları ayrıştır: [{type:'rule', sel, body} | {type:'at', prelude, body}]
function parseBlocks(css) {
  const out = []; let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const semi = css.indexOf(';', i);
    if (semi !== -1 && semi < open && /^\s*@/.test(css.slice(i, semi))) { i = semi + 1; continue; } // @import / @charset
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1, q = null;
    for (; j < css.length && depth > 0; j++) {
      const ch = css[j];
      if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) out.push({ type: 'at', prelude, body });
    else out.push({ type: 'rule', sel: prelude, body });
    i = j;
  }
  return out;
}
function splitTop(s, sepChar) {
  const parts = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === '\\') { cur += s[++i] || ''; } else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sepChar && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function prefixSelector(sel) {
  return splitTop(sel, ',').map((raw) => {
    const s = raw.trim().replace(/\s+/g, ' ');
    if (!s) return s;
    if (/^:root\b/.test(s)) return s.replace(/^:root/, 'html.theme-dark');
    if (/^html\b/.test(s)) return s.replace(/^html/, 'html.theme-dark');
    return 'html.theme-dark ' + s;
  }).join(',\n');
}
function convertDecls(body) {
  const out = [];
  for (const d of splitTop(body, ';')) {
    const k = d.indexOf(':');
    if (k === -1) continue;
    const prop = d.slice(0, k).trim();
    let val = d.slice(k + 1).trim();
    if (!prop || !val) continue;
    const pl = prop.toLowerCase();
    let kind = COLOR_PROPS[pl];
    if (pl.startsWith('--')) {
      if (!hasColor(val) && !/var\(/.test(val)) continue;
      kind = varKind(pl);
    }
    if (!kind) continue;
    if (!hasColor(val) && !/var\(|currentcolor|transparent|none|inherit|initial|unset/i.test(val)) continue;
    out.push(`    ${prop}: ${mapValue(val, kind)};`);
  }
  return out;
}
function convert(css, indent) {
  indent = indent || '';
  const lines = [];
  for (const b of parseBlocks(stripComments(css))) {
    if (b.type === 'rule') {
      const decls = convertDecls(b.body);
      if (!decls.length) continue;
      lines.push(indent + prefixSelector(b.sel).replace(/\n/g, '\n' + indent) + ' {');
      decls.forEach((d) => lines.push(indent + d));
      lines.push(indent + '}');
    } else if (/^@(media|supports|container|layer)\b/i.test(b.prelude)) {
      const inner = convert(b.body, indent + '    ');
      if (!inner.trim()) continue;
      lines.push(indent + b.prelude + ' {', inner, indent + '}');
    } // @keyframes, @font-face, @page: atla
  }
  return lines.join('\n');
}
function extractJsCss(src) {
  const blocks = [];
  const re = /const css = `([\s\S]*?)`;/g; let m;
  while ((m = re.exec(src))) blocks.push(m[1]);
  return blocks.join('\n');
}
function generate(source, kind) {
  const css = kind === 'js' ? extractJsCss(source) : source;
  return '/* OTOMATİK ÜRETİLDİ — elle düzenlemeyin. Kaynak değişince: node tools/dark-theme.js */\n' + convert(css) + '\n';
}

module.exports = { generate, mapColor, parseColor, prefixSelector, TARGETS };

if (require.main === module) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [outRel, srcRel, kind] of TARGETS) {
    const out = generate(fs.readFileSync(path.join(ROOT, srcRel), 'utf8'), kind);
    const outPath = path.join(ROOT, outRel);
    if (check) {
      const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
      if (cur !== out) { stale++; console.error('güncel değil: ' + outRel); }
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
      console.log(outRel + '  (' + out.split('\n').length + ' satır)');
    }
  }
  if (check && stale) process.exit(1);
}
