// Gemini Live API 的「暫時性權杖」核發端點（2026-10-28，雙大腦架構的賈維斯語音助理用）。
// 用途：PWA 前端要直接連線 Gemini Live API（WebSocket）做即時語音互動時，不能把
// GEMINI_API_KEY 這種長效、權限完整的金鑰直接放進前端程式碼（會被任何人看原始碼偷走，
// 偷到就能無限用，直到你發現帳單異常才會知道）。正確做法（Google官方文件寫的）：
// 前端先驗證自己的身份給這支後端看，後端才拿真正的API金鑰去跟Gemini換一個「效期很短、
// 用完即丟」的暫時性權杖，再把這個短效權杖交給前端去連線——金鑰本身永遠不離開伺服器。
//
// POST /api/gemini-token，body 可以不帶（用預設效期）。
// 要帶現有登入的JWT（夥伴或主控都可以）：Authorization: Bearer <token>，不然任何人都能
// 呼叫這支端點騙到一個能用的權杖，等於間接偷到金鑰的使用權。
//
// ⚠️ 2026-10-28寫這支的時候，Google這個「暫時性權杖」功能官方文件標示「目前處於預覽
// 階段」，欄位/行為以後可能會變，正式串接語音功能前建議先去Google官方文件確認規格
// 有沒有更新：https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
//
// 這支端點目前還沒有被任何畫面呼叫（語音功能的前端還沒做），部署了也不影響任何現有
// 功能；真的要用之前，還需要去Vercel專案設定加上 GEMINI_API_KEY 這個環境變數
// （Google AI Studio申請的那把金鑰），不加的話呼叫這支會得到清楚的錯誤訊息，不會是
// 語焉不詳的失敗。

const jwt = require('jsonwebtoken');

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
function authOf(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  try { return jwt.verify(tok, process.env.SUPABASE_JWT_SECRET); } catch { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const auth = authOf(req);
  if (!auth || (auth.role !== 'app_driver' && auth.role !== 'app_admin')) {
    return res.status(401).json({ error: '請先登入' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: '伺服器還沒設定 GEMINI_API_KEY，請到 Vercel 專案環境變數加上這把金鑰' });
  }

  const body = parseBody(req);
  const now = Date.now();
  // 預設：這個權杖本身30分鐘內有效（expireTime），但只給1分鐘去「啟動」一個新的語音
  // session（newSessionExpireTime）——跟官方範例的預設值一致，語音功能通常是「點了就
  // 立刻開始講」，不需要給使用者長時間考慮要不要連線。
  const expireTime = body.expireTime || new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = body.newSessionExpireTime || new Date(now + 60 * 1000).toISOString();

  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime })
    });
    const j = await r.json();
    if (!r.ok) {
      console.error('gemini-token 核發失敗:', JSON.stringify(j));
      return res.status(502).json({ error: 'Gemini 權杖核發失敗：' + (j.error?.message || r.status) });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token: j.name, expireTime: j.expireTime || expireTime });
  } catch (e) {
    console.error('gemini-token 呼叫失敗:', e.message);
    return res.status(502).json({ error: '連線 Gemini 失敗，請稍後再試' });
  }
};
