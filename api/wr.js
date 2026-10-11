// 戰情室外部連結的網頁入口：/wr/<金鑰>（vercel.json 把這個路徑導到這裡）。
// 回傳的就是 index.html 本身，只在傳出去之前改三件事：
//   1. <base href="/">：頁面網址多了 /wr/ 這一層，原本的相對路徑（js/、assets/）才找得到檔案。
//   2. manifest 換成這個金鑰專屬的（起始網址 /wr/<金鑰>）。iOS／Android 是在「頁面一載入」就讀取 manifest 決定加到主畫面
//      的開啟網址，不能等 JS 跑起來再換，所以要在傳出頁面時就放進去。
//   3. 主畫面名稱「碳金戰情室」與 standalone 設定，以及戰情室專用圖示。
// 這支不查資料庫、也不回傳任何資料：金鑰有沒有效、要顯示什麼，都還是由前端呼叫 /api/warroom 決定；
// index.html 本來就是公開的靜態頁面，沒有任何機密。
const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
  const token = String(req.query.token || '').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return res.status(404).send('Not found');
  let html;
  try { html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'); }
  catch (e) { console.error('wr page read failed:', e.message); return res.status(500).send('伺服器錯誤，請稍後再試'); }
  const manifestTags =
    '<link rel="manifest" href="/api/warroom?manifest=1&token=' + token + '">\n' +
    '<meta name="apple-mobile-web-app-capable" content="yes">\n' +
    '<meta name="apple-mobile-web-app-title" content="碳金戰情室">\n' +
    '<meta name="theme-color" content="#0A0F1A">';
  html = html.replace('<head>', '<head>\n<base href="/">');
  // 戰情室專用圖示（深藍黑底＋金色 T＋右下綠點）：<head> 裡的 favicon／apple-touch-icon 全部換成 wr- 開頭的那組。
  // iOS 加入主畫面時抓的是 apple-touch-icon，不是 manifest 的 icons。
  const headEnd = html.indexOf('</head>');
  html = html.slice(0, headEnd).split('href="assets/icons/').join('href="assets/icons/wr-') + html.slice(headEnd);
  html = /<link rel="manifest"[^>]*>/.test(html)
    ? html.replace(/<link rel="manifest"[^>]*>/, manifestTags)
    : html.replace('</head>', manifestTags + '\n</head>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.status(200).send(html);
};
