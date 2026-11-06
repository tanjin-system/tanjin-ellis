// 夥伴（司機）端畫面程式碼——2026-10-30從index.html搬出來，目的是降低index.html
// 本身的重量（它是no-cache、每次都要整包重新下載的進入點，一直往裡面塞程式碼只會
// 讓每次開系統都變慢）。這個檔案走一般<script defer>、有版本號快取（同js/data-layer.js
// /js/voice.js的模式），這樣之後只改動主控端的東西，不會連帶讓這些完全沒變的夥伴端
// 程式碼也要重新下載一次。
//
// 這裡的函式仍然是「主控檢視夥伴畫面」(state.adminViewDriver)會呼叫到的同一套程式碼
// （不是另外寫一份），所以這支檔案是無條件載入給所有身份使用，不是只有夥伴登入才
// 載入——純粹只是「放在哪個檔案」的調整，不影響任何功能或畫面。
//
// 純搬移，沒有改動任何邏輯；依賴index.html裡定義的共用函式/全域狀態（state、
// escapeHtml、todayStr等等），跟js/data-layer.js依賴index.html是同一種既有的
// 跨檔案呼叫模式，因為index.html的主要inline script在這支檔案載入「完成」之後
// 才會真正執行到會呼叫這裡函式的程式碼（renderContent的dispatch表、showApp()等）。

function todayHolidayGreeting(driverId){
  const today = todayStr();
  const h = holidayForDate(today);
  if(!h || !h.greeting) return null;
  const isWorkingToday = state.data.assignments.some(a=>a.driverId===driverId && a.date===today && a.status!=='cancelled');
  return isWorkingToday ? null : h.greeting;
}

function renderHomeDriver(c){
  const dId = state.activeDriverId;
  const todays = myOpenTasks(dId);
  // 主控在「主控檢視中」模式下也是叫這支函式，這時 state.data.announcements
  // 是用admin身份撈的（含已下架、含所有對象的公告），這裡一律再篩一次
  // active跟發送對象，確保跟真的夥伴登入看到的內容完全一樣：全體公告
  // 都看得到，指定對象的公告只有被指定到的夥伴（dId在driverIds裡）才看得到。
  const activeAnnouncements = (state.data.announcements||[]).filter(a=>
    a.active && (a.audience!=='selected' || a.driverIds.includes(dId)));
  c.innerHTML = `
    <h2 class="section-title">首頁</h2>
    <p class="section-sub">${driverName(dId)}，您好。${todays.length ? `今天有 ${todays.length} 趟任務，請從選單的「今日任務」開始。` : '今天沒有待完成的任務。'}</p>
    ${todayHolidayGreeting(dId) ? `<div class="panel" style="border-color:var(--amber); border-width:2px;">
      <p style="margin:0; font-size:13px;">${todayHolidayGreeting(dId)} 辛苦了，感謝您的配送服務。</p>
    </div>` : ''}
    ${activeAnnouncements.length ? `<div class="panel" style="border-color:var(--amber); border-width:2px;">
      <h3 style="margin-top:0;">📢 公告</h3>
      ${activeAnnouncements.map(a=>`<div style="padding:8px 0; border-bottom:1px solid var(--border);">
        <strong>${escapeHtml(a.title)}</strong>
        <p style="font-size:13px; white-space:pre-wrap; margin:4px 0 0;">${escapeHtml(a.content)}</p>
        <span style="font-size:11px; color:var(--ink-soft);">${new Date(a.createdAt).toLocaleString('zh-Hant-TW')}</span>
      </div>`).join('')}
    </div>` : ''}
    ${currentProgressShifts() ? `<div class="panel" style="border-color:var(--danger); border-width:2px;">
      <div class="toolbar"><h3 style="margin:0;">🚚 同任務起點今日任務狀況</h3>
        <span style="font-size:11px; color:var(--ink-soft);">即時更新中・${lastHomeRefreshAt?`上次更新 ${lastHomeRefreshAt.toLocaleTimeString('zh-Hant-TW')}`:'尚未更新'}
          <button class="btn ghost" id="manualRefreshBtn" style="margin-left:6px; padding:2px 8px; font-size:11px;">↻ 立即更新</button>
        </span>
      </div>
      <div id="depotOverviewBox"><div class="empty">載入中…</div></div>
    </div>` : ''}
    <div id="leaveHost"></div>
  `;
  renderLeavePanel();
  const manualRefreshBtn = document.getElementById('manualRefreshBtn');
  if(manualRefreshBtn) manualRefreshBtn.onclick = async ()=>{
    manualRefreshBtn.disabled = true; manualRefreshBtn.textContent = '更新中…';
    await refreshHomeDataIfIdle();
  };
  const progressShifts = currentProgressShifts();
  if(progressShifts){
    loadDepotOverview(dId, todayStr()).then(rows=>{
      if(state.tab!=='home') return; // 使用者可能早就切到別的分頁了，避免這裡的畫面蓋掉別的內容
      const box = document.getElementById('depotOverviewBox');
      if(!box) return;
      const groups = rows.filter(g=>progressShifts.includes(g.shift));
      box.innerHTML = groups.length ? groups.map(g=>`
        <div style="font-size:13px; padding:6px 0; border-bottom:1px solid var(--border);">
          <strong>${escapeHtml(g.routeName)} ${escapeHtml(g.driverName)}</strong>
          ${g.status==='in_progress' ? ' <span class="badge progress">已出發</span>' : ' <span class="badge pending">尚未出發</span>'}
        </div>`).join('') : '<div class="empty">同任務起點的任務今天都已完成 🎉</div>';
    });
  }
}
// 請假日期太近的風險提示（2026-10-29，使用者指出：公司現行規則是星期五/六/日
// 回報「下週」狀況，沒回報就視為可以照公司安排排班——所以正常請假日期應該是下週，
// 不是今天/明天。這張表只是「以後排班不要排我」的註記，不會自動取消已經排定、
// 已經發佈給夥伴的任務，系統沒有能力臨時改派。日期太近、或當天已經有排定任務時，
// 要清楚提醒夥伴必須直接聯絡主控，不能只靠這筆登記。
function leaveUrgencyWarning(dateVal, dId){
  if(!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) return '';
  const today = todayStr();
  if(dateVal < today) return '';
  // 2026-10-30：原本只講「你已經有排定的任務」太籠統，讓司機/主控看不出是哪一趟、
  // 要不要緊急處理——直接把路線名稱、店點數一起顯示，跟排班衝突面板（小碳任務畫面）
  // 看到的是同一筆資料，司機自己心裡有數「喔是這一趟」，不用再回頭確認。
  const conflictAssignment = (state.data.assignments||[]).find(a=>
    a.driverId===dId && a.date===dateVal && a.status!=='cancelled' && a.published!==false && !a.isSupport);
  if(conflictAssignment) return `⚠️ ${dateVal} 你已經有排定的任務（${routeName(conflictAssignment.routeId)}，${(conflictAssignment.dropPoints||[]).length}個店點），這筆登記不會自動取消、也不會通知主控，請務必直接聯絡主控確認！`;
  const daysUntil = Math.round((new Date(dateVal+'T00:00:00') - new Date(today+'T00:00:00')) / 86400000);
  if(daysUntil<=1) return '⚠️ 這個日期太近了（今天或明天）。公司規則是星期五、六、日回報下週狀況，太晚回報系統可能來不及調整，請務必同時直接聯絡主控確認。';
  return '';
}
// ---------- 夥伴請假/不可排班回報（2026-10-29，雙大腦架構小金語音助理的第一塊
// 真正可用的功能：手動表單版。語音版以後會接同一個 createDriverUnavailability()，
// 只是來源改成source:'voice'，且要先過PWA確認卡片——這裡先把「人手動填表單送出」
// 當作確認這件事本身，不需要再疊一層確認，跟語音那種「AI自己猜」風險不一樣。）----------
async function renderLeavePanel(){
  const host = document.getElementById('leaveHost');
  if(!host) return;
  const dId = state.activeDriverId;
  const today = todayStr();
  host.innerHTML = `<div class="panel">
    <div class="toolbar"><h3 style="margin:0;">📝 請假／回報不可排班</h3>
      <button class="btn ghost" id="leaveAddBtn" style="padding:4px 12px; font-size:12.5px;">新增</button>
    </div>
    <div id="leaveFormBox" style="display:none; margin-top:8px;">
      <div class="grid3">
        <div class="field"><label>日期</label><input id="leaveDate" type="date" min="${today}"></div>
        <div class="field" style="grid-column: span 2;"><label>備註（選填）</label><input id="leaveNote" maxlength="100" placeholder="例如：家裡有事"></div>
      </div>
      <div id="leaveWarnBox" style="display:none; font-size:12.5px; color:var(--danger); margin:-4px 0 8px;"></div>
      <button class="btn amber" id="leaveSubmitBtn">送出</button>
      <button class="btn ghost" id="leaveCancelBtn">取消</button>
    </div>
    <div id="leaveListBox" style="margin-top:10px;"><div class="empty">載入中…</div></div>
  </div>`;
  document.getElementById('leaveAddBtn').onclick = ()=>{
    document.getElementById('leaveFormBox').style.display = 'block';
    document.getElementById('leaveAddBtn').style.display = 'none';
  };
  document.getElementById('leaveCancelBtn').onclick = ()=>{
    document.getElementById('leaveFormBox').style.display = 'none';
    document.getElementById('leaveAddBtn').style.display = '';
  };
  document.getElementById('leaveDate').onchange = ()=>{
    const warn = leaveUrgencyWarning(document.getElementById('leaveDate').value, dId);
    const box = document.getElementById('leaveWarnBox');
    box.style.display = warn ? 'block' : 'none';
    box.textContent = warn;
  };
  document.getElementById('leaveSubmitBtn').onclick = async ()=>{
    const date = document.getElementById('leaveDate').value;
    const note = document.getElementById('leaveNote').value;
    if(!date){ alert('請選擇日期'); return; }
    const warn = leaveUrgencyWarning(date, dId);
    if(warn && !confirm(warn + '\n\n仍要送出這筆登記嗎？')) return;
    try{
      await createDriverUnavailability(dId, date, note, 'manual');
      renderLeavePanel();
    }catch(err){ alert(err.message); }
  };
  const end = new Date(Date.now() + 60*24*3600*1000).toISOString().slice(0,10);
  try{
    const list = await fetchDriverUnavailabilities(today, end);
    if(state.tab!=='home' || !document.getElementById('leaveListBox')) return; // 使用者可能已經切走這一頁
    const mine = list.filter(x=>x.driverId===dId).sort((a,b)=>a.date.localeCompare(b.date));
    document.getElementById('leaveListBox').innerHTML = mine.length
      ? mine.map(x=>`<div style="display:flex; justify-content:space-between; align-items:center; font-size:13px; padding:4px 0; border-top:1px solid var(--border);">
          <span>${x.date}${x.note?'　'+escapeHtml(x.note):''}${x.source==='voice'?'　<span class="badge pending" style="font-size:10.5px;">語音回報</span>':''}</span>
          <button class="btn ghost" data-leavedel="${x.id}" style="padding:2px 8px; font-size:11.5px;">刪除</button>
        </div>`).join('')
      : '<div class="empty">目前沒有登記請假</div>';
    document.querySelectorAll('[data-leavedel]').forEach(b=>{
      b.onclick = async ()=>{
        if(!confirm('確定要取消這筆請假登記嗎？')) return;
        try{ await deleteDriverUnavailability(b.dataset.leavedel); renderLeavePanel(); }
        catch(err){ alert(err.message); }
      };
    });
  }catch(err){
    const box = document.getElementById('leaveListBox');
    if(box) box.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- 夥伴端：今日任務（預設畫面） ----------
// 上午永遠排在下午前面——不管實際建立任務的順序（週期任務清單怎麼異動、
// 哪個先建立），同一天同時有上午跟下午的車次時，畫面上一律上午在上。
function assignmentShiftKey(a){
  const route = state.data.routes.find(r=>r.id===a.routeId);
  return route?.shift==='PM' ? 1 : 0;
}
// 夥伴「還要處理」的任務：今天沒完成的，加上最近 7 天內「已經開始但忘了按完成」的舊任務
// （過了那天不然就沒有地方可以按完成了）。舊的排在前面。
function myOpenTasks(dId){
  const today = todayStr(), weekAgo = ymd(addDays(today, -7));
  return state.data.assignments.filter(a=>a.driverId===dId && !a.isSupport && a.published!==false && (
      (a.date===today && a.status!=='completed') || (a.date<today && a.date>=weekAgo && a.status==='in_progress')))
    .sort((a,b)=> a.date.localeCompare(b.date) || assignmentShiftKey(a)-assignmentShiftKey(b));
}
function renderToday(c){
  thumbsPrune(); // 昨天以前的縮圖順手清掉
  const dId = state.activeDriverId;
  const today = todayStr();
  const todays = myOpenTasks(dId);
  const weekDates = [...getWeekDates(0), ...getWeekDates(1)];
  c.innerHTML = `
    <h2 class="section-title">今日任務</h2>
    <p class="section-sub">Hi~${driverName(dId)}，這是您今日任務。${todayHolidayGreeting(dId)?` ${todayHolidayGreeting(dId)}`:''}</p>
    <div id="todayDetail"></div>
    <h3 style="margin-top:20px;">本週任務總覽</h3>
    <p class="section-sub" style="margin-top:-6px;">點擊「待完成」的任務可預覽當天行程與報酬。</p>
    <div class="schedule-list">${(()=>{
      const dayName = d=> `${d.slice(5).replace('-','/')}（${WEEKDAY_ZH[(new Date(d+'T00:00:00').getDay()+6)%7]}）`;
      const tasksOf = d=> state.data.assignments.filter(a=>a.driverId===dId && a.published!==false && a.date===d).sort((a,b)=> assignmentShiftKey(a)-assignmentShiftKey(b));
      const st = a=> a.status==='completed' ? '<span class="sl-st done">✓ 已完成</span>' : a.status==='in_progress' ? '<span class="sl-st run">● 執行中</span>' : '<span class="sl-st wait">○ 待完成</span>';
      const row = a=> `<div class="sl-row" ${a.status==='scheduled'?`data-previewtrip="${a.id}" style="cursor:pointer;"`:''}><strong>${routeName(a.routeId)}</strong>${st(a)}</div>`;
      const thisWeek = getWeekDates(0), nextWeek = getWeekDates(1);
      let html = '';
      // 本週已過去的日子：收成一行，點開才看（詳細紀錄在「歷史任務」）。
      const pastTasks = thisWeek.filter(d=>d<today).flatMap(d=>tasksOf(d).map(a=>({d,a})));
      // 同一天的任務放在同一個日期底下（日期只出現一次）。
      const pastDays = [...new Set(pastTasks.map(x=>x.d))];
      if(pastTasks.length) html += `<details class="sl-past"><summary>本週已過去的任務 ${pastTasks.length} 項 ▸</summary>${pastDays.map(d=>`<div class="sl-day"><div class="sl-day-label">${dayName(d)}</div><div class="sl-rows">${pastTasks.filter(x=>x.d===d).map(x=>row(x.a)).join('')}</div></div>`).join('')}</details>`;
      const renderRange = dates=>{
        let out = '', emptyRun = [];
        const flush = ()=>{ if(!emptyRun.length) return; out += `<div class="sl-empty">${emptyRun.length===1?dayName(emptyRun[0]):`${emptyRun[0].slice(5).replace('-','/')}～${emptyRun[emptyRun.length-1].slice(5).replace('-','/')}`}　無任務</div>`; emptyRun = []; };
        dates.forEach(d=>{
          const items = tasksOf(d);
          if(!items.length){ emptyRun.push(d); return; }
          flush();
          out += `<div class="sl-day ${d===today?'today':''}"><div class="sl-day-label">${dayName(d)}${d===today?'・今天':''}</div><div class="sl-rows">${items.map(row).join('')}</div></div>`;
        });
        flush();
        return out;
      };
      const thisUpcoming = thisWeek.filter(d=>d>=today);
      if(thisUpcoming.length) html += renderRange(thisUpcoming);
      // 今天不在本週清單（理論上不會）時也要有今天標示，這裡不另外處理。
      const nextHasTasks = nextWeek.some(d=>tasksOf(d).length);
      // 下週：有已發佈的任務才顯示，沒有就整段不出現。
      if(nextHasTasks) html += `<div class="sl-sub">下週</div>` + renderRange(nextWeek);
      return html;
    })()}</div>
    <div class="schedule-grid">
      ${weekDates.map(d=>{
        const items = state.data.assignments.filter(a=>a.driverId===dId && a.published!==false && a.date===d)
          .sort((a,b)=> assignmentShiftKey(a)-assignmentShiftKey(b));
        return `<div class="day-card"><div class="day-label">${d.slice(5)}（星期${WEEKDAY_ZH[(new Date(d+'T00:00:00').getDay()+6)%7]}）${d===today?'・今天':''}</div>
          ${items.map(a=>`<div class="trip-chip ${a.status==='completed'?'locked':''}" ${a.status==='scheduled'?`data-previewtrip="${a.id}" style="cursor:pointer;"`:''}><strong>${routeName(a.routeId)}</strong><br>${a.status==='completed'?'<span class="badge locked">已完成</span>':a.status==='in_progress'?'<span class="badge progress">執行中</span>':'<span class="badge pending">待完成</span>'}</div>`).join('') || '<div style="color:var(--ink-soft);font-size:11px;">無任務</div>'}
        </div>`;
      }).join('')}
    </div>
    <div id="weekTripModal"></div>
  `;
  c.querySelectorAll('[data-previewtrip]').forEach(chip=>{
    chip.onclick = ()=> openWeekTripPreview(chip.dataset.previewtrip);
  });
  renderTodayDetail(todays);
}
// 本週任務總覽裡「待完成」的車次點擊後預覽當天行程與夥伴費用——單純預覽，
// 任務還沒開始，不提供拍照/完成等操作（那些要等到當天在「今日任務」才會出現）。
function openWeekTripPreview(assignmentId){
  const host = document.getElementById('weekTripModal');
  const a = state.data.assignments.find(x=>x.id===assignmentId);
  if(!a) return;
  host.innerHTML = `
    <div class="modal-backdrop" id="weekTripBackdrop">
      <div class="modal-box" style="max-width:480px;">
        <div class="toolbar"><h3 style="margin:0;">${routeName(a.routeId)}</h3><button class="btn ghost" id="closeWeekTrip">關閉</button></div>
        <p style="font-size:12.5px; color:var(--ink-soft); margin:0 0 8px;">${a.date}（星期${['日','一','二','三','四','五','六'][new Date(a.date+'T00:00:00').getDay()]}）</p>
        <p style="font-size:12.5px;">任務起點：${a.origin||'—'} ${(()=>{ const link = buildMultiStopMapsLink(a.origin, ownDropPoints(a)); return link ? `<a class="link" href="${link}" target="_blank">開啟多點導航</a>` : ''; })()}</p>
        <h3 style="margin:0 0 8px;">報酬：$${money(tripPay(a))}</h3>
        <label style="font-size:12px; color:var(--ink-soft); display:block; margin:10px 0 4px;">店點（${ownDropPoints(a).length}）</label>
        ${ownDropPoints(a).length ? ownDropPoints(a).map(dp=>`<div class="drop-point-driver"><span class="store-name">${dpLabel(dp)}</span>（${channelName(dp.channelId)}）</div>`).join('') : '<div class="empty">尚未安排店點</div>'}
      </div>
    </div>
  `;
  document.getElementById('closeWeekTrip').onclick = ()=>{ host.innerHTML=''; };
  document.getElementById('weekTripBackdrop').onclick = (e)=>{ if(e.target.id==='weekTripBackdrop') host.innerHTML=''; };
}
// 夥伴自己的店點：交給支援夥伴的店點不再出現在原夥伴的畫面（任務明細、導航、LINE 提醒、完成判斷都不含）。
function ownDropPoints(a){ return (a.dropPoints||[]).filter(dp=>!dp.helperId); }
// 夥伴當天第一次進系統：全螢幕問候動畫（早安／午安／晚安＋今天幾趟任務），畫面會一直停著，夥伴點任何地方才進入首頁。
// 每位夥伴每天只出現一次（記在手機瀏覽器），隔天再登入會再出現；主控「檢視夥伴」不會觸發。
function maybeGreetDriver(){
  if(state.role!=='driver' || state.adminViewDriver || !state.activeDriverId) return;
  if(document.getElementById('greetOverlay')) return;
  const key = `greeted|${state.activeDriverId}|${todayStr()}`;
  try{
    if(localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    Object.keys(localStorage).filter(k=>k.startsWith('greeted|') && k!==key).forEach(k=>localStorage.removeItem(k));
  }catch(e){
    if(state._greetedDay===todayStr()) return; // 瀏覽器不讓存資料時，退而求其次：這次開啟只出現一次
    state._greetedDay = todayStr();
  }
  showGreeting();
}
function showGreeting(){
  const dId = state.activeDriverId, today = todayStr();
  const h = new Date().getHours();
  const period = h<11 ? 'morning' : h<18 ? 'day' : 'night';
  const hello = { morning:'早安', day:'午安', night:'晚安' }[period];
  const icon = { morning:'🌅', day:'☀️', night:'🌙' }[period];
  const mine = state.data.assignments.filter(a=>a.driverId===dId && !a.isSupport && a.published!==false && a.date===today && a.status!=='cancelled')
    .sort((a,b)=> assignmentShiftKey(a)-assignmentShiftKey(b));
  const open = mine.filter(a=>a.status!=='completed');
  const holiday = todayHolidayGreeting(dId);
  const sub = mine.length
    ? (open.length ? `今天有 ${mine.length} 趟任務，第一趟是「${routeName(open[0].routeId)}」。` : `今天的 ${mine.length} 趟任務都完成了，辛苦了！`)
    : (holiday || '今天沒有排定任務，好好休息。');
  const el = document.createElement('div');
  el.id = 'greetOverlay'; el.className = 'greet ' + period;
  el.innerHTML = `<div class="gicon">${icon}</div><h1>${hello}，${escapeHtml(driverName(dId))}</h1><div class="gsub">${escapeHtml(sub)}</div>
    <div class="gtap">點一下畫面任何地方，進入首頁</div>`;
  document.body.appendChild(el);
  let closed = false;
  // 問候畫面不會自動消失；點任何地方才淡出並跳到首頁。
  const close = ()=>{ if(closed) return; closed = true; el.classList.add('out'); setTimeout(()=>el.remove(), 550); if(state.tab!=='home') switchTab('home'); else renderContent(); };
  el.onclick = close;
}
// 登入當下提醒：本月所得（整月原始金額試算，不是看已經實際開單扣了多少——
// 這裡是前瞻性提醒「之後開單可能會被扣稅，記得先申報代墊費用」，跟報酬結算/
// 我的報酬正式顯示「已經被扣了多少稅」的邏輯是不同用途，沿用整月合併試算
// 沒關係，2026-10-27）達起扣門檻時跳出，提醒夥伴常常忘記申報加油／保養發票
// ——代墊費用不算所得，愈早申報愈有機會降低這個月要課稅的金額。夥伴可以
// 勾選「這個月不再提醒」，勾了之後這個月份都不會再跳出（跟下面沒勾選時
// 的「每天只出現一次」是兩層不同的節流：沒勾就每天出現一次，勾了就整個
// 月都不出現，直到下個月門檻又重新判斷）。主控「檢視夥伴」不會觸發。
async function maybeShowNhiReminder(){
  if(state.role!=='driver' || state.adminViewDriver || !state.activeDriverId) return;
  const dId = state.activeDriverId, today = todayStr(), m = today.slice(0,7);
  try{ if(localStorage.getItem(`nhiNoticeMute|${dId}|${m}`)) return; }catch(e){}
  const key = `nhiNotice|${dId}|${today}`;
  try{
    if(localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    Object.keys(localStorage).filter(k=>k.startsWith('nhiNotice|') && k!==key).forEach(k=>localStorage.removeItem(k));
  }catch(e){
    if(state._nhiNoticeDay===today) return; // 瀏覽器不讓存資料時，退而求其次：這次開啟只出現一次
    state._nhiNoticeDay = today;
  }
  let monthAssignments;
  try{
    monthAssignments = await fetchAssignmentsInRange(m+'-01', monthEndStr(m));
    await ensureAdjustmentsRange(m+'-01');
  }catch(e){ return; } // 查失敗就安靜放棄，不影響正常登入流程
  if(state.role!=='driver' || state.activeDriverId!==dId) return; // 查詢期間可能已經登出／切換身份
  const r = driverMonthly(dId, m, monthAssignments);
  const calc = statementNetFromAdjustments(r.tripTotal, r.adjustments);
  const ded = computePayrollDeductions(calc.net, r.reimbursement);
  if(!ded.withholdTax) return;
  showNhiReminderModal();
}
function showNhiReminderModal(){
  let host = document.getElementById('nhiReminderHost');
  if(!host){ host = document.createElement('div'); host.id = 'nhiReminderHost'; document.body.appendChild(host); }
  const dId = state.activeDriverId, m = todayStr().slice(0,7);
  host.innerHTML = `<div class="modal-backdrop" id="nhiReminderBackdrop">
    <div class="modal-box" style="max-width:420px;">
      <h3 style="margin-top:0;">⚠️ 本月所得已達 NT$${money(PAYROLL_WITHHOLD_THRESHOLD)}</h3>
      <p style="font-size:13.5px; line-height:1.7;">之後勞報單如果涵蓋到這段金額，依規定會被扣 10% 所得稅＋2.11% 二代健保補充保費。如果這個月有加油或車輛保養還沒申報，記得先申報發票——代墊費用不算所得，可以降低要課稅的金額。</p>
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--ink-soft); margin:10px 0 14px;"><input type="checkbox" id="nhiReminderMute" style="width:auto;">這個月不再提醒</label>
      <button class="btn amber" id="nhiReminderOk" style="width:100%;">我知道了，查看勞報單預覽</button>
    </div>
  </div>`;
  const applyMuteIfChecked = ()=>{
    const cb = document.getElementById('nhiReminderMute');
    if(cb && cb.checked){ try{ localStorage.setItem(`nhiNoticeMute|${dId}|${m}`, '1'); }catch(e){} }
  };
  document.getElementById('nhiReminderOk').onclick = ()=>{ applyMuteIfChecked(); host.innerHTML=''; state._meSlipPreviewOpen = true; switchTab('my-earnings'); };
  document.getElementById('nhiReminderBackdrop').onclick = (e)=>{ if(e.target.id==='nhiReminderBackdrop'){ applyMuteIfChecked(); host.innerHTML=''; } };
}
// 進入系統時提醒：夥伴還沒上傳身分證正反面（勞報單用途）就跳出來，讓他點「立即拍攝」
// 直接進入拍照流程，或「稍後再說」先去忙別的事——不是強制關卡，不會擋住其他功能。
// 跟上面NHI提醒不同，這裡故意不做「不再提醒」選項：使用者要求「要一直跳浮動視窗到
// 他拍攝為止」，因為這是一次性的必要資料，不像NHI門檻是每月都要重新判斷的狀態，也
// 沒有「這次先不管、之後自然不會再相關」的情況——沒拍完成之前，每次進系統都要再看到。
// 主控「檢視夥伴」不會觸發。
function maybeShowIdCardReminder(){
  if(state.role!=='driver' || state.adminViewDriver || !state.activeDriverId) return;
  const d = state.data.drivers.find(x=>x.id===state.activeDriverId);
  if(!d || d.idCardPath) return;
  showIdCardReminderModal(d.id);
}
function showIdCardReminderModal(dId){
  let host = document.getElementById('idCardReminderHost');
  if(!host){ host = document.createElement('div'); host.id = 'idCardReminderHost'; document.body.appendChild(host); }
  host.innerHTML = `<div class="modal-backdrop" id="idCardReminderBackdrop">
    <div class="modal-box" style="max-width:420px;">
      <h3 style="margin-top:0;">📋 請拍攝身分證正反面</h3>
      <p style="font-size:13.5px; line-height:1.7;">勞報單申報需要身分證正反面照片，請拍攝上傳——只有主控看得到，系統會自動合成並加註浮水印，僅供勞報使用。還沒完成之前，每次進來都會再提醒一次。</p>
      <div style="display:flex; gap:10px; margin-top:14px;">
        <button class="btn ghost" id="idCardReminderLater" style="flex:1;">稍後再說</button>
        <button class="btn amber" id="idCardReminderGo" style="flex:1;">立即拍攝</button>
      </div>
    </div>
  </div>`;
  const close = ()=>{ host.innerHTML = ''; };
  document.getElementById('idCardReminderLater').onclick = close;
  document.getElementById('idCardReminderBackdrop').onclick = (e)=>{ if(e.target.id==='idCardReminderBackdrop') close(); };
  document.getElementById('idCardReminderGo').onclick = async ()=>{
    close();
    try{
      const dataUrl = await captureIdCardPhoto();
      if(!dataUrl) return; // 使用者自己取消拍攝，什麼都不做，下次進系統會再提醒
      const path = await uploadDriverIdCard(dId, dataUrl);
      await setDriverIdCardPath(dId, path);
      if(state.activeDriverId===dId) renderContent();
    }catch(err){ alert(err.message); }
  };
}
// 語音辨識結果的二次確認卡片（2026-10-29，雙大腦架構的安全關卡——2026-10-28定案：
// 語音助理聽到的內容絕對不能直接寫入資料庫，一定要先讓夥伴看過、自己點確認才算數）。
// intent格式：{ type:'leave', date:'YYYY-MM-DD'（可能沒有/格式不對）, rawText:'聽到的原話' }。
// 語音助理前端接上後，呼叫 showVoiceIntentConfirmCard(intent) 即可；目前沒有語音輸入
// 來源，先靠 window.__testVoiceIntent() 手動模擬觸發測試這整套確認流程。
// 10秒沒有互動、或一開始intent就沒有有效日期，自動（或直接）退回手動日期選擇器，
// 不讓夥伴卡在一個聽不懂在問什麼的畫面。
function showVoiceIntentConfirmCard(intent){
  let host = document.getElementById('voiceConfirmHost');
  if(!host){ host = document.createElement('div'); host.id = 'voiceConfirmHost'; document.body.appendChild(host); }
  const dId = state.activeDriverId;
  let timer = null;
  const doneHtml = (dateVal)=>`<div class="modal-backdrop" id="voiceConfirmBackdrop"><div class="modal-box" style="max-width:380px; text-align:center;"><p>✅ 已登記 ${dateVal} 請假</p><button class="btn ghost" id="voiceConfirmClose" style="margin-top:8px;">關閉</button></div></div>`;
  const wireClose = ()=>{ const b=document.getElementById('voiceConfirmClose'); if(b) b.onclick = ()=>{ host.innerHTML=''; if(state.tab==='home') renderLeavePanel(); }; };
  const submit = async (dateVal)=>{
    try{
      await createDriverUnavailability(dId, dateVal, (intent && intent.rawText) || '', 'voice');
      host.innerHTML = doneHtml(dateVal);
      wireClose();
    }catch(err){ alert(err.message); host.innerHTML=''; }
  };
  const render = (fallback)=>{
    if(!document.body.contains(host)) return; // 夥伴可能已經登出或頁面已經卸載
    const dateVal = (intent && intent.date) || '';
    host.innerHTML = `<div class="modal-backdrop" id="voiceConfirmBackdrop">
      <div class="modal-box" style="max-width:380px;">
        ${fallback ? `
          <h3 style="margin-top:0;">請選擇請假日期</h3>
          <p style="font-size:13px; color:var(--ink-soft);">${intent && intent.rawText ? `剛剛聽到：「${escapeHtml(intent.rawText)}」，但系統沒辨識出明確日期，請手動選擇：` : '語音辨識逾時，請手動選擇：'}</p>
          <input type="date" id="voiceFallbackDate" min="${todayStr()}" style="width:100%; margin-bottom:10px;">
          <button class="btn amber" id="voiceFallbackSubmit" style="width:100%;">送出</button>
        ` : `
          <h3 style="margin-top:0;">🎙️ 語音辨識結果</h3>
          ${intent && intent.rawText ? `<p style="font-size:12.5px; color:var(--ink-soft);">剛剛聽到：「${escapeHtml(intent.rawText)}」</p>` : ''}
          <p style="font-size:15px; font-weight:600;">系統辨識：${dateVal} 請假，請問是否正確？</p>
          ${leaveUrgencyWarning(dateVal, dId) ? `<p style="font-size:12.5px; color:var(--danger); font-weight:600;">${escapeHtml(leaveUrgencyWarning(dateVal, dId))}</p>` : ''}
          <div style="display:flex; gap:8px;">
            <button class="btn amber" id="voiceConfirmYes" style="flex:1;">👍 正確，送出</button>
            <button class="btn ghost" id="voiceConfirmNo" style="flex:1;">不對，手動選</button>
          </div>
          <div id="voiceCountdown" style="font-size:11.5px; color:var(--ink-soft); margin-top:8px; text-align:center;"></div>
        `}
      </div>
    </div>`;
    if(fallback){
      document.getElementById('voiceFallbackSubmit').onclick = ()=>{
        const d = document.getElementById('voiceFallbackDate').value;
        if(!d){ alert('請選擇日期'); return; }
        const warn = leaveUrgencyWarning(d, dId);
        if(warn && !confirm(warn + '\n\n仍要送出這筆登記嗎？')) return;
        submit(d);
      };
      return;
    }
    let secs = 10;
    const tick = ()=>{
      if(!document.body.contains(host)){ clearInterval(timer); timer=null; return; }
      const cd = document.getElementById('voiceCountdown');
      if(cd) cd.textContent = `${secs}秒後自動切換成手動選擇`;
      secs--;
      if(secs<0){ clearInterval(timer); timer=null; render(true); }
    };
    tick(); timer = setInterval(tick, 1000);
    document.getElementById('voiceConfirmYes').onclick = ()=>{ clearInterval(timer); timer=null; submit(dateVal); };
    document.getElementById('voiceConfirmNo').onclick = ()=>{ clearInterval(timer); timer=null; render(true); };
  };
  const hasDate = intent && intent.date && /^\d{4}-\d{2}-\d{2}$/.test(intent.date);
  render(!hasDate); // 一開始就沒有有效日期的話，直接跳手動選擇，不用先演一次辨識畫面
}
// 測試用：模擬語音助理解析出的結果，手動觸發確認卡片（主控瀏覽器console呼叫），
// 不用真的接上語音也能測整套二次確認流程。語音前端做好之後，這個保留當偵錯工具即可。
window.__testVoiceIntent = (date, rawText)=> showVoiceIntentConfirmCard({ type:'leave', date: date||'', rawText: rawText||'下週二家裡有事請假' });
// 今天全部完成的慶祝動畫：彩帶＋卡片彈出＋金額數字跳動，每位夥伴每天只播一次；之後同一天再進來就維持靜態完成畫面，隔天（午夜 12 點後）自動換新的一天。
// 夥伴自己拍的照片縮圖：只存在這支手機的瀏覽器裡（約 4KB 的小圖，上傳當下就地縮出來），
// 完全不用網路、不會向伺服器多要任何照片資料（不佔流量）。只暫存當天（過了午夜就清掉），每個店點最多 3 張；歷史任務不顯示縮圖、維持原本的樣子；換手機看不到縮圖，但「✓ 已上傳 N 張」仍在。
function makeThumb(dataUrl, size){
  size = size || 120;
  return new Promise(res=>{
    const im = new Image();
    im.onload = ()=>{
      const r = Math.min(size/im.width, size/im.height, 1);
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.width*r)); c.height = Math.max(1, Math.round(im.height*r));
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      try{ res(c.toDataURL('image/jpeg', 0.55)); }catch(e){ res(null); }
    };
    im.onerror = ()=> res(null);
    im.src = dataUrl;
  });
}
function thumbsGet(dpId){
  try{
    const today = todayStr(); // 只留當天的縮圖，過了午夜就不再顯示
    return JSON.parse(localStorage.getItem('thumbs|'+dpId) || '[]').filter(x=>x && x.d===today && x.u);
  }catch(e){ return []; }
}
function thumbsPrune(){
  try{
    const today = todayStr();
    Object.keys(localStorage).filter(k=>k.startsWith('thumbs|')).forEach(k=>{
      let a = []; try{ a = JSON.parse(localStorage.getItem(k) || '[]'); }catch(e){}
      a = a.filter(x=>x && x.d===today);
      if(a.length) localStorage.setItem(k, JSON.stringify(a)); else localStorage.removeItem(k);
    });
  }catch(e){}
}
// 離線佇列中的店點：只存在記憶體裡（跟this次開啟畫面同生命週期），單純用來
// 在畫面上標一個「等待上傳」的提示——實際佇列內容在IndexedDB(見data-layer.js)，
// 重新整理畫面後仍在，只是這個小提示要等flushPendingOfflineBadges()重新掃一次。
state._offlinePendingDp = state._offlinePendingDp || new Set();
function markDpOfflinePending(dpId){ state._offlinePendingDp.add(dpId); }
async function refreshOfflinePendingBadges(){
  try{
    const items = await listPendingUploads();
    state._offlinePendingDp = new Set(items.map(x=>x.dropPointId));
  }catch(e){}
}
// 恢復網路／App回到前景／剛開啟App時都試著補送一次離線佇列——這三個
// 時機涵蓋「訊號差的店離開了」「切到別的App再切回來」「昨天沒傳完，
// 今天重新登入」幾種實際會發生的情況。只註冊一次監聽，避免登出再登入
// 時重複掛好幾份一樣的事件。
let _offlineFlushWired = false;
function setupOfflineUploadFlush(){
  if(_offlineFlushWired) return;
  _offlineFlushWired = true;
  const tryFlush = ()=>{
    flushPendingUploads().then(()=> refreshOfflinePendingBadges().then(()=>renderContent()));
  };
  window.addEventListener('online', tryFlush);
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') tryFlush(); });
  tryFlush();
}
async function thumbsAdd(dpId, dataUrl){
  const t = await makeThumb(dataUrl);
  if(!t) return;
  try{
    const a = thumbsGet(dpId); a.push({ d: todayStr(), u: t });
    localStorage.setItem('thumbs|'+dpId, JSON.stringify(a.slice(-3)));
    thumbsPrune();
  }catch(e){} // 手機儲存空間滿了：不影響上傳，只是不顯示縮圖
}
// 照片上傳成功：畫面中央大勾勾一閃（約 1.3 秒）＋通知，讓夥伴確定「有傳成功」。
function showCheckOverlay(n){
  document.getElementById('checkOverlay')?.remove();
  const el = document.createElement('div'); el.id = 'checkOverlay'; el.innerHTML = '<div>✓</div>';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 1400);
  toast(`照片上傳成功${n?`（${n} 張）`:''}`, { type:'ok' });
  try{ if(navigator.vibrate) navigator.vibrate(60); }catch(e){}
}
function playCelebration(card, earn){
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){ const a = card.querySelector('.amt'); if(a) a.textContent = '今日報酬 $'+money(earn); return; }
  const host = document.createElement('div'); host.id = 'confettiHost';
  const colors = ['#E0902E','#2C6B44','#2C5F8A','#B5493A','#D4AF37','#7B5EA7'];
  for(let i=0;i<70;i++){
    const c = document.createElement('i');
    c.style.left = Math.random()*100 + 'vw';
    c.style.background = colors[i%colors.length];
    c.style.setProperty('--dx', (Math.random()*160-80) + 'px');
    c.style.setProperty('--rot', (Math.random()*900-450) + 'deg');
    c.style.animationDuration = (2.2 + Math.random()*1.8) + 's';
    c.style.animationDelay = (Math.random()*0.8) + 's';
    host.appendChild(c);
  }
  document.body.appendChild(host);
  setTimeout(()=>host.remove(), 5200);
  const amt = card.querySelector('.amt');
  if(amt){
    const t0 = performance.now(), dur = 1300;
    const step = now=>{
      const k = Math.min(1, (now - t0)/dur), eased = 1 - Math.pow(1-k, 3);
      amt.textContent = '今日報酬 $' + money(Math.round(earn*eased));
      if(k<1 && amt.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
function renderTodayDetail(todays){
  const box = document.getElementById('todayDetail');
  // 「交給我支援」的店點（資料庫只讓我看到被交給我的那幾個）：另外一張卡片，沒有開始／完成按鈕、不顯示報酬。
  const supportToday = state.data.assignments.filter(a=>a.isSupport && a.date===todayStr());
  if(!todays.length && !supportToday.length){
    // 今天有任務、而且全部都完成了：給一個完成畫面和今日報酬（沒任務才顯示「今天沒有排定任務」）。
    const doneToday = state.data.assignments.filter(a=>a.driverId===state.activeDriverId && !a.isSupport && a.published!==false && a.date===todayStr() && a.status==='completed');
    if(doneToday.length){
      const earn = doneToday.reduce((n,a)=>n+tripPay(a),0);
      // 只有夥伴本人（不是主控檢視）、而且今天第一次看到完成畫面才播動畫
      const own = state.role==='driver' && !state.adminViewDriver;
      const key = `celebrated|${state.activeDriverId}|${todayStr()}`;
      let first = false;
      if(own){
        try{
          first = !localStorage.getItem(key);
          if(first){
            Object.keys(localStorage).filter(k=>k.startsWith('celebrated|') && k!==key).forEach(k=>localStorage.removeItem(k));
            localStorage.setItem(key, '1');
          }
        }catch(e){}
      }
      box.innerHTML = `<div class="dv-done ${first?'anim':''}"><div class="big">🎉</div><h3>今天的任務全部完成了</h3><div style="font-size:13px; color:var(--ink-soft);">共 ${doneToday.length} 趟，辛苦了！</div><div class="amt">今日報酬 $${first?'0':money(earn)}</div></div>`;
      if(first) playCelebration(box.querySelector('.dv-done'), earn);
    } else box.innerHTML = '<div class="empty">今天沒有排定任務</div>';
    return;
  }
  // 進度與「下一站」：只統計今天的任務；下一站＝進行中的任務裡第一個還沒完成、也沒填未完成原因的店點，
  // 沒有進行中的任務時就是今天第一個任務的第一站。
  const todayMine = todays.filter(a=>a.date===todayStr());
  const pending = dp=> dp.status!=='completed' && !dp.issueReason;
  const allDps = todayMine.flatMap(a=>ownDropPoints(a));
  const doneN = allDps.filter(dp=>dp.status==='completed').length;
  let nextA = todayMine.find(a=>a.status==='in_progress' && ownDropPoints(a).some(pending)) || todayMine.find(a=>a.status==='scheduled');
  const nextDp = nextA ? ownDropPoints(nextA).find(pending) : null;
  const nextDpId = null; // 進行中的任務改由下方時間軸呈現「建議下一站」
  const flashId = state._flashDp; state._flashDp = null;
  const progHtml = allDps.length ? `<div class="dv-prog">
      <div class="dv-top"><span>今日進度</span><span><b>${doneN}</b> / ${allDps.length} 站</span></div>
      <div class="ov-bar" style="margin:8px 0 0;"><i style="width:${Math.round(doneN*100/allDps.length)}%"></i></div>
    </div>` : '';
  const nextHtml = (nextA && nextA.status==='scheduled' && nextDp) ? `<div class="dv-next">
      <span class="dv-tag">${nextA.status==='in_progress'?'下一站':'今天第一站'}</span>
      <div class="dv-name">${escapeHtml(dpLabel(nextDp))}</div>
      <div class="dv-addr">${escapeHtml(nextDp.address||'')}（${escapeHtml(channelName(nextDp.channelId))}）・${escapeHtml(routeName(nextA.routeId))}</div>
      <div class="dv-actions">
        <a class="btn amber" href="${mapLink(nextDp.address)}" target="_blank" rel="noopener">🧭 導航</a>
        ${nextA.status==='in_progress' ? `<button class="btn ghost" data-gonext="${nextDp.id}">📷 拍照上傳</button>` : `<button class="btn ghost" data-gostart="${nextA.id}">開始任務</button>`}
      </div>
    </div>` : '';
  // 一個店點一列（狀態、拍照／上傳／導航按鈕、未完成原因）；readonly＝已交給支援夥伴，原夥伴只看狀態不能再動。
  const dpRow = (a, dp, readonly)=>{
    const photoCount = (dp.status==='completed'?1:0) + (dp.media||[]).filter(m=>m.type==='image').length;
    const photoUrls = dpPhotoUrls(dp);
    const statusBadge = dp.status==='completed'
      ? `<span class="badge completed"${photoUrls.length?' data-viewphoto style="cursor:pointer;"':''}>已完成${photoUrls.length?'・點擊看照片':''}</span>`
      : '<span class="badge pending">待完成</span>';
    return `
          <div class="drop-point-driver ${dp.id===nextDpId?'next-stop':''} ${dp.id===flashId?'flash':''}" data-dpid="${dp.id}">
            <span class="store-name">${dpLabel(dp)}</span>（${channelName(dp.channelId)}）
            ${statusBadge}
            ${state._offlinePendingDp && state._offlinePendingDp.has(dp.id) ? '<span class="badge" style="background:#E7E9EC; color:#555;">📦 離線佇列中・恢復網路後自動上傳</span>' : ''}
            ${photoCount ? `<span class="upok"><b>✓</b>已上傳 ${photoCount} 張</span>` : ''}
            ${(()=>{ const th = thumbsGet(dp.id); return th.length ? `<div class="thms">${th.map(x=>`<img class="thm" src="${x.u}" alt="" loading="lazy">`).join('')}</div>` : ''; })()}
            ${readonly ? `<span class="badge" style="background:#E3EEF7; color:#2F6EA5;">由${escapeHtml(dp.helperName||'支援夥伴')}支援</span>` : ''}
            ${dp.status!=='completed' && dp.issueReason ? `<span class="badge" style="background:#F4E3C1; color:#7A5A00;">未完成：${dp.issueReason}</span>` : ''}
            ${(()=>{ const note = state.data.dropPoints.find(x=>x.id===dp.sourceDpId)?.unloadNote; return note ? `<div style="font-size:12.5px; background:#FFF6E0; border-radius:6px; padding:5px 8px; margin-top:6px;">📝 卸貨備註：${escapeHtml(note)}</div>` : ''; })()}
            ${readonly ? '' : `<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
              ${photoCount<3 ? `
              <button type="button" class="btn ghost" style="flex:1; min-width:110px; margin:0;" data-photo="${a.id}|${dp.id}">拍照上傳</button>
              <input type="file" accept="image/*" capture="environment" data-photofallback="${a.id}|${dp.id}" style="display:none;">
              <button type="button" class="btn ghost" style="flex:1; min-width:110px; margin:0;" data-photolib="${a.id}|${dp.id}">上傳照片</button>
              <input type="file" accept="image/*" multiple data-photolibinput="${a.id}|${dp.id}" style="display:none;">
              ` : '<span style="font-size:11.5px; color:var(--ink-soft);">已達3張上限</span>'}
              <a class="btn ghost" href="${mapLink(dp.address)}" target="_blank" style="flex:1; min-width:110px;">Google導航</a>
              <button type="button" class="btn ghost" style="flex:1; min-width:110px; margin:0;" data-unloadnote="${dp.sourceDpId||''}">✏️ 卸貨備註</button>
            </div>
            ${!dp.photo && dp.photoCleared?'<span style="font-size:11.5px; color:var(--ink-soft);">照片已超過30天自動清除</span>':''}
            ${dp.status!=='completed' ? `<div style="margin-top:8px;">
              <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:3px;">若無法完成，請選擇原因：</label>
              <select data-issue="${a.id}|${dp.id}" style="width:100%;">
                <option value="">－選擇原因－</option>
                ${['通路未下單','央廚未出貨','便當翻覆','遲到拒收'].map(r=>`<option value="${r}" ${dp.issueReason===r?'selected':''}>${r}</option>`).join('')}
              </select>
            </div>` : ''}`}
          </div>`;
  };
  // 自己當天有任務時，支援的店點直接併進自己的那一台車（用藍框區塊標示「支援」）；當天沒有自己的任務才用獨立卡片。
  const supBlock = s=>`<div style="margin:10px 0; padding:8px; border:2px solid #2F6EA5; border-radius:8px;">
      <div style="font-size:12.5px; font-weight:700; color:#2F6EA5; margin-bottom:4px;">支援：${routeName(s.routeId)}（原夥伴：${escapeHtml(s.originalDriverName||'—')}）${s.dropPoints.length}個店點，直接拍照上傳即可</div>
      ${s.dropPoints.map(dp=>dpRow(s, dp, false)).join('')}
    </div>`;
  const supportHtml = supportToday.map(a=>`<div class="panel" style="border-color:#2F6EA5; border-width:2px;">
      <div class="toolbar"><strong>支援：${routeName(a.routeId)}</strong><span class="badge" style="background:#E3EEF7; color:#2F6EA5;">原夥伴：${escapeHtml(a.originalDriverName||'—')}</span></div>
      <p style="font-size:12.5px; color:var(--ink-soft);">這是臨時交給您支援的店點（${a.dropPoints.length} 個），到店後直接拍照上傳即可，不需要再傳給原夥伴。完成後原夥伴會自動看到。</p>
      ${a.dropPoints.map(dp=>dpRow(a, dp, false)).join('')}
    </div>`).join('');
  // 時間軸：已完成（依實際完成順序，多了會收成一行）在上，還沒到的站（預排順序）在下；點某一站展開它的拍照／導航。
  state._tl = state._tl || {};
  const tlState = aid=> (state._tl[aid] = state._tl[aid] || { focus:null, doneOpen:false });
  const timelineHtml = (a, mine)=>{
    const st = tlState(a.id);
    const seq = dp=> mine.indexOf(dp) + 1;
    const doneL = mine.filter(dp=>dp.status==='completed').sort((x,y)=> (x.completedAt||'').localeCompare(y.completedAt||'') || seq(x)-seq(y));
    const handledL = mine.filter(dp=>dp.status!=='completed' && dp.issueReason);
    const pendL = mine.filter(dp=>dp.status!=='completed' && !dp.issueReason);
    const finished = doneL.concat(handledL);
    let focus = st.focus;
    if(focus===null) focus = pendL.length ? pendL[0].id : '__none';
    st.eff = focus; // 目前實際展開的是哪一站（點同一站＝收合）
    const key = dp=> `${a.id}|${dp.id}`;
    const chips = dp=>{
      const th = thumbsGet(dp.id);
      return th.length ? `<div class="thms">${th.map(x=>`<img class="thm" src="${x.u}" alt="" loading="lazy">`).join('')}</div>` : '';
    };
    const photoN = dp=> (dp.status==='completed'?1:0) + (dp.media||[]).filter(m=>m.type==='image').length;
    const expanded = (dp, kind)=> `<div class="tl-card ${kind==='done'?'donecard':''}">
        <div class="tl-row" data-tlpick="${key(dp)}"><div class="tl-nm">${escapeHtml(dpLabel(dp))}<span class="tl-pill">${escapeHtml(channelName(dp.channelId))}</span><span class="tl-pill">預排第 ${seq(dp)} 站</span></div>
        <div class="tl-sub" style="color:var(--teal); font-weight:600;">${kind==='next' ? (dp===pendL[0] ? '建議下一站' : '你選的下一站') : '點一下收合'}</div></div>
        ${dpRow(a, dp, false)}</div>`;
    const rowOf = (dp, kind, idxInDone)=>{
      const isFocus = focus===dp.id;
      const isNew = dp.id===flashId;
      let dot, info;
      if(kind==='done'){
        dot = '<div class="tl-dot done">✓</div>';
        const reordered = seq(dp)!==idxInDone+1;
        info = `<div class="tl-nm">${escapeHtml(dpLabel(dp))}${reordered?`<span class="tl-pill alt">預排第 ${seq(dp)} 站</span>`:''}</div>
          <div class="tl-sub" style="color:var(--ok,#2C6B44);">第 ${idxInDone+1} 個到${photoN(dp)?`　✓ 已上傳 ${photoN(dp)} 張`:''}</div>${chips(dp)}`;
      } else if(kind==='handled'){
        dot = '<div class="tl-dot warn">!</div>';
        info = `<div class="tl-nm">${escapeHtml(dpLabel(dp))}</div><div class="tl-sub" style="color:#8A5A17;">未完成：${escapeHtml(dp.issueReason)}</div>`;
      } else {
        dot = isFocus ? '<div class="tl-dot cur"></div>' : `<div class="tl-dot">${seq(dp)}</div>`;
        info = `<div class="tl-nm">${escapeHtml(dpLabel(dp))}<span class="tl-pill">${escapeHtml(channelName(dp.channelId))}</span></div><div class="tl-sub">預排第 ${seq(dp)} 站・點一下展開</div>`;
      }
      const body = isFocus ? expanded(dp, kind==='pend'?'next':'done') : `<div class="tl-row" data-tlpick="${key(dp)}">${info}</div>`;
      return { dot, body, isNew };
    };
    const lines = [];
    // 已完成區（超過 2 站收成一行）
    const hideN = (!st.doneOpen && finished.length>2) ? finished.length-2 : 0;
    if(hideN) lines.push({ dot:'<div class="tl-dot done">✓</div>', body:`<div class="tl-fold" data-tldone="${a.id}">已完成 ${hideN} 站 ▸（點一下展開）</div>`, seg:'done' });
    finished.forEach((dp,k)=>{
      if(k<hideN) return;
      const kind = dp.status==='completed' ? 'done' : 'handled';
      const r = rowOf(dp, kind, k);
      lines.push({ dot:r.dot, body:r.body, seg:'done', isNew:r.isNew });
    });
    if(st.doneOpen && finished.length>2) lines.push({ dot:'', body:`<div class="tl-fold" data-tldone="${a.id}" style="padding-left:0;">收起 ▴</div>`, seg:'none' });
    if(pendL.length && finished.length) lines.push({ divider:`還沒到的站（可以任選順序）` });
    pendL.forEach(dp=>{ const r = rowOf(dp, 'pend', 0); lines.push({ dot:r.dot, body:r.body, seg:'todo' }); });
    const flag = pendL.length ? '<div class="tl-dot">⚑</div>' : '<div class="tl-dot done">⚑</div>';
    let h = `<div class="tl-st"><div class="tl-rail"><div class="tl-dot org">⌂</div><div class="tl-seg"></div></div><div class="tl-body" style="padding-bottom:6px;"><div class="tl-sub" style="margin-top:3px;">出發　${escapeHtml(a.origin||'')}</div></div></div>`;
    lines.forEach(L=>{
      if(L.divider){ h += `<div class="tl-divider">${L.divider}</div>`; return; }
      if(L.seg==='none'){ h += `<div class="tl-st"><div class="tl-rail"></div><div class="tl-body" style="padding-bottom:6px;">${L.body}</div></div>`; return; }
      h += `<div class="tl-st ${L.isNew?'tl-new':''}"><div class="tl-rail">${L.dot}<div class="tl-seg ${L.seg==='todo'?'todo':''}"></div></div><div class="tl-body">${L.body}</div></div>`;
    });
    h += `<div class="tl-st"><div class="tl-rail">${flag}</div><div class="tl-body" style="padding-bottom:4px;"><div class="tl-sub" style="margin-top:3px;">收工　全部處理完後按下面「完成任務」</div></div></div>`;
    return h;
  };
  box.innerHTML = progHtml + nextHtml + todays.map(a=>{
    const mine = ownDropPoints(a);
    const allHandled = mine.length>0 && mine.every(dp=>dp.status==='completed' || dp.issueReason);
    const isPast = a.date < todayStr();
    return `<div class="panel" ${isPast?'style="border-color:var(--danger); border-width:2px;"':''}>
      <div class="toolbar">
        <strong>${isPast?`<span class="badge" style="background:#FBEAE6; color:var(--danger); margin-right:6px;">${a.date.slice(5).replace('-','/')} 還沒完成</span>`:''}${routeName(a.routeId)}</strong>
        <span>
          ${a.status==='scheduled'?'<span class="badge pending">尚未開始</span>':a.status==='in_progress'?'<span class="badge progress">執行中</span>':''}
          <a class="btn ghost" href="${lineShareLink(`【任務提醒】${a.date} ${routeName(a.routeId)}\n任務起點：${a.origin||'—'}\n店點：${mine.map(dpLabel).join('、')||'尚未建立'}`)}" target="_blank" style="text-decoration:none; display:inline-block;">分享至LINE</a>
        </span>
      </div>
      <p style="font-size:12.5px;">任務起點：${a.origin||'—'} ${(()=>{ const link = buildMultiStopMapsLink(a.origin, mine); return link ? `<a class="link" href="${link}" target="_blank">開啟多點導航</a>` : ''; })()}</p>
      ${a===todays[0] ? supportToday.map(supBlock).join('') : ''}
      ${a.status==='scheduled' ? `<button class="btn amber" data-start="${a.id}">開始任務</button>` : `
        ${timelineHtml(a, mine)}
        <button class="btn amber" style="margin-top:10px;" data-finish="${a.id}">完成任務（自動封存進歷史任務）</button>
        ${!allHandled?'<p style="font-size:11.5px;color:var(--ink-soft);">尚有店點未完成拍照或未選擇未完成原因，結束時需填寫備註說明原因</p>':''}
      `}
    </div>`;
  }).join('') + (todays.length ? '' : supportHtml);
  // 照片改成跟歷史任務一樣，點擊「已完成」才載入——手機背景切換常把頁面砍掉
  // 重開，之前「一開頁面就自動載入當天所有已完成照片」會讓同一批照片被
  // 重複下載很多次，是 Storage 流量爆量的主因之一。
  const dpById = {};
  const aByDpId = {};
  [...todays, ...supportToday].forEach(a=> a.dropPoints.forEach(dp=> { dpById[dp.id]=dp; aByDpId[dp.id]=a; }));
  // 店點的拍照/上傳/刪除/未完成原因/卸貨備註控制項是top-level的wireStopPhotoControls()
  // （見下方定義，接受 root/dpById/aByDpId/onDone）；renderHistory() 也會呼叫同一套，
  // 讓主控重置過的店點在歷史任務畫面裡一樣能重新拍照上傳，不用再寫一次同樣的邏輯。
  wireStopPhotoControls(box, dpById, aByDpId);
  box.querySelectorAll('[data-tlpick]').forEach(el=>{
    el.onclick = ()=>{ const [aid, dpid] = el.dataset.tlpick.split('|'); const st = tlState(aid); st.focus = (st.eff===dpid) ? '__none' : dpid; renderTodayDetail(todays); };
  });
  box.querySelectorAll('[data-tldone]').forEach(el=>{
    el.onclick = ()=>{ const st = tlState(el.dataset.tldone); st.doneOpen = !st.doneOpen; renderTodayDetail(todays); };
  });
  box.querySelectorAll('[data-gonext]').forEach(btn=>{
    btn.onclick = ()=>{ const el = box.querySelector(`[data-dpid="${btn.dataset.gonext}"]`); if(el) el.scrollIntoView({behavior:'smooth', block:'center'}); };
  });
  box.querySelectorAll('[data-gostart]').forEach(btn=>{
    btn.onclick = async ()=>{ try{ await markAssignmentDeparted(btn.dataset.gostart); renderContent(); } catch(err){ alert(err.message); } };
  });
  box.querySelectorAll('[data-start]').forEach(btn=>{
    btn.onclick = async ()=>{
      try{ await markAssignmentDeparted(btn.dataset.start); renderContent(); }
      catch(err){ alert(err.message); }
    };
  });
  box.querySelectorAll('[data-finish]').forEach(btn=>{
    btn.onclick = async ()=>{
      const a = state.data.assignments.find(x=>x.id===btn.dataset.finish);
      const allHandled = ownDropPoints(a).length>0 && ownDropPoints(a).every(dp=>dp.status==='completed' || dp.issueReason);
      let issueNote;
      if(!allHandled){
        const note = prompt('尚有店點未完成拍照、也沒有選擇未完成原因，請說明原因（此備註主控端會看到）：');
        if(note===null) return;
        if(!note.trim()){ alert('請填寫備註原因'); return; }
        issueNote = note.trim();
      }
      try{ await markAssignmentComplete(a.id, issueNote); renderContent(); }
      catch(err){ alert(err.message); }
    };
  });
}

// 店點的拍照/上傳/刪除/未完成原因/卸貨備註控制項：原本寫在 renderTodayDetail() 裡面、
// 靠閉包抓 dpById/aByDpId，只有「今天」畫面能用；現在改成 top-level 函式、dpById/aByDpId
// 當參數傳進來，renderTodayDetail()跟renderHistory()可以共用同一套（主控在歷史任務裡
// 重置某個店點後，一樣要能在這裡重新拍照上傳，不想為了這個再寫一次一樣的邏輯）。
// onDone 選填：呼叫端如果有自己的局部重畫邏輯（目前都沒有，都是靠外層 renderContent()
// 整頁重畫涵蓋到），可以傳進來在 refresh() 時一併執行。
function wireStopPhotoControls(root, dpById, aByDpId, onDone){
  const refresh = ()=>{ renderContent(); if(onDone) onDone(); };
  root.querySelectorAll('[data-dpid]').forEach(el=>{
    const dp = dpById[el.dataset.dpid];
    if(!dp) return;
    const items = dpPhotoItems(dp);
    const vp = el.querySelector('[data-viewphoto]');
    if(!items.length || !vp) return;
    const a = aByDpId[el.dataset.dpid];
    // 任務還沒封存（status !== 'completed'）才開放夥伴自己刪除；主控（state.role==='admin'，
    // 含「主控檢視中」）不受這條限制，封存後真的傳錯也能刪——理由見
    // deleteDropPointPhoto/deleteDropPointMedia 的說明。
    const canDelete = a && (a.status!=='completed' || state.role==='admin');
    vp.onclick = ()=> openPhotoLightbox(items.map(x=>x.url), canDelete ? {
      onDelete: async (i)=>{
        const item = items[i];
        if(item.kind==='main') await deleteDropPointPhoto(a.id, dp.id);
        else await deleteDropPointMedia(a.id, item.mediaId);
        refresh();
      }
    } : null);
  });
  root.querySelectorAll('[data-photo]').forEach(btn=>{
    const [aid, dpid] = btn.dataset.photo.split('|');
    const fallbackInput = root.querySelector(`[data-photofallback="${aid}|${dpid}"]`);
    // 浮水印要疊的店名：跟店點一起查，拍照當下就知道是哪一家，不用等上傳完才補。
    const storeName = dpLabel(state.data.assignments.find(x=>x.id===aid)?.dropPoints.find(x=>x.id===dpid));
    async function goMany(dataUrls, coords){
      const up = toast(`📤 照片上傳中（${dataUrls.length} 張），請稍候…`, { type:'info', sticky:true });
      try{
        for(const dataUrl of dataUrls) await fillNextPhotoSlot(aid, dpid, dataUrl, coords);
        up.dismiss();
        state._flashDp = dpid; if(state._tl && state._tl[aid]) state._tl[aid].focus = null;
        refresh();
        showCheckOverlay(dataUrls.length);
      }catch(err){
        up.dismiss();
        if(err.queued){ toast('📦 '+err.message, { type:'info' }); refresh(); }
        else { console.error('照片處理失敗', err); alert('照片處理失敗：'+err.message+'\n請重新拍攝再試一次。'); }
      }
    }
    btn.onclick = ()=>{
      const dp = state.data.assignments.find(x=>x.id===aid)?.dropPoints.find(x=>x.id===dpid);
      const photoCount = (dp && dp.status==='completed'?1:0) + (dp?.media||[]).filter(m=>m.type==='image').length;
      const budget = Math.max(1, 3 - photoCount);
      capturePhoto(fallbackInput, budget, goMany, storeName);
    };
    fallbackInput.onchange = (e)=>{
      const files = [...e.target.files]; if(!files.length) return;
      (async ()=>{
        try{
          const shots = [];
          for(const f of files){ const coords = await readExifGps(f); shots.push(await watermarkDataUrl(await compressImageFile(f), storeName, coords)); }
          await goMany(shots.map(x=>x.dataUrl), shots[0]?.coords||null);
        }catch(err){
          console.error('照片處理失敗', err);
          alert('照片處理失敗：'+err.message+'\n請重新拍攝或選擇另一張照片再試一次。');
        }
      })();
    };
  });
  root.querySelectorAll('[data-photolib]').forEach(btn=>{
    const [aid, dpid] = btn.dataset.photolib.split('|');
    const libInput = root.querySelector(`[data-photolibinput="${aid}|${dpid}"]`);
    btn.onclick = ()=> libInput.click();
    libInput.onchange = (e)=>{
      const files = [...e.target.files]; if(!files.length) return;
      const dp = state.data.assignments.find(x=>x.id===aid)?.dropPoints.find(x=>x.id===dpid);
      const photoCount = (dp && dp.status==='completed'?1:0) + (dp?.media||[]).filter(m=>m.type==='image').length;
      const budget = Math.max(0, 3 - photoCount);
      const acceptFiles = files.slice(0, budget);
      const droppedCount = files.length - acceptFiles.length;
      (async ()=>{
        try{
          const shots = [];
          for(const f of acceptFiles){ const coords = await readExifGps(f); shots.push(await watermarkDataUrl(await compressImageFile(f), dpLabel(dp), coords)); }
          for(const s of shots) await fillNextPhotoSlot(aid, dpid, s.dataUrl, s.coords);
          state._flashDp = dpid; if(state._tl && state._tl[aid]) state._tl[aid].focus = null;
          showCheckOverlay(acceptFiles.length);
          if(droppedCount>0) alert(`一個店點最多3張照片，已上傳${acceptFiles.length}張，其餘 ${droppedCount} 張未上傳。`);
          refresh();
        }catch(err){
          if(err.queued){ toast('📦 '+err.message, { type:'info' }); refresh(); return; }
          console.error('照片處理失敗', err);
          alert('照片處理失敗：'+err.message+'\n請重新選擇照片再試一次。');
        }
      })();
    };
  });
  root.querySelectorAll('[data-issue]').forEach(sel=>{
    sel.onchange = async ()=>{
      const [aid, dpid] = sel.dataset.issue.split('|');
      try{ await setDropPointIssueReason(aid, dpid, sel.value || null); refresh(); }
      catch(err){ alert(err.message); }
    };
  });
  root.querySelectorAll('[data-unloadnote]').forEach(btn=>{
    btn.onclick = async ()=>{
      const sourceDpId = btn.dataset.unloadnote;
      if(!sourceDpId){ alert('這個店點還沒有建檔完整的店點資料，無法寫備註。'); return; }
      const current = state.data.dropPoints.find(x=>x.id===sourceDpId)?.unloadNote || '';
      const note = prompt('卸貨備註（其他司機排到這個店也會看到，留空代表清除）：', current);
      if(note===null) return;
      try{ await saveUnloadNote(sourceDpId, note.trim()); refresh(); }
      catch(err){ alert(err.message); }
    };
  });
}
// 「拍照上傳」跟「上傳照片」兩顆按鈕共用同一套「填下一格」邏輯：一個
// 店點最多3格照片，第1格是主要送達證明照（決定這個點是否算已完成），
// 第2、3格是附加照片。不管是先按拍照還是先用相簿上傳、按第幾次，都是
// 「填下一個還空著的格子」，沒有「重新拍照＝覆蓋」這種概念了——按鈕
// 名稱/行為固定，同一顆「拍照上傳」按第一次拍主要照片，再按同一顆按
// 鈕拍第二、第三張，都是往後補上附加照片，直到補滿3格按鈕才會消失
// （見上面模板 photoCount<3 的判斷）。
async function fillNextPhotoSlot(aid, dpid, dataUrl, coords){
  // 重複照片偵測：同一張(或幾乎同一張)照片被送了兩次——例如相簿多選時
  // 不小心選到同一張、或網路重試時同一張被送了第二次——擋下來，不要讓
  // 同一個店點塞進兩張一樣的證明照。雜湊只存在這次畫面存活期間（不用
  // 跨登入階段記），夠用來擋這種短時間內的重複。
  const hash = quickImageHash(dataUrl);
  if(!state._recentPhotoHashes) state._recentPhotoHashes = new Set();
  if(state._recentPhotoHashes.has(hash)) throw new Error('偵測到重複照片，請重新拍攝或選擇不同照片。');
  const dp = state.data.assignments.find(x=>x.id===aid)?.dropPoints.find(x=>x.id===dpid);
  const kind = (dp && dp.status!=='completed') ? 'photo' : 'media';
  try{
    if(kind==='photo') await uploadDropPointPhoto(aid, dpid, dataUrl, coords);
    else await handleExtraMediaUpload(aid, dpid, [dataUrl]);
  }catch(err){
    // 網路真的不通才排進離線佇列——業務邏輯錯誤（RLS擋掉、資料不存在…）
    // 重試也不會成功，直接把原始錯誤丟回去讓夥伴知道，不要假裝排隊等好。
    if(!isNetworkError(err)) throw err;
    await queuePendingUpload({ kind, assignmentId:aid, dropPointId:dpid, dataUrl, coords: kind==='photo' ? coords : null });
    markDpOfflinePending(dpid);
    state._recentPhotoHashes.add(hash);
    await thumbsAdd(dpid, dataUrl);
    throw Object.assign(new Error('目前沒有網路，已將照片存在裝置上，恢復網路後會自動上傳。'), { queued:true });
  }
  state._recentPhotoHashes.add(hash);
  await thumbsAdd(dpid, dataUrl); // 上傳成功才存縮圖（只存本機，不佔流量）
}

// dpPhotoItems：跟 dpPhotoUrls 同一套順序／篩選條件，多附上每張照片對應的「怎麼刪」
// 資訊（主要照片 vs 附加照片的哪一筆），給「傳錯刪除」功能用；dpPhotoUrls 保留原本
// 只回傳網址的簽章，其他呼叫端（歷史任務、看圖彈窗預設行為）不用跟著改。
function dpPhotoItems(dp){
  const items = [];
  if(dp.photo) items.push({ url:dp.photo, kind:'main' });
  (dp.media||[]).filter(m=>m.type==='image' && m.url).forEach(m=> items.push({ url:m.url, kind:'media', mediaId:m.id }));
  return items;
}
function dpPhotoUrls(dp){
  return dpPhotoItems(dp).map(x=>x.url);
}
async function renderHistory(c){
  const dId = state.activeDriverId;
  // 夥伴自己的歷史任務想看多久以前都合理，而且夥伴端因為RLS本來就只看得到
  // 自己的任務（driver_select_own policy），不會因為系統整體規模（多少夥伴/
  // 多少店家）變大而跟著變重，所以這裡直接補到半年前，比預設的14天窗口寬
  // 很多，不受主控端那邊刻意縮小窗口的影響。
  // 只顯示「本月」已完成的紀錄：每月 1 號起，上個月以前的紀錄自動隱藏（各月份金額請看「我的報酬」）。
  const lookbackStart = todayStr().slice(0,7) + '-01';
  if(state.data.assignmentsWindowStart && lookbackStart < state.data.assignmentsWindowStart){
    c.innerHTML = '<h2 class="section-title">歷史任務</h2><div class="empty">載入中...</div>';
    try{ await ensureAssignmentsRange(lookbackStart); }
    catch(e){ c.innerHTML = `<h2 class="section-title">歷史任務</h2><div class="empty">載入失敗：${e.message}</div>`; return; }
    if(state.tab!=='history') return; // 使用者可能已經切走這一頁
  }
  const list = state.data.assignments.filter(a=>a.driverId===dId && a.status==='completed' && a.date>=lookbackStart).sort((a,b)=>b.date.localeCompare(a.date));
  const groups = {};
  list.forEach(a=>{ if(!groups[a.date]) groups[a.date] = []; groups[a.date].push(a); });
  const dateKeys = Object.keys(groups).sort((a,b)=>b.localeCompare(a));
  c.innerHTML = `
    <h2 class="section-title">歷史任務</h2>
    <p class="section-sub">本月已完成並封存的任務紀錄，不可再編輯。</p>
    ${(()=>{
      // 臨時支援別人的店點：只列有完成的，拆分金額是主控填的顯示用數字，不影響我的報酬。
      const sup = state.data.assignments.filter(a=>a.isSupport && a.date>=lookbackStart && a.dropPoints.some(d=>d.status==='completed')).sort((x,y)=>y.date.localeCompare(x.date));
      if(!sup.length) return '';
      return `<div class="panel"><h3 style="margin:0 0 6px;">支援紀錄（本月）</h3>${sup.map(a=>{
        const done = a.dropPoints.filter(d=>d.status==='completed').length;
        return `<div style="padding:6px 0; border-top:1px solid var(--border); font-size:13.5px;"><strong>${a.date.slice(5).replace('-','/')} ${routeName(a.routeId)}</strong><br><span style="color:var(--ink-soft); font-size:12.5px;">支援 ${escapeHtml(a.originalDriverName||'')} 的店點：完成 ${done}／${a.dropPoints.length}${a.supportAmount!=null?`　拆分金額 $${money(a.supportAmount)}（僅供參考）`:''}</span></div>`;
      }).join('')}</div>`;
    })()}
    ${dateKeys.map(date=>{
      const items = groups[date];
      return `<div class="date-group" data-key="${date}">
        <div class="date-head">
          <span>${date}</span>
          <span><span class="chevron">▸</span></span>
        </div>
        <div class="date-body">
          ${items.map(a=>`
            <div class="panel" style="margin-top:12px;">
              <div class="toolbar"><strong>${routeName(a.routeId)}</strong><span class="badge locked">已封存</span></div>
              <p style="font-size:12.5px; margin-bottom:4px;">任務起點：${a.origin||'—'}</p>
              <p style="margin:0 0 8px;"><strong>報酬：$${money(tripPay(a))}</strong>${Number(a.extraPay)?`<span style="font-size:12px; color:var(--ink-soft);">（車資 $${money(Number(a.payrollFareSnapshot ?? a.fare)||0)} ${Number(a.extraPay)>0?'+':'−'} 額外 $${money(Math.abs(Number(a.extraPay)))}）</span>`:''}</p>
              ${a.hasIssue ? `<div class="note" style="border-color:var(--danger); color:var(--danger);"><strong>回報異常：</strong>${escapeHtml(a.issueNote)}</div>` : ''}
              ${ownDropPoints(a).map(dp=>{
                const photoUrls = dpPhotoUrls(dp);
                const statusBadge = dp.status==='completed'
                  ? `<span class="badge completed"${photoUrls.length?' data-viewphoto style="cursor:pointer;"':''}>已完成${photoUrls.length?'・點擊看照片':''}</span>`
                  : `<span class="badge pending">未完成${dp.issueReason?'：'+dp.issueReason:''}</span>`;
                // 主控刪掉已封存任務的照片後，這一格的 issue_reason 會被設成固定提示字串
                // （見 deleteDropPointPhoto），這裡靠它判斷要不要重新長出拍照/上傳按鈕——
                // 其他原因關閉的未完成店點（夥伴自己選的理由）維持唯讀，不會多長按鈕出來。
                const reopened = dp.status!=='completed' && dp.issueReason===ADMIN_RESET_PHOTO_REASON;
                return `<div class="drop-point-driver" data-dpid="${dp.id}"><span class="store-name">${dpLabel(dp)}</span>（${channelName(dp.channelId)}） ${statusBadge}${!dp.photo && dp.photoCleared?'<br><span style="font-size:11.5px; color:var(--ink-soft);">照片已超過30天自動清除</span>':''}
                  ${reopened ? `<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
                    <button type="button" class="btn ghost" style="flex:1; min-width:110px; margin:0;" data-photo="${a.id}|${dp.id}">拍照上傳</button>
                    <input type="file" accept="image/*" capture="environment" data-photofallback="${a.id}|${dp.id}" style="display:none;">
                    <button type="button" class="btn ghost" style="flex:1; min-width:110px; margin:0;" data-photolib="${a.id}|${dp.id}">上傳照片</button>
                    <input type="file" accept="image/*" multiple data-photolibinput="${a.id}|${dp.id}" style="display:none;">
                  </div>` : ''}
                </div>`;
              }).join('')}
            </div>
          `).join('')}
        </div>
      </div>`;
    }).join('') || '<div class="empty">本月尚無已完成的歷史任務</div>'}
  `;
  c.querySelectorAll('.date-head').forEach(head=>{
    head.onclick = ()=> head.closest('.date-group').classList.toggle('open');
  });
  const dpById = {};
  const aByDpId = {};
  list.forEach(a=> a.dropPoints.forEach(dp=> { dpById[dp.id]=dp; aByDpId[dp.id]=a; }));
  // 跟「今天」畫面共用同一套控制項（拍照/上傳/刪除）：歷史任務預設還是唯讀
  // （沒有按鈕可以按），只有主控剛剛重置過的那一格才會真的用到拍照/上傳；
  // 看圖彈窗的刪除則是主控（state.role==='admin'）才會出現，夥伴自己看不到。
  wireStopPhotoControls(c, dpById, aByDpId);
}

let editingFuelClaimId = null;
function renderFuelPanel(){
  const box = document.getElementById('meFuel');
  if(!box) return;
  // 主控「檢視夥伴」模式只讀：看得到夥伴填的申報紀錄，但不能代填，也不能在這裡改／刪
  // （待確認的請到報酬結算處理）。
  const readOnly = state.role!=='driver' || !!state.adminViewDriver;
  const dId = state.activeDriverId;
  const claims = state.data.fuelClaims.filter(c=>c.driverId===dId);
  // 申報紀錄跟「查詢月份」連動：只列該月份（依發票日期）的，其他月份到該月份再看。
  const viewMonth = state._myEarningsMonth || todayStr().slice(0,7);
  const monthClaims = claims.filter(c=>c.date.startsWith(viewMonth));
  const editing = claims.find(c=>c.id===editingFuelClaimId && c.status==='pending');
  box.innerHTML = `
    <div class="panel">
      <h3 style="margin-top:0;">代墊費用申報（加油／車輛保養）</h3>
      ${readOnly ? '<p class="note" style="margin-top:0;">主控檢視中：夥伴本人登入後才能填寫申報；待確認的申報請到「報酬結算」確認。</p>' : `<p class="note" style="margin-top:0;">加油或車輛保養時，請把發票打上公司統編（${PAYROLL_PAYER_TAX_ID}），並填寫下面資料；主控核對發票後會列入代墊款。送出後在主控確認前還可以修改或刪除。</p>
      <button type="button" class="btn ghost" id="fcScan" style="margin-bottom:10px;">📷 掃描發票 QR Code 自動帶入</button>
      <div class="grid3">
        <div class="field"><label>類別</label><select id="fcCategory">${Object.entries(CLAIM_CATEGORY_LABEL).map(([k,v])=>`<option value="${k}" ${(editing?editing.category:'fuel')===k?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>日期</label><input id="fcDate" type="date" max="${todayStr()}" value="${editing?editing.date:todayStr()}"></div>
        <div class="field"><label>金額（元）</label><input id="fcAmount" type="number" inputmode="numeric" min="1" value="${editing?editing.amount:''}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>發票號碼</label><input id="fcInvoice" placeholder="AB12345678" maxlength="12" value="${editing?editing.invoiceNo:''}"></div>
        <div class="field"><label>備註（選填，例如保養項目）</label><input id="fcNote" maxlength="60" value="${editing?escapeHtml(editing.note):''}"></div>
      </div>
      <button class="btn amber" id="fcSubmit">${editing?'儲存修改':'送出申報'}</button>
      ${editing?'<button class="btn ghost" id="fcCancel">取消修改</button>':''}`}
      <h4 style="margin:${readOnly?'0':'16px'} 0 6px;">${readOnly?'申報紀錄':'我的申報紀錄'}（${viewMonth}）</h4>
      <table>
        <thead><tr><th>類別</th><th>日期</th><th>金額</th><th>發票號碼</th><th>備註</th><th>狀態</th><th></th></tr></thead>
        <tbody>${monthClaims.map(c=>`<tr>
          <td>${CLAIM_CATEGORY_LABEL[c.category]||'—'}</td><td>${c.date}</td><td class="amount">$${money(c.amount)}</td><td>${c.invoiceNo}</td><td>${escapeHtml(c.note)||'—'}</td>
          <td>${c.status==='confirmed'?'<span class="badge completed">已確認</span>':'<span class="badge pending">待確認</span>'}</td>
          <td>${!readOnly && c.status==='pending'?`<button class="btn ghost" data-fcedit="${c.id}">修改</button> <button class="btn danger" data-fcdel="${c.id}">刪除</button>`:''}</td>
        </tr>`).join('') || `<tr><td colspan="7"><div class="empty">${viewMonth} 尚無申報紀錄</div></td></tr>`}</tbody>
      </table>
    </div>`;
  if(readOnly) return;
  document.getElementById('fcScan').onclick = async ()=>{
    const r = await openInvoiceScanner();
    if(r.cancelled) return;
    if(r.fallback){ alert('這台裝置/瀏覽器沒辦法掃描，請直接手動輸入發票號碼跟金額。'); return; }
    document.getElementById('fcInvoice').value = r.invoiceNo;
    document.getElementById('fcAmount').value = r.amount;
    if(r.date) document.getElementById('fcDate').value = r.date;
    toast(`已掃描發票 ${r.invoiceNo}，${r.date||''} 金額 $${money(r.amount)}，請確認類別後送出`);
  };
  document.getElementById('fcSubmit').onclick = async ()=>{
    const input = { driverId:dId, category:document.getElementById('fcCategory').value, date:document.getElementById('fcDate').value, amount:document.getElementById('fcAmount').value, invoiceNo:document.getElementById('fcInvoice').value, note:document.getElementById('fcNote').value };
    try{
      if(editing) await updateFuelClaim(editing.id, input); else await createFuelClaim(input);
      editingFuelClaimId = null; renderFuelPanel();
    }catch(err){ alert(err.message); }
  };
  const cancel = document.getElementById('fcCancel');
  if(cancel) cancel.onclick = ()=>{ editingFuelClaimId = null; renderFuelPanel(); };
  box.querySelectorAll('[data-fcedit]').forEach(b=>{ b.onclick = ()=>{ editingFuelClaimId = b.dataset.fcedit; renderFuelPanel(); }; });
  box.querySelectorAll('[data-fcdel]').forEach(b=>{
    b.onclick = async ()=>{
      if(!confirm('確定要刪除這筆申報嗎？')) return;
      try{ await deleteFuelClaim(b.dataset.fcdel); if(editingFuelClaimId===b.dataset.fcdel) editingFuelClaimId=null; renderFuelPanel(); }
      catch(err){ alert(err.message); }
    };
  });
}
async function renderMyEarnings(c){
  const dId = state.activeDriverId;
  const monthStr = state._myEarningsMonth || todayStr().slice(0,7);
  c.innerHTML = `
    <h2 class="section-title">我的報酬</h2>
    <div id="meDeferred"></div>
    <div class="panel">
      <div class="field" style="max-width:200px;"><label>查詢月份</label>
        <select id="meMonth">${monthOptionsHtml(monthStr)}</select>
      </div>
    </div>
    <div id="meResult"><div class="empty">載入中...</div></div>
    <div id="meFuel"></div>
  `;
  renderFuelPanel();
  // 掛帳中的報酬（約好之後才付）：不分月份，夥伴隨時看得到「待領多少、預計哪天付」。
  fetchDeferredTrips(dId).then(trips=>{
    const box = document.getElementById('meDeferred');
    if(!box || !trips.length) return;
    box.innerHTML = groupDeferred(trips).map(g=>`<div class="panel" style="border-color:var(--amber); border-width:2px;">
      <div style="font-weight:600;">待領 <span class="amount">$${money(g.total)}</span>　預計 ${g.due} 支付</div>
      <div style="font-size:12.5px; color:var(--ink-soft); margin-top:2px;">工作日期 ${g.start===g.end?g.start:g.start+'～'+g.end}（${g.ids.length} 趟）${g.note?'・'+escapeHtml(g.note):''}　※ 金額為任務報酬，實際匯款金額以扣除預支、扣稅等為準。</div>
    </div>`).join('');
  }).catch(()=>{});
  document.getElementById('meMonth').onchange = (e)=>{ state._myEarningsMonth = e.target.value; renderFuelPanel(); refresh(); };
  // 跟報酬結算的作法一致：這個畫面只讀不寫，直接跟資料庫要選定月份的任務，
  // 不碰共用的 state.data.assignments，查哪個月份都一樣快，也不會讓共用陣列
  // 越查越大（夥伴身份本來就受RLS限制只看得到自己的任務，查6個月內任一個月
  // 都很輕量）。
  async function refresh(){
    const m = state._myEarningsMonth || monthStr;
    const resultEl = document.getElementById('meResult');
    resultEl.innerHTML = '<div class="empty">載入中...</div>';
    let monthAssignments;
    try{
      monthAssignments = await fetchAssignmentsInRange(m+'-01', monthEndStr(m));
      await ensureAdjustmentsRange(m+'-01'); await ensureFuelClaimsRange(m+'-01');
    }
    catch(err){ resultEl.innerHTML = `<div class="empty">載入失敗：${err.message}</div>`; return; }
    if(state.tab!=='my-earnings') return; // 使用者可能已經切走這一頁
    const r = driverMonthly(dId, m, monthAssignments);
    const driver = state.data.drivers.find(x=>x.id===dId);
    // 勞報單預覽跟扣稅/補充保費提醒：不能假設「整月合併開一張單」去試算扣稅
    // ——扣不扣稅要看主控實際拉出來開單的那段期間自己的金額夠不夠20000，不是
    // 行事曆月份累計（跟報酬結算頁同一套邏輯跟理由，見renderPayrollPage那邊的
    // 說明；2026-10-27跟會計確認過）。已經實際開出的區間／月結勞報單，各自
    // 依自己期間正確算過，直接採用其實領金額；還沒被任何勞報單涵蓋的部分，
    // 不假設扣稅，用原始金額顯示。
    const monthStart = m+'-01', monthEnd = monthEndStr(m);
    const coveringStatements = state.data.statements.filter(s=>{
      if(s.driverId!==dId) return false;
      const [a,b] = statementRange(s);
      return a<=monthEnd && b>=monthStart;
    });
    const documentedActual = coveringStatements.reduce((s,x)=>s+x.actualNet, 0);
    const documentedTax = coveringStatements.reduce((s,x)=>s+x.taxAmount, 0);
    const documentedNhi = coveringStatements.reduce((s,x)=>s+x.nhiAmount, 0);
    const isCovered = date => coveringStatements.some(s=>{ const [a,b]=statementRange(s); return date>=a && date<=b; });
    const undocTripTotal = r.trips.filter(a=>!isCovered(a.date)).reduce((s,a)=>s+tripPay(a), 0);
    const undocAdjustments = r.adjustments.filter(a=>!isCovered(adjustmentEffectiveDate(a)));
    const undocCalc = statementNetFromAdjustments(undocTripTotal, undocAdjustments);
    const statementCalc = statementNetFromAdjustments(r.tripTotal, r.adjustments);
    const previewR = { ...r, adjTotal:statementCalc.adjTotal, net:statementCalc.net };
    const ded = {
      incomeType: PAYROLL_INCOME_TYPE, withholdTax: documentedTax>0, taxRate: PAYROLL_TAX_RATE, taxAmount: documentedTax,
      withholdNhi: documentedNhi>0, nhiRate: PAYROLL_NHI_RATE, nhiAmount: documentedNhi,
      actualNet: documentedActual + undocCalc.net
    };
    let defTrips = [];
    try{ defTrips = await fetchDeferredTrips(dId); }catch(e){}
    const defSplit = deferredSplit(defTrips, m+'-01', monthEndStr(m));
    // 承接前幾個月還沒扣完的超支餘額（預支/區間勞報單先付超過當月賺的部分），不會自動消失，
    // 要繼續從這裡扣——見 index.html 的 computeCarryInMap() 旁的說明。
    let carryIn = 0;
    try{ carryIn = (await computeCarryInMap(m, [dId])).get(dId) || 0; }catch(e){}
    if(state.tab!=='my-earnings' || (state._myEarningsMonth||monthStr)!==m) return; // 使用者可能已經切走這一頁或換了月份
    const isCurrent = m===todayStr().slice(0,7);
    const netNow = r.net-(r.paid||0)+carryIn;
    const byDay = new Map(); r.trips.forEach(a=>byDay.set(a.date,(byDay.get(a.date)||0)+tripPay(a)));
    const dim = Number(monthEndStr(m).slice(8));
    const dayVals = Array.from({length:dim}, (_,i)=>[i+1, byDay.get(m+'-'+String(i+1).padStart(2,'0'))||0]);
    const dayMax = Math.max(1, ...dayVals.map(x=>x[1]));
    const paidAmt = Math.max(0, r.paid||0), unpaidAmt = Math.max(0, netNow);
    const payTotal = paidAmt + unpaidAmt;
    const hero = `<div class="earn-hero">
      <div class="eh-l">${isCurrent?'本月目前預估淨額':m+' 當月淨額'}</div>
      <div class="eh-n">$${money(netNow)}</div>
      <div class="eh-row"><span>已完成 ${r.trips.length} 趟</span><span>報酬 $${money(r.tripTotal)}</span>${r.adjTotal?`<span>調整 ${r.adjTotal>=0?'+':'−'}$${money(Math.abs(r.adjTotal))}</span>`:''}</div>
      ${paidAmt>0 ? `<div class="eh-pay"><i class="pd" style="width:${Math.round(paidAmt*100/payTotal)}%"></i><i class="up" style="width:${100-Math.round(paidAmt*100/payTotal)}%"></i></div>
        <div class="eh-leg"><span>🟩 已付 $${money(paidAmt)}</span><span>🟧 未付 $${money(unpaidAmt)}</span></div>` : ''}
      <div class="mini-bars" title="每日報酬">${dayVals.map(([d,v])=>`<div class="mb" title="${m}-${String(d).padStart(2,'0')}：$${money(v)}"><i class="${v?'':'z'}" style="height:${v?Math.max(4,Math.round(v*100/dayMax)):4}%"></i><span>${d%5===0||d===1?d:''}</span></div>`).join('')}</div>
    </div>`;
    // 扣不扣稅要看「主控實際開出的那張勞報單」自己的金額夠不夠NT$20,000起扣
    // 門檻，不是行事曆月份累計（已跟會計確認，2026-10-27）——所以這裡只在
    // 「這個月已經有實際開出的勞報單被扣了稅／補充保費」時才提醒，不會因為
    // 本月累計金額看起來快超過20000就提早誤報（分批小額開單、每張都沒過
    // 門檻的話，依規定本來就不扣）。⚠️ 門檻是否仍適用、要不要另外準備收據／
    // 憑證，請洽主控或會計師確認，這裡不是正式稅務建議。
    const nhiNotice = ded.withholdTax ? `<div class="note" style="border-color:var(--amber); color:#8A5A17; margin-bottom:10px;">⚠️ ${isCurrent?'本月':m}已有勞報單金額達 NT$${money(PAYROLL_WITHHOLD_THRESHOLD)}起扣門檻，依規定扣繳了 10% 所得稅＋2.11% 二代健保補充保費（下方「本月勞報單預覽」可以看到詳細金額）。</div>` : '';
    resultEl.innerHTML = nhiNotice + hero + `
      <div class="panel">
        <table>
          <tr><td>已完成任務數</td><td class="amount">${r.trips.length}</td></tr>
          <tr><td>報酬合計</td><td class="amount">$${money(r.tripTotal)}</td></tr>
          <tr><td>${m}調整項</td><td class="amount">${r.adjTotal>=0?'+':''}$${money(r.adjTotal)}</td></tr>
          ${r.reimbursement ? `<tr><td>　其中含代墊款（憑證開公司）</td><td class="amount">$${money(r.reimbursement)}</td></tr>` : ''}
          ${r.paid ? `<tr><td>已領現金／已付款</td><td class="amount">-$${money(r.paid)}</td></tr>` : ''}
          ${carryIn ? `<tr><td style="color:var(--danger);">承接前期超支餘額</td><td class="amount" style="color:var(--danger);">-$${money(Math.abs(carryIn))}</td></tr>` : ''}
          <tr><td><strong>${isCurrent?'目前預估淨額':'當月淨額'}</strong></td><td class="amount"><strong>$${money(netNow)}</strong></td></tr>
          ${defSplit.inRange.total ? `<tr><td>　其中已掛帳，預計 ${defSplit.inRange.dues.join('、')} 支付</td><td class="amount">$${money(defSplit.inRange.total)}</td></tr>` : ''}
          ${defSplit.other.total ? `<tr><td>加：其他月份掛帳待領（預計 ${defSplit.other.dues.join('、')} 支付）</td><td class="amount">+$${money(defSplit.other.total)}</td></tr>
          <tr><td><strong>應領合計（含掛帳）</strong></td><td class="amount"><strong>$${money(netNow+defSplit.other.total)}</strong></td></tr>` : ''}
        </table>
        ${(()=>{
          const groups = new Map();
          r.trips.filter(a=>(Number(a.paidAmount)||0)>0).forEach(a=>{
            const k = a.paidGroup || ('single-'+a.id);
            const g = groups.get(k) || { date:a.paidDate, method:a.paidMethod, ps:a.paidPeriodStart, pe:a.paidPeriodEnd, amount:0 };
            g.amount += Number(a.paidAmount)||0; groups.set(k, g);
          });
          if(!groups.size) return '';
          const monthStart = m+'-01', monthEnd = monthEndStr(m);
          return `<div style="margin:10px 0 0;"><div style="font-size:12.5px; font-weight:600; margin-bottom:4px;">已支付紀錄</div>${[...groups.values()].sort((x,y)=>(x.date||'').localeCompare(y.date||'')).map(g=>`<div style="font-size:12.5px; padding:2px 0;">✅ ${g.date||'—'} 以${g.method==='cash'?'現金':'轉帳'}支付${g.ps?`　區間 ${g.ps}～${g.pe}`:''}　<b>$${money(g.amount)}</b>${g.ps && (g.ps<monthStart || g.pe>monthEnd) ? '<span style="color:var(--ink-soft);">（本月部分）</span>' : ''}</div>`).join('')}</div>`;
        })()}
        ${r.reimbursement ? `<p class="note" style="margin:8px 0 0;">代墊款（例如油資）已包含在上面的報酬裡一起付給您，不屬於所得，勞報單的扣稅／補充保費只用「報酬 − 代墊款」計算，所以扣的稅會比較少。</p>` : ''}
      </div>
      <div class="panel">
        <h3 style="margin-top:0;">已完成任務</h3>
        <table>
          <thead><tr><th>日期</th><th>項目</th><th>報酬</th></tr></thead>
          <tbody>${r.trips.map(a=>`<tr><td>${a.date}</td><td>${routeName(a.routeId)}</td><td class="amount">$${money(tripPay(a))}</td></tr>`).join('') || `<tr><td colspan="3"><div class="empty">${m}尚無已完成任務</div></td></tr>`}</tbody>
        </table>
        ${(()=>{
          // 由加油／保養申報確認轉進來的代墊款，下方「申報紀錄」已經有（含日期、發票號碼、狀態），
          // 這裡不重複列；上面的金額表仍會計入。只剩預支、加減項與主控手動新增的代墊款。
          const claimAdjIds = new Set((state.data.fuelClaims||[]).filter(f=>f.adjustmentId).map(f=>f.adjustmentId));
          const shown = r.adjustments.filter(adj=>!claimAdjIds.has(adj.id));
          if(!shown.length) return '';
          return `
          <h3>${m}調整項明細</h3>
          <table>
            <thead><tr><th>項目</th><th>備註</th><th>金額</th></tr></thead>
            <tbody>${shown.map(adj=>`<tr><td>${adjTypeLabel(adj.type)}</td><td>${adj.note||'—'}</td><td class="amount">${adj.type==='reimbursement'?'':adj.type==='add'?'+':'-'}$${money(Math.abs(adj.amount))}</td></tr>`).join('')}</tbody>
          </table>
        `;
        })()}
      </div>
      <details class="fold-d" ${state._meSlipPreviewOpen?'open':''} ontoggle="state._meSlipPreviewOpen=this.open">
        <summary style="font-weight:600; padding:10px 0;">📝 ${m} 勞報單預覽<span style="font-weight:400; font-size:12px; color:var(--ink-soft);">　（需要時點開查看）</span></summary>
        <p class="note" style="margin-top:0;">依目前已完成任務與調整項即時算出，僅供參考；正式勞報單由主控完成月結確認後才會產生、開放回簽，內容與金額可能因後續調整而變動。</p>
        ${driver ? payrollSlipHtml(driver, m, previewR, ded, { v2:true, serviceName:driver.serviceName }) + payrollAttachmentHtml(driver, m, previewR) : ''}
      </details>`;
  }
  await refresh();
}
// ---------- 夥伴端：我的資料 ----------
// 2026-11-02使用者要求：夥伴填個資習慣不一，身分證有大小寫、銀行/分行有人填全名
// 有人漏打「銀行」「分行」兩字、帳號有人會加空格或「-」分隔——系統自動幫忙整理，
// 不用主控事後一個個手動改。銀行／分行自動補字排除「已知例外」（使用者確認：
// 「郵局」不是銀行，「營業部」不是分行，不能把這兩種硬補成「郵局銀行」「營業部分行」）。
function normalizeIdNumber(v){ return (v||'').trim().toUpperCase(); }
function normalizeBankName(v){
  v = (v||'').trim();
  if(!v || v.includes('銀行') || v.includes('郵局') || v.includes('農會') || v.includes('漁會') || v.includes('合作社')) return v;
  return v + '銀行';
}
function normalizeBranchName(v){
  v = (v||'').trim();
  if(!v || v.includes('分行') || v.includes('郵局') || v.endsWith('部')) return v;
  return v + '分行';
}
function normalizeAccountNumber(v){ return (v||'').trim().replace(/[\s-]/g, ''); }
function renderMyProfile(c){
  const dId = state.activeDriverId;
  const d = state.data.drivers.find(x=>x.id===dId);
  const isDriverOwn = state.role==='driver' && !state.adminViewDriver;
  const incomplete = isDriverOwn && !isDriverProfileRequiredComplete(d);
  c.innerHTML = `
    <h2 class="section-title">我的資料</h2>
    <p class="section-sub">修改後主控端會收到通知。姓名與狀態如需變更請聯絡主控。</p>
    ${incomplete ? `<div class="note" style="border-color:var(--amber); color:#8A5A17;">電話、身分證字號、銀行帳戶資訊為必填，請補齊並儲存後才能使用其他功能。</div>` : ''}
    <div class="panel">
      <div class="grid4">
        <div class="field"><label>電話 <span class="required-mark">*</span></label><input id="mpPhone" value="${escapeHtml(d.phone||'')}"></div>
        <div class="field"><label>身分證字號（可提供勞報人員） <span class="required-mark">*</span></label><input id="mpIdNumber" value="${escapeHtml(d.idNumber||'')}"></div>
        <div class="field"><label>車牌（選填）</label><input id="mpPlate" value="${escapeHtml(d.vehicle.plate||'')}"></div>
        <div class="field"><label>車型（選填）</label><input id="mpVType" value="${escapeHtml(d.vehicle.type||'')}"></div>
      </div>
      <div class="grid4">
        <div class="field"><label>銀行 <span class="required-mark">*</span></label><input id="mpBankName" value="${escapeHtml(d.bank.bankName||'')}"></div>
        <div class="field"><label>分行 <span class="required-mark">*</span></label><input id="mpBranch" value="${escapeHtml(d.bank.branch||'')}"></div>
        <div class="field"><label>帳號 <span class="required-mark">*</span></label><input id="mpAccount" value="${escapeHtml(d.bank.account||'')}"></div>
        <div class="field"><label>戶名 <span class="required-mark">*</span></label><input id="mpHolder" value="${escapeHtml(d.bank.holder||'')}"></div>
      </div>
      <button class="btn amber" id="mpSave">儲存修改</button>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">身分證正反面（勞報單用途）</h3>
      <p class="section-sub" style="margin-top:0;">拍攝或上傳身分證正面與反面，系統會自動合成一張圖片並加註浮水印，只有主控能查看，用於勞報單申報文件。</p>
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        ${d.idCardPath ? '<span class="badge completed">已上傳</span>' : '<span class="badge pending">尚未上傳</span>'}
        <button type="button" class="btn ${d.idCardPath?'ghost':'amber'}" id="mpIdCardBtn">${d.idCardPath?'重新拍攝':'拍攝身分證正反面'}</button>
        <button type="button" class="btn ghost" id="mpIdCardUpload">${d.idCardPath?'重新上傳照片':'上傳現有照片'}</button>
        ${d.idCardPath ? '<button type="button" class="btn ghost" id="mpIdCardView">查看我上傳的</button>' : ''}
      </div>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">字體大小</h3>
      <p class="section-sub" style="margin-top:0;">調整整個系統畫面文字的大小，只存在這台裝置上，換別的手機或瀏覽器要重新設定。</p>
      <div style="display:flex; gap:8px;" id="fsPicker">
        <button type="button" class="btn ghost" data-fs="small">小</button>
        <button type="button" class="btn ghost" data-fs="medium">中</button>
        <button type="button" class="btn ghost" data-fs="large">大</button>
      </div>
    </div>
    <div class="panel"><h3 style="margin-top:0;">通知設定</h3><div id="pushBox"><p class="section-sub" style="margin:0;">載入中…</p></div></div>
  `;
  pushRenderBox(document.getElementById('pushBox'));
  // 身分證字號：邊打邊轉大寫（單純轉大小寫不會打斷輸入）。銀行/分行/帳號：等離開
  // 欄位（blur）才整理——補字這種操作如果邊打邊做，打第一個字就會被硬插「銀行」
  // 兩字，反而讓人打不下去；存檔時也會再整理一次，防呆不漏掉用Enter送出的情況。
  const idEl = document.getElementById('mpIdNumber');
  idEl.oninput = ()=>{ const pos = idEl.selectionStart; idEl.value = normalizeIdNumber(idEl.value); try{ idEl.setSelectionRange(pos, pos); }catch(e){} };
  document.getElementById('mpBankName').onblur = e=>{ e.target.value = normalizeBankName(e.target.value); };
  document.getElementById('mpBranch').onblur = e=>{ e.target.value = normalizeBranchName(e.target.value); };
  document.getElementById('mpAccount').onblur = e=>{ e.target.value = normalizeAccountNumber(e.target.value); };
  document.getElementById('mpSave').onclick = async ()=>{
    const changes = [];
    const checks = [
      ['phone', d.phone, document.getElementById('mpPhone').value.trim(), '電話'],
      ['idNumber', d.idNumber, normalizeIdNumber(document.getElementById('mpIdNumber').value), '身分證字號'],
      ['vehicle.plate', d.vehicle.plate, document.getElementById('mpPlate').value.trim(), '車牌'],
      ['vehicle.type', d.vehicle.type, document.getElementById('mpVType').value.trim(), '車型'],
      ['bank.bankName', d.bank.bankName, normalizeBankName(document.getElementById('mpBankName').value), '銀行'],
      ['bank.branch', d.bank.branch, normalizeBranchName(document.getElementById('mpBranch').value), '分行'],
      ['bank.account', d.bank.account, normalizeAccountNumber(document.getElementById('mpAccount').value), '帳號'],
      ['bank.holder', d.bank.holder, document.getElementById('mpHolder').value.trim(), '戶名']
    ];
    checks.forEach(([field, oldVal, newVal, label])=>{ if((oldVal||'')!==newVal) changes.push(label); });
    if(!changes.length){ alert('沒有變更任何欄位'); return; }
    try{
      await updateDriverProfile(dId, {
        phone: document.getElementById('mpPhone').value.trim(),
        idNumber: normalizeIdNumber(document.getElementById('mpIdNumber').value),
        plate: document.getElementById('mpPlate').value.trim(),
        vtype: document.getElementById('mpVType').value.trim(),
        bankName: normalizeBankName(document.getElementById('mpBankName').value),
        branch: normalizeBranchName(document.getElementById('mpBranch').value),
        account: normalizeAccountNumber(document.getElementById('mpAccount').value),
        holder: document.getElementById('mpHolder').value.trim()
      });
      alert('已儲存。');
      renderNav(); renderContent();
    }catch(err){ alert(err.message); }
  };
  // 字體大小：存localStorage（本機裝置偏好，不是夥伴資料，不用上傳到資料庫），
  // 套用後整頁重繪，按鈕的選中樣式也會跟著新的字體大小一起重畫出來。
  const fsCurrent = localStorage.getItem('driverFontSize') || 'medium';
  document.querySelectorAll('#fsPicker [data-fs]').forEach(btn=>{
    if(btn.dataset.fs===fsCurrent) btn.classList.replace('ghost', 'amber');
    btn.onclick = ()=>{
      localStorage.setItem('driverFontSize', btn.dataset.fs);
      applyFontSizePref();
      renderContent();
    };
  });
  // 拍照／上傳現有照片兩個按鈕共用的收尾流程（取得裁切合成好的dataUrl後，上傳＋存路徑＋
  // 重新整理畫面），差別只在前面用哪個函式取得照片（captureIdCardPhoto跑相機、
  // uploadIdCardPhotos跑選檔案＋手動裁切）。
  // 網路上傳這一步（跟前面拍照/裁切分開處理）失敗時不直接放棄：手機網路不穩是常見的
  // 暫時性失敗，直接整個重來（兩張都要重拍/重選）很痛苦，所以失敗時問要不要重試，
  // 重試用的是同一張已經裁切合成好的dataUrl，不會遺失剛剛拍/選的內容。
  async function finishIdCardUpload(btn, grabPhoto){
    btn.disabled = true;
    const original = btn.textContent;
    let dataUrl;
    try{ dataUrl = await grabPhoto(); }
    catch(err){ alert(err.message); btn.disabled = false; return; }
    if(!dataUrl){ btn.disabled = false; return; }
    for(;;){
      btn.textContent = '上傳中…';
      try{
        const path = await uploadDriverIdCard(dId, dataUrl);
        await setDriverIdCardPath(dId, path);
        renderContent();
        return;
      }catch(err){
        if(!confirm(`上傳失敗：${err.message}\n\n要重試嗎？不用重新拍照/選照片，會直接用剛剛這張再試一次。`)){
          btn.disabled = false; btn.textContent = original; return;
        }
      }
    }
  }
  const idCardBtn = document.getElementById('mpIdCardBtn');
  if(idCardBtn) idCardBtn.onclick = ()=> finishIdCardUpload(idCardBtn, captureIdCardPhoto);
  const idCardUploadBtn = document.getElementById('mpIdCardUpload');
  if(idCardUploadBtn) idCardUploadBtn.onclick = ()=> finishIdCardUpload(idCardUploadBtn, uploadIdCardPhotos);
  const idCardViewBtn = document.getElementById('mpIdCardView');
  if(idCardViewBtn) idCardViewBtn.onclick = async ()=>{
    try{ openPhotoLightbox([await getDriverIdCardUrl(d.idCardPath)]); }
    catch(err){ alert(err.message); }
  };
}

// 簽名圖處理成「貼在勞報單簽章欄」的樣子：只留筆跡範圍（裁掉空白、留一點邊距）、背景透明、
// 縮到適合簽章欄的大小（最寬 640、最高 220，等比例），這樣貼上去不會太小、也不會超出欄位。
// 簽名板一律是橫向的畫布（直拿手機時畫面會旋轉成橫向，座標已經轉正），所以這裡不用再旋轉。
function buildSignatureForSlip(canvas){
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  let minX=w, minY=h, maxX=0, maxY=0, found=false;
  const data = ctx.getImageData(0,0,w,h).data;
  const step = 2; // 抽樣掃描加快速度，簽名筆畫夠粗不會因此漏掉範圍
  for(let y=0; y<h; y+=step){
    for(let x=0; x<w; x+=step){
      if(data[(y*w+x)*4+3] > 10){
        found = true;
        if(x<minX) minX=x; if(x>maxX) maxX=x;
        if(y<minY) minY=y; if(y>maxY) maxY=y;
      }
    }
  }
  if(!found) return canvas.toDataURL('image/png');
  const pad = 14;
  minX = Math.max(0, minX-pad); minY = Math.max(0, minY-pad);
  maxX = Math.min(w, maxX+pad); maxY = Math.min(h, maxY+pad);
  const cropW = maxX-minX, cropH = maxY-minY;
  const scale = Math.min(1, 640/cropW, 220/cropH);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cropW*scale));
  out.height = Math.max(1, Math.round(cropH*scale));
  out.getContext('2d').drawImage(canvas, minX, minY, cropW, cropH, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
// 滿版橫式簽名視窗：點「已確認報酬並簽名」才開，蓋滿整個螢幕、鎖住背景捲動。
// 手機如果是直的，簽名板會旋轉 90 度（請把手機橫過來握著簽；握反了按「翻轉」），手機本身已經是橫向就直接用；
// 筆跡座標一律換算回橫向畫布，所以存出來的簽名一定是正的橫式。簽完先預覽貼在勞報單簽章欄的樣子，再按「確認送出」。
function openSignatureModal(record){
  const host = document.getElementById('sigModalHost');
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let flip = false, drawing = false, hasSignature = false;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  host.innerHTML = `
    <div class="sig-full" id="sigFull">
      <div id="sigStage">
        <canvas id="sigPad"></canvas>
        <div class="sig-watermark">請簽名</div>
        <div id="sigHint" class="sig-hint"></div>
        <div class="sig-bar">
          <div class="sig-side">
            <button class="sig-clear-link" id="sigClear">清除重簽</button>
            <button class="sig-clear-link" id="sigFlip" style="display:none;">翻轉方向</button>
          </div>
          <div class="sig-side">
            <button class="sig-icon-btn cancel" id="sigCancel" title="取消">❌</button>
            <button class="sig-icon-btn confirm" id="sigConfirm" title="完成簽名">☑️</button>
          </div>
        </div>
      </div>
    </div>`;
  const full = document.getElementById('sigFull');
  const stage = document.getElementById('sigStage');
  const canvas = document.getElementById('sigPad');
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('sigHint');
  const flipBtn = document.getElementById('sigFlip');
  const DPR = 2;
  full.addEventListener('touchmove', e=>e.preventDefault(), { passive:false });
  // Android 可以真的全螢幕＋鎖橫向（iPhone 不支援，靠旋轉簽名板）；失敗就算了，不影響簽名。
  if(!isIOS){
    try{ const r = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if(r && r.then) r.then(()=>{ try{ screen.orientation.lock('landscape').catch(()=>{}); }catch(e){} }).catch(()=>{}); }catch(e){}
  }
  function layout(){
    const W = window.innerWidth, H = window.innerHeight;
    const rotated = H > W;
    const lw = rotated ? H : W, lh = rotated ? W : H; // 簽名板自己的（橫向）寬高
    stage.style.width = lw+'px'; stage.style.height = lh+'px';
    if(!rotated){ stage.style.left = '0px'; stage.style.top = '0px'; stage.style.transform = 'none'; }
    else if(!flip){ stage.style.left = W+'px'; stage.style.top = '0px'; stage.style.transform = 'rotate(90deg)'; }
    else { stage.style.left = '0px'; stage.style.top = H+'px'; stage.style.transform = 'rotate(-90deg)'; }
    flipBtn.style.display = rotated ? '' : 'none';
    hint.textContent = rotated ? '請把手機橫過來握著簽名（字是倒的就按「翻轉方向」）' : '';
    const prev = (canvas.width && hasSignature) ? canvas.toDataURL('image/png') : null;
    canvas.width = lw*DPR; canvas.height = lh*DPR;
    ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1B2129';
    if(prev){ const img = new Image(); img.onload = ()=> ctx.drawImage(img,0,0,canvas.width,canvas.height); img.src = prev; }
  }
  // 螢幕座標 → 簽名板（橫向）座標
  function pos(e){
    const W = window.innerWidth, H = window.innerHeight;
    let lx, ly;
    if(H <= W){ lx = e.clientX; ly = e.clientY; }
    else if(!flip){ lx = e.clientY; ly = W - e.clientX; }
    else { lx = H - e.clientY; ly = e.clientX; }
    return { x: lx*DPR, y: ly*DPR };
  }
  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);
  canvas.addEventListener('pointerdown', e=>{ drawing=true; hasSignature=true; const p=pos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+0.01,p.y); ctx.stroke(); });
  canvas.addEventListener('pointermove', e=>{ if(!drawing) return; const p=pos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); });
  window.addEventListener('pointerup', onUp);
  function onUp(){ drawing=false; }
  function close(){
    window.removeEventListener('resize', layout); window.removeEventListener('orientationchange', layout); window.removeEventListener('pointerup', onUp);
    document.body.style.overflow = prevOverflow;
    try{ if(document.fullscreenElement) document.exitFullscreen(); screen.orientation.unlock(); }catch(e){}
    host.innerHTML = '';
  }
  document.getElementById('sigClear').onclick = ()=>{ ctx.clearRect(0,0,canvas.width,canvas.height); hasSignature=false; };
  flipBtn.onclick = ()=>{ flip = !flip; layout(); };
  document.getElementById('sigCancel').onclick = close;
  document.getElementById('sigConfirm').onclick = ()=>{
    if(!hasSignature){ alert('請先簽名再送出'); return; }
    const sigUrl = buildSignatureForSlip(canvas);
    close();
    showSignaturePreview(record, sigUrl);
  };
}
// 簽完先預覽「貼在勞報單簽章欄」的樣子（跟勞報單用同樣的欄位與圖片大小限制），確認才送出，不滿意回去重簽。
function showSignaturePreview(record, sigUrl){
  const host = document.getElementById('sigModalHost');
  const payDate = record.payDate || (()=>{ const [y,m] = record.month.split('-').map(Number); const d = new Date(y, m, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-15`; })();
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  host.innerHTML = `
    <div class="sig-full" style="display:flex; align-items:center; justify-content:center; padding:16px; overflow:auto;">
      <div style="background:#fff; border-radius:12px; padding:16px; width:100%; max-width:560px; color:#1B2129;">
        <div style="font-weight:700; margin-bottom:6px;">請確認簽名（勞報單上的樣子）</div>
        <div style="font-size:12.5px; color:#5B6470; margin-bottom:8px;">${statementLabel(record)}　報酬總額 $${money(record.net)}　實領金額 $${money(record.actualNet)}</div>
        <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
          <tr style="border-top:1px solid #D8DADF; border-bottom:1px solid #D8DADF;">
            <td style="width:22%; padding:8px 6px;">所得人簽章</td>
            <td style="width:38%; padding:8px 6px; height:72px;"><img src="${sigUrl}" style="max-height:56px; max-width:100%;" loading="lazy"></td>
            <td style="width:18%; padding:8px 6px;">給付日期</td>
            <td style="padding:8px 6px;">${payDate}</td>
          </tr>
        </table>
        <div style="display:flex; gap:10px; margin-top:14px;">
          <button class="btn ghost" id="sigRedo" style="flex:1;">重簽</button>
          <button class="btn amber" id="sigSend" style="flex:2;">確認送出</button>
        </div>
        <button class="btn ghost" id="sigAbort" style="width:100%; margin-top:8px;">取消</button>
      </div>
    </div>`;
  const end = ()=>{ document.body.style.overflow = prevOverflow; host.innerHTML = ''; };
  document.getElementById('sigRedo').onclick = ()=>{ end(); openSignatureModal(record); };
  document.getElementById('sigAbort').onclick = end;
  document.getElementById('sigSend').onclick = async ()=>{
    const btn = document.getElementById('sigSend'); btn.disabled = true;
    try{ await signStatement(record.id, sigUrl); end(); renderContent(); }
    catch(err){ alert(err.message); btn.disabled = false; }
  };
}
function renderMyStatement(c){
  const dId = state.activeDriverId;
  const now = new Date(); let prevY=now.getFullYear(), prevM=now.getMonth();
  if(prevM===0){ prevM=12; prevY--; }
  const defaultMonth = `${prevY}-${pad(prevM)}`;
  const monthStr = state._myStatementMonth || defaultMonth;
  // 區間勞報單（主控依實際付款期間開的）：每一份獨立列出，點開簽名；月結勞報單照舊用月份選。
  const periodStmts = state.data.statements.filter(s=>s.driverId===dId && s.periodStart)
    .sort((a,b)=> b.periodEnd.localeCompare(a.periodEnd));
  const waiting = periodStmts.filter(s=>s.status==='awaiting_signature').length;
  c.innerHTML = `
    <h2 class="section-title">對帳單 / 勞報單</h2>
    <div class="panel no-print" style="position:sticky; top:0; z-index:20; box-shadow:0 2px 6px rgba(27,33,41,.12);"><div class="field" style="max-width:200px; margin-bottom:0;"><label>月份（月結勞報單）</label><input id="smMonth" type="month" value="${monthStr}"></div></div>
    ${periodStmts.length ? `<div class="panel">
      <h3 style="margin:0 0 6px;">每次付款的勞報單${waiting?`　<span class="badge progress">${waiting} 份待簽名</span>`:''}</h3>
      <table><thead><tr><th>期間</th><th>給付日期</th><th>實領金額</th><th>狀態</th><th></th></tr></thead>
      <tbody>${periodStmts.map(x=>`<tr><td>${statementLabel(x)}</td><td>${x.payDate||'—'}</td><td class="amount">$${money(x.actualNet)}</td><td>${x.status==='awaiting_signature'?'<span class="badge progress">待簽名</span>':x.status==='signed'?'<span class="badge signed">已簽（未鎖定）</span>':'<span class="badge signed">已鎖定</span>'}</td><td><button class="btn ${x.status==='awaiting_signature'?'amber':'ghost'}" data-openstmt="${x.id}">查看</button></td></tr>`).join('')}</tbody></table>
    </div>` : ''}
    <div id="statementBox"></div>`;
  let currentPeriodId = state._myStatementPeriodId || null;
  async function refresh(){
    const m = document.getElementById('smMonth').value;
    state._myStatementMonth = m;
    const periodRecord = currentPeriodId ? state.data.statements.find(s=>s.id===currentPeriodId && s.driverId===dId) : null;
    const record = periodRecord || state.data.statements.find(s=>s.driverId===dId && !s.periodStart && s.month===m);
    const box = document.getElementById('statementBox');

    if(!record){
      box.innerHTML = `<div class="panel"><div class="empty">${m} 尚未由主控端完成月結確認，結算完成後才能在這裡看到並回簽勞報單。</div></div>`;
      return;
    }
    const driver = state.data.drivers.find(d=>d.id===dId);
    const label = statementLabel(record);
    // 勞報單上的「共完成N趟」要以整個期間為準：state.data.assignments 預設只載入最近14天，
    // 所以跟報酬結算、我的報酬一樣，直接跟資料庫要這段期間的任務。
    box.innerHTML = '<div class="empty">載入中...</div>';
    let monthAssignments;
    const [rangeStart, rangeEnd] = statementRange(record);
    try{
      monthAssignments = await fetchAssignmentsInRange(rangeStart, rangeEnd);
      await ensureAdjustmentsRange(rangeStart); await ensureFuelClaimsRange(rangeStart);
    }
    catch(err){ box.innerHTML = `<div class="panel"><div class="empty">載入失敗：${err.message}</div></div>`; return; }
    if(document.getElementById('smMonth')?.value!==m) return; // 使用者可能已經改選別的月份
    if((state._myStatementPeriodId||null)!==currentPeriodId) return;
    const { slipHtml, attHtml } = buildSlipHtmls(driver, record, monthAssignments);
    const fileTag = `${driverName(dId)}_${label}_勞報單`;
    const backBtn = periodRecord ? `<div class="no-print" style="margin-bottom:8px;"><button class="btn ghost" id="backMonthly">← 回月結勞報單</button></div>` : '';
    const wireBack = ()=>{ const b=document.getElementById('backMonthly'); if(b) b.onclick=()=>{ currentPeriodId=null; state._myStatementPeriodId=null; refresh(); }; };
    if(record.status==='awaiting_signature'){
      box.innerHTML = `
        ${backBtn}
        <div id="payrollSlipArea">${slipHtml}${attHtml}</div>
        <div class="panel no-print">
          <button class="btn amber" id="ackPayBtn" style="width:100%;">已確認報酬並簽名</button>
        </div>
        <div id="sigModalHost"></div>`;
      wireBack();
      document.getElementById('ackPayBtn').onclick = ()=> openSignatureModal(record);
    } else if(record.status==='signed'){
      // 簽了名但還沒按「確認簽名」鎖定前，夥伴可以隨時重新簽名改掉。
      box.innerHTML = `
        ${backBtn}
        <div id="payrollSlipArea">${slipHtml}${attHtml}</div>
        <div class="note">請確認簽名清楚無誤。按下方「確認簽名」後就會鎖定，不能再修改（如果需要修改，要請主控端退回才能重簽）。</div>
        <div class="no-print" style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn ghost" id="printMy">列印/另存PDF</button>
          <button class="btn ghost" id="resignBtn">重新簽名</button>
          <button class="btn amber" id="confirmSignBtn">確認簽名（鎖定，不可再改）</button>
        </div>
        <div id="sigModalHost"></div>`;
      wireBack();
      document.getElementById('printMy').onclick = ()=> exportPayrollPortraitPdf([slipHtml, attHtml].filter(Boolean), fileTag);
      document.getElementById('resignBtn').onclick = ()=> openSignatureModal(record);
      document.getElementById('confirmSignBtn').onclick = async ()=>{
        if(!confirm('確認簽名後就不能再修改，需要主控退回才能重簽，確定要鎖定嗎？')) return;
        try{ await confirmSignature(record.id); renderContent(); }
        catch(err){ alert(err.message); }
      };
    } else if(record.status==='confirmed'){
      // 已鎖定，只能列印，不能再重新簽名。
      box.innerHTML = `
        ${backBtn}
        <div id="payrollSlipArea">${slipHtml}${attHtml}</div>
        <div class="no-print" style="margin-top:10px;">
          <button class="btn ghost" id="printMy">列印/另存PDF</button>
        </div>`;
      wireBack();
      document.getElementById('printMy').onclick = ()=> exportPayrollPortraitPdf([slipHtml, attHtml].filter(Boolean), fileTag);
    }
  }
  c.querySelectorAll('[data-openstmt]').forEach(btn=>{
    btn.onclick = ()=>{ currentPeriodId = btn.dataset.openstmt; state._myStatementPeriodId = currentPeriodId; refresh(); window.scrollTo({top:0}); };
  });
  document.getElementById('smMonth').onchange = ()=>{ currentPeriodId=null; state._myStatementPeriodId=null; refresh(); };
  refresh();
}
