/* Hotizy — PMS dış istek adresi güvenlik denetimi (saf, test edilebilir).
 *
 * pmsSaveConfig/pmsTestConfig'te baseUrl/tokenUrl için hiçbir host doğrulaması
 * yoktu — yalnızca superadmin erişebildiği için düşük olasılıklı ama ele
 * geçirilmiş/XSS'lenmiş bir superadmin oturumu, extraHeaders + cfg.map ile
 * Cloud Functions'ın iç ağına veya GCP metadata sunucusuna (169.254.169.254)
 * karşı kör bir SSRF+veri-sızdırma primitifi olarak fetch noktalarını
 * kullanabilirdi (bkz. operasyonel/güvenlik denetimi).
 *
 * DNS çözümlemesi (assertSafeOutboundUrl) dış bir bağımlılık (require('dns'))
 * gerektirdiğinden parametre olarak alınır — böylece bu modül emülatörsüz,
 * saf birim testleriyle doğrulanabilir (bkz. tests/pms-ssrf-guard.test.js).
 */
'use strict';

// Tek bir IPv4 adresi özel/yerel/ayrılmış bir aralıkta mı?
function ipv4Blocked(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !isFinite(n) || n < 0 || n > 255 || !Number.isInteger(n))) return true; // biçimsiz → engelle
  const [a, b] = parts;
  if (a === 127) return true;                          // loopback
  if (a === 10) return true;                            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  if (a === 169 && b === 254) return true;               // link-local — GCP/AWS metadata dahil
  if (a === 100 && b >= 64 && b <= 127) return true;      // 100.64.0.0/10 (CGNAT, bazı bulut iç ağları)
  if (a === 0) return true;                               // 0.0.0.0/8
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 (IETF özel)
  if (a === 198 && (b === 18 || b === 19)) return true;   // 198.18.0.0/15 (kıyaslama ağı)
  if (a >= 224) return true;                              // çoklu yayın + ayrılmış + 255.255.255.255
  return false;
}

// IPv6 → 8 adet 16-bit sayı. Sondaki noktalı IPv4 ("::ffff:1.2.3.4") de
// çözülür. Biçimsizse null.
function parseIPv6(str) {
  let s = String(str || '').toLowerCase();
  const pct = s.indexOf('%'); if (pct !== -1) s = s.slice(0, pct); // bölge kimliği (fe80::1%eth0)
  let tail = [];
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.') !== -1) {
    const v4 = s.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !(n >= 0 && n <= 255))) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1) + (s.charAt(lastColon - 1) === ':' ? '' : '0');
    if (s.slice(-2) === ':0' && tail.length) s = s.slice(0, -2);
    if (s.slice(-1) === ':' && s.slice(-2) !== '::') s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toNums = (h) => (h ? h.split(':') : []).map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  const head = toNums(halves[0]);
  const rest = halves.length === 2 ? toNums(halves[1]) : [];
  const total = head.length + rest.length + tail.length;
  if (head.concat(rest).some((n) => isNaN(n))) return null;
  if (halves.length === 1 && total !== 8) return null;
  if (total > 8) return null;
  const zeros = new Array(8 - total).fill(0);
  return head.concat(zeros, rest, tail);
}

// TEK bir IP adresinin private/loopback/link-local/CGNAT aralıklarından
// birine düşüp düşmediğini kontrol eder. Hostname bir DNS adıysa çağıran
// TÜM çözülen IP'leri buradan geçirmeli (DNS-rebinding'e karşı) — yalnızca
// URL string'ine bakmak yeterli olmaz.
// IPv6 DÜZELTMESİ: URL ayrıştırıcısı IPv6 adresini KÖŞELİ PARANTEZLE verir
// ("[::1]") ve IPv4-gömülü adresleri onaltılı yazar ("[::ffff:a9fe:a9fe]" =
// 169.254.169.254). Eski kontrol ikisini de tanımıyordu: http://[::1]/ ve
// metadata sunucusunun IPv4-eşlemeli biçimi denetimden GEÇİYORDU.
function ipBlocked(ip) {
  let s = String(ip || '').trim();
  if (s.charAt(0) === '[' && s.slice(-1) === ']') s = s.slice(1, -1);
  if (s.indexOf(':') === -1) return ipv4Blocked(s);
  const h = parseIPv6(s);
  if (!h) return true;                                                  // biçimsiz → engelle
  const embeddedV4 = () => [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.');
  if (h.every((x) => x === 0)) return true;                             // :: (belirsiz)
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true;   // ::1 loopback
  if ((h[0] & 0xffc0) === 0xfe80) return true;                          // fe80::/10 link-local
  if ((h[0] & 0xfe00) === 0xfc00) return true;                          // fc00::/7 unique local
  if ((h[0] & 0xff00) === 0xff00) return true;                          // ff00::/8 çoklu yayın
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return ipv4Blocked(embeddedV4()); // ::ffff:a.b.c.d
  if (h.slice(0, 6).every((x) => x === 0)) return ipv4Blocked(embeddedV4());                     // ::a.b.c.d (eski uyumlu)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return ipv4Blocked(embeddedV4()); // 64:ff9b::/96 NAT64
  return false;
}

// `lookup(hostname)` -> Promise<string[]> (çözülen IP'ler) enjekte edilir —
// gerçek kullanımda functions/index.js `dns.promises.lookup` ile sarmalar,
// testlerde sahte bir çözümleyici verilir (gerçek DNS'e hiç çıkılmaz).
async function assertSafeOutboundUrl(urlStr, label, lookup) {
  const lbl = label || 'URL';
  let u;
  try { u = new URL(String(urlStr || '')); } catch (e) { throw Object.assign(new Error(lbl + ' geçersiz.'), { code: 'invalid-argument' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error(lbl + ' yalnızca http(s) olabilir.'), { code: 'invalid-argument' });
  }
  const hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
    throw Object.assign(new Error(lbl + ' iç/yerel bir adrese işaret edemez.'), { code: 'invalid-argument' });
  }
  let ips;
  try {
    const looksLikeIp = /^[\d.]+$/.test(hostname) || hostname.indexOf(':') !== -1 || hostname.charAt(0) === '[';
    ips = looksLikeIp ? [hostname] : await lookup(hostname);
  } catch (e) {
    throw Object.assign(new Error(lbl + ' çözümlenemedi: ' + (e.message || e.name)), { code: 'unavailable' });
  }
  if (!ips || !ips.length || ips.some(ipBlocked)) {
    throw Object.assign(new Error(lbl + ' iç ağ/özel bir adrese işaret ediyor — izin verilmiyor.'), { code: 'invalid-argument' });
  }
}

module.exports = { ipBlocked, parseIPv6, assertSafeOutboundUrl };
