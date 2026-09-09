const WINDOW_MINUTES = 15;
const MAX_FAILS = 10;

function getClientIp(req) {
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

module.exports = { getClientIp, isRateLimited, recordAttempt, WINDOW_MINUTES, MAX_FAILS };
