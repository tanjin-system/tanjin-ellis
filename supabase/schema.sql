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
  status text not null default 'active' check (status in ('active','inactive')),
  inactive_at timestamptz,
  vehicle_plate text,
  vehicle_type text,
  vehicle_load numeric,
  bank_name text,
  bank_branch text,
  bank_account text,
  bank_holder text,
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
  tax_inclusive boolean not null default true,
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
  created_at timestamptz not null default now()
);
create index idx_adp_assignment on assignment_drop_points(assignment_id);

-- ------------------------------------------------------------
-- 9. 司機薪資調整項
-- ------------------------------------------------------------
create table adjustments (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  adjustment_month date not null,
  adjustment_type text not null check (adjustment_type in ('advance','add','deduct')),
  amount numeric not null,
  note text,
  created_at timestamptz not null default now()
);
create index idx_adjustments_driver_month on adjustments(driver_id, adjustment_month);

-- ------------------------------------------------------------
-- 10. 司機月結勞報單
-- ------------------------------------------------------------
create table statements (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  statement_month date not null,
  trip_total numeric not null default 0,
  adj_total numeric not null default 0,
  net_amount numeric not null default 0,
  status text not null default 'awaiting_signature' check (status in ('awaiting_signature','signed')),
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
grant select, insert on storage.objects to app_driver;

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
-- 且只能改「我的資料」頁允許編輯的欄位，不能碰 name/status/access_code。
-- ------------------------------------------------------------
alter table drivers enable row level security;
grant select, insert, update, delete on drivers to app_admin;
grant select on drivers to app_driver;
grant update (phone, line_user_id, vehicle_plate, vehicle_type, vehicle_load,
              bank_name, bank_branch, bank_account, bank_holder) on drivers to app_driver;

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
-- 屬於自己車趟的下貨點，只能改 status / photo_url / completed_at
-- （photo_cleared 是系統housekeeping欄位，司機不可碰）。
-- ------------------------------------------------------------
alter table assignment_drop_points enable row level security;
grant select, insert, update, delete on assignment_drop_points to app_admin;
grant select on assignment_drop_points to app_driver;
grant update (status, photo_url, completed_at) on assignment_drop_points to app_driver;

create policy admin_all on assignment_drop_points for all to app_admin using (true) with check (true);
create policy driver_select_own on assignment_drop_points for select to app_driver
  using (exists (select 1 from assignments a where a.id = assignment_drop_points.assignment_id and a.driver_id = auth_driver_id()));
create policy driver_update_own on assignment_drop_points for update to app_driver
  using (exists (select 1 from assignments a where a.id = assignment_drop_points.assignment_id and a.driver_id = auth_driver_id()))
  with check (exists (select 1 from assignments a where a.id = assignment_drop_points.assignment_id and a.driver_id = auth_driver_id()));

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
create policy driver_sign_own on statements for update to app_driver
  using (driver_id = auth_driver_id() and status = 'awaiting_signature')
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
create or replace function compute_trip_billing() returns trigger
language plpgsql as $$
declare
  pool_points int := 0;
  pool_total numeric := 0;
  base_amt numeric;
  remainder int;
  seen int := 0;
  ch record;
  by_channel jsonb := '{}'::jsonb;
  total_amount numeric := 0;
  v_rate_km numeric;
  v_rate_point numeric;
  amt numeric;
  i int;
begin
  if new.status = 'completed' and (old.status is distinct from 'completed') then

    select coalesce(sum(cnt), 0) into pool_points
    from (
      select count(*) as cnt
      from assignment_drop_points adp
      join channels c on c.id = adp.channel_id
      where adp.assignment_id = new.id and c.formula_type <> 'flat_per_trip'
      group by adp.channel_id
    ) s;

    if pool_points > 0 then
      select c.rate_km, c.rate_point into v_rate_km, v_rate_point
      from assignment_drop_points adp
      join channels c on c.id = adp.channel_id
      where adp.assignment_id = new.id and c.formula_type <> 'flat_per_trip'
      order by adp.sequence_no
      limit 1;

      pool_total := round(coalesce(new.distance_km, 0) * v_rate_km + pool_points * v_rate_point);
      base_amt := floor(pool_total / pool_points);
      remainder := pool_total - base_amt * pool_points;
      seen := 0;

      for ch in
        select adp.channel_id as channel_id, count(*) as cnt
        from assignment_drop_points adp
        join channels c on c.id = adp.channel_id
        where adp.assignment_id = new.id and c.formula_type <> 'flat_per_trip'
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
        by_channel := by_channel || jsonb_build_object(ch.channel_id::text, amt);
        total_amount := total_amount + amt;
      end loop;
    end if;

    for ch in
      select distinct adp.channel_id as channel_id, c.flat_amount as flat_amount
      from assignment_drop_points adp
      join channels c on c.id = adp.channel_id
      where adp.assignment_id = new.id and c.formula_type = 'flat_per_trip'
    loop
      by_channel := by_channel || jsonb_build_object(ch.channel_id::text, round(ch.flat_amount));
      total_amount := total_amount + round(ch.flat_amount);
    end loop;

    new.billing_total_snapshot := total_amount;
    new.billing_by_channel_snapshot := by_channel;
    new.payroll_fare_snapshot := new.fare;
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end;
$$;

create trigger trg_compute_trip_billing
before update on assignments
for each row execute function compute_trip_billing();


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

create policy driver_upload_own_signature on storage.objects for insert to app_driver
  with check (
    bucket_id = 'signatures'
    and exists (
      select 1 from statements s
      where s.id::text = split_part(name, '.', 1)
        and s.driver_id = auth_driver_id()
        and s.status = 'awaiting_signature'
    )
  );
