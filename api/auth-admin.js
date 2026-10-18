// 主控登入。密碼存成 scrypt 雜湊（admin_security 表，前端角色完全讀不到）；開啟兩步驟驗證後要再輸入驗證碼（或一次性復原碼）。
// 相容舊版：admin_security 還沒有雜湊時，比對 settings.admin_pin（明文，固定時間比對），登入成功後自動轉成雜湊並清掉明文。
// 新裝置登入會推播通知主控；同一個網路位置連續失敗會推播警示。
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { getClientIp, isRateLimited, recordAttempt, recentFailCount } = require('../lib/rateLimit');
const sec = require('../lib/adminSecurity');
const { sendToAdmins, claimOnce } = require('../lib/pushSend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
function describeUa(ua) {
  ua = String(ua || '');
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '未知裝置';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return dev + (br ? '・' + br : '');
}
function where(req) {
  const c = req.headers['x-vercel-ip-country'] || '', city = req.headers['x-vercel-ip-city'] || '';
  let cityDec = city; try { cityDec = decodeURIComponent(city); } catch { /* 保持原樣 */ }
  return [cityDec, c].filter(Boolean).join(' ') || '位置不明';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const body = parseBody(req);
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  if (!pin) return res.status(400).json({ error: '請輸入密碼' });

  const ip = getClientIp(req);
  if (await isRateLimited(supabase, 'admin', ip)) return res.status(429).json({ error: '嘗試次數過多，請 15 分鐘後再試' });

  const [{ data: st, error: stErr }, { data: legacy, error: lgErr }] = await Promise.all([
    supabase.from('admin_security').select('*').eq('id', 1).maybeSingle(),
    supabase.from('settings').select('admin_pin').eq('id', 1).maybeSingle()
  ]);
  if (lgErr) { console.error('auth-admin lookup failed:', lgErr.message); return res.status(500).json({ error: '伺服器錯誤，請稍後再試' }); }
  if (stErr) console.error('admin_security lookup failed (fallback to legacy):', stErr.message);

  const fail = async (msg, status = 401) => {
    await recordAttempt(supabase, 'admin', ip, false);
    const n = await recentFailCount(supabase, 'admin', ip);
    if (n >= 5 && await claimOnce(supabase, 'adminfail:' + ip + ':' + Math.floor(Date.now() / 3600000))) {
      await sendToAdmins(supabase, { title: '⚠️ 有人嘗試登入主控失敗', body: '同一個網路位置 15 分鐘內失敗 ' + n + ' 次（' + where(req) + '）。如果不是你，請考慮更改密碼。', tag: 'admin-fail' });
    }
    return res.status(status).json({ error: msg });
  };

  // 1) 密碼
  let pinOk = false, legacyMigrate = false;
  if (st && st.pin_hash) pinOk = sec.verifyPinHash(pin, st.pin_hash);
  else if (legacy && legacy.admin_pin) { pinOk = sec.safeEqualStr(legacy.admin_pin, pin); legacyMigrate = pinOk; }
  if (!pinOk) return fail('密碼錯誤');

  // 2) 兩步驟驗證（有開啟才檢查）——這台裝置先前驗證過、還在信任期內的話，直接跳過，不用再輸入驗證碼
  let newLastStep = null, usedRecovery = null, trustedDevices = null, issueTrustToken = false;
  const trustToken = typeof body.trustToken === 'string' ? body.trustToken.trim() : '';
  if (st && st.totp_enabled && st.totp_secret) {
    const { matchIndex, list } = sec.matchTrustToken(trustToken, st.trusted_devices);
    trustedDevices = list; // 先把過期的濾掉，不管有沒有信任成功都要寫回去
    if (matchIndex >= 0) {
      list[matchIndex] = Object.assign({}, list[matchIndex], { exp: sec.trustExpiry() }); // 這台裝置今天又用了，續期 30 天
    } else {
      const code = typeof body.totp === 'string' ? body.totp.trim() : '';
      if (!code) return res.status(401).json({ error: '請輸入兩步驟驗證碼', needTotp: true });
      const step = sec.verifyTotp(st.totp_secret, code, st.totp_last_step);
      if (step != null) newLastStep = step;
      else {
        const h = sec.hashRecovery(code);
        if ((st.recovery_hashes || []).includes(h)) usedRecovery = h;
        else return fail('驗證碼錯誤', 401).then(r => r);
      }
      issueTrustToken = true; // 剛才是真的驗證碼（或復原碼）過的，發一組新的信任憑證給這台裝置
    }
  }

  // 3) 成功：登記、必要時把舊的明文密碼轉成雜湊
  await recordAttempt(supabase, 'admin', ip, true);
  const upd = {};
  if (newLastStep != null) upd.totp_last_step = newLastStep;
  if (usedRecovery) upd.recovery_hashes = (st.recovery_hashes || []).filter(x => x !== usedRecovery);
  let newTrustToken = null;
  if (trustedDevices) {
    if (issueTrustToken) {
      newTrustToken = sec.newTrustToken();
      trustedDevices = trustedDevices.concat([{ h: sec.hashTrustToken(newTrustToken), exp: sec.trustExpiry() }]).slice(-20);
    }
    upd.trusted_devices = trustedDevices;
  }
  const deviceHash = typeof body.deviceId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.deviceId) ? sec.sha256(body.deviceId) : null;
  const known = (st && st.known_devices) || [];
  const isNewDevice = !deviceHash || !known.includes(deviceHash);
  if (deviceHash && isNewDevice) upd.known_devices = [...known, deviceHash].slice(-20);
  if (legacyMigrate) { upd.pin_hash = sec.hashPin(pin); upd.pin_changed_at = new Date().toISOString(); }
  if (Object.keys(upd).length) {
    const row = Object.assign({ id: 1 }, upd);
    const { error: upErr } = await supabase.from('admin_security').upsert(row, { onConflict: 'id' });
    if (upErr) { console.error('admin_security update failed:', upErr.message); newTrustToken = null; } // 沒寫進去就不要發給前端一組假的信任憑證
    else if (legacyMigrate) await supabase.from('settings').update({ admin_pin: '' }).eq('id', 1); // 雜湊寫入成功才清掉明文
  }
  if (isNewDevice) {
    await sendToAdmins(supabase, { title: '主控有新裝置登入', body: describeUa(req.headers['user-agent']) + '・' + where(req) + '。如果不是你，請立刻更改密碼。', tag: 'admin-login' });
  }

  const token = jwt.sign({ role: 'app_admin' }, process.env.SUPABASE_JWT_SECRET, { expiresIn: '12h' });
  return res.status(200).json({ token, weakPin: pin.length < 8, totpEnabled: !!(st && st.totp_enabled), trustToken: newTrustToken || undefined });
};
