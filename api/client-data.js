// 客戶專屬瀏覽網頁的資料來源。前端（client.html）完全不碰 Supabase，
// 只帶著 token 呼叫這支 API；驗證與查詢都在這裡用 service role key 做，
// 資料庫對 anon 角色維持完全鎖死，不會因為這個公開頁面多開一個安全缺口。
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function pad(n) { return String(n).padStart(2, '0'); }

// 台灣縣市清單（含「臺」異體字，依地址開頭比對，最長/最完整名稱優先，
// 例如「新竹市」要在「新竹縣」之前個別列出，避免誤判成不存在的「新竹」）。
// 抓不到縣市的地址（格式異常或非台灣地址）歸到「其他地區」，不會整筆消失。
const TW_CITIES = [
  '台北市', '臺北市', '新北市', '桃園市', '台中市', '臺中市', '台南市', '臺南市', '高雄市',
  '基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣',
  '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
];
function extractCity(address) {
  if (!address) return '其他地區';
  const found = TW_CITIES.find(c => address.startsWith(c));
  return found ? found.replace('臺', '台') : '其他地區';
}

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

  // 這裡故意用「這個通路在路線管理裡的每一個店點」單一查詢，不再依 completed/
  // pending 狀態分開查、也不對 completed_at/photo_url 加條件——之前拆成「已送達」
  // 「即將送達」兩支查詢，各自還有 500/300 筆的 limit，通路店點一多（例如7-11
  // 88個點，同時有445筆車趟店點紀錄）很容易被 limit 截斷，導致「明明路線管理裡
  // 有安排，客戶查詢卻看不到」。現在一次抓齊，用 delivered 欄位分辨已完成/尚未完成，
  // 完全不會因為狀態或筆數而整批消失。
  //
  // 這裡的 .limit() 只是客戶端「最多要多少筆」的請求值，Supabase 專案本身在
  // PostgREST 層還有一個獨立的「Max Rows」上限（預設1000筆），不管客戶端
  // limit 開多大，伺服器都只會回傳到那個上限為止，而且沒下 order 的話回傳的
  // 是「哪1000筆」完全不保證跟日期順序有關——這正是實際發生過的bug：7-11一個
  // 通路60天+未來排班合計超過1000筆，被伺服器悄悄截斷，客戶查詢頁面上桃園市
  // 某兩天的門市因此「隨機」少了8家，看起來像資料出錯，其實資料庫裡完全正常。
  // 改成用 .range() 分頁迴圈，依 id 排序、每次抓1000筆抓到抓不滿為止，不管
  // 通路未來成長到多少筆、也不管 Supabase 專案的 Max Rows 設定值多少，都保證
  // 抓到完整資料，不會再被悄悄截斷。
  const PAGE_SIZE = 1000;
  let rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: pageErr } = await supabase
      .from('assignment_drop_points')
      .select('id, address, code, status, completed_at, photo_url, assignments!inner(trip_date, status, routes!inner(shift))')
      .eq('channel_id', channel.id)
      .neq('assignments.status', 'cancelled')
      .gte('assignments.trip_date', sinceStr)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (pageErr) {
      console.error('client-data points query failed:', pageErr.message);
      return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
    }
    rows = rows.concat(page);
    if (page.length < PAGE_SIZE) break;
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
  // fare/distance/billing 等金額欄位，所以無論哪個通路的連結，客戶都看不到夥伴費用，
  // 也看不到共配車趟上其他通路的站點（一律只用 channel_id 篩出這個通路自己的點）。
  const items = (rows || []).map(p => ({
    id: p.id,
    name: p.code || p.address,
    city: extractCity(p.address),
    date: p.assignments.trip_date,
    shift: p.assignments?.routes?.shift || null,
    delivered: p.status === 'completed',
    completedAt: p.completed_at,
    photoUrl: p.photo_url ? (signedUrls[p.photo_url] || null) : null
  }));

  return res.status(200).json({ channelName: channel.name, items });
};
