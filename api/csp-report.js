// 內容安全政策（CSP）違規回報接收端。目前政策是「只觀察不阻擋」（Content-Security-Policy-Report-Only，見 vercel.json）：
// 瀏覽器發現頁面載入了政策沒列出的來源，就會 POST 到這裡，我們只把摘要寫進 Vercel 執行紀錄，
// 觀察一陣子、確認沒有正常功能被誤報，再改成正式阻擋。不寫資料庫、不回傳任何內容。
let logged = 0;
module.exports = (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw.length > 8000 || logged >= 300) return res.status(204).end(); // 太大或這個執行個體已記太多就丟掉
    const r = (typeof req.body === 'object' && req.body && (req.body['csp-report'] || (Array.isArray(req.body) ? req.body[0] && req.body[0].body : req.body.body))) || {};
    const clip = v => String(v == null ? '' : v).replace(/[\r\n]/g, ' ').slice(0, 160);
    console.warn('csp-violation', JSON.stringify({
      directive: clip(r['violated-directive'] || r.effectiveDirective || r['effective-directive']),
      blocked: clip(r['blocked-uri'] || r.blockedURL),
      page: clip((r['document-uri'] || r.documentURL || '').replace(/[?#].*$/, '')),
      source: clip(r['source-file'] || r.sourceFile)
    }));
    logged++;
  } catch (e) { /* 回報格式不對就忽略 */ }
  return res.status(204).end();
};
