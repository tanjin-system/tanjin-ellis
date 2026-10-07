// 建立 Supabase client；每個請求都帶上登入時拿到的自訂 JWT（見 auth.js），
// PostgREST 會依 JWT 的 role claim 自動切換成 app_admin / app_driver 身份。
//
// anon key 本來就是設計給前端公開使用的值（沒有它 RLS 什麼都做不了），
// 部署前把下面兩個值換成你 Supabase 專案 API 頁面顯示的 Project URL / anon public key。
// 因為這個專案刻意不做建置步驟（維持demo原本單檔可直接打開的風格），沒有.env注入機制，
// 所以是直接寫死在這個檔案裡，不是機密值，可以安心提交進版本控制。
const SUPABASE_URL = 'https://rcdvclfvqnrvffxkseqh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3C3Hr1JnvIHLjGR-zBN7HQ_zckQECJ4';

let supabaseClient = null;

function getSupabase() {
  const token = localStorage.getItem('fleet_auth_token');
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : {}
  });
  return supabaseClient;
}

// Realtime 需要一條「常駐」的 WebSocket 連線，不能像 getSupabase() 那樣每次查詢
// 都重新建立一個新的 client（那樣會一直開新連線、舊的變成孤兒）。這裡刻意另外
// 維護一個獨立的 realtimeClient，整個登入session只建立一次。
// setAuth() 把跟一般REST查詢同一組自訂JWT交給Realtime，讓它判斷「這個連線可以
// 收到哪些異動」時，套用的是跟REST查詢一模一樣的RLS規則（夥伴只收得到自己的
// 車趟/店點異動，主控收得到全部）——這件事已經實際用兩個不同夥伴的真實帳號
// 測過雙向隔離，包含 assignment_drop_points 這種帶子查詢的RLS規則，確認沒有
// 外洩風險，才接上這段。
let realtimeClient = null;
let realtimeChannel = null;

// 一段時間內可能連續收到好幾筆異動（例如夥伴連續點好幾個店點完成），
// debounce 讓短時間內的一串事件只觸發一次畫面刷新，不會一筆一筆刷。
function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// onEvent(payload)：每一筆資料異動各呼叫一次（payload.table / eventType / new / old），
// 由呼叫端自己合併、只抓有變的那幾筆，不再「整段任務重抓」。
// 訂閱的表：任務、店點（任務明細）、勞報單（簽名）、調整項、代墊申報——RLS 照樣套用，
// 夥伴只收得到自己的、主控收得到全部。
async function startRealtimeSync(onEvent) {
  const token = localStorage.getItem('fleet_auth_token');
  if (!token || realtimeClient) return; // 沒登入，或已經在跑了（不重複訂閱）
  try {
    realtimeClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    await realtimeClient.realtime.setAuth(token);
    let ch = realtimeClient.channel('live-sync');
    ['assignments', 'assignment_drop_points', 'statements', 'adjustments', 'fuel_claims'].forEach(table => {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, payload => onEvent({
        table, eventType: payload.eventType, new: payload.new || {}, old: payload.old || {}
      }));
    });
    realtimeChannel = ch.subscribe();
  } catch (e) {
    console.error('Realtime 訂閱失敗，將繼續依賴定期輪詢：', e.message);
    realtimeClient = null;
    realtimeChannel = null;
  }
}

function stopRealtimeSync() {
  if (realtimeClient && realtimeChannel) {
    realtimeClient.removeChannel(realtimeChannel);
  }
  realtimeClient = null;
  realtimeChannel = null;
}
