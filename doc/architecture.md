# Architecture

> **Parts of this document are out of date** — the page and component names
> below predate several rounds of change. For how a chart describes alerts and
> how templates are generated from it, see [alert-rules.md](alert-rules.md);
> for how to do things, [how-to.md](how-to.md). Both are current.

## Overview

Alert Template UI is a local-first, filesystem-backed tool for authoring and deploying Prometheus Operator alerting configurations. It has no database — all state lives in versioned Helm charts on disk. A lightweight Express API serves the frontend and delegates rendering to `helm template`.

```
Browser (React 18 / Vite)
        │  /api  (Vite proxy → :3001)
        ▼
Express API (server.js, ES modules)
        │
        ├── Read / write YAML files  (js-yaml)
        ├── Spawn:  helm dependency update
        │           helm template
        └── Inline: route pruning algorithm
                    PrometheusRule import scanner
```

---

## Directory Layout

```
alerttemplateui/
├── server.js               # Express API server (single file, ES module)
├── vite.config.js          # Vite + proxy config
├── src/
│   ├── App.jsx             # Top-level nav shell
│   ├── pages/              # One file per editor page
│   │   ├── AlertTypeEditor.jsx
│   │   ├── AlertSuiteEditor.jsx
│   │   ├── ReceiversEditor.jsx
│   │   ├── AlertmanagerSmartEditor.jsx   # AM Config (primary routing editor)
│   │   ├── GitopsEditor.jsx
│   │   └── PromQLEditor.jsx
│   ├── components/
│   │   ├── KVEditor.jsx        # Generic key-value table
│   │   ├── VersionModal.jsx    # Save-as / version bump dialog
│   │   ├── PromQLEditor.jsx    # CodeMirror wrapper
│   │   └── PromQLBuilder.jsx   # Guided builder UI
│   └── utils/
│       ├── api.js              # Typed fetch wrappers for all endpoints
│       └── templateUtils.js    # Shared YAML helpers
├── templates/              # Helm chart filesystem (source of truth)
│   ├── alert-type/
│   ├── alert-suite/
│   ├── receivers/
│   └── amconfig/
├── gitops-deploy/          # GitOps stage charts (generated)
├── scripts/
│   └── prune_routes.py     # Standalone CLI route pruning tool
└── config/
    └── defaults.yaml       # Global defaults (groupWait, intervals, etc.)
```

---

## Template Hierarchy

Templates are independent Helm charts. The dependency chain flows in one direction:

```
alert-type          (leaf — no dependencies)
    ▲
alert-suite         (depends on one or more alert-types via Helm deps)
    ▲
amconfig            (depends on one or more alert-suites)
    ▲
gitops-deploy stage (depends on one amconfig)
```

Each level adds a layer of parameterisation:

| Level | Adds |
|---|---|
| alert-type | `expr` template, var names/descriptions |
| alert-suite | Concrete var values, severity, groupLabels, rules list |
| amconfig | Route tree, inhibit rules, receivers, namespace filter |
| gitops stage | Product/site/relunit context (`global.product`) |

### Filesystem layout per template

```
templates/{type}/{name}/{version}/
├── Chart.yaml          # name, version, dependencies[]
├── values.yaml         # template data (the UI's source of truth)
└── templates/
    └── *.yaml          # Go template files rendered by helm template
```

---

## API Server (`server.js`)

All routes are under `/api`. The server is a single ES-module file with no framework beyond Express.

### Template CRUD

| Method | Path | Action |
|---|---|---|
| GET | `/api/templates/:type` | List all names + versions for a type |
| GET | `/api/templates/:type/:name/:version` | Read `values.yaml` (parsed + raw) |
| POST | `/api/templates/:type/:name/:version` | Write `values.yaml`; create `Chart.yaml` if new |
| DELETE | `/api/templates/:type/:name/:version` | Remove version folder |
| GET | `/api/templates/:type/:name/:version/chartmeta` | Read `Chart.yaml` metadata |

### GitOps Deploy

| Method | Path | Action |
|---|---|---|
| GET | `/api/gitops/product` | Read product name from `gitops-deploy/` |
| POST | `/api/gitops/product` | Rename product folder |
| GET | `/api/gitops/:product/sites` | List site folders |
| POST | `/api/gitops/:product/sites` | Create site folder |
| DELETE | `/api/gitops/:product/:site` | Delete site |
| GET | `/api/gitops/:product/:site/relunits` | List relunit folders |
| POST | `/api/gitops/:product/:site/relunits` | Create relunit |
| DELETE | `/api/gitops/:product/:site/:relunit` | Delete relunit |
| GET | `/api/gitops/:product/:site/:relunit/:stage` | Read stage `values.yaml` |
| POST | `/api/gitops/:product/:site/:relunit/:stage` | Write stage; create `Chart.yaml` if new |
| DELETE | `/api/gitops/:product/:site/:relunit/:stage` | Remove stage folder |

### Utilities

| Method | Path | Action |
|---|---|---|
| GET | `/api/defaults` | Read `config/defaults.yaml` |
| POST | `/api/defaults` | Write `config/defaults.yaml` |
| GET | `/api/metrics-dict` | Read metrics dictionary |
| POST | `/api/metrics-dict` | Write metrics dictionary |
| GET | `/api/import/prometheus-rules` | Scan filesystem for PrometheusRule YAMLs |
| POST | `/api/prune-routes` | Run route pruning algorithm (pure JS) |
| POST | `/api/helm/render/:product/:site/:relunit/:stage` | Run `helm template` on a stage |

---

## Frontend Pages

### Alert Type Editor

Manages `templates/alert-type/` entries. Each alert type stores:
- `expr` — a Go template string with `{{ .varName }}` placeholders
- `vars[]` — name + description for each placeholder

The editor renders a live preview of the filled `expr` and a PrometheusRule skeleton.

### Rule Group Editor (Alert Suite)

Manages `templates/alert-suite/` entries. Each rule group stores:
- `alertSuite.rules[]` — concrete instances of alert types with resolved `expr`, `vars`, `severity`, `for`, `labels`
- `alertSuite.groupLabels` — Kubernetes labels attached to the PrometheusRule group

Rules reference an alert type by `alertTypeName` + `alertTypeVersion`. The editor can import existing PrometheusRule YAMLs from the filesystem (via `/api/import/prometheus-rules`) and auto-fill the rule table, including scanning `spec.groups[].labels` as `groupLabels`.

### Receivers Editor

Manages `templates/receivers/` entries. Supports four config types per receiver entry: `webhook_configs`, `slack_configs`, `pagerduty_configs`, `email_configs`.

### AM Config Editor (`AlertmanagerSmartEditor`)

The main Alertmanager configuration editor. Manages `templates/amconfig/` entries.

**Form sections:**

| Section | Fields |
|---|---|
| Header | `configName`, `defaultReceiver` |
| Rule Groups | List of `alert-suite` name+version pairs (rendered into Helm dependencies) |
| Route Matchers | `spec.route.matchers` — top-level namespace / label filter applied before child routes |
| Route Configuration | Flat list of `{receiver, matchers[]}` route rules; Original / Pruned toggle |
| Inhibit Rules | `spec.inhibitRules[]` — source matchers, target matchers, equal label names |
| Receivers | Embedded receiver configs (same format as Receivers editor) |

**Route modes:**

- **Original** — route rules rendered as a flat list in YAML
- **Pruned** — routes sent to `POST /api/prune-routes`; result is a synthesized trie tree displayed in preview and stored on save

**Autocomplete sources:**
- Receiver names — from the embedded receivers list
- Label keys / alertnames — derived from all loaded rule group data
- Severity values — hardcoded `critical`, `warning`, `info`
- Alertname values — rule names from loaded alert-suite templates

### GitOps Deploy Editor

Tree view: `product → sites → relunits → stages`. Each stage stores a `values.yaml` that scopes overrides under the amconfig chart name key. The editor can:
- Toggle stages on/off (creates/removes the stage folder)
- Assign an amconfig template
- Run `helm template` and display the rendered YAML

### PromQL Builder

CodeMirror 6 editor with `@prometheus-io/codemirror-promql` for syntax highlighting and autocomplete. Includes a guided builder panel backed by a user-maintained metrics dictionary.

---

## Route Pruning Algorithm

The pruning algorithm converts a flat list of routes into an optimal trie, reducing Alertmanager routing work by hoisting shared matchers into parent nodes.

### Steps

1. **Strip top-level matchers** — `spec.route.matchers` are implicit for all children; remove them from every child route to avoid redundancy.

2. **Build trie** (recursive):
   a. Index all matchers → which routes contain them.
   b. Find matchers shared by 2+ routes (candidates for hoisting).
   c. For each unique group of routes sharing a matcher, compute the full intersection of all matchers across every route in that group.
   d. Pick the best group: maximise (number of routes grouped, then number of matchers hoisted).
   e. Create a synthetic parent node with the intersection matchers; assign the most-common receiver as parent receiver.
   f. Children keep only their differentiating matchers. Drop children that are identical to the parent.
   g. Recurse on children, then on remaining ungrouped routes.

### Example

Input (flat):
```yaml
- receiver: pd       matchers: [severity=critical, team=infra]
- receiver: slack    matchers: [severity=warning,  team=infra]
- receiver: email    matchers: [severity=warning,  team=api]
```

Output (pruned):
```yaml
- receiver: pd
  matchers: [team=infra]
  routes:
    - receiver: pd      matchers: [severity=critical]
    - receiver: slack   matchers: [severity=warning]
- receiver: email
  matchers: [severity=warning, team=api]
```

### Implementations

| Location | Use |
|---|---|
| `server.js` — `buildRouteTree()` | Server-side, called by `/api/prune-routes`; result used for YAML preview and saved values |
| `src/pages/AlertmanagerSmartEditor.jsx` — `pruneRoutes()` | Client-side fallback (basic subset detection only) |
| `scripts/prune_routes.py` | Standalone CLI for manual inspection; same algorithm, PyYAML output |

---

## Helm Template Conventions

### Recursive route rendering

`amconfig` uses a named Go template to render arbitrarily nested route trees:

```yaml
{{- define "amconfig.routes" -}}
{{- range . }}
- receiver: {{ .receiver | quote }}
  {{- if .matchers }}
  matchers:
    {{- range .matchers }}
    - name: {{ .key | quote }}
      matchType: {{ .op | quote }}
      value: {{ .value | quote }}
    {{- end }}
  {{- end }}
  {{- if .routes }}
  routes:
{{ include "amconfig.routes" .routes | indent 4 }}
  {{- end }}
{{- end }}
{{- end }}
```

### Product prefixing

`global.product` is injected by the GitOps stage chart. When set, it prefixes:
- `metadata.name` on all CRs
- Receiver names in routes and receiver definitions

This allows multiple products to share a single Alertmanager instance without name collisions.

### Stage `Chart.yaml` formula

```yaml
apiVersion: v2
name: {relunit}-{stage}
version: 0.1.0
dependencies:
  - name: {amconfig-chart-name}
    version: "{version-without-v}"
    repository: "file://../../../../../templates/amconfig/{name}/{version}"
```

The `file://` path is always 5 `../` levels up from the stage folder to the repo root.

---

## Data Flow: Save an AM Config

```
User edits form
    │
    ▼
buildPayload()              # serialise form → plain JS object
    │
    ├── routeMode = 'pruned' ?
    │       └── prunedRouteTree ?? pruneRoutes(flat)  →  routeRules
    │
    ▼
saveTemplate('amconfig', name, version, payload)
    │
    ▼
POST /api/templates/amconfig/:name/:version
    │
    ├── js-yaml.dump(payload)  →  values.yaml
    └── create Chart.yaml + templates/ if new version
```

## Data Flow: Helm Render

```
User clicks "Render" on a GitOps stage
    │
    ▼
POST /api/helm/render/:product/:site/:relunit/:stage
    │
    ├── helm dependency update  (amconfig chart)
    ├── helm dependency update  (stage chart)
    └── helm template {relunit}-{stage} .
            │
            └── stdout → res.json({ yaml: ... })
```

---

## Kubernetes CRDs Produced

| CRD | API Version | Produced by |
|---|---|---|
| `PrometheusRule` | `monitoring.coreos.com/v1` | `templates/alert-suite/.../prometheus-rule.yaml` |
| `AlertmanagerConfig` | `monitoring.coreos.com/v1alpha1` | `templates/amconfig/.../alertmanager-config.yaml` |
