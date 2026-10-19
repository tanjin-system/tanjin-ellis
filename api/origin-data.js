// 任務起點專屬查詢頁（origin.html）的資料來源。前端只帶著 token 呼叫這支 API，驗證與查詢都在這裡用
// service role 做；資料庫對 anon 角色完全鎖死（見 schema PART 36），所以即使有人直接打 Supabase 也拿不到資料，
// 一定要經過這支函式。只回傳「看行程」需要的欄位：車次名稱、班次、店點順序與名稱、通路名稱。
// 不含：夥伴費用、請款金額、各通路拆賬、里程、夥伴姓名電話——這些欄位這裡的 SQL 選取範圍本來就沒有取用，
// 不是前端藏起來而已。
// 回應帶 s-maxage 讓 Vercel 邊緣快取 30 秒：同一個起點被反覆打開，資料庫也最多每 30 秒被問一次。
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function taipeiToday() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少存取權杖' });

  const { data: origin, error: oErr } = await supabase.from('origins').select('id, address, label').eq('access_token', token).maybeSingle();
  if (oErr) { console.error('origin-data lookup failed:', oErr.message); return res.status(500).json({ error: '伺服器錯誤，請稍後再試' }); }
  if (!origin) return res.status(404).json({ error: '連結無效或已停用，請向主控確認最新連結。' });

  const today = taipeiToday();
  try {
    const { data: routes, error: rErr } = await supabase.from('routes')
      .select('id, name, seq, shift, created_at, route_versions(id, start_date, end_date, route_version_points(sequence_no, drop_points(code, address, channels(name))))')
      .eq('origin_id', origin.id).eq('status', 'active').order('shift').order('created_at');
    if (rErr) throw new Error(rErr.message);

    const stopsOf = (version) => version ? (version.route_version_points || [])
      .slice().sort((a, b) => a.sequence_no - b.sequence_no)
      .map(p => ({ store: (p.drop_points && (p.drop_points.code || p.drop_points.address)) || '', channel: (p.drop_points && p.drop_points.channels && p.drop_points.channels.name) || '' }))
      : [];

    const items = (routes || []).map(r => {
      const versions = r.route_versions || [];
      // 今天生效的版本；如果有舊版本忘了填 end_date，會跟新版本同時符合「今天生效」，
      // 這裡一定要取 start_date 最新的那個，不能用陣列裡隨便第一個符合的（資料庫回傳順序
      // 不保證跟日期順序一致），不然主控明明已經新增新版本，頁面卻一直顯示舊的行程。
      // 找不到任何今天生效的版本（例如資料還沒排到今天）就退回最近一個開始生效的版本，
      // 不要整條車次直接消失不顯示。
      const todaysVersions = versions.filter(v => v.start_date <= today && (!v.end_date || v.end_date >= today));
      const active = (todaysVersions.length ? todaysVersions : versions)
        .slice().sort((a, b) => b.start_date.localeCompare(a.start_date))[0] || null;
      const stops = stopsOf(active);

      // 預告未來異動：主控常常提前排好「明天/下週生效」的新版本，出發點不會剛好在生效當天
      // 才第一次打開連結，必須提前讓他們看到——否則變動當天司機才發現行程不一樣就太晚了。
      // 只取最近的下一個未來版本（生效日最早的那個），且內容真的跟目前不同才顯示，避免
      // 單純重建同一份內容的版本也跳預告。
      const futureVersions = versions.filter(v => v.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date));
      const nextVersion = futureVersions[0] || null;
      const upcomingStops = stopsOf(nextVersion);
      const upcoming = (nextVersion && upcomingStops.length && JSON.stringify(upcomingStops) !== JSON.stringify(stops))
        ? { effectiveDate: nextVersion.start_date, stops: upcomingStops }
        : null;

      return { id: r.id, name: r.name, shift: r.shift, stops, upcoming };
    }).filter(r => r.stops.length || r.upcoming);

    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=15');
    // originId／每個車次的 id 都只是內部的 UUID，沒有金額或個資意義，前端用來做「本機資料存取 key」
    // 跟「行程有沒有被主控調整過」的比對，不會因為 token 重新產生而跟著變。
    return res.status(200).json({ originId: origin.id, originLabel: origin.label || origin.address, originAddress: origin.address, today, routes: items });
  } catch (e) {
    console.error('origin-data query failed:', e.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
};
