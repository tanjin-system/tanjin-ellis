// 建立 Supabase client；每個請求都帶上登入時拿到的自訂 JWT（見 auth.js），
// PostgREST 會依 JWT 的 role claim 自動切換成 app_admin / app_driver 身份。
//
// anon key 本來就是設計給前端公開使用的值（沒有它 RLS 什麼都做不了），
// 部署前把下面兩個值換成你 Supabase 專案 API 頁面顯示的 Project URL / anon public key。
// 因為這個專案刻意不做建置步驟（維持demo原本單檔可直接打開的風格），沒有.env注入機制，
// 所以是直接寫死在這個檔案裡，不是機密值，可以安心提交進版本控制。
const SUPABASE_URL = 'https://iqmlglpaxecqhssgghqj.supabase.co;
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxbWxnbHBheGVjcWhzc2dnaHFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5ODc0NDksImV4cCI6MjA4NjU2MzQ0OX0.4x8Z9jW6h7K3m5L2v1N0x9J8h7G6f5D4s3A2q1W0e9Q';

let supabaseClient = null;

function getSupabase() {
  const token = localStorage.getItem('fleet_auth_token');
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : {}
  });
  return supabaseClient;
}
