// 主控登入安全：密碼雜湊（scrypt）、TOTP 兩步驟驗證、備用復原碼、已知裝置。
// 全部只在伺服器端執行；機密存在 admin_security 表（沒有對任何前端角色開放，只有 service role 讀得到）。
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  const clean = String(s).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEqualStr(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---- 密碼 ----
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(String(pin), salt, 32, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('hex'), h.toString('hex')].join('$');
}
function verifyPinHash(pin, stored) {
  try {
    const [alg, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const h = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32, { N: +N, r: +r, p: +p });
    const want = Buffer.from(hashHex, 'hex');
    return want.length === h.length && crypto.timingSafeEqual(h, want);
  } catch { return false; }
}

// ---- TOTP（RFC 6238，30 秒、6 位數、SHA-1，跟 Google Authenticator／密碼 App 相容）----
function newTotpSecret() { return b32enc(crypto.randomBytes(20)); }
function hotp(secretBuf, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(b).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
// 回傳比對成功的時間步（用來防止同一組驗證碼被重複使用），失敗回傳 null。允許前後各一個時間步的誤差。
function verifyTotp(secretB32, code, lastStep) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  let key; try { key = b32dec(secretB32); } catch { return null; }
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const step = now + d;
    if (lastStep != null && step <= Number(lastStep)) continue;
    if (safeEqualStr(hotp(key, step), c)) return step;
  }
  return null;
}
function otpauthUri(secret, account) {
  return 'otpauth://totp/' + encodeURIComponent('碳金Hub:' + account) + '?secret=' + secret + '&issuer=' + encodeURIComponent('碳金Hub') + '&digits=6&period=30';
}

// ---- 備用復原碼（一次性）----
function newRecoveryCodes(n = 8) {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => { let s = ''; const r = crypto.randomBytes(10); for (let i = 0; i < 10; i++) s += alpha[r[i] % alpha.length]; return s.slice(0, 5) + '-' + s.slice(5); });
}
const normRecovery = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function hashRecovery(c) { return sha256(normRecovery(c)); }

// ---- 已信任裝置（「記住這台裝置 30 天」，通過一次完整的密碼＋兩步驟驗證後才會發一組，之後這台裝置登入可以跳過驗證碼）----
// 瀏覽器端只存這組亂碼本身（夠長、無法用猜的），伺服器只存它的雜湊＋到期時間，資料庫外洩也救不回原始值。
const TRUSTED_DEVICE_DAYS = 30;
function newTrustToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashTrustToken(t) { return sha256('td:' + String(t || '')); }
// list：目前存在 admin_security.trusted_devices 的陣列。回傳 { matchIndex, list }：matchIndex 是比對到且未過期的那一筆索引（沒有就是 -1），
// list 是「已經先濾掉過期項目」的新陣列（呼叫端寫回資料庫時用這份，順便清掉過期的，不用另外跑一次清理）。
function matchTrustToken(token, list) {
  const now = Date.now();
  const alive = (Array.isArray(list) ? list : []).filter(x => x && x.exp && new Date(x.exp).getTime() > now);
  if (!token) return { matchIndex: -1, list: alive };
  const h = hashTrustToken(token);
  const matchIndex = alive.findIndex(x => x.h === h);
  return { matchIndex, list: alive };
}
function trustExpiry() { return new Date(Date.now() + TRUSTED_DEVICE_DAYS * 86400000).toISOString(); }

module.exports = { hashPin, verifyPinHash, safeEqualStr, newTotpSecret, verifyTotp, otpauthUri, newRecoveryCodes, hashRecovery, normRecovery, sha256, b32enc, b32dec, hotp, newTrustToken, hashTrustToken, matchTrustToken, trustExpiry, TRUSTED_DEVICE_DAYS };
