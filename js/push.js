// ---------- 推播通知（Web Push）前端 ----------
// 夥伴／主控在「通知設定」按「開啟通知」（夥伴開啟後不能挑類別、也不能在系統裡關閉；主控可以）→ 註冊 /sw.js、向瀏覽器訂閱推播、把訂閱存進 push_subscriptions（RLS：夥伴只看得到自己的）。
// 主控的操作（發佈、換人、取消、公告）會呼叫 pushQueueTasks()／pushAnnouncement()，4 秒內的合併成「每位夥伴一則」，
// 再由 /api/push?op=send 送出。前一天提醒與月底對帳由伺服器排程送（見 api/push.js）。
const PUSH_KINDS_PARTNER = [['publish', '新任務'], ['change', '任務調整（換人、取消）'], ['announce', '公告'], ['reminder', '前一天提醒（隔天有任務）'], ['statement', '月底對帳']];
const PUSH_KINDS_ADMIN = [['statement', '月底對帳提醒']];

function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function pushIsIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function pushIsStandalone() { return !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); }
function pushB64ToU8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function pushCurrentSub() {
  if (!pushSupported()) return null;
  try { const reg = await navigator.serviceWorker.getRegistration(); return reg ? await reg.pushManager.getSubscription() : null; } catch (e) { return null; }
}
async function pushLoadPrefs(endpoint) {
  const { data } = await getSupabase().from('push_subscriptions').select('prefs').eq('endpoint', endpoint).maybeSingle();
  return (data && data.prefs) || {};
}
async function pushEnable() {
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知權限沒有開啟。請在跳出的視窗按「允許」，或到手機的設定裡開啟這個 App 的通知。');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const kr = await fetch('/api/push?op=key');
  if (!kr.ok) throw new Error('取得通知金鑰失敗，請稍後再試。');
  const { publicKey } = await kr.json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushB64ToU8(publicKey) });
  await pushRegister(sub);
}
// 把這支手機登記給「現在登入的人」（伺服器以 JWT 為準；同一支手機換人登入會改登記）
async function pushRegister(sub) {
  const j = sub.toJSON();
  await pushApi('subscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent });
}
// 已經允許通知、手機也有訂閱的情況下，每次登入悄悄把這支手機登記給現在的人（不用再按一次；也修復資料庫登記遺失或登記給別人的情況）
async function pushAutoSync() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted' || state.adminViewDriver || !(state.role === 'admin' || state.role === 'driver')) return;
    const sub = await pushCurrentSub();
    if (sub) await pushRegister(sub);
  } catch (e) { /* 悄悄失敗，使用者開設定頁會看到真實狀態 */ }
}
async function pushDisable() {
  const sub = await pushCurrentSub();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch (e) {}
  await getSupabase().from('push_subscriptions').delete().eq('endpoint', endpoint);
}
async function pushSavePrefs(endpoint, prefs) {
  const { error } = await getSupabase().from('push_subscriptions').update({ prefs, updated_at: new Date().toISOString() }).eq('endpoint', endpoint);
  if (error) throw new Error('儲存失敗：' + error.message);
}
async function pushApi(op, body) {
  const auth = getStoredAuth();
  const r = await fetch('/api/push?op=' + op, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (auth ? auth.token : '') }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error('通知服務暫時無法使用（' + r.status + '）');
  return r.json();
}

// 通知設定面板（夥伴的「我的資料」、主控的「系統設定」共用）
async function pushRenderBox(el) {
  if (!el) return;
  const kinds = state.role === 'admin' ? PUSH_KINDS_ADMIN : PUSH_KINDS_PARTNER;
  const msg = t => { el.innerHTML = '<p class="section-sub" style="margin:0;">' + t + '</p>'; };
  if (state.adminViewDriver) return msg('主控檢視夥伴畫面時不能開啟通知，請用夥伴自己的手機設定。');
  if (!pushSupported()) {
    return msg(pushIsIOS() && !pushIsStandalone()
      ? 'iPhone 要先把系統「加入主畫面」（Safari 的分享 → 加入主畫面），再從主畫面的圖示打開，才能開啟通知。'
      : '這個瀏覽器不支援推播通知。');
  }
  if (pushIsIOS() && !pushIsStandalone()) return msg('iPhone 要先把系統「加入主畫面」（Safari 的分享 → 加入主畫面），再從主畫面的圖示打開，才能開啟通知。');
  const sub = await pushCurrentSub();
  if (Notification.permission === 'denied') return msg('通知被關閉了。請到手機的「設定 → 通知」找到這個 App，把通知打開，再回到這裡。');
  if (!sub) {
    el.innerHTML = '<p class="section-sub" style="margin:0 0 10px;">' + (state.role === 'admin' ? '開啟後，這支手機會收到月底對帳提醒。' : '開啟後，新任務、任務調整、公告、前一天提醒和月底對帳會直接跳到手機上，螢幕關著也收得到。') + '</p><button class="btn amber" id="pushOn">開啟通知</button>';
    document.getElementById('pushOn').onclick = async ev => {
      ev.target.disabled = true;
      try { await pushEnable(); toast('已開啟通知'); } catch (e) { alert(e.message); }
      pushRenderBox(el);
    };
    return;
  }
  // 以資料庫的登記為準（手機本身有訂閱，不代表登記給現在登入的這個人）
  let st = { registered: false, prefs: {} };
  try { st = await pushApi('status', { endpoint: sub.endpoint }); } catch (e) { return msg('目前無法確認通知狀態，請稍後再試。'); }
  if (!st.registered) {
    el.innerHTML = '<p class="section-sub" style="margin:0 0 10px;">這支手機還沒有登記給你，按下去就會開始收到通知。</p><button class="btn amber" id="pushOn">開啟通知</button>';
    document.getElementById('pushOn').onclick = async ev => {
      ev.target.disabled = true;
      try { await pushEnable(); toast('已開啟通知'); } catch (e) { alert(e.message); }
      pushRenderBox(el);
    };
    return;
  }
  // 夥伴：不能挑類別、也不能在系統裡關閉——公司的任務通知一律都收（只能在手機自己的設定裡關掉系統通知）。
  if (state.role !== 'admin') {
    el.innerHTML = '<p class="section-sub" style="margin:0 0 8px;">這支手機已開啟通知，會收到：新任務、任務調整（換人、取消）、公告、前一天提醒、月底對帳。</p>'
      + '<button class="btn ghost" id="pushTest">傳一則測試通知</button>';
    document.getElementById('pushTest').onclick = async ev => {
      ev.target.disabled = true;
      try { const r = await pushApi('test', {}); toast(r.sent ? '已送出測試通知，幾秒內會收到' : '沒有送出（這支手機的通知可能已失效，請聯絡主控）'); } catch (e) { alert(e.message); }
      ev.target.disabled = false;
    };
    return;
  }
  // 主控：可以選要收哪些、勿擾時段、關閉
  let prefs = st.prefs || {};
  const on = k => prefs[k] !== false;
  el.innerHTML = '<p class="section-sub" style="margin:0 0 8px;">這支手機已開啟通知。想收哪些，自己決定：</p>'
    + kinds.map(([k, label]) => `<label style="display:flex; align-items:center; gap:8px; padding:7px 0; font-size:14px;"><input type="checkbox" data-pk="${k}" ${on(k) ? 'checked' : ''} style="width:auto; flex:none; margin:0;"> ${label}</label>`).join('')
    + `<label style="display:flex; align-items:center; gap:8px; padding:7px 0; font-size:14px;"><input type="checkbox" id="pushQuiet" ${prefs.quiet ? 'checked' : ''} style="width:auto; flex:none; margin:0;"> 勿擾時段（晚上 10 點到早上 6 點不通知）</label>`
    + '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;"><button class="btn ghost" id="pushTest">傳一則測試通知</button><button class="btn ghost" id="pushOff">關閉這支手機的通知</button></div>';
  const save = async () => {
    const next = {};
    el.querySelectorAll('[data-pk]').forEach(c => { if (!c.checked) next[c.dataset.pk] = false; });
    if (document.getElementById('pushQuiet').checked) next.quiet = true;
    prefs = next;
    try { await pushSavePrefs(sub.endpoint, next); } catch (e) { alert(e.message); }
  };
  el.querySelectorAll('input[type=checkbox]').forEach(c => { c.onchange = save; });
  document.getElementById('pushTest').onclick = async ev => {
    ev.target.disabled = true;
    try { const r = await pushApi('test', {}); toast(r.sent ? '已送出測試通知，幾秒內會收到' : '沒有送出（可能這支手機的訂閱已失效，請關閉後重新開啟）'); } catch (e) { alert(e.message); }
    ev.target.disabled = false;
  };
  document.getElementById('pushOff').onclick = async () => {
    if (!confirm('關閉後這支手機不會再收到通知，確定嗎？')) return;
    try { await pushDisable(); } catch (e) { alert(e.message); }
    pushRenderBox(el);
  };
}

// ---------- 主控操作 → 推播 ----------
let _pushQ = [], _pushTimer = null;
function pushQueueTasks(kind, list, opts) {
  if (state.role !== 'admin' || state.adminViewDriver) return;
  const today = todayStr(), force = opts && opts.force;
  (list || []).forEach(a => {
    if (!a || a.isSupport) return;
    const driverId = (opts && opts.driverId) || a.driverId;
    if (!driverId || a.date < today || a.status === 'completed') return;
    if (a.published === false && !force) return; // 草稿夥伴看不到，不通知
    _pushQ.push({ kind, driverId, date: a.date, routeId: a.routeId });
  });
  clearTimeout(_pushTimer); _pushTimer = setTimeout(pushFlush, 4000);
}
function pushFmtDates(dates) {
  const u = [...new Set(dates)].sort(), lab = d => { const x = new Date(d + 'T00:00:00'); return (x.getMonth() + 1) + '/' + x.getDate() + '（週' + '日一二三四五六'[x.getDay()] + '）'; };
  const segs = [];
  u.forEach(d => { const last = segs[segs.length - 1]; if (last && Math.round((new Date(d + 'T00:00:00') - new Date(last[last.length - 1] + 'T00:00:00')) / 86400000) === 1) last.push(d); else segs.push([d]); });
  return { text: segs.map(s => s.length > 1 ? lab(s[0]) + '到' + lab(s[s.length - 1]) : lab(s[0])).join('、'), days: u.length };
}
function pushFmtRoutes(ids) {
  const names = [...new Set(ids.map(id => routeName(id)))];
  return names.slice(0, 3).join('、') + (names.length > 3 ? ' 等 ' + names.length + ' 條' : '');
}
async function pushFlush() {
  const q = _pushQ; _pushQ = [];
  if (!q.length) return;
  const groups = new Map();
  q.forEach(e => { const k = e.kind + '|' + e.driverId; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
  const messages = [];
  groups.forEach((es, k) => {
    const kind = es[0].kind, driverId = es[0].driverId;
    const dt = pushFmtDates(es.map(e => e.date)), rt = pushFmtRoutes(es.map(e => e.routeId));
    if (kind === 'publish') messages.push({ to: { driverId }, kind: 'publish', url: '/?go=today', title: dt.days > 1 ? '新任務（' + dt.days + ' 天）' : '新任務', body: dt.text + '\n' + rt });
    else messages.push({ to: { driverId }, kind: 'change', url: '/?go=today', title: '任務有調整', body: dt.text + ' ' + rt + (kind === 'removed' ? ' 不用跑了（已改由其他夥伴負責）' : ' 已取消') });
  });
  try { await pushApi('send', { messages }); } catch (e) { console.error('推播送出失敗', e); }
}
async function pushAnnouncement(title, audience, driverIds) {
  if (state.role !== 'admin') return;
  const base = { kind: 'announce', url: '/?go=home', title: '公告', body: title };
  const messages = audience === 'selected' ? (driverIds || []).map(id => Object.assign({ to: { driverId: id } }, base)) : [Object.assign({ to: { all: true } }, base)];
  try { await pushApi('send', { messages }); } catch (e) { console.error('公告推播失敗', e); }
}
