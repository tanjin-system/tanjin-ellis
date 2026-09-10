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
    status: row.status,
    inactiveAt: row.inactive_at,
    vehicle: { plate: row.vehicle_plate || '', type: row.vehicle_type || '', load: row.vehicle_load ?? '' },
    bank: { bankName: row.bank_name || '', branch: row.bank_branch || '', account: row.bank_account || '', holder: row.bank_holder || '' }
  };
}

function mapChannel(row) {
  return {
    id: row.id, name: row.name, periodType: row.period_type,
    startDay: row.start_day, endDay: row.end_day, status: row.status,
    formulaType: row.formula_type, rateKm: Number(row.rate_km), ratePoint: Number(row.rate_point),
    flatAmount: Number(row.flat_amount)
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
      dropPointIds: (v.route_version_points || [])
        .slice().sort((a, b) => a.sequence_no - b.sequence_no)
        .map(p => p.drop_point_id)
    }));
  return { id: row.id, name: row.name, originAddr, seq: row.seq, shift: row.shift, versions };
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
      photoCleared: p.photo_cleared
    }))
  };
}

// 下貨點顯示用文字：有代號時代號在前、地址在後（例："萬家福桂林店 臺北市萬華區仁德里桂林路1號"），
// 沒代號就只顯示地址。司機端行程畫面、即時通知訊息都共用這個格式。
function dpLabel(dp) {
  if (!dp) return '';
  return dp.code ? `${dp.code} ${dp.address}` : dp.address;
}

function mapAdjustment(row) {
  return {
    id: row.id, driverId: row.driver_id, month: row.adjustment_month.slice(0, 7),
    type: row.adjustment_type, amount: Number(row.amount), note: row.note || ''
  };
}

function mapStatement(row) {
  return {
    id: row.id, driverId: row.driver_id, month: row.statement_month.slice(0, 7),
    tripTotal: Number(row.trip_total), adjTotal: Number(row.adj_total), net: Number(row.net_amount),
    status: row.status, confirmedAt: row.confirmed_at, signedAt: row.signed_at,
    signatureDataUrl: null, adminAcked: row.admin_acked
  };
}

function mapNotification(row) {
  return { id: row.id, type: row.type, message: row.message, createdAt: row.created_at, read: row.read };
}

// ---------------- 照片／簽名：Storage 路徑 → 短期有效的可存取連結 ----------------
// 沿用 demo 原本欄位名稱（dp.photo / statement.signatureDataUrl），
// 這樣 index.html 裡 <img src="${dp.photo}"> 這類渲染程式碼完全不用改。

async function resolvePhotoUrls(assignments) {
  const supabase = getSupabase();
  const targets = [];
  assignments.forEach(a => a.dropPoints.forEach(dp => { if (dp.photoPath) targets.push(dp); }));
  if (!targets.length) return;
  const { data, error } = await supabase.storage
    .from('assignment-photos')
    .createSignedUrls(targets.map(dp => dp.photoPath), 60 * 60 * 24 * 7);
  if (error) { console.error('取得照片連結失敗', error.message); return; }
  data.forEach((item, i) => { targets[i].photo = item?.signedUrl || null; });
}

async function resolveSignatureUrls(statements) {
  const supabase = getSupabase();
  const targets = statements.filter(s => s.status === 'signed');
  if (!targets.length) return;
  const { data, error } = await supabase.storage
    .from('signatures')
    .createSignedUrls(targets.map(s => `${s.id}.png`), 60 * 60 * 24 * 7);
  if (error) { console.error('取得簽名連結失敗', error.message); return; }
  data.forEach((item, i) => { targets[i].signatureDataUrl = item?.signedUrl || null; });
}

function dataUrlToBytesAndType(dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('圖片格式錯誤');
  const [, contentType, base64] = match;
  return { bytes: Uint8Array.from(atob(base64), c => c.charCodeAt(0)), contentType };
}

// ---------------- 讀取全部資料（取代 loadData()） ----------------

async function loadAllData() {
  const supabase = getSupabase();
  // 安全性修補：settings 表（含 admin_pin）依 schema.sql 設計刻意「只有 app_admin 能碰，
  // app_driver 完全不可見」，故意不 grant app_driver 任何權限，避免司機讀到明文主控PIN。
  // 但這代表司機身份查 settings 一定會收到 permission denied 錯誤——原本這裡不分身份
  // 都查，會讓下面的 for...throw 直接把司機的整個 loadAllData() 打斷，司機端因此完全
  // 無法登入使用。改成只有 admin 才查 settings，司機端用空殼帶過即可（司機端本來就
  // 沒有任何畫面會用到 adminPin）。
  const isAdmin = state.role === 'admin';
  const queries = {
    ...(isAdmin ? { settingsRes: supabase.from('settings').select('*').eq('id', 1).maybeSingle() } : {}),
    driversRes: supabase.from('drivers').select('*').order('created_at'),
    channelsRes: supabase.from('channels').select('*').order('created_at'),
    originsRes: supabase.from('origins').select('*').order('created_at'),
    dropPointsRes: supabase.from('drop_points').select('*').order('created_at'),
    routesRes: supabase.from('routes').select('*, origins(address), route_versions(*, route_version_points(*))'),
    assignmentsRes: supabase.from('assignments').select('*, assignment_drop_points(*)').order('trip_date'),
    adjustmentsRes: supabase.from('adjustments').select('*'),
    statementsRes: supabase.from('statements').select('*'),
    // 同樣的道理：schema.sql 只 grant app_driver 對 notifications 的 insert 權限
    // （司機端沒有通知頁，出發/完成時只需要新增一筆，不需要讀取），所以司機身份
    // 查這個表一定 permission denied，只有 admin 才查。
    ...(isAdmin ? { notificationsRes: supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(200) } : {})
  };
  const keys = Object.keys(queries);
  const results = await Promise.all(Object.values(queries));
  const byKey = {};
  keys.forEach((k, i) => { byKey[k] = results[i]; });
  for (const [label, res] of Object.entries(byKey)) {
    if (res.error) throw new Error(`載入 ${label} 失敗：${res.error.message}`);
  }

  const data = {
    settings: { adminPin: byKey.settingsRes?.data?.admin_pin || '' },
    drivers: (byKey.driversRes.data || []).map(mapDriver),
    channels: (byKey.channelsRes.data || []).map(mapChannel),
    origins: (byKey.originsRes.data || []).map(mapOrigin),
    dropPoints: (byKey.dropPointsRes.data || []).map(mapDropPoint),
    routes: (byKey.routesRes.data || []).map(mapRoute),
    assignments: (byKey.assignmentsRes.data || []).map(mapAssignment),
    adjustments: (byKey.adjustmentsRes.data || []).map(mapAdjustment),
    statements: (byKey.statementsRes.data || []).map(mapStatement),
    notifications: (byKey.notificationsRes?.data || []).map(mapNotification)
  };

  await resolvePhotoUrls(data.assignments);
  await resolveSignatureUrls(data.statements);
  return data;
}

async function fetchAssignment(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('assignments').select('*, assignment_drop_points(*)').eq('id', id).single();
  if (error) throw new Error('讀取車趟失敗：' + error.message);
  const assignment = mapAssignment(data);
  await resolvePhotoUrls([assignment]);
  return assignment;
}

// ---------------- 通知（司機端動作會建立一筆，失敗不擋主流程） ----------------

async function createNotification(type, message) {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('notifications').insert({ type, message });
    if (error) console.error('建立通知失敗：', error.message);
  } catch (e) { console.error('建立通知失敗：', e.message); }
}

async function markAllNotificationsRead() {
  const supabase = getSupabase();
  const unreadIds = state.data.notifications.filter(n => !n.read).map(n => n.id);
  if (!unreadIds.length) return;
  const { error } = await supabase.from('notifications').update({ read: true }).in('id', unreadIds);
  if (error) throw new Error('標記已讀失敗：' + error.message);
  state.data.notifications.forEach(n => n.read = true);
}

// ---------------- 司機 ----------------

async function createDriver(input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drivers').insert({
    name: input.name, phone: input.phone || null, line_user_id: input.lineId || null,
    access_code: String(Math.floor(1000 + Math.random() * 9000)),
    vehicle_plate: input.plate || null, vehicle_type: input.vtype || null, vehicle_load: input.vload || null,
    bank_name: input.bankName || null, bank_branch: input.branch || null,
    bank_account: input.account || null, bank_holder: input.holder || null,
    status: input.status || 'active'
  }).select().single();
  if (error) throw new Error('新增司機失敗：' + error.message);
  const driver = mapDriver(data);
  state.data.drivers.push(driver);
  return driver;
}

async function regenerateDriverAccessCode(driverId) {
  const supabase = getSupabase();
  const newCode = String(Math.floor(1000 + Math.random() * 9000));
  const { data, error } = await supabase.from('drivers').update({ access_code: newCode }).eq('id', driverId).select().single();
  if (error) throw new Error('重新產生代碼失敗：' + error.message);
  const driver = state.data.drivers.find(d => d.id === driverId);
  if (driver) driver.accessCode = data.access_code;
}

async function deleteOrDeactivateDriver(driverId) {
  const referenced = state.data.assignments.some(a => a.driverId === driverId);
  const supabase = getSupabase();
  if (referenced) {
    const inactiveAt = new Date().toISOString();
    const { error } = await supabase.from('drivers').update({ status: 'inactive', inactive_at: inactiveAt }).eq('id', driverId);
    if (error) throw new Error('停用司機失敗：' + error.message);
    const driver = state.data.drivers.find(d => d.id === driverId);
    if (driver) { driver.status = 'inactive'; driver.inactiveAt = inactiveAt; }
    return 'deactivated';
  }
  const { error } = await supabase.from('drivers').delete().eq('id', driverId);
  if (error) throw new Error('刪除司機失敗：' + error.message);
  state.data.drivers = state.data.drivers.filter(d => d.id !== driverId);
  return 'deleted';
}

// 司機端「我的資料」頁可編輯欄位（跟 schema.sql 裡 app_driver 的欄位權限一致）
// changeSummary：呼叫端算好的「修改了哪些欄位」文字（例如「電話、車牌」），
// 沒傳的話通知訊息會用比較籠統的說法。
async function updateDriverProfile(driverId, fields, changeSummary) {
  const payload = {};
  if ('phone' in fields) payload.phone = fields.phone || null;
  if ('lineId' in fields) payload.line_user_id = fields.lineId || null;
  if ('plate' in fields) payload.vehicle_plate = fields.plate || null;
  if ('vtype' in fields) payload.vehicle_type = fields.vtype || null;
  if ('vload' in fields) payload.vehicle_load = fields.vload || null;
  if ('bankName' in fields) payload.bank_name = fields.bankName || null;
  if ('branch' in fields) payload.bank_branch = fields.branch || null;
  if ('account' in fields) payload.bank_account = fields.account || null;
  if ('holder' in fields) payload.bank_holder = fields.holder || null;
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drivers').update(payload).eq('id', driverId).select().single();
  if (error) throw new Error('更新資料失敗：' + error.message);
  const idx = state.data.drivers.findIndex(d => d.id === driverId);
  if (idx >= 0) state.data.drivers[idx] = mapDriver(data);
  await createNotification('profile', `${data.name} 修改了基本資料${changeSummary ? '：' + changeSummary : ''}`);
}

// ---------------- 通路 ----------------

function channelPayload(input) {
  return {
    name: input.name, period_type: input.periodType, start_day: input.startDay,
    end_day: input.periodType === 'custom' ? input.endDay : null,
    formula_type: input.formulaType, rate_km: input.rateKm, rate_point: input.ratePoint, flat_amount: input.flatAmount
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

// ---------------- 出發點 ----------------

async function createOrigin(input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('origins').insert({ address: input.address, label: input.label || null, status: 'active' }).select().single();
  if (error) throw new Error('新增出發點失敗：' + error.message);
  const origin = mapOrigin(data);
  state.data.origins.push(origin);
  return origin;
}

async function updateOrigin(originId, input) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('origins').update({ address: input.address, label: input.label || null }).eq('id', originId).select().single();
  if (error) throw new Error('更新出發點失敗：' + error.message);
  const idx = state.data.origins.findIndex(o => o.id === originId);
  if (idx >= 0) state.data.origins[idx] = mapOrigin(data);
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
  const dup = state.data.dropPoints.find(dp => dp.status !== 'inactive' && dp.address.trim().toLowerCase() === input.address.trim().toLowerCase());
  if (dup) throw new Error(`地址重複，已存在相同的下貨點：「${dup.address}」（${channelName(dup.channelId)}），已取消新增。`);
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
  const dup = state.data.dropPoints.find(x => x.id !== dpId && x.status !== 'inactive' && x.address.trim().toLowerCase() === input.address.trim().toLowerCase());
  if (dup) throw new Error(`地址重複，已存在相同的下貨點：「${dup.address}」（${channelName(dup.channelId)}），已取消儲存。`);
  const code = (input.code || '').trim();
  if (code) {
    const dupCode = state.data.dropPoints.find(x => x.id !== dpId && x.status !== 'inactive' && x.channelId === input.channelId && (x.code || '').trim().toLowerCase() === code.toLowerCase());
    if (dupCode) throw new Error(`代號重複，同一通路（${channelName(input.channelId)}）已經有代號「${dupCode.code}」的下貨點：「${dupCode.address}」，已取消儲存。`);
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drop_points').update({
    address: input.address, channel_id: input.channelId, code: input.code || null
  }).eq('id', dpId).select().single();
  if (error) throw new Error('更新下貨點失敗：' + error.message);
  const idx = state.data.dropPoints.findIndex(x => x.id === dpId);
  if (idx >= 0) state.data.dropPoints[idx] = mapDropPoint(data);
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
    .insert({ name: input.name, origin_id: origin.id, seq: input.seq, shift: input.shift })
    .select('*, origins(address), route_versions(*, route_version_points(*))')
    .single();
  if (error) throw new Error('新增路線失敗：' + error.message);
  const route = mapRoute(data);
  state.data.routes.push(route);
  return route;
}

async function deleteRoute(routeId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('routes').delete().eq('id', routeId);
  if (error) throw new Error('刪除路線失敗：' + error.message);
  state.data.routes = state.data.routes.filter(r => r.id !== routeId);
}

// 對應 demo 的 saveRouteVersion() + recomputeRouteVersionEnds()：
// 新增/覆寫一個版本的下貨點順序後，重新計算這條路線所有版本的生效區間
// （每個版本的 end = 下一個版本 start 前一天，最後一個版本 end = null）。
async function saveRouteVersion(routeId, newStart, dropPointIds) {
  const route = state.data.routes.find(r => r.id === routeId);
  if (!route) throw new Error('找不到路線');
  const supabase = getSupabase();

  let version = route.versions.find(v => v.start === newStart);
  if (version) {
    const { error: delErr } = await supabase.from('route_version_points').delete().eq('route_version_id', version.id);
    if (delErr) throw new Error('更新路線版本失敗：' + delErr.message);
  } else {
    const { data: newVer, error: insErr } = await supabase.from('route_versions')
      .insert({ route_id: routeId, start_date: newStart }).select().single();
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

// ---------------- 車趟指派與生命週期 ----------------

async function createAssignment(input) {
  const route = state.data.routes.find(r => r.id === input.routeId);
  if (!route) throw new Error('找不到路線');
  const version = route.versions.find(v => input.date >= v.start && (!v.end || input.date <= v.end));
  const dropPointIds = version ? version.dropPointIds : [];

  const supabase = getSupabase();
  const { data: assignRow, error } = await supabase.from('assignments').insert({
    trip_date: input.date, route_id: input.routeId, driver_id: input.driverId,
    origin_snapshot: route.originAddr || '', fare: input.fare, distance_km: input.distanceKm, status: 'scheduled'
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

async function deleteAssignment(assignmentId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').delete().eq('id', assignmentId);
  if (error) throw new Error('刪除車趟失敗：' + error.message);
  state.data.assignments = state.data.assignments.filter(a => a.id !== assignmentId);
}

async function markAssignmentDeparted(assignmentId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').update({ status: 'in_progress' }).eq('id', assignmentId);
  if (error) throw new Error('更新狀態失敗：' + error.message);
  const a = state.data.assignments.find(x => x.id === assignmentId);
  if (a) a.status = 'in_progress';
  await createNotification('depart', `${driverName(a?.driverId)} 已出發 － ${routeName(a?.routeId)}（${a?.date || ''}）`);
}

// issueNote 有值代表「尚有下貨點未拍照回報」時司機填寫的原因說明，跟 demo 的
// 「完成本趟」流程一致：同一次操作把 status/has_issue/issue_note 一起送出。
// 完成時間（completed_at）與司機報酬凍結快照（payroll_fare_snapshot）由資料庫
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
  await createNotification('complete', `${driverName(full.driverId)} 已完成 ${routeName(full.routeId)}（${full.date}）${full.hasIssue ? ' ⚠️ 有異常備註' : ''}`);
  return full;
}

// 車趟管理的人工輸入：司機費用、里程、各通路請款金額都由主控直接 key in，
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
  const { error: upErr } = await supabase.storage.from('assignment-photos').upload(path, bytes, { contentType, upsert: true });
  if (upErr) throw new Error('照片上傳失敗：' + upErr.message);

  const completedAt = new Date().toISOString();
  const { error: updErr } = await supabase.from('assignment_drop_points')
    .update({ status: 'completed', photo_url: path, completed_at: completedAt })
    .eq('id', dropPointId);
  if (updErr) throw new Error('更新下貨點狀態失敗：' + updErr.message);

  const assignment = state.data.assignments.find(a => a.id === assignmentId);
  const dp = assignment?.dropPoints.find(x => x.id === dropPointId);
  if (dp) { dp.status = 'completed'; dp.photoPath = path; dp.photo = dataUrl; }
  // 通知訊息只顯示代號本身（有代號就不再附完整地址，維持通知列表簡潔），
  // 沒設代號的下貨點才退回顯示地址；跟司機行程頁「代號+地址都顯示」的 dpLabel() 不一樣。
  await createNotification('photo', `${driverName(assignment?.driverId)} 於「${dp?.code || dp?.address || ''}」完成拍照回報`);
}

async function bulkDeleteAssignments(ids) {
  const supabase = getSupabase();
  const { error } = await supabase.from('assignments').delete().in('id', ids);
  if (error) throw new Error('刪除資料失敗：' + error.message);
  const idSet = new Set(ids);
  state.data.assignments = state.data.assignments.filter(a => !idSet.has(a.id));
}

// ---------------- 薪資調整項 / 月結對帳單 ----------------

async function createAdjustment(input) {
  const already = state.data.statements.find(s => s.driverId === input.driverId && s.month === input.month);
  if (already) throw new Error('這個月份已經月結確認過，如需調整請先處理下個月，或聯絡開發者協助修正已結算資料。');
  const supabase = getSupabase();
  const { data, error } = await supabase.from('adjustments').insert({
    driver_id: input.driverId, adjustment_month: `${input.month}-01`,
    adjustment_type: input.type, amount: input.amount, note: input.note || null
  }).select().single();
  if (error) throw new Error('新增調整項失敗：' + error.message);
  const adj = mapAdjustment(data);
  state.data.adjustments.push(adj);
  return adj;
}

async function deleteAdjustment(adjustmentId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('adjustments').delete().eq('id', adjustmentId);
  if (error) throw new Error('刪除調整項失敗：' + error.message);
  state.data.adjustments = state.data.adjustments.filter(a => a.id !== adjustmentId);
}

async function bulkDeleteAdjustments(ids) {
  const supabase = getSupabase();
  const { error } = await supabase.from('adjustments').delete().in('id', ids);
  if (error) throw new Error('刪除資料失敗：' + error.message);
  const idSet = new Set(ids);
  state.data.adjustments = state.data.adjustments.filter(a => !idSet.has(a.id));
}

// live: driverMonthly() 算出來的即時金額（凍結當下的快照數字）
async function confirmMonthlyStatement(driverId, month, live) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('statements').insert({
    driver_id: driverId, statement_month: `${month}-01`,
    trip_total: live.tripTotal, adj_total: live.adjTotal, net_amount: live.net,
    status: 'awaiting_signature', confirmed_at: new Date().toISOString(), admin_acked: false
  }).select().single();
  if (error) throw new Error('月結確認失敗：' + error.message);
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
  await createNotification('statement', `${driverName(s?.driverId)} 已完成 ${s?.month || ''} 對帳單回簽`);
}

// ---------------- 系統設定 ----------------

async function updateAdminPin(pin) {
  const supabase = getSupabase();
  const { error } = await supabase.from('settings').update({ admin_pin: pin }).eq('id', 1);
  if (error) throw new Error('更新PIN碼失敗：' + error.message);
  state.data.settings.adminPin = pin;
}

// 「匯出全部備份」沿用 demo 的 JSON.stringify(state.data)，只是資料來源換成即時查詢結果；
// 「匯入覆蓋全系統」這個危險操作已依討論結果拿掉，不搬到正式版
// （Supabase 專案本身有資料庫層級備份機制，不需要靠這種方式防資料遺失）。
