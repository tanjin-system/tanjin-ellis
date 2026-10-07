// 取代 demo 原本的 loadData()/saveData()/normalize()/defaultData()。
// 設計原則：每個函式做完 Supabase 讀寫後，直接同步更新 state.data 裡對應的物件/陣列，
// 讓呼叫端（render*() 函式）跟 demo 時代一樣，操作完只要 renderContent() 就能看到最新畫面，
// 不需要再手動重新整個載入一次。所有函式失敗時 throw new Error(訊息)，
// 呼叫端沿用 demo 原本 try/catch + alert(err.message) 的寫法即可。
//
// 依賴 index.html 裡原本就有的 ymd()/addDays()/todayStr() 等純函式，請確保載入順序在這之後。

// ---------------- 型別轉換：DB row（snake_case）→ demo 原本的 JS 物件形狀 ----------------

function mapDriver(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || '',
    lineId: row.line_user_id || '',
    accessCode: row.access_code || '',
    forceCodeReset: !!row.force_code_reset,
    status: row.status,
    inactiveAt: row.inactive_at,
    vehicle: { plate: row.vehicle_plate || '', type: row.vehicle_type || '', load: row.vehicle_load ?? '' },
    bank: { bankName: row.bank_name || '', branch: row.bank_branch || '', account: row.bank_account || '', holder: row.bank_holder || '' },
    idNumber: row.id_number || '',
    unionInsured: !!row.union_insured, unionProofPath: row.union_proof_path || '',
    serviceName: row.service_name || ''
  };
}

function mapChannel(row) {
  return {
    id: row.id, name: row.name, periodType: row.period_type,
    startDay: row.start_day, endDay: row.end_day, status: row.status,
    formulaType: row.formula_type, rateKm: Number(row.rate_km), ratePoint: Number(row.rate_point),
    flatAmount: Number(row.flat_amount), taxMode: row.tax_mode || 'inclusive',
    accessToken: row.access_token || ''
  };
}

function mapOrigin(row) {
  return { id: row.id, address: row.address, label: row.label || '', status: row.status };
}

function mapDropPoint(row) {
  return { id: row.id, address: row.address, channelId: row.channel_id, code: row.code || '', status: row.status };
}

function mapRoute(row) {
  const originAddr = row.origins?.address || '';
  const versions = (row.route_versions || [])
    .slice().sort((a, b) => a.start_date.localeCompare(b.start_date))
    .map(v => ({
      id: v.id,
      start: v.start_date,
      end: v.end_date,
      origin: originAddr,
      distanceKm: v.distance_km != null ? Number(v.distance_km) : null,
      driverFare: v.driver_fare != null ? Number(v.driver_fare) : null,
      billingTotal: v.billing_total != null ? Number(v.billing_total) : null,
      billingByChannel: v.billing_by_channel || {},
      dropPointIds: (v.route_version_points || [])
        .slice().sort((a, b) => a.sequence_no - b.sequence_no)
        .map(p => p.drop_point_id)
    }));
  return { id: row.id, name: row.name, originAddr, seq: row.seq, shift: row.shift, region: row.region || '', versions };
}

function mapAssignment(row) {
  const points = (row.assignment_drop_points || []).slice().sort((a, b) => a.sequence_no - b.sequence_no);
  return {
    id: row.id,
    date: row.trip_date,
    routeId: row.route_id,
    driverId: row.driver_id,
    origin: row.origin_snapshot || '',
    fare: Number(row.fare),
    distanceKm: row.distance_km != null ? Number(row.distance_km) : null,
    status: row.status,
    hasIssue: row.has_issue,
    issueNote: row.issue_note || '',
    runNo: row.run_no,
    completedAt: row.completed_at,
    payrollFareSnapshot: row.payroll_fare_snapshot != null ? Number(row.payroll_fare_snapshot) : null,
    extraPay: Number(row.extra_pay || 0),
    paidAmount: Number(row.paid_amount || 0), paidDate: row.paid_date || null, paidMethod: row.paid_method || null,
    paidGroup: row.paid_group || null, paidPeriodStart: row.paid_period_start || null, paidPeriodEnd: row.paid_period_end || null,
    payDueDate: row.pay_due_date || null, payDueNote: row.pay_due_note || '',
    published: row.published !== false,
    billingSnapshot: row.billing_total_snapshot != null ? {
      totalAmount: Number(row.billing_total_snapshot),
      totalPoints: points.length,
      byChannel: row.billing_by_channel_snapshot || {}
    } : null,
    dropPoints: points.map(p => ({
      id: p.id,
      sourceDpId: p.source_drop_point_id,
      address: p.address,
      code: p.code || '',
      channelId: p.channel_id,
      status: p.status,
      photoPath: p.photo_url,
      photo: null,
      photoCleared: p.photo_cleared,
      issueReason: p.issue_reason || null,
      // 主要送達證明照以外的附加照片/影片（見 assignment_drop_point_media）；
      // url 要另外呼叫 resolvePhotoUrls() 才會補上簽名連結，跟 photo 欄位同一套機制。
      media: (p.assignment_drop_point_media || []).map(m => ({ id: m.id, path: m.media_url, type: m.media_type, url: null }))
    }))
  };
}

// 下貨點顯示用文字：全系統只顯示代號（例如"萬家福桂林店"），不顯示地址，
// 只有「下貨點資料庫」那個管理頁面本身例外會顯示完整地址。沒設代號的下貨點
// 才退回顯示地址（沒有別的資訊可顯示）。
function dpLabel(dp) {
  if (!dp) return '';
  return dp.code || dp.address;
}

function mapAdjustment(row) {
  return {
    id: row.id, driverId: row.driver_id, month: row.adjustment_month.slice(0, 7),
    type: row.adjustment_type, amount: Number(row.amount), note: row.note || '',
    date: row.adjustment_date || null
  };
}

// 夥伴代墊申報的類別：加油、車輛保養（資料表沿用 fuel_claims 名稱，category 欄位區分）。
const CLAIM_CATEGORY_LABEL = { fuel: '加油', maintenance: '車輛保養' };

function mapFuelClaim(row) {
  return {
    id: row.id, driverId: row.driver_id, date: row.fuel_date, amount: Number(row.amount),
    invoiceNo: row.invoice_no, status: row.status, adjustmentId: row.adjustment_id || null,
    category: row.category || 'fuel', note: row.note || ''
  };
}

function mapStatement(row) {
  return {
    id: row.id, driverId: row.driver_id, month: row.statement_month.slice(0, 7),
    tripTotal: Number(row.trip_total), adjTotal: Number(row.adj_total), net: Number(row.net_amount),
    incomeType: row.income_type || '',
    withholdTax: !!row.withhold_tax, taxRate: Number(row.tax_rate || 0), taxAmount: Number(row.tax_amount || 0),
    withholdNhi: !!row.withhold_nhi, nhiRate: Number(row.nhi_rate || 0), nhiAmount: Number(row.nhi_amount || 0),
    actualNet: Number(row.actual_net_amount || 0),
    reimbursementAmount: Number(row.reimbursement_amount || 0),
    serviceName: row.service_name || '',
    periodStart: row.period_start || null, periodEnd: row.period_end || null, payDate: row.pay_date || null,
    status: row.status, confirmedAt: row.confirmed_at, signedAt: row.signed_at,
    signatureDataUrl: null, adminAcked: row.admin_acked
  };
}

function mapBillingAdjustment(row) {
  return {
    id: row.id, channelId: row.channel_id, periodStart: row.period_start, periodEnd: row.period_end,
    note: row.note, amount: Number(row.amount)
  };
}

function mapAnnouncement(row) {
  return {
    id: row.id, title: row.title, content: row.content, active: row.active,
    audience: row.audience || 'all',
    driverIds: (row.announcement_recipients || []).map(r => r.driver_id),
    createdAt: row.created_at
  };
}

// ---------------- 照片／簽名：Storage 路徑 → 短期有效的可存取連結 ----------------
// 沿用 demo 原本欄位名稱（dp.photo / statement.signatureDataUrl），
// 這樣 index.html 裡 <img src="${dp.photo}"> 這類渲染程式碼完全不用改。

async function resolvePhotoUrls(assignments) {
  const supabase = getSupabase();
  const targets = [];
  assignments.forEach(a => a.dropPoints.forEach(dp => { if (dp.photoPath) targets.push(dp); }));
  const mediaTargets = [];
  assignments.forEach(a => a.dropPoints.forEach(dp => (dp.media || []).forEach(m => mediaTargets.push(m))));
  if (mediaTargets.length) {
    const { data: mediaSigned, error: mediaErr } = await supabase.storage
      .from('assignment-photos')
      .createSignedUrls(mediaTargets.map(m => m.path), 60 * 60 * 24 * 7);
    if (mediaErr) console.error('取得附加媒體連結失敗', mediaErr.message);
    else mediaSigned.forEach((item, i) => { mediaTargets[i].url = item?.signedUrl || null; });
  }
  if (!targets.length) return;
  const { data, error } = await supabase.storage
    .from('assignment-photos')
    .createSignedUrls(targets.map(dp => dp.photoPath), 60 * 60 * 24 * 7);
  if (error) { console.error('取得照片連結失敗', error.message); return; }
  data.forEach((item, i) => { targets[i].photo = item?.signedUrl || null; });
}

async function resolveSignatureUrls(statements) {
  const supabase = getSupabase();
  const targets = statements.filter(s => s.status === 'signed' || s.status === 'confirmed');
  if (!targets.length) return;
  const { data, error } = await supabase.storage
    .from('signatures')
    .createSignedUrls(targets.map(s => `${s.id}.png`), 60 * 60 * 24 * 7);
  if (error) { console.error('取得簽名連結失敗', error.message); return; }
  data.forEach((item, i) => { targets[i].signatureDataUrl = item?.signedUrl || null; });
}

// data URL格式是 data:[mediatype][;base64],data ——逗號永遠是切開「頭部
// 說明」跟「實際資料」的分界，這是規格保證的，不會變。原本用一個很嚴格
// 的正規表達式要求頭部長得剛好是"image/xxx;base64"，結果部分手機（會
// 在mediatype跟base64中間多塞一段例如";charset=binary"）產生的data URL
// 對不上這個嚴格格式，直接被當成「圖片格式錯誤」擋掉上傳——不是照片真
// 的壞掉，是我們自己的格式檢查太嚴格。改成不管頭部塞了什麼，一律照
// 逗號切開來，頭部隨便抓得到image/xxx就用，抓不到就預設當jpeg，一律
// 都收，不再因為頭部格式差一點就整個拒收。
function dataUrlToBytesAndType(dataUrl) {
  const commaIdx = (dataUrl || '').indexOf(',');
  if (commaIdx === -1) throw new Error('圖片格式錯誤');
  const header = dataUrl.slice(0, commaIdx);
  const base64 = dataUrl.slice(commaIdx + 1);
  const mimeMatch = /^data:(image\/[\w.\-]+)/.exec(header);
  const contentType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  return { bytes: Uint8Array.from(atob(base64), c => c.charCodeAt(0)), contentType };
}

// ---------------- 讀取全部資料（取代 loadData()） ----------------

// 車趟紀錄只會越堆越多、從來不會清（「資料匯出與封存」要admin手動確認才會刪），
// 每次登入/重新整理都把全部車趟連同下貨點、附加照片一次抓光，資料量只會越來越大、
// 越來越慢——尤其「加入主畫面」模式常被手機系統整個殺掉釋放記憶體，比一般瀏覽器
// 分頁更常從頭冷啟動、更常整批重抓，延遲感特別明顯。
//
// 這個天數要照「系統設計要撐住的規模」訂，不是照「現在資料量看起來夠不夠」訂：
// 目標是100位夥伴、1000+店家同時配送。主控端身份（RLS admin_all policy 是
// using(true)，看得到全部夥伴的資料）在那個規模下，即使窗口只抓14天，換算
// 下來大約還是要抓大幾千筆下貨點紀錄；抓90天在那個規模下單次登入的JSON會到
// 10幾MB，一定會感覺到卡頓，所以刻意縮到14天，只涵蓋「今日行程/本週期任務清單」
// 這種天天在看的畫面（這兩個畫面另外各自呼叫 ensureAssignmentsRange 確保涵蓋
// 實際顯示的區間，不完全依賴這裡的預設值）。夥伴自己登入時因為 RLS
// （driver_select_own policy 是 driver_id = auth_driver_id()）本來就只看得到
// 自己的車趟，不會跟著全系統規模一起變大，14天以外需要的地方（薪資結算、
// 請款結算查舊月份、資料匯出與封存、夥伴歷史班表）都用 ensureAssignmentsRange()
// 按需補抓缺口，不受這個預設窗口大小影響。
const ASSIGNMENTS_WINDOW_DAYS = 14;

// 目錄資料（夥伴/通路/出發點/下貨點/路線，含路線巢狀的全部版本跟版本下貨點）
// 幾乎不會變動，但份量是 loadAllData() 裡最大的一塊（尤其是路線，每條都
// 巢狀帶著全部歷史版本）。這裡先查 catalog_meta 這個單一時間戳記（見
// schema.sql PART 9，目錄表格任一張有異動，觸發器就會更新它），跟瀏覽器
// localStorage 存的版本比對——一樣就直接用本地快取，完全跳過這5支查詢；
// 版本查詢本身失敗（例如舊版資料庫還沒跑 migration）就當作沒快取，照原本
// 方式整包重抓，不影響既有行為。
// Supabase(PostgREST) 單次查詢最多回傳 1000 筆（Max Rows），超過會悄悄截斷、不報錯。
// 一個月的車趟數已經接近這個量，薪資/請款/首頁利潤如果只抓一頁就會少算，所以所有
// 抓整段車趟的查詢都改成這個分頁函式：buildQuery 回傳尚未排序的查詢，這裡依
// trip_date、id 排序後每次抓1000筆，抓到不足一頁為止。
async function fetchAllAssignmentPages(buildQuery) {
  const PAGE = 1000;
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().order('trip_date').order('id').range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    all = all.concat(data || []);
    if (!data || data.length < PAGE) break;
  }
  return { data: all, error: null };
}

// 目錄快取必須依「登入身份」分開存：資料庫權限（RLS）讓夥伴只看得到自己的夥伴資料等，
// 夥伴登入抓回來的目錄是「縮水版」；如果跟主控共用同一份快取，同一個瀏覽器先用夥伴
// 身份測試、再用主控登入，只要目錄版本沒變，主控就會拿到只有1位夥伴的縮水快取，
// 看起來像夥伴資料全部不見（實際資料庫完好）。主控一份，每位夥伴各自一份。
// 版本號碼後綴 v2：舊版（沒分身份）的快取直接作廢，不再被讀取。
function catalogCacheSuffix() {
  const driverId = state.role === 'driver' ? (state.activeDriverId || 'unknown') : null;
  return driverId ? `driver_${driverId}` : 'admin';
}
const catalogCacheKey = () => `fleet_catalog_cache_v2_${catalogCacheSuffix()}`;
const catalogVersionKey = () => `fleet_catalog_version_v2_${catalogCacheSuffix()}`;

async function loadAllData() {
  const supabase = getSupabase();
  // 清掉舊版（沒分身份）的目錄快取，避免佔著空間；新版快取用不同的 key，不受影響。
  try { localStorage.removeItem('fleet_catalog_cache_v1'); localStorage.removeItem('fleet_catalog_version_v1'); } catch (e) { /* 忽略 */ }

  let cachedCatalog = null;
  let remoteCatalogVersion = null;
  try {
    const { data: meta, error: metaErr } = await supabase.from('catalog_meta').select('version').eq('id', 1).maybeSingle();
    if (!metaErr && meta?.version) {
      remoteCatalogVersion = meta.version;
      if (remoteCatalogVersion === localStorage.getItem(catalogVersionKey())) {
        const cachedJson = localStorage.getItem(catalogCacheKey());
        if (cachedJson) cachedCatalog = JSON.parse(cachedJson);
      }
    }
  } catch (e) { /* 版本比對只是加速用，任何失敗都當作沒快取，退回正常整包重抓 */ }

  // 安全性修補：settings 表（含 admin_pin）依 schema.sql 設計刻意「只有 app_admin 能碰，
  // app_driver 完全不可見」，故意不 grant app_driver 任何權限，避免夥伴讀到明文主控PIN。
  // 但這代表夥伴身份查 settings 一定會收到 permission denied 錯誤——原本這裡不分身份
  // 都查，會讓下面的 for...throw 直接把夥伴的整個 loadAllData() 打斷，夥伴端因此完全
  // 無法登入使用。改成只有 admin 才查 settings，夥伴端用空殼帶過即可（夥伴端本來就
  // 沒有任何畫面會用到 adminPin）。
  const isAdmin = state.role === 'admin';
  const assignmentsWindowStart = ymd(addDays(todayStr(), -ASSIGNMENTS_WINDOW_DAYS));
  const queries = {
    ...(isAdmin ? { settingsRes: supabase.from('settings').select('*').eq('id', 1).maybeSingle() } : {}),
    ...(cachedCatalog ? {} : {
      driversRes: supabase.from('drivers').select('*').order('created_at'),
      channelsRes: supabase.from('channels').select('*').order('created_at'),
      originsRes: supabase.from('origins').select('*').order('created_at'),
      dropPointsRes: supabase.from('drop_points').select('*').order('created_at'),
      routesRes: supabase.from('routes').select('*, origins(address), route_versions(*, route_version_points(*))')
    }),
    assignmentsRes: fetchAllAssignmentPages(() => supabase.from('assignments').select('*, assignment_drop_points(*, assignment_drop_point_media(*))').gte('trip_date', assignmentsWindowStart)),
    adjustmentsRes: supabase.from('adjustments').select('*'),
    statementsRes: supabase.from('statements').select('*'),
    // billing_adjustments 只 grant app_admin，夥伴身份查會 permission denied，只有 admin 才查。
    ...(isAdmin ? { billingAdjustmentsRes: supabase.from('billing_adjustments').select('*').order('created_at') } : {}),
    // 公告：admin/driver 都能查，driver 只查得到 active=true 的（RLS擋掉下架的），
    // 不需要另外分身份寫兩個查詢。
    announcementsRes: supabase.from('announcements').select('*, announcement_recipients(driver_id)').order('created_at', { ascending: false }),
    // 夥伴加油申報：夥伴只查得到自己的（RLS），主控看全部。
    fuelClaimsRes: supabase.from('fuel_claims').select('*').order('fuel_date', { ascending: false })
  };
  const keys = Object.keys(queries);
  const results = await Promise.all(Object.values(queries));
  const byKey = {};
  keys.forEach((k, i) => { byKey[k] = results[i]; });
  for (const [label, res] of Object.entries(byKey)) {
    if (res.error) throw new Error(`載入 ${label} 失敗：${res.error.message}`);
  }

  const data = {
    settings: { adminPin: byKey.settingsRes?.data?.admin_pin || '', lastBackupAt: byKey.settingsRes?.data?.last_backup_at || null },
    drivers: cachedCatalog ? cachedCatalog.drivers : (byKey.driversRes.data || []).map(mapDriver),
    channels: cachedCatalog ? cachedCatalog.channels : (byKey.channelsRes.data || []).map(mapChannel),
    origins: cachedCatalog ? cachedCatalog.origins : (byKey.originsRes.data || []).map(mapOrigin),
    dropPoints: cachedCatalog ? cachedCatalog.dropPoints : (byKey.dropPointsRes.data || []).map(mapDropPoint),
    routes: cachedCatalog ? cachedCatalog.routes : (byKey.routesRes.data || []).map(mapRoute),
    assignments: (byKey.assignmentsRes.data || []).map(mapAssignment),
    assignmentsWindowStart,
    adjustments: (byKey.adjustmentsRes.data || []).map(mapAdjustment),
    statements: (byKey.statementsRes.data || []).map(mapStatement),
    billingAdjustments: (byKey.billingAdjustmentsRes?.data || []).map(mapBillingAdjustment),
    announcements: (byKey.announcementsRes.data || []).map(mapAnnouncement),
    fuelClaims: (byKey.fuelClaimsRes.data || []).map(mapFuelClaim)
  };

  if (!cachedCatalog && remoteCatalogVersion) {
    // 剛才是整包重抓目錄資料，把這次抓到的資料連同版本寫回本地快取，下次
    // 登入版本沒變就吃得到——寫入失敗（例如瀏覽器localStorage被塞滿）不影響
    // 正常運作，純粹放棄這次快取，下次登入照樣會走一樣的判斷、不會壞掉。
    try {
      localStorage.setItem(catalogVersionKey(), remoteCatalogVersion);
      localStorage.setItem(catalogCacheKey(), JSON.stringify({
        drivers: data.drivers, channels: data.channels, origins: data.origins,
        dropPoints: data.dropPoints, routes: data.routes
      }));
    } catch (e) { /* 忽略快取寫入失敗 */ }
  }

  await resolvePhotoUrls(data.assignments);
  await resolveSignatureUrls(data.statements);
  return data;
}

// 補抓 loadAllData() 預設時間窗口之外、更早的車趟資料（見 ASSIGNMENTS_WINDOW_DAYS
// 說明），只補「要求的日期」到「目前已載入的最早日期」這一段缺口，抓回來的資料
// 直接併入 state.data.assignments（依 id 去重，正常不會重疊），並把
// assignmentsWindowStart 往前推——之後再查更早的日期，缺口只會越補越小，
// 不會整批重抓。startDate 已經在目前已載入範圍內時直接跳過，不打資料庫。
async function ensureAssignmentsRange(startDate) {
  if (!startDate) return;
  const windowStart = state.data.assignmentsWindowStart;
  if (!windowStart || startDate >= windowStart) return;
  const supabase = getSupabase();
  const { data, error } = await fetchAllAssignmentPages(() => supabase
    .from('assignments')
    .select('*, assignment_drop_points(*, assignment_drop_point_media(*))')
    .gte('trip_date', startDate)
    .lt('trip_date', windowStart));
  if (error) throw new Error('讀取較早的車趟資料失敗：' + error.message);
  const extra = (data || []).map(mapAssignment);
  await resolvePhotoUrls(extra);
  const existingIds = new Set(state.data.assignments.map(a => a.id));
  extra.forEach(a => { if (!existingIds.has(a.id)) state.data.assignments.push(a); });
  state.data.assignments.sort((a, b) => a.date.localeCompare(b.date));
  state.data.assignmentsWindowStart = startDate;
}

// 首頁待著不動時的背景自動刷新（見 index.html refreshHomeDataIfIdle）原本是
// 每25秒重新呼叫整支 loadAllData()——連夥伴/通路/出發點/路線（含每條路線的
// 全部版本與版本下貨點）這些幾乎不會變動的目錄資料也一起重抓一次。在100位
// 夥伴同時上線的規模下，這代表每25秒就有100個並發連線各自重抓一次幾乎相同
// 的目錄資料，是完全不必要的資料庫負擔。首頁背景刷新真正需要跟上即時狀態
// 的只有車趟資料（請款-薪資即時利潤、今日尚未配送完成），改成只重新抓「這個
// 範圍內」的車趟、直接整段覆蓋（不是像 ensureAssignmentsRange 那樣只補缺口，
// 這裡要的是最新狀態，即使範圍已經載入過也要覆蓋成最新的），範圍外的資料
// 完全不動。
async function refreshAssignmentsRange(start, end) {
  const supabase = getSupabase();
  const { data, error } = await fetchAllAssignmentPages(() => supabase
    .from('assignments')
    .select('*, assignment_drop_points(*, assignment_drop_point_media(*))')
    .gte('trip_date', start)
    .lte('trip_date', end));
  if (error) throw new Error('重新整理車趟資料失敗：' + error.message);
  const fresh = (data || []).map(mapAssignment);
  await resolvePhotoUrls(fresh);
  const outsideRange = state.data.assignments.filter(a => a.date < start || a.date > end);
  state.data.assignments = outsideRange.concat(fresh).sort((a, b) => a.date.localeCompare(b.date));
  if (!state.data.assignmentsWindowStart || start < state.data.assignmentsWindowStart) {
    state.data.assignmentsWindowStart = start;
  }
}

// 薪資結算／請款結算／資料匯出這三個純報表畫面（只讀，不像週期任務清單還要點格子
// 編輯/指派）改成完全不碰 state.data.assignments 共用陣列，查詢當下直接跟
// 資料庫要「這次剛好需要的那一段」，用完就丟（存在呼叫端自己的區域變數，
// 不寫回 state）。這樣畫面停留期間不管查的區間多大，都不會拖到其他任何
// 畫面的效能，也不需要另外用 trimAssignmentsToBaseWindow 收尾。刻意不呼叫
// resolvePhotoUrls——這三個畫面從來不顯示送達照片，省下不必要的 Storage
// 簽名連結請求。
async function fetchAssignmentsInRange(start, end) {
  const supabase = getSupabase();
  const { data, error } = await fetchAllAssignmentPages(() => supabase
    .from('assignments')
    .select('*, assignment_drop_points(*, assignment_drop_point_media(*))')
    .gte('trip_date', start)
    .lte('trip_date', end));
  if (error) throw new Error('讀取車趟資料失敗：' + error.message);
  return (data || []).map(mapAssignment);
}

// ensureAssignmentsRange() 只會往前補資料、從不清掉，如果放著不管，一個
// 主控在同一個session裡多查幾次舊月份薪資、舊區間請款、舊週期任務清單，
// state.data.assignments 會一路累積下去——100夥伴/1000店規模下，查個
// 5、6次舊資料累積起來的量，跟直接抓90天窗口一樣重，等於繞了一圈又
// 繞回原本要解決的問題。查歷史資料本身完全合理（要用就是要能查到），
// 但查完離開那個畫面後，不該一直占用著拖慢其他所有畫面的篩選/掃描
// 效能。這裡把 state.data.assignments 縮回「日常操作真的需要」的基本
// 窗口（今日行程/週期任務清單當週用），離開薪資結算/請款結算/資料匯出/週期任務清單
// 這些「查歷史資料」的分頁時呼叫（見 index.html goTab()），下次要查
// 別的舊資料時 ensureAssignmentsRange() 會重新按需補抓，不影響查詢
// 本身，只是不讓查過的舊資料一直賴著不走。
function trimAssignmentsToBaseWindow() {
  const baseStart = ymd(addDays(todayStr(), -ASSIGNMENTS_WINDOW_DAYS));
  state.data.assignments = state.data.assignments.filter(a => a.date >= baseStart);
  state.data.assignmentsWindowStart = baseStart;
}

async function fetchAssignment(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('assignments').select('*, assignment_drop_points(*, assignment_drop_point_media(*))').eq('id', id).single();
  if (error) throw new Error('讀取車趟失敗：' + error.message);
  const assignment = mapAssignment(data);
  await resolvePhotoUrls([assignment]);
  return assignment;
}

// ---------------- 夥伴 ----------------

async function createDriver(input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drivers').insert({
    name: input.name, phone: input.phone || null, line_user_id: input.lineId || null,
    access_code: String(Math.floor(1000 + Math.random() * 9000)),
    vehicle_plate: input.plate || null, vehicle_type: input.vtype || null, vehicle_load: input.vload || null,
    bank_name: input.bankName || null, bank_branch: input.branch || null,
    bank_account: input.account || null, bank_holder: input.holder || null,
    id_number: input.idNumber || null,
    status: input.status || 'active'
  }).select().single();
  if (error) throw new Error('新增夥伴失敗：' + error.message);
  const driver = mapDriver(data);
  state.data.drivers.push(driver);
  return driver;
}

async function regenerateDriverAccessCode(driverId) {
  const supabase = getSupabase();
  const newCode = String(Math.floor(1000 + Math.random() * 9000));
  const { data, error } = await supabase.from('drivers').update({ access_code: newCode, force_code_reset: true }).eq('id', driverId).select().single();
  if (error) throw new Error('重新產生代碼失敗：' + error.message);
  const driver = state.data.drivers.find(d => d.id === driverId);
  if (driver) { driver.accessCode = data.access_code; driver.forceCodeReset = true; }
}

// 夥伴自己設定新的登入代碼（首次登入，或主控重新產生代碼後）：
// 只有本人（driver_id 來自 JWT）能改自己這一列的 access_code/force_code_reset，
// 改完就把 force_code_reset 清成 false，之後登入不會再被強制要求重設。
async function changeMyAccessCode(driverId, newCode) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drivers')
    .update({ access_code: newCode, force_code_reset: false })
    .eq('id', driverId).select().single();
  if (error) {
    if (error.code === '23505') throw new Error('這組代碼已經有人使用，請換一組。');
    throw new Error('設定新代碼失敗：' + error.message);
  }
  const driver = state.data.drivers.find(d => d.id === driverId);
  if (driver) { driver.accessCode = data.access_code; driver.forceCodeReset = false; }
}

async function deleteOrDeactivateDriver(driverId) {
  const referenced = state.data.assignments.some(a => a.driverId === driverId);
  const supabase = getSupabase();
  if (referenced) {
    const inactiveAt = new Date().toISOString();
    const { error } = await supabase.from('drivers').update({ status: 'inactive', inactive_at: inactiveAt }).eq('id', driverId);
    if (error) throw new Error('停用夥伴失敗：' + error.message);
    const driver = state.data.drivers.find(d => d.id === driverId);
    if (driver) { driver.status = 'inactive'; driver.inactiveAt = inactiveAt; }
    return 'deactivated';
  }
  const { error } = await supabase.from('drivers').delete().eq('id', driverId);
  if (error) throw new Error('刪除夥伴失敗：' + error.message);
  state.data.drivers = state.data.drivers.filter(d => d.id !== driverId);
  return 'deleted';
}

// 夥伴端「我的資料」頁可編輯欄位（跟 schema.sql 裡 app_driver 的欄位權限一致）
async function updateDriverProfile(driverId, fields) {
  const payload = {};
  if ('name' in fields) payload.name = fields.name || null;
  if ('status' in fields) payload.status = fields.status || 'active';
  if ('phone' in fields) payload.phone = fields.phone || null;
  if ('lineId' in fields) payload.line_user_id = fields.lineId || null;
  if ('plate' in fields) payload.vehicle_plate = fields.plate || null;
  if ('vtype' in fields) payload.vehicle_type = fields.vtype || null;
  if ('vload' in fields) payload.vehicle_load = fields.vload || null;
  if ('bankName' in fields) payload.bank_name = fields.bankName || null;
  if ('branch' in fields) payload.bank_branch = fields.branch || null;
  if ('account' in fields) payload.bank_account = fields.account || null;
  if ('holder' in fields) payload.bank_holder = fields.holder || null;
  if ('idNumber' in fields) payload.id_number = fields.idNumber || null;
  // 職業工會欄位只有主控（admin）能改，夥伴端欄位權限（schema.sql）沒有開放這兩欄。
  if ('unionInsured' in fields) payload.union_insured = !!fields.unionInsured;
  if ('unionProofPath' in fields) payload.union_proof_path = fields.unionProofPath || null;
  // 勞報單勞務名稱（空白＝用預設）：只有主控能改，月結確認時才凍結進 statements.service_name。
  if ('serviceName' in fields) payload.service_name = (fields.serviceName || '').trim() || null;
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drivers').update(payload).eq('id', driverId).select().single();
  if (error) throw new Error('更新資料失敗：' + error.message);
  const idx = state.data.drivers.findIndex(d => d.id === driverId);
  if (idx >= 0) state.data.drivers[idx] = mapDriver(data);
}

// ---------------- 通路 ----------------

function channelPayload(input) {
  return {
    name: input.name, period_type: input.periodType, start_day: input.startDay,
    end_day: input.periodType === 'custom' ? input.endDay : null,
    formula_type: input.formulaType, rate_km: input.rateKm, rate_point: input.ratePoint, flat_amount: input.flatAmount,
    tax_mode: input.taxMode || 'inclusive'
  };
}

async function createChannel(input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('channels').insert({ ...channelPayload(input), status: 'active' }).select().single();
  if (error) throw new Error('新增通路失敗：' + error.message);
  const channel = mapChannel(data);
  state.data.channels.push(channel);
  return channel;
}

async function updateChannel(channelId, input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('channels').update(channelPayload(input)).eq('id', channelId).select().single();
  if (error) throw new Error('更新通路失敗：' + error.message);
  const idx = state.data.channels.findIndex(c => c.id === channelId);
  if (idx >= 0) state.data.channels[idx] = mapChannel(data);
}

async function deleteOrDeactivateChannel(channelId) {
  const referenced = state.data.dropPoints.some(dp => dp.channelId === channelId) ||
    state.data.assignments.some(a => a.dropPoints.some(dp => dp.channelId === channelId));
  const supabase = getSupabase();
  if (referenced) {
    const { error } = await supabase.from('channels').update({ status: 'inactive' }).eq('id', channelId);
    if (error) throw new Error('停用通路失敗：' + error.message);
    const ch = state.data.channels.find(c => c.id === channelId);
    if (ch) ch.status = 'inactive';
    return 'deactivated';
  }
  const { error } = await supabase.from('channels').delete().eq('id', channelId);
  if (error) throw new Error('刪除通路失敗：' + error.message);
  state.data.channels = state.data.channels.filter(c => c.id !== channelId);
  return 'deleted';
}

// 客戶專屬瀏覽網頁用的權杖：一長串隨機亂碼，知道網址（含這組權杖）就能看，
// 不需要帳號密碼。可以重新產生（會讓舊連結失效，例如合作終止或連結外流時用）。
async function regenerateChannelAccessToken(channelId) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('');
  const supabase = getSupabase();
  const { error } = await supabase.from('channels').update({ access_token: token }).eq('id', channelId);
  if (error) throw new Error('產生客戶連結失敗：' + error.message);
  const ch = state.data.channels.find(c => c.id === channelId);
  if (ch) ch.accessToken = token;
  return token;
}

// ---------------- 出發點 ----------------

async function createOrigin(input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('origins').insert({ address: input.address, label: input.label || null, status: 'active' }).select().single();
  if (error) throw new Error('新增出發點失敗：' + error.message);
  const origin = mapOrigin(data);
  state.data.origins.push(origin);
  return origin;
}

// 路線名稱（例如「三洋工業零件中心 第一車 上午」）是新增路線當下把出發點
// 名稱直接寫死存成文字，不會跟著出發點改名自動更新——如果只改 origins
// 這張表，底下已存在的路線名稱會卡在改名前的舊字，變成到處都看得到卻
// 改不掉的舊名字（夥伴端、週期任務清單、請款結算、薪資結算配送明細都顯示路線
// 名稱）。所以出發點改名時，這裡一併把底下每一條路線的名稱依「現在的
// label＋自己的 seq/shift」重新組一次、寫回去，不是只把舊字串換成新字串
// ——這樣不管路線名稱原本是用哪個舊名組出來的，改完都保證跟出發點同步。
async function updateOrigin(originId, input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('origins').update({ address: input.address, label: input.label || null }).eq('id', originId).select().single();
  if (error) throw new Error('更新出發點失敗：' + error.message);
  const origin = mapOrigin(data);
  const idx = state.data.origins.findIndex(o => o.id === originId);
  if (idx >= 0) state.data.origins[idx] = origin;

  const { data: routeRows, error: routesErr } = await supabase.from('routes').select('id, seq, shift').eq('origin_id', originId);
  if (routesErr) throw new Error('讀取路線失敗：' + routesErr.message);
  const label = origin.label || origin.address;
  for (const r of routeRows || []) {
    const newName = `${label} ${r.seq} ${r.shift === 'AM' ? '上午' : '下午'}`;
    const { error: renameErr } = await supabase.from('routes').update({ name: newName }).eq('id', r.id);
    if (renameErr) throw new Error('同步路線名稱失敗：' + renameErr.message);
    const localRoute = state.data.routes.find(x => x.id === r.id);
    if (localRoute) localRoute.name = newName;
  }
}

async function deleteOrDeactivateOrigin(originId) {
  const origin = state.data.origins.find(o => o.id === originId);
  const referenced = origin && state.data.routes.some(r => r.originAddr === origin.address);
  const supabase = getSupabase();
  if (referenced) {
    const { error } = await supabase.from('origins').update({ status: 'inactive' }).eq('id', originId);
    if (error) throw new Error('停用出發點失敗：' + error.message);
    origin.status = 'inactive';
    return 'deactivated';
  }
  const { error } = await supabase.from('origins').delete().eq('id', originId);
  if (error) throw new Error('刪除出發點失敗：' + error.message);
  state.data.origins = state.data.origins.filter(o => o.id !== originId);
  return 'deleted';
}

// ---------------- 下貨點 ----------------

async function createDropPoint(input) {
  const code = (input.code || '').trim();
  if (code) {
    const dupCode = state.data.dropPoints.find(dp => dp.status !== 'inactive' && dp.channelId === input.channelId && (dp.code || '').trim().toLowerCase() === code.toLowerCase());
    if (dupCode) throw new Error(`代號重複，同一通路（${channelName(input.channelId)}）已經有代號「${dupCode.code}」的下貨點：「${dupCode.address}」，已取消新增。`);
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drop_points').insert({
    address: input.address, channel_id: input.channelId, code: input.code || null, status: 'active'
  }).select().single();
  if (error) throw new Error('新增下貨點失敗：' + error.message);
  const dp = mapDropPoint(data);
  state.data.dropPoints.push(dp);
  return dp;
}

async function updateDropPoint(dpId, input) {
  const code = (input.code || '').trim();
  if (code) {
    const dupCode = state.data.dropPoints.find(x => x.id !== dpId && x.status !== 'inactive' && x.channelId === input.channelId && (x.code || '').trim().toLowerCase() === code.toLowerCase());
    if (dupCode) throw new Error(`代號重複，同一通路（${channelName(input.channelId)}）已經有代號「${dupCode.code}」的下貨點：「${dupCode.address}」，已取消儲存。`);
  }
  const supabase = getSupabase();
  const prev = state.data.dropPoints.find(x => x.id === dpId);
  const channelChanged = prev && prev.channelId !== input.channelId;
  const { data, error } = await supabase.from('drop_points').update({
    address: input.address, channel_id: input.channelId, code: input.code || null
  }).eq('id', dpId).select().single();
  if (error) throw new Error('更新下貨點失敗：' + error.message);
  const idx = state.data.dropPoints.findIndex(x => x.id === dpId);
  if (idx >= 0) state.data.dropPoints[idx] = mapDropPoint(data);

  // 通路（所屬分類）改變時，同步套用到「所有」引用這個下貨點的車趟快照
  // （不分完成與否——請款明細/配送紀錄一律依下貨點資料庫目前的分類顯示）。
  // 已完成的車趟，資料庫那邊（見 sync_drop_point_channel()）也會一併補算
  // 一次請款拆賬金額，這裡重新抓一次那些車趟同步最新的金額快照；夥伴費用
  // 不受影響。
  if (channelChanged) {
    const { error: syncErr } = await supabase.rpc('sync_drop_point_channel', { p_drop_point_id: dpId, p_channel_id: input.channelId });
    if (syncErr) console.error('同步下貨點通路失敗', syncErr.message);
    else {
      const completedIds = [];
      state.data.assignments.forEach(a => {
        const touched = a.dropPoints.some(dp => dp.sourceDpId === dpId);
        if (!touched) return;
        a.dropPoints.forEach(dp => { if (dp.sourceDpId === dpId) dp.channelId = input.channelId; });
        if (a.status === 'completed') completedIds.push(a.id);
      });
      for (const aid of completedIds) {
        const idx = state.data.assignments.findIndex(x => x.id === aid);
        if (idx >= 0) state.data.assignments[idx] = await fetchAssignment(aid);
      }
    }
  }
}

async function deleteOrDeactivateDropPoint(dpId) {
  const referenced = state.data.routes.some(r => r.versions.some(v => (v.dropPointIds || []).includes(dpId))) ||
    state.data.assignments.some(a => a.dropPoints.some(dp => dp.sourceDpId === dpId));
  const supabase = getSupabase();
  if (referenced) {
    const { error } = await supabase.from('drop_points').update({ status: 'inactive' }).eq('id', dpId);
    if (error) throw new Error('停用下貨點失敗：' + error.message);
    const dp = state.data.dropPoints.find(x => x.id === dpId);
    if (dp) dp.status = 'inactive';
    return 'deactivated';
  }
  const { error } = await supabase.from('drop_points').delete().eq('id', dpId);
  if (error) throw new Error('刪除下貨點失敗：' + error.message);
  state.data.dropPoints = state.data.dropPoints.filter(x => x.id !== dpId);
  return 'deleted';
}

// ---------------- 路線與版本 ----------------

async function createRoute(input) {
  const origin = state.data.origins.find(o => o.address === input.originAddr);
  if (!origin) throw new Error('找不到對應的出發點');
  const supabase = getSupabase();
  const { data, error } = await supabase.from('routes')
    .insert({ name: input.name, origin_id: origin.id, seq: input.seq, shift: input.shift, region: input.region || null })
    .select('*, origins(address), route_versions(*, route_version_points(*))')
    .single();
  if (error) throw new Error('新增路線失敗：' + error.message);
  const route = mapRoute(data);
  state.data.routes.push(route);
  return route;
}

async function updateRouteRegion(routeId, region) {
  const supabase = getSupabase();
  const { error } = await supabase.from('routes').update({ region: region || null }).eq('id', routeId);
  if (error) throw new Error('更新地區失敗：' + error.message);
  const route = state.data.routes.find(r => r.id === routeId);
  if (route) route.region = region || '';
}

async function deleteRoute(routeId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('routes').delete().eq('id', routeId);
  if (error) throw new Error('刪除路線失敗：' + error.message);
  state.data.routes = state.data.routes.filter(r => r.id !== routeId);
}

// 請款拆賬公式：扣除「整趟固定金額」通路後，剩餘金額依各通路的下貨點數
// 比例分攤（不是依實際跑一趟的公里數重新套公式，因為請款總額本身已經是
// 人工填寫好的數字）。用最大餘數法分配捨入誤差，確保拆出來的金額加總
// 一定等於請款總額，不會有零頭對不起來的問題。
function computeChannelSplitByStoreCount(dropPointIds, billingTotal) {
  const countByChannel = {};
  (dropPointIds || []).forEach(id => {
    const dp = state.data.dropPoints.find(x => x.id === id);
    if (!dp) return;
    countByChannel[dp.channelId] = (countByChannel[dp.channelId] || 0) + 1;
  });
  const byChannel = {};
  let flatTotal = 0;
  const poolIds = [];
  Object.keys(countByChannel).forEach(cid => {
    const ch = state.data.channels.find(c => c.id === cid);
    if (ch && ch.formulaType === 'flat_per_trip') {
      const amt = Math.round(Number(ch.flatAmount) || 0);
      byChannel[cid] = amt;
      flatTotal += amt;
    } else {
      poolIds.push(cid);
    }
  });
  const remaining = (Number(billingTotal) || 0) - flatTotal;
  const poolCount = poolIds.reduce((s, cid) => s + countByChannel[cid], 0);
  if (poolCount > 0) {
    const exact = poolIds.map(cid => remaining * countByChannel[cid] / poolCount);
    const floors = exact.map(Math.floor);
    const distributed = floors.reduce((s, v) => s + v, 0);
    let leftover = Math.round(remaining - distributed);
    const order = poolIds.map((cid, i) => ({ cid, frac: exact[i] - floors[i] })).sort((a, b) => b.frac - a.frac);
    const finalAmt = {};
    poolIds.forEach((cid, i) => { finalAmt[cid] = floors[i]; });
    for (let i = 0; i < leftover && order.length; i++) { finalAmt[order[i % order.length].cid] += 1; }
    poolIds.forEach(cid => { byChannel[cid] = finalAmt[cid]; });
  } else {
    poolIds.forEach(cid => { byChannel[cid] = 0; });
  }
  return byChannel;
}

// 對應 demo 的 saveRouteVersion() + recomputeRouteVersionEnds()：
// 新增/覆寫一個版本的下貨點順序後，重新計算這條路線所有版本的生效區間
// （每個版本的 end = 下一個版本 start 前一天，最後一個版本 end = null）。
// finance = { distanceKm, driverFare, billingTotal } 是這個版本人工填寫的
// 里程／夥伴費用／請款總額；請款總額依通路自動拆賬，算好的結果一併存起來，
// 之後這個版本底下每一趟車建立時都直接複製這份快照，不用每趟重算。
async function saveRouteVersion(routeId, newStart, dropPointIds, finance) {
  const route = state.data.routes.find(r => r.id === routeId);
  if (!route) throw new Error('找不到路線');
  const supabase = getSupabase();

  // 拆賬金額改成人工輸入（見 index.html renderRouteDetail 的 rvSplitInputs），
  // 這裡直接採用呼叫端給的數字；只有在完全沒給的情況下才退回自動依店數比例算一次。
  const billingByChannel = (finance && finance.billingByChannel && Object.keys(finance.billingByChannel).length)
    ? finance.billingByChannel
    : computeChannelSplitByStoreCount(dropPointIds, finance?.billingTotal);
  const financePayload = {
    distance_km: finance?.distanceKm === '' || finance?.distanceKm == null ? null : Number(finance.distanceKm),
    driver_fare: finance?.driverFare === '' || finance?.driverFare == null ? null : Number(finance.driverFare),
    billing_total: finance?.billingTotal === '' || finance?.billingTotal == null ? null : Number(finance.billingTotal),
    billing_by_channel: billingByChannel
  };

  let version = route.versions.find(v => v.start === newStart);
  if (version) {
    const { error: delErr } = await supabase.from('route_version_points').delete().eq('route_version_id', version.id);
    if (delErr) throw new Error('更新路線版本失敗：' + delErr.message);
    const { error: updErr } = await supabase.from('route_versions').update(financePayload).eq('id', version.id);
    if (updErr) throw new Error('更新路線版本費用失敗：' + updErr.message);
  } else {
    const { data: newVer, error: insErr } = await supabase.from('route_versions')
      .insert({ route_id: routeId, start_date: newStart, ...financePayload }).select().single();
    if (insErr) throw new Error('建立路線版本失敗：' + insErr.message);
    version = { id: newVer.id, start: newStart, end: null, origin: route.originAddr, dropPointIds: [] };
    route.versions.push(version);
  }

  if (dropPointIds.length) {
    const rows = dropPointIds.map((dpId, i) => ({ route_version_id: version.id, drop_point_id: dpId, sequence_no: i + 1 }));
    const { error: pointsErr } = await supabase.from('route_version_points').insert(rows);
    if (pointsErr) throw new Error('儲存下貨點順序失敗：' + pointsErr.message);
  }
  version.dropPointIds = dropPointIds;
  version.distanceKm = financePayload.distance_km;
  version.driverFare = financePayload.driver_fare;
  version.billingTotal = financePayload.billing_total;
  version.billingByChannel = billingByChannel;

  const sorted = [...route.versions].sort((a, b) => a.start.localeCompare(b.start));
  const updates = [];
  sorted.forEach((v, i) => {
    const newEnd = (i < sorted.length - 1) ? ymd(addDays(sorted[i + 1].start, -1)) : null;
    if (v.end !== newEnd) { v.end = newEnd; updates.push({ id: v.id, end_date: newEnd }); }
  });
  route.versions = sorted;
  for (const u of updates) {
    const { error } = await supabase.from('route_versions').update({ end_date: u.end_date }).eq('id', u.id);
    if (error) throw new Error('更新路線版本區間失敗：' + error.message);
  }
}

// 路線版本臨時更新（例如訂正下貨點順序、修正拆賬）時，週期任務清單裡已經排好、
// 但還沒開始/還沒完成的未來車趟，不會自動跟著變——建立車趟當下就把內容複製
// 成快照了（見 createAssignment）。這裡是選配的「一鍵套用」：找出這條路線
// 所有還沒完成（scheduled/in_progress）、日期落在新版本生效範圍內的車趟，
// 把下貨點清單、里程、夥伴費用、請款拆賬全部重新套用成當時該生效版本的
// 內容，夥伴／日期／車次都不動。已完成的車趟本來就凍結（付過的夥伴費用、
// 請款金額都不該回頭被重算），不在套用範圍內。
async function regenerateFutureAssignments(routeId, fromDate) {
  const route = state.data.routes.find(r => r.id === routeId);
  if (!route) throw new Error('找不到路線');
  const supabase = getSupabase();
  const targets = state.data.assignments.filter(a =>
    a.routeId === routeId && a.date >= fromDate && (a.status === 'scheduled' || a.status === 'in_progress'));
  let updated = 0;
  for (const a of targets) {
    const version = route.versions.find(v => a.date >= v.start && (!v.end || a.date <= v.end));
    if (!version) continue;
    const dropPointIds = version.dropPointIds || [];
    const { error: delErr } = await supabase.from('assignment_drop_points').delete().eq('assignment_id', a.id);
    if (delErr) throw new Error('清除舊下貨點失敗：' + delErr.message);
    if (dropPointIds.length) {
      const rows = dropPointIds.map((dpId, i) => {
        const dp = state.data.dropPoints.find(x => x.id === dpId);
        return { assignment_id: a.id, source_drop_point_id: dpId, address: dp?.address || '', code: dp?.code || null, channel_id: dp?.channelId || null, sequence_no: i + 1 };
      });
      const { error: insErr } = await supabase.from('assignment_drop_points').insert(rows);
      if (insErr) throw new Error('寫入新下貨點失敗：' + insErr.message);
    }
    const { error: updErr } = await supabase.from('assignments').update({
      distance_km: version.distanceKm ?? null,
      fare: version.driverFare ?? 0,
      billing_total_snapshot: version.billingTotal ?? null,
      billing_by_channel_snapshot: version.billingByChannel ?? null
    }).eq('id', a.id);
    if (updErr) throw new Error('更新車趟資料失敗：' + updErr.message);
    updated++;
  }
  for (const a of targets) {
    const idx = state.data.assignments.findIndex(x => x.id === a.id);
    if (idx >= 0) state.data.assignments[idx] = await fetchAssignment(a.id);
  }
  return { updated, total: targets.length };
}

// ---------------- 車趟指派與生命週期 ----------------

// 夥伴費用／里程／請款金額不再由排班時人工輸入，改成直接複製路線當時生效
// 版本裡已經填好的數字（見 saveRouteVersion 的 finance 參數）。找不到生效版本
// 或版本還沒填費用時，就先以 0/null 建立，之後可以在路線管理補上再重新產生車趟，
// 或於車趟管理個別調整（見 updateAssignmentFinance，供例外狀況覆寫用）。
async function createAssignment(input) {
  const route = state.data.routes.find(r => r.id === input.routeId);
  if (!route) throw new Error('找不到路線');
  const version = route.versions.find(v => input.date >= v.start && (!v.end || input.date <= v.end));
  const dropPointIds = version ? version.dropPointIds : [];

  // fare 可在排班當下手動填「調整金額」覆寫路線版本的夥伴費用（例如這一趟臨時加點、
  // 繞遠路），留空則沿用版本預設值，跟 updateAssignmentFinance() 事後覆寫是同一個欄位。
  const fareOverride = input.fare !== undefined && input.fare !== '' && input.fare !== null ? Number(input.fare) : null;
  const supabase = getSupabase();
  const { data: assignRow, error } = await supabase.from('assignments').insert({
    trip_date: input.date, route_id: input.routeId, driver_id: input.driverId,
    origin_snapshot: route.originAddr || '',
    fare: fareOverride ?? (version?.driverFare ?? 0),
    distance_km: version?.distanceKm ?? null,
    billing_total_snapshot: version?.billingTotal ?? null,
    billing_by_channel_snapshot: version?.billingByChannel ?? null,
    // 本週（含以前）的車趟排好就生效；之後週次的車趟先是草稿（只有主控看得到），按「發佈」才開放給夥伴。
    published: input.published ?? (input.date <= getWeekDates(0)[6]),
    status: 'scheduled'
  }).select().single();
  if (error) throw new Error('建立車趟失敗：' + error.message);

  if (dropPointIds.length) {
    const rows = dropPointIds.map((dpId, i) => {
      const dp = state.data.dropPoints.find(x => x.id === dpId);
      return { assignment_id: assignRow.id, source_drop_point_id: dpId, address: dp?.address || '', code: dp?.code || null, channel_id: dp?.channelId || null, sequence_no: i + 1 };
    });
    const { error: pointsErr } = await supabase.from('assignment_drop_points').insert(rows);
    if (pointsErr) throw new Error('建立車趟下貨點失敗：' + pointsErr.message);
  }

  const full = await fetchAssignment(assignRow.id);
  state.data.assignments.push(full);
  return full;
}

// ---------------- 週期任務清單：下週自動延續本週＋發佈 ----------------
// 發佈：未來週次的車趟預設是草稿（published=false，夥伴端 RLS 看不到），主控排完按「發佈」才開放。
// 自動延續：每週第一次打開週期任務清單時，如果下週還沒補過（schedule_rollovers 沒有紀錄）且下週是空的，
// 就把本週每一格（路線＋夥伴＋星期幾）複製到下週，一律是草稿。先寫入紀錄再複製，之後刪掉哪格都不會再補回來。
async function publishWeek(start, end) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').update({ published: true })
    .gte('trip_date', start).lte('trip_date', end).eq('published', false);
  if (error) throw new Error('發佈失敗：' + error.message);
  state.data.assignments.forEach(a => { if (a.date >= start && a.date <= end) a.published = true; });
}

async function rolloverNextWeekIfNeeded() {
  const thisWeek = getWeekDates(0), nextWeek = getWeekDates(1);
  const nextStart = nextWeek[0], nextEnd = nextWeek[6];
  if (state._rolloverChecked === nextStart) return null;
  state._rolloverChecked = nextStart;
  const supabase = getSupabase();
  const { data: rec, error: recErr } = await supabase.from('schedule_rollovers').select('week_start').eq('week_start', nextStart);
  if (recErr || (rec && rec.length)) return null;
  const { error: claimErr } = await supabase.from('schedule_rollovers').insert({ week_start: nextStart });
  if (claimErr) return null; // 別的裝置剛好先補了，或寫入失敗：不重複做
  if (state.data.assignments.some(a => a.date >= nextStart && a.date <= nextEnd)) return { created: 0, alreadyHadTrips: true };

  const created = [];
  let skipped = 0;
  try {
  // 本週來源（精簡欄位，分頁避開1000筆上限）
  const src = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('assignments').select('route_id, driver_id, trip_date, status')
      .gte('trip_date', thisWeek[0]).lte('trip_date', thisWeek[6]).neq('status', 'cancelled').order('id').range(from, from + 999);
    if (error) throw new Error('讀取本週期任務清單失敗：' + error.message);
    src.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const activeDrivers = new Set(state.data.drivers.filter(d => d.status === 'active').map(d => d.id));
  const rows = [];
  const seen = new Set();
  src.forEach(x => {
    const route = state.data.routes.find(r => r.id === x.route_id);
    const date = ymd(addDays(x.trip_date, 7));
    const key = x.route_id + '|' + date;
    if (!route || !activeDrivers.has(x.driver_id) || seen.has(key)) { skipped++; return; }
    seen.add(key);
    const version = route.versions.find(v => date >= v.start && (!v.end || date <= v.end));
    rows.push({
      row: {
        trip_date: date, route_id: x.route_id, driver_id: x.driver_id, origin_snapshot: route.originAddr || '',
        fare: version?.driverFare ?? 0, distance_km: version?.distanceKm ?? null,
        billing_total_snapshot: version?.billingTotal ?? null, billing_by_channel_snapshot: version?.billingByChannel ?? null,
        published: false, status: 'scheduled'
      },
      dropPointIds: version ? version.dropPointIds : []
    });
  });
  // 分批新增車趟，再分批新增每趟的下貨點。
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { data, error } = await supabase.from('assignments').insert(chunk.map(c => c.row)).select('id, route_id, trip_date');
    if (error) throw new Error('延續下週期任務清單失敗：' + error.message);
    chunk.forEach(c => {
      const hit = (data || []).find(d => d.route_id === c.row.route_id && d.trip_date === c.row.trip_date);
      if (hit) created.push({ id: hit.id, dropPointIds: c.dropPointIds });
    });
  }
  const pointRows = [];
  created.forEach(c => c.dropPointIds.forEach((dpId, i) => {
    const dp = state.data.dropPoints.find(x => x.id === dpId);
    pointRows.push({ assignment_id: c.id, source_drop_point_id: dpId, address: dp?.address || '', code: dp?.code || null, channel_id: dp?.channelId || null, sequence_no: i + 1 });
  }));
  for (let i = 0; i < pointRows.length; i += 500) {
    const { error } = await supabase.from('assignment_drop_points').insert(pointRows.slice(i, i + 500));
    if (error) throw new Error('延續下週期任務清單的下貨點失敗：' + error.message);
  }
  await supabase.from('schedule_rollovers').update({ created_count: created.length }).eq('week_start', nextStart);
  } catch (err) {
    // 中途失敗：把已建立的半成品車趟清掉（下貨點隨車趟一併刪除）並放掉「已補過」記錄，下次打開會重新嘗試。
    try {
      for (let i = 0; i < created.length; i += 200) await supabase.from('assignments').delete().in('id', created.slice(i, i + 200).map(c => c.id));
      await supabase.from('schedule_rollovers').delete().eq('week_start', nextStart);
    } catch (e2) { console.error('清理失敗的延續紀錄時出錯', e2); }
    throw err;
  }
  // 把新建的下週車趟讀進記憶體（含下貨點）
  const { data: full, error: fullErr } = await fetchAllAssignmentPages(() => supabase.from('assignments')
    .select('*, assignment_drop_points(*, assignment_drop_point_media(*))').gte('trip_date', nextStart).lte('trip_date', nextEnd));
  if (fullErr) throw new Error('讀取下週期任務清單失敗：' + fullErr.message);
  const have = new Set(state.data.assignments.map(a => a.id));
  (full || []).map(mapAssignment).forEach(a => { if (!have.has(a.id)) state.data.assignments.push(a); });
  state.data.assignments.sort((a, b) => a.date.localeCompare(b.date));
  return { created: created.length, skipped };
}

async function deleteAssignment(assignmentId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').delete().eq('id', assignmentId);
  if (error) throw new Error('刪除車趟失敗：' + error.message);
  state.data.assignments = state.data.assignments.filter(a => a.id !== assignmentId);
}

// 臨時異動：已排定或已出發的車趟需要臨時換夥伴（例如原本排定的夥伴臨時請假），
// 不用刪除重建整趟車趟（那樣會遺失已經拍的照片、下貨點順序等資料）。
// 已完成的車趟不開放異動，維持「完成即封存」的設計。
async function reassignAssignmentDriver(assignmentId, newDriverId) {
  const a = state.data.assignments.find(x => x.id === assignmentId);
  if (a && a.status === 'completed') throw new Error('已完成的車趟不可異動夥伴。');
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').update({ driver_id: newDriverId }).eq('id', assignmentId);
  if (error) throw new Error('換夥伴失敗：' + error.message);
  if (a) a.driverId = newDriverId;
}

async function markAssignmentDeparted(assignmentId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').update({ status: 'in_progress' }).eq('id', assignmentId);
  if (error) throw new Error('更新狀態失敗：' + error.message);
  const a = state.data.assignments.find(x => x.id === assignmentId);
  if (a) a.status = 'in_progress';
}

// issueNote 有值代表「尚有下貨點未拍照回報」時夥伴填寫的原因說明，跟 demo 的
// 「完成本趟」流程一致：同一次操作把 status/has_issue/issue_note 一起送出。
// 完成時間（completed_at）與夥伴報酬凍結快照（payroll_fare_snapshot）由資料庫
// 觸發器自動處理；請款金額不再自動計算，改由主控在車趟管理裡人工輸入
// （見 updateAssignmentFinance()），這裡送出後重新抓一次該筆車趟同步最新狀態。
async function markAssignmentComplete(assignmentId, issueNote) {
  const payload = { status: 'completed' };
  if (issueNote) { payload.has_issue = true; payload.issue_note = issueNote; }
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').update(payload).eq('id', assignmentId);
  if (error) throw new Error('完成車趟失敗：' + error.message);

  const full = await fetchAssignment(assignmentId);
  const idx = state.data.assignments.findIndex(x => x.id === assignmentId);
  if (idx >= 0) state.data.assignments[idx] = full;
  return full;
}

// 車趟管理的人工輸入：夥伴費用、里程、各通路請款金額都由主控直接 key in，
// 不再依公里數/下貨點數套公式換算。billingByChannel 是 {channelId: amount} 的物件，
// 只需要包含這趟車實際牽涉到的通路；總額在這裡直接加總，不留給資料庫算。
async function updateAssignmentFinance(assignmentId, { fare, distanceKm, billingByChannel }) {
  const total = Object.values(billingByChannel || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').update({
    fare, distance_km: distanceKm,
    billing_total_snapshot: total,
    billing_by_channel_snapshot: billingByChannel
  }).eq('id', assignmentId);
  if (error) throw new Error('儲存費用失敗：' + error.message);

  const a = state.data.assignments.find(x => x.id === assignmentId);
  if (a) {
    a.fare = Number(fare) || 0;
    a.distanceKm = distanceKm === '' || distanceKm == null ? null : Number(distanceKm);
    a.billingSnapshot = { totalAmount: total, totalPoints: a.dropPoints.length, byChannel: billingByChannel };
  }
}

async function uploadDropPointPhoto(assignmentId, dropPointId, dataUrl) {
  const { bytes, contentType } = dataUrlToBytesAndType(dataUrl);
  const path = `${assignmentId}/${dropPointId}.jpg`;
  const supabase = getSupabase();
  // upsert:true 讓同一個下貨點重複呼叫這個函式時（夥伴「重新拍照」）直接覆蓋掉
  // 同一個路徑的舊照片，不需要另外處理刪除舊檔——這也是「重新拍照」能重用這支
  // 既有函式、不用另外寫一支的原因。
  const { error: upErr } = await supabase.storage.from('assignment-photos').upload(path, bytes, { contentType, upsert: true });
  if (upErr) throw new Error('照片上傳失敗：' + upErr.message);

  const assignment = state.data.assignments.find(a => a.id === assignmentId);
  const dp = assignment?.dropPoints.find(x => x.id === dropPointId);

  const completedAt = new Date().toISOString();
  // 補拍照片代表這個下貨點其實送達了，之前選的未配達原因（如果有）就不成立，
  // 一起清掉，避免畫面同時顯示「已送達」又掛著一個舊的未配達原因標籤。
  const { error: updErr } = await supabase.from('assignment_drop_points')
    .update({ status: 'completed', photo_url: path, completed_at: completedAt, issue_reason: null })
    .eq('id', dropPointId);
  if (updErr) throw new Error('更新下貨點狀態失敗：' + updErr.message);

  if (dp) { dp.status = 'completed'; dp.photoPath = path; dp.photo = dataUrl; dp.issueReason = null; }
}

// 未配達原因：夥伴在單一下貨點旁邊直接選填，不用等到整趟結束才填一個籠統的
// 備註。設定原因不代表這個下貨點「完成」（status 還是 pending，沒有送達
// 證明照），只是有了解釋；主控端在「完成本趟」的判斷跟畫面顯示都會把它
// 當作「已處理」看待。
async function setDropPointIssueReason(assignmentId, dropPointId, reason) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignment_drop_points').update({ issue_reason: reason }).eq('id', dropPointId);
  if (error) throw new Error('儲存未配達原因失敗：' + error.message);
  const a = state.data.assignments.find(x => x.id === assignmentId);
  const dp = a?.dropPoints.find(x => x.id === dropPointId);
  if (dp) dp.issueReason = reason;
}

// 附加媒體（多張照片／影片）：跟主要送達證明照是分開的一張表，一個下貨點可以有
// 很多筆，不會互相覆蓋。items 是呼叫端（index.html）已經處理好的
// [{bytes, contentType, mediaType}, ...]，圖片已經過 compressImageFile 壓縮、
// 影片則是原始檔案位元組（不做壓縮）。
// 路徑第一層資料夾一定要是 assignmentId（跟 uploadDropPointPhoto 用同一套規則），
// Storage 的 RLS policy 是用路徑第一層資料夾比對夥伴是否為這張 assignment 的
// 車手——之前這裡路徑是 extra/xxx（第一層資料夾是字面上的"extra"，比對不到
// 任何 assignment），導致附加照片上傳100%被RLS擋下、報「new row violates
// row-level security policy」。
async function uploadDropPointMedia(assignmentId, dropPointId, items) {
  if (!items || !items.length) return [];
  const supabase = getSupabase();
  const uploaded = [];
  for (const item of items) {
    const ext = item.mediaType === 'video' ? 'mp4' : 'jpg';
    const path = `${assignmentId}/extra/${dropPointId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from('assignment-photos').upload(path, item.bytes, { contentType: item.contentType, upsert: false });
    if (upErr) throw new Error('附加媒體上傳失敗：' + upErr.message);
    const { data, error: insErr } = await supabase.from('assignment_drop_point_media')
      .insert({ assignment_drop_point_id: dropPointId, media_url: path, media_type: item.mediaType })
      .select().single();
    if (insErr) throw new Error('附加媒體紀錄失敗：' + insErr.message);
    uploaded.push({ id: data.id, path, type: item.mediaType, url: null });
  }
  for (const a of state.data.assignments) {
    const dp = a.dropPoints.find(x => x.id === dropPointId);
    if (dp) { if (!dp.media) dp.media = []; dp.media.push(...uploaded); break; }
  }
  const { data: signed, error: signErr } = await supabase.storage
    .from('assignment-photos')
    .createSignedUrls(uploaded.map(u => u.path), 60 * 60 * 24 * 7);
  if (signErr) console.error('取得附加媒體連結失敗', signErr.message);
  else signed.forEach((s, i) => { uploaded[i].url = s?.signedUrl || null; });
  return uploaded;
}

async function bulkDeleteAssignments(ids) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').delete().in('id', ids);
  if (error) throw new Error('刪除資料失敗：' + error.message);
  const idSet = new Set(ids);
  state.data.assignments = state.data.assignments.filter(a => !idSet.has(a.id));
}

// 只用在「資料匯出」頁刪除已經匯出備份的歷史路線版本（route_versions，
// end_date不是null，代表已被新版本取代、不是目前生效中的版本）。刪除
// route_versions會連動cascade刪掉route_version_points，不會動到routes
// 本身或目前生效的版本。呼叫端(renderExport)已經保證ids只會是已結束的
// 版本，這裡不用再檢查一次。
async function bulkDeleteRouteVersions(ids) {
  const supabase = getSupabase();
  const { error } = await supabase.from('route_versions').delete().in('id', ids);
  if (error) throw new Error('刪除資料失敗：' + error.message);
  const idSet = new Set(ids);
  state.data.routes.forEach(r => { r.versions = r.versions.filter(v => !idSet.has(v.id)); });
}

// ---------------- 薪資調整項 / 月結對帳單 ----------------

// 調整項可以帶日期（input.date）：區間勞報單依日期把調整項歸入期間；沒帶日期的（舊資料或
// 純月結用）視為該月1日。已被任何勞報單（月結或區間）涵蓋的日期不能再新增調整項。
async function createAdjustment(input) {
  const date = input.date || null;
  const month = date ? date.slice(0, 7) : input.month;
  // 代墊款（發票）要跟著區間勞報單依日期拆分，一定要有日期；其他調整項日期選填（沒填視為該月1日）。
  if (input.type === 'reimbursement' && !date) throw new Error('代墊款請填「調整項日期」（用發票日期），區間勞報單才會依日期歸入正確的期間。');
  const covered = findCoveringStatement(input.driverId, date || (month + '-01'));
  if (covered) throw new Error(`${date || month} 已經被勞報單（${statementLabel(covered)}）涵蓋並凍結，無法再新增調整項。如需調整請先收回那份勞報單。`);
  const supabase = getSupabase();
  const { data, error } = await supabase.from('adjustments').insert({
    driver_id: input.driverId, adjustment_month: `${month}-01`, adjustment_date: date,
    adjustment_type: input.type, amount: input.amount, note: input.note || null
  }).select().single();
  if (error) throw new Error('新增調整項失敗：' + error.message);
  const adj = mapAdjustment(data);
  state.data.adjustments.push(adj);
  return adj;
}

// 這筆調整項如果是由加油申報確認轉進來的，刪掉前先把那筆申報退回「待確認」，
// 不然申報會一直顯示已確認、但代墊款其實已經不存在。
async function revertFuelClaimsOfAdjustments(adjustmentIds) {
  const claims = (state.data.fuelClaims || []).filter(c => adjustmentIds.includes(c.adjustmentId));
  if (!claims.length) return;
  const supabase = getSupabase();
  const { error } = await supabase.from('fuel_claims').update({ status: 'pending', adjustment_id: null }).in('id', claims.map(c => c.id));
  if (error) throw new Error('退回加油申報失敗：' + error.message);
  claims.forEach(c => { c.status = 'pending'; c.adjustmentId = null; });
}

async function deleteAdjustment(adjustmentId) {
  await revertFuelClaimsOfAdjustments([adjustmentId]);
  const supabase = getSupabase();
  const { error } = await supabase.from('adjustments').delete().eq('id', adjustmentId);
  if (error) throw new Error('刪除調整項失敗：' + error.message);
  state.data.adjustments = state.data.adjustments.filter(a => a.id !== adjustmentId);
}

async function bulkDeleteAdjustments(ids) {
  await revertFuelClaimsOfAdjustments(ids);
  const supabase = getSupabase();
  const { error } = await supabase.from('adjustments').delete().in('id', ids);
  if (error) throw new Error('刪除資料失敗：' + error.message);
  const idSet = new Set(ids);
  state.data.adjustments = state.data.adjustments.filter(a => !idSet.has(a.id));
}

// ---------------- 趟報酬：額外金額（臨時加錢／拆店調撥）與已付款 ----------------
// 夥伴單趟報酬＝凍結車資（或排定車資）＋額外金額（assignments.extra_pay）。額外金額是併進
// 趟報酬的，所以我的報酬、薪資結算、勞報單、首頁即時利潤全部自動跟著變，不用另外處理；
// 逐筆來源紀錄放在 trip_pay_adjustments（只有主控能看），extra_pay 永遠＝該趟所有紀錄的加總。
// 客戶請款是另外手動輸入的數字，完全不受影響。
function tripPay(a) {
  return (Number(a.payrollFareSnapshot ?? a.fare) || 0) + (Number(a.extraPay) || 0);
}

// 已經被勞報單（月結或區間）涵蓋的趟次，金額已凍結簽名，不能再動額外金額。
function assertTripPayEditable(a) {
  const st = findCoveringStatement(a.driverId, a.date);
  if (st) throw new Error(`${a.date} ${driverName(a.driverId)} 的車趟已被勞報單（${statementLabel(st)}）涵蓋並凍結，不能再改額外金額。如需調整請先收回那份勞報單。`);
}

async function fetchTripPayLogs(assignmentIds) {
  if (!assignmentIds || !assignmentIds.length) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase.from('trip_pay_adjustments').select('*').in('assignment_id', assignmentIds).order('created_at');
  if (error) throw new Error('讀取額外金額紀錄失敗：' + error.message);
  return data || [];
}

// 依紀錄重算並寫回這幾趟的 extra_pay。
async function syncExtraPay(assignmentIds) {
  const supabase = getSupabase();
  const logs = await fetchTripPayLogs(assignmentIds);
  for (const id of assignmentIds) {
    const sum = logs.filter(l => l.assignment_id === id).reduce((s, l) => s + Number(l.amount), 0);
    const { error } = await supabase.from('assignments').update({ extra_pay: sum }).eq('id', id);
    if (error) throw new Error('更新額外金額失敗：' + error.message);
    const a = state.data.assignments.find(x => x.id === id);
    if (a) a.extraPay = sum;
  }
}

function normalizeExtraAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) throw new Error('請輸入不是 0 的金額（減錢請輸入負數）');
  return Math.round(n * 100) / 100;
}

// 臨時加錢／減錢：單一趟，金額可正可負。
async function addTripExtra(assignmentId, amount, note) {
  const a = state.data.assignments.find(x => x.id === assignmentId);
  if (!a) throw new Error('找不到這趟車');
  assertTripPayEditable(a);
  const amt = normalizeExtraAmount(amount);
  const supabase = getSupabase();
  const { error } = await supabase.from('trip_pay_adjustments').insert({
    assignment_id: assignmentId, kind: 'extra', amount: amt, note: (note || '').trim() || null
  });
  if (error) throw new Error('新增額外金額失敗：' + error.message);
  await syncExtraPay([assignmentId]);
}

// 拆店調撥：來源趟調整後保留 keepAmount，其他趟各自加 add；總額不要求不變（距離變短可以少付）。
// 三筆以上綁成同一組（group_id），顯示與刪除都以整組為單位。
async function createSplitTransfer({ sourceId, keepAmount, targets, note }) {
  const src = state.data.assignments.find(x => x.id === sourceId);
  if (!src) throw new Error('找不到來源車趟');
  if (!targets || !targets.length) throw new Error('請至少選一趟要分過去的車');
  const keep = Number(keepAmount);
  if (!Number.isFinite(keep) || keep < 0) throw new Error('來源車趟保留金額要是 0 以上的數字');
  const ids = new Set([sourceId]);
  const rows = [];
  const group = crypto.randomUUID();
  const noteText = (note || '').trim() || null;
  assertTripPayEditable(src);
  const delta = Math.round((keep - tripPay(src)) * 100) / 100;
  if (delta !== 0) rows.push({ assignment_id: sourceId, kind: 'split', group_id: group, amount: delta, note: noteText });
  for (const t of targets) {
    if (ids.has(t.assignmentId)) throw new Error('同一趟不能重複選');
    ids.add(t.assignmentId);
    const a = state.data.assignments.find(x => x.id === t.assignmentId);
    if (!a) throw new Error('找不到要分過去的車趟');
    assertTripPayEditable(a);
    const add = Number(t.add);
    if (!Number.isFinite(add) || add < 0) throw new Error('各趟加的金額要是 0 以上的數字');
    if (add !== 0) rows.push({ assignment_id: t.assignmentId, kind: 'split', group_id: group, amount: Math.round(add * 100) / 100, note: noteText });
  }
  if (!rows.length) throw new Error('沒有任何金額變動');
  const supabase = getSupabase();
  const { error } = await supabase.from('trip_pay_adjustments').insert(rows);
  if (error) throw new Error('拆店調撥失敗：' + error.message);
  await syncExtraPay([...ids]);
}

// 刪除一筆紀錄；屬於拆店調撥的整組一起刪（避免只刪一半造成金額對不起來）。
async function deleteTripPayLog(logId) {
  const supabase = getSupabase();
  const { data: log, error: e1 } = await supabase.from('trip_pay_adjustments').select('*').eq('id', logId).single();
  if (e1) throw new Error('讀取紀錄失敗：' + e1.message);
  let q = supabase.from('trip_pay_adjustments').select('*');
  q = log.group_id ? q.eq('group_id', log.group_id) : q.eq('id', logId);
  const { data: logs, error: e2 } = await q;
  if (e2) throw new Error('讀取紀錄失敗：' + e2.message);
  const ids = [...new Set(logs.map(l => l.assignment_id))];
  for (const id of ids) {
    const a = state.data.assignments.find(x => x.id === id);
    if (a) assertTripPayEditable(a);
  }
  const { error } = await supabase.from('trip_pay_adjustments').delete().in('id', logs.map(l => l.id));
  if (error) throw new Error('刪除失敗：' + error.message);
  await syncExtraPay(ids);
}

// 已付款（現金／轉帳）：主控填「區間日期＋付款日期」，區間內這位夥伴已完成、還沒標已付的車趟
// 一次標為已付（付款金額依各趟報酬比例攤到每一趟，所以跨月時各月各自算得出已付多少）。
// 只影響「可領淨額」，不影響勞報單金額，跟預支是兩個獨立功能；同一次付款共用 paid_group。
// 只抓必要欄位，不連帶抓下貨點，區間再長也很輕。
async function fetchDriverTripsInRange(driverId, start, end) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('assignments')
    .select('id, trip_date, driver_id, status, fare, payroll_fare_snapshot, extra_pay, paid_amount, pay_due_date')
    .eq('driver_id', driverId).gte('trip_date', start).lte('trip_date', end).order('trip_date').limit(1000);
  if (error) throw new Error('讀取區間車趟失敗：' + error.message);
  return (data || []).map(r => ({
    id: r.id, date: r.trip_date, driverId: r.driver_id, status: r.status,
    fare: Number(r.fare), payrollFareSnapshot: r.payroll_fare_snapshot != null ? Number(r.payroll_fare_snapshot) : null,
    extraPay: Number(r.extra_pay || 0), paidAmount: Number(r.paid_amount || 0), payDueDate: r.pay_due_date || null
  }));
}

function validatePaymentRange(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) throw new Error('請選擇區間的開始與結束日期');
  if (end < start) throw new Error('結束日期不能早於開始日期');
  if ((new Date(end) - new Date(start)) / 86400000 > 62) throw new Error('一次付款的區間最長 62 天');
}

// 預覽／實際付款共用：區間內已完成、尚未標已付的車趟與合計。
function unpaidTripsOf(trips) {
  const list = trips.filter(t => t.status === 'completed' && !(Number(t.paidAmount) > 0));
  return { list, total: list.reduce((s, t) => s + tripPay(t), 0) };
}

async function recordPeriodPayment({ driverId, start, end, payDate, method, amount }) {
  validatePaymentRange(start, end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate || '')) throw new Error('請選擇付款日期');
  if (method !== 'cash' && method !== 'transfer') throw new Error('請選擇付款方式');
  const trips = await fetchDriverTripsInRange(driverId, start, end);
  const { list, total } = unpaidTripsOf(trips);
  if (!list.length) throw new Error('這個區間內沒有「已完成、尚未標已付」的車趟');
  const paying = (amount === '' || amount == null) ? total : Number(amount);
  if (!Number.isFinite(paying) || paying <= 0) throw new Error('付款金額要大於 0');
  if (paying > total + 0.005) throw new Error(`付款金額 $${paying} 超過區間內報酬合計 $${total}`);
  // 依各趟報酬比例攤，最後一趟補尾差，加總一定等於付款金額。
  const group = crypto.randomUUID();
  let allocated = 0;
  const parts = list.map((t, i) => {
    const part = i === list.length - 1 ? Math.round((paying - allocated) * 100) / 100 : Math.round(paying * tripPay(t) / total * 100) / 100;
    allocated += part;
    return { id: t.id, part };
  });
  const supabase = getSupabase();
  const results = await Promise.all(parts.map(p => supabase.from('assignments').update({
    paid_amount: p.part, paid_date: payDate, paid_method: method,
    paid_group: group, paid_period_start: start, paid_period_end: end
  }).eq('id', p.id)));
  const failed = results.find(r => r.error);
  if (failed) throw new Error('記錄已付款失敗（部分車趟可能已更新，請重新整理後檢查）：' + failed.error.message);
  parts.forEach(p => {
    const a = state.data.assignments.find(x => x.id === p.id);
    if (a) Object.assign(a, { paidAmount: p.part, paidDate: payDate, paidMethod: method, paidGroup: group, paidPeriodStart: start, paidPeriodEnd: end });
  });
  state._pendingPayCache = null;
  return { count: list.length, total: paying, skipped: trips.filter(t => t.status === 'completed').length - list.length };
}

// 取消整次付款（同一個 paid_group 的所有車趟一起取消）。
async function cancelPaymentGroup(groupId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments')
    .update({ paid_amount: 0, paid_date: null, paid_method: null, paid_group: null, paid_period_start: null, paid_period_end: null })
    .eq('paid_group', groupId);
  if (error) throw new Error('取消付款失敗：' + error.message);
  state.data.assignments.forEach(a => {
    if (a.paidGroup === groupId) Object.assign(a, { paidAmount: 0, paidDate: null, paidMethod: null, paidGroup: null, paidPeriodStart: null, paidPeriodEnd: null });
  });
  state._pendingPayCache = null;
}

// ---------------- 延後付款（掛帳）與待付款清單 ----------------
// 夥伴同意晚一點領（例如 9/30 的報酬約好 11/15 才付）：主控把那段期間「已完成、還沒付」的車趟掛帳，
// 記錄預計付款日；到了預計日轉帳後，用上面的區間付款登記，掛帳自動消失。只標記有掛帳的車趟，
// 舊月份沒有逐趟標過已付，不會被誤當成欠款。完全不影響勞報單與可領淨額計算。
async function deferPayment({ driverId, start, end, dueDate, note }) {
  validatePaymentRange(start, end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate || '')) throw new Error('請選擇預計付款日');
  const text = (note || '').trim();
  if (text.length > 60) throw new Error('備註請控制在60字以內');
  const trips = await fetchDriverTripsInRange(driverId, start, end);
  const targets = trips.filter(t => t.status === 'completed' && !(Number(t.paidAmount) > 0));
  if (!targets.length) throw new Error('這個區間內沒有「已完成、尚未付款」的車趟可以掛帳');
  const supabase = getSupabase();
  const results = await Promise.all(targets.map(t => supabase.from('assignments').update({ pay_due_date: dueDate, pay_due_note: text || null }).eq('id', t.id)));
  const failed = results.find(r => r.error);
  if (failed) throw new Error('掛帳失敗（部分車趟可能已更新，請重新整理後檢查）：' + failed.error.message);
  targets.forEach(t => {
    const a = state.data.assignments.find(x => x.id === t.id);
    if (a) { a.payDueDate = dueDate; a.payDueNote = text; }
  });
  state._pendingPayCache = null;
  return { count: targets.length, total: targets.reduce((s, t) => s + tripPay(t), 0) };
}

async function cancelDeferredPayment(assignmentIds) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').update({ pay_due_date: null, pay_due_note: null }).in('id', assignmentIds);
  if (error) throw new Error('取消掛帳失敗：' + error.message);
  state.data.assignments.forEach(a => { if (assignmentIds.includes(a.id)) { a.payDueDate = null; a.payDueNote = ''; } });
  state._pendingPayCache = null;
}

// 所有掛帳中（已完成、有預計付款日、還沒付）的車趟，精簡欄位；driverId 給了就只抓那位（夥伴端用）。
async function fetchDeferredTrips(driverId) {
  const supabase = getSupabase();
  let q = supabase.from('assignments')
    .select('id, trip_date, driver_id, fare, payroll_fare_snapshot, extra_pay, pay_due_date, pay_due_note')
    .eq('status', 'completed').eq('paid_amount', 0).not('pay_due_date', 'is', null).order('pay_due_date').limit(1000);
  if (driverId) q = q.eq('driver_id', driverId);
  const { data, error } = await q;
  if (error) throw new Error('讀取待付款清單失敗：' + error.message);
  return (data || []).map(r => ({
    id: r.id, date: r.trip_date, driverId: r.driver_id, fare: Number(r.fare),
    payrollFareSnapshot: r.payroll_fare_snapshot != null ? Number(r.payroll_fare_snapshot) : null,
    extraPay: Number(r.extra_pay || 0), payDueDate: r.pay_due_date, payDueNote: r.pay_due_note || ''
  }));
}
// 同一位夥伴＋同一個預計付款日＋同一備註 合成一筆待付款。
function groupDeferred(trips) {
  const map = new Map();
  trips.forEach(t => {
    const k = `${t.driverId}|${t.payDueDate}|${t.payDueNote}`;
    const g = map.get(k) || { driverId: t.driverId, due: t.payDueDate, note: t.payDueNote, ids: [], start: t.date, end: t.date, total: 0 };
    g.ids.push(t.id); g.total += tripPay(t);
    if (t.date < g.start) g.start = t.date;
    if (t.date > g.end) g.end = t.date;
    map.set(k, g);
  });
  return [...map.values()].sort((a, b) => a.due.localeCompare(b.due) || String(a.driverId).localeCompare(String(b.driverId)));
}
// 掛帳金額依「檢視的期間」拆成兩塊：期間內（已經算在該月報酬裡，只註明已掛帳）與期間外（其他月份的掛帳，
// 要另外加進應付合計）。dues 是預計付款日（去重、由早到晚）。
function deferredSplit(trips, start, end) {
  const pack = list => ({
    total: list.reduce((sum, t) => sum + tripPay(t), 0),
    dues: [...new Set(list.map(t => t.payDueDate))].sort()
  });
  return {
    inRange: pack(trips.filter(t => t.date >= start && t.date <= end)),
    other: pack(trips.filter(t => t.date < start || t.date > end))
  };
}
// 首頁用：5 分鐘內共用同一份結果，付款／掛帳動作會清掉快取。
async function getDeferredCached() {
  const c = state._pendingPayCache;
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.groups;
  const groups = groupDeferred(await fetchDeferredTrips());
  state._pendingPayCache = { at: Date.now(), groups };
  return groups;
}
// 到期狀態：overdue 逾期、today 今天、soon 3 天內、later 其他。
function deferredStatus(due) {
  const today = todayStr();
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  const days = Math.round((new Date(due + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  return days <= 3 ? 'soon' : 'later';
}

// ---------------- 客戶請款例外調整（跟夥伴薪資調整項是兩回事） ----------------

async function createBillingAdjustment(input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('billing_adjustments').insert({
    channel_id: input.channelId, period_start: input.periodStart, period_end: input.periodEnd,
    note: input.note, amount: input.amount
  }).select().single();
  if (error) throw new Error('新增請款調整項失敗：' + error.message);
  const adj = mapBillingAdjustment(data);
  state.data.billingAdjustments.push(adj);
  return adj;
}

async function deleteBillingAdjustment(id) {
  const supabase = getSupabase();
  const { error } = await supabase.from('billing_adjustments').delete().eq('id', id);
  if (error) throw new Error('刪除請款調整項失敗：' + error.message);
  state.data.billingAdjustments = state.data.billingAdjustments.filter(a => a.id !== id);
}

// ---------------- 公告（主控發布給全體夥伴看的訊息） ----------------

// audience 'all'：全體夥伴；'selected'：只有 driverIds 列出的那幾位看得到。
async function createAnnouncement(input) {
  const supabase = getSupabase();
  const audience = input.audience === 'selected' ? 'selected' : 'all';
  const { data, error } = await supabase.from('announcements').insert({
    title: input.title, content: input.content, audience
  }).select().single();
  if (error) throw new Error('發布公告失敗：' + error.message);
  let driverIds = [];
  if (audience === 'selected' && input.driverIds && input.driverIds.length) {
    const rows = input.driverIds.map(driverId => ({ announcement_id: data.id, driver_id: driverId }));
    const { error: recErr } = await supabase.from('announcement_recipients').insert(rows);
    if (recErr) throw new Error('設定公告發送對象失敗：' + recErr.message);
    driverIds = input.driverIds;
  }
  const a = { ...mapAnnouncement(data), driverIds };
  state.data.announcements.unshift(a);
  return a;
}

async function updateAnnouncement(id, input) {
  const supabase = getSupabase();
  const audience = input.audience === 'selected' ? 'selected' : 'all';
  const { data, error } = await supabase.from('announcements').update({
    title: input.title, content: input.content, audience
  }).eq('id', id).select().single();
  if (error) throw new Error('更新公告失敗：' + error.message);
  // 對象名單整批重建最簡單、最不容易漏改：全部刪掉再依目前選的重新插入，
  // 不用另外算「加了誰、少了誰」的差異。
  const { error: delErr } = await supabase.from('announcement_recipients').delete().eq('announcement_id', id);
  if (delErr) throw new Error('更新公告發送對象失敗：' + delErr.message);
  let driverIds = [];
  if (audience === 'selected' && input.driverIds && input.driverIds.length) {
    const rows = input.driverIds.map(driverId => ({ announcement_id: id, driver_id: driverId }));
    const { error: recErr } = await supabase.from('announcement_recipients').insert(rows);
    if (recErr) throw new Error('設定公告發送對象失敗：' + recErr.message);
    driverIds = input.driverIds;
  }
  const idx = state.data.announcements.findIndex(a => a.id === id);
  if (idx >= 0) state.data.announcements[idx] = { ...mapAnnouncement(data), driverIds };
}

// 下架用軟刪除（active=false）而不是直接刪除列——夥伴那邊 RLS 只擋掉
// active=false 的，不代表歷史上發過這則公告的紀錄要一起消失，主控自己
// 這邊（不受 active 篩選）還是看得到、可以重新上架。
async function setAnnouncementActive(id, active) {
  const supabase = getSupabase();
  const { error } = await supabase.from('announcements').update({ active }).eq('id', id);
  if (error) throw new Error('更新公告狀態失敗：' + error.message);
  const a = state.data.announcements.find(x => x.id === id);
  if (a) a.active = active;
}

async function deleteAnnouncement(id) {
  const supabase = getSupabase();
  const { error } = await supabase.from('announcements').delete().eq('id', id);
  if (error) throw new Error('刪除公告失敗：' + error.message);
  state.data.announcements = state.data.announcements.filter(a => a.id !== id);
}

// 全體夥伴固定套用同一個所得類別；如果貴公司實際適用的所得類別不是這個，
// 請直接改這個常數即可，不用逐月手動修改每張勞報單。
const PAYROLL_INCOME_TYPE = '執行業務所得';
// 稅務／二代健保補充保費費率與起扣門檻。⚠️ 這兩個數字（10% 扣繳率、
// 單筆NT$20,000起扣點、2.11%補充保費費率）是台灣目前普遍適用的參考值，
// 但實際是否適用、門檻是否變動，請務必先請會計師／記帳士確認過一次再
// 正式依賴這個自動判斷結果，避免扣錯稅或漏扣。
const PAYROLL_TAX_RATE = 0.10;
const PAYROLL_NHI_RATE = 0.0211;
const PAYROLL_WITHHOLD_THRESHOLD = 20000;
// reimbursement＝夥伴代墊款（例如油資，憑證開公司統編）：這筆錢已經包含在
// 報酬總額裡一起付給夥伴，但屬於代墊還款、不是所得，扣稅／補充保費的門檻
// 判斷跟計算基礎只用「報酬總額 − 代墊款」（所得額）；實領金額＝報酬總額 −
// 稅 − 補充保費，夥伴實際收到的錢跟沒有代墊時的算法一致。
function computePayrollDeductions(grossAmount, reimbursement = 0) {
  const amt = Math.round(Number(grossAmount) || 0);
  const reimb = Math.min(Math.max(Math.round(Number(reimbursement) || 0), 0), Math.max(amt, 0));
  const taxable = amt - reimb;
  const withhold = taxable >= PAYROLL_WITHHOLD_THRESHOLD;
  const taxAmount = withhold ? Math.round(taxable * PAYROLL_TAX_RATE) : 0;
  const nhiAmount = withhold ? Math.round(taxable * PAYROLL_NHI_RATE) : 0;
  return {
    incomeType: PAYROLL_INCOME_TYPE,
    withholdTax: withhold, taxRate: withhold ? PAYROLL_TAX_RATE : 0, taxAmount,
    withholdNhi: withhold, nhiRate: withhold ? PAYROLL_NHI_RATE : 0, nhiAmount,
    taxableAmount: taxable, reimbursement: reimb,
    actualNet: amt - taxAmount - nhiAmount
  };
}

// live: driverMonthly() 算出來的即時金額（凍結當下的快照數字）。這裡故意
// 不直接用live.adjTotal/live.net——那是含預支扣減的即時參考值，勞報單是
// 正式文件，預支不算扣款，凍結存檔時要用statementNetFromAdjustments()
// 重新排除預支再算一次（見index.html該函式旁邊的說明）。
// 勞報單勞務名稱：預設「貨物配送及到店協助理貨勞務」。主控可以依夥伴改名稱，但規則是名稱
// 要符合系統記錄的實際工作——當月有完成車趟時，名稱必須含「配送」；當月沒有車趟才可自由填寫。
const DEFAULT_SERVICE_NAME = '到店協助理貨勞務';
function validateServiceName(name, tripCount) {
  name = (name || '').trim();
  if (!name) return;
  if (name.length > 30) throw new Error('勞務名稱最多 30 個字');
  if (tripCount > 0 && !name.includes('理貨')) {
    throw new Error(`勞務名稱「${name}」沒有寫到「理貨」，但這位夥伴本月在系統裡有 ${tripCount} 趟完成的車趟。名稱必須符合實際工作，請修改夥伴資料裡的勞務名稱（需含「理貨」）。`);
  }
}

async function confirmMonthlyStatement(driverId, month, live) {
  const supabase = getSupabase();
  const driver = (state.data.drivers || []).find(d => d.id === driverId);
  const serviceName = ((driver && driver.serviceName) || '').trim();
  validateServiceName(serviceName, (live.trips || []).length);
  const overlap = findOverlappingStatement(driverId, `${month}-01`, monthEndStr(month));
  if (overlap) throw new Error(`${month} 這個月份已經有勞報單（${statementLabel(overlap)}）涵蓋，不能再整月月結，避免同一段期間重複開單。`);
  const { adjTotal, net } = statementNetFromAdjustments(live.tripTotal, live.adjustments);
  const reimbursement = live.adjustments.filter(a => a.type === 'reimbursement').reduce((s, a) => s + Math.abs(Number(a.amount) || 0), 0);
  const ded = computePayrollDeductions(net, reimbursement);
  const { data, error } = await supabase.from('statements').insert({
    driver_id: driverId, statement_month: `${month}-01`,
    trip_total: live.tripTotal, adj_total: adjTotal, net_amount: net,
    income_type: ded.incomeType,
    withhold_tax: ded.withholdTax, tax_rate: ded.taxRate, tax_amount: ded.taxAmount,
    withhold_nhi: ded.withholdNhi, nhi_rate: ded.nhiRate, nhi_amount: ded.nhiAmount,
    actual_net_amount: ded.actualNet, reimbursement_amount: ded.reimbursement,
    service_name: serviceName || null,
    status: 'awaiting_signature', confirmed_at: new Date().toISOString(), admin_acked: false
  }).select().single();
  if (error) throw new Error('月結確認失敗：' + error.message);
  const st = mapStatement(data);
  state.data.statements.push(st);
  return st;
}

// ---------------- 區間勞報單（依實際付款期間開單） ----------------
// 夥伴每週（或每次付款）請款時，主控可以自選日期區間開一張勞報單：金額由系統裡該區間的
// 完成車趟與調整項（依調整項日期）算出來，不能手動改；給付日期記錄實際轉帳日。
// 區間不可跟同一位夥伴的其他勞報單（月結或區間）重疊，避免同一段期間重複開單。

function statementRange(s) {
  return s.periodStart ? [s.periodStart, s.periodEnd] : [s.month + '-01', monthEndStr(s.month)];
}
function statementLabel(s) {
  return s.periodStart ? `${s.periodStart}～${s.periodEnd}` : s.month;
}
function findOverlappingStatement(driverId, start, end, excludeId) {
  return state.data.statements.find(s => {
    if (s.driverId !== driverId || s.id === excludeId) return false;
    const [a, b] = statementRange(s);
    return a <= end && b >= start;
  });
}
function findCoveringStatement(driverId, date) {
  return findOverlappingStatement(driverId, date, date);
}
// 調整項的有效日期：有日期用日期，舊資料沒日期的視為該月1日。
function adjustmentEffectiveDate(a) {
  return a.date || (a.month + '-01');
}

async function confirmPeriodStatement(driverId, start, end, payDate, live) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('請選擇正確的起訖日期');
  if (end < start) throw new Error('結束日期不能早於開始日期');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate || '')) throw new Error('請填寫實際給付日期');
  if (end > todayStr()) throw new Error('結束日期不能是未來的日期（期間內的車趟要已經完成）');
  const overlap = findOverlappingStatement(driverId, start, end);
  if (overlap) throw new Error(`這段期間跟已存在的勞報單（${statementLabel(overlap)}）重疊，不能重複開單。`);
  const supabase = getSupabase();
  const driver = (state.data.drivers || []).find(d => d.id === driverId);
  const serviceName = ((driver && driver.serviceName) || '').trim();
  validateServiceName(serviceName, (live.trips || []).length);
  const { adjTotal, net } = statementNetFromAdjustments(live.tripTotal, live.adjustments);
  const reimbursement = live.adjustments.filter(a => a.type === 'reimbursement').reduce((s, a) => s + Math.abs(Number(a.amount) || 0), 0);
  const ded = computePayrollDeductions(net, reimbursement);
  const { data, error } = await supabase.from('statements').insert({
    driver_id: driverId, statement_month: `${end.slice(0, 7)}-01`,
    period_start: start, period_end: end, pay_date: payDate,
    trip_total: live.tripTotal, adj_total: adjTotal, net_amount: net,
    income_type: ded.incomeType,
    withhold_tax: ded.withholdTax, tax_rate: ded.taxRate, tax_amount: ded.taxAmount,
    withhold_nhi: ded.withholdNhi, nhi_rate: ded.nhiRate, nhi_amount: ded.nhiAmount,
    actual_net_amount: ded.actualNet, reimbursement_amount: ded.reimbursement,
    service_name: serviceName || null,
    status: 'awaiting_signature', confirmed_at: new Date().toISOString(), admin_acked: false
  }).select().single();
  if (error) throw new Error('區間勞報單建立失敗：' + error.message);
  const st = mapStatement(data);
  state.data.statements.push(st);
  return st;
}

async function ackStatement(statementId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('statements').update({ admin_acked: true }).eq('id', statementId);
  if (error) throw new Error('標記已讀失敗：' + error.message);
  const s = state.data.statements.find(x => x.id === statementId);
  if (s) s.adminAcked = true;
}

async function signStatement(statementId, signatureDataUrl) {
  const { bytes, contentType } = dataUrlToBytesAndType(signatureDataUrl);
  const path = `${statementId}.png`;
  const supabase = getSupabase();
  const { error: upErr } = await supabase.storage.from('signatures').upload(path, bytes, { contentType, upsert: true });
  if (upErr) throw new Error('簽名上傳失敗：' + upErr.message);

  const signedAt = new Date().toISOString();
  const { error } = await supabase.from('statements')
    .update({ status: 'signed', signed_at: signedAt, signature_url: path })
    .eq('id', statementId);
  if (error) throw new Error('回簽失敗：' + error.message);

  const s = state.data.statements.find(x => x.id === statementId);
  if (s) { s.status = 'signed'; s.signedAt = signedAt; s.signatureDataUrl = signatureDataUrl; }
}

// 主控退回簽名：把已回簽的勞報單退回「待回簽」狀態，讓夥伴可以重新簽名
// （例如簽名簽錯、看不清楚）。不刪除舊的簽名圖檔（夥伴重簽時 signStatement()
// 會用同一個路徑 upsert 覆蓋掉），只重置狀態欄位。
async function rejectStatementSignature(statementId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('statements')
    .update({ status: 'awaiting_signature', signed_at: null, signature_url: null })
    .eq('id', statementId);
  if (error) throw new Error('退回簽名失敗：' + error.message);
  const s = state.data.statements.find(x => x.id === statementId);
  if (s) { s.status = 'awaiting_signature'; s.signedAt = null; s.signatureDataUrl = null; s.adminAcked = false; }
}

// 批次退回簽名（一次多份）：邏輯同 rejectStatementSignature，一個請求完成。
async function rejectStatementSignatures(ids) {
  if (!ids || !ids.length) return;
  const supabase = getSupabase();
  const { error } = await supabase.from('statements')
    .update({ status: 'awaiting_signature', signed_at: null, signature_url: null })
    .in('id', ids);
  if (error) throw new Error('批次退回簽名失敗：' + error.message);
  const idSet = new Set(ids);
  state.data.statements.forEach(s => {
    if (idSet.has(s.id)) { s.status = 'awaiting_signature'; s.signedAt = null; s.signatureDataUrl = null; s.adminAcked = false; }
  });
}

// 收回月結：帳務有問題時，把已經月結確認的勞報單整份刪除，那個月份回到「尚未月結
// 確認」，就可以重新新增／刪除調整項、修正後再月結確認一次。跟「退回簽名」不同：
// 退回簽名只是讓夥伴重簽，金額仍是凍結的；收回是連凍結金額一起作廢。夥伴端會
// 看不到這份勞報單；已簽名的簽名圖檔不刪（路徑是舊的狀態id，重新月結後不會被用到，
// 檔案很小、在私有bucket裡，留著不影響）。
async function revokeStatements(ids) {
  if (!ids || !ids.length) return;
  const supabase = getSupabase();
  const { error } = await supabase.from('statements').delete().in('id', ids);
  if (error) throw new Error('收回月結失敗：' + error.message);
  const idSet = new Set(ids);
  state.data.statements = state.data.statements.filter(x => !idSet.has(x.id));
}

// 夥伴首頁「同出發點今日出發狀況」：呼叫 schema.sql 裡的
// security definer 函式 driver_depot_overview()，只回傳沒有金額的窄
// 欄位（車次名稱/夥伴姓名/狀態），繞過夥伴只能查自己車趟的RLS限制，
// 但不會洩漏其他夥伴的薪資/請款資料。
async function fetchDepotOverview(date) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('driver_depot_overview', { p_date: date });
  if (error) { console.error('取得同出發點車隊狀況失敗:', error.message); return []; }
  return (data || []).map(r => ({
    assignmentId: r.assignment_id,
    routeName: r.route_name,
    driverName: r.driver_name,
    status: r.status,
    seq: r.seq,
    shift: r.shift
  }));
}

// 夥伴自己按「確認簽名」把 signed 鎖定成 confirmed，鎖定後夥伴端不再顯示
// 「重新簽名」按鈕（例如主控已經拿這份簽名去申報國稅局之後，就不該再讓
// 簽名內容悄悄變掉）。主控的退回簽名不受這個狀態影響，隨時能退回重簽。
async function confirmSignature(statementId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('statements')
    .update({ status: 'confirmed' })
    .eq('id', statementId);
  if (error) throw new Error('確認簽名失敗：' + error.message);
  const s = state.data.statements.find(x => x.id === statementId);
  if (s) s.status = 'confirmed';
}

// ---------------- 系統設定 ----------------

async function updateAdminPin(pin) {
  const supabase = getSupabase();
  const { error } = await supabase.from('settings').update({ admin_pin: pin }).eq('id', 1);
  if (error) throw new Error('更新PIN碼失敗：' + error.message);
  state.data.settings.adminPin = pin;
}

// 記錄「剛剛做過一次手動備份」，只用來在首頁顯示「超過7天沒備份」提醒，
// 不影響備份內容本身；失敗就靜默忽略（備份這個動作本身已經完成，記錄時間
// 失敗不該讓使用者以為備份失敗）。
async function recordBackupDone() {
  try {
    const supabase = getSupabase();
    const now = new Date().toISOString();
    const { error } = await supabase.from('settings').update({ last_backup_at: now }).eq('id', 1);
    if (error) { console.error('記錄備份時間失敗:', error.message); return; }
    state.data.settings.lastBackupAt = now;
  } catch (err) { console.error('記錄備份時間失敗:', err.message); }
}

// 「匯出全部備份」沿用 demo 的 JSON.stringify(state.data)，只是資料來源換成即時查詢結果；
// 「匯入覆蓋全系統」這個危險操作已依討論結果拿掉，不搬到正式版。

// 免費方案用量監控（系統設定頁面）：資料庫大小跟檔案儲存空間都能查到，
// 每月流量/Egress 沒有公開API可查（Supabase官方本身也只能在後台Usage
// 頁面手動看），這裡就不假裝能查到。任何一個查詢失敗都不影響其他資料，
// 個別回傳 null，畫面上顯示「無法取得」而不是整頁壞掉。
async function fetchUsageStats() {
  const supabase = getSupabase();
  const [dbRes, storageRes] = await Promise.all([
    supabase.rpc('get_database_size'),
    supabase.rpc('get_storage_usage')
  ]);
  const dbSizeBytes = dbRes.error ? null : dbRes.data;
  if (dbRes.error) console.error('取得資料庫大小失敗', dbRes.error.message);
  const storageBuckets = storageRes.error ? null : (storageRes.data || []);
  if (storageRes.error) console.error('取得檔案儲存用量失敗', storageRes.error.message);
  const storageTotalBytes = storageBuckets ? storageBuckets.reduce((s, b) => s + Number(b.total_bytes || 0), 0) : null;
  return { dbSizeBytes, storageBuckets, storageTotalBytes };
}

// ---------------- 夥伴加油申報（夥伴填、主控確認後轉成代墊款） ----------------

function normalizeInvoiceNo(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function validateFuelClaimInput(input, excludeId) {
  const date = String(input.date || '');
  const category = input.category || 'fuel';
  if (!CLAIM_CATEGORY_LABEL[category]) throw new Error('請選擇申報類別');
  const label = CLAIM_CATEGORY_LABEL[category];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`請選擇${label}日期`);
  if (date > todayStr()) throw new Error(`${label}日期不能是未來的日期`);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('請輸入正確的金額');
  const invoiceNo = normalizeInvoiceNo(input.invoiceNo);
  if (!/^[A-Z]{2}[0-9]{8}$/.test(invoiceNo)) throw new Error('發票號碼格式不正確，應為2碼英文＋8碼數字（例如 AB12345678）');
  const covered = findCoveringStatement(input.driverId, date);
  if (covered) {
    throw new Error(`${date} 已經被勞報單（${statementLabel(covered)}）涵蓋，無法再申報這段期間的代墊費用，請聯絡主控。`);
  }
  if ((state.data.fuelClaims || []).some(c => c.invoiceNo === invoiceNo && c.id !== excludeId)) {
    throw new Error('這張發票號碼已經申報過了');
  }
  const note = String(input.note || '').trim();
  if (note.length > 60) throw new Error('備註請控制在60字以內');
  return { date, amount, invoiceNo, category, note: note || null };
}

async function createFuelClaim(input) {
  const v = validateFuelClaimInput(input);
  const supabase = getSupabase();
  const { data, error } = await supabase.from('fuel_claims').insert({
    driver_id: input.driverId, fuel_date: v.date, amount: v.amount, invoice_no: v.invoiceNo, category: v.category, note: v.note
  }).select().single();
  if (error) throw new Error(error.code === '23505' ? '這張發票號碼已經申報過了' : '送出申報失敗：' + error.message);
  const claim = mapFuelClaim(data);
  state.data.fuelClaims.unshift(claim);
  return claim;
}

async function updateFuelClaim(id, input) {
  const existing = state.data.fuelClaims.find(c => c.id === id);
  if (!existing || existing.status !== 'pending') throw new Error('這筆申報已經確認，無法修改');
  const v = validateFuelClaimInput({ ...input, driverId: existing.driverId }, id);
  const supabase = getSupabase();
  const { data, error } = await supabase.from('fuel_claims').update({
    fuel_date: v.date, amount: v.amount, invoice_no: v.invoiceNo, category: v.category, note: v.note
  }).eq('id', id).eq('status', 'pending').select().single();
  if (error) throw new Error(error.code === '23505' ? '這張發票號碼已經申報過了' : '修改申報失敗：' + error.message);
  Object.assign(existing, mapFuelClaim(data));
  return existing;
}

async function deleteFuelClaim(id) {
  const existing = state.data.fuelClaims.find(c => c.id === id);
  if (existing && existing.status !== 'pending') throw new Error('這筆申報已經確認，無法刪除');
  const supabase = getSupabase();
  const { error } = await supabase.from('fuel_claims').delete().eq('id', id).eq('status', 'pending');
  if (error) throw new Error('刪除申報失敗：' + error.message);
  state.data.fuelClaims = state.data.fuelClaims.filter(c => c.id !== id);
}

// 主控核對憑證後確認：轉成該加油日期所屬月份的代墊款（createAdjustment 會擋掉
// 已經月結凍結的月份），再把申報標記為已確認；第二步失敗就把剛建的代墊款刪回去，
// 避免兩邊不一致。
async function confirmFuelClaim(id) {
  const claim = state.data.fuelClaims.find(c => c.id === id);
  if (!claim || claim.status !== 'pending') throw new Error('這筆申報已經處理過了');
  const adj = await createAdjustment({
    driverId: claim.driverId, month: claim.date.slice(0, 7), date: claim.date, type: 'reimbursement',
    amount: claim.amount, note: `${CLAIM_CATEGORY_LABEL[claim.category] || '代墊'} ${claim.date} 發票${claim.invoiceNo}${claim.note ? ' ' + claim.note : ''}`
  });
  const supabase = getSupabase();
  const { error } = await supabase.from('fuel_claims').update({ status: 'confirmed', adjustment_id: adj.id }).eq('id', id);
  if (error) {
    await supabase.from('adjustments').delete().eq('id', adj.id);
    state.data.adjustments = state.data.adjustments.filter(a => a.id !== adj.id);
    throw new Error('確認申報失敗：' + error.message);
  }
  claim.status = 'confirmed';
  claim.adjustmentId = adj.id;
}

// 首頁背景刷新用：夥伴隨時可能新增申報，主控停在首頁時要能看到最新的待確認數量
// （fuel_claims 沒有訂閱 Realtime，資料量也很小，直接整張重抓）。
async function refreshFuelClaims() {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('fuel_claims').select('*').order('fuel_date', { ascending: false });
  if (error) throw new Error('重新整理加油申報失敗：' + error.message);
  state.data.fuelClaims = (data || []).map(mapFuelClaim);
}

// 「尚未月結確認」名單用：只抓指定月份已完成車趟的精簡欄位（沒有下貨點），一樣分頁避開1000筆上限。
// 同一個月份在這個 session 只查一次（state._settleCache），首頁提醒與勞報單頁共用。
async function fetchCompletedTripsLite(monthStr) {
  const supabase = getSupabase();
  const PAGE = 1000;
  const trips = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('assignments')
      .select('driver_id, trip_date, fare, payroll_fare_snapshot, extra_pay')
      .eq('status', 'completed').gte('trip_date', monthStr + '-01').lte('trip_date', monthEndStr(monthStr))
      .order('id').range(from, from + PAGE - 1);
    if (error) throw new Error('讀取月結名單失敗：' + error.message);
    (data || []).forEach(r => trips.push({
      driverId: r.driver_id, date: r.trip_date, fare: Number(r.fare),
      payrollFareSnapshot: r.payroll_fare_snapshot != null ? Number(r.payroll_fare_snapshot) : null,
      extraPay: Number(r.extra_pay || 0)
    }));
    if (!data || data.length < PAGE) break;
  }
  return trips;
}
async function getSettleTrips(monthStr, force) {
  if (force || !state._settleCache || state._settleCache.month !== monthStr) {
    state._settleCache = { month: monthStr, trips: await fetchCompletedTripsLite(monthStr) };
  }
  return state._settleCache.trips;
}

// 「無需月結」標記：某位夥伴某個月不需要月結（不影響任何金額），從尚未月結名單與首頁提醒消失，可恢復。
async function ensureSettleSkips() {
  if (state._settleSkips) return state._settleSkips;
  const supabase = getSupabase();
  const { data, error } = await supabase.from('settle_skips').select('driver_id, statement_month');
  if (error) throw new Error('讀取無需月結標記失敗：' + error.message);
  state._settleSkips = new Set((data || []).map(r => `${r.driver_id}|${r.statement_month.slice(0, 7)}`));
  return state._settleSkips;
}
function settleSkipped(driverId, monthStr) {
  return !!(state._settleSkips && state._settleSkips.has(`${driverId}|${monthStr}`));
}
async function addSettleSkip(driverId, monthStr) {
  const supabase = getSupabase();
  const { error } = await supabase.from('settle_skips').insert({ driver_id: driverId, statement_month: `${monthStr}-01` });
  if (error) throw new Error('標記無需月結失敗：' + error.message);
  (await ensureSettleSkips()).add(`${driverId}|${monthStr}`);
}
async function removeSettleSkip(driverId, monthStr) {
  const supabase = getSupabase();
  const { error } = await supabase.from('settle_skips').delete().eq('driver_id', driverId).eq('statement_month', `${monthStr}-01`);
  if (error) throw new Error('恢復失敗：' + error.message);
  (await ensureSettleSkips()).delete(`${driverId}|${monthStr}`);
}

// 某個月份「還沒被月結／區間勞報單涵蓋、也沒標無需月結」的夥伴與趟數、報酬總額（精簡趟資料＋已載入的調整項）。
function unsettledRows(monthStr, liteTrips) {
  return state.data.drivers.map(d => {
    if (settleSkipped(d.id, monthStr)) return null;
    const trips = liteTrips.filter(t => t.driverId === d.id && !findCoveringStatement(d.id, t.date));
    if (!trips.length) return null;
    const tripTotal = trips.reduce((sum, t) => sum + tripPay(t), 0);
    const adjustments = state.data.adjustments.filter(a => a.driverId === d.id && a.month === monthStr && !findCoveringStatement(d.id, adjustmentEffectiveDate(a)));
    return { d, trips: trips.length, net: statementNetFromAdjustments(tripTotal, adjustments).net };
  }).filter(Boolean);
}
// 提示只在每月 1～15 號顯示，且只看上個月；16 號起不論有沒有月結都不顯示。
function settleReminderMonth() {
  const today = todayStr();
  if (Number(today.slice(8, 10)) > 15) return null;
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// ---------------- 夥伴「已投保職業工會」證明圖檔（僅主控可上傳／查看） ----------------

// 私有 bucket driver-docs，只有 app_admin 有權限（見 schema.sql PART 12），路徑
// {driverId}/union-{時間}.jpg。回傳儲存路徑，由呼叫端寫進 drivers.union_proof_path。
async function uploadDriverUnionProof(driverId, dataUrl) {
  const { bytes, contentType } = dataUrlToBytesAndType(dataUrl);
  const path = `${driverId}/union-${Date.now()}.jpg`;
  const supabase = getSupabase();
  const { error } = await supabase.storage.from('driver-docs').upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error('上傳工會證明失敗：' + error.message);
  return path;
}

async function getDriverUnionProofUrl(path) {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from('driver-docs').createSignedUrl(path, 300);
  if (error) throw new Error('讀取工會證明失敗：' + error.message);
  return data.signedUrl;
}

async function removeDriverUnionProofFile(path) {
  if (!path) return;
  const supabase = getSupabase();
  await supabase.storage.from('driver-docs').remove([path]);
}
