// 伺服器端推播給「主控」的手機（登入通知、疑似暴力破解警示）。沒有 VAPID 金鑰或沒有主控訂閱時靜默略過，不影響登入。
const webpush = require('web-push');

async function sendToAdmins(supabase, msg) {
  try {
    const { data: v } = await supabase.from('settings').select('vapid_public, vapid_private').eq('id', 1).maybeSingle();
    if (!v || !v.vapid_public || !v.vapid_private) return 0;
    webpush.setVapidDetails('https://xinxing-tanjin.vercel.app', v.vapid_public, v.vapid_private);
    const { data: subs } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('is_admin', true);
    let sent = 0;
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || '/?go=settings', tag: msg.tag });
    for (const s of subs || []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: 'high' }); sent++; }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await supabase.from('push_subscriptions').delete().eq('id', s.id); }
    }
    return sent;
  } catch (e) { console.error('sendToAdmins failed:', e.message); return 0; }
}
// 同一個 key 只做一次（用 push_log 的唯一鍵去重），回傳是否搶到
async function claimOnce(supabase, key) {
  const { error } = await supabase.from('push_log').insert({ key });
  return !error;
}
module.exports = { sendToAdmins, claimOnce };
