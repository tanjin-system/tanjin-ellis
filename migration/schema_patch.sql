-- ============================================================
-- 已停用：這個補丁的內容已經整合進 supabase/schema.sql（單一權威版本，
-- 含完整表格 + RBAC/RLS + 請款計算觸發器）。請直接執行 supabase/schema.sql，
-- 不需要再跑這個檔案。保留在這裡只是留存修改歷程。
-- ============================================================

-- ============================================================
-- Schema 補丁：在原本的 schema.sql 之後執行
-- 原因：真實資料（real_data.json）證實 channels 需要計費公式欄位，
-- 否則牧穀（flat_per_trip, 3000）、21Plus（flat_per_trip, 236）
-- 這類「整趟固定金額」通路無法還原，共配拆分公式(tripBilling)也無從計算。
-- ============================================================

alter table channels
  add column if not exists formula_type text not null default 'per_km_and_point'
    check (formula_type in ('per_km_and_point', 'flat_per_trip')),
  add column if not exists rate_km numeric not null default 35,
  add column if not exists rate_point numeric not null default 50,
  add column if not exists flat_amount numeric not null default 0;

-- 原本手動寫死的 3 筆通路種子資料改由 migrate.js 從 real_data.json 匯入，
-- 這裡先清空，避免種子資料的 id 與真實資料衝突。
delete from channels;

-- 原本手動寫死的 4 筆出發點種子資料，理由同上。
delete from origins;

-- 這個 view 用固定的 35/50 費率計算總額，且沒有處理：
-- (1) 多通路共配時依點數比例分攤 + 餘數逐一分配
-- (2) flat_per_trip 通路獨立計算、不參與共配
-- 因此跟真實的 tripBilling() 拆分邏輯對不上，先移除。
-- 車趟完成時的請款金額改由應用層（對應 tripBilling 邏輯的 Edge Function）
-- 計算後寫入 assignments.billing_total_snapshot / billing_by_channel_snapshot，
-- 匯入舊資料時則直接沿用 JSON 裡既有的 billingSnapshot，不重新計算。
drop view if exists assignment_billing_totals;
