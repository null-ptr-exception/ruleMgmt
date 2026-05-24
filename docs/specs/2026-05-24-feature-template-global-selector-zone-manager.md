# Spec: Template Global Selector & Zone Manager

**Date**: 2026-05-24
**Type**: feature

## Background

當前的 Template 系統缺乏「套用範圍」的概念——一個 template 可以被套用在任何地方，無法在 template 層級限制它只適用於特定 cluster、group 或 instance。此外，目前沒有 Zone（Prometheus/VM instance）層級的管理介面，無法清楚地看到哪個 Zone 套用了哪些 template，也無法管理 template 的 global selector 值。

## Requirements

### Feature 1 — Template Global Selector

#### 1.1 Global Selector 定義
- 每個 template（chart）在 schema 層級新增 `x-global-selectors: []` 欄位，宣告哪些 selector key 屬於 global selector（例如 `["cluster", "group"]`）
- Global selector key 在 PromQL 中以現有的 `{{ .keyName }}` 語法嵌入，與現有 selectors/thresholds 使用相同語法，但在 schema 中以獨立欄位宣告，不影響現有 var 機制
- Template 編輯頁（TemplateDevEditor）新增「Global Selectors」區塊，允許新增／移除 global selector key 及其描述

#### 1.2 Validation 規則（per rule）
- 判定單位為單一 rule（每個 alert group 的 `x-promql` 表達式），不是 rule group
- Save 時：若某 rule 的 PromQL 未包含任何 global selector placeholder，顯示提示並提供「Auto-fix」按鈕
  - Auto-fix 行為：將 `keyName="{{ .keyName }}"` 注入至該 rule PromQL 中所有 `{...}` label block；若 PromQL 無 `{}` block，直接在 metric 名稱後附加 `{keyName="{{ .keyName }}"}`
  - 使用者點擊確認後才執行，行為透明可預期
- Save 時：若整個 template 完全沒有任何 rule 嵌入 global selector，顯示警告 dialog，要求使用者按下確認才能儲存（允許繼續但需明確確認）

#### 1.3 Clone Template
- Template 列表新增 Clone 操作，複製整個 chart（schema、PromQL、所有 alert groups）
- Clone 後產生新的獨立 chart，名稱由使用者輸入
- Clone 的 chart 與原本完全獨立，修改互不影響

#### 1.4 Remove Template
- 現有 Delete 功能已支援，確認 dialog 措辭更新為 `Delete chart "{name}" and all its alert groups?`

---

### Feature 2 & 3 — Zone Manager

#### 2.1 Zone 概念
- Zone = 一個 Prometheus / VictoriaMetrics instance（共用 data source 的範圍）
- 存放於 repo 內 `zones/{zone-name}/` 目錄（同一 repo，不同 folder）：
  - `zones/{zone-name}/zone.yaml`：Zone 基本資訊（name, type: `prometheus` | `victoriametrics`）
  - `zones/{zone-name}/bindings.yaml`：該 Zone 套用的 template bindings

#### 2.2 Binding 結構（`bindings.yaml`）
```yaml
bindings:
  - template: mariadb-saturation
    globalSelectors:
      group: "a"
      cluster: "prod-01"
    enabled: true
  - template: mysql-connection
    globalSelectors:
      group: "b"
    enabled: false
```

#### 2.3 Zone Manager 頁面（新頁面，整合 Feature 2 + 3）
新增側欄選項「Zone Manager」，UI 結構：

```
左側 Sidebar                右側 Panel
─────────────────           ──────────────────────────────────────────
Zone 列表                   Zone: zone-a  (prometheus)
  ▸ zone-a                  ─────────────────────────────────────────
  ▸ zone-b                  [Apply Template]  [Filter: ____________]
  ▸ zone-c
  [+ Add Zone]              Template          Selectors      Enabled  Actions
                            mariadb-sat       group=a        ✓        Edit / Remove
                            mysql-conn        group=b        ✗        Edit / Remove
                            redis-mem         cluster=c1     ✓        Edit / Remove
```

功能細節：
- **左側**：Zone 列表，支援新增 Zone（輸入名稱、選擇類型）及移除 Zone
- **右側 — Apply Template**：選擇 template，填入各 global selector key 的值，建立 binding
- **右側 — Table**：
  - 顯示欄位：Template 名稱、Global Selector 值（key=value，多組以逗號分隔）、Enabled（toggle）、Actions
  - Filter bar：依 template 名稱或 selector key=value 篩選
- **Edit binding**：修改已套用的 global selector 值或 enabled 狀態
- **Remove binding**：從 Zone 移除 template 套用

---

## Out of Scope

- 跨 repo 的 Zone 管理
- Template 內部 PromQL 的完整語法驗證（auto-fix 使用簡單字串操作）
- Zone 與現有 Gitops Deploy 流程的整合（不修改 `gitops-deploy/` 目錄結構）
- Template versioning 機制的調整
- Zone 的 online/offline 狀態監控

## Open Questions

1. **Zone 與現有 Deployment 的關係**：Zone Manager 是否需要與現有 Alerts 頁的 Deployment 概念對齊？目前暫定為獨立功能，不做整合。
2. **多個 global selector 的 Auto-fix**：若 template 定義了兩個 global selector key（例如 `cluster` 和 `group`），auto-fix 是否將兩者都注入同一個 `{}` block？建議：是，一起注入。

## Proposed Issues

1. `feat: add x-global-selectors field and UI block to TemplateDevEditor`
2. `feat: add per-rule global selector validation with auto-fix on save`
3. `feat: add clone chart action to TemplateDevEditor`
4. `feat: implement zones/ directory model and server API (CRUD)`
5. `feat: implement Zone Manager page — zone list and template binding table`
