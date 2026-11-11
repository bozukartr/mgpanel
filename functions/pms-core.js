/* Hotizy — PMS okuma adaptörü çekirdeği (saf, test edilebilir).
 *
 * Eskiden bu mantık functions/index.js içindeydi ve hiçbir testle
 * çalıştırılamıyordu — gerçek bir PMS bağlanmadan doğruluğu bilinemiyordu.
 * Ağ (fetch), adres güvenliği (SSRF), şifre çözme ve token önbelleği
 * BAĞIMLILIK olarak enjekte edilir; tests/pms-core.test.js bu çekirdeği yerel
 * bir sahte PMS sunucusuna karşı uçtan uca çalıştırır.
 *
 * Yalnızca OKUMA: misafir arama. PMS'e hiçbir zaman yazılmaz.
 *
 * Sahte PMS denemesinde bulunan ve burada düzeltilen hatalar:
 *  · Boş alan eşlemesi kaydın TAMAMINI döndürüyordu → isim/telefon
 *    "[object Object]" (formun varsayılanıyla bile).
 *  · 2 karakterden kısa sorgu PMS'e hiç gitmeden "başarılı" dönüyordu —
 *    süperadmin testinin varsayılan sorgusu "a" olduğundan TEST HİÇBİR
 *    ZAMAN PMS'e bağlanmıyordu (yanlış adres/anahtarla da "başarılı").
 *  · OAuth2'de boş "Auth Öneki" → "Authorization: <token>" (Bearer yok) → 401;
 *    "Bearer" boşluksuz yazılırsa "Bearer<token>" → 401.
 *  · OAuth2 token önbelleği yalnızca otele göre anahtarlıydı: yeni (yanlış)
 *    client secret ile yapılan test eski token'la BAŞARILI görünüyordu.
 *  · Yönlendirmeler izleniyordu (SSRF denetimini atlatır).
 *  · Tarih "2026-11-10T14:00:00Z" / "15.11.2026" olduğu gibi geçiyor, tarih
 *    alanlarını dolduramıyordu; VIP "N" → true.
 */
'use strict';
const crypto = require('crypto');

class PmsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.isPmsError = true; }
}

const MAX_RESULTS = 12;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 7000;

// ── Alan okuma ─────────────────────────────────────────────────────────
// 'a.b.0.c' ya da 'a.b[0].c'. Boş yol → undefined (eskiden kaydın KENDİSİ).
function dig(obj, path) {
  const p = String(path == null ? '' : path).trim();
  if (!p) return undefined;
  return p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}
// 'profile.firstName + profile.lastName' → "Ahmet Yılmaz"
function pickField(item, spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) return undefined;
  if (s.indexOf('+') === -1) return dig(item, s);
  const parts = s.split('+').map((x) => scalar(dig(item, x.trim())))
    .filter((v) => v !== undefined && String(v).trim() !== '');
  return parts.length ? parts.map((v) => String(v).trim()).join(' ') : undefined;
}
function scalar(v) { return (v == null || typeof v === 'object') ? undefined : v; }
function firstVal() {
  for (let i = 0; i < arguments.length; i++) {
    const s = scalar(arguments[i]);
    if (s !== undefined && String(s).trim() !== '') return String(s).trim();
  }
  return '';
}
const pad2 = (n) => (String(n).length < 2 ? '0' + n : String(n));

// Tarih → 'YYYY-MM-DD' (tanınmazsa ''). Tarih alanları <input type="date">
// bekliyor; tanınmayan biçimi olduğu gibi yazmak alanı sessizce boşaltıyordu.
function normDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms + 3 * 3600 * 1000); // İstanbul günü
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  // GG.AA.YYYY / GG/AA/YYYY / GG-AA-YYYY (Türkiye/Avrupa). İkinci sayı 12'den
  // büyükse ABD biçimidir (AA/GG/YYYY).
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) {
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
    return valid(+m[3], mo, d);
  }
  return '';
}
function valid(y, mo, d) {
  if (!(y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  return y + '-' + pad2(mo) + '-' + pad2(d);
}
// VIP: true/'Y'/'VIP2'/'Gold' → true; 'N'/'false'/'0'/'' → false.
function normVip(v) {
  if (v === true) return true;
  if (v == null || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'object') return false;
  const s = String(v).trim().toLocaleLowerCase('tr-TR');
  return !(s === '' || ['n', 'no', 'false', '0', 'hayır', 'hayir', 'yok', 'none', '-', 'null', 'off'].includes(s));
}
function birthYearOf(v) {
  const s = scalar(v);
  if (s === undefined || String(s).trim() === '') return '';
  const str = String(s).trim();
  const y = /^\d{4}$/.test(str) ? +str : +String(normDate(s)).slice(0, 4);
  const now = new Date().getFullYear();
  return (y >= 1900 && y <= now) ? y : '';
}

// PMS kaydı → standart misafir. Eşleme boşsa yaygın alan adlarına düşer.
function normalize(item, map) {
  const it = (item && typeof item === 'object') ? item : {};
  const m = (map && typeof map === 'object') ? map : {};
  const nameJoined = [scalar(it.firstName), scalar(it.lastName)].filter((x) => x !== undefined && String(x).trim()).join(' ');
  return {
    name: firstVal(pickField(it, m.name), it.name, it.guestName, it.fullName, nameJoined).slice(0, 120),
    room: firstVal(pickField(it, m.room), it.room, it.roomNo, it.roomNumber).slice(0, 20),
    checkIn: normDate(firstVal(pickField(it, m.checkIn), it.checkIn, it.arrival, it.arrivalDate)),
    checkOut: normDate(firstVal(pickField(it, m.checkOut), it.checkOut, it.departure, it.departureDate)),
    vip: normVip(String(m.vip || '').trim() ? pickField(it, m.vip) : it.vip),
    phone: firstVal(pickField(it, m.phone), it.phone, it.phoneNumber, it.mobile).slice(0, 40),
    email: firstVal(pickField(it, m.email), it.email, it.mail).slice(0, 120),
    birthYear: birthYearOf(firstVal(pickField(it, m.birthDate), it.birthDate, it.dateOfBirth, it.birthYear))
  };
}

// ── İstek kurma ────────────────────────────────────────────────────────
function buildUrl(baseUrl, searchPath, q) {
  const path = String(searchPath || '?q={q}').trim().replace(/\{q\}/g, encodeURIComponent(q));
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (path.charAt(0) === '?') return base + (base.indexOf('?') !== -1 ? '&' + path.slice(1) : path);
  return base + (path.charAt(0) === '/' ? path : '/' + path);
}
// Oda numarası gibi görünen sorgu (204, 1105A, B12) — ayrı "Oda Arama Yolu"
// tanımlıysa o kullanılır (PMS'ler oda ve isim için çoğu zaman farklı
// parametre ister).
function isRoomQuery(q) { return /^[A-Za-z]?\d{1,5}[A-Za-z]?$/.test(String(q || '').trim()); }
// "Bearer" → "Bearer <token>"; OAuth2'de önek boşsa Bearer varsayılır.
function authValue(prefix, secret, isOAuth) {
  let p = String(prefix == null ? '' : prefix).trim();
  if (!p && isOAuth) p = 'Bearer';
  if (!p) return secret;
  return (/[=:]$/.test(p) ? p : p + ' ') + secret;
}
function tokenFingerprint(o) {
  return crypto.createHash('sha256')
    .update([o.tokenUrl, o.clientId, o.scope, o.clientSecret].map((x) => String(x || '')).join('\n'))
    .digest('hex').slice(0, 24);
}
function statusHint(st) {
  if (st === 401 || st === 403) return ' — anahtar/kimlik bilgisi, Auth Header veya Auth Öneki hatalı olabilir.';
  if (st === 404) return ' — Base URL veya Arama Yolu yanlış olabilir.';
  if (st === 429) return ' — PMS hız sınırına takıldı.';
  if (st >= 500) return ' — PMS sunucu hatası.';
  return '';
}

async function fetchOnce(deps, url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs || TIMEOUT_MS);
  try {
    // redirect:'manual' — yönlendirme İZLENMEZ: aksi halde güvenli görünen
    // bir adres iç ağa/metadata sunucusuna yönlendirip SSRF denetimini
    // atlatabilirdi (ve kimlik bilgisi başka bir hosta gidebilirdi).
    return await deps.fetch(url, Object.assign({}, init, { signal: ctrl.signal, redirect: 'manual' }));
  } catch (e) {
    if (e && e.name === 'AbortError') throw new PmsError('deadline-exceeded', 'PMS ' + Math.round((deps.timeoutMs || TIMEOUT_MS) / 1000) + ' sn içinde yanıt vermedi.');
    throw new PmsError('unavailable', 'PMS bağlantısı başarısız: ' + ((e && (e.cause && e.cause.code)) || (e && e.message) || 'ağ hatası'));
  } finally { clearTimeout(timer); }
}
// Geçici hatada (ağ hatası / 5xx) tek yeniden deneme; zaman aşımı ve 4xx'te değil.
async function fetchWithRetry(deps, url, init) {
  try {
    const r = await fetchOnce(deps, url, init);
    if (r.status < 500) return r;
  } catch (e) {
    if (e.code === 'deadline-exceeded') throw e;
  }
  await new Promise((res) => setTimeout(res, deps.retryDelayMs == null ? 350 : deps.retryDelayMs));
  return fetchOnce(deps, url, init);
}
function assertNotRedirect(resp, label) {
  if (resp.status >= 300 && resp.status < 400) {
    throw new PmsError('failed-precondition', label + ' yönlendirme döndürdü (HTTP ' + resp.status
      + '). Güvenlik nedeniyle yönlendirme izlenmez — doğrudan son adresi girin (ör. http yerine https).');
  }
}
async function readJson(resp, label) {
  const len = Number(resp.headers && resp.headers.get && resp.headers.get('content-length')) || 0;
  if (len > MAX_BODY_BYTES) throw new PmsError('unavailable', label + ' yanıtı çok büyük (' + Math.round(len / 1024) + ' KB).');
  const text = await resp.text();
  if (text.length > MAX_BODY_BYTES) throw new PmsError('unavailable', label + ' yanıtı çok büyük.');
  try { return JSON.parse(text); } catch (e) {
    const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
    throw new PmsError('unavailable', label + ' yanıtı JSON değil' + (ct ? ' (' + String(ct).split(';')[0] + ')' : '')
      + ' — Base URL / Arama Yolu bir giriş sayfasına ya da yanlış uca gidiyor olabilir.');
  }
}

// ── OAuth2 client-credentials ──────────────────────────────────────────
// Önbellek kaydı {token, expiresAt, fp}: fp, token URL + client id + scope +
// secret özetidir — kimlik bilgisi değişince eski token KULLANILMAZ.
async function getToken(cfg, deps, forceRefresh) {
  const o = Object.assign({}, cfg.oauth2 || {});
  o.clientSecret = deps.decrypt(o.clientSecret);
  if (!o.tokenUrl) throw new PmsError('failed-precondition', 'OAuth2 token URL tanımlı değil.');
  const fp = tokenFingerprint(o);
  const now = Date.now();
  if (!forceRefresh && deps.tokenCache) {
    const c = await deps.tokenCache.get();
    if (c && c.fp === fp && c.expiresAt > now) return c.token;
  }
  await deps.assertSafeUrl(o.tokenUrl, 'OAuth2 token URL');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: o.clientId || '', client_secret: o.clientSecret || '' });
  if (o.scope) body.set('scope', o.scope);
  const resp = await fetchOnce(deps, o.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  });
  assertNotRedirect(resp, 'OAuth2 token URL');
  if (!resp.ok) {
    throw new PmsError('unavailable', 'PMS OAuth2 token alınamadı: HTTP ' + resp.status
      + (resp.status === 400 || resp.status === 401 ? ' — Client ID / Client Secret / Scope hatalı olabilir.' : ''));
  }
  const data = await readJson(resp, 'OAuth2 token');
  if (!data || !data.access_token) throw new PmsError('unavailable', 'PMS OAuth2 yanıtında access_token yok.');
  const expiresInMs = (Number(data.expires_in) || 300) * 1000;
  const fresh = { token: String(data.access_token), expiresAt: now + Math.max(30000, expiresInMs - 15000), fp };
  if (deps.tokenCache) await deps.tokenCache.set(fresh);
  return fresh.token;
}

// ── Demo (mock) sağlayıcı ──────────────────────────────────────────────
// Tarihler BUGÜNE göre üretilir (eskiden sabit Haziran 2026 tarihleriydi).
function mockGuests(base) {
  const t0 = base ? new Date(base) : new Date(Date.now() + 3 * 3600 * 1000);
  const day = (o) => new Date(t0.getTime() + o * 86400000).toISOString().slice(0, 10);
  return [
    { name: 'Ahmet Yılmaz', room: '204', checkIn: day(-1), checkOut: day(2), vip: true, phone: '+90 532 111 2233', email: 'ahmet.yilmaz@example.com', birthYear: 1985 },
    { name: 'Elif Demir', room: '305', checkIn: day(-2), checkOut: day(1), vip: false, phone: '+90 533 222 3344', email: 'elif.demir@example.com', birthYear: 1992 },
    { name: 'Mehmet Kaya', room: '118', checkIn: day(-3), checkOut: day(3), vip: false, phone: '+90 534 333 4455', email: 'mehmet.kaya@example.com', birthYear: 1978 },
    { name: 'Sema Doğan', room: '410', checkIn: day(-4), checkOut: day(7), vip: true, phone: '+90 535 444 5566', email: 'sema.dogan@example.com', birthYear: 1980 },
    { name: 'John Carter', room: '512', checkIn: day(0), checkOut: day(5), vip: false, phone: '+1 202 555 0142', email: 'j.carter@example.com', birthYear: 1975 },
    { name: 'Ayşe Çelik', room: '207', checkIn: day(-1), checkOut: day(0), vip: false, phone: '+90 536 555 6677', email: 'ayse.celik@example.com', birthYear: 1990 }
  ];
}

// Test teşhisi için yanıttaki alan YOLLARI (değerler değil — kişisel veri
// süperadmin ekranına taşınmaz).
function keyPaths(obj, depth, prefix, out) {
  out = out || [];
  if (!obj || typeof obj !== 'object' || depth < 0 || out.length >= 40) return out;
  Object.keys(obj).slice(0, 25).forEach((k) => {
    if (out.length >= 40) return;
    const v = obj[k];
    const p = prefix ? prefix + '.' + k : k;
    if (Array.isArray(v)) {
      if (v.length && v[0] && typeof v[0] === 'object') keyPaths(v[0], depth - 1, p + '[0]', out);
      else out.push(p + '[]');
    } else if (v && typeof v === 'object') keyPaths(v, depth - 1, p, out);
    else out.push(p);
  });
  return out;
}

// ── Arama ──────────────────────────────────────────────────────────────
// deps: { fetch, assertSafeUrl(url,label), decrypt(blob), tokenCache?{get,set} }
// opts: { diagnose } — süperadmin testi: kısa sorgu HATA verir (sessizce
// "başarılı" dönmez) ve yanıt yapısı teşhisi eklenir.
async function runLookup(cfg, query, deps, opts) {
  opts = opts || {};
  const q = String(query || '').trim().slice(0, 80);
  if (!cfg || cfg.enabled === false) return { enabled: false, results: [] };
  if (q.length < 2) {
    if (opts.diagnose) throw new PmsError('invalid-argument', 'Test sorgusu en az 2 karakter olmalı (ör. bir soyadı veya oda numarası).');
    return { enabled: true, results: [] };
  }
  const provider = cfg.provider || 'mock';
  if (provider === 'mock') {
    const ql = q.toLocaleLowerCase('tr-TR');
    const results = mockGuests().filter((g) => g.name.toLocaleLowerCase('tr-TR').includes(ql) || g.room.includes(q)).slice(0, 8);
    return { enabled: true, results, source: 'mock' };
  }
  if (provider !== 'generic') return { enabled: true, results: [] };
  if (!cfg.baseUrl) throw new PmsError('failed-precondition', 'PMS Base URL tanımlı değil.');

  const byRoom = !!String(cfg.roomSearchPath || '').trim() && isRoomQuery(q);
  const url = buildUrl(cfg.baseUrl, byRoom ? cfg.roomSearchPath : cfg.searchPath, q);
  await deps.assertSafeUrl(url, 'PMS Base URL');

  const isOAuth = cfg.authType === 'oauth2';
  const authHeader = String(cfg.authHeader || '').trim() || 'Authorization';
  const headers = { Accept: 'application/json' };
  if (cfg.extraHeaders && typeof cfg.extraHeaders === 'object') {
    Object.keys(cfg.extraHeaders).forEach((k) => {
      const v = deps.decrypt(cfg.extraHeaders[k]);
      if (k && v) headers[k] = String(v);
    });
  }
  if (isOAuth) headers[authHeader] = authValue(cfg.authPrefix, await getToken(cfg, deps, false), true);
  else if (cfg.apiKey) { const k = deps.decrypt(cfg.apiKey); if (k) headers[authHeader] = authValue(cfg.authPrefix, k, false); }

  let resp = await fetchWithRetry(deps, url, { headers });
  // Token süresinden önce geçersizleşmiş olabilir (iptal, PMS yeniden
  // başlatma) — bir kez taze token ile tekrar dene.
  if (isOAuth && resp.status === 401) {
    headers[authHeader] = authValue(cfg.authPrefix, await getToken(cfg, deps, true), true);
    resp = await fetchOnce(deps, url, { headers });
  }
  assertNotRedirect(resp, 'PMS');
  if (!resp.ok) throw new PmsError('unavailable', 'PMS yanıtı: HTTP ' + resp.status + statusHint(resp.status));
  const data = await readJson(resp, 'PMS');

  const rp = String(cfg.resultsPath || '').trim();
  let arr = rp ? dig(data, rp) : data;
  const pathFound = Array.isArray(arr);
  if (!pathFound) arr = Array.isArray(data) ? data : [];
  const raw = arr.slice(0, MAX_RESULTS);
  const results = raw.map((it) => normalize(it, cfg.map)).filter((g) => g.name || g.room);
  const out = { enabled: true, results, source: 'generic' };
  if (opts.diagnose) {
    out.diag = {
      status: resp.status,
      insecure: /^http:/i.test(url),
      byRoom,
      resultsPath: rp,
      resultsPathFound: pathFound,
      rawCount: arr.length,
      kept: results.length,
      topKeys: (data && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data).slice(0, 20) : [],
      itemKeys: raw[0] ? keyPaths(raw[0], 3) : [],
      emptyFields: results.length ? ['name', 'room', 'checkIn', 'checkOut'].filter((f) => results.every((g) => !g[f])) : []
    };
  }
  return out;
}

module.exports = {
  PmsError, dig, pickField, normDate, normVip, birthYearOf, normalize, buildUrl, isRoomQuery,
  authValue, tokenFingerprint, mockGuests, keyPaths, runLookup, getToken, MAX_RESULTS
};
