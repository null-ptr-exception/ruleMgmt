# Spec: Alert Template Inheritance & Bulk Import Wizard

**Date**: 2026-05-18
**Type**: feature

## Background

目前系統中每個 alert type 是獨立的 template 檔案（`gitops/charts/{chart}/templates/{name}.yaml`），骨架與 metric 邏輯混在同一個檔案裡。`_meta` 各自定義 vars，彼此之間沒有繼承關係。

使用者需分兩頁分別操作：TemplateDevEditor（寫 YAML + 定義 vars）和 AlertUserView（填 instance 資料），無法一次匯入就建立完整的告警規則樹。

## Requirements

- **三層架構**：
  - Layer 1 Preset：系統內建計算邏輯 + label 結構，儲存在 `gitops/charts/_presets/templates/`，新增 Preset 只需放入 YAML 檔不需改程式碼
  - Layer 2 Child Template：繼承一個 Preset，可 override tier 數量、for duration、label 結構；以 `_meta` 的 `preset` / `override` / `defaults` 欄位儲存（現有格式延伸，無新檔案類型）
  - Layer 3 Table：一張含 `name` 欄位的表，`name` 使用底線命名，系統自動從 `name` 前綴展開樹狀結構（沿用現有 `buildTree()` 邏輯）

- **內建 Preset**（至少三種）：
  - `multi-tier-threshold`：`{{ .metric_expr }} > threshold`，支援 info/warn/crit 三層
  - `ratio-threshold`：`numerator / denominator > threshold`，warn/crit 兩層
  - `absence-check`：`{{ .metric_expr }} == 0`，crit only

- **Import Wizard**（整合進現有 TemplateDevEditor）：
  - Step 1：選擇 Preset（卡片式選單）
  - Step 2：匯入 Table（CSV 上傳 / 貼上 YAML），自動偵測 name 欄位展示樹狀預覽
  - Step 3：為每個偵測到的 leaf 定義 Child 設定（alertName、metric_expr 預設值、選填 override）
  - Step 4：Render 預覽（每個 leaf 取 row[0] sample render + 統計摘要；有錯誤才展開 log）
  - Step 5：確認儲存

- **各步驟驗證**：
  - Step 2：name 欄位存在、必填欄位（cluster, app）不為空、number 型別合法、至少一列
  - Step 3：metric_expr 非空、alertName 不重複；PromQL 格式疑慮為警告（非阻擋）
  - Step 4：render 成功才可往下

- **Child metric_expr 為程度 2 參數化**：Child 定義預設值，Table row 可選填覆寫

## Out of Scope

- Table 稀疏欄位的 UI 優化（分色分區塊顯示）
- 現有 non-inherited templates 的自動遷移
- Preset 的 UI 管理介面（新增 Preset 直接放檔案）
- Multi-user 並發控制

## Open Questions

- 現有 AlertUserView 讀取含 `preset` 的 `_meta` 時，是否需要調整讀取邏輯？
- `_presets` chart 是否要在 ChartSelector 中隱藏（不讓使用者當一般 chart 操作）？

## Proposed Issues

1. **後端：Preset 基礎設施**
   - 建立 `gitops/charts/_presets/` 目錄與三個內建 Preset YAML
   - `server/routes/templates.js` 支援 `preset` / `override` / `defaults` 讀寫
   - 新增 `/api/v2/presets` 端點列出可用 Preset

2. **後端：Wizard 匯入 API**
   - 新增 `/api/v2/import` 端點，一次接收 preset、child 定義清單、table 資料
   - 執行驗證、render sample、寫入 `_meta` 與 deployment values

3. **前端：Import Wizard UI**
   - 在 TemplateDevEditor sidebar 新增 `[+ Import Wizard]` 入口
   - 實作 Step 1–5 的 Wizard 元件（含各步驟驗證與錯誤提示）
   - Step 4 Render 預覽（sample + 統計摘要 + error log）
