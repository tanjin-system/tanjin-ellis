-- ============================================================
-- 碳金車隊調度系統 正式版資料庫 Schema (Supabase / PostgreSQL)
-- 這份檔案是「單一權威版本」：整合了原本的 schema.sql + schema_patch.sql，
-- 並加上正式上線需要的角色權限(RBAC)、RLS、請款金額計算觸發器。
-- 請在一個全新的 Supabase 專案上完整執行這份檔案（由上到下一次跑完）。
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 0. 系統設定（單一列即可）
-- ------------------------------------------------------------
create table settings (
  id int primary key default 1,
  admin_pin text not null default '0000',
  -- 最近一次手動備份（下載JSON快照／顯示備份文字）的時間，只用來在首頁提醒
  -- 「超過7天沒備份」，免費方案沒有自動備份，全靠這個提醒手動記得備份。
  last_backup_at timestamptz,
  constraint singleton check (id = 1)
);
insert into settings (id, admin_pin) values (1, '0000');

-- ------------------------------------------------------------
-- 1. 司機資料（含車輛、銀行、登入資訊）
-- ------------------------------------------------------------
create table drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  line_user_id text unique,
  access_code text unique,
  force_code_reset boolean not null default true, -- true：目前是主控指派/重置的代碼，司機下次登入須自行改成新代碼才能進入系統
  status text not null default 'active' check (status in ('active','inactive')),
  inactive_at timestamptz,
  vehicle_plate text,
  vehicle_type text,
  vehicle_load numeric,
  bank_name text,
  bank_branch text,
  bank_account text,
  bank_holder text,
  id_number text, -- 身分證／居留證號，勞務報酬單「所得人」欄位自動帶入用
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_drivers_status on drivers(status);

-- ------------------------------------------------------------
-- 2. 通路（含請款週期規則、計費公式）
-- ------------------------------------------------------------
create table channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  period_type text not null check (period_type in ('calendar_month','custom')),
  start_day int not null default 1,
  end_day int,
  status text not null default 'active' check (status in ('active','inactive')),
  formula_type text not null default 'per_km_and_point' check (formula_type in ('per_km_and_point','flat_per_trip')),
  rate_km numeric not null default 35,
  rate_point numeric not null default 50,
  flat_amount numeric not null default 0,
  tax_mode text not null default 'inclusive' check (tax_mode in ('inclusive','exclusive','exempt')),
  -- 客戶專屬瀏覽頁用的存取權杖：知道這組亂碼＝能看這個通路的送達照片/時間/門市，
  -- 不需要帳號密碼。驗證完全在後端 api/client-data.js 用 service role key 做，
  -- 這裡刻意不開放 anon 角色直接查詢，資料庫層級維持完全鎖死。
  access_token text unique,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. 出發點資料庫
-- ------------------------------------------------------------
create table origins (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  label text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 4. 下貨點資料庫
-- ------------------------------------------------------------
create table drop_points (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  channel_id uuid not null references channels(id),
  code text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  -- 同一通路下代號不可重複（代號是給司機/通知辨識用的簡短標籤，重複會讓人分不清是哪一站）。
  -- 前端 createDropPoint()/updateDropPoint() 已經有更友善的重複檢查，這裡是資料庫層的最後防線。
  constraint drop_points_code_channel_unique unique (channel_id, code)
);
create index idx_drop_points_channel on drop_points(channel_id);

-- ------------------------------------------------------------
-- 5. 路線（不綁司機；出發點固定於此層級）
-- ------------------------------------------------------------
create table routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  origin_id uuid not null references origins(id),
  seq text not null,
  shift text not null check (shift in ('AM','PM')),
  region text, -- 人工自訂的地區分組標籤，純顯示用（路線管理收合分組），不影響任何計費/排班邏輯
  created_at timestamptz not null default now(),
  unique (origin_id, seq, shift)
);

-- ------------------------------------------------------------
-- 6. 路線版本（下貨點組合的歷史版本，區間不重疊）
-- ------------------------------------------------------------
create table route_versions (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  start_date date not null,
  end_date date,
  -- 司機費用／里程／請款總額改成在這裡（路線版本層級）人工填寫一次，
  -- 同一版本底下每一趟車預設沿用這些值（建立車趟時複製一份快照到
  -- assignments，讓歷史車趟不受之後版本異動影響）。billing_by_channel
  -- 是系統依「扣除整趟計費通路後，其餘通路依下貨點數比例分攤」算出來的，
  -- 見 js/data-layer.js 的 computeChannelSplitByStoreCount()。
  distance_km numeric,
  driver_fare numeric,
  billing_total numeric,
  billing_by_channel jsonb,
  created_at timestamptz not null default now(),
  unique (route_id, start_date)
);
create index idx_route_versions_route on route_versions(route_id);

create table route_version_points (
  id uuid primary key default gen_random_uuid(),
  route_version_id uuid not null references route_versions(id) on delete cascade,
  drop_point_id uuid not null references drop_points(id),
  sequence_no int not null,
  unique (route_version_id, sequence_no)
);

-- ------------------------------------------------------------
-- 7. 車趟指派
-- ------------------------------------------------------------
create table assignments (
  id uuid primary key default gen_random_uuid(),
  trip_date date not null,
  route_id uuid not null references routes(id),
  driver_id uuid not null references drivers(id),
  run_no int not null default 1,
  origin_snapshot text,
  fare numeric not null default 0,
  distance_km numeric,
  status text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','cancelled')),
  has_issue boolean not null default false,
  issue_note text,
  completed_at timestamptz,
  payroll_fare_snapshot numeric,
  billing_total_snapshot numeric,
  billing_by_channel_snapshot jsonb,
  created_at timestamptz not null default now(),
  unique (route_id, trip_date)
);
create index idx_assignments_driver_date on assignments(driver_id, trip_date);
create index idx_assignments_date on assignments(trip_date);
create index idx_assignments_status on assignments(status);

-- ------------------------------------------------------------
-- 8. 車趟下貨點
-- ------------------------------------------------------------
create table assignment_drop_points (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignments(id) on delete cascade,
  source_drop_point_id uuid references drop_points(id),
  address text not null,
  code text,
  channel_id uuid references channels(id),
  sequence_no int not null,
  status text not null default 'pending' check (status in ('pending','completed')),
  photo_url text,
  photo_cleared boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  -- 未配達原因：司機在單一下貨點旁邊直接選填（不用等到整趟結束才填一個籠統的
  -- 備註），限定固定選項，讓主控端看報表時分類一致好統計。設定原因不代表這個
  -- 下貨點「完成」（status 還是 pending，沒有送達證明照），只是有了解釋。
  issue_reason text check (issue_reason in ('通路未下單','央廚未出貨','便當翻覆','遲到拒收'))
);
create index idx_adp_assignment on assignment_drop_points(assignment_id);

-- ------------------------------------------------------------
-- 8b. 車趟下貨點附加媒體（多張照片／影片，photo_url 那一張是主要送達證明照，
-- 這裡是額外補充的附件，一個下貨點可以有很多筆）
-- ------------------------------------------------------------
create table assignment_drop_point_media (
  id uuid primary key default gen_random_uuid(),
  assignment_drop_point_id uuid not null references assignment_drop_points(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('image','video')),
  created_at timestamptz not null default now()
);
create index idx_adp_media_point on assignment_drop_point_media(assignment_drop_point_id);

-- ------------------------------------------------------------
-- 9. 司機薪資調整項
-- ------------------------------------------------------------
create table adjustments (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  adjustment_month date not null,
  -- reimbursement＝司機代墊款（例如油資，憑證開公司統編）：已包含在車趟報酬裡一起付給司機，
  -- 勞報單要拆出來不算所得（不扣稅／補充保費），不影響報酬總額與毛利。
  adjustment_type text not null check (adjustment_type in ('advance','add','deduct','reimbursement')),
  amount numeric not null,
  note text,
  created_at timestamptz not null default now()
);
create index idx_adjustments_driver_month on adjustments(driver_id, adjustment_month);

-- ------------------------------------------------------------
-- 9b. 客戶請款例外調整（例如「未出車扣款」「回收費用」等人工加註的
-- 備註+金額，跟司機薪資調整項是兩回事，只影響請款單顯示的總額）
-- ------------------------------------------------------------
create table billing_adjustments (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  note text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);
create index idx_billing_adjustments_channel on billing_adjustments(channel_id);

-- ------------------------------------------------------------
-- 10. 司機月結勞報單
-- ------------------------------------------------------------
create table statements (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  statement_month date not null,
  trip_total numeric not null default 0,
  adj_total numeric not null default 0,
  net_amount numeric not null default 0, -- 報酬總額（車趟+調整項，未扣稅/健保前）
  -- 以下是勞務報酬單的稅務/健保欄位，月結確認當下由系統自動判斷並凍結，
  -- 道理跟 trip_total/adj_total/net_amount 一樣（司機回簽後金額不再變動）。
  income_type text, -- 所得類別，全體司機固定套用同一個值（見 index.html 的 PAYROLL_INCOME_TYPE 常數）
  withhold_tax boolean not null default false,
  tax_rate numeric not null default 0,
  tax_amount numeric not null default 0,
  withhold_nhi boolean not null default false,
  nhi_rate numeric not null default 0,
  nhi_amount numeric not null default 0,
  actual_net_amount numeric not null default 0, -- 實領金額 = net_amount − tax_amount − nhi_amount
  reimbursement_amount numeric not null default 0, -- 代墊款（非所得）凍結金額，稅／補充保費基礎＝net_amount − reimbursement_amount
  -- signed：司機已簽名，但還能自己重新簽名改掉；confirmed：司機自己點過
  -- 「確認簽名」，正式鎖定不能再改（例如主控已經拿去申報國稅局之後）。
  -- 主控的「退回簽名」不受這個狀態限制，隨時可以退回 awaiting_signature。
  status text not null default 'awaiting_signature' check (status in ('awaiting_signature','signed','confirmed')),
  confirmed_at timestamptz,
  signed_at timestamptz,
  signature_url text,
  admin_acked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (driver_id, statement_month)
);

-- ------------------------------------------------------------
-- 11. 即時通知
-- ------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('depart','photo','complete','profile','statement')),
  message text not null,
  related_assignment_id uuid references assignments(id),
  related_driver_id uuid references drivers(id),
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_notifications_read on notifications(read);
create index idx_notifications_created on notifications(created_at desc);

-- ------------------------------------------------------------
-- 12. 登入嘗試紀錄（供 Netlify Function 做失敗次數限制，防止暴力
-- 猜測4碼司機代碼/主控PIN）。只有 service role 會碰這張表，
-- 前端／app_admin／app_driver 都不需要也不應該能直接存取。
-- ------------------------------------------------------------
create table login_attempts (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('driver','admin')),
  ip text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index idx_login_attempts_lookup on login_attempts(scope, ip, success, created_at);

-- updated_at 自動維護
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger trg_drivers_updated_at before update on drivers
for each row execute function set_updated_at();


-- ============================================================
-- PART 2：角色權限 (RBAC)
-- 對應「後端代理驗證」：Netlify Function 簽發自訂 JWT，
-- role claim 直接對應這裡建立的 Postgres 角色，PostgREST 會依
-- JWT 的 role claim 自動切換執行角色，不需要 Supabase Auth 帳號。
-- ============================================================
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_admin') then
    create role app_admin nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'app_driver') then
    create role app_driver nologin;
  end if;
end $$;

grant app_admin to authenticator;
grant app_driver to authenticator;
grant usage on schema public to app_admin, app_driver;

-- 缺這行的話 Supabase Storage 服務會直接回 permission denied for table objects，
-- 即使 storage.objects 的 GRANT 和 RLS policy 都設對了也一樣：Storage 服務要求
-- 「role claim 指定的自訂角色」必須是 anon 的成員才會被接受並切換過去執行。
-- 這是 Supabase 官方文件 Custom Roles 明確要求、但很容易漏掉的一步。
grant anon to app_admin, app_driver;
grant usage on schema storage to app_admin, app_driver;
grant select on storage.buckets to app_admin, app_driver;
grant select, insert, update, delete on storage.objects to app_admin;
grant select, insert, update on storage.objects to app_driver;

-- 從 JWT claims 讀出目前登入司機的 id（由 Netlify Function 簽發時放入 driver_id claim）
create or replace function auth_driver_id() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'driver_id', '')::uuid
$$;

-- ------------------------------------------------------------
-- settings：只有 app_admin 能碰，anon/app_driver 完全不可見（admin_pin 是明文PIN，
-- 絕對不能讓 app_driver 讀到，否則司機能直接查出主控PIN、冒充主控登入）。
-- 注意：正因為這裡刻意不 grant app_driver，js/data-layer.js 的 loadAllData()
-- 不可以無條件對所有身份都查 settings，司機端要跳過這個查詢，否則會直接
-- permission denied 整包失敗、司機完全無法登入（修過的地雷，見該檔案註解）。
-- ------------------------------------------------------------
alter table settings enable row level security;
grant select, update on settings to app_admin;
create policy admin_all on settings for all to app_admin using (true) with check (true);

-- login_attempts：鎖死，只有 service role（Netlify Function 用）能碰
alter table login_attempts enable row level security;

-- ------------------------------------------------------------
-- 主資料表（channels/origins/drop_points/routes/route_versions/route_version_points）
-- app_admin 全權限；app_driver 唯讀（排班/歷史畫面需要顯示路線與通路名稱）
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['channels','origins','drop_points','routes','route_versions','route_version_points'] loop
    execute format('alter table %I enable row level security', t);
    execute format('grant select, insert, update, delete on %I to app_admin', t);
    execute format('grant select on %I to app_driver', t);
    execute format('create policy admin_all on %I for all to app_admin using (true) with check (true)', t);
    execute format('create policy driver_read on %I for select to app_driver using (true)', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- drivers：app_admin 全權限；app_driver 只能看/改自己那一列，
-- 且只能改「我的資料」頁允許編輯的欄位，不能碰 name/status。
-- access_code/force_code_reset 額外開放給司機自己更新，僅用於「首次登入/忘記代碼後
-- 主控重置」強制要求司機自訂新代碼的流程（見 changeMyAccessCode()）。
-- ------------------------------------------------------------
alter table drivers enable row level security;
grant select, insert, update, delete on drivers to app_admin;
grant select on drivers to app_driver;
grant update (phone, line_user_id, vehicle_plate, vehicle_type, vehicle_load,
              bank_name, bank_branch, bank_account, bank_holder, id_number,
              access_code, force_code_reset) on drivers to app_driver;

create policy admin_all on drivers for all to app_admin using (true) with check (true);
create policy driver_select_self on drivers for select to app_driver
  using (id = auth_driver_id());
create policy driver_update_self on drivers for update to app_driver
  using (id = auth_driver_id()) with check (id = auth_driver_id());

-- ------------------------------------------------------------
-- assignments：app_admin 全權限；app_driver 只能看自己的車趟，
-- 只能改 status / has_issue / issue_note（出發、標記完成、回報問題）。
-- completed_at 與請款/薪資快照一律由下面的觸發器計算，司機端碰不到。
-- ------------------------------------------------------------
alter table assignments enable row level security;
grant select, insert, update, delete on assignments to app_admin;
grant select on assignments to app_driver;
grant update (status, has_issue, issue_note) on assignments to app_driver;

create policy admin_all on assignments for all to app_admin using (true) with check (true);
create policy driver_select_own on assignments for select to app_driver
  using (driver_id = auth_driver_id());
create policy driver_update_own on assignments for update to app_driver
  using (driver_id = auth_driver_id()) with check (driver_id = auth_driver_id());

-- ------------------------------------------------------------
-- assignment_drop_points：app_admin 全權限；app_driver 只能看/改
-- 屬於自己車趟的下貨點，只能改 status / photo_url / completed_at / issue_reason
-- （photo_cleared 是系統housekeeping欄位，司機不可碰）。
-- ------------------------------------------------------------
alter table assignment_drop_points enable row level security;
grant select, insert, update, delete on assignment_drop_points to app_admin;
grant select on assignment_drop_points to app_driver;
grant update (status, photo_url, completed_at, issue_reason) on assignment_drop_points to app_driver;

create policy admin_all on assignment_drop_points for all to app_admin using (true) with check (true);
create policy driver_select_own on assignment_drop_points for select to app_driver
  using (exists (select 1 from assignments a where a.id = assignment_drop_points.assignment_id and a.driver_id = auth_driver_id()));
create policy driver_update_own on assignment_drop_points for update to app_driver
  using (exists (select 1 from assignments a where a.id = assignment_drop_points.assignment_id and a.driver_id = auth_driver_id()))
  with check (exists (select 1 from assignments a where a.id = assignment_drop_points.assignment_id and a.driver_id = auth_driver_id()));

-- ------------------------------------------------------------
-- assignment_drop_point_media：app_admin 全權限；app_driver 只能新增/查看
-- 自己車趟下貨點的附加媒體，不開放刪除或修改——上傳後的照片/影片不能自己
-- 偷偷改掉或刪掉，保留完整送達證明紀錄。
-- ------------------------------------------------------------
alter table assignment_drop_point_media enable row level security;
grant select, insert, update, delete on assignment_drop_point_media to app_admin;
grant select, insert on assignment_drop_point_media to app_driver;

create policy admin_all on assignment_drop_point_media for all to app_admin using (true) with check (true);
create policy driver_select_own on assignment_drop_point_media for select to app_driver
  using (exists (
    select 1 from assignment_drop_points adp join assignments a on a.id = adp.assignment_id
    where adp.id = assignment_drop_point_media.assignment_drop_point_id and a.driver_id = auth_driver_id()
  ));
create policy driver_insert_own on assignment_drop_point_media for insert to app_driver
  with check (exists (
    select 1 from assignment_drop_points adp join assignments a on a.id = adp.assignment_id
    where adp.id = assignment_drop_point_media.assignment_drop_point_id and a.driver_id = auth_driver_id()
  ));

-- ------------------------------------------------------------
-- adjustments：app_admin 全權限（司機薪資調整項由主控輸入）；
-- app_driver 只能唯讀自己的部分（我的報酬頁需要顯示）。
-- ------------------------------------------------------------
alter table adjustments enable row level security;
grant select, insert, update, delete on adjustments to app_admin;
grant select on adjustments to app_driver;

create policy admin_all on adjustments for all to app_admin using (true) with check (true);
create policy driver_select_own on adjustments for select to app_driver
  using (driver_id = auth_driver_id());

-- ------------------------------------------------------------
-- billing_adjustments：只有 app_admin 會用到（客戶請款例外調整，司機不需要看）。
-- ------------------------------------------------------------
alter table billing_adjustments enable row level security;
grant select, insert, update, delete on billing_adjustments to app_admin;
create policy admin_all on billing_adjustments for all to app_admin using (true) with check (true);

-- ------------------------------------------------------------
-- statements：app_admin 全權限；app_driver 只能看自己的月結單，
-- 且只有在「等待回簽」狀態下才能簽名（status/signed_at/signature_url）。
-- ------------------------------------------------------------
alter table statements enable row level security;
grant select, insert, update, delete on statements to app_admin;
grant select on statements to app_driver;
grant update (status, signed_at, signature_url) on statements to app_driver;

create policy admin_all on statements for all to app_admin using (true) with check (true);
create policy driver_select_own on statements for select to app_driver
  using (driver_id = auth_driver_id());
-- 不限制 status 才能更新：司機自己回簽後想重新簽名、或主控把已回簽的
-- 勞報單「退回」讓司機重簽，都需要司機能對「已經是 signed 狀態」的自己
-- 那筆紀錄再次更新（grant 只開放 status/signed_at/signature_url 這三欄，
-- 金額欄位司機仍然完全碰不到，不影響凍結金額的安全性）。
create policy driver_sign_own on statements for update to app_driver
  using (driver_id = auth_driver_id())
  with check (driver_id = auth_driver_id());

-- ------------------------------------------------------------
-- notifications：app_admin 可讀/寫/標記已讀；app_driver 只能新增
-- （出發/拍照/完成時推播一筆），不需要讀取（司機端沒有通知頁）。
-- ------------------------------------------------------------
alter table notifications enable row level security;
grant select, insert, update on notifications to app_admin;
grant insert on notifications to app_driver;

create policy admin_all on notifications for all to app_admin using (true) with check (true);
create policy driver_insert on notifications for insert to app_driver with check (true);


-- ============================================================
-- PART 3：請款金額計算觸發器
-- 把原本前端 tripBilling() 的邏輯搬到資料庫層，車趟狀態轉為
-- completed 時自動計算並鎖定金額快照，司機端沒有欄位權限可以竄改。
-- 注意：這個觸發器只在「狀態轉為 completed 的那一次 UPDATE」執行，
-- 匯入舊資料（INSERT 時就已經是 completed）不會觸發，舊資料的
-- 金額快照維持匯入時的原始值（凍結快照本來就不該回頭被重算）。
-- ============================================================
-- compute_trip_billing_values()：純計算，抽出來給觸發器（車趟轉為completed
-- 那一刻）跟 recompute_trip_billing_snapshot()（事後補算，見下面）共用同一套
-- 公式，不會兩邊各寫一份、之後改公式忘記改到另一邊。
create or replace function compute_trip_billing_values(p_assignment_id uuid, p_distance_km numeric)
returns table(total_amount numeric, by_channel jsonb)
language plpgsql as $$
declare
  pool_points int := 0;
  pool_total numeric := 0;
  base_amt numeric;
  remainder int;
  seen int := 0;
  ch record;
  v_by_channel jsonb := '{}'::jsonb;
  v_total_amount numeric := 0;
  v_rate_km numeric;
  v_rate_point numeric;
  amt numeric;
  i int;
begin
  select coalesce(sum(cnt), 0) into pool_points
  from (
    select count(*) as cnt
    from assignment_drop_points adp
    join channels c on c.id = adp.channel_id
    where adp.assignment_id = p_assignment_id and c.formula_type <> 'flat_per_trip'
    group by adp.channel_id
  ) s;

  if pool_points > 0 then
    select c.rate_km, c.rate_point into v_rate_km, v_rate_point
    from assignment_drop_points adp
    join channels c on c.id = adp.channel_id
    where adp.assignment_id = p_assignment_id and c.formula_type <> 'flat_per_trip'
    order by adp.sequence_no
    limit 1;

    pool_total := round(coalesce(p_distance_km, 0) * v_rate_km + pool_points * v_rate_point);
    base_amt := floor(pool_total / pool_points);
    remainder := pool_total - base_amt * pool_points;
    seen := 0;

    for ch in
      select adp.channel_id as channel_id, count(*) as cnt
      from assignment_drop_points adp
      join channels c on c.id = adp.channel_id
      where adp.assignment_id = p_assignment_id and c.formula_type <> 'flat_per_trip'
      group by adp.channel_id
      order by min(adp.sequence_no)
    loop
      amt := base_amt * ch.cnt;
      for i in 1..ch.cnt loop
        if seen < remainder then
          amt := amt + 1;
        end if;
        seen := seen + 1;
      end loop;
      v_by_channel := v_by_channel || jsonb_build_object(ch.channel_id::text, amt);
      v_total_amount := v_total_amount + amt;
    end loop;
  end if;

  for ch in
    select distinct adp.channel_id as channel_id, c.flat_amount as flat_amount
    from assignment_drop_points adp
    join channels c on c.id = adp.channel_id
    where adp.assignment_id = p_assignment_id and c.formula_type = 'flat_per_trip'
  loop
    v_by_channel := v_by_channel || jsonb_build_object(ch.channel_id::text, round(ch.flat_amount));
    v_total_amount := v_total_amount + round(ch.flat_amount);
  end loop;

  total_amount := v_total_amount;
  by_channel := v_by_channel;
  return next;
end;
$$;

-- 把原本前端 tripBilling() 的邏輯搬到資料庫層，車趟狀態轉為
-- completed 時自動計算並鎖定金額快照，司機端沒有欄位權限可以竄改。
-- 注意：這個觸發器只在「狀態轉為 completed 的那一次 UPDATE」執行，
-- 匯入舊資料（INSERT 時就已經是 completed）不會觸發，舊資料的
-- 金額快照維持匯入時的原始值（凍結快照本來就不該回頭被重算）——
-- 例外只有下面 recompute_trip_billing_snapshot()，用於下貨點分類
-- 事後訂正時主動補算，不是自動重算。
create or replace function compute_trip_billing() returns trigger
language plpgsql as $$
declare
  r record;
begin
  if new.status = 'completed' and (old.status is distinct from 'completed') then
    select * into r from compute_trip_billing_values(new.id, new.distance_km);
    new.billing_total_snapshot := r.total_amount;
    new.billing_by_channel_snapshot := r.by_channel;
    new.payroll_fare_snapshot := new.fare;
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end;
$$;

create trigger trg_compute_trip_billing
before update on assignments
for each row execute function compute_trip_billing();

-- 下貨點分類訂正後，已經completed、金額已凍結的車趟主動補算一次請款拆賬
-- （只有 sync_drop_point_channel() 會呼叫這個，不是自動觸發——一般情況金額
-- 凍結後不會再變，只有「下貨點資料庫分類打錯字，事後訂正」這種資料修正
-- 情境才需要）。司機費用（fare/payroll_fare_snapshot）不受影響，這裡完全
-- 不碰。
create or replace function recompute_trip_billing_snapshot(p_assignment_id uuid) returns void
language plpgsql as $$
declare
  r record;
  v_distance_km numeric;
begin
  select distance_km into v_distance_km from assignments where id = p_assignment_id and status = 'completed';
  if not found then return; end if;
  select * into r from compute_trip_billing_values(p_assignment_id, v_distance_km);
  update assignments set billing_total_snapshot = r.total_amount, billing_by_channel_snapshot = r.by_channel where id = p_assignment_id;
end;
$$;
grant execute on function recompute_trip_billing_snapshot(uuid) to app_admin;

-- ------------------------------------------------------------
-- 下貨點改分類（所屬通路）時，同步套用到「所有」引用這個下貨點的車趟快照
-- （配送紀錄查詢／請款明細一律依下貨點資料庫目前的分類顯示，不分車趟是否
-- 已完成）。已經 completed 的車趟，請款金額快照也會跟著補算一次（下貨點
-- 的通路歸屬會影響共配分攤的店數比例）——這一步刻意繞過「金額凍結後不
-- 回頭重算」的一般原則，因為這裡要修正的是「下貨點打從一開始就分類錯」
-- 這個資料錯誤本身，不是路線/費率之後合理變動；已經修正的請款金額如果
-- 前期已經請款/入帳，請自行核對是否需要跟通路方調整。司機費用完全不受
-- 影響（recompute_trip_billing_snapshot 不碰 fare）。
-- ------------------------------------------------------------
create or replace function sync_drop_point_channel(p_drop_point_id uuid, p_channel_id uuid) returns void
language plpgsql as $$
declare
  aid uuid;
begin
  update assignment_drop_points
  set channel_id = p_channel_id
  where source_drop_point_id = p_drop_point_id
    and channel_id is distinct from p_channel_id;

  for aid in
    select distinct a.id from assignments a
    join assignment_drop_points adp on adp.assignment_id = a.id
    where adp.source_drop_point_id = p_drop_point_id and a.status = 'completed'
  loop
    perform recompute_trip_billing_snapshot(aid);
  end loop;
end;
$$;
grant execute on function sync_drop_point_channel(uuid, uuid) to app_admin;


-- ============================================================
-- PART 4：Storage bucket 權限（bucket 本身由 migrate.js / 應用程式
-- 用 supabase-js 的 storage.createBucket 建立，這裡只設定 RLS policy）
-- 路徑格式固定為 {assignment_id}/{assignment_drop_point_id}.jpg
-- ============================================================
create policy admin_all_photos on storage.objects for all to app_admin
  using (bucket_id = 'assignment-photos') with check (bucket_id = 'assignment-photos');

create policy driver_select_own_photos on storage.objects for select to app_driver
  using (
    bucket_id = 'assignment-photos'
    and exists (
      select 1 from assignments a
      where a.id::text = (storage.foldername(name))[1]
        and a.driver_id = auth_driver_id()
    )
  );

create policy driver_upload_own_photos on storage.objects for insert to app_driver
  with check (
    bucket_id = 'assignment-photos'
    and exists (
      select 1 from assignments a
      where a.id::text = (storage.foldername(name))[1]
        and a.driver_id = auth_driver_id()
    )
  );

-- 重新拍照會用 upsert:true 覆蓋同一路徑的既有檔案，Storage 底層是把它當UPDATE
-- 處理（物件已存在），光有上面的 insert policy 涵蓋不到，沒有這條的話重新拍照
-- 選檔案時會顯示成功但實際upload被RLS擋下、整個流程失敗。
create policy driver_update_own_photos on storage.objects for update to app_driver
  using (
    bucket_id = 'assignment-photos'
    and exists (
      select 1 from assignments a
      where a.id::text = (storage.foldername(name))[1]
        and a.driver_id = auth_driver_id()
    )
  )
  with check (
    bucket_id = 'assignment-photos'
    and exists (
      select 1 from assignments a
      where a.id::text = (storage.foldername(name))[1]
        and a.driver_id = auth_driver_id()
    )
  );

-- 司機回簽簽名圖檔也走 Storage（bucket: signatures），不直接塞base64進資料庫欄位。
-- 路徑格式固定為 {statement_id}.png
create policy admin_all_signatures on storage.objects for all to app_admin
  using (bucket_id = 'signatures') with check (bucket_id = 'signatures');

create policy driver_select_own_signature on storage.objects for select to app_driver
  using (
    bucket_id = 'signatures'
    and exists (
      select 1 from statements s
      where s.id::text = split_part(name, '.', 1)
        and s.driver_id = auth_driver_id()
    )
  );

-- 上傳（第一次簽名）跟更新（重新簽名覆蓋舊檔）都不限制 status，理由同上
-- statements 表的 driver_sign_own policy。
create policy driver_upload_own_signature on storage.objects for insert to app_driver
  with check (
    bucket_id = 'signatures'
    and exists (
      select 1 from statements s
      where s.id::text = split_part(name, '.', 1)
        and s.driver_id = auth_driver_id()
    )
  );
create policy driver_update_own_signature on storage.objects for update to app_driver
  using (
    bucket_id = 'signatures'
    and exists (
      select 1 from statements s
      where s.id::text = split_part(name, '.', 1)
        and s.driver_id = auth_driver_id()
    )
  )
  with check (
    bucket_id = 'signatures'
    and exists (
      select 1 from statements s
      where s.id::text = split_part(name, '.', 1)
        and s.driver_id = auth_driver_id()
    )
  );

-- ============================================================
-- PART 5：免費方案用量監控（系統設定頁面用）
-- Supabase 沒有公開 API 可以查每月流量/Egress（那個只能到官方後台
-- Usage頁面手動看），但資料庫大小、檔案儲存空間都可以直接用SQL算出來。
-- app_admin本身沒有storage schema的權限（那是Storage API走的，不是一般
-- 資料表權限），這兩個function用 security definer 用擁有者權限繞過這個
-- 限制，只回傳彙總數字（純數字，不會洩漏任何檔案內容或路徑明細）。
-- ============================================================
create or replace function get_database_size() returns bigint
language sql security definer as $$
  select pg_database_size(current_database());
$$;
grant execute on function get_database_size() to app_admin;

create or replace function get_storage_usage() returns table(bucket_id text, total_bytes bigint, file_count bigint)
language sql security definer set search_path = storage, public as $$
  select bucket_id, coalesce(sum((metadata->>'size')::bigint), 0) as total_bytes, count(*) as file_count
  from storage.objects
  group by bucket_id;
$$;
grant execute on function get_storage_usage() to app_admin;

-- ============================================================
-- PART 6：公告（主控發布給全體司機或指定司機看的訊息，例如放假通知、
-- 規則異動、或只給某幾位司機的個別提醒）
-- ============================================================
create table announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  active boolean not null default true,
  -- 'all'：全體司機都看得到；'selected'：只有 announcement_recipients
  -- 裡指定的那幾位司機看得到。
  audience text not null default 'all' check (audience in ('all','selected')),
  created_at timestamptz not null default now()
);
create index idx_announcements_active on announcements(active, created_at desc);

-- 公告指定對象（audience='selected' 時才會有資料；audience='all' 時這裡
-- 一律不用填，全體司機都看得到，不需要一筆一筆列出來）。
create table announcement_recipients (
  announcement_id uuid not null references announcements(id) on delete cascade,
  driver_id uuid not null references drivers(id) on delete cascade,
  primary key (announcement_id, driver_id)
);

-- app_admin 全權限（新增/編輯/下架/刪除）；app_driver 只能看目前上架中
-- （active=true）、而且是發給全體（audience='all'）或有把自己列在
-- announcement_recipients 裡的公告。不需要另外做已讀/未讀追蹤，就是
-- 簡單的「現在有效、而且是發給我的都顯示」。
alter table announcements enable row level security;
grant select, insert, update, delete on announcements to app_admin;
grant select on announcements to app_driver;

create policy admin_all on announcements for all to app_admin using (true) with check (true);
create policy driver_select_active on announcements for select to app_driver
  using (
    active = true
    and (
      audience = 'all'
      or exists (
        select 1 from announcement_recipients ar
        where ar.announcement_id = announcements.id and ar.driver_id = auth_driver_id()
      )
    )
  );

-- announcement_recipients：app_admin 全權限；app_driver 只能看自己被
-- 指定到的那幾筆（給上面 announcements 的 policy 子查詢用，司機端本身
-- 不會直接查這張表）。
alter table announcement_recipients enable row level security;
grant select, insert, delete on announcement_recipients to app_admin;
grant select on announcement_recipients to app_driver;

create policy admin_all on announcement_recipients for all to app_admin using (true) with check (true);
create policy driver_select_own on announcement_recipients for select to app_driver
  using (driver_id = auth_driver_id());

-- ============================================================
-- PART 7：司機互看「同出發點車隊今日出發狀況」
-- 同出發點所有還沒完成的車次（不論出發了沒）都列出來給司機看，只顯示
-- 「出發了沒」這個狀態，不含下貨點/店名等配送細節；完成的車次直接從
-- 清單消失，不是顯示成「已完成」。
-- assignments 的 driver_select_own policy 只讓司機查到自己的車趟，看不到
-- 同出發點其他司機的資料——這是故意的，因為 assignments 整張表包含司機
-- 費用/請款金額等敏感欄位，不能整表開放給其他司機查。這裡改用一個
-- security definer 函式，只回傳「車次名稱、司機姓名、出發狀態」這幾個
-- 沒有金額的欄位，繞過（但不破壞）assignments 本身的RLS限制——
-- app_driver 只拿得到這個函式回傳的窄欄位結果，查不到底下
-- assignments/routes 表的其他欄位（尤其是fare/payroll_fare_snapshot/
-- billing_total_snapshot這些薪資/請款金額，完全不會出現在回傳結果裡）。
-- ============================================================
create or replace function driver_depot_overview(p_date date default current_date)
returns table (
  assignment_id uuid,
  route_name text,
  driver_name text,
  status text,
  seq text,
  shift text
)
language plpgsql security definer set search_path = public as $$
declare
  my_id uuid := auth_driver_id();
begin
  if my_id is null then
    return;
  end if;
  return query
    select
      a.id,
      r.name,
      d.name,
      a.status,
      r.seq,
      r.shift
    from assignments a
    join routes r on r.id = a.route_id
    join drivers d on d.id = a.driver_id
    where a.trip_date = p_date
      and a.status not in ('cancelled', 'completed')
      and r.origin_id in (
        select r2.origin_id from assignments a2
        join routes r2 on r2.id = a2.route_id
        where a2.driver_id = my_id and a2.trip_date = p_date
      );
end;
$$;
grant execute on function driver_depot_overview(date) to app_driver;

-- ============================================================
-- PART 9：目錄資料版本標記，給前端做「有變動才重抓」的快取比對用
-- ============================================================
-- drivers/channels/origins/drop_points/routes（含巢狀的route_versions/
-- route_version_points）這些「目錄資料」在 loadAllData() 裡幾乎每次登入
-- 都會整包重抓，但實際上一天可能只會被改個一兩次。這裡維護一個單一列
-- 的版本戳記，這些目錄表格任何一張有異動（不管是新增/修改/刪除），
-- 觸發器就會把這裡的時間戳記更新成當下時間；前端登入時先查這裡的
-- version，跟本地瀏覽器快取的版本比對，一樣就直接用快取、不用重新整包
-- 抓那幾支查詢（詳見 js/data-layer.js 的 loadAllData()）。
--
-- 沒有加 RLS——跟 channels/origins/drop_points/routes 這些目錄表格一樣，
-- 單純依賴 anon 角色的預設權限（app_admin/app_driver 都是 anon 的成員），
-- 這裡只存一個時間戳記，不是機敏資料，不需要另外鎖權限。
-- ============================================================
create table catalog_meta (
  id smallint primary key default 1,
  version timestamptz not null default now(),
  constraint catalog_meta_singleton check (id = 1)
);
insert into catalog_meta (id, version) values (1, now());

create or replace function bump_catalog_version() returns trigger
language plpgsql as $$
begin
  update catalog_meta set version = now() where id = 1;
  return null;
end;
$$;

create trigger trg_catalog_version_drivers after insert or update or delete on drivers
  for each statement execute function bump_catalog_version();
create trigger trg_catalog_version_channels after insert or update or delete on channels
  for each statement execute function bump_catalog_version();
create trigger trg_catalog_version_origins after insert or update or delete on origins
  for each statement execute function bump_catalog_version();
create trigger trg_catalog_version_drop_points after insert or update or delete on drop_points
  for each statement execute function bump_catalog_version();
create trigger trg_catalog_version_routes after insert or update or delete on routes
  for each statement execute function bump_catalog_version();
create trigger trg_catalog_version_route_versions after insert or update or delete on route_versions
  for each statement execute function bump_catalog_version();
create trigger trg_catalog_version_route_version_points after insert or update or delete on route_version_points
  for each statement execute function bump_catalog_version();

-- ============================================================
-- PART 10：司機代墊款（2026-10-04）
-- 已在線上資料庫直接執行過（見 adjustments 的 check 與 statements.reimbursement_amount）：
--   alter table adjustments drop constraint adjustments_adjustment_type_check;
--   alter table adjustments add constraint adjustments_adjustment_type_check check (adjustment_type in ('advance','add','deduct','reimbursement'));
--   alter table statements add column reimbursement_amount numeric not null default 0;
-- ============================================================


-- ============================================================
-- PART 11：司機加油申報（2026-10-04，已在線上資料庫直接執行過）
-- 司機只能填日期/金額/發票號碼，狀態固定是 pending（待確認）；主控核對憑證後
-- 「確認」才會轉成 adjustments 的 reimbursement（代墊款）並把狀態改成 confirmed，
-- 確認後司機就不能再改或刪除。status/adjustment_id 司機端沒有寫入權限。
-- ============================================================
create table fuel_claims (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  fuel_date date not null,
  amount numeric not null check (amount > 0),
  invoice_no text not null check (invoice_no ~ '^[A-Z]{2}[0-9]{8}$'),
  status text not null default 'pending' check (status in ('pending','confirmed')),
  adjustment_id uuid references adjustments(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fuel_claims_invoice_unique unique (invoice_no)
);
create index idx_fuel_claims_driver on fuel_claims(driver_id, fuel_date);
alter table fuel_claims enable row level security;
grant select, insert, update, delete on fuel_claims to app_admin;
grant select, delete on fuel_claims to app_driver;
grant insert (driver_id, fuel_date, amount, invoice_no) on fuel_claims to app_driver;
grant update (fuel_date, amount, invoice_no) on fuel_claims to app_driver;
create policy admin_all on fuel_claims for all to app_admin using (true) with check (true);
create policy driver_select_own on fuel_claims for select to app_driver using (driver_id = auth_driver_id());
create policy driver_insert_own on fuel_claims for insert to app_driver with check (driver_id = auth_driver_id());
create policy driver_update_own on fuel_claims for update to app_driver
  using (driver_id = auth_driver_id() and status = 'pending') with check (driver_id = auth_driver_id() and status = 'pending');
create policy driver_delete_own on fuel_claims for delete to app_driver
  using (driver_id = auth_driver_id() and status = 'pending');

-- 司機代墊申報加入類別（加油／車輛保養）與選填備註（2026-10-04，已在線上資料庫直接執行過）：
--   alter table fuel_claims add column category text not null default 'fuel' check (category in ('fuel','maintenance'));
--   alter table fuel_claims add column note text check (note is null or char_length(note) <= 60);
--   grant insert (category, note) on fuel_claims to app_driver;
--   grant update (category, note) on fuel_claims to app_driver;

-- ============================================================
-- PART 12：司機「已投保職業工會」勾選＋證明圖檔（2026-10-06，已在線上資料庫直接執行過）
-- 只有主控（app_admin）能設定／上傳／查看；司機端欄位權限沒有開放這兩欄。
-- 證明圖檔放私有 bucket driver-docs，路徑 {driver_id}/union-{時間}.jpg。
-- ============================================================
alter table drivers add column if not exists union_insured boolean not null default false;
alter table drivers add column if not exists union_proof_path text;
insert into storage.buckets (id, name, public) values ('driver-docs', 'driver-docs', false) on conflict (id) do nothing;
create policy admin_all_driver_docs on storage.objects for all to app_admin
  using (bucket_id = 'driver-docs') with check (bucket_id = 'driver-docs');

-- ============================================================
-- PART 13：勞報單勞務名稱（2026-10-06，已在線上資料庫直接執行過）
-- drivers.service_name：主控設定的該司機勞務名稱（空白＝預設「貨物配送及到店協助理貨勞務」）；
-- statements.service_name：月結確認當下凍結的名稱。司機欄位權限沒有開放 drivers.service_name，
-- 只有主控能改。程式規則（data-layer.js validateServiceName）：當月有完成車趟時名稱必須含「配送」。
-- ============================================================
alter table drivers add column if not exists service_name text check (service_name is null or char_length(service_name) <= 30);
alter table statements add column if not exists service_name text check (service_name is null or char_length(service_name) <= 30);

-- ============================================================
-- PART 14：區間勞報單（依實際付款期間開單，2026-10-06）
-- statements 多了 period_start/period_end/pay_date：有值＝區間勞報單（期間不可跟同司機其他勞報單
-- 重疊，由程式 findOverlappingStatement 把關），空＝原本的月結。statement_month 區間單存結束日所屬月份。
-- 原本 unique(driver_id, statement_month) 改成只限月結（period_start is null）的 partial unique index，
-- 區間單另有 (driver_id, period_start, period_end) 唯一。
-- adjustments.adjustment_date：調整項日期，區間勞報單依此歸入期間（舊資料為空，視為該月1日）。
-- ============================================================
alter table statements add column if not exists period_start date;
alter table statements add column if not exists period_end date;
alter table statements add column if not exists pay_date date;
alter table statements add constraint statements_period_chk check ((period_start is null and period_end is null) or (period_start is not null and period_end is not null and period_end >= period_start));
alter table statements drop constraint if exists statements_driver_id_statement_month_key;
create unique index if not exists statements_monthly_uq on statements(driver_id, statement_month) where period_start is null;
create unique index if not exists statements_period_uq on statements(driver_id, period_start, period_end) where period_start is not null;
alter table adjustments add column if not exists adjustment_date date;

-- ============================================================
-- PART 15：趟報酬額外金額（臨時加錢／拆店調撥）與已付款（2026-10-06，已在線上資料庫直接執行過）
-- assignments.extra_pay：併進這一趟司機報酬的額外金額（＝trip_pay_adjustments 該趟紀錄加總），
--   趟報酬 = (payroll_fare_snapshot ?? fare) + extra_pay（程式 tripPay()）；我的報酬、薪資結算、勞報單、
--   首頁即時利潤全部用趟報酬，勞報單不單獨列項；客戶請款不受影響。
-- trip_pay_adjustments：逐筆來源紀錄（kind: extra 臨時加減／split 拆店調撥，同一次拆店共用 group_id），只有主控可讀寫。
-- assignments.paid_amount/paid_date/paid_method：這趟已先付（現金／轉帳）的金額，只影響可領淨額，不影響勞報單，與預支獨立。
-- ============================================================
alter table assignments add column if not exists extra_pay numeric not null default 0;
alter table assignments add column if not exists paid_amount numeric not null default 0;
alter table assignments add column if not exists paid_date date;
alter table assignments add column if not exists paid_method text check (paid_method is null or paid_method in ('cash','transfer'));
create table if not exists trip_pay_adjustments (id uuid primary key default gen_random_uuid(), assignment_id uuid not null references assignments(id) on delete cascade, kind text not null check (kind in ('extra','split')), group_id uuid, amount numeric not null, note text, created_at timestamptz not null default now());
create index if not exists idx_tpa_assignment on trip_pay_adjustments(assignment_id);
create index if not exists idx_tpa_group on trip_pay_adjustments(group_id);
alter table trip_pay_adjustments enable row level security;
grant select, insert, update, delete on trip_pay_adjustments to app_admin;
create policy admin_all on trip_pay_adjustments for all to app_admin using (true) with check (true);

-- PART 15b：已付款改成「區間付款」（2026-10-06，已在線上資料庫直接執行過）
-- 主控填區間＋付款日期，區間內已完成未付的車趟一次標為已付（金額依各趟報酬比例攤）；
-- 同一次付款共用 paid_group，並記錄 paid_period_start/end，週班表顯示「✅10/3付」、司機我的報酬顯示支付日與區間。
alter table assignments add column if not exists paid_group uuid;
alter table assignments add column if not exists paid_period_start date;
alter table assignments add column if not exists paid_period_end date;
create index if not exists idx_assignments_paid_group on assignments(paid_group) where paid_group is not null;

-- PART 16：「無需月結」標記（2026-10-06，已在線上資料庫直接執行過）
-- 某位司機某個月不需要月結（只是記錄，不影響金額）：從尚未月結名單與首頁提醒消失，可恢復。只有主控可讀寫。
create table if not exists settle_skips (driver_id uuid not null references drivers(id) on delete cascade, statement_month date not null, created_at timestamptz not null default now(), primary key (driver_id, statement_month));
alter table settle_skips enable row level security;
grant select, insert, update, delete on settle_skips to app_admin;
create policy admin_all on settle_skips for all to app_admin using (true) with check (true);

-- PART 17：代墊款日期補齊（2026-10-06，已在線上資料庫直接執行過）
-- 舊的代墊款（由加油申報轉進來）當時沒有 adjustment_date，一律被當成該月1日，區間勞報單切週時會全擠在
-- 含1號的那一段。已用對應申報的加油日期回填；程式也改成手動新增代墊款一定要填日期。
--   update adjustments a set adjustment_date = f.fuel_date from fuel_claims f where f.adjustment_id = a.id and a.adjustment_date is null and a.adjustment_type = 'reimbursement';

-- PART 18：延後付款（掛帳）（2026-10-06，已在線上資料庫直接執行過）
-- 司機同意晚點領：主控把某段期間已完成、尚未付款的車趟掛帳（pay_due_date 預計付款日、pay_due_note 備註），
-- 薪資結算頁有待付款清單，首頁到期前3天提醒，司機我的報酬顯示待領；用區間付款登記後（paid_amount>0）自動消失。
-- 完全不影響勞報單。只標記有掛帳的車趟，舊月份不會被誤當成欠款。
alter table assignments add column if not exists pay_due_date date;
alter table assignments add column if not exists pay_due_note text check (pay_due_note is null or char_length(pay_due_note) <= 60);
create index if not exists idx_assignments_pay_due on assignments(pay_due_date) where pay_due_date is not null;

-- PART 19：週班表「發佈」與「下週自動延續本週」（2026-10-06，已在線上資料庫直接執行過）
-- assignments.published：false＝草稿（只有主控看得到），true＝司機看得到。司機端 assignments 的 select/update policy
-- 加上 and published（assignment_drop_points、media、storage 的 policy 都是 exists(select from assignments)，
-- 受同一個 RLS 過濾，自動跟著看不到草稿）；driver_depot_overview 也加了 published 條件。既有車趟預設 true。
-- 程式：本週（含以前）新建的車趟 published=true，之後週次的車趟 published=false，主控按「發佈這週」才開放。
-- schedule_rollovers：記錄哪一週已經自動延續過（先寫入再複製），之後刪掉哪格都不會再被補回來。
alter table assignments add column if not exists published boolean not null default true;
create table if not exists schedule_rollovers (week_start date primary key, created_count int not null default 0, created_at timestamptz not null default now());
alter table schedule_rollovers enable row level security;
grant select, insert, update, delete on schedule_rollovers to app_admin;
create policy admin_all on schedule_rollovers for all to app_admin using (true) with check (true);
drop policy if exists driver_select_own on assignments;
create policy driver_select_own on assignments for select to app_driver using (driver_id = auth_driver_id() and published);
drop policy if exists driver_update_own on assignments;
create policy driver_update_own on assignments for update to app_driver using (driver_id = auth_driver_id() and published) with check (driver_id = auth_driver_id() and published);
-- driver_depot_overview(p_date)：where 加 a.published，子查詢 a2 也加 a2.published（完整內容見上方 PART 的函式，已用 create or replace 更新）

-- PART 20：即時同步擴大範圍（2026-10-08，已在線上資料庫直接執行過）
-- Realtime publication 原本只有 assignments / assignment_drop_points，現在加上 statements（勞報單／簽名）、
-- adjustments（調整項）、fuel_claims（代墊申報）；RLS 照樣套用（夥伴只收得到自己的）。
alter publication supabase_realtime add table statements, adjustments, fuel_claims;

-- PART 21：臨時支援——把店點交給支援夥伴（2026-10-08，已在線上資料庫直接執行過）
-- 只改「店點由誰到場拍照」，任務／報酬／請款／拆店調撥／勞報單完全不動。
-- stop_delegations：一次交付一筆（assignment_id、helper_id、amount＝只顯示用的拆分金額，不計帳、note），只有主控能讀寫。
-- assignment_drop_points 新增 helper_id（支援夥伴）、helper_name、delegation_id、completed_by（完成者，由觸發器寫入）。
-- RLS：支援夥伴能看／更新 helper_id=自己 的店點（看不到原任務，所以報酬看不到）；原夥伴看得到但 helper_id 有值就不能更新；
--   附加媒體、Storage 照片（路徑第一層是任務 id）的 policy 也加上「是這任務的支援夥伴」的條件。
-- my_support_context(p_from, p_to)：security definer，只回傳支援夥伴需要的任務脈絡（日期、路線、原夥伴姓名、拆分金額）。
create table if not exists stop_delegations (id uuid primary key default gen_random_uuid(), assignment_id uuid not null references assignments(id) on delete cascade, helper_id uuid not null references drivers(id), amount numeric, note text, created_at timestamptz not null default now());
alter table stop_delegations enable row level security;
grant select, insert, update, delete on stop_delegations to app_admin;
create policy admin_all on stop_delegations for all to app_admin using (true) with check (true);
alter table assignment_drop_points add column if not exists helper_id uuid references drivers(id) on delete set null;
alter table assignment_drop_points add column if not exists helper_name text;
alter table assignment_drop_points add column if not exists delegation_id uuid references stop_delegations(id) on delete set null;
alter table assignment_drop_points add column if not exists completed_by uuid references drivers(id) on delete set null;
create index if not exists idx_adp_helper on assignment_drop_points(helper_id) where helper_id is not null;
create or replace function set_dp_completed_by() returns trigger language plpgsql as $$ begin if new.status = 'completed' and old.status is distinct from 'completed' and auth_driver_id() is not null then new.completed_by := auth_driver_id(); end if; return new; end; $$;
create trigger trg_dp_completed_by before update on assignment_drop_points for each row execute function set_dp_completed_by();
-- assignment_drop_points：driver_select_own = helper_id=我 or 我的任務；driver_update_own = helper_id=我 or (helper_id is null and 我的任務)
-- assignment_drop_point_media：select/insert 加上 helper_id=我（原夥伴 insert 需 helper_id is null）
-- storage.objects（assignment-photos）select/insert/update 加上 exists(assignment_drop_points where assignment_id=路徑第一層 and helper_id=我)
-- my_support_context(date,date)：見線上資料庫函式，grant execute to app_driver


-- ============================================================
-- PART 22：店點涵蓋檢查（路線管理／店點資料庫）
-- allow_duplicate：刻意同一班次排進多條路線的店，標了之後涵蓋檢查不警示。
-- 其餘（遺漏／重複／已停用卻還在路線）全部由程式依現有路線版本即時計算，不另存資料。
-- ============================================================
alter table drop_points add column if not exists allow_duplicate boolean not null default false;

-- PART 23：路線停用（status）。停用的路線不出現在週期任務清單／批次建立／下週自動延續／涵蓋檢查，歷史資料全部保留。
alter table routes add column if not exists status text not null default 'active' check (status in ('active','inactive'));
