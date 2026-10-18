const WINDOW_MINUTES = 15;
const MAX_FAILS = 10;

function getClientIp(req) {
  // Vercel 自己填的真實來源 IP（客戶端偽造不了）；沒有才退回一般標頭
  const vff = req.headers['x-vercel-forwarded-for'];
  if (vff) return vff.split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function isRateLimited(supabase, scope, ip) {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();
  const { count, error } = await supabase
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('scope', scope)
    .eq('ip', ip)
    .eq('success', false)
    .gte('created_at', since);
  if (error) {
    console.error('rate limit check failed, failing open:', error.message);
    return false;
  }
  return (count || 0) >= MAX_FAILS;
}

async function recordAttempt(supabase, scope, ip, success) {
  const { error } = await supabase.from('login_attempts').insert({ scope, ip, success });
  if (error) console.error('failed to record login attempt:', error.message);
}

// 近 15 分鐘某個身份的失敗次數（ip 不給就是全部 IP 合計）：用來偵測分散式猜測
async function recentFailCount(supabase, scope, ip) {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();
  let q = supabase.from('login_attempts').select('id', { count: 'exact', head: true }).eq('scope', scope).eq('success', false).gte('created_at', since);
  if (ip) q = q.eq('ip', ip);
  const { count } = await q;
  return count || 0;
}

module.exports = { getClientIp, isRateLimited, recordAttempt, recentFailCount, WINDOW_MINUTES, MAX_FAILS };
