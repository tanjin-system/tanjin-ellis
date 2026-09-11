// 客戶專屬瀏覽網頁的資料來源。前端（client.html）完全不碰 Supabase，
// 只帶著 token 呼叫這支 API；驗證與查詢都在這裡用 service role key 做，
// 資料庫對 anon 角色維持完全鎖死，不會因為這個公開頁面多開一個安全缺口。
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

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

  // 只給最近 60 天的資料，避免頁面一次載入太多筆、也避免舊資料無意義地一直曝光。
  const since = new Date();
  since.setDate(since.getDate() - 60);

  const { data: points, error: dpErr } = await supabase
    .from('assignment_drop_points')
    .select('id, address, code, completed_at, photo_url')
    .eq('channel_id', channel.id)
    .eq('status', 'completed')
    .not('photo_url', 'is', null)
    .gte('completed_at', since.toISOString())
    .order('completed_at', { ascending: false })
    .limit(500);
  if (dpErr) {
    console.error('client-data points query failed:', dpErr.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }

  let signedUrls = {};
  const paths = points.filter(p => p.photo_url).map(p => p.photo_url);
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

  const deliveries = points.map(p => ({
    id: p.id,
    name: p.code || p.address,
    completedAt: p.completed_at,
    photoUrl: p.photo_url ? (signedUrls[p.photo_url] || null) : null
  }));

  return res.status(200).json({ channelName: channel.name, deliveries });
};
