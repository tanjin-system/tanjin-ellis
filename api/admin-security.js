// 主控的登入安全設定（需要主控登入）：更改密碼、開啟／關閉兩步驟驗證、清除已知裝置。
//   POST ?op=status | set-pin | totp-begin | totp-confirm | totp-disable | clear-devices
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { getClientIp, isRateLimited, recordAttempt } = require('../lib/rateLimit');
const sec = require('../lib/adminSecurity');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
function isAdmin(req) {
  const h = String(req.headers.authorization || ''), tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return false;
  try { return jwt.verify(tok, process.env.SUPABASE_JWT_SECRET).role === 'app_admin'; } catch { return false; }
}
async function load() {
  const [{ data: st }, { data: lg }] = await Promise.all([
    supabase.from('admin_security').select('*').eq('id', 1).maybeSingle(),
    supabase.from('settings').select('admin_pin').eq('id', 1).maybeSingle()
  ]);
  return { st: st || null, legacyPin: lg && lg.admin_pin || '' };
}
function pinMatches(ctx, pin) {
  if (ctx.st && ctx.st.pin_hash) return sec.verifyPinHash(pin, ctx.st.pin_hash);
  return !!ctx.legacyPin && sec.safeEqualStr(ctx.legacyPin, pin);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!isAdmin(req)) return res.status(401).json({ error: '需要主控登入' });
  const op = String(req.query.op || ''), b = parseBody(req);
  try {
    const ctx = await load(), st = ctx.st;
    if (op === 'status') {
      return res.status(200).json({ pinHashed: !!(st && st.pin_hash), totpEnabled: !!(st && st.totp_enabled), recoveryLeft: st ? (st.recovery_hashes || []).length : 0, pinChangedAt: st ? st.pin_changed_at : null, knownDevices: st ? (st.known_devices || []).length : 0 });
    }
    // 以下操作都要再輸入一次目前密碼，並套用同一套失敗次數限制
    const ip = getClientIp(req);
    if (await isRateLimited(supabase, 'admin', ip)) return res.status(429).json({ error: '嘗試次數過多，請 15 分鐘後再試' });
    const needPin = async () => {
      if (pinMatches(ctx, String(b.current || '').trim())) return true;
      await recordAttempt(supabase, 'admin', ip, false); return false;
    };
    if (op === 'set-pin') {
      const next = String(b.next || '').trim();
      if (!(await needPin())) return res.status(401).json({ error: '目前密碼錯誤' });
      if (next.length < 8) return res.status(400).json({ error: '新密碼至少 8 個字元（建議用一句好記的長句子）' });
      if (/^(.)\1+$/.test(next) || /^(0123|1234|12345678|password|abcdefgh)/i.test(next)) return res.status(400).json({ error: '這個密碼太好猜，請換一個' });
      const { error } = await supabase.from('admin_security').upsert({ id: 1, pin_hash: sec.hashPin(next), pin_changed_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
      await supabase.from('settings').update({ admin_pin: '' }).eq('id', 1);
      return res.status(200).json({ ok: true });
    }
    if (op === 'totp-begin') {
      if (st && st.totp_enabled) return res.status(400).json({ error: '兩步驟驗證已經開啟' });
      const secret = sec.newTotpSecret();
      const { error } = await supabase.from('admin_security').upsert({ id: 1, totp_pending: secret }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
      return res.status(200).json({ secret, uri: sec.otpauthUri(secret, '主控') });
    }
    if (op === 'totp-confirm') {
      if (!st || !st.totp_pending) return res.status(400).json({ error: '請先按「開啟兩步驟驗證」取得設定金鑰' });
      const step = sec.verifyTotp(st.totp_pending, b.code, null);
      if (step == null) { await recordAttempt(supabase, 'admin', ip, false); return res.status(401).json({ error: '驗證碼不對，請確認驗證器顯示的數字（每 30 秒會換）' }); }
      const codes = sec.newRecoveryCodes(8);
      const { error } = await supabase.from('admin_security').upsert({ id: 1, totp_secret: st.totp_pending, totp_pending: null, totp_enabled: true, totp_last_step: step, recovery_hashes: codes.map(sec.hashRecovery) }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
      return res.status(200).json({ ok: true, recoveryCodes: codes });
    }
    if (op === 'totp-disable') {
      if (!st || !st.totp_enabled) return res.status(400).json({ error: '兩步驟驗證目前沒有開啟' });
      if (!(await needPin())) return res.status(401).json({ error: '目前密碼錯誤' });
      const step = sec.verifyTotp(st.totp_secret, b.code, st.totp_last_step);
      const rec = step == null && (st.recovery_hashes || []).includes(sec.hashRecovery(b.code));
      if (step == null && !rec) { await recordAttempt(supabase, 'admin', ip, false); return res.status(401).json({ error: '驗證碼錯誤' }); }
      const { error } = await supabase.from('admin_security').update({ totp_enabled: false, totp_secret: null, totp_pending: null, recovery_hashes: [], totp_last_step: null }).eq('id', 1);
      if (error) throw new Error(error.message);
      return res.status(200).json({ ok: true });
    }
    if (op === 'clear-devices') {
      if (!(await needPin())) return res.status(401).json({ error: '目前密碼錯誤' });
      await supabase.from('admin_security').upsert({ id: 1, known_devices: [] }, { onConflict: 'id' });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Bad request' });
  } catch (e) {
    console.error('admin-security failed:', e.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
};
