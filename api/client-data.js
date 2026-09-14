// 客戶專屬瀏覽網頁的資料來源。前端（client.html）完全不碰 Supabase，
// 只帶著 token 呼叫這支 API；驗證與查詢都在這裡用 service role key 做，
// 資料庫對 anon 角色維持完全鎖死，不會因為這個公開頁面多開一個安全缺口。
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function pad(n) { return String(n).padStart(2, '0'); }

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const token = (req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少存取權杖' });

  const { data: channel, error: chErr } = await supabase
    .from('channels')
    .select('id, name')
    .eq('access_token', token)
    .maybeSingle();
  if (chErr) {
    console.error('client-data channel lookup failed:', chErr.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
  if (!channel) return res.status(404).json({ error: '連結無效或已失效，請跟貨運公司確認最新連結。' });

  // 只回溯最近 60 天（依車趟日期，不是完成時間），避免舊資料無意義地一直曝光；
  // 未來排定的車趟沒有上限，路線管理排多遠、這裡就顯示多遠。
  const since = new Date();
  since.setDate(since.getDate() - 60);
  const sinceStr = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;

  // 這裡故意用「這個通路在路線管理裡的每一個下貨點」單一查詢，不再依 completed/
  // pending 狀態分開查、也不對 completed_at/photo_url 加條件——之前拆成「已送達」
  // 「即將送達」兩支查詢，各自還有 500/300 筆的 limit，通路下貨點一多（例如7-11
  // 88個點，同時有445筆車趟下貨點紀錄）很容易被 limit 截斷，導致「明明路線管理裡
  // 有安排，客戶查詢卻看不到」。現在一次抓齊，用 delivered 欄位分辨已完成/尚未完成，
  // 完全不會因為狀態或筆數而整批消失。
  const { data: rows, error: rowsErr } = await supabase
    .from('assignment_drop_points')
    .select('id, address, code, status, completed_at, photo_url, assignments!inner(trip_date, status, routes!inner(shift))')
    .eq('channel_id', channel.id)
    .neq('assignments.status', 'cancelled')
    .gte('assignments.trip_date', sinceStr)
    .limit(5000);
  if (rowsErr) {
    console.error('client-data points query failed:', rowsErr.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }

  let signedUrls = {};
  const paths = rows.filter(p => p.photo_url).map(p => p.photo_url);
  if (paths.length) {
    const { data: signed, error: signErr } = await supabase.storage
      .from('assignment-photos')
      .createSignedUrls(paths, 60 * 60);
    if (signErr) {
      console.error('client-data sign urls failed:', signErr.message);
    } else {
      signed.forEach((s, i) => { if (s.signedUrl) signedUrls[paths[i]] = s.signedUrl; });
    }
  }

  // 安全上只選 address/code/completed_at/photo_url/trip_date/shift，绝不會帶到
  // fare/distance/billing 等金額欄位，所以無論哪個通路的連結，客戶都看不到司機費用，
  // 也看不到共配車趟上其他通路的站點（一律只用 channel_id 篩出這個通路自己的點）。
  const items = (rows || []).map(p => ({
    id: p.id,
    name: p.code || p.address,
    date: p.assignments.trip_date,
    shift: p.assignments?.routes?.shift || null,
    delivered: p.status === 'completed',
    completedAt: p.completed_at,
    photoUrl: p.photo_url ? (signedUrls[p.photo_url] || null) : null
  }));

  return res.status(200).json({ channelName: channel.name, items });
};
