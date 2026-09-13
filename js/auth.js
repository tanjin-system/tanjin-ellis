// 登入流程：呼叫 Vercel Serverless Function（/api/auth-*）驗證 PIN／代碼（後端用 service role key 比對，
// 前端完全看不到 admin_pin / access_code 本人），成功後拿到自訂 JWT 存進 localStorage，
// 之後 getSupabase() 每個請求都會帶上這個 token。
// UX 跟 demo 完全一樣：主控輸PIN、司機輸4碼代碼，只是驗證的地方換到後端。

const AUTH_STORAGE_KEY = 'fleet_auth_token';
const AUTH_ROLE_KEY = 'fleet_auth_role';
const AUTH_DRIVER_KEY = 'fleet_auth_driver';

function getStoredAuth() {
  const token = localStorage.getItem(AUTH_STORAGE_KEY);
  const role = localStorage.getItem(AUTH_ROLE_KEY);
  const driver = localStorage.getItem(AUTH_DRIVER_KEY);
  if (!token || !role) return null;
  return { token, role, driver: driver ? JSON.parse(driver) : null };
}

function clearAuth() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(AUTH_ROLE_KEY);
  localStorage.removeItem(AUTH_DRIVER_KEY);
}

async function loginAsAdmin(pin) {
  const res = await fetch('/api/auth-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || '登入失敗');
  localStorage.setItem(AUTH_STORAGE_KEY, body.token);
  localStorage.setItem(AUTH_ROLE_KEY, 'admin');
  localStorage.removeItem(AUTH_DRIVER_KEY);
  return body;
}

async function loginAsDriver(code) {
  const res = await fetch('/api/auth-driver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || '登入失敗');
  localStorage.setItem(AUTH_STORAGE_KEY, body.token);
  localStorage.setItem(AUTH_ROLE_KEY, 'driver');
  localStorage.setItem(AUTH_DRIVER_KEY, JSON.stringify(body.driver));
  return body;
}

// 渲染登入畫面到 #loginGate；跟 demo 的登入畫面配置相同（主控PIN / 司機代碼 兩種入口）。
// 每次呼叫都要重新把 #loginGate 顯示出來、把 #appLayout 藏起來——不然像「登出後
// 想切換身份」這種情境，畫面會卡在上一個已登入的主控/司機畫面上，看不到登入表單。
function renderLoginGate(message) {
  const appLayout = document.getElementById('appLayout');
  if (appLayout) appLayout.style.display = 'none';
  const gate = document.getElementById('loginGate');
  gate.style.display = 'block';
  gate.innerHTML = `
    <h2 class="section-title">登入</h2>
    <p class="section-sub">選擇身份並輸入代碼</p>
    <div class="field">
      <label>身份</label>
      <select id="loginRole">
        <option value="driver">司機帳號</option>
        <option value="admin">主控帳號</option>
      </select>
    </div>
    <div class="field">
      <label id="loginCodeLabel">登入代碼（4碼）</label>
      <input id="loginCode" inputmode="numeric" maxlength="8">
    </div>
    <div id="loginError" style="color:var(--danger); font-size:12.5px; margin-bottom:8px; display:none;"></div>
    <button class="btn amber" id="loginSubmit" style="width:100%;">登入</button>
    <div id="forgotCodeWrap" style="text-align:center; margin-top:10px;">
      <a href="javascript:void(0)" id="forgotCodeLink" style="font-size:12.5px; color:var(--ink-soft);">忘記登入代碼？</a>
    </div>
    <div id="forgotCodeNote" style="display:none; font-size:12.5px; color:var(--ink-soft); margin-top:8px; text-align:center;">
      請聯絡主控管理員，由主控重新產生一組新代碼給您；拿到新代碼登入後，系統會請您自行設定一組新的登入代碼。
    </div>
  `;
  const roleSel = document.getElementById('loginRole');
  const codeLabel = document.getElementById('loginCodeLabel');
  const codeInput = document.getElementById('loginCode');
  const errEl = document.getElementById('loginError');
  const forgotWrap = document.getElementById('forgotCodeWrap');
  const forgotNote = document.getElementById('forgotCodeNote');
  if (message) { errEl.textContent = message; errEl.style.display = 'block'; }
  const applyRoleInputMode = () => {
    forgotNote.style.display = 'none';
    if (roleSel.value === 'admin') {
      codeLabel.textContent = '主控PIN碼';
      codeInput.removeAttribute('inputmode');
      codeInput.removeAttribute('maxlength');
      forgotWrap.style.display = 'none';
    } else {
      codeLabel.textContent = '登入代碼（4碼）';
      codeInput.setAttribute('inputmode', 'numeric');
      codeInput.setAttribute('maxlength', '8');
      forgotWrap.style.display = 'block';
    }
  };
  roleSel.onchange = applyRoleInputMode;
  document.getElementById('forgotCodeLink').onclick = () => {
    forgotNote.style.display = 'block';
  };
  document.getElementById('loginSubmit').onclick = async () => {
    const role = roleSel.value;
    const code = document.getElementById('loginCode').value.trim();
    errEl.style.display = 'none';
    if (!code) return;
    try {
      if (role === 'admin') await loginAsAdmin(code);
      else await loginAsDriver(code);
      await bootApp();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  };
}

// 司機首次登入(或主控重新產生代碼後)強制要求自訂新代碼的畫面，蓋在 #loginGate 上——
// 跟 renderLoginGate 一樣先把 #appLayout 藏起來，這樣司機在設定新代碼前完全碰不到
// 系統其他任何畫面。設定成功後直接呼叫 bootApp() 重新走一次開機流程進正式畫面。
function renderForceCodeResetGate(driverId, driverName) {
  const appLayout = document.getElementById('appLayout');
  if (appLayout) appLayout.style.display = 'none';
  const gate = document.getElementById('loginGate');
  gate.style.display = 'block';
  gate.innerHTML = `
    <h2 class="section-title">設定新的登入代碼</h2>
    <p class="section-sub">${driverName ? driverName + '，' : ''}為了帳號安全，首次登入（或代碼被主控重設後）需要自訂一組新的登入代碼才能繼續使用。</p>
    <div class="field"><label>新登入代碼</label><input id="newCode1" inputmode="numeric" maxlength="8"></div>
    <div class="field"><label>再輸入一次確認</label><input id="newCode2" inputmode="numeric" maxlength="8"></div>
    <div id="resetCodeError" style="color:var(--danger); font-size:12.5px; margin-bottom:8px; display:none;"></div>
    <button class="btn amber" id="resetCodeSubmit" style="width:100%;">設定並登入</button>
  `;
  const errEl = document.getElementById('resetCodeError');
  document.getElementById('resetCodeSubmit').onclick = async () => {
    const c1 = document.getElementById('newCode1').value.trim();
    const c2 = document.getElementById('newCode2').value.trim();
    errEl.style.display = 'none';
    if (!c1) { errEl.textContent = '請輸入新代碼'; errEl.style.display = 'block'; return; }
    if (c1 !== c2) { errEl.textContent = '兩次輸入的代碼不一致'; errEl.style.display = 'block'; return; }
    try {
      await changeMyAccessCode(driverId, c1);
      await bootApp();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  };
}
