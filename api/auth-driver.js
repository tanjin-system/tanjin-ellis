const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { getClientIp, isRateLimited, recordAttempt, recentFailCount } = require('../lib/rateLimit');
const { sendToAdmins, claimOnce } = require('../lib/pushSend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { code } = parseBody(req);
  if (!code || typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: '請輸入登入代碼' });

  const ip = getClientIp(req);
  if (await isRateLimited(supabase, 'driver', ip)) {
    return res.status(429).json({ error: '嘗試次數過多，請 15 分鐘後再試' });
  }

  const { data: driver, error } = await supabase
    .from('drivers')
    .select('id, name, status')
    .eq('access_code', code.trim())
    .maybeSingle();

  if (error) {
    console.error('auth-driver lookup failed:', error.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }

  if (!driver || driver.status !== 'active') {
    await recordAttempt(supabase, 'driver', ip, false);
    // 偵測分散式猜測：全部網路位置合計 15 分鐘失敗太多次，每小時最多推播主控一次（只警示，不鎖定，避免被拿來癱瘓夥伴登入）
    const total = await recentFailCount(supabase, 'driver', null);
    if (total >= 30 && await claimOnce(supabase, 'driverbf:' + Math.floor(Date.now() / 3600000))) {
      await sendToAdmins(supabase, { title: '⚠️ 夥伴登入異常失敗偏多', body: '15 分鐘內夥伴登入失敗 ' + total + ' 次，可能有人在猜登入代碼。', tag: 'driver-bf' });
    }
    return res.status(401).json({ error: '代碼錯誤或帳號已停用' });
  }

  await recordAttempt(supabase, 'driver', ip, true);

  // 代碼太短（舊版 4 碼）：登入後強制要求夥伴設定 6 碼以上的新代碼（沿用既有的「首次設定專屬代碼」畫面）
  const weak = code.trim().length < 6;
  if (weak) await supabase.from('drivers').update({ force_code_reset: true }).eq('id', driver.id);

  const token = jwt.sign(
    { role: 'app_driver', driver_id: driver.id },
    process.env.SUPABASE_JWT_SECRET,
    { expiresIn: '14d' }
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ token, driver: { id: driver.id, name: driver.name }, mustChangeCode: weak });
};
