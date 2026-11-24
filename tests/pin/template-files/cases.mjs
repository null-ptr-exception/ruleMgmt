// The input table of the template-files pin (see harness.mjs): one row per
// state of a Template's files. The base repo holds the Templates below, each
// made the way AlertForge makes one (New Template, then Save of its rules/),
// each with one folder deployment deployments/<chart>/d; a row starts from it
// and changes the files it names.
//
// chart:   the Template the row is about (charts/<chart>)
// files:   { 'path from the repo root': spec } — the forms of
//          tests/pin/lib/repoState.mjs `put`: text, { mode: 0, content },
//          { dir: true }, { link }, { remove: true }, { dirMode: 0 }
// edits:   { 'path': text => text } — a change to the base repo's file
// setup:   'copy-dot' | 'link-inside' | 'link-outside' — moves the whole
//          Template folder (harness.mjs)
// promise: { alert: at least this many } the deployment must render, when
//          the row changes what the base chart promises (BASE[chart].promise)
import fs from 'fs'
import path from 'path'

const LEGACY_DIR = path.resolve(import.meta.dirname, '../../fixtures/legacy-1x')
const read = rel => fs.readFileSync(path.join(LEGACY_DIR, rel), 'utf-8')

// A Template with every kind of group a Prometheus 2 chart has: Common
// Values with the row identity label, vars, derived values, a group `name:`,
// a once group.
const P2_RULES = {
  '_common.yaml': 'rowIdentity: true\ncolumns:\n  team: {type: string, required: true}\n  base: {type: integer, default: 4}\n',
  'cpu.yaml': `name: CPU usage
vars:
  r: rate(cpu{job="\${job}",team="\${team}"}[\${window}])
columns:
  job: {type: string, required: true}
  threshold: {type: number, default: 80}
  window: {type: duration, default: 5m}
  freq: {type: integer, default: 1}
derived:
  w: {expr: "freq * base", unit: m}
rules:
  - alert: CpuHigh
    expr: \${r} > \${threshold}
    labels: {severity: warning}
  - alert: CpuRate
    expr: rate(cpu_total{job="\${job}"}[\${w}]) > 0
`,
  'mem.yaml': 'columns:\n  job: {type: string, required: true}\nrules:\n  - alert: MemHigh\n    expr: mem{job="${job}"} > 0.9\n    labels: {severity: warning}\n',
  'up.yaml': 'once: true\nrules:\n  - alert: Down\n    expr: up{team="${team}"} == 0\n',
}
const P2_VALUES = body => `${body}:\n  _common:\n    team: shop\n  cpu:\n    - { job: api }\n    - { job: web, threshold: 70 }\n  mem:\n    - { job: api }\n`
const P2_PROMISE = { CpuHigh: 2, CpuRate: 2, MemHigh: 1, Down: 1 }
const SMALL_RULES = { 'disk.yaml': 'columns:\n  job: {type: string, required: true}\nrules:\n  - alert: DiskFull\n    expr: disk{job="${job}"} > 90\n' }
const SMALL_VALUES = name => `${name}:\n  disk:\n    - { job: api }\n`

// The legacy chart of v1.5.1 (tests/fixtures/legacy-1x): a schema with the
// rules in it and one hand-written templates/prometheus-rule.yaml.
const LEGACY = {
  chart: read('charts/mariadb-alerts/Chart.yaml'),
  values: read('charts/mariadb-alerts/values.yaml'),
  schema: read('charts/mariadb-alerts/values.schema.json'),
  template: read('charts/mariadb-alerts/templates/prometheus-rule.yaml'),
  deployment: read('deployments/mariadb-1/production/values.yaml'),
}
export const LEGACY_TEMPLATE = LEGACY.template
const LEGACY_PROMISE = { MariadbLatencySlowQueries_WarnThreshold: 1, MariadbErrorsConnections_WarnRate: 1 }

// The Templates of the base repo. `rules` are saved through the app; `legacy`
// is copied as it is; `convert` is the legacy chart after `gen-rules`;
// `schema` (custom) is written before the save, for it to carry over.
export const BASE = {
  p2: { rules: P2_RULES, deployment: P2_VALUES('p2'), promise: P2_PROMISE, tfile: 'cpu' },
  p3: {
    rules: { 'api.yaml': "type: prometheus3\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: ApiErrors\n    expr: rate(http_errors_total{job=\"${job}\"}[5m]) > 1\n    labels: {severity: warning, service.name: '${job}'}\n" },
    deployment: 'p3:\n  api:\n    - { job: api }\n', promise: { ApiErrors: 1 }, tfile: 'api',
  },
  vm: {
    rules: { 'http.yaml': "type: vm\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: HTTPErrors\n    expr: 'WITH (e = rate(http_errors_total{job=\"${job}\"}[5m])) e > 5'\n    labels: {severity: warning}\n" },
    deployment: 'vm:\n  http:\n    - { job: api }\n', promise: { HTTPErrors: 1 }, tfile: 'http',
  },
  vlogs: {
    rules: { 'app.yaml': "type: vlogs\ncolumns:\n  service: {type: string, required: true}\nrules:\n  - alert: AppErrors\n    expr: '_time:5m service:\"${service}\" level:error | stats count() as errors | filter errors:>10'\n    labels: {severity: warning}\n" },
    deployment: 'vlogs:\n  app:\n    - { service: checkout }\n', promise: { AppErrors: 1 }, tfile: 'app',
  },
  custom: {
    schemaFirst: { $schema: 'https://json-schema.org/draft-07/schema#', type: 'object', properties: { hand: { type: 'array', 'x-custom-template': true, items: { type: 'object', properties: { job: { type: 'string' } } } } } },
    handTemplate: { 'hand.yaml': 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: {{ .Release.Name }}-hand\nspec:\n  groups:\n    - name: hand\n      rules:\n        {{- range .Values.hand }}\n        - alert: HandWritten\n          expr: up{job="{{ .job }}"} == 0\n        {{- end }}\n' },
    rules: SMALL_RULES, deployment: 'custom:\n  disk:\n    - { job: api }\n  hand:\n    - { job: api }\n', promise: { DiskFull: 1, HandWritten: 1 }, tfile: 'disk',
  },
  'my-chart': { rules: SMALL_RULES, deployment: SMALL_VALUES('my-chart'), promise: { DiskFull: 1 }, tfile: 'disk' },
  my_chart: { rules: SMALL_RULES, deployment: SMALL_VALUES('my_chart'), promise: { DiskFull: 1 }, tfile: 'disk' },
  legacy: { legacy: LEGACY, deployment: LEGACY.deployment.replace(/^mariadb-alerts:/m, 'legacy:'), promise: LEGACY_PROMISE, tfile: 'prometheus-rule' },
  conv: { legacy: LEGACY, convert: true, deployment: LEGACY.deployment.replace(/^mariadb-alerts:/m, 'conv:'), promise: LEGACY_PROMISE, tfile: 'mariadb-errors-connections' },
}

const P = rel => `charts/p2/${rel}`
const RULE = (extra = '') => `columns:\n  job: {type: string, required: true}\nrules:\n  - alert: MemHigh\n    expr: mem{job="\${job}"} > 0.9\n${extra}`
const OWN_RULE_OBJECT = name => `apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: {{ .Release.Name }}-${name}\nspec:\n  groups:\n    - name: ${name}\n      rules:\n        - alert: Extra\n          expr: vector(1)\n`
// A keyword the generator never writes, added by hand: every row of cpu
// needs a threshold of at least 75 (the deployment has 70).
const withMinimum = text => {
  const s = JSON.parse(text)
  s.properties.cpu.items.properties.threshold.minimum = 75
  return `${JSON.stringify(s, null, 2)}\n`
}
const NO_MEM = { CpuHigh: 2, CpuRate: 2, Down: 1 }

export const CASES = [
  // good Templates of each output profile and kind of group
  { id: 'p2-ok', chart: 'p2' },
  { id: 'p3-ok', chart: 'p3' },
  { id: 'vm-ok', chart: 'vm' },
  { id: 'vlogs-ok', chart: 'vlogs' },
  { id: 'custom-template-ok', chart: 'custom' },
  { id: 'name-dash-ok', chart: 'my-chart' },
  { id: 'name-underscore-ok', chart: 'my_chart' },
  { id: 'legacy-ok', chart: 'legacy' },
  { id: 'converted-ok', chart: 'conv' },
  // hand-written files in templates/
  { id: 'tmpl-extra-own-rules', chart: 'p2', files: { [P('templates/extra-alerts.yaml')]: OWN_RULE_OBJECT('extra') }, promise: { ...P2_PROMISE, Extra: 1 } },
  { id: 'tmpl-underscore-file', chart: 'p2', files: { [P('templates/_extra.yaml')]: OWN_RULE_OBJECT('extra') }, promise: { ...P2_PROMISE, Extra: 1 } },
  // a partial Helm reads as one: defines only, no rule object
  { id: 'tmpl-underscore-helpers', chart: 'p2', files: { [P('templates/_helpers.yaml')]: '{{- define "p2.team" -}}shop{{- end -}}\n' } },
  { id: 'tmpl-folder-named-yaml', chart: 'p2', files: { [P('templates/x.yaml/a.yaml')]: OWN_RULE_OBJECT('x') }, promise: { ...P2_PROMISE, Extra: 1 } },
  { id: 'tmpl-generated-missing', chart: 'p2', files: { [P('templates/mem.yaml')]: { remove: true } } },
  { id: 'tmpl-generated-hand-edited', chart: 'p2', edits: { [P('templates/mem.yaml')]: t => `${t}# edited by hand\n` } },
  { id: 'tmpl-leftover-of-removed-group', chart: 'p2', files: { [P('rules/mem.yaml')]: { remove: true } }, promise: NO_MEM },
  { id: 'tmpl-1x-file-repeats-alerts', chart: 'conv', files: { 'charts/conv/templates/prometheus-rule.yaml': LEGACY.template } },
  { id: 'tmpl-dir-unreadable', chart: 'p2', files: { [P('templates')]: { dirMode: 0 } } },
  // rules/
  { id: 'rules-absent', chart: 'p2', files: { [P('rules')]: { remove: true } } },
  { id: 'rules-empty', chart: 'p2', files: { [P('rules')]: { dir: true } } },
  { id: 'rules-dir-unreadable', chart: 'p2', files: { [P('rules')]: { dirMode: 0 } } },
  { id: 'rules-file-unreadable', chart: 'p2', files: { [P('rules/mem.yaml')]: { mode: 0, content: P2_RULES['mem.yaml'] } } },
  { id: 'rules-file-is-folder', chart: 'p2', files: { [P('rules/mem.yaml')]: { dir: true } } },
  { id: 'rules-dangling-link', chart: 'p2', files: { [P('rules/mem.yaml')]: { link: 'nowhere.yaml' } } },
  { id: 'rules-link-inside', chart: 'p2', files: { [P('rules/mem.yaml')]: { link: '../../../shared/mem.yaml' }, 'shared/mem.yaml': P2_RULES['mem.yaml'] } },
  { id: 'rules-link-outside', chart: 'p2', files: { [P('rules/mem.yaml')]: { link: '__OUTSIDE__' } } },
  { id: 'rules-not-yaml', chart: 'p2', files: { [P('rules/mem.yaml')]: 'columns: [\n' } },
  { id: 'rules-labels-scalar', chart: 'p2', files: { [P('rules/mem.yaml')]: RULE('    labels: foo\n') } },
  { id: 'rules-labels-key-value-list', chart: 'p2', files: { [P('rules/mem.yaml')]: RULE('    labels:\n      - {key: severity, value: warning}\n') } },
  { id: 'rules-expr-list', chart: 'p2', files: { [P('rules/mem.yaml')]: 'columns:\n  job: {type: string, required: true}\nrules:\n  - alert: MemHigh\n    expr: [x]\n' } },
  { id: 'rules-once-group-empty-map', chart: 'p2', files: { [P('rules/up.yaml')]: '{}\n' } },
  { id: 'rules-duplicate-key', chart: 'p2', files: { [P('rules/mem.yaml')]: RULE('    expr: mem > 1\n') } },
  { id: 'rules-duplicate-group-name', chart: 'p2', files: { [P('rules/mem.yaml')]: `name: CPU usage\n${RULE()}` } },
  { id: 'rules-unknown-column', chart: 'p2', files: { [P('rules/mem.yaml')]: 'columns:\n  job: {type: string, required: true}\nrules:\n  - alert: MemHigh\n    expr: mem{job="${job}"} > ${limit}\n' } },
  { id: 'rules-group-constructor', chart: 'p2', files: { [P('rules/constructor.yaml')]: RULE().replace('MemHigh', 'CtorHigh') } },
  { id: 'rules-file-proto', chart: 'p2', files: { [P('rules/__proto__.yaml')]: RULE().replace('MemHigh', 'ProtoHigh') } },
  { id: 'rules-column-proto', chart: 'p2', files: { [P('rules/mem.yaml')]: 'columns:\n  job: {type: string, required: true}\n  __proto__: {type: string}\nrules:\n  - alert: MemHigh\n    expr: mem{job="${job}"} > 0.9\n' } },
  { id: 'common-not-yaml', chart: 'p2', files: { [P('rules/_common.yaml')]: 'columns: [\n' } },
  { id: 'common-unreadable', chart: 'p2', files: { [P('rules/_common.yaml')]: { mode: 0, content: P2_RULES['_common.yaml'] } } },
  { id: 'common-absent', chart: 'p2', files: { [P('rules/_common.yaml')]: { remove: true } } },
  // values.schema.json
  { id: 'schema-absent', chart: 'p2', files: { [P('values.schema.json')]: { remove: true } } },
  { id: 'schema-stale', chart: 'p2', files: { [P('values.schema.json')]: '{\n  "type": "object",\n  "properties": {}\n}\n' } },
  { id: 'schema-not-json', chart: 'p2', files: { [P('values.schema.json')]: '{ "type": \n' } },
  { id: 'schema-bom', chart: 'p2', edits: { [P('values.schema.json')]: t => `\uFEFF${t}` } },
  { id: 'schema-hand-keyword', chart: 'p2', edits: { [P('values.schema.json')]: withMinimum } },
  { id: 'schema-unreadable', chart: 'p2', files: { [P('values.schema.json')]: { mode: 0, content: '{}' } } },
  { id: 'legacy-schema-not-json', chart: 'legacy', files: { 'charts/legacy/values.schema.json': '{ "type": \n' } },
  // the Template's values.yaml
  { id: 'tvalues-absent', chart: 'p2', files: { [P('values.yaml')]: { remove: true } } },
  { id: 'tvalues-not-yaml', chart: 'p2', files: { [P('values.yaml')]: 'cpu: [\n' } },
  { id: 'tvalues-trailing-dashes', chart: 'p2', files: { [P('values.yaml')]: '{}\n---\n' } },
  { id: 'tvalues-two-documents', chart: 'p2', files: { [P('values.yaml')]: 'mem: []\n---\nmem:\n  - { job: other }\n' } },
  { id: 'tvalues-yaml11', chart: 'p2', files: { [P('values.yaml')]: '_common:\n  base: 010\n  team: yes\n' } },
  // a block text with an indentation digit: Helm reads it, AlertForge
  // cannot tell how
  { id: 'tvalues-cannot-tell', chart: 'p2', files: { [P('values.yaml')]: '_common:\n  team: |2\n    platform\n' } },
  { id: 'tvalues-common', chart: 'p2', files: { [P('values.yaml')]: '_common:\n  team: platform\n' } },
  { id: 'tvalues-required-common-only-there', chart: 'p2', files: { [P('values.yaml')]: '_common:\n  team: platform\n', 'deployments/p2/d/values.yaml': 'p2:\n  cpu:\n    - { job: api }\n    - { job: web, threshold: 70 }\n  mem:\n    - { job: api }\n' } },
  { id: 'tvalues-unreadable', chart: 'p2', files: { [P('values.yaml')]: { mode: 0, content: '{}\n' } } },
  { id: 'tvalues-folder', chart: 'p2', files: { [P('values.yaml')]: { dir: true } } },
  // Chart.yaml
  { id: 'chart-absent', chart: 'p2', files: { [P('Chart.yaml')]: { remove: true } } },
  { id: 'chart-unreadable', chart: 'p2', files: { [P('Chart.yaml')]: { mode: 0, content: 'apiVersion: v2\nname: p2\nversion: 0.1.0\n' } } },
  { id: 'chart-not-yaml', chart: 'p2', files: { [P('Chart.yaml')]: 'apiVersion: v2\nname: [\n' } },
  { id: 'chart-version-not-semver', chart: 'p2', files: { [P('Chart.yaml')]: 'apiVersion: v2\nname: p2\nversion: one\ntype: application\nannotations:\n  app: alertforge\n' } },
  { id: 'chart-version-other-than-asked', chart: 'legacy', files: { 'charts/legacy/Chart.yaml': LEGACY.chart.replace('name: mariadb-alerts', 'name: legacy').replace('version: 2.0.0', 'version: 2.1.0') } },
  { id: 'chart-name-not-folder', chart: 'p2', files: { [P('Chart.yaml')]: 'apiVersion: v2\nname: other\nversion: 0.1.0\ntype: application\nannotations:\n  app: alertforge\n' } },
  { id: 'chart-no-annotation', chart: 'p2', files: { [P('Chart.yaml')]: 'apiVersion: v2\nname: p2\nversion: 0.1.0\ntype: application\n' } },
  // the Template folder itself
  { id: 'name-dot', chart: 'p2.v2', setup: 'copy-dot' },
  { id: 'folder-link-inside', chart: 'p2', setup: 'link-inside' },
  { id: 'folder-link-outside', chart: 'p2', setup: 'link-outside' },
]
