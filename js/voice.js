// ---------- 賈維斯語音助理（Gemini Live API，2026-10-29）----------
// 流程：按🎙️ →要麥克風權限→跟後端換一個短效權杖（/api/gemini-token，GEMINI_API_KEY
// 本身不會經過這支手機）→直接連線Gemini Live API（WebSocket）→即時把麥克風聲音串流
// 過去→模型聽懂之後呼叫我們定義的「report_unavailable」工具（不是直接寫資料庫！）→
// 前端收到工具呼叫，一律先跳showVoiceIntentConfirmCard()給夥伴看過、自己點確認才會
// 真的寫入driver_unavailabilities——跟2026-10-28定案的鐵律一致：語音辨識結果絕對
// 不能跳過人工確認直接生效。
//
// ⚠️ 這支連線協定（setup/realtimeInput/serverContent/toolCall...的訊息格式、
// WebSocket網址、模型名稱）是依照寫這支程式碼當下所知最新的Gemini Live API文件，
// Google這個功能官方標示「預覽階段」，規格隨時可能已經變了。這裡沒有真的麥克風、
// 也沒有可以燒的Gemini額度，沒辦法在開發環境裡實際連線測試——真的能不能動、
// 聽得懂多準，需要用真手機實際測。如果打不開/連不上，請打開瀏覽器主控台
// （iPhone：設定→Safari→進階→網頁檢視器，接電腦用Safari開發選單看；或直接把
// 畫面上跳出的錯誤訊息截圖/打字告訴我），把真正的錯誤內容給我，照實際錯誤調整，
// 不要憑空猜。

// 2026-10-29第一版用的是key=長效金鑰的連線方式＋舊的模型名稱（gemini-2.0-flash-live-001），
// 實機測試直接連線失敗（code 1007）。查Google官方文件後修正：暫時性權杖要用
// BidiGenerateContentConstrained這個方法（不是BidiGenerateContent）、網址參數是
// access_token（不是key），模型名稱也早就換成gemini-3.8-live。這兩個如果Google
// 之後又改了，連線失敗時主控台看到的錯誤碼/訊息是最準的依據。
const VOICE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const VOICE_MODEL = 'models/gemini-3.8-live';

const VOICE_FN_REPORT_UNAVAILABLE = {
  name: 'report_unavailable',
  description: '當夥伴口頭表示某天要請假或不能排班時呼叫這個工具。能明確判斷出西元日期（根據系統指示給的今天日期換算「明天」「下週二」等說法）才填date；不確定、模糊（例如「最近」「之後再說」）就把date留空字串，交給人去用畫面手動選——絕對不要自己亂猜一個日期。rawText一定要填，放聽到的原話或簡短摘要。',
  parameters: {
    type: 'OBJECT',
    properties: {
      date: { type: 'STRING', description: 'YYYY-MM-DD格式；不確定時留空字串，不要猜' },
      rawText: { type: 'STRING', description: '聽到的原話或簡短摘要' }
    },
    required: ['rawText']
  }
};

function voiceSystemInstruction() {
  const wd = '日一二三四五六'[new Date().getDay()];
  return `你是物流車隊系統「賈維斯」語音助理，只講中文（台灣）。今天是${todayStr()}（星期${wd}）。
你唯一能做的事：聽夥伴說要請假或某天不能排班，換算出確切日期後呼叫report_unavailable這個
工具；不確定日期就把date留空，不要自己亂猜。除此之外不要做任何其他事、不要回答跟請假排班
無關的問題、不要承諾或編造任何系統裡沒有的資訊。聽完後用一句簡短的話口頭回應你聽到的內容
（例如「好，幫你記明天請假」），然後呼叫工具就結束，不用等待使用者口頭再確認一次——確認
這件事系統會另外跳畫面給使用者看，不是你的責任。`;
}

function voiceSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && (window.AudioContext || window.webkitAudioContext) && 'WebSocket' in window);
}

let _voiceState = null; // { closed, stream, audioCtx, sourceNode, procNode, muteNode, ws, timeoutTimer }

function voiceRenderOverlay(status, showStop) {
  let ov = document.getElementById('voiceOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'voiceOverlay'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="modal-backdrop"><div class="modal-box" style="max-width:320px; text-align:center;">
    <p style="font-size:30px; margin:4px 0;">🎙️</p>
    <p style="font-size:14px;">${escapeHtml(status)}</p>
    ${showStop ? '<button class="btn ghost" id="voiceStopBtn" style="width:100%; margin-top:10px;">結束</button>' : ''}
  </div></div>`;
  const btn = document.getElementById('voiceStopBtn');
  if (btn) btn.onclick = () => voiceStop();
}

function voiceDownsampleTo16k(float32Array, inputSampleRate) {
  if (inputSampleRate === 16000) return float32Array;
  const ratio = inputSampleRate / 16000;
  const newLen = Math.round(float32Array.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = float32Array[Math.floor(i * ratio)];
  return out;
}
function voiceFloat32ToPCM16Base64(float32Array) {
  const buf = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buf);
  for (let i = 0, off = 0; i < float32Array.length; i++, off += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function voiceParseRate(mimeType, fallback) {
  const m = /rate=(\d+)/.exec(mimeType || '');
  return m ? Number(m[1]) : fallback;
}
function voicePlayAudioChunk(audioCtx, base64, mimeType) {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const n = bytes.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 0x8000;
    const rate = voiceParseRate(mimeType, 24000); // 文件沒寫死輸出取樣率，優先用訊息自己附的mimeType，沒有才退回24kHz猜測值
    const buffer = audioCtx.createBuffer(1, n, rate);
    buffer.copyToChannel(f32, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start();
  } catch (e) { console.error('播放語音回應失敗', e); }
}

function voiceStartStreamingMic(stream, audioCtx, ws) {
  const source = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1); // 用舊版API換取簡單直接可用（不用額外寄生worklet檔案）
  const mute = audioCtx.createGain(); mute.gain.value = 0; // 一定要接到destination才會持續觸發，但不能真的播出來（會變回音）
  _voiceState.sourceNode = source; _voiceState.procNode = proc; _voiceState.muteNode = mute;
  proc.onaudioprocess = e => {
    if (!_voiceState || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const down = voiceDownsampleTo16k(input, audioCtx.sampleRate);
    ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: voiceFloat32ToPCM16Base64(down) } } }));
  };
  source.connect(proc); proc.connect(mute); mute.connect(audioCtx.destination);
}

function voiceStop() {
  if (!_voiceState) return;
  _voiceState.closed = true;
  clearTimeout(_voiceState.timeoutTimer);
  try { _voiceState.procNode && _voiceState.procNode.disconnect(); } catch (e) {}
  try { _voiceState.sourceNode && _voiceState.sourceNode.disconnect(); } catch (e) {}
  try { _voiceState.muteNode && _voiceState.muteNode.disconnect(); } catch (e) {}
  try { _voiceState.stream && _voiceState.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { _voiceState.ws && _voiceState.ws.readyState === WebSocket.OPEN && _voiceState.ws.close(); } catch (e) {}
  try { _voiceState.audioCtx && _voiceState.audioCtx.close(); } catch (e) {}
  const ov = document.getElementById('voiceOverlay'); if (ov) ov.remove();
  voiceFabSetActive(false);
  _voiceState = null;
}
function voiceFail(message) {
  if (!_voiceState) return; // 已經收尾過了，不要重複跳錯誤訊息
  voiceStop();
  alert(message);
}

// ---------- 懸浮小助手（2026-10-29，使用者要求：不要把語音功能藏在面板裡，
// 做一個隨時看得到的懸浮圖示，點了就能講話）----------
function voiceFabAvatarSvg() {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <defs><linearGradient id="voiceFabBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FFC2E2"/><stop offset="100%" stop-color="#C9A8FF"/>
    </linearGradient></defs>
    <circle cx="50" cy="50" r="50" fill="url(#voiceFabBg)"/>
    <ellipse cx="18" cy="62" rx="10" ry="19" fill="#6B4A8A"/>
    <ellipse cx="82" cy="62" rx="10" ry="19" fill="#6B4A8A"/>
    <circle cx="50" cy="53" r="26" fill="#FFE4CF"/>
    <path d="M24 47 Q26 19 50 19 Q74 19 76 47 Q70 33 50 33 Q30 33 24 47 Z" fill="#7A5AA0"/>
    <path d="M38 35 Q40 45 36 51" stroke="#7A5AA0" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M62 35 Q60 45 64 51" stroke="#7A5AA0" stroke-width="3" fill="none" stroke-linecap="round"/>
    <ellipse cx="41" cy="55" rx="5.3" ry="6.8" fill="#2E2A3A"/>
    <ellipse cx="59" cy="55" rx="5.3" ry="6.8" fill="#2E2A3A"/>
    <circle cx="43" cy="52" r="1.6" fill="#fff"/>
    <circle cx="61" cy="52" r="1.6" fill="#fff"/>
    <ellipse cx="34" cy="63" rx="4.5" ry="3" fill="#FFAFC4" opacity="0.85"/>
    <ellipse cx="66" cy="63" rx="4.5" ry="3" fill="#FFAFC4" opacity="0.85"/>
    <path d="M46 66 Q50 70 54 66" stroke="#C06080" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M26 47 Q50 29 74 47" stroke="#3A3A3A" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <circle cx="76" cy="51" r="4.2" fill="#3A3A3A"/>
    <circle cx="24" cy="51" r="4.2" fill="#3A3A3A"/>
  </svg>`;
}
// renderContent()每次切分頁都會呼叫；show=是否該顯示（夥伴畫面／主控檢視夥伴畫面才顯示，
// 主控自己的畫面不顯示）。按鈕本身只建立一次、之後只切display，不會被各分頁的innerHTML洗掉。
function voiceFabEnsure(show) {
  let fab = document.getElementById('voiceFab');
  if (!show) { if (fab) fab.style.display = 'none'; return; }
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'voiceFab';
    fab.className = 'voice-fab';
    fab.type = 'button';
    fab.title = '語音助理（賈維斯）';
    fab.innerHTML = voiceFabAvatarSvg();
    fab.onclick = () => { _voiceState ? voiceStop() : voiceStart(); };
    document.body.appendChild(fab);
  }
  fab.style.display = 'flex';
}
function voiceFabSetActive(active) {
  const fab = document.getElementById('voiceFab');
  if (fab) fab.classList.toggle('active', !!active);
}

async function voiceStart() {
  if (_voiceState) return; // 已經在進行中
  if (!voiceSupported()) { alert('這支手機／瀏覽器不支援語音功能（需要麥克風與WebSocket）。'); return; }
  if (!navigator.onLine) { alert('請先連上網路才能使用語音功能。'); return; }
  _voiceState = { closed: false };
  voiceFabSetActive(true);
  voiceRenderOverlay('準備中…', false);
  try {
    const auth = getStoredAuth();
    if (!auth) throw new Error('請先登入');
    const tr = await fetch('/api/gemini-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token }, body: JSON.stringify({}) });
    const tj = await tr.json();
    if (!tr.ok) throw new Error(tj.error || '取得語音權杖失敗');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (!_voiceState) { stream.getTracks().forEach(t => t.stop()); return; } // 要權限的這幾秒使用者可能已經按了結束
    _voiceState.stream = stream;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    _voiceState.audioCtx = audioCtx;

    const ws = new WebSocket(VOICE_WS_URL + '?access_token=' + encodeURIComponent(tj.token));
    _voiceState.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: VOICE_MODEL,
          generationConfig: { responseModalities: ['AUDIO'] },
          systemInstruction: { parts: [{ text: voiceSystemInstruction() }] },
          tools: [{ functionDeclarations: [VOICE_FN_REPORT_UNAVAILABLE] }]
        }
      }));
    };
    ws.onerror = () => { console.error('語音WebSocket錯誤', ws.url); voiceFail('語音連線發生錯誤，請稍後再試。如果一直這樣，請把瀏覽器主控台的錯誤訊息告訴工程師。'); };
    ws.onclose = ev => { console.error('語音WebSocket關閉', ev.code, ev.reason); if (_voiceState && !_voiceState.closed) voiceFail(`語音連線中斷（code ${ev.code}${ev.reason ? '：' + ev.reason : ''}）。`); };
    ws.onmessage = async ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch (e) { return; }

      if (msg.setupComplete) {
        voiceRenderOverlay('請說話…（例如「我明天請假」）', true);
        voiceStartStreamingMic(stream, audioCtx, ws);
        return;
      }
      if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
        msg.toolCall.functionCalls.forEach(fc => {
          try { ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'ok' } }] } })); } catch (e) {}
          if (fc.name === 'report_unavailable') {
            const args = fc.args || {};
            voiceStop();
            showVoiceIntentConfirmCard({ type: 'leave', date: args.date || '', rawText: args.rawText || '' });
          }
        });
        return;
      }
      if (msg.serverContent) {
        const parts = (msg.serverContent.modelTurn && msg.serverContent.modelTurn.parts) || [];
        parts.forEach(p => { if (p.inlineData && p.inlineData.data) voicePlayAudioChunk(audioCtx, p.inlineData.data, p.inlineData.mimeType); });
        if (msg.serverContent.turnComplete) voiceRenderOverlay('請說話…', true);
      }
    };

    // 30秒內沒有結果就自動結束，避免忘記關掉、白白耗用額度
    _voiceState.timeoutTimer = setTimeout(() => voiceFail('語音辨識逾時，請重新再試一次。'), 30000);
  } catch (e) {
    voiceFail(e.name === 'NotAllowedError' ? '沒有麥克風權限，請到手機設定開啟這個App的麥克風權限後再試一次。' : (e.message || '語音功能啟動失敗'));
  }
}
