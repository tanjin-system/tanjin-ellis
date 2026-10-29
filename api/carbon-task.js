// 「小碳」特助端點（2026-10-30，雙大腦計劃「後台」）。
//
// 背景：原本設計小碳只是定期跑規則、印報表，使用者明確要求改掉這個方向——
// 小碳要是老闆隨時可以透過小金（語音）或後台按鈕交辦任務的「特助」，不是
// 「問一句答一句」的機器人。所以這支端點不再是單一用途的「摘要」，而是
// 通用的「老闆交辦一件事，小碳想完回覆」。
//
// 身分：這支端點本身不碰資料庫、不會寫入任何表——它只負責把老闆的交辦內容
// 跟（選填的）背景資料丟給Claude，拿回一段文字。實際要不要存進carbon_tasks
// 表、要不要唸出來，都是呼叫端（voice.js／index.html）的事，維持「AI只能
// 提案、人點頭才算數」：小碳自己沒有能力真的去改班表、改金額、發公告。
//
// POST /api/carbon-task，body：
//   { request?: string,            // 老闆交辦的話（語音轉述或後台輸入），可省略
//     items?: [{kind, text}, ...]  // 背景資料（財務稽核／排班衝突等已經算好的事實），可省略
//   }
// request、items至少要有一個，兩個都有的話小碳會同時參考。
// 一定要帶主控的JWT：Authorization: Bearer <token>——小碳服務對象是主控，不開放夥伴身份呼叫。
//
// 金鑰（ANTHROPIC_API_KEY）要另外去Vercel專案環境變數設定，沒設定會得到清楚的
// 錯誤訊息，不會是語焉不詳的失敗。

const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');

const CLAUDE_MODEL = 'claude-opus-5-5';
const MAX_ITEMS = 200; // 防止背景資料異常龐大，拖垮這支函式／浪費額度
const MAX_REQUEST_LEN = 2000;

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

const SYSTEM_PROMPT = `你是物流車隊系統的後台虛擬特助「小碳」。老闆會透過語音助理小金、或後台的按鈕，把任務或問題轉達給你處理，只講繁體中文（台灣）。

規則：
- 如果下面有提供「目前系統裡的相關資料」，那是系統已經用程式碼算好的事實（財務稽核、排班衝突等），你只能根據這些資料回答，絕對不能編造裡面沒有的人名、金額、日期。如果老闆問的問題超出這些資料能回答的範圍，要老實說資料沒有涵蓋到、需要工程師另外處理，不要硬掰一個答案。
- 如果老闆是單純交辦一件需要你動腦判斷或撰寫的事（例如寫一段提案、整理一段說明、排出處理順序），直接用你的判斷完成。
- 如果老闆明確要求你「寫」「草擬」「發」一則公告給夥伴看，呼叫draft_announcement工具把標題跟內容準備好，同時用一兩句話簡短說明你準備了什麼（這段話小金會唸給老闆聽）。不要自己發布——你沒有能力，也不會真的去寫資料庫，實際發布是老闆在後台看過草稿、按確認之後系統才做的事。老闆沒有明確要求公告的話，不要呼叫這個工具。
- 除了公告之外，你目前還沒有能力真的去改班表、改金額或改路線——如果老闆要求的是這類事情，要在回答裡清楚說這部分你只能先幫忙想法，實際動手需要老闆或工程師到後台操作。
- 語氣像一位細心的特助在跟老闆報告，簡潔，不要用條列符號硬湊，寫成好讀的幾段話。
- 不要在回答裡提到你是「Claude」或任何底層模型名稱，你就是「小碳」。`;

const TOOLS = [{
  name: 'draft_announcement',
  description: '老闆明確要求撰寫/草擬一則要發布給夥伴看的公告時使用，把草稿準備好交給老闆審核，不會自己發布。',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '公告標題' },
      content: { type: 'string', description: '公告完整內容' }
    },
    required: ['title', 'content'],
    additionalProperties: false
  }
}];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const auth = authOf(req);
  if (!auth || auth.role !== 'app_admin') {
    return res.status(401).json({ error: '請先用主控身份登入' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器還沒設定 ANTHROPIC_API_KEY，請到 Vercel 專案環境變數加上這把金鑰' });
  }

  const body = parseBody(req);
  const requestText = typeof body.request === 'string' ? body.request.trim().slice(0, MAX_REQUEST_LEN) : '';
  const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  if (!requestText && !items.length) {
    return res.status(400).json({ error: '沒有收到任何交辦內容或背景資料（request跟items都是空的）' });
  }

  const parts = [];
  if (items.length) {
    const listText = items.map((it, i) => `${i + 1}. [${it.kind || '其他'}] ${it.text || ''}`).join('\n');
    parts.push(`目前系統裡的相關資料：\n${listText}`);
  }
  parts.push(requestText ? `老闆交辦／詢問：${requestText}` : '請根據上面的資料，整理這次掃描的重點，排出優先順序，給我一段話的報告。');

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1536,
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: [{ role: 'user', content: parts.join('\n\n') }]
    });

    if (msg.stop_reason === 'refusal') {
      console.error('carbon-task 被安全機制拒絕:', JSON.stringify(msg.stop_details || {}));
      return res.status(502).json({ error: '小碳無法處理這個請求（安全機制擋下），請換個方式問或找工程師看看' });
    }

    const content = msg.content || [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const toolUse = content.find(b => b.type === 'tool_use' && b.name === 'draft_announcement');

    let actionType = null, actionPayload = null;
    if (toolUse) {
      const input = toolUse.input || {};
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const draftContent = typeof input.content === 'string' ? input.content.trim() : '';
      if (title && draftContent) { actionType = 'announcement'; actionPayload = { title, content: draftContent }; }
    }

    if (!text && !actionType) return res.status(502).json({ error: 'AI沒有回傳任何內容，請稍後再試' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      summary: text || `我幫你草擬了一份公告「${actionPayload.title}」，完整內容在後台「小碳任務」等你確認。`,
      actionType, actionPayload
    });
  } catch (e) {
    console.error('carbon-task 呼叫失敗:', e && e.message, e && e.status);
    return res.status(502).json({ error: '連線 Claude 失敗：' + (e && e.message ? e.message : '請稍後再試') });
  }
};
