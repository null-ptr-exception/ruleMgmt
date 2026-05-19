# Import Wizard 範例集

每個範例包含兩份檔案：
- `*-template.yaml` → Import Wizard Step 1（Template 定義）
- `*-data.csv`      → Import Wizard Step 2（Alert 資料）

---

## 範例清單

| 編號 | 情境 | Preset | 重點特性 |
|------|------|--------|---------|
| [01-basic-3tier](#01) | 基礎三水位 | `single-threshold-3tier` | 最簡寫法，直接 `metricExpr` |
| [02-expr-template](#02) | 共用 expr 形狀 | `single-threshold-3tier` | `exprTemplate` + `metric` 短寫 |
| [03-multi-tier](#03) | 三水位獨立定義 | `multi-tier-threshold` | `thresholds.info/warn/crit` |
| [04-warn-crit](#04) | 兩水位警告 | `warn-crit-threshold` | `thresholds.warn/crit` 只有兩層 |
| [05-absence-check](#05) | 服務存活監控 | `absence-check` | CSV 無 threshold 欄 |
| [06-mixed-presets](#06) | 完整微服務套件 | 混合 | 同一 template 跨 group override preset |

---

## 可用 Preset 快速參照

| Preset ID | 觸發條件 | Template 需定義 | CSV threshold 欄 |
|-----------|---------|----------------|-----------------|
| `single-threshold-3tier` | `metric > threshold` | `threshold` (root/group/leaf) | 選填（可 per-row override）|
| `multi-tier-threshold`   | `metric > threshold` | `thresholds.info/warn/crit` | 不使用（定義在 template）|
| `warn-crit-threshold`    | `metric > threshold` | `thresholds.warn/crit` | 不使用（定義在 template）|
| `absence-check`          | `metric == 0`        | 不需要 | 不使用 |

---

## 各範例說明

<a id="01"></a>
### 01 — 基礎三水位（`single-threshold-3tier`）

最簡單的用法。定義一個 `threshold`，系統自動展開：
- **info** = threshold × 50%
- **warn** = threshold × 75%
- **crit** = threshold × 100%

threshold 繼承順序：leaf > group > root > preset default (0.9)

---

<a id="02"></a>
### 02 — exprTemplate 共用 expr 形狀

多個 leaf 共用相同的 expr 包裝（如 `1 - ({{metric}})`），只在 leaf 填入差異部分。
若個別 leaf 需要不同形狀，直接用 `metricExpr:` 覆蓋。

```
exprTemplate: "1 - ({{metric}})"
  └── metric: available_bytes / total_bytes
      → resolved: 1 - (available_bytes / total_bytes)
```

---

<a id="03"></a>
### 03 — 三水位獨立定義（`multi-tier-threshold`）

三個 tier (info/warn/crit) 各自定義數值，不再按比例推算。
適合延遲、佔比等需要非線性水位的指標。

`thresholds` 定義在 template（group 或 leaf），CSV 只需 `name,cluster,app`。

---

<a id="04"></a>
### 04 — 兩水位警告（`warn-crit-threshold`）

只有 warn / crit 兩個水位，無 info 層。
適合錯誤率、重試率等「一旦出現就警告」的指標。

---

<a id="05"></a>
### 05 — 服務存活監控（`absence-check`）

`metric == 0` 時觸發，固定 critical，無水位概念。
適合 `up` 指標、heartbeat 監控。CSV 不需要 `threshold` 欄位。

---

<a id="06"></a>
### 06 — 混合 Preset（完整微服務套件）

同一份 template 混用四種 preset，由各 group 自行 override。
展示完整的繼承鏈：root preset → group override → leaf override。

```
preset: single-threshold-3tier (global)
  ├── resource/  → single-threshold-3tier (inherited)
  ├── latency/   → multi-tier-threshold   (group override)
  ├── error/     → warn-crit-threshold    (group override)
  └── svc/       → absence-check         (group override)
```
