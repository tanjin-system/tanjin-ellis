// 推播通知（Web Push）。四個動作（用 ?op= 區分，合成一支函式以節省免費方案的函式數量）：
//   GET  ?op=key   → 回傳 VAPID 公鑰（第一次用到時自動產生一組金鑰存在 settings，私鑰只有伺服器讀得到）。
//   POST ?op=send  → 主控發送：body { messages:[{ to:{driverId}|{all:true}|{admin:true}, kind, title, body, url, tag }] }，
//                    驗證主控的 JWT 後依對象查出訂閱並送出；失效的訂閱（404/410）順手刪除。
//   POST ?op=subscribe → 夥伴或主控登記「這支手機」：以登入身份（JWT）為準，同一支手機換人登入會改登記給新的人
//                    （例如主控用自己的手機測試夥伴帳號），換人時偏好設定重置。
//   POST ?op=status    → 這支手機目前是不是登記給「現在登入的這個人」（畫面用這個判斷，不能只看手機本身有沒有訂閱）。
//   POST ?op=test  → 夥伴或主控傳一則測試通知給「自己」。
//   GET  ?op=cron  → 每天一次的排程（vercel.json）：前一天提醒隔天有任務的夥伴；月底最後一天提醒對帳；超過 7 天沒備份提醒主控；
//                    小碳的財務異常提醒主控（已完成卻沒報酬的趟次、勞報單即將/已經逾期未簽名）。
//                    用 push_log 去重（同一天只會發一次），且 16 點以前不動作，所以就算網址被別人呼叫也不會重複打擾。
// 通知內容只放路線與日期，不放店名、金額、電話（會顯示在鎖定畫面上）。
const webpush = require('web-push');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const KINDS = ['publish', 'change', 'announce', 'reminder', 'statement', 'audit'];
const WD = ['日', '一', '二', '三', '四', '五', '六'];

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
function taipeiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function ymdOf(d) { return d.toISOString().slice(0, 10); }
function addDaysTpe(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }

async function getVapid() {
  let { data } = await supabase.from('settings').select('vapid_public, vapid_private').eq('id', 1).maybeSingle();
  if (data && data.vapid_public && data.vapid_private) return data;
  const keys = webpush.generateVAPIDKeys();
  // 只在還沒有金鑰時寫入（兩個請求同時第一次進來時，只有一個會成功，另一個重新讀取）
  await supabase.from('settings').update({ vapid_public: keys.publicKey, vapid_private: keys.privateKey }).eq('id', 1).is('vapid_public', null);
  ({ data } = await supabase.from('settings').select('vapid_public, vapid_private').eq('id', 1).maybeSingle());
  if (!data || !data.vapid_public) throw new Error('VAPID 金鑰建立失敗');
  return data;
}
async function initPush() {
  const v = await getVapid();
  webpush.setVapidDetails('https://xinxing-tanjin.vercel.app', v.vapid_public, v.vapid_private);
  return v;
}
function authOf(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  try { return jwt.verify(tok, process.env.SUPABASE_JWT_SECRET); } catch { return null; }
}
function inQuiet(prefs) {
  if (!prefs || !prefs.quiet) return false;
  const h = taipeiNow().getUTCHours();
  return h >= 22 || h < 6;
}
async function subsFor(to) {
  let q = supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth, prefs, driver_id, is_admin');
  if (to && to.driverId) q = q.eq('driver_id', to.driverId).eq('is_admin', false);
  else if (to && to.all) q = q.eq('is_admin', false);
  else if (to && to.admin) q = q.eq('is_admin', true);
  else return [];
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}
async function deliver(sub, msg) {
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || '/', tag: msg.tag || undefined });
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 12 * 3600, urgency: 'high' });
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) await supabase.from('push_subscriptions').delete().eq('id', sub.id);
    else console.error('push send failed:', e && (e.statusCode || e.message));
    return false;
  }
}
async function sendMessages(messages) {
  let sent = 0, skipped = 0;
  for (const m of messages) {
    const subs = await subsFor(m.to);
    for (const s of subs) {
      const prefs = s.is_admin ? (s.prefs || {}) : {}; // 夥伴的開關與勿擾一律不採用：公司任務通知全部都收；只有主控的手機可以自己選
      // 測試通知（kind 不在清單內）一律送，不看個別開關與勿擾時段，方便確認「這支手機收得到」
      const isKind = KINDS.includes(m.kind);
      if (isKind && (prefs[m.kind] === false || inQuiet(prefs))) { skipped++; continue; }
      if (await deliver(s, m)) sent++;
    }
  }
  return { sent, skipped };
}
function routeShort(name) {
  const n = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return String(name || '').replace(/第([一二三四五六七八九十]+)車/g, (m, c) => (n[c] ? 'R' + n[c] : m)).replace(/\s+/g, '');
}
async function claim(key) {
  const { error } = await supabase.from('push_log').insert({ key });
  return !error; // 已經有同一個 key（唯一鍵衝突）就代表今天發過了
}

async function runCron() {
  const now = taipeiNow(), hour = now.getUTCHours();
  if (hour < 16) return { skipped: 'too early' };
  const today = ymdOf(now), tomorrowD = addDaysTpe(now, 1), tomorrow = ymdOf(tomorrowD);
  const out = {};
  // 1) 前一天提醒
  if (await claim('reminder:' + today)) {
    const { data: rows, error } = await supabase.from('assignments')
      .select('driver_id, route_id, routes(name)').eq('trip_date', tomorrow).eq('published', true).neq('status', 'cancelled');
    if (error) throw new Error(error.message);
    const by = new Map();
    (rows || []).forEach(r => { if (!r.driver_id) return; const a = by.get(r.driver_id) || []; a.push(routeShort(r.routes && r.routes.name)); by.set(r.driver_id, a); });
    const wd = '週' + WD[tomorrowD.getUTCDay()], md = (tomorrowD.getUTCMonth() + 1) + '/' + tomorrowD.getUTCDate();
    const msgs = [...by.entries()].map(([driverId, names]) => ({
      to: { driverId }, kind: 'reminder', tag: 'reminder-' + tomorrow, url: '/?go=today',
      title: '明天（' + md + ' ' + wd + '）有 ' + names.length + ' 趟',
      body: names.slice(0, 4).join('、') + (names.length > 4 ? ' 等 ' + names.length + ' 趟' : '')
    }));
    out.reminder = await sendMessages(msgs);
    out.reminder.drivers = by.size;
  }
  // 2) 月底對帳（明天是 1 號＝今天是本月最後一天）
  if (tomorrowD.getUTCDate() === 1 && await claim('statement:' + today.slice(0, 7))) {
    const month = now.getUTCMonth() + 1;
    out.statement = await sendMessages([
      { to: { all: true }, kind: 'statement', tag: 'statement-' + today.slice(0, 7), url: '/?go=my-earnings', title: '月底對帳', body: month + ' 月結束了，請到「我的報酬」確認本月任務與報酬是否正確' },
      { to: { admin: true }, kind: 'statement', tag: 'statement-admin-' + today.slice(0, 7), url: '/?go=slips', title: '月底對帳', body: month + ' 月結束了，記得進行月結：報酬結算與勞報單' }
    ]);
  }
  // 3) 備份提醒：超過 7 天沒下載完整備份（或從來沒有），每兩天提醒主控一次，直到備份為止
  {
    const { data: st } = await supabase.from('settings').select('last_backup_at').eq('id', 1).maybeSingle();
    const last = st && st.last_backup_at ? new Date(st.last_backup_at).getTime() : null;
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    const bucket = Math.floor(Date.now() / (2 * 86400000));
    if ((days === null || days >= 7) && await claim('backup:' + bucket)) {
      out.backup = await sendMessages([{ to: { admin: true }, kind: 'backup', tag: 'backup-reminder', url: '/?go=settings',
        title: '該備份資料了', body: (days === null ? '還沒有備份紀錄' : '已經 ' + days + ' 天沒有備份') + '，請到「系統設定」下載完整備份。' }]);
    }
  }
  // 4) 小碳的財務異常主動推播（2026-10-30，使用者要求主控不用自己天天上系統查）：
  //    只做2條邏輯最單純、風險最低的規則（跟前端「小碳任務」財務稽核畫面裡4條規則
  //    其中的2條同一套算法，但刻意不搬「已完成卻沒有跟任何通路請款」那條過來——那條
  //    需要effectiveByChannelForAssignment()整串billing_adjustments/路線版本費率/
  //    tripBilling()試算的複雜串接邏輯，在這支獨立的伺服器端函式裡重寫一份風險太高，
  //    容易跟前端算法兜不起來、吃力不討好；真正要查完整異常還是要去「小碳任務」看）。
  if (await claim('audit:' + today)) {
    const monthStart = today.slice(0, 7) + '-01';
    const { data: tripRows, error: tripErr } = await supabase.from('assignments')
      .select('published, fare, payroll_fare_snapshot, extra_pay')
      .eq('status', 'completed').gte('trip_date', monthStart).lte('trip_date', today);
    if (tripErr) throw new Error(tripErr.message);
    const noPay = (tripRows || []).filter(a => a.published !== false &&
      ((Number(a.payroll_fare_snapshot ?? a.fare) || 0) + (Number(a.extra_pay) || 0)) <= 0).length;

    const { data: stRows, error: stErr } = await supabase.from('statements')
      .select('period_end').eq('status', 'awaiting_signature').not('period_end', 'is', null);
    if (stErr) throw new Error(stErr.message);
    const todayD = new Date(today + 'T00:00:00');
    let dueSoon = 0, overdue = 0;
    (stRows || []).forEach(s => {
      const days = Math.floor((todayD - new Date(s.period_end + 'T00:00:00')) / 86400000);
      if (days >= 14) overdue++; else if (days >= 10) dueSoon++;
    });

    const parts = [];
    if (noPay) parts.push(noPay + '趟已完成卻沒有報酬');
    if (overdue) parts.push(overdue + '份勞報單已超過2週未簽名');
    if (dueSoon) parts.push(dueSoon + '份勞報單即將到期（4天內）');
    if (parts.length) {
      out.audit = await sendMessages([{ to: { admin: true }, kind: 'audit', tag: 'audit-' + today, url: '/?go=carbon_inbox',
        title: '小碳的異常提醒', body: parts.join('、') + '，詳細內容請到「小碳任務」查看。' }]);
    }
  }
  return out;
}

module.exports = async (req, res) => {
  const op = String(req.query.op || '');
  try {
    if (op === 'key' && req.method === 'GET') {
      const v = await initPush();
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).json({ publicKey: v.vapid_public });
    }
    if (op === 'cron' && req.method === 'GET') {
      await initPush();
      return res.status(200).json(await runCron());
    }
    if (op === 'send' && req.method === 'POST') {
      const claims = authOf(req);
      if (!claims || claims.role !== 'app_admin') return res.status(401).json({ error: '需要主控登入' });
      await initPush();
      const messages = (parseBody(req).messages || []).slice(0, 200);
      return res.status(200).json(await sendMessages(messages));
    }
    if ((op === 'subscribe' || op === 'status') && req.method === 'POST') {
      const claims = authOf(req);
      if (!claims || (claims.role !== 'app_admin' && !(claims.role === 'app_driver' && claims.driver_id))) return res.status(401).json({ error: '請先登入' });
      const b = parseBody(req), endpoint = String(b.endpoint || '');
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return res.status(400).json({ error: 'Bad endpoint' });
      const owner = claims.role === 'app_admin' ? { driver_id: null, is_admin: true } : { driver_id: claims.driver_id, is_admin: false };
      const { data: ex, error: exErr } = await supabase.from('push_subscriptions').select('id, driver_id, is_admin, prefs').eq('endpoint', endpoint).maybeSingle();
      if (exErr) throw new Error(exErr.message);
      const same = !!ex && ex.is_admin === owner.is_admin && ex.driver_id === owner.driver_id;
      if (op === 'status') return res.status(200).json({ registered: same, prefs: same ? (ex.prefs || {}) : {} });
      const keys = { p256dh: String(b.p256dh || ''), auth: String(b.auth || '') };
      if (!keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Bad keys' });
      const row = Object.assign({}, owner, keys, { user_agent: String(b.ua || '').slice(0, 200), updated_at: new Date().toISOString() });
      if (ex) { if (!same) row.prefs = {}; const { error } = await supabase.from('push_subscriptions').update(row).eq('id', ex.id); if (error) throw new Error(error.message); }
      else { const { error } = await supabase.from('push_subscriptions').insert(Object.assign({ endpoint }, row)); if (error) throw new Error(error.message); }
      return res.status(200).json({ ok: true, changedOwner: !!ex && !same });
    }
    if (op === 'test' && req.method === 'POST') {
      const claims = authOf(req);
      if (!claims) return res.status(401).json({ error: '請先登入' });
      await initPush();
      const to = claims.role === 'app_admin' ? { admin: true } : { driverId: claims.driver_id };
      const r = await sendMessages([{ to, kind: 'test', title: '測試通知', body: '收到這則就代表通知設定成功', url: '/', tag: 'test' }]);
      return res.status(200).json(r);
    }
    return res.status(400).json({ error: 'Bad request' });
  } catch (e) {
    console.error('push api failed:', e.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
};
