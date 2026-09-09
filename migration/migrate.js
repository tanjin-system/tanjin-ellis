// 一次性資料匯入腳本：把 real_data.json 匯入到已套用 supabase/schema.sql 的 Supabase 專案。
// 使用方式見對話說明；務必先在 Supabase SQL Editor 完整執行 supabase/schema.sql。
// 這裡用 service role key 連線，會繞過 RLS，跟 schema.sql 裡的 app_admin/app_driver 權限設計無關。
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const FORCE = process.argv.includes('--force');
const DATA_FILE = process.argv.find(a => a.endsWith('.json')) || path.join(__dirname, '..', '..', 'real_data.json');
const BUCKET = 'assignment-photos';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，請先建立 .env（可參考 .env.example）。');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const orNull = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
const num = v => (v === undefined || v === null || v === '') ? null : Number(v);

const warnings = [];
const mapping = { channels: {}, origins: {}, dropPoints: {}, drivers: {}, routes: {}, assignments: {} };

async function insertOne(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`insert ${table} 失敗：${error.message}\n row=${JSON.stringify(row)}`);
  return data;
}

async function assertEmptyOrForce() {
  const tables = ['channels', 'origins', 'drop_points', 'drivers', 'routes', 'assignments', 'notifications'];
  for (const t of tables) {
    const { count, error } = await supabase.from(t).select('id', { count: 'exact', head: true });
    if (error) throw new Error(`檢查 ${t} 是否為空時失敗：${error.message}`);
    if (count > 0 && !FORCE) {
      console.error(`資料表 "${t}" 已經有 ${count} 筆資料。為避免重複匯入造成髒資料，已中止。`);
      console.error('若確定要在既有資料上繼續疊加匯入，請加上 --force 參數重新執行（不建議；建議先清空資料表再匯入）。');
      process.exit(1);
    }
  }
}

async function ensureBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`列出 storage bucket 失敗：${error.message}`);
  for (const name of [BUCKET, 'signatures']) {
    if (!buckets.find(b => b.name === name)) {
      const { error: createErr } = await supabase.storage.createBucket(name, { public: false });
      if (createErr) throw new Error(`建立 bucket ${name} 失敗：${createErr.message}`);
      console.log(`已建立 storage bucket: ${name}（私有，需用 signed URL 存取）`);
    }
  }
}

async function uploadPhoto(dataUrl, objectPath) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
  if (!match) { warnings.push(`照片格式不是預期的 base64 data URL，已略過：${objectPath}`); return null; }
  const [, contentType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  const { error } = await supabase.storage.from(BUCKET).upload(objectPath, buffer, { contentType, upsert: true });
  if (error) { warnings.push(`照片上傳失敗（${objectPath}）：${error.message}`); return null; }
  return objectPath;
}

async function main() {
  console.log(`讀取資料檔：${DATA_FILE}`);
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  await assertEmptyOrForce();
  await ensureBucket();

  // 0. settings
  const adminPin = raw.settings?.adminPin || '0000';
  const { error: setErr } = await supabase.from('settings').update({ admin_pin: adminPin }).eq('id', 1);
  if (setErr) throw new Error(`更新 settings 失敗：${setErr.message}`);
  console.log('settings 完成');

  // 1. channels
  for (const ch of raw.channels) {
    const row = await insertOne('channels', {
      name: ch.name,
      period_type: ch.periodType,
      start_day: ch.startDay,
      end_day: ch.endDay ?? null,
      status: ch.status || 'active',
      formula_type: ch.formulaType || 'per_km_and_point',
      rate_km: num(ch.rateKm) ?? 0,
      rate_point: num(ch.ratePoint) ?? 0,
      flat_amount: num(ch.flatAmount) ?? 0
    });
    mapping.channels[ch.id] = row.id;
  }
  console.log(`channels 完成：${raw.channels.length} 筆`);

  // 2. origins
  const originAddressToNewId = {};
  for (const og of raw.origins) {
    const row = await insertOne('origins', {
      address: og.address,
      label: orNull(og.label),
      status: og.status || 'active'
    });
    mapping.origins[og.id] = row.id;
    originAddressToNewId[og.address.trim()] = row.id;
  }
  console.log(`origins 完成：${raw.origins.length} 筆`);

  // 3. drop_points
  for (const dp of raw.dropPoints) {
    const channelId = mapping.channels[dp.channelId];
    if (!channelId) { warnings.push(`下貨點 ${dp.id} 找不到對應的通路 ${dp.channelId}，已略過`); continue; }
    const row = await insertOne('drop_points', {
      address: dp.address,
      channel_id: channelId,
      code: orNull(dp.code),
      status: dp.status || 'active'
    });
    mapping.dropPoints[dp.id] = row.id;
  }
  console.log(`drop_points 完成：${Object.keys(mapping.dropPoints).length} / ${raw.dropPoints.length} 筆`);

  // 4. drivers
  for (const dr of raw.drivers) {
    const row = await insertOne('drivers', {
      name: dr.name,
      phone: orNull(dr.phone),
      line_user_id: orNull(dr.lineId),
      access_code: orNull(dr.accessCode),
      status: dr.status || 'active',
      inactive_at: dr.inactiveAt || null,
      vehicle_plate: orNull(dr.vehicle?.plate),
      vehicle_type: orNull(dr.vehicle?.type),
      vehicle_load: num(dr.vehicle?.load),
      bank_name: orNull(dr.bank?.bankName),
      bank_branch: orNull(dr.bank?.branch),
      bank_account: orNull(dr.bank?.account),
      bank_holder: orNull(dr.bank?.holder)
    });
    mapping.drivers[dr.id] = row.id;
  }
  console.log(`drivers 完成：${raw.drivers.length} 筆`);

  // 5. routes
  for (const rt of raw.routes) {
    const originId = originAddressToNewId[rt.originAddr.trim()];
    if (!originId) { warnings.push(`路線 ${rt.name} 的出發點地址「${rt.originAddr}」在 origins 裡找不到對應項目，已略過整條路線`); continue; }
    const row = await insertOne('routes', {
      name: rt.name,
      origin_id: originId,
      seq: rt.seq,
      shift: rt.shift
    });
    mapping.routes[rt.id] = row.id;

    // route_versions + route_version_points
    for (const v of (rt.versions || [])) {
      const verRow = await insertOne('route_versions', {
        route_id: row.id,
        start_date: v.start,
        end_date: v.end || null
      });
      let seq = 1;
      for (const oldDpId of (v.dropPointIds || [])) {
        const newDpId = mapping.dropPoints[oldDpId];
        if (!newDpId) { warnings.push(`路線版本 ${rt.name}/${v.start} 裡的下貨點 ${oldDpId} 找不到對應項目，已略過`); continue; }
        const { error } = await supabase.from('route_version_points').insert({
          route_version_id: verRow.id,
          drop_point_id: newDpId,
          sequence_no: seq++
        });
        if (error) throw new Error(`insert route_version_points 失敗：${error.message}`);
      }
    }
  }
  console.log(`routes 完成：${Object.keys(mapping.routes).length} / ${raw.routes.length} 筆（含各自的 route_versions）`);

  // 6. assignments + assignment_drop_points
  let assignmentCount = 0, photoCount = 0;
  for (const a of raw.assignments) {
    const routeId = mapping.routes[a.routeId];
    const driverId = mapping.drivers[a.driverId];
    if (!routeId || !driverId) { warnings.push(`車趟 ${a.id}（${a.date}）找不到對應的路線或司機，已略過`); continue; }

    let billingTotal = null, billingByChannel = null;
    if (a.billingSnapshot) {
      billingTotal = a.billingSnapshot.totalAmount;
      billingByChannel = {};
      for (const [oldChId, amt] of Object.entries(a.billingSnapshot.byChannel || {})) {
        const newChId = mapping.channels[oldChId];
        if (newChId) billingByChannel[newChId] = amt;
        else warnings.push(`車趟 ${a.id} 的請款快照裡有未知通路 ${oldChId}`);
      }
    }

    const assignRow = await insertOne('assignments', {
      trip_date: a.date,
      route_id: routeId,
      driver_id: driverId,
      run_no: a.runNo || 1,
      origin_snapshot: orNull(a.origin),
      fare: num(a.fare) ?? 0,
      distance_km: num(a.distanceKm),
      status: a.status,
      has_issue: !!a.hasIssue,
      issue_note: orNull(a.issueNote),
      completed_at: a.completedAt || null,
      payroll_fare_snapshot: num(a.payrollFareSnapshot),
      billing_total_snapshot: billingTotal,
      billing_by_channel_snapshot: billingByChannel
    });
    mapping.assignments[a.id] = assignRow.id;
    assignmentCount++;

    let seq = 1;
    for (const dp of (a.dropPoints || [])) {
      const channelId = mapping.channels[dp.channelId];
      const sourceDpId = mapping.dropPoints[dp.sourceDpId] || null;
      let photoPath = null;
      if (dp.photo) {
        photoPath = await uploadPhoto(dp.photo, `${assignRow.id}/${dp.id}.jpg`);
        if (photoPath) photoCount++;
      }
      const { error } = await supabase.from('assignment_drop_points').insert({
        assignment_id: assignRow.id,
        source_drop_point_id: sourceDpId,
        address: dp.address,
        channel_id: channelId,
        sequence_no: seq++,
        status: dp.status || 'pending',
        photo_url: photoPath,
        photo_cleared: false,
        completed_at: (dp.status === 'completed') ? (a.completedAt || null) : null
      });
      if (error) throw new Error(`insert assignment_drop_points 失敗：${error.message}`);
    }
  }
  console.log(`assignments 完成：${assignmentCount} / ${raw.assignments.length} 筆，上傳照片 ${photoCount} 張`);

  // 7. adjustments（目前 real_data.json 是空陣列，但仍照通用邏輯處理，未來有資料也能直接用）
  for (const adj of (raw.adjustments || [])) {
    const driverId = mapping.drivers[adj.driverId];
    if (!driverId) { warnings.push(`調整項 ${adj.id} 找不到對應司機，已略過`); continue; }
    await insertOne('adjustments', {
      driver_id: driverId,
      adjustment_month: adj.month ? `${adj.month}-01` : null,
      adjustment_type: adj.type,
      amount: num(adj.amount) ?? 0,
      note: orNull(adj.note)
    });
  }
  console.log(`adjustments 完成：${(raw.adjustments || []).length} 筆`);

  // 8. statements（目前為空陣列。若未來匯入時已有簽名資料，signature_url 這裡先原樣存入
  // base64 dataURL，跟舊系統一樣未做 Storage 化；之後有真實簽名資料時應改成跟照片一樣
  // 上傳到 Storage 再存路徑，這裡先不處理是因為目前沒有樣本資料可驗證欄位/流程）
  for (const st of (raw.statements || [])) {
    const driverId = mapping.drivers[st.driverId];
    if (!driverId) { warnings.push(`對帳單 ${st.id} 找不到對應司機，已略過`); continue; }
    await insertOne('statements', {
      driver_id: driverId,
      statement_month: st.month ? `${st.month}-01` : null,
      trip_total: num(st.tripTotal) ?? 0,
      adj_total: num(st.adjTotal) ?? 0,
      net_amount: num(st.net) ?? 0,
      status: st.status || 'awaiting_signature',
      confirmed_at: st.confirmedAt || null,
      signed_at: st.signedAt || null,
      signature_url: orNull(st.signatureDataUrl),
      admin_acked: !!st.adminAcked
    });
  }
  console.log(`statements 完成：${(raw.statements || []).length} 筆`);

  // 9. notifications
  let notifCount = 0;
  for (const n of (raw.notifications || [])) {
    const { error } = await supabase.from('notifications').insert({
      type: n.type,
      message: n.message,
      related_assignment_id: null,
      related_driver_id: null,
      read: !!n.read,
      created_at: n.createdAt || new Date().toISOString()
    });
    if (error) { warnings.push(`通知 ${n.id} 匯入失敗：${error.message}`); continue; }
    notifCount++;
  }
  console.log(`notifications 完成：${notifCount} / ${(raw.notifications || []).length} 筆`);

  fs.writeFileSync(path.join(__dirname, 'id_mapping.json'), JSON.stringify(mapping, null, 2));
  console.log('\n舊 id → 新 id 對照表已寫入 id_mapping.json（供之後核對用）。');

  if (warnings.length) {
    console.log(`\n共有 ${warnings.length} 筆警告：`);
    warnings.forEach(w => console.log(' - ' + w));
  } else {
    console.log('\n沒有任何警告，匯入乾淨完成。');
  }
}

main().catch(err => {
  console.error('\n匯入過程發生錯誤，已中止：');
  console.error(err.message);
  process.exit(1);
});
