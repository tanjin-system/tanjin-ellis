// 免費地址轉經緯度的小代理。前端不能直接呼叫 Nominatim（瀏覽器發出的請求
// 不會帶正確的 User-Agent，容易被服務擋掉），所以在後端代打一次。
// 這是 OpenStreetMap 的免費服務，沒有金鑰、不用綁信用卡，但使用禮節要求
// 不能高頻並發呼叫——這支API本身不做限流，「別連續狂打」的責任在前端
// （見 js/data-layer.js 的批次回填座標邏輯，呼叫之間有間隔）。
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const address = (req.body && req.body.address || '').trim();
  if (!address) return res.status(400).json({ error: '缺少地址' });

  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&q=' + encodeURIComponent(address);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'xinxing-tanjin-dispatch/1.0 (contact: fishsky99@gmail.com)' }
    });
    if (!r.ok) return res.status(502).json({ error: '地理編碼服務暫時無法使用' });
    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: '查不到這個地址的座標' });
    return res.status(200).json({ lat: Number(rows[0].lat), lng: Number(rows[0].lon) });
  } catch (err) {
    console.error('geocode failed:', err.message);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
};
