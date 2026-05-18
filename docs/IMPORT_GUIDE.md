# Import Wizard 使用說明

Import Wizard 讓你用兩份檔案一次建立 alert template 與 deployment values，不需要手動編輯 YAML schema。

---

## 前置條件

1. 啟動 dev server：`npm run dev`
2. 瀏覽器開啟 `http://localhost:5173`
3. 進入 **Template Dev Editor** 頁面
4. 在左上角 chart 選單選擇目標 chart（例如 `infra-saturation`）
5. 點擊左側 sidebar 的 **Import** 按鈕

---

## 兩種輸入檔案

### 1. `alert-template.yaml` — 定義 alert 結構

描述整棵 alert 樹的結構、使用的 preset、PromQL metric expression，以及預設 threshold。

```yaml
preset: single-threshold-3tier   # 全域預設 preset
threshold: 0.9                   # 全域預設 critical threshold

tree:
  <group>:
    threshold: 0.85              # 選填：覆寫此子樹的 threshold
    children:
      <leaf>:
        metricExpr: <PromQL>     # 必填：metric expression（不含比較運算子）
      <leaf>:
        metricExpr: <PromQL>
        threshold: 0.95          # 選填：leaf 層再次覆寫
  <group>:
    preset: absence-check        # 選填：覆寫此子樹的 preset
    children:
      <leaf>:
        metricExpr: <PromQL>
```

**Threshold 繼承順序**：leaf 自身 > 父 group > 全域 > preset default

**可用 Preset**：

| ID | 說明 | Threshold 欄位 |
|---|---|---|
| `single-threshold-3tier` | 輸入一個值，自動展開 info(50%) / warn(75%) / crit(100%) | `threshold` |
| `multi-tier-threshold` | 三個 tier 各自定義 | `thresholds.info` / `thresholds.warn` / `thresholds.crit` |
| `warn-crit-threshold` | 兩個 tier | `thresholds.warn` / `thresholds.crit` |
| `absence-check` | 服務存活檢查（metric == 0 觸發），固定 critical | 不需要 |

---

### 2. `alert-data.csv` / `alert-data.yaml` — 定義 alert 實例

每一列代表一個監控目標（cluster + app）。`threshold` 欄位選填，空值繼承 template 預設值。

**CSV 格式**：

```csv
name,cluster,app,threshold
kpi_cpu_saturation,staging,api-gateway,
kpi_cpu_saturation,staging,worker,0.75
svc_isalive,staging,api-gateway,
```

**YAML 格式**：

```yaml
- name: kpi_cpu_saturation
  cluster: staging
  app: api-gateway
- name: kpi_cpu_saturation
  cluster: staging
  app: worker
  threshold: 0.75        # 只有需要覆寫時才填
- name: svc_isalive
  cluster: staging
  app: api-gateway
```

**欄位規則**：
- `name`：必填，對應 template 的 leaf（格式 `group_leaf`，如 `kpi_cpu_saturation`）
- `cluster`：必填
- `app`：必填
- `threshold`：選填，空值 = 繼承 template 預設

---

## 步驟說明

### Step 1 — Template 定義

1. 貼上 YAML 內容，或點 **Upload file** 上傳 `.yaml` 檔
2. 點 **Parse template**
3. 確認下方 leaf 摘要表正確（name / preset / threshold / metricExpr）
4. 有紅字錯誤須先修正才能前進

### Step 2 — Alert 資料

1. 貼上 CSV 或 YAML 內容，或點 **Upload file** 上傳
2. 點 **Parse data**
3. 確認列表正確；黃色警告（unknown leaf name）代表 CSV 裡有 template 不存在的 name
4. `threshold` 空值顯示為 `—`，代表繼承 template 預設，屬正常

### Step 3 — Preview

- 系統產生 PrometheusRule YAML template（左側）
- 顯示展開後的 resolved values 摘要（threshold 已按比例計算）
- 確認 stats：Leaves / Alert rules / Instances

### Step 4 — 確認儲存

1. 填入 **Deployment name**（例如 `staging` 或 `prod`）
2. 點 **Import**
3. 儲存結果：
   - `gitops/charts/<chart>/values.schema.json` ← alert 結構定義
   - `gitops/charts/<chart>/templates/prometheus-rule.yaml` ← Helm template
   - `gitops/deployments/<chart>/<deployment>-values.yaml` ← 實例數據

---

## 範例檔案

位於 `docs/examples/`：

| 檔案 | 用途 |
|---|---|
| `infra-saturation-template.yaml` | Step 1，定義 kpi_* + svc_isalive |
| `infra-saturation-staging.csv` | Step 2，deployment name: `staging` |
| `infra-saturation-prod.csv` | Step 2，deployment name: `prod` |

**完整測試流程**：

```
1. Template Dev Editor → 選 infra-saturation → Import
2. Step 1: 上傳 infra-saturation-template.yaml → Parse template → Next
3. Step 2: 上傳 infra-saturation-staging.csv  → Parse data    → Next
4. Step 3: 確認 Preview（4 leaves, 10 rules, 11 instances）  → Next
5. Step 4: deployment = staging → Import
6. 重複步驟 1–5，改用 infra-saturation-prod.csv，deployment = prod
```

---

## 注意事項

- 同一個 deployment name 再次 import 會 **merge**（不會整個覆蓋），相同 leaf name 的資料會被取代
- `absence-check` preset 的列不需要填 threshold，留空即可
- Leaf name 必須符合 `[a-z0-9_]` 格式（全小寫、底線分隔）
