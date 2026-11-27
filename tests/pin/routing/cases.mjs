// The input table of the routing pin (see harness.mjs): one row per input,
// each a state of the repo — a deployment's routing.yaml, its generated
// AlertmanagerConfig, the shared notification configs — and, for a save,
// what is sent.
//
// target: A   deployments/t/a, a sync source (B its target)
//         S   deployments/s/x, on the _common stack deployments/s/_common/demo
//         B   deployments/t/b, a's sync target: held to a's routing
//         SH  the shared configs' file, as deployments/t/c uses it
//         L   the _common chart deployments/s/_common/demo, rendered through x
// text:   the subject's routing.yaml (A, S, B), or { mode: 0, content } /
//         { dir: true } / { link } / { remove: true }
// shared: the shared configs' file's content (SH), same forms
// json:   the table the Routing page would send (optional)
// files:  other files of the repo, same forms
// saved:  true — the text is saved through the API first, as the page saves
//         it, so the resource (and the sync target) are made from it
// smtp:   false — the platform's Alertmanager has no global mail server
//         and sender (the reference only: AlertForge cannot see it)

export const DIRS = { A: 'deployments/t/a', B: 'deployments/t/b', C: 'deployments/t/c', S: 'deployments/s/x', L: 'deployments/s/_common/demo' }
export const CR = 'templates/alertmanagerconfig.yaml'
export const SHARED = '_shared/notification-configs.yaml'

const OPS = 'ops: { type: email, to: ops@example.com }'
const HOOK = 'hook: { type: webhook, url: "http://hook.example.com:8080/alert" }'
const LABELS = 'labels:\n  severity: [critical, warning]\n  team: [db, web]\n'
const CELLS = `cells:
  - match: { severity: critical, team: db }
    configs: [ops, hook]
    repeatInterval: 1h
  - match: { severity: warning, team: db }
    configs: [ops]
`
const R = ({ labels = LABELS, defaults = 'defaults: { groupWait: 30s }\n', configs = [OPS, HOOK], cells = CELLS } = {}) =>
  `${labels}${defaults}configs:\n${configs.map(c => `  ${c}\n`).join('')}${cells}`
// One cell, one config: for a config's own fields.
const ONE = (config, extra = '') => `labels:\n  severity: [critical]\nconfigs:\n  only: ${config}\ncells:\n  - match: { severity: critical }\n    configs: [only]\n${extra}`

export const BASE = {
  A: R(),
  C: 'labels:\n  severity: [critical]\nconfigs:\n  relay: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [relay]\n',
  X: ONE('{ type: email, to: x@example.com }'),
  SHARED: 'configs:\n  relay: { type: webhook, url: "http://relay.example.com:8080" }\n',
}

const okJ = {
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  defaults: { groupWait: '30s' },
  configs: { ops: { type: 'email', to: 'ops@example.com' }, hook: { type: 'webhook', url: 'http://hook.example.com:8080/alert' } },
  cells: [{ match: { severity: 'critical', team: 'db' }, configs: ['ops', 'hook'], repeatInterval: '1h' }, { match: { severity: 'warning', team: 'db' }, configs: ['ops'] }],
}
const oneJ = config => ({ labels: { severity: ['critical'] }, configs: { only: config }, cells: [{ match: { severity: 'critical' }, configs: ['only'] }] })
const REF = { name: 'mail', key: 'password' }

export const CASES = [
  // good routing: every kind and field
  { id: 'ok', target: 'A', text: BASE.A, json: okJ },
  { id: 'ok-comment', target: 'A', text: `# kept as written\n${BASE.A}# end\n` },
  { id: 'email-full', target: 'A', text: ONE('{ type: email, to: db@example.com, from: am@example.com, smarthost: "smtp.example.com:587", authUsername: am, authPassword: { name: mail, key: password }, requireTLS: true, tlsConfig: { insecureSkipVerify: false }, sendResolved: true, headers: { Subject: "alert" }, text: "plain", html: "" }'),
    json: oneJ({ type: 'email', to: 'db@example.com', from: 'am@example.com', smarthost: 'smtp.example.com:587', authUsername: 'am', authPassword: REF, requireTLS: true, tlsConfig: { insecureSkipVerify: false }, sendResolved: true, headers: { Subject: 'alert' }, text: 'plain', html: '' }) },
  { id: 'email-auth-identity', target: 'A', text: ONE('{ type: email, to: db@example.com, smarthost: "smtp.example.com:587", authUsername: am, authPassword: { name: mail, key: password }, authIdentity: am-id }') },
  { id: 'email-auth-secret', target: 'A', text: ONE('{ type: email, to: db@example.com, authUsername: am, authSecret: { name: mail, key: secret } }') },
  { id: 'webhook-full', target: 'A', text: ONE('{ type: webhook, url: "https://relay.example.com/x", sendResolved: false, maxAlerts: 5, timeout: 30s, authorization: { type: Bearer, credentials: { name: hook, key: token } }, tlsConfig: { ca: { secret: { name: ca, key: ca.crt } } } }') },
  { id: 'webhook-secret-basic', target: 'A', text: ONE('{ type: webhook, urlSecret: { name: hook, key: url }, basicAuth: { username: { name: hook, key: user }, password: { name: hook, key: pass } } }') },
  { id: 'webhook-timeout-90s', target: 'A', text: ONE('{ type: webhook, url: "http://relay.example.com", timeout: 90s }'), json: oneJ({ type: 'webhook', url: 'http://relay.example.com', timeout: '90s' }) },
  { id: 'labels-one', target: 'A', text: ONE('{ type: email, to: a@example.com }') },
  { id: 'labels-three', target: 'A', text: R({ labels: 'labels:\n  severity: [critical, warning]\n  team: [db, web]\n  zone: [eu, us]\n', cells: 'cells:\n  - match: { severity: critical, team: db, zone: eu }\n    configs: [ops]\n' }) },
  { id: 'cells-none', target: 'A', text: R({ cells: '' }) },
  { id: 'shared-used', target: 'A', text: R({ configs: [OPS, HOOK, 'relay: { shared: true }'], cells: `${CELLS}  - match: { severity: critical, team: web }\n    configs: [relay]\n` }) },
  { id: 'reaches-nobody', target: 'A', text: ONE('{ type: email, to: "undisclosed-recipients:;" }') },
  { id: 'smtp-absent', target: 'A', text: ONE('{ type: email, to: db@example.com }'), smtp: false },
  { id: 'templated', target: 'A', text: ONE('{ type: email, to: "{{ .CommonLabels.owner }}@example.com", headers: { Subject: "{{ .Status }} 100%" }, text: "{{ range .Alerts }}{{ .Labels.alertname }} {{ end }}%d" }') },
  // groupBy (#223): the defaults' for every cell, a cell's own in its place
  { id: 'groupby', target: 'A', text: R({ defaults: 'defaults: { groupWait: 30s, groupBy: [alertname] }\n', cells: CELLS.replace('    repeatInterval: 1h\n', '    groupBy: [alertname, instance]\n    repeatInterval: 1h\n') }),
    json: { ...okJ, defaults: { groupWait: '30s', groupBy: ['alertname'] }, cells: [{ ...okJ.cells[0], groupBy: ['alertname', 'instance'] }, okJ.cells[1]] } },
  { id: 'groupby-saved', target: 'A', saved: true, text: R({ defaults: 'defaults: { groupWait: 30s, groupBy: [alertname] }\n', cells: CELLS.replace('    repeatInterval: 1h\n', '    groupBy: [alertname, instance]\n    repeatInterval: 1h\n') }) },
  // a cell's match written in another order than labels: the same route
  { id: 'groupby-match-order', target: 'A', text: R({ defaults: 'defaults: { groupBy: [alertname] }\n', cells: 'cells:\n  - match: { team: db, severity: critical }\n    configs: [ops]\n    groupBy: [alertname, instance]\n' }) },
  { id: 'groupby-every-label', target: 'A', text: ONE('{ type: email, to: db@example.com }', "    groupBy: ['...']\n") },
  { id: 'groupby-twice', target: 'A', text: ONE('{ type: email, to: db@example.com }', '    groupBy: [alertname, alertname]\n') },
  { id: 'groupby-every-label-and-more', target: 'A', text: ONE('{ type: email, to: db@example.com }', "    groupBy: ['...', alertname]\n") },
  { id: 'groupby-not-legacy-name', target: 'A', text: ONE('{ type: email, to: db@example.com }', '    groupBy: [host-name]\n') },
  { id: 'groupby-empty', target: 'A', text: R({ defaults: 'defaults: { groupBy: [] }\n' }) },
  { id: 'brace-runs', target: 'A', text: ONE('{ type: email, to: db@example.com, text: "{} {{{ x }}} }}" }') },
  // absent, empty, not YAML, wrong shapes
  { id: 'absent-cr-left', target: 'A', text: { remove: true } },
  { id: 'absent-both', target: 'A', text: { remove: true }, files: { [`${DIRS.A}/${CR}`]: { remove: true } } },
  { id: 'empty', target: 'A', text: '' },
  { id: 'not-yaml', target: 'A', text: 'labels: [\n' },
  { id: 'top-list', target: 'A', text: '- labels\n' },
  { id: 'labels-not-map', target: 'A', text: R({ labels: 'labels: [severity]\n' }) },
  { id: 'labels-scalar-values', target: 'A', text: R({ labels: 'labels:\n  severity: critical\n  team: [db, web]\n' }) },
  { id: 'labels-empty', target: 'A', text: R({ labels: 'labels: {}\n', cells: '' }) },
  { id: 'config-not-map', target: 'A', text: ONE('email') },
  { id: 'config-other-kind', target: 'A', text: ONE('{ type: slack, channel: "#ops", apiURL: { name: slack, key: url } }') },
  { id: 'config-unknown-field', target: 'A', text: ONE('{ type: email, to: db@example.com, smartHost: "smtp.example.com:25" }'), json: oneJ({ type: 'email', to: 'db@example.com', smartHost: 'smtp.example.com:25' }) },
  { id: 'top-unknown-key', target: 'A', text: `${BASE.A}routes: []\n` },
  { id: 'timeout-bad', target: 'A', text: ONE('{ type: webhook, url: "http://relay.example.com", timeout: 5x }') },
  { id: 'url-credential', target: 'A', text: ONE('{ type: webhook, url: "http://relay.example.com/?token=a1b2c3d4e5f6g7h8i9j0" }') },
  { id: 'smarthost-half-login', target: 'A', text: ONE('{ type: email, to: db@example.com, smarthost: "smtp.example.com:587", authUsername: am }') },
  { id: 'cell-missing-label', target: 'A', text: R({ cells: 'cells:\n  - match: { severity: critical }\n    configs: [ops]\n' }), json: { ...okJ, cells: [{ match: { severity: 'critical' }, configs: ['ops'] }] } },
  { id: 'cell-extra-label', target: 'A', text: R({ cells: 'cells:\n  - match: { severity: critical, team: db, zone: eu }\n    configs: [ops]\n' }) },
  { id: 'cell-value-outside', target: 'A', text: R({ cells: 'cells:\n  - match: { severity: info, team: db }\n    configs: [ops]\n' }) },
  { id: 'cell-config-unknown', target: 'A', text: R({ cells: 'cells:\n  - match: { severity: critical, team: db }\n    configs: [nobody]\n' }) },
  { id: 'cell-configs-empty', target: 'A', text: R({ cells: 'cells:\n  - match: { severity: critical, team: db }\n    configs: []\n' }) },
  { id: 'cells-twice', target: 'A', text: R({ cells: 'cells:\n  - match: { severity: critical, team: db }\n    configs: [ops]\n  - match: { severity: critical, team: db }\n    configs: [hook]\n' }) },
  { id: 'cells-not-list', target: 'A', text: R({ cells: 'cells: { severity: critical }\n' }) },
  { id: 'duplicate-key', target: 'A', text: R({ configs: [OPS, HOOK, 'ops: { type: email, to: other@example.com }'] }) },
  { id: 'yaml11-values', target: 'A', text: ONE('{ type: email, to: db@example.com }').replace('severity: [critical]', 'severity: [critical, "yes", "on", "010", "1_000"]') },
  { id: 'number-values', target: 'A', text: ONE('{ type: email, to: db@example.com }').replace('severity: [critical]', 'severity: [critical, 010, 0x1F]') },
  { id: 'name-constructor', target: 'A', text: 'labels:\n  constructor: [x]\nconfigs:\n  constructor: { type: email, to: db@example.com }\ncells:\n  - match: { constructor: x }\n    configs: [constructor]\n',
    json: { labels: { constructor: ['x'] }, configs: { constructor: { type: 'email', to: 'db@example.com' } }, cells: [{ match: { constructor: 'x' }, configs: ['constructor'] }] } },
  { id: 'name-proto', target: 'A', text: 'labels:\n  __proto__: [x]\nconfigs:\n  ops: { type: email, to: db@example.com }\ncells:\n  - match: { __proto__: x }\n    configs: [ops]\n' },
  // unreadable
  { id: 'unreadable-perm', target: 'A', text: { mode: 0, content: BASE.A } },
  { id: 'unreadable-dir', target: 'A', text: { dir: true } },
  { id: 'dangling-link', target: 'A', text: { link: 'nowhere.yaml' } },
  { id: 'link-outside', target: 'A', text: { link: '__OUTSIDE__' } },
  { id: 'link-inside', target: 'A', text: { link: '../c/routing.yaml' } },
  // the generated resource behind, gone, or one more
  { id: 'cr-hand-edited', target: 'A', text: BASE.A, files: { [`${DIRS.A}/${CR}`]: { edit: ['ops@example.com', 'oncall@example.com'] } } },
  { id: 'cr-deleted', target: 'A', text: BASE.A, files: { [`${DIRS.A}/${CR}`]: { remove: true } } },
  { id: 'cr-extra', target: 'A', text: BASE.A, files: { [`${DIRS.A}/templates/extra.yaml`]: { copy: `${DIRS.C}/${CR}` } } },
  { id: 'cr-unreadable', target: 'A', text: BASE.A, files: { [`${DIRS.A}/${CR}`]: { mode: 0, content: '' } } },
  { id: 'routing-hand-edited', target: 'A', text: BASE.A.replace('ops@example.com', 'oncall@example.com') },
  // on a _common stack, inside a _common, a sync target
  { id: 'stack-ok', target: 'S', text: BASE.X },
  { id: 'stack-hand-edited', target: 'S', text: BASE.X.replace('x@', 'y@') },
  { id: 'stack-not-yaml', target: 'S', text: 'labels: [\n' },
  { id: 'common-has-routing', target: 'L', files: { [`${DIRS.L}/routing.yaml`]: BASE.X, [`${DIRS.L}/${CR}`]: { copy: `${DIRS.S}/${CR}` } } },
  { id: 'target-ok', target: 'B' },
  { id: 'target-hand-edited', target: 'B', text: BASE.A.replace('ops@example.com', 'mine@example.com') },
  { id: 'target-cr-deleted', target: 'B', files: { [`${DIRS.B}/${CR}`]: { remove: true } } },
  { id: 'source-broken', target: 'B', files: { [`${DIRS.A}/routing.yaml`]: 'labels: [\n' } },
  // the shared configs
  { id: 'shared-ok', target: 'SH' },
  { id: 'shared-changed', target: 'SH', shared: BASE.SHARED.replace('8080', '9090') },
  { id: 'shared-absent', target: 'SH', shared: { remove: true } },
  { id: 'shared-not-yaml', target: 'SH', shared: 'configs: [\n' },
  { id: 'shared-refused-entry', target: 'SH', shared: 'configs:\n  relay: { type: webhook, url: "http://relay.example.com:8080", timeot: 5s }\n' },
  { id: 'shared-unused-entry', target: 'SH', shared: `${BASE.SHARED}  spare: { type: email, to: spare@example.com }\n` },
  { id: 'shared-reaches-nobody', target: 'SH', shared: 'configs:\n  relay: { type: email, to: "undisclosed-recipients:;" }\n' },
  { id: 'shared-dir-holds-more', target: 'SH', files: { '_shared/notes.txt': 'mine\n' } },
  { id: 'shared-unreadable', target: 'SH', shared: { mode: 0, content: BASE.SHARED } },
  { id: 'shared-link-inside', target: 'SH', shared: { link: '../notes/shared.yaml' }, files: { 'notes/shared.yaml': BASE.SHARED } },
  { id: 'shared-link-outside', target: 'SH', shared: { link: '__OUTSIDE__' } },
  { id: 'shared-dangling-link', target: 'SH', shared: { link: 'nowhere.yaml' } },
  { id: 'shared-dir-link', target: 'SH', files: { _shared: { link: 'notes/sh' }, 'notes/sh/notification-configs.yaml': BASE.SHARED } },
  { id: 'shared-ref-missing', target: 'A', text: R({ configs: [OPS, HOOK, 'nope: { shared: true }'], cells: `${CELLS}  - match: { severity: critical, team: web }\n    configs: [nope]\n` }) },
  { id: 'sync-yaml-unreadable', target: 'SH', files: { 'sync.yaml': { dirMode: 0 } } },
  { id: 'shared-smtp-absent', target: 'SH', shared: 'configs:\n  relay: { type: email, to: relay@example.com }\n', smtp: false },
]
