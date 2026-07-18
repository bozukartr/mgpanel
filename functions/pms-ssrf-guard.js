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

// TEK bir IP adresinin private/loopback/link-local/CGNAT aralıklarından
// birine düşüp düşmediğini kontrol eder. Hostname bir DNS adıysa çağıran
// TÜM çözülen IP'leri buradan geçirmeli (DNS-rebinding'e karşı) — yalnızca
// URL string'ine bakmak yeterli olmaz.
function ipBlocked(ip) {
  if (ip.indexOf('.') !== -1 && ip.indexOf(':') === -1) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !isFinite(n) || n < 0 || n > 255)) return true; // biçimsiz → engelle
    const [a, b] = parts;
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                            // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16
    if (a === 169 && b === 254) return true;               // link-local — GCP/AWS metadata dahil
    if (a === 100 && b >= 64 && b <= 127) return true;      // 100.64.0.0/10 (CGNAT, bazı bulut iç ağları)
    if (a === 0) return true;                               // 0.0.0.0/8
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1') return true;                                          // loopback
  if (/^fe[89ab][0-9a-f]:/.test(low)) return true;                         // fe80::/10 link-local
  if (low[0] === 'f' && (low[1] === 'c' || low[1] === 'd')) return true;   // fc00::/7 unique local
  if (low.indexOf('::ffff:') === 0) return ipBlocked(low.slice(7));        // IPv4-mapped
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
    const looksLikeIp = /^[\d.]+$/.test(hostname) || hostname.indexOf(':') !== -1;
    ips = looksLikeIp ? [hostname] : await lookup(hostname);
  } catch (e) {
    throw Object.assign(new Error(lbl + ' çözümlenemedi: ' + (e.message || e.name)), { code: 'unavailable' });
  }
  if (!ips || !ips.length || ips.some(ipBlocked)) {
    throw Object.assign(new Error(lbl + ' iç ağ/özel bir adrese işaret ediyor — izin verilmiyor.'), { code: 'invalid-argument' });
  }
}

module.exports = { ipBlocked, assertSafeOutboundUrl };
