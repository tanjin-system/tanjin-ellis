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

  const { pin } = parseBody(req);
  if (!pin || typeof pin !== 'string' || !pin.trim()) return res.status(400).json({ error: '請輸入PIN碼' });

  const ip = getClientIp(req);
  if (await isRateLimited(supabase, 'admin', ip)) {
    return res.status(429).json({ error: '嘗試次數過多，請 15 分鐘後再試' });
  }

  const { data: settings, error } = await supabase
    .from('settings')
    .select('admin_pin')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    console.error('auth-admin lookup failed:', error.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }

  if (!settings || settings.admin_pin !== pin.trim()) {
    await recordAttempt(supabase, 'admin', ip, false);
    return res.status(401).json({ error: 'PIN碼錯誤' });
  }

  await recordAttempt(supabase, 'admin', ip, true);

  const token = jwt.sign(
    { role: 'app_admin' },
   'tanjin_secret_key_2026',
    { expiresIn: '12h' }
  );

  return res.status(200).json({ token });
};
