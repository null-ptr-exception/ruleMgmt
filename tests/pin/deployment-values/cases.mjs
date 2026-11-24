// The input table of the deployment-values pin (see harness.mjs): one row
// per input, each a state of the repo (the subject's values file plus any
// other file) and, for a save, what is sent.
//
// target: A  folder deployment deployments/t/a (sync source, B its target)
//         S  deployment deployments/s/x on the _common stack deployments/s/_common/demo
//         L  the layer deployments/s/_common/demo itself (rendered through x)
//         F  flat legacy file deployments/demo/f-values.yaml (bare values)
//         T  like A, with the Template's own values.yaml changed (files)
// text:   the subject file's content, or { mode: 0, content } / { dir: true } / { link }
// json:   the bare values the editor would send for a JSON save (optional)
// files:  other files of the repo to change, same forms as text, or
//         { remove: true } / { dirMode: 0 }

const W = body => `demo:\n${body}`
const C = '  _common:\n    team: shop\n'
const ROW = r => `  cpu:\n    - ${r}\n`
const OK = W(C + ROW('{ job: api }'))
const okJ = { _common: { team: 'shop' }, cpu: [{ job: 'api' }] }
const withRow = row => ({ _common: { team: 'shop' }, cpu: [row] })
const TPL = 'charts/demo/values.yaml'

export const BASE = {
  A: OK,
  B: W(C + ROW('{ job: web }')),
  X: 'common:\n  demo:\n    cpu:\n      - job: x\n',
  L: 'demo:\n  _common:\n    team: shop\n',
  F: '_common:\n  team: shop\ncpu:\n  - job: f\n',
  TPL: 'cpu: []\n',
}

export const CASES = [
  // good values
  { id: 'ok', target: 'A', text: OK, json: okJ },
  { id: 'ok-full', target: 'A', text: W(C + ROW('{ job: api, threshold: 90, window: 10m, severity: critical, freq: 2 }')), json: withRow({ job: 'api', threshold: 90, window: '10m', severity: 'critical', freq: 2 }) },
  { id: 'ok-comment', target: 'A', text: `# hand-written\n${OK}# end\n` },
  { id: 'ok-two-rows', target: 'A', text: W(C + '  cpu:\n    - { job: api }\n    - { job: web, threshold: 70 }\n') },
  // wrong types for declared columns, enum misses, shapes
  { id: 'number-col-text', target: 'A', text: W(C + ROW('{ job: api, threshold: abc }')), json: withRow({ job: 'api', threshold: 'abc' }) },
  { id: 'integer-col-float', target: 'A', text: W(C + ROW('{ job: api, freq: 2.5 }')), json: withRow({ job: 'api', freq: 2.5 }) },
  { id: 'string-col-bool', target: 'A', text: W(C + ROW('{ job: true }')), json: withRow({ job: true }) },
  { id: 'enum-miss', target: 'A', text: W(C + ROW('{ job: api, severity: fatal }')), json: withRow({ job: 'api', severity: 'fatal' }) },
  { id: 'required-miss', target: 'A', text: W(C + ROW('{ threshold: 5 }')), json: withRow({ threshold: 5 }) },
  { id: 'required-empty', target: 'A', text: W(C + ROW("{ job: '' }")), json: withRow({ job: '' }) },
  { id: 'duration-number', target: 'A', text: W(C + ROW('{ job: api, window: 5 }')), json: withRow({ job: 'api', window: 5 }) },
  { id: 'duration-bad', target: 'A', text: W(C + ROW('{ job: api, window: 5x }')), json: withRow({ job: 'api', window: '5x' }) },
  { id: 'number-col-zero', target: 'A', text: W(C + ROW('{ job: api, threshold: 0 }')), json: withRow({ job: 'api', threshold: 0 }) },
  { id: 'number-col-false', target: 'A', text: W(C + ROW('{ job: api, threshold: false }')), json: withRow({ job: 'api', threshold: false }) },
  { id: 'row-negative', target: 'A', text: W(C + ROW('{ job: api, freq: -1 }')), json: withRow({ job: 'api', freq: -1 }) },
  { id: 'cell-spaces', target: 'A', text: W(C + ROW("{ job: ' api ' }")), json: withRow({ job: ' api ' }) },
  { id: 'cell-null', target: 'A', text: W(C + ROW('{ job: api, threshold: null }')), json: withRow({ job: 'api', threshold: null }) },
  { id: 'cell-list', target: 'A', text: W(C + ROW('{ job: api, threshold: [1] }')), json: withRow({ job: 'api', threshold: [1] }) },
  { id: 'row-scalar', target: 'A', text: W(C + '  cpu:\n    - 5\n'), json: { _common: { team: 'shop' }, cpu: [5] } },
  { id: 'group-not-list', target: 'A', text: W(C + '  cpu: { job: api }\n'), json: { _common: { team: 'shop' }, cpu: { job: 'api' } } },
  { id: 'common-not-map', target: 'A', text: W('  _common: [shop]\n' + ROW('{ job: api }')), json: { _common: ['shop'], cpu: [{ job: 'api' }] } },
  { id: 'group-empty', target: 'A', text: W(C + '  cpu: []\n'), json: { _common: { team: 'shop' }, cpu: [] } },
  { id: 'rows-duplicate', target: 'A', text: W(C + '  cpu:\n    - { job: api }\n    - { job: api }\n') },
  { id: 'group-null', target: 'A', text: W(C + '  cpu: null\n'), json: { _common: { team: 'shop' }, cpu: null } },
  { id: 'common-null', target: 'A', text: W('  _common: null\n' + ROW('{ job: api }')), json: { _common: null, cpu: [{ job: 'api' }] } },
  { id: 'common-team-null', target: 'A', text: W('  _common:\n    team: null\n' + ROW('{ job: api }')) },
  { id: 'once-group-map', target: 'A', text: W(C + ROW('{ job: api }') + '  up: {}\n'), json: { ...okJ, up: {} } },
  { id: 'once-group-null', target: 'A', text: W(C + ROW('{ job: api }') + '  up: null\n') },
  // undeclared keys
  { id: 'undeclared-cell', target: 'A', text: W(C + ROW('{ job: api, foo: 1 }')), json: withRow({ job: 'api', foo: 1 }) },
  { id: 'undeclared-cell-list', target: 'A', text: W(C + ROW('{ job: api, foo: [1] }')), json: withRow({ job: 'api', foo: [1] }) },
  { id: 'undeclared-group-list', target: 'A', text: OK + '  extra: [1]\n', json: { ...okJ, extra: [1] } },
  { id: 'undeclared-common-map', target: 'A', text: W('  _common:\n    team: shop\n    extra: { a: 1 }\n' + ROW('{ job: api }')) },
  // prototype-named keys
  { id: 'proto-cell', target: 'A', text: W(C + ROW('{ job: api, constructor: x }')) },
  { id: 'proto-group', target: 'A', text: OK + '  constructor: []\n' },
  { id: 'proto-dunder', target: 'A', text: OK + '  __proto__: { cpu: 1 }\n' },
  // YAML 1.1 forms (Helm reads YAML 1.1; js-yaml reads 1.2)
  { id: 'y11-yes', target: 'A', text: W(C + ROW('{ job: yes }')) },
  { id: 'y11-off-enum', target: 'A', text: W(C + ROW('{ job: api, severity: off }')) },
  { id: 'y11-octal-010', target: 'A', text: W(C + ROW('{ job: api, threshold: 010 }')) },
  { id: 'y11-0o10', target: 'A', text: W(C + ROW('{ job: api, threshold: 0o10 }')) },
  { id: 'y11-underscore', target: 'A', text: W(C + ROW('{ job: api, threshold: 1_000 }')) },
  { id: 'y11-date', target: 'A', text: W(C + ROW('{ job: 2024-01-01 }')) },
  { id: 'y11-sexagesimal', target: 'A', text: W(C + ROW('{ job: api, threshold: 1:30 }')) },
  { id: 'y11-0_7', target: 'A', text: W(C + ROW('{ job: api, threshold: 0_7 }')) },
  { id: 'y11-hex', target: 'A', text: W(C + ROW('{ job: api, threshold: 0x10 }')) },
  { id: 'y11-exp', target: 'A', text: W(C + ROW('{ job: api, threshold: 1e3 }')) },
  { id: 'quoted-number', target: 'A', text: W(C + ROW("{ job: api, threshold: '10' }")), json: withRow({ job: 'api', threshold: '10' }) },
  { id: 'dup-key', target: 'A', text: W(C + ROW('{ job: api, job: web }')) },
  { id: 'merge-key', target: 'A', text: 'x: &r { job: api }\n' + W(C + '  cpu:\n    - <<: *r\n      threshold: 70\n') },
  // documents
  { id: 'comment-only', target: 'A', text: '# nothing yet\n' },
  { id: 'leading-dashes-comment', target: 'A', text: `--- # values\n${OK}` },
  { id: 'bom', target: 'A', text: `\uFEFF${OK}` },
  { id: 'crlf', target: 'A', text: OK.replace(/\n/g, '\r\n') },
  { id: 'tab-indent', target: 'A', text: 'demo:\n\tcpu: []\n' },
  { id: 'empty-file', target: 'A', text: '' },
  { id: 'null-doc', target: 'A', text: '~\n' },
  { id: 'demo-null', target: 'A', text: 'demo:\n' },
  { id: 'trailing-dashes', target: 'A', text: `${OK}---\n` },
  { id: 'second-doc', target: 'A', text: `${OK}---\ndemo:\n  cpu: []\n` },
  { id: 'second-doc-broken', target: 'A', text: `${OK}---\n[\n` },
  { id: 'not-yaml', target: 'A', text: 'demo:\n  cpu: [\n' },
  { id: 'top-scalar', target: 'A', text: '5\n' },
  { id: 'top-list', target: 'A', text: '- a\n' },
  { id: 'unwrapped', target: 'A', text: '_common:\n  team: shop\ncpu:\n  - job: api\n' },
  { id: 'wrong-wrapper', target: 'A', text: 'demox:\n  cpu:\n    - job: api\n' },
  // derived values
  { id: 'common-zero', target: 'A', text: W('  _common:\n    team: shop\n    base: 0\n' + ROW('{ job: api }')), json: { _common: { team: 'shop', base: 0 }, cpu: [{ job: 'api' }] } },
  { id: 'row-zero', target: 'A', text: W(C + ROW('{ job: api, freq: 0 }')) },
  { id: 'derived-overflow', target: 'A', text: W(C + ROW('{ job: api, freq: 99999999999999999 }')) },
  { id: 'threshold-inf', target: 'A', text: W(C + ROW('{ job: api, threshold: .inf }')) },
  // unreadable
  { id: 'unreadable-perm', target: 'A', text: { mode: 0, content: OK } },
  { id: 'unreadable-dir', target: 'A', text: { dir: true } },
  { id: 'dangling-link', target: 'A', text: { link: 'nowhere.yaml' } },
  { id: 'link-outside', target: 'A', text: { link: '__OUTSIDE__' } },
  { id: 'link-loop', target: 'A', text: { link: 'values.yaml' } },
  { id: 'chart-link-missing', target: 'A', text: OK, files: { 'deployments/t/a/charts/demo': { remove: true } } },
  { id: 'link-inside', target: 'A', text: { link: '../b/values.yaml' } },
  // the Template's own values.yaml underneath
  { id: 'tpl-common-team', target: 'T', text: W(ROW('{ job: api }')), files: { [TPL]: '_common:\n  team: platform\ncpu: []\n' } },
  { id: 'tpl-common-zero', target: 'T', text: OK, files: { [TPL]: '_common:\n  base: 0\ncpu: []\n' } },
  { id: 'tpl-null-merge', target: 'T', text: W('  _common:\n    team: null\n' + ROW('{ job: api }')), files: { [TPL]: '_common:\n  team: platform\ncpu: []\n' } },
  { id: 'tpl-trailing-dashes', target: 'T', text: OK, files: { [TPL]: 'cpu: []\n---\n' } },
  { id: 'tpl-not-yaml', target: 'T', text: OK, files: { [TPL]: 'cpu: [\n' } },
  { id: 'tpl-unreadable', target: 'T', text: OK, files: { [TPL]: { mode: 0, content: 'cpu: []\n' } } },
  { id: 'tpl-row-incomplete', target: 'T', text: OK, files: { [TPL]: 'cpu:\n  - { threshold: 5 }\n' } },
  { id: 'tpl-rules-unreadable', target: 'T', text: OK, files: { 'charts/demo/rules': { dirMode: 0 } } },
  // the _common stack
  { id: 'stack-ok', target: 'S', text: BASE.X },
  { id: 'stack-unwrapped', target: 'S', text: 'demo:\n  cpu:\n    - job: x\n' },
  { id: 'stack-x-null', target: 'S', text: 'common:\n  demo: null\n' },
  { id: 'stack-x-number-text', target: 'S', text: 'common:\n  demo:\n    cpu:\n      - { job: x, threshold: abc }\n' },
  { id: 'stack-x-010', target: 'S', text: 'common:\n  demo:\n    cpu:\n      - { job: x, threshold: 010 }\n' },
  { id: 'stack-missing-link', target: 'S', text: BASE.X, files: { 'deployments/s/_common/demo/charts/demo': { remove: true } } },
  { id: 'layer-common-zero', target: 'L', text: 'demo:\n  _common:\n    team: shop\n    base: 0\n' },
  { id: 'layer-team-missing', target: 'L', text: 'demo:\n  cpu: []\n' },
  { id: 'layer-group-map', target: 'L', text: 'demo:\n  _common:\n    team: shop\n  cpu: { job: x }\n' },
  { id: 'layer-not-yaml', target: 'L', text: 'demo:\n  _common: [\n' },
  { id: 'layer-unreadable', target: 'L', text: { mode: 0, content: BASE.L } },
  { id: 'layer-link-outside', target: 'L', text: { link: '__OUTSIDE__' } },
  { id: 'layer-010', target: 'L', text: 'demo:\n  _common:\n    team: shop\n    base: 010\n' },
  // flat legacy file (bare values)
  { id: 'flat-ok', target: 'F', text: BASE.F, json: { _common: { team: 'shop' }, cpu: [{ job: 'f' }] } },
  { id: 'flat-number-text', target: 'F', text: '_common:\n  team: shop\ncpu:\n  - { job: f, threshold: abc }\n', json: { _common: { team: 'shop' }, cpu: [{ job: 'f', threshold: 'abc' }] } },
  { id: 'flat-010', target: 'F', text: '_common:\n  team: shop\ncpu:\n  - { job: f, threshold: 010 }\n' },
  { id: 'flat-not-yaml', target: 'F', text: 'cpu: [\n' },
  { id: 'flat-empty', target: 'F', text: '' },
  { id: 'flat-unreadable', target: 'F', text: { mode: 0, content: BASE.F } },
  { id: 'flat-wrapped', target: 'F', text: 'demo:\n  _common:\n    team: shop\n  cpu:\n    - job: f\n' },
]
