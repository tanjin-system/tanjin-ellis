// ---------- 小金語音助理（Gemini Live API，2026-10-29）----------
// 流程：按🎙️ →要麥克風權限→跟後端換一個短效權杖（/api/gemini-token，GEMINI_API_KEY
// 本身不會經過這支手機）→直接連線Gemini Live API（WebSocket）→即時把麥克風聲音串流
// 過去→模型聽懂之後呼叫我們定義的「report_unavailable」工具（不是直接寫資料庫！）→
// 前端收到工具呼叫，一律先跳showVoiceIntentConfirmCard()給夥伴看過、自己點確認才會
// 真的寫入driver_unavailabilities——跟2026-10-28定案的鐵律一致：語音辨識結果絕對
// 不能跳過人工確認直接生效。
//
// ⚠️ 這支連線協定（setup/realtimeInput/serverContent/toolCall...的訊息格式、
// WebSocket網址、模型名稱）是依照寫這支程式碼當下所知最新的Gemini Live API文件，
// Google這個功能官方標示「預覽階段」，規格隨時可能已經變了。這裡沒有真的麥克風、
// 也沒有可以燒的Gemini額度，沒辦法在開發環境裡實際連線測試——真的能不能動、
// 聽得懂多準，需要用真手機實際測。如果打不開/連不上，請打開瀏覽器主控台
// （iPhone：設定→Safari→進階→網頁檢視器，接電腦用Safari開發選單看；或直接把
// 畫面上跳出的錯誤訊息截圖/打字告訴我），把真正的錯誤內容給我，照實際錯誤調整，
// 不要憑空猜。

// 2026-10-29第一版用的是key=長效金鑰的連線方式＋舊的模型名稱（gemini-2.0-flash-live-001），
// 實機測試直接連線失敗（code 1007）。查Google官方文件後修正：暫時性權杖要用
// BidiGenerateContentConstrained這個方法（不是BidiGenerateContent）、網址參數是
// access_token（不是key），模型名稱也早就換成gemini-3.8-live。這兩個如果Google
// 之後又改了，連線失敗時主控台看到的錯誤碼/訊息是最準的依據。
const VOICE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const VOICE_MODEL = 'models/gemini-3.8-live';

const VOICE_FN_REPORT_UNAVAILABLE = {
  name: 'report_unavailable',
  description: '當夥伴口頭表示某天要請假或不能排班時呼叫這個工具。能明確判斷出西元日期（根據系統指示給的今天日期換算「明天」「下週二」等說法）才填date；不確定、模糊（例如「最近」「之後再說」）就把date留空字串，交給人去用畫面手動選——絕對不要自己亂猜一個日期。rawText一定要填，放聽到的原話或簡短摘要。',
  parameters: {
    type: 'OBJECT',
    properties: {
      date: { type: 'STRING', description: 'YYYY-MM-DD格式；不確定時留空字串，不要猜' },
      rawText: { type: 'STRING', description: '聽到的原話或簡短摘要' }
    },
    required: ['rawText']
  }
};
// 2026-10-29新增：使用者反應問「這週要跑什麼任務」「這個月賺多少」都被打槍說看不到——
// 其實前端本來就有這些資料（state.data），只是一開始系統指示寫死「不能查」。加三個
// 唯讀查詢工具，執行完直接回傳文字結果讓Gemini唸出來。這些都只讀資料、不寫資料庫，
// 跟report_unavailable那種會改資料的工具不一樣，不需要額外的人工確認關卡。
// 2026-10-29使用者反應：問「明天行程」只答得出是哪台車，答不出下貨點有哪些、
// 費用多少——因為原本的回答只列了路線名稱。assignment本身的資料其實就有完整的
// 下貨點清單（assignment_drop_points，見fetchAssignmentsInRange的select），
// 只是沒有組進回答文字裡。加一個date參數：問特定一天（明天、下週三...）就填
// 換算好的日期，回傳那天的完整明細（每個下貨點、費用）；問一整週/一整月才用
// range，給簡要列表（每趟幾個店點、費用，但不逐一唸出店名，不然太長）。
const VOICE_FN_GET_MY_TASKS = {
  name: 'get_my_tasks',
  description: '查詢使用者自己本人（目前登入這支手機的夥伴）的任務安排，不是查別人的。問特定一天（例如「今天」「明天」「下週三」）要先把日期換算成YYYY-MM-DD填到date——填了date會回傳那一天的完整明細（每個下貨點、費用）。問一整週/一整月才用range：week（這週，週一到週日）或month（這個月），不要同時填date和range。',
  parameters: { type: 'OBJECT', properties: {
    date: { type: 'STRING', description: 'YYYY-MM-DD，問特定一天時填這個，會回傳完整明細' },
    range: { type: 'STRING', description: 'week 或 month，問一整週/一整月時填這個，給簡要列表' }
  } }
};
const VOICE_FN_GET_MY_EARNINGS = {
  name: 'get_my_earnings',
  description: '查詢使用者自己本人（目前登入這支手機的夥伴）的報酬/薪資，不是查別人的。month格式YYYY-MM，沒講就不用填，預設查這個月。',
  parameters: { type: 'OBJECT', properties: { month: { type: 'STRING', description: 'YYYY-MM格式，選填' } } }
};
const VOICE_FN_GET_WEATHER = {
  name: 'get_weather',
  description: '查詢天氣。沒有指定地點就查公司所在地的天氣。',
  parameters: { type: 'OBJECT', properties: { location: { type: 'STRING', description: '地點名稱，選填，例如「台北」「高雄」' } } }
};
// 2026-10-29新增：主控（admin）端也要有語音助理，查全車隊/特定夥伴的狀況（主控本來
// 就看得到所有夥伴的資料，跟夥伴自己只能看自己的不一樣，範圍刻意分開）。只讀查詢，
// 一樣不能寫資料庫——主控這邊本來就有完整的操作介面可以真的改東西，語音只負責回答
// 問題，不負責動手做事，跟夥伴端「AI只能提案、人點頭才算數」是同一個原則。
const VOICE_FN_GET_FLEET_STATUS = {
  name: 'get_fleet_status',
  description: '查詢某一天全車隊的任務狀況（排了幾趟、完成幾趟、有沒有異常回報）。問特定一天要把日期換算成YYYY-MM-DD，沒講就查今天。',
  parameters: { type: 'OBJECT', properties: { date: { type: 'STRING', description: 'YYYY-MM-DD，選填，沒填查今天' } } }
};
const VOICE_FN_GET_DRIVER_LOOKUP = {
  name: 'get_driver_lookup',
  description: '查詢某一位夥伴的狀況：今天跑哪些任務、這個月跑幾趟、報酬大約多少。driverName填聽到的姓名，可以只有部分（例如「小沈」）。',
  parameters: { type: 'OBJECT', properties: { driverName: { type: 'STRING', description: '夥伴姓名或部分姓名' } }, required: ['driverName'] }
};
// 2026-10-29使用者要求：不要只開放幾個事先想好的問題，應該要能瀏覽系統裡「這個
// 帳號看得到的」幾乎任何目錄/營運資料（路線、店點、通路、公告...），依帳號不同
// 看得到的範圍不同。不是每種資料各寫一支工具（以後每多一種就要再改一次程式碼、
// 再部署一次），改成一個通用的browse_info(topic, keyword, month)工具，搭配一張
// topic→處理函式的對照表（VOICE_TOPICS_DRIVER/VOICE_TOPICS_ADMIN），以後要多開放
// 別的主題，對照表加一行就好。
//
// ⚠️ 有一條線不管哪個帳號都一樣沒有開放：登入密碼/驗證碼、API金鑰這類「系統本身
// 的祕密」。這個系統本來就特別設計成這些東西連admin自己瀏覽器的畫面都看不到（見
// auth.js/auth-admin.js的註解——admin_pin、access_code、vapid_private這些欄位
// 從資料庫查出來的時候就已經不包含在前端讀得到的資料裡了）。語音助理只讀取瀏覽器
// 現有讀得到的資料（state.data）跟既有的查詢函式，天然不會碰到這些欄位，不是我
// 另外加了什麼過濾規則——這個系統從一開始的設計就不允許前端程式碼拿到這些東西。
const VOICE_FN_BROWSE_INFO_DRIVER = {
  name: 'browse_info',
  description: '查詢系統裡的其他資料（不是本人任務/報酬/請假，是路線、店點、通路、公告這類目錄資料）。topic固定用下面其中一個：announcements（公告）、my_leave_records（我登記過的請假）、route_info（查某條路線，keyword填路線名稱）、drop_point_info（查某個店點，keyword填店名或代號）、channel_info（查某個通路，keyword填通路名稱）。',
  parameters: { type: 'OBJECT', properties: {
    topic: { type: 'STRING', description: 'announcements, my_leave_records, route_info, drop_point_info, 或 channel_info' },
    keyword: { type: 'STRING', description: '查詢關鍵字（路線/店點/通路名稱），依topic決定要不要填' }
  }, required: ['topic'] }
};
const VOICE_FN_BROWSE_INFO_ADMIN = {
  name: 'browse_info',
  description: '查詢系統裡的目錄/營運資料。topic固定用下面其中一個：company_overview（公司整體概況：幾位夥伴、幾條路線等）、routes_list（列出路線，keyword可選填出發點名稱縮小範圍）、route_info（查某條路線詳細資料含金額，keyword填路線名稱）、drop_point_info（查某個店點，keyword填店名或代號）、channel_info（查某個通路含費率，keyword填通路名稱）、channel_revenue（查某個通路某個月的營收，keyword填通路名稱，month選填YYYY-MM）、announcements（目前上架中的公告）、drivers_by_earnings（找出某個月報酬合計達到某個金額以上的夥伴，例如「有哪些人報酬超過20000」，minAmount填那個金額，month選填）、driver_bank_info（查某位夥伴的匯款銀行資訊，要匯款時用，keyword填夥伴姓名）、undelivered_stops（查某一天還沒送完的店點，date選填YYYY-MM-DD，沒填查今天）。',
  parameters: { type: 'OBJECT', properties: {
    topic: { type: 'STRING', description: 'company_overview, routes_list, route_info, drop_point_info, channel_info, channel_revenue, announcements, drivers_by_earnings, driver_bank_info, 或 undelivered_stops' },
    keyword: { type: 'STRING', description: '查詢關鍵字（店點/通路/路線名稱，或driver_bank_info的夥伴姓名），依topic決定要不要填' },
    month: { type: 'STRING', description: 'YYYY-MM，channel_revenue/drivers_by_earnings可以用，沒講就用這個月' },
    minAmount: { type: 'NUMBER', description: '金額門檻，只有drivers_by_earnings需要，例如20000' },
    date: { type: 'STRING', description: 'YYYY-MM-DD，只有undelivered_stops會用，沒講就查今天' }
  }, required: ['topic'] }
};

// 2026-10-29使用者要求：說出想查的夥伴/店點/路線，小金要能直接把畫面切過去，
// 不是只用唸的。這是純畫面導覽（不寫資料庫、不改任何東西），所以不用像
// report_unavailable那樣走確認卡片——跟點選單上的連結是同一件事，只是用講的。
// 導覽到夥伴/店點直接重用現有的全域搜尋gsGo()，路線同理走openRouteForEdit()，
// 不要另外發明一套導覽邏輯。姓名/名稱比對沿用「完全相符才直接動作、模糊相符
// 要先確認」的同一套安全原則（跟查薪水那次事故修法一致）——切錯畫面雖然不會
// 造成資料損失，但一樣是「講得很篤定其實搞錯對象」的同一種失誤，不要輕視。
function voiceFindSingleRoute(rawQuery) {
  const raw = (rawQuery || '').trim();
  if (!raw) return { error: '沒有聽清楚要找哪條路線，請再說一次。' };
  const routes = (state.data.routes || []).filter(r => r.status !== 'inactive');
  const exact = routes.filter(r => routeDisplayName(r.name) === raw || r.name === raw);
  if (exact.length === 1) return { entity: exact[0] };
  if (exact.length > 1) return { error: `有${exact.length}條路線都叫「${raw}」，請提供更多資訊確認是哪一條。` };
  const fuzzy = routes.filter(r => { const n = routeDisplayName(r.name); return n.includes(raw) || raw.includes(n); });
  if (fuzzy.length === 1) return { error: `沒有完全符合「${raw}」的路線，最接近的是「${routeDisplayName(fuzzy[0].name)}」，要切到這條的話請講出完整正確的名稱確認一次。` };
  if (fuzzy.length > 1) return { error: `有${fuzzy.length}條路線名稱接近「${raw}」（${fuzzy.map(r => routeDisplayName(r.name)).join('、')}），請講出完整正確的名稱。` };
  return { error: `查不到名稱包含「${raw}」的路線。` };
}
function voiceFindSingleDropPoint(rawQuery) {
  const raw = (rawQuery || '').trim();
  if (!raw) return { error: '沒有聽清楚要找哪個店點，請再說一次。' };
  const points = state.data.dropPoints || [];
  const exact = points.filter(p => (p.code || '') === raw || (p.address || '') === raw);
  if (exact.length === 1) return { entity: exact[0] };
  if (exact.length > 1) return { error: `有${exact.length}個店點都叫「${raw}」，請提供更多資訊確認是哪一個。` };
  const fuzzy = points.filter(p => (p.code || '').includes(raw) || (p.address || '').includes(raw));
  if (fuzzy.length === 1) return { error: `沒有完全符合「${raw}」的店點，最接近的是「${dpLabel(fuzzy[0])}」，要切到這個的話請講出完整正確的名稱確認一次。` };
  if (fuzzy.length > 1) return { error: `有${fuzzy.length}個店點名稱接近「${raw}」（${fuzzy.slice(0, 8).map(p => dpLabel(p)).join('、')}），請講出更完整的名稱。` };
  return { error: `查不到代號或地址包含「${raw}」的店點。` };
}

const VOICE_FN_GOTO_SCREEN_ADMIN = {
  name: 'goto_screen',
  description: '幫主控把畫面切到想查看的地方（純畫面導覽，不會改動任何資料）。target用driver（某位夥伴的資料，keyword填姓名）、drop_point（某個店點，keyword填店名或代號）、route（某條路線的編輯畫面，keyword填路線名稱），或下面這些固定分頁之一：home（總覽首頁）、warroom（戰情室）、schedule（排班）、drivers（夥伴列表）、dropPoints（店點列表）、routes（路線列表）、payroll（報酬結算）、billing（請款結算）、channels（通路）、origins（任務起點）、announcements（公告）、slips（勞報單）、export（資料匯出）、settings（系統設定）。',
  parameters: { type: 'OBJECT', properties: {
    target: { type: 'STRING', description: 'driver, drop_point, route, 或上面列出的固定分頁名稱之一' },
    keyword: { type: 'STRING', description: 'driver/drop_point/route需要填姓名或名稱，固定分頁不用填' }
  }, required: ['target'] }
};
const VOICE_ADMIN_TAB_MAP = {
  home: ['home', '總覽首頁'], warroom: ['warroom', '戰情室'], schedule: ['schedule', '排班'],
  drivers: ['drivers', '夥伴列表'], dropPoints: ['dropPoints', '店點列表'], routes: ['routes', '路線列表'],
  payroll: ['payroll', '報酬結算'], billing: ['billing', '請款結算'], channels: ['channels', '通路'],
  origins: ['origins', '任務起點'], announcements: ['announcements', '公告'], slips: ['slips', '勞報單'],
  export: ['export', '資料匯出'], settings: ['settings', '系統設定']
};
async function voiceToolGotoScreenAdmin(args) {
  const target = (args && args.target) || '';
  const keyword = (args && args.keyword) || '';
  try {
    if (target === 'driver') {
      const found = voiceFindDriverByName(keyword);
      if (found.error) return found.error;
      gsGo('d|' + found.driver.id);
      return `好，已經幫你切到${found.driver.name}的夥伴資料畫面了。`;
    }
    if (target === 'drop_point') {
      const found = voiceFindSingleDropPoint(keyword);
      if (found.error) return found.error;
      gsGo('p|' + found.entity.id);
      return `好，已經幫你切到${dpLabel(found.entity)}的店點畫面了。`;
    }
    if (target === 'route') {
      const found = voiceFindSingleRoute(keyword);
      if (found.error) return found.error;
      gsGo('r|' + found.entity.id);
      return `好，已經幫你打開${routeDisplayName(found.entity.name)}的編輯畫面了。`;
    }
    const mapped = VOICE_ADMIN_TAB_MAP[target];
    if (mapped) { switchTab(mapped[0]); return `好，已經幫你切到${mapped[1]}了。`; }
  } catch (e) { return '切換畫面時發生錯誤，請自己點選看看。'; }
  return `還沒開放切到「${target}」這個畫面，可以自己從選單切換。`;
}

const VOICE_FN_GOTO_SCREEN_DRIVER = {
  name: 'goto_screen',
  description: '幫使用者把畫面切到想看的分頁（純畫面導覽，不會改動任何資料）。target固定用下面其中一個：home（首頁）、today（今日任務）、history（歷史任務）、myEarnings（我的報酬）、myStatement（對帳單）、profile（我的資料）。',
  parameters: { type: 'OBJECT', properties: { target: { type: 'STRING', description: 'home, today, history, myEarnings, myStatement, 或 profile' } }, required: ['target'] }
};
const VOICE_DRIVER_TAB_MAP = {
  home: ['home', '首頁'], today: ['today', '今日任務'], history: ['history', '歷史任務'],
  myEarnings: ['my-earnings', '我的報酬'], myStatement: ['my-statement', '對帳單'], profile: ['profile', '我的資料']
};
async function voiceToolGotoScreenDriver(args) {
  const target = (args && args.target) || '';
  const mapped = VOICE_DRIVER_TAB_MAP[target];
  if (!mapped) return `還沒開放切到「${target}」這個畫面。`;
  try { switchTab(mapped[0]); } catch (e) { return '切換畫面時發生錯誤，請自己點選看看。'; }
  return `好，已經幫你切到${mapped[1]}了。`;
}

function voiceIsAdminMode() { return state.role === 'admin' && !state.adminViewDriver; }

function voiceFindRoute(keyword, admin) {
  const routes = (state.data.routes || []).filter(r => r.status !== 'inactive');
  if (!keyword) return `目前有${routes.length}條使用中的路線：` + routes.slice(0, 15).map(r => routeDisplayName(r.name)).join('、') + (routes.length > 15 ? '…等' : '') + '。';
  const matches = routes.filter(r => routeDisplayName(r.name).includes(keyword) || (r.name || '').includes(keyword));
  if (!matches.length) return `查不到名稱包含「${keyword}」的路線。`;
  if (matches.length > 1) return `有${matches.length}條路線名稱包含「${keyword}」（${matches.slice(0, 8).map(r => routeDisplayName(r.name)).join('、')}），請講更完整的名稱。`;
  const r = matches[0];
  const v = (r.versions || [])[r.versions.length - 1]; // versions依start_date排序過，最後一筆是最新版本
  const stopCount = v ? (v.dropPointIds || []).length : 0;
  let text = `${routeDisplayName(r.name)}：出發點${r.originAddr || '—'}，${r.shift === 'AM' ? '早班' : r.shift === 'PM' ? '午班' : (r.shift || '')}，目前${stopCount}個店點`;
  if (admin && v) {
    if (v.driverFare != null) text += `，司機報酬${voiceMoney(v.driverFare)}`;
    if (v.billingTotal != null) text += `，請款總額${voiceMoney(v.billingTotal)}`;
  }
  return text + '。';
}
function voiceFindDropPoint(keyword) {
  const points = state.data.dropPoints || [];
  if (!keyword) return `系統裡共有${points.filter(p => p.status !== 'inactive').length}個使用中的店點，請講店名或代號查詳細資料。`;
  const matches = points.filter(p => (p.code || '').includes(keyword) || (p.address || '').includes(keyword));
  if (!matches.length) return `查不到代號或地址包含「${keyword}」的店點。`;
  if (matches.length > 1) return `有${matches.length}個店點符合「${keyword}」（${matches.slice(0, 8).map(p => dpLabel(p)).join('、')}），請講更完整的名稱。`;
  const p = matches[0];
  return `${dpLabel(p)}：地址${p.address}，通路${channelName(p.channelId)}，${p.status === 'inactive' ? '已停用' : '使用中'}。`;
}
function voiceFindChannel(keyword, admin) {
  const channels = state.data.channels || [];
  if (!keyword) return `系統裡共有${channels.filter(c => c.status !== 'inactive').length}個使用中的通路：` + channels.filter(c => c.status !== 'inactive').map(c => c.name).join('、') + '。';
  const matches = channels.filter(c => (c.name || '').includes(keyword));
  if (!matches.length) return `查不到名稱包含「${keyword}」的通路。`;
  if (matches.length > 1) return `有${matches.length}個通路名稱包含「${keyword}」（${matches.map(c => c.name).join('、')}），請講更完整的名稱。`;
  const c = matches[0];
  let text = `${c.name}：${c.status === 'inactive' ? '已停用' : '使用中'}`;
  if (admin) {
    if (c.formulaType) text += `，計費方式${c.formulaType}`;
    if (c.rateKm) text += `，每公里${c.rateKm}元`;
    if (c.ratePoint) text += `，每店點${c.ratePoint}元`;
    if (c.flatAmount) text += `，固定金額${c.flatAmount}元`;
  }
  return text + '。';
}

const VOICE_TOPICS_DRIVER = {
  announcements: async () => {
    const dId = state.activeDriverId;
    const list = (state.data.announcements || []).filter(a => a.active && (a.audience !== 'selected' || a.driverIds.includes(dId)));
    if (!list.length) return '目前沒有公告。';
    return list.slice(0, 5).map(a => `「${a.title}」：${a.content}`).join('；');
  },
  my_leave_records: async () => {
    const dId = state.activeDriverId;
    const today = todayStr();
    let list;
    try { list = await fetchDriverUnavailabilities(today, ymd(addDays(today, 60))); } catch (e) { return '查詢請假紀錄時發生錯誤，請稍後再試。'; }
    const mine = list.filter(x => x.driverId === dId).sort((a, b) => a.date.localeCompare(b.date));
    if (!mine.length) return '目前沒有登記任何請假。';
    return '已登記：' + mine.map(x => `${x.date}${x.note ? '（' + x.note + '）' : ''}`).join('、');
  },
  route_info: async args => voiceFindRoute((args && args.keyword) || '', false),
  drop_point_info: async args => voiceFindDropPoint((args && args.keyword) || ''),
  channel_info: async args => voiceFindChannel((args && args.keyword) || '', false)
};
const VOICE_TOPICS_ADMIN = {
  company_overview: async () => {
    const activeDrivers = (state.data.drivers || []).filter(d => d.status === 'active').length;
    const activeRoutes = (state.data.routes || []).filter(r => r.status !== 'inactive').length;
    const activePoints = (state.data.dropPoints || []).filter(p => p.status !== 'inactive').length;
    const activeChannels = (state.data.channels || []).filter(c => c.status !== 'inactive').length;
    return `目前在職夥伴${activeDrivers}位，使用中路線${activeRoutes}條，使用中店點${activePoints}個，使用中通路${activeChannels}個。`;
  },
  routes_list: async args => voiceFindRoute((args && args.keyword) || '', true),
  route_info: async args => voiceFindRoute((args && args.keyword) || '', true),
  drop_point_info: async args => voiceFindDropPoint((args && args.keyword) || ''),
  channel_info: async args => voiceFindChannel((args && args.keyword) || '', true),
  channel_revenue: async args => {
    const keyword = (args && args.keyword) || '';
    if (!keyword) return '請講要查哪個通路的營收。';
    const matches = (state.data.channels || []).filter(c => (c.name || '').includes(keyword));
    if (!matches.length) return `查不到名稱包含「${keyword}」的通路。`;
    if (matches.length > 1) return `有${matches.length}個通路名稱包含「${keyword}」，請講更完整的名稱。`;
    const c = matches[0];
    const month = (args && args.month && /^\d{4}-\d{2}$/.test(args.month)) ? args.month : todayStr().slice(0, 7);
    const start = month + '-01', end = monthEndStr(month);
    let assignments;
    try { assignments = await fetchAssignmentsInRange(start, end); } catch (e) { return '查詢營收時發生錯誤，請稍後再試。'; }
    const r = channelBillingTotal(c.id, start, end, assignments);
    return `${c.name} ${month}營收合計約${voiceMoney(r.total)}（${r.contributing.length}趟已完成任務）。`;
  },
  announcements: async () => {
    const list = (state.data.announcements || []).filter(a => a.active).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!list.length) return '目前沒有上架中的公告。';
    return list.slice(0, 5).map(a => `「${a.title}」：${a.content}`).join('；');
  },
  // 2026-10-29使用者要求：主控要能用語音做條件篩選，例如「有哪些司機報酬超過
  // 20000」——不是查單一夥伴，是整批算完再篩選。挨個夥伴跑driverMonthly()，
  // 公司規模（~100位夥伴）這樣算一次沒問題，不需要另外做資料庫端的聚合查詢。
  drivers_by_earnings: async args => {
    const minAmount = Number(args && args.minAmount);
    if (!minAmount || minAmount <= 0) return '請講報酬門檻是多少元，例如「超過20000元」。';
    const month = (args && args.month && /^\d{4}-\d{2}$/.test(args.month)) ? args.month : todayStr().slice(0, 7);
    const start = month + '-01', end = monthEndStr(month);
    let assignments;
    try { assignments = await fetchAssignmentsInRange(start, end); await ensureAdjustmentsRange(start); } catch (e) { return '查詢時發生錯誤，請稍後再試。'; }
    const results = (state.data.drivers || []).filter(d => d.status === 'active').map(d => {
      const r = driverMonthly(d.id, month, assignments);
      return { name: d.name, tripTotal: r.tripTotal, trips: r.trips.length };
    }).filter(x => x.tripTotal >= minAmount).sort((a, b) => b.tripTotal - a.tripTotal);
    if (!results.length) return `${month}沒有任何在職夥伴的報酬合計達到${minAmount}元以上。`;
    return `${month}報酬合計達到${minAmount}元以上的夥伴共${results.length}位：` + results.map(x => `${x.name}（約${voiceMoney(x.tripTotal)}，${x.trips}趟）`).join('、') + '。';
  },
  // 2026-10-29使用者要求：要匯款給夥伴時直接問語音助理要銀行資訊。這份資料
  // 主控本來就能在「夥伴」管理畫面看到（匯款本來就要用），跟登入密碼/驗證碼
  // 那種系統祕密不一樣，所以可以開放；但帳號資訊單獨開一個主題，不要混在
  // get_driver_lookup（問今天跑什麼/賺多少）裡，問別的問題不會順便就講出帳號。
  driver_bank_info: async args => {
    const found = voiceFindDriverByName((args && args.keyword) || '');
    if (found.error) return found.error;
    const d = found.driver, b = d.bank || {};
    if (!b.bankName && !b.account) return `${d.name}目前還沒有填寫銀行資訊，請提醒他到「我的資料」補上才能匯款。`;
    return `${d.name}的匯款資訊：戶名${b.holder || d.name}，銀行${b.bankName || '未填'}，分行${b.branch || '未填'}，帳號${b.account || '未填'}。`;
  },
  // 2026-10-29使用者要求：問「還有哪些店沒送完」要查得到。掃今天所有在跑的
  // 任務，把還沒標記完成的下貨點抓出來——跟戰情室（WarRoom）判斷「完成」的
  // 依據（dp.status==='completed'）是同一套，不是另外發明一套邏輯。
  undelivered_stops: async args => {
    const date = (args && args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : todayStr();
    let assignments;
    try { assignments = await fetchAssignmentsInRange(date, date); } catch (e) { return '查詢未完成店點時發生錯誤，請稍後再試。'; }
    const active = assignments.filter(a => !a.isSupport && a.published !== false && a.status !== 'cancelled');
    const pending = [];
    active.forEach(a => (a.dropPoints || []).forEach(dp => {
      if (dp.status !== 'completed') pending.push({ label: dpLabel(dp), route: routeName(a.routeId), driver: driverName(a.driverId), issue: dp.issueReason || '' });
    }));
    if (!pending.length) return `${date}目前所有店點都已經送完了。`;
    const shown = pending.slice(0, 10);
    const text = shown.map(p => `${p.label}（${p.route}・${p.driver}）${p.issue ? '，異常：' + p.issue : ''}`).join('、');
    return `${date}還有${pending.length}個店點沒送完：` + text + (pending.length > shown.length ? `，還有${pending.length - shown.length}個沒列出，可以到戰情室看完整清單` : '') + '。';
  }
};
async function voiceToolBrowseInfo(args) {
  const topic = (args && args.topic) || '';
  const registry = voiceIsAdminMode() ? VOICE_TOPICS_ADMIN : VOICE_TOPICS_DRIVER;
  const handler = registry[topic];
  if (!handler) return `目前還沒有開放「${topic}」這個主題的查詢。`;
  try { return await handler(args || {}); } catch (e) { return '查詢時發生錯誤，請稍後再試。'; }
}

function voiceSystemInstruction() {
  return voiceIsAdminMode() ? voiceSystemInstructionAdmin() : voiceSystemInstructionDriver();
}
function voiceSystemInstructionAdmin() {
  const wd = '日一二三四五六'[new Date().getDay()];
  return `你是物流車隊系統「小金」語音助理，只講中文（台灣），語氣親切專業、像個得力
助理。今天是${todayStr()}（星期${wd}）。

⚠️最高原則（比任何其他規則都優先）：對任何查到的姓名、資料、數字，只要不是
100%確定，一定要老實跟主控確認，絕對不能把猜測的結果當成肯定的答案講出去。
查錯人、講錯數字造成的麻煩，遠比「多問一句、慢一點」嚴重得多——工具如果回傳
的是確認用的問句（例如「最接近的是OOO，要查這位嗎」），那就是在問你，不是
在給你答案，你要把問句完整唸給主控聽、等明確回答之後才能再查一次拿到真正的
答案。

現在跟你說話的是主控（公司管理者）本人，不是夥伴（司機）。你有以下工具可以用，
該用就直接呼叫，不要說自己做不到：
- get_fleet_status：主控問「今天/某一天車隊狀況怎樣」「有沒有異常」就呼叫這個。
- get_driver_lookup：主控問某位夥伴的狀況（今天跑什麼、這個月跑幾趟/賺多少）
  就呼叫這個。
- get_weather：主控問天氣就呼叫這個。
- goto_screen：主控說「幫我切到/查一下某位夥伴的畫面」「幫我打開OO路線」
  「切到戰情室/報酬結算」這種想要畫面跳轉的需求，就呼叫這個，target要用
  goto_screen工具說明裡列出的其中一個。這個工具只是切換畫面給主控自己操作，
  不會真的改動任何資料。
- browse_info：問路線、店點、通路（含費率）、營收、公告這類目錄/營運資料，問
  「有哪些夥伴報酬超過OO元」這種條件篩選，問某位夥伴的匯款銀行資訊（要匯款時
  用），或問「還有哪些店沒送完」，就呼叫這個，topic要用browse_info工具說明裡
  列出的其中一個，不要自己亂編topic名稱。查到銀行帳號的時候，數字要一個一個
  唸清楚（例如「0、2、1、0、1、8」），不要唸成一長串數字含糊帶過。
這幾個工具以外（例如詳細勞報單/請款單明細、系統設定），你看不到，被問到就老實
說看不到、建議主控自己到對應頁面查，不要瞎編；工具查詢失敗或查不到的時候，也
照實說查詢失敗，不要自己編一個答案出來。

⚠️極重要（真實發生過的事故）：get_driver_lookup、browse_info的
driver_bank_info這兩個工具，如果聽到的姓名在系統裡沒有完全一樣的，工具會
回傳「最接近的是『OOO』，要查這位嗎」這種確認用的句子，不是正式查詢結果。
遇到這種回覆，你一定要把這句確認問題完整照唸給主控聽、等主控明確回答（例如
「對」或講出完整正確的姓名）之後，才能再呼叫一次工具去真的查數字——絕對
不能自己猜主控說的就是工具建議的那個人，直接把數字報出來。之前發生過真實
事故：主控問「喬治這個月薪水多少」，小金自己猜了一個接近的姓名就把（別人的）
趟數和金額報成喬治的，主控完全看不出來查錯人，造成財務資訊誤報。姓名查詢
寧可多問一句確認，也不要自信地報錯人、報錯錢。

你平常也可以自由聊天、講笑話、閒聊、回答一般常識問題，不用每次都把話題拉回工作。

⚠️重要：你只能查資料、回答問題，不能真的去改派任務、調整排班、修改金額或登入
帳號——這些操作一律請主控自己到系統畫面上操作，你沒有、也不應該有這些權限。

⚠️極重要（真實發生過的事故）：工具回傳的金額文字會長得像「25530元（兩萬五千
五百三十元）」這樣，括號裡已經是正確的中文唸法，你口頭回答的時候直接照括號
裡的中文唸出來就好（例如唸成「兩萬五千五百三十元」），不要自己把前面那個
阿拉伯數字重新換算成中文——之前發生過真實事故：工具回傳的金額是對的，但
你自己把「25530」轉換成中文口語時轉錯，多唸成「25萬5300」，講給主控聽的
數字整整大了10倍，造成財務資訊誤報。`;
}
function voiceSystemInstructionDriver() {
  const wd = '日一二三四五六'[new Date().getDay()];
  // 2026-10-29使用者要求：小金要知道自己現在是在哪個帳號裡講話（例如在小沈的手機
  // 上就要知道在跟小沈說話、只能讀小沈自己的資料；換一支手機、換成漢祥登入，就只能讀
  // 漢祥的）。直接把目前登入這支手機的夥伴姓名寫進系統指示，而不是讓它自己瞎猜。
  const who = (typeof driverName === 'function' && driverName(state.activeDriverId)) || '這位夥伴';
  return `你是物流車隊系統「小金」語音助理，只講中文（台灣），語氣親切自然、像個熟悉的
同事。今天是${todayStr()}（星期${wd}）。

⚠️最高原則（比任何其他規則都優先）：對任何查到的資料、數字，只要不是100%
確定，一定要老實跟使用者確認，絕對不能把猜測的結果當成肯定的答案講出去。

現在跟你說話的是夥伴本人「${who}」——這支手機就是${who}登入的帳號，下面提到的「使用者」
都是指${who}這一個人，不是別人。查任務、查報酬、請假登記，一律只針對${who}自己，絕對
不要查到或講到其他夥伴的資料（你本來也看不到別人的，不用假裝看得到）。如果使用者問
「你知道我是誰嗎」之類的，可以直接說出「${who}」這個名字，不用裝作不知道。

你是個全方位的語音小幫手：平常可以自由聊天、講笑話、閒聊、回答一般常識問題，不用每次
都把話題拉回工作。你有以下幾個工具可以用，該用就直接呼叫，不要說自己做不到：
- get_my_tasks：使用者問「我今天/明天/下週三要跑什麼」「有哪些店點」就呼叫這個
  （問特定一天會回傳完整明細：每個下貨點、費用）；問「這週/這個月」要跑什麼就用
  range參數，給簡要列表。
- get_my_earnings：使用者問「我這個月賺多少」「報酬多少」就呼叫這個。
- get_weather：使用者問天氣就呼叫這個。
- report_unavailable：使用者說要請假/不能排班就呼叫這個（詳見下方規則）。
- goto_screen：使用者說「幫我切到OO」這種想要畫面跳轉的需求，就呼叫這個，
  target要用goto_screen工具說明裡列出的其中一個。
- browse_info：問公告、自己登記過哪些請假、或查路線/店點/通路資料（不含金額，
  那些是主控才看得到的）就呼叫這個，topic要用browse_info工具說明裡列出的其中
  一個，不要自己亂編topic名稱。
這幾個工具以外，你看不到系統裡其他資料（例如別的夥伴的狀況、確切的公司財務數字），
被問到就老實說看不到、不要瞎編；工具查詢失敗或查不到的時候，也照實跟使用者說查詢
失敗，不要自己編一個答案出來。

除了聊天之外，你還有一個正式功能：聽到夥伴說要請假或某天不能排班時，換算出確切日期後
呼叫report_unavailable這個工具；不確定日期就把date留空，不要自己亂猜。

⚠️重要（請假相關）：公司現行規則是星期五、六、日要回報「下週」（下星期一到星期日）的
狀況，沒回報就視為可以照公司安排排班——所以正常情況下夥伴講的請假日期應該是下週的某一
天，不是今天或明天。這個登記本身只是「以後排班不要排我」的註記，絕對不會自動取消今天、
明天這種已經排定、已經發給夥伴的任務，系統沒有能力臨時改派。如果夥伴講的日期是今天或
明天，呼叫工具之前一定要先口頭提醒：「這個時間太緊急了，光跟我說沒有用，一定要直接打
電話或傳LINE給主控確認」，講完提醒才呼叫工具；平常（下週的日期）就不用講這段提醒，
直接簡短回應（例如「好，幫你記下週三請假」）然後呼叫工具即可，不用等待使用者口頭再
確認一次——確認這件事系統會另外跳畫面給使用者看，不是你的責任。

⚠️極重要：工具回傳的金額文字會長得像「25530元（兩萬五千五百三十元）」這樣，
括號裡已經是正確的中文唸法，直接照括號裡的中文唸出來就好，不要自己把前面的
阿拉伯數字重新換算成中文——之前發生過真實事故：主控端查報酬時，AI自己換算
中文口語轉錯，把數字講大了10倍，造成財務資訊誤報。`;
}

function voiceWeekRange(today) {
  const d = new Date(today + 'T00:00:00');
  const dow = d.getDay() === 0 ? 7 : d.getDay(); // 週一=1...週日=7
  return { start: ymd(addDays(today, 1 - dow)), end: ymd(addDays(today, 7 - dow)) };
}
// 2026-10-29使用者回報：查10月報酬只讀到1750元/2趟，實際是8525元/10趟。原因是
// state.data.assignments只保留近期窗口（ASSIGNMENTS_WINDOW_DAYS=14天，見
// js/data-layer.js），查整個月（尤其是月初已經過去14天的部分）會漏資料。跟
// renderMyEarnings同一套做法：不碰共用的state.data.assignments，直接用
// fetchAssignmentsInRange()跟資料庫要選定區間的資料，兩個查詢工具都改成async。
function voiceShiftLabel(shift) { return shift === 'AM' ? '早班' : shift === 'PM' ? '午班' : (shift || ''); }
// 2026-10-29使用者回報真實事故：問「喬治這個月薪水多少」，語音助理報了255,300元，
// 實際對照「我的報酬」「報酬結算」兩個正式畫面都是25,530元——剛好是10倍。追查過
// 我這邊送出去的文字本身是正確的（${Math.round(r.tripTotal)}元，沒有任何乘法），
// 33趟/完成數也對得上，所以問題應該不是出在資料查詢或算法，是Gemini把阿拉伯數字
// 轉成中文口語唸出來的這一步算錯了——中文數字是以「萬」（1萬=10000）分級，英文/
// 阿拉伯數字是以千分位（1,000）分級，兩種分級方式不一樣，大型語言模型把多位數
// 轉換成中文口語時，偶爾會在「萬」這個位階算錯、多唸或少唸一位，這是中文語音AI
// 常見的已知問題類型。既然沒辦法從我這邊修正Gemini內部怎麼做數字轉換，就不要讓它
// 做這個轉換——所有金額的回傳文字都直接附上我自己算好的中文讀法（例如「25530元
// （兩萬五千五百三十元）」），讓它照著唸就好，不用自己再轉換一次，大幅降低唸錯的
// 機會。
function voiceChineseNumber(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return '零';
  const negative = n < 0; n = Math.abs(n);
  const digits = '零一二三四五六七八九';
  const units = ['', '十', '百', '千'];
  function fourDigit(num) {
    if (num === 0) return '';
    const str = String(num).padStart(4, '0');
    let s = '', zeroFlag = false, started = false; // started=false時的0是補位用的前導0，不該唸出「零」，只有數字中間真的跳過的0才要唸
    for (let i = 0; i < 4; i++) {
      const d = Number(str[i]);
      if (d === 0) { if (started) zeroFlag = true; continue; }
      if (zeroFlag) { s += '零'; zeroFlag = false; }
      s += digits[d] + units[3 - i];
      started = true;
    }
    return s;
  }
  const yi = Math.floor(n / 100000000);
  const wan = Math.floor((n % 100000000) / 10000);
  const rest = n % 10000;
  const parts = [];
  if (yi) parts.push(fourDigit(yi) + '億');
  if (wan) parts.push(fourDigit(wan) + '萬');
  if (rest) { if (parts.length && rest < 1000) parts.push('零'); parts.push(fourDigit(rest)); }
  let result = (parts.join('') || '零').replace(/^一十/, '十'); // 口語習慣唸「十五」不唸「一十五」
  return (negative ? '負' : '') + result;
}
function voiceMoney(n) {
  const r = Math.round(Number(n) || 0);
  return `${r}元（${voiceChineseNumber(r)}元）`;
}
async function voiceToolGetMyTasks(args) {
  const dId = state.activeDriverId;
  const today = todayStr();
  const specificDate = (args && args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : '';
  let start, end, label, detailed;
  if (specificDate) { start = specificDate; end = specificDate; label = specificDate; detailed = true; }
  else if ((args && args.range) === 'month') { start = today.slice(0, 7) + '-01'; end = monthEndStr(today.slice(0, 7)); label = '這個月'; detailed = false; }
  else { const w = voiceWeekRange(today); start = w.start; end = w.end; label = '這週'; detailed = false; }
  let assignments;
  try { assignments = await fetchAssignmentsInRange(start, end); } catch (e) { return '查詢任務時發生錯誤，請稍後再試。'; }
  const list = assignments.filter(a =>
    a.driverId === dId && !a.isSupport && a.published !== false && a.status !== 'cancelled'
  ).sort((a, b) => a.date.localeCompare(b.date) || assignmentShiftKey(a) - assignmentShiftKey(b));
  if (!list.length) return `${label}（${start}到${end}）沒有排定的任務。`;
  if (detailed) {
    return list.map(a => {
      const stops = (a.dropPoints || []).map((dp, i) => `${i + 1}.${dpLabel(dp)}`).join('、');
      return `${a.date} ${voiceShiftLabel(a.shift)} ${routeName(a.routeId)}，費用約${voiceMoney(tripPay(a))}，共${(a.dropPoints || []).length}個下貨點：${stops || '（店點明細尚未排定）'}`;
    }).join('；');
  }
  const lines = list.map(a => `${a.date} ${voiceShiftLabel(a.shift)} ${routeName(a.routeId)}，${(a.dropPoints || []).length}個店點，費用約${voiceMoney(tripPay(a))}${a.status === 'completed' ? '（已完成）' : ''}`);
  return `${label}（${start}到${end}）共有${list.length}趟任務：` + lines.join('；');
}
async function voiceToolGetMyEarnings(args) {
  const dId = state.activeDriverId;
  const month = (args && args.month && /^\d{4}-\d{2}$/.test(args.month)) ? args.month : todayStr().slice(0, 7);
  const start = month + '-01', end = monthEndStr(month);
  let monthAssignments;
  try {
    monthAssignments = await fetchAssignmentsInRange(start, end);
    await ensureAdjustmentsRange(start); // 調整項（加減項）也要補到這個月，不然net會漏算
  } catch (e) { return '查詢報酬時發生錯誤，請稍後再試。'; }
  const r = driverMonthly(dId, month, monthAssignments);
  const netNow = r.net - (r.paid || 0);
  return `${month}已完成${r.trips.length}趟任務，報酬合計${voiceMoney(r.tripTotal)}，目前預估淨額約${voiceMoney(netNow)}（實際領到的金額以月結單正式結算、扣稅扣款後為準，可能會有些微差異）。`;
}
async function voiceToolGetWeather(args) {
  try {
    const loc = (args && args.location) || '';
    let lat, lon, label;
    if (loc) {
      const gr = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=' + encodeURIComponent(loc));
      const gj = await gr.json();
      const hit = gj.results && gj.results[0];
      if (!hit) return `查不到「${loc}」這個地點的天氣資料。`;
      lat = hit.latitude; lon = hit.longitude; label = hit.name;
    } else {
      const o = (state.data.origins || []).find(x => x.lat != null && x.lng != null);
      if (o) { lat = o.lat; lon = o.lng; label = o.label || o.address || '公司所在地'; }
      else { lat = 25.0330; lon = 121.5654; label = '台北'; } // 系統裡沒有座標資料時的保底預設值
    }
    const wr = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code,wind_speed_10m`);
    const wj = await wr.json();
    const cur = wj.current;
    if (!cur) return '查詢天氣失敗，請稍後再試。';
    return `${label}目前氣溫約${Math.round(cur.temperature_2m)}度，${cur.precipitation > 0 ? '目前正在下雨' : '目前沒有下雨'}，風速約每小時${Math.round(cur.wind_speed_10m)}公里。`;
  } catch (e) { return '查詢天氣時發生錯誤，請稍後再試。'; }
}
async function voiceToolGetFleetStatus(args) {
  const date = (args && args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : todayStr();
  let assignments;
  try { assignments = await fetchAssignmentsInRange(date, date); } catch (e) { return '查詢車隊狀況時發生錯誤，請稍後再試。'; }
  const active = assignments.filter(a => !a.isSupport && a.published !== false && a.status !== 'cancelled');
  if (!active.length) return `${date}目前沒有排定任何任務。`;
  const completed = active.filter(a => a.status === 'completed').length;
  const inProgress = active.filter(a => a.status === 'in_progress').length;
  const issues = active.filter(a => a.hasIssue);
  let text = `${date}共排定${active.length}趟任務，已完成${completed}趟`;
  if (inProgress) text += `，${inProgress}趟進行中`;
  text += issues.length ? `，${issues.length}趟有異常回報：` + issues.map(a => `${routeName(a.routeId)}（${driverName(a.driverId)}）`).join('、') : '，沒有異常回報';
  return text + '。';
}
// 2026-10-29第一版：查中文姓名「找不到」（查英文可以）——原本只有「driverName
// 字串是夥伴姓名的子字串」這一種比對方向，中文同音字多，語音辨識常常多聽/少聽
// 一個字就直接比對失敗。改成雙向模糊比對，比對到唯一一個就直接當作答案採用。
//
// 結果出了真的事故：使用者問「喬治這個月薪水多少」，小金用模糊比對到了另一位
// 夥伴的資料，卻照樣用「喬治」的名義把（別人的）趟數跟金額報出來，使用者完全
// 看不出來查錯人——這是比「查不到」嚴重得多的錯誤：財務數字講錯，使用者還真的
// 會相信。問題不是比對邏輯不夠聰明，是「模糊比對到了就直接當答案用」這個設計
// 本身不安全。改成：
// - 完全一模一樣的姓名才會直接採用（高信心，不用再確認）。
// - 模糊比對到的只能當「候選」，一律要使用者口頭確認是不是這位、小金再用
//   確認過的完整姓名重新查一次（會變成完全比對），才能真的把數字報出來——
//   跟report_unavailable「AI只能提案、人點頭才算數」是同一個原則，只是這裡
//   套用在「查到的是不是這個人」這一步，不是套用在「要不要寫入資料庫」。
function voiceFindDriverByName(rawQuery) {
  const raw = (rawQuery || '').trim();
  const q = raw.replace(/[的嗎呢吧啊喔]+$/g, '') || raw; // 去掉語音常見的結尾贅字，去完變空字串就還用原字
  if (!q) return { error: '沒有聽清楚要查哪位夥伴，請再說一次姓名。' };
  const drivers = state.data.drivers || [];
  const exact = drivers.filter(d => (d.name || '') === q);
  if (exact.length === 1) return { driver: exact[0] };
  if (exact.length > 1) return { error: `系統裡有${exact.length}位夥伴都叫「${q}」，請提供其他資訊（例如電話末三碼）才能確認是哪一位。` };
  const fuzzy = drivers.filter(d => { const name = d.name || ''; return name.includes(q) || q.includes(name); });
  if (fuzzy.length === 1) return { error: `沒有完全符合「${q}」的夥伴，最接近的是「${fuzzy[0].name}」，要查這位的話，請講「對，查${fuzzy[0].name}」確認一次，講完整正確的姓名我才會真的查。` };
  if (fuzzy.length > 1) return { error: `有${fuzzy.length}位夥伴的名字接近「${q}」（${fuzzy.map(d => d.name).join('、')}），請講出完整正確的姓名。` };
  const candidates = drivers.filter(d => {
    const name = d.name || '';
    let shared = 0;
    for (const ch of q) if (name.includes(ch)) shared++;
    return shared >= 2;
  });
  if (candidates.length) return { error: `查不到「${q}」，你是不是要找：${candidates.slice(0, 5).map(d => d.name).join('、')}？請講出完整正確的姓名。` };
  return { error: `查不到叫「${q}」的夥伴，請確認姓名（語音辨識中文姓名有時候會聽錯字，可以試著講更完整或換個講法）。` };
}
async function voiceToolGetDriverLookup(args) {
  const found = voiceFindDriverByName((args && args.driverName) || '');
  if (found.error) return found.error;
  const d = found.driver;
  const today = todayStr(), month = today.slice(0, 7);
  let todays, monthAssignments;
  try {
    todays = await fetchAssignmentsInRange(today, today);
    monthAssignments = await fetchAssignmentsInRange(month + '-01', monthEndStr(month));
    await ensureAdjustmentsRange(month + '-01');
  } catch (e) { return '查詢夥伴資料時發生錯誤，請稍後再試。'; }
  const myToday = todays.filter(a => a.driverId === d.id && !a.isSupport && a.published !== false && a.status !== 'cancelled');
  const r = driverMonthly(d.id, month, monthAssignments);
  const todayText = myToday.length ? myToday.map(a => `${voiceShiftLabel(a.shift)} ${routeName(a.routeId)}`).join('、') : '沒有排定任務';
  return `${d.name}今天：${todayText}。${month}已完成${r.trips.length}趟，報酬合計約${voiceMoney(r.tripTotal)}。`;
}

function voiceSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && (window.AudioContext || window.webkitAudioContext) && 'WebSocket' in window);
}

let _voiceState = null; // { closed, stream, audioCtx, sourceNode, procNode, muteNode, ws, timeoutTimer }

// 2026-10-29使用者要求：原本講話時是整個畫面的modal蓋住，不能邊講邊操作系統。
// 改成一顆不擋畫面的小狀態條（CSS另外定義在index.html的#voiceOverlay/.voice-status-pill），
// 底下的畫面照常點得到；另外在voiceStart()裡掛一個「點畫面空白處結束通話」的監聽器
// （只認真的點在document.body本身的那種點擊，不會誤吃到任何按鈕/連結/面板上的點擊）。
function voiceRenderOverlay(status, showStop) {
  let ov = document.getElementById('voiceOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'voiceOverlay'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="voice-status-pill">
    <span>🎙️ ${escapeHtml(status)}</span>
    ${showStop ? '<button type="button" id="voiceStopBtn">結束</button>' : ''}
  </div>`;
  const btn = document.getElementById('voiceStopBtn');
  if (btn) btn.onclick = () => voiceStop();
}
function voiceBlankTapToEnd(e) {
  if (_voiceState && !_voiceState.closed && e.target === document.body) voiceStop();
}
document.addEventListener('click', voiceBlankTapToEnd); // 註冊一次就好，沒有通話中時不會有作用

function voiceDownsampleTo16k(float32Array, inputSampleRate) {
  if (inputSampleRate === 16000) return float32Array;
  const ratio = inputSampleRate / 16000;
  const newLen = Math.round(float32Array.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = float32Array[Math.floor(i * ratio)];
  return out;
}
function voiceFloat32ToPCM16Base64(float32Array) {
  const buf = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buf);
  for (let i = 0, off = 0; i < float32Array.length; i++, off += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function voiceParseRate(mimeType, fallback) {
  const m = /rate=(\d+)/.exec(mimeType || '');
  return m ? Number(m[1]) : fallback;
}
// 2026-10-29實機測試回報「我的聲音+AI的聲音重疊」，改成AI講話時暫停送出麥克風
// （半雙工）。後來使用者又回報：這樣會變成「AI講話中使用者講話也沒用、AI會一直
// 講完」，要求真正的「使用者一開口AI就要立刻停下來」（barge-in／搶話）。這兩個
// 需求其實互相牽制：要能被打斷，麥克風就得在AI講話時持續送出去，讓Gemini自己的
// 語音活動偵測聽得到使用者開口；但手機沒戴耳機時，喇叭放出的AI聲音又會被同一支
// 麥克風錄到送回去。折衷做法：
// 1) 不再暫停送出麥克風——持續串流，讓Gemini server端自己判斷「使用者開口了，
//    我要停下來」（Live API協定裡的serverContent.interrupted旗標）。
// 2) 收到interrupted旗標，立刻呼叫voiceStopPlayback()把所有已經排隊/正在播放
//    的語音全部喊停，不要讓AI講到自然的段落才停。
// 3) 麥克風的echoCancellation（getUserMedia已經有開）是瀏覽器自己消除「喇叭聲
//    被自己麥克風錄到」的機制，這部分效果好不好要看手機硬體/瀏覽器，我沒辦法
//    在這裡保證——如果實測還是常常自己講話打斷自己，最確實的解法是戴耳機（喇叭
//    聲音不會跑出來，麥克風自然收不到），這點會老實跟使用者說。
function voicePlayAudioChunk(state, audioCtx, base64, mimeType) {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const n = bytes.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 0x8000;
    const rate = voiceParseRate(mimeType, 24000); // 文件沒寫死輸出取樣率，優先用訊息自己附的mimeType，沒有才退回24kHz猜測值
    const buffer = audioCtx.createBuffer(1, n, rate);
    buffer.copyToChannel(f32, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    const startAt = Math.max(audioCtx.currentTime, state.nextPlayTime || 0);
    src.start(startAt);
    state.nextPlayTime = startAt + buffer.duration;
    state.aiSpeaking = true; // 只用來給狀態條顯示文字，不再拿來決定麥克風要不要送出
    if (!state.playingSources) state.playingSources = [];
    state.playingSources.push(src);
    src.onended = () => { const i = state.playingSources.indexOf(src); if (i >= 0) state.playingSources.splice(i, 1); };
  } catch (e) { console.error('播放語音回應失敗', e); }
}
// 使用者打斷AI時呼叫：把所有排隊中／正在播放的語音全部停掉，不要播完當下這句話
function voiceStopPlayback(state) {
  (state.playingSources || []).forEach(src => { try { src.onended = null; src.stop(); } catch (e) {} });
  state.playingSources = [];
  state.nextPlayTime = 0;
  state.aiSpeaking = false;
}

function voiceStartStreamingMic(stream, audioCtx, ws, state) {
  const source = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1); // 用舊版API換取簡單直接可用（不用額外寄生worklet檔案）
  const mute = audioCtx.createGain(); mute.gain.value = 0; // 一定要接到destination才會持續觸發，但不能真的播出來（會變回音）
  state.sourceNode = source; state.procNode = proc; state.muteNode = mute;
  proc.onaudioprocess = e => {
    if (!_voiceState || ws.readyState !== WebSocket.OPEN) return; // 不管AI講不講話都持續送出，讓server端自己判斷使用者有沒有開口打斷
    const input = e.inputBuffer.getChannelData(0);
    const down = voiceDownsampleTo16k(input, audioCtx.sampleRate);
    ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: voiceFloat32ToPCM16Base64(down) } } }));
  };
  source.connect(proc); proc.connect(mute); mute.connect(audioCtx.destination);
}

function voiceStop() {
  if (!_voiceState) return;
  _voiceState.closed = true;
  clearTimeout(_voiceState.timeoutTimer);
  try { _voiceState.procNode && _voiceState.procNode.disconnect(); } catch (e) {}
  try { _voiceState.sourceNode && _voiceState.sourceNode.disconnect(); } catch (e) {}
  try { _voiceState.muteNode && _voiceState.muteNode.disconnect(); } catch (e) {}
  try { _voiceState.stream && _voiceState.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { _voiceState.ws && _voiceState.ws.readyState === WebSocket.OPEN && _voiceState.ws.close(); } catch (e) {}
  try { _voiceState.audioCtx && _voiceState.audioCtx.close(); } catch (e) {}
  const ov = document.getElementById('voiceOverlay'); if (ov) ov.remove();
  voiceFabSetActive(false);
  _voiceState = null;
  setTimeout(voiceWakeStart, 400); // 正式通話用的麥克風真的釋放後，才恢復喚醒詞監聽（兩邊不能同時佔用麥克風）
}
function voiceFail(message) {
  if (!_voiceState) return; // 已經收尾過了，不要重複跳錯誤訊息
  voiceStop();
  alert(message);
}

// 2026-10-29使用者回報：連續對話中大約15秒就會被強制結束。查了才發現這個計時器
// 第一版是「設定一次、連線後30秒不管有沒有在講話都砍掉」，不是真正的「太久沒反應
// 才算逾時」——完全不適合現在這種可以一直聊下去的全方位助理。改成每次有訊息往來
// 就重新計時，真的是整整60秒完全沒有任何互動（使用者沒講話、AI也沒回應）才會自動
// 結束，避免忘記關掉、白白耗用額度，同時也不會打斷正在進行中的對話。
const VOICE_INACTIVITY_MS = 60000;
function resetInactivityTimer() {
  if (!_voiceState) return;
  clearTimeout(_voiceState.timeoutTimer);
  _voiceState.timeoutTimer = setTimeout(() => voiceFail('太久沒有互動，語音助理自動結束了。'), VOICE_INACTIVITY_MS);
}

// ---------- 懸浮小助手（2026-10-29，使用者要求：不要把語音功能藏在面板裡，
// 做一個隨時看得到的懸浮圖示，點了就能講話）----------
function voiceFabAvatarSvg() {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <defs><linearGradient id="voiceFabBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FFC2E2"/><stop offset="100%" stop-color="#C9A8FF"/>
    </linearGradient></defs>
    <circle cx="50" cy="50" r="50" fill="url(#voiceFabBg)"/>
    <ellipse cx="18" cy="62" rx="10" ry="19" fill="#6B4A8A"/>
    <ellipse cx="82" cy="62" rx="10" ry="19" fill="#6B4A8A"/>
    <circle cx="50" cy="53" r="26" fill="#FFE4CF"/>
    <path d="M24 47 Q26 19 50 19 Q74 19 76 47 Q70 33 50 33 Q30 33 24 47 Z" fill="#7A5AA0"/>
    <path d="M38 35 Q40 45 36 51" stroke="#7A5AA0" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M62 35 Q60 45 64 51" stroke="#7A5AA0" stroke-width="3" fill="none" stroke-linecap="round"/>
    <ellipse cx="41" cy="55" rx="5.3" ry="6.8" fill="#2E2A3A"/>
    <ellipse cx="59" cy="55" rx="5.3" ry="6.8" fill="#2E2A3A"/>
    <circle cx="43" cy="52" r="1.6" fill="#fff"/>
    <circle cx="61" cy="52" r="1.6" fill="#fff"/>
    <ellipse cx="34" cy="63" rx="4.5" ry="3" fill="#FFAFC4" opacity="0.85"/>
    <ellipse cx="66" cy="63" rx="4.5" ry="3" fill="#FFAFC4" opacity="0.85"/>
    <path d="M46 66 Q50 70 54 66" stroke="#C06080" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M26 47 Q50 29 74 47" stroke="#3A3A3A" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <circle cx="76" cy="51" r="4.2" fill="#3A3A3A"/>
    <circle cx="24" cy="51" r="4.2" fill="#3A3A3A"/>
  </svg>`;
}
// 懸浮球拖曳＋記住位置（2026-10-29，使用者要求：球可能擋到畫面內容，要能自己拖去別的地方）。
// 固定寬高跟.voice-fab CSS的width/height一致（58px），位置存這支手機的localStorage，
// 換手機、清過瀏覽器資料就會回到預設右下角，不影響任何人共用的資料。
const VOICE_FAB_SIZE = 58;
const VOICE_FAB_POS_KEY = 'fleet_voice_fab_pos';
function voiceFabLoadPos() {
  try { const p = JSON.parse(localStorage.getItem(VOICE_FAB_POS_KEY) || 'null'); if (p && typeof p.x === 'number' && typeof p.y === 'number') return p; } catch (e) {}
  return null;
}
function voiceFabSavePos(x, y) { try { localStorage.setItem(VOICE_FAB_POS_KEY, JSON.stringify({ x, y })); } catch (e) {} }
function voiceFabClamp(x, y) {
  const maxX = Math.max(4, window.innerWidth - VOICE_FAB_SIZE - 4);
  const maxY = Math.max(4, window.innerHeight - VOICE_FAB_SIZE - 4);
  return { x: Math.min(Math.max(4, x), maxX), y: Math.min(Math.max(4, y), maxY) };
}
function voiceFabApplyPos(fab, x, y) {
  fab.style.left = x + 'px'; fab.style.top = y + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto';
}
const VOICE_LONG_PRESS_MS = 600;
function voiceFabWireDrag(fab) {
  // 2026-10-29：先後試過「監聽器綁在球自己身上＋setPointerCapture」、「拖曳中把
  // Pointer Events監聽器掛到window上」，實機都回報完全拖不動——Pointer
  // Events在手機瀏覽器這邊顯然有問題，不管用什麼方式都一樣。這版整個換掉，
  // 直接用最原始、相容性最好的touch事件（手機）＋mouse事件（電腦測試用），
  // 不再依賴Pointer Events/setPointerCapture這套。
  // 長按（不移動地壓著不放超過VOICE_LONG_PRESS_MS）用來切換喚醒詞模式，跟拖曳/
  // 單純點一下共用同一套移動判斷，避免互相誤判。
  let dragging = false, moved = false, startX = 0, startY = 0, origX = 0, origY = 0, longPressTimer = null;
  const begin = (x, y) => {
    dragging = true; moved = false;
    const r = fab.getBoundingClientRect();
    origX = r.left; origY = r.top; startX = x; startY = y;
    fab.style.animation = 'none'; // 拖曳中先停掉呼吸動畫，不然位置跟縮放動畫疊在一起會晃
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (!dragging || moved) return; // 已經放開、或已經判定成拖曳就不算長按
      dragging = false;
      fab.style.animation = '';
      fab._justLongPressed = true; // 擋掉放開後補發的click，不要被當成單純點一下去開語音
      setTimeout(() => { fab._justLongPressed = false; }, 300);
      voiceWakeSetEnabled(!voiceWakeLoadPref());
    }, VOICE_LONG_PRESS_MS);
  };
  const move = (x, y) => {
    if (!dragging) return false;
    const dx = x - startX, dy = y - startY;
    if (!moved && Math.hypot(dx, dy) > 6) { moved = true; clearTimeout(longPressTimer); } // 移動夠多才算拖曳，不然手抖一下就誤判成拖曳、吃掉原本要點一下的操作
    if (!moved) return false;
    const p = voiceFabClamp(origX + dx, origY + dy);
    voiceFabApplyPos(fab, p.x, p.y);
    return true;
  };
  const end = () => {
    clearTimeout(longPressTimer);
    if (!dragging) return;
    dragging = false;
    fab.style.animation = '';
    if (moved) {
      const r = fab.getBoundingClientRect();
      voiceFabSavePos(r.left, r.top);
      fab._justDragged = true; // 擋掉拖完放開後瀏覽器自己補發的click，不要被誤判成「點一下」去開語音
      setTimeout(() => { fab._justDragged = false; }, 50);
    }
  };
  // 觸控（手機）：touchstart不擋預設行為（維持單純點一下能正常觸發click），
  // 真的判定成拖曳（moved=true）之後才在touchmove擋掉，避免被瀏覽器當成捲動手勢取消掉。
  fab.addEventListener('touchstart', e => { const t = e.touches[0]; if (t) begin(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('touchmove', e => { const t = e.touches[0]; if (t && move(t.clientX, t.clientY)) e.preventDefault(); }, { passive: false });
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
  // 滑鼠（電腦瀏覽器測試用）
  fab.addEventListener('mousedown', e => begin(e.clientX, e.clientY));
  window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  window.addEventListener('mouseup', end);
  window.addEventListener('resize', () => {
    if (!document.body.contains(fab) || fab.style.left === '') return; // 還沒拖過（用CSS預設右下角）就不用管
    const r = fab.getBoundingClientRect();
    const p = voiceFabClamp(r.left, r.top);
    if (p.x !== r.left || p.y !== r.top) { voiceFabApplyPos(fab, p.x, p.y); voiceFabSavePos(p.x, p.y); }
  });
}

// ---------- 喚醒詞「小金」（2026-10-29，使用者要求）----------
// ⚠️ 老實說清楚這塊的限制：用瀏覽器內建、免費的語音辨識（Web Speech API）在背景
// 持續聽，偵測到「小金」這個詞就自動開始正式對話。這不是真正的「隨時待命」助理——
// 只有在這個PWA分頁真的開著、螢幕亮著的時候才聽得到，手機鎖螢幕、切到別的App、
// 或把這個分頁關掉，瀏覽器就不會再讓網頁聽麥克風了，這是手機作業系統本身的限制，
// 不是這支程式碼能繞過去的。另外Web Speech API在iPhone Safari上的穩定度我沒有
// 把握（這個功能本來就比較新、各家瀏覽器支援度落差大），需要實際測試才知道準不準、
// 會不會中途自己斷掉。預設關閉，長按懸浮球0.6秒開啟/關閉（開啟時會跳一個提示）。
const VOICE_WAKE_WORD = '小金';
const VOICE_WAKE_KEY = 'fleet_voice_wake_enabled';
let _wakeRecognizer = null;
function voiceWakeSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
function voiceWakeLoadPref() { try { return localStorage.getItem(VOICE_WAKE_KEY) === '1'; } catch (e) { return false; } }
function voiceWakeSavePref(on) { try { localStorage.setItem(VOICE_WAKE_KEY, on ? '1' : '0'); } catch (e) {} }
function voiceWakeStart() {
  if (_wakeRecognizer || _voiceState || !voiceWakeLoadPref() || !voiceWakeSupported()) return; // 已經在聽、或已經在正式通話中、或功能沒開/不支援，都不用啟動
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = 'zh-TW'; rec.continuous = true; rec.interimResults = true;
  rec.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = (e.results[i][0] && e.results[i][0].transcript) || '';
      if (text.includes(VOICE_WAKE_WORD)) { voiceWakeStop(); voiceStart(); return; }
    }
  };
  rec.onerror = () => {}; // 常見的no-speech/aborted不用特別處理，onend會自動重啟
  rec.onend = () => { _wakeRecognizer = null; if (voiceWakeLoadPref() && !_voiceState) setTimeout(voiceWakeStart, 300); }; // 瀏覽器常常過一段時間自己結束連續辨識，重啟繼續聽
  try { rec.start(); _wakeRecognizer = rec; } catch (e) { _wakeRecognizer = null; }
}
function voiceWakeStop() {
  if (_wakeRecognizer) { try { _wakeRecognizer.onend = null; _wakeRecognizer.stop(); } catch (e) {} _wakeRecognizer = null; }
}
function voiceWakeSetEnabled(on) {
  if (on && !voiceWakeSupported()) { if (typeof toast === 'function') toast('這支手機的瀏覽器不支援喚醒詞功能'); return; }
  voiceWakeSavePref(on);
  if (on) { voiceWakeStart(); if (typeof toast === 'function') toast(`👂 喚醒模式已開啟，說「${VOICE_WAKE_WORD}」就能開始對話（只有畫面開著、螢幕亮著才有效）`); }
  else { voiceWakeStop(); if (typeof toast === 'function') toast('👂 喚醒模式已關閉'); }
}
// renderContent()每次切分頁都會呼叫；show=是否該顯示（夥伴畫面／主控檢視夥伴畫面才顯示，
// 主控自己的畫面不顯示）。按鈕本身只建立一次、之後只切display，不會被各分頁的innerHTML洗掉。
function voiceFabEnsure(show) {
  let fab = document.getElementById('voiceFab');
  if (!show) { if (fab) fab.style.display = 'none'; voiceWakeStop(); return; } // 離開夥伴畫面就不要繼續聽喚醒詞（隱私/省電），偏好設定本身不變，回來會自動恢復
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'voiceFab';
    fab.className = 'voice-fab';
    fab.type = 'button';
    fab.title = '語音助理（小金）・可以拖著移動・長按切換喚醒詞模式';
    fab.innerHTML = voiceFabAvatarSvg();
    fab.onclick = () => { if (fab._justDragged || fab._justLongPressed) return; _voiceState ? voiceStop() : voiceStart(); };
    document.body.appendChild(fab);
    const saved = voiceFabLoadPos();
    if (saved) { const p = voiceFabClamp(saved.x, saved.y); voiceFabApplyPos(fab, p.x, p.y); }
    voiceFabWireDrag(fab);
  }
  fab.style.display = 'flex';
  voiceWakeStart(); // 偏好設定若已開啟，回到夥伴畫面就恢復聽喚醒詞；voiceWakeStart()內部本來就會檢查是否該啟動
}
function voiceFabSetActive(active) {
  const fab = document.getElementById('voiceFab');
  if (fab) fab.classList.toggle('active', !!active);
}

async function voiceStart() {
  if (_voiceState) return; // 已經在進行中
  if (!voiceSupported()) { alert('這支手機／瀏覽器不支援語音功能（需要麥克風與WebSocket）。'); return; }
  if (!navigator.onLine) { alert('請先連上網路才能使用語音功能。'); return; }
  voiceWakeStop(); // 正式對話跟喚醒詞監聽不能同時佔用麥克風，先讓出來
  _voiceState = { closed: false, aiSpeaking: false, nextPlayTime: 0 };
  voiceFabSetActive(true);
  voiceRenderOverlay('準備中…', false);
  try {
    const auth = getStoredAuth();
    if (!auth) throw new Error('請先登入');
    const tr = await fetch('/api/gemini-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token }, body: JSON.stringify({}) });
    const tj = await tr.json();
    if (!tr.ok) throw new Error(tj.error || '取得語音權杖失敗');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (!_voiceState) { stream.getTracks().forEach(t => t.stop()); return; } // 要權限的這幾秒使用者可能已經按了結束
    _voiceState.stream = stream;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    _voiceState.audioCtx = audioCtx;

    const ws = new WebSocket(VOICE_WS_URL + '?access_token=' + encodeURIComponent(tj.token));
    _voiceState.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: VOICE_MODEL,
          generationConfig: { responseModalities: ['AUDIO'] },
          systemInstruction: { parts: [{ text: voiceSystemInstruction() }] },
          tools: [{ functionDeclarations: voiceIsAdminMode()
            ? [VOICE_FN_GET_FLEET_STATUS, VOICE_FN_GET_DRIVER_LOOKUP, VOICE_FN_GET_WEATHER, VOICE_FN_BROWSE_INFO_ADMIN, VOICE_FN_GOTO_SCREEN_ADMIN]
            : [VOICE_FN_REPORT_UNAVAILABLE, VOICE_FN_GET_MY_TASKS, VOICE_FN_GET_MY_EARNINGS, VOICE_FN_GET_WEATHER, VOICE_FN_BROWSE_INFO_DRIVER, VOICE_FN_GOTO_SCREEN_DRIVER] }]
        }
      }));
    };
    ws.onerror = () => { console.error('語音WebSocket錯誤', ws.url); voiceFail('語音連線發生錯誤，請稍後再試。如果一直這樣，請把瀏覽器主控台的錯誤訊息告訴工程師。'); };
    ws.onclose = ev => { console.error('語音WebSocket關閉', ev.code, ev.reason); if (_voiceState && !_voiceState.closed) voiceFail(`語音連線中斷（code ${ev.code}${ev.reason ? '：' + ev.reason : ''}）。`); };
    ws.onmessage = async ev => {
      resetInactivityTimer(); // 任何一則訊息都代表連線還活著、有在互動，重新計時（見下方timeoutTimer的說明）
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch (e) { return; }

      if (msg.setupComplete) {
        voiceRenderOverlay(voiceIsAdminMode() ? '請說話…（可以問車隊狀況、問夥伴狀況，或聊天）' : '請說話…（可以聊天、問問題，或說「我下週三請假」）', true);
        voiceStartStreamingMic(stream, audioCtx, ws, _voiceState);
        return;
      }
      if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
        for (const fc of msg.toolCall.functionCalls) {
          let resultText = 'ok';
          try {
            if (fc.name === 'get_my_tasks') resultText = await voiceToolGetMyTasks(fc.args || {});
            else if (fc.name === 'get_my_earnings') resultText = await voiceToolGetMyEarnings(fc.args || {});
            else if (fc.name === 'get_weather') resultText = await voiceToolGetWeather(fc.args || {});
            else if (fc.name === 'get_fleet_status') resultText = await voiceToolGetFleetStatus(fc.args || {});
            else if (fc.name === 'get_driver_lookup') resultText = await voiceToolGetDriverLookup(fc.args || {});
            else if (fc.name === 'browse_info') resultText = await voiceToolBrowseInfo(fc.args || {});
            else if (fc.name === 'goto_screen') resultText = await (voiceIsAdminMode() ? voiceToolGotoScreenAdmin(fc.args || {}) : voiceToolGotoScreenDriver(fc.args || {}));
          } catch (e) { resultText = '查詢時發生錯誤，請稍後再試。'; }
          try { ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: resultText } }] } })); } catch (e) {}
          if (fc.name === 'report_unavailable') {
            const args = fc.args || {};
            voiceStop();
            showVoiceIntentConfirmCard({ type: 'leave', date: args.date || '', rawText: args.rawText || '' });
          }
        }
        return;
      }
      if (msg.serverContent) {
        if (msg.serverContent.interrupted) {
          // 使用者開口打斷了AI——Gemini自己偵測到的，不是我們本地猜的。立刻把正在
          // 播放/排隊中的語音全部停掉，不要播完當下這句才停。
          voiceStopPlayback(_voiceState);
          voiceRenderOverlay('請說話…', true);
        }
        const parts = (msg.serverContent.modelTurn && msg.serverContent.modelTurn.parts) || [];
        parts.forEach(p => { if (p.inlineData && p.inlineData.data) { voicePlayAudioChunk(_voiceState, audioCtx, p.inlineData.data, p.inlineData.mimeType); voiceRenderOverlay('🤖 小金說話中…（講話可以隨時打斷我）', true); } });
        if (msg.serverContent.turnComplete) {
          // 不是文字生成完就改狀態條——等排隊的音訊真的播完（還留多少時間就等多少）
          // 才顯示「請說話」，不然字跟聲音對不上
          const remainMs = Math.max(0, ((_voiceState.nextPlayTime || 0) - audioCtx.currentTime)) * 1000 + 150;
          setTimeout(() => {
            if (!_voiceState) return;
            _voiceState.aiSpeaking = false;
            voiceRenderOverlay('請說話…', true);
          }, remainMs);
        }
      }
    };

    resetInactivityTimer(); // 從連線那一刻開始計時，setupComplete/每則訊息都會重新計時（見函式定義）
  } catch (e) {
    voiceFail(e.name === 'NotAllowedError' ? '沒有麥克風權限，請到手機設定開啟這個App的麥克風權限後再試一次。' : (e.message || '語音功能啟動失敗'));
  }
}
