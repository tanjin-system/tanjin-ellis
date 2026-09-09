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
function renderLoginGate() {
  const gate = document.getElementById('loginGate');
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
  `;
  const roleSel = document.getElementById('loginRole');
  const codeLabel = document.getElementById('loginCodeLabel');
  roleSel.onchange = () => {
    codeLabel.textContent = roleSel.value === 'admin' ? '主控PIN碼' : '登入代碼（4碼）';
  };
  document.getElementById('loginSubmit').onclick = async () => {
    const role = roleSel.value;
    const code = document.getElementById('loginCode').value.trim();
    const errEl = document.getElementById('loginError');
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
