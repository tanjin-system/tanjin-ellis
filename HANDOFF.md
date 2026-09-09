# 碳金車隊調度系統 — 正式版交接說明

給接手的人（或給另一個 AI 助理）看的，說明目前進度、關鍵架構決定、還沒做完的部分。

## 專案背景

原本是一個 Artifact demo（單檔 HTML + localStorage），功能邏輯（排班、司機管理、薪資計算、請款拆分公式）已經跟業主確認過。現在要改寫成正式版，串接 Supabase 資料庫，部署到 Vercel。

改寫策略是**最小改動**：畫面與所有 `render*()` 函式完全不動，只把資料層從 localStorage 換成 Supabase。

## 兩個關鍵架構決定（已跟業主確認，不要重新討論）

### 1. 身份驗證：後端代理驗證，不是 Supabase Auth 帳號

demo 原本是明文 PIN（主控）／4碼代碼（司機）比對，直接接 Supabase 會有安全疑慮（anon key 讓任何人都能讀到明文PIN/代碼）。改成：

- `api/auth-driver.js`、`api/auth-admin.js`（Vercel Serverless Function）用 **service role key** 在後端比對 PIN/代碼
- 比對成功後，用 `jsonwebtoken` 簽發一個自訂 JWT，`role` claim 直接設成 `app_admin` 或 `app_driver`（司機的還會帶 `driver_id`）
- 前端把這個 token 存進 localStorage，之後每個 Supabase 請求都帶著它（見 `js/supabase-client.js`）
- **關鍵機制**：PostgREST 會讀 JWT 的 `role` claim，自動切換成對應的 Postgres 角色（`app_admin`/`app_driver`，定義在 `supabase/schema.sql` 的 PART 2），不需要 Supabase Auth 的 `auth.users`。這是 Supabase/PostgREST 官方支援的「自訂角色」模式。
- 簽 JWT 要用 Supabase 專案的 **JWT Secret**（Project Settings → API → JWT Settings，舊版共用密鑰），不是 anon key 也不是 service role key。

PIN/代碼登入的 UX 跟 demo 完全一樣，司機、主控都不用學新的登入方式。

### 2. 請款金額計算搬進資料庫觸發器，不信任前端

demo 的 `tripBilling()` 是純前端 JS 函式。正式版裡，如果讓前端算好金額再寫入資料庫，司機端理論上能竄改請款金額（畢竟司機的 Supabase 連線也是同一把 anon key）。所以：

- `supabase/schema.sql` 裡的 `compute_trip_billing()` trigger function 完整移植了 `tripBilling()` 的邏輯（共配拆分＋餘數分配＋flat_per_trip 通路獨立計算），只在車趟狀態轉為 `completed` 的那次 UPDATE 觸發
- 司機端的 Postgres 權限（見 schema.sql 的 `grant update (status, has_issue, issue_note) on assignments to app_driver`）**只能改 status/has_issue/issue_note**，完全碰不到金額欄位
- `js/data-layer.js` 的 `markAssignmentComplete()` 送出 UPDATE 後會重新 fetch 該筆車趟，拿觸發器算好的凍結金額，不會用前端自己算的數字

## 檔案結構

```
claude code/
├── supabase/schema.sql       單一權威 schema：表格＋RBAC角色＋RLS policies＋
│                              請款計算觸發器＋Storage bucket policies
├── migration/
│   ├── migrate.js             一次性腳本：把 real_data.json 匯入 Supabase
│   │                           （已用真實資料驗證過所有欄位對應，包含真實的
│   │                           5個通路、3位司機、6條路線、22筆車趟、21張照片）
│   └── .env.example           需要 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
├── api/
│   ├── auth-driver.js         Vercel Serverless Function，驗證4碼代碼
│   └── auth-admin.js          Vercel Serverless Function，驗證PIN
├── lib/rateLimit.js           登入失敗次數限制（防暴力猜代碼/PIN）
├── vercel.json                安全性 headers
├── package.json               api/ 用到的依賴（@supabase/supabase-js, jsonwebtoken）
├── index.html                 主程式（demo原班UI/render邏輯，資料層已換掉）
└── js/
    ├── supabase-client.js     建立 Supabase client，帶上登入token
    ├── auth.js                登入畫面 + 呼叫 /api/auth-*
    └── data-layer.js          取代 loadData/saveData，約30個CRUD函式
```

## 部署步驟（Supabase / GitHub / Vercel 帳號都已建好）

1. Supabase SQL Editor 執行 `supabase/schema.sql`（一次全部跑完）
2. 照 `migration/` 的說明跑 `migrate.js`，把 `real_data.json` 匯入
3. `js/supabase-client.js` 填入該專案的 `SUPABASE_URL` / `SUPABASE_ANON_KEY`（這兩個是公開值，可以直接寫進程式碼提交）
4. push 到 GitHub，Vercel 匯入這個 repo（Framework Preset 選 "Other"，不需要 build command，會自動辨識 `/api` 資料夾）
5. Vercel 專案的 Environment Variables 填：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_JWT_SECRET`（這三個是機密值，只給後端用，不要出現在前端程式碼）
6. 部署後用真實司機代碼、主控PIN實際登入測試一次，確認 RLS 權限沒有擋錯地方

## 已知、故意擱置的缺口

**30天照片自動清除沒有實作**。demo 原本是「每次開系統時，把記憶體裡超過30天的照片欄位清空」，這招在正式版行不通（照片存在 Supabase Storage，不會因為某人開系統就被清）。需要另外做一支排程（例如 Supabase pg_cron + Edge Function），定期找出 `assignment_drop_points` 裡 `completed_at` 超過30天、`photo_cleared=false` 的資料列，砍掉 Storage 物件、把 `photo_url` 設回 null、`photo_cleared` 設成 true。目前這個排程還沒建，短期內的影響只是舊照片會持續留在 Storage 裡多佔空間，不影響功能正確性。

## 交接時建議提醒接手者的事

- `supabase/schema.sql` 是「單一權威版本」，裡面已經整合了所有討論過程中的修正（例如 `channels` 表補上 `formula_type`/`rate_km`/`rate_point`/`flat_amount` 這幾個必要欄位；一開始使用者提供的手寫schema漏了這幾個，若沒有這些欄位整套請款拆分邏輯無法還原）
- `migration/schema_patch.sql` 已經標記停用（內容併入 schema.sql 了），不需要理它
- 不要重新加回 demo 原本的「匯入JSON覆蓋全系統」功能——這個決定是跟業主討論過的，理由是 Supabase 本身有資料庫層級備份機制，這種土法煉鋼的覆蓋式匯入在關聯式資料庫上風險較高
