// 配送照片 30 天自動清除（每天一次，vercel.json 的排程呼叫 /api/photos-cleanup?run=1）。
// 清除對象（都在 Storage 的 assignment-photos 桶）：
//   1. 送達證明照：assignment_drop_points.completed_at 超過 30 天、photo_cleared=false → 刪檔，photo_url 設 null、photo_cleared 設 true
//      （夥伴端畫面會顯示「照片已超過30天自動清除」）。
//   2. 補充附件（多張照片／影片）：assignment_drop_point_media.created_at 超過 30 天 → 刪檔並刪除紀錄。
// 不碰簽名檔（signatures）與夥伴證件（driver-docs）。
// 沒帶 run=1 只是「預覽」：回傳會清除幾筆，不會刪任何東西。
// 先刪檔、成功才改資料庫；刪檔失敗的那一批不改資料庫，下次排程會再試。每次最多處理 600 筆，積壓的舊照片會分幾天清完。
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const KEEP_DAYS = 30;
const MAX_PER_RUN = 600;
const CHUNK = 100;
const BUCKET = 'assignment-photos';

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const run = String(req.query.run || '') === '1';
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString();
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [mainRes, mediaRes] = await Promise.all([
      supabase.from('assignment_drop_points').select('id, photo_url, completed_at')
        .eq('photo_cleared', false).not('photo_url', 'is', null).lt('completed_at', cutoff)
        .order('completed_at', { ascending: true }).limit(MAX_PER_RUN),
      supabase.from('assignment_drop_point_media').select('id, media_url, created_at')
        .lt('created_at', cutoff).order('created_at', { ascending: true }).limit(MAX_PER_RUN)
    ]);
    if (mainRes.error) throw new Error(mainRes.error.message);
    if (mediaRes.error) throw new Error(mediaRes.error.message);
    const mains = mainRes.data || [], medias = mediaRes.data || [];
    const out = {
      mode: run ? 'run' : 'preview', cutoff, keepDays: KEEP_DAYS,
      mainPhotos: mains.length, extraMedia: medias.length,
      oldest: [mains[0] && mains[0].completed_at, medias[0] && medias[0].created_at].filter(Boolean).sort()[0] || null,
      note: mains.length >= MAX_PER_RUN || medias.length >= MAX_PER_RUN ? '還有更多，會在接下來幾天分批清完' : undefined
    };
    if (!run) return res.status(200).json(out);

    let deletedMain = 0, deletedMedia = 0, failed = 0;
    for (let i = 0; i < mains.length; i += CHUNK) {
      const part = mains.slice(i, i + CHUNK);
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove(part.map(p => p.photo_url));
      if (rmErr) { failed += part.length; console.error('photo remove failed:', rmErr.message); continue; }
      const { error: upErr } = await supabase.from('assignment_drop_points').update({ photo_url: null, photo_cleared: true }).in('id', part.map(p => p.id));
      if (upErr) { failed += part.length; console.error('photo flag update failed:', upErr.message); continue; }
      deletedMain += part.length;
    }
    for (let i = 0; i < medias.length; i += CHUNK) {
      const part = medias.slice(i, i + CHUNK);
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove(part.map(p => p.media_url));
      if (rmErr) { failed += part.length; console.error('media remove failed:', rmErr.message); continue; }
      const { error: delErr } = await supabase.from('assignment_drop_point_media').delete().in('id', part.map(p => p.id));
      if (delErr) { failed += part.length; console.error('media row delete failed:', delErr.message); continue; }
      deletedMedia += part.length;
    }
    return res.status(200).json(Object.assign(out, { deletedMain, deletedMedia, failed }));
  } catch (e) {
    console.error('photos-cleanup failed:', e.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
};
