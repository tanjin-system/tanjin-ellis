// 戰情室外部連結（大螢幕／不登入）的資料來源。前端只帶 token 呼叫這支 API，驗證與查詢都在這裡用
// service role 做，資料庫對 anon 維持完全鎖死。唯讀（沒有任何寫入），而且刻意只回傳「看進度」需要的最少欄位：
// 路線名稱、任務起點、每一站有沒有完成與完成時間、有沒有回報未完成原因、有沒有排人。
// 不含夥伴姓名／電話、店點名稱與地址、未完成原因內容、報酬與請款金額、照片。
// 回應帶 s-maxage 讓 Vercel 邊緣快取 45 秒：同時開幾個螢幕，資料庫也最多每 45 秒被問一次。
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function taipeiToday() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const token = String(req.query.token || '').trim();
  if (!token || token.length < 16) return res.status(400).json({ error: '缺少存取權杖' });

  const { data: settings, error: sErr } = await supabase.from('settings').select('warroom_token, warroom_config').eq('id', 1).maybeSingle();
  if (sErr) { console.error('warroom settings lookup failed:', sErr.message); return res.status(500).json({ error: '伺服器錯誤，請稍後再試' }); }
  if (!settings || !settings.warroom_token || !safeEqual(settings.warroom_token, token)) {
    return res.status(404).json({ error: '連結無效或已停用，請向主控確認最新連結。' });
  }

  // 「加入主畫面」用的專屬 manifest：系統本身的 site.webmanifest 起始網址固定是首頁，加到主畫面後會丟掉 ?wr=金鑰、
  // 點開變成登入畫面。外部連結頁面載入時把 <link rel="manifest"> 換成這支，起始網址就帶著金鑰。
  if (req.query.manifest) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    return res.status(200).send(JSON.stringify({
      name: '碳金戰情室', short_name: '戰情室', description: '碳金戰情室（唯讀）',
      start_url: '/wr/' + encodeURIComponent(token), scope: '/', display: 'standalone',
      background_color: '#0A0F1A', theme_color: '#0A0F1A',
      icons: [
        { src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/assets/icons/maskable-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/assets/icons/maskable-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    }));
  }

  const today = taipeiToday(), d7 = addDays(today, -7), d14 = addDays(today, -14);
  try {
    const [todayRes, histRes, originsRes, routesRes] = await Promise.all([
      supabase.from('assignments')
        .select('id, trip_date, route_id, driver_id, status, assignment_drop_points(status, completed_at, issue_reason, sequence_no)')
        .eq('trip_date', today).eq('published', true).neq('status', 'cancelled'),
      supabase.from('assignments').select('id, trip_date, route_id, status').in('trip_date', [d7, d14]).eq('published', true).neq('status', 'cancelled'),
      supabase.from('origins').select('id, address, label, status'),
      supabase.from('routes').select('id, name, seq, shift, status, origins(address), route_versions(start_date, end_date)')
    ]);
    for (const r of [todayRes, histRes, originsRes, routesRes]) if (r.error) throw new Error(r.error.message);
    const ids = (todayRes.data || []).map(a => a.id);
    let marks = [];
    if (ids.length) {
      const m = await supabase.from('war_room_marks').select('assignment_id, acked_count, resolved_count').in('assignment_id', ids);
      if (m.error) throw new Error(m.error.message);
      marks = m.data || [];
    }
    const assignments = (todayRes.data || []).map(a => ({
      id: a.id, date: a.trip_date, routeId: a.route_id, hasDriver: !!a.driver_id, status: a.status,
      dropPoints: (a.assignment_drop_points || []).slice().sort((x, y) => x.sequence_no - y.sequence_no).map(p => ({
        status: p.status, completedAt: p.completed_at, hasIssue: !!p.issue_reason
      }))
    })).concat((histRes.data || []).map(a => ({ id: a.id, date: a.trip_date, routeId: a.route_id, hasDriver: false, status: a.status, dropPoints: [] })));
    res.setHeader('Cache-Control', 'public, s-maxage=45, stale-while-revalidate=15');
    return res.status(200).json({
      today, windowStart: d14, config: settings.warroom_config || null,
      origins: (originsRes.data || []).map(o => ({ id: o.id, address: o.address, label: o.label || '', status: o.status })),
      routes: (routesRes.data || []).map(r => ({
        id: r.id, name: r.name, originAddr: r.origins ? r.origins.address : '', seq: r.seq, shift: r.shift, status: r.status || 'active',
        versions: (r.route_versions || []).map(v => ({ start: v.start_date, end: v.end_date }))
      })),
      assignments,
      marks: marks.map(m => ({ assignmentId: m.assignment_id, acked: m.acked_count || 0, resolved: m.resolved_count || 0 }))
    });
  } catch (e) {
    console.error('warroom query failed:', e.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
};
