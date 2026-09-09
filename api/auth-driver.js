const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { getClientIp, isRateLimited, recordAttempt } = require('../lib/rateLimit');

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
    return res.status(401).json({ error: '代碼錯誤或帳號已停用' });
  }

  await recordAttempt(supabase, 'driver', ip, true);

  const token = jwt.sign(
    { role: 'app_driver', driver_id: driver.id },
    'tanjin_secret_key_2026'
    { expiresIn: '30d' }
  );

  return res.status(200).json({ token, driver: { id: driver.id, name: driver.name } });
};
