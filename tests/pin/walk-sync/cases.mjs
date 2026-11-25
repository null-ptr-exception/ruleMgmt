// The input table of the walk / sync pin (see harness.mjs): one row per
// input, each a state of the repo.
//
// kind W  a folder (`folder`) and what is in it (`files`): is it a
//         deployment, and who finds it
// kind Y  sync.yaml (`sync`) and other files: who reads which links, and is
//         each target a copy of its source
// files:  { rel: content | { mode: 0, content } | { dir: true } | { link } |
//         { remove: true } | { dirMode: 0 } | { copy: rel } }
//         ('__OUTSIDE__' at the start of a link: the deployment outside the repo)
import path from 'path'

export const A = 'deployments/t/a'
export const B = 'deployments/t/b'
export const X = 'deployments/s/x'
export const FLAT = 'deployments/demo/f-values.yaml'

// A deployment's Chart.yaml at `rel`, naming each Template as Helm finds it.
export const chartAt = (rel, charts = ['demo'], { name = path.posix.basename(rel) } = {}) =>
  `apiVersion: v2\nname: ${JSON.stringify(name)}\nversion: 0.1.0\ndependencies:\n${charts.map(c => `  - name: ${c}\n    version: '>=0.0.0-0'\n    repository: file://${path.posix.relative(rel, `charts/${c}`)}\n`).join('')}`
export const valuesFor = (job, chart = 'demo') => `${chart}:\n  cpu:\n    - job: ${job}\n`
// A whole deployment at rel: { rel/Chart.yaml, rel/values.yaml }.
const DEP = (rel, opts = {}) => ({ [`${rel}/Chart.yaml`]: chartAt(rel, opts.charts, opts), [`${rel}/values.yaml`]: opts.values ?? valuesFor(path.posix.basename(rel).replace(/\W/g, '') || 'x', (opts.charts || ['demo'])[0]) })
const W = (id, folder, files, extra = {}) => ({ id, kind: 'W', folder, files, ...extra })

const ROUTING = 'labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ops@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n'
export const BASE = { ROUTING, SYNC: `syncs:\n  - source: ${A}\n    targets:\n      - ${B}\n` }
const Y = (id, sync, files = {}, extra = {}) => ({ id, kind: 'Y', sync, files, ...extra })

export const CASES = [
  // where a deployment is, and what it is called
  W('plain', 'deployments/w/d', DEP('deployments/w/d')),
  W('deep', 'deployments/w/n1/n2/n3/d', DEP('deployments/w/n1/n2/n3/d')),
  W('top-level', 'w', DEP('w')),
  W('inside-deployment', `${A}/inner`, DEP(`${A}/inner`)),
  W('inside-deployment-templates', `${A}/templates/inner`, DEP(`${A}/templates/inner`)),
  W('in-common-folder', 'deployments/s/_common/d', DEP('deployments/s/_common/d')),
  W('under-common-stack', 'deployments/s/y', { 'deployments/s/y/Chart.yaml': { copy: `${X}/Chart.yaml` }, 'deployments/s/y/values.yaml': 'common:\n  demo:\n    cpu:\n      - job: yy\n' }),
  W('common-two-levels', 'deployments/s/deeper/z', { ...DEP('deployments/s/deeper/z'), 'deployments/s/deeper/_common/demo/Chart.yaml': chartAt('deployments/s/deeper/_common/demo', ['demo'], { name: 'demo' }), 'deployments/s/deeper/_common/demo/values.yaml': 'demo: {}\n' }),
  // A folder that holds only a _common, as the New Deployment dialog makes
  // one before the folder has a deployment.
  W('common-only-folder', 'deployments/n/_common/demo', {
    'deployments/n/_common/demo/Chart.yaml': "apiVersion: v2\nname: common\ndescription: What the deployments under deployments/n/ inherit\nversion: 0.1.0\ndependencies:\n  - name: demo\n    version: '>=0.0.0-0'\n",
    'deployments/n/_common/demo/charts/demo': { link: '../../../../../charts/demo' },
    'deployments/n/_common/demo/values.yaml': 'demo:\n  cpu: []\n',
  }),
  W('common-chart-link-gone', X, {}, { files: { 'deployments/s/_common/demo/charts/demo': { remove: true } } }),
  W('name-dots', 'deployments/w/d.v1', DEP('deployments/w/d.v1')),
  W('name-dash-underscore', 'deployments/w/my_dep-2', DEP('deployments/w/my_dep-2')),
  W('name-space', 'deployments/w/my dep', DEP('deployments/w/my dep', { name: 'mydep' })),
  W('name-non-ascii', 'deployments/w/部署', DEP('deployments/w/部署', { name: 'bushu' })),
  W('name-uppercase', 'deployments/w/Prod', DEP('deployments/w/Prod', { name: 'prod' })),
  W('hidden-folder', 'deployments/.w/d', DEP('deployments/.w/d')),
  W('hidden-deployment', 'deployments/w/.d', DEP('deployments/w/.d', { name: 'd' })),
  W('node-modules', 'deployments/node_modules/d', DEP('deployments/node_modules/d')),
  W('link-inside', 'deployments/w/ln', { 'deployments/w/ln': { link: '../t/a' } }),
  W('link-outside', 'deployments/w/out', { 'deployments/w/out': { link: '__OUTSIDE__' } }),
  W('link-loop', 'deployments/w/loop', { 'deployments/w/loop': { link: '.' } }),
  W('link-dangling', 'deployments/w/gone', { 'deployments/w/gone': { link: 'nowhere' } }),
  W('link-self-loop', 'deployments/w/self', { 'deployments/w/self': { link: 'self' } }),
  W('charts-link-inside', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/charts/demo': { link: '../../../../charts/demo' } }),
  W('chart-link-inside', 'deployments/w/d', { 'deployments/w/d/Chart.yaml': { link: '../../t/a/Chart.yaml' }, 'deployments/w/d/values.yaml': valuesFor('d') }),
  W('values-link-outside', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/values.yaml': { link: '__OUTSIDE__/values.yaml' } }),
  W('nested-two-deep', `${A}/n/inner`, DEP(`${A}/n/inner`)),
  W('layer-chart-null', X, {}, { files: { 'deployments/s/_common/demo/values.yaml': 'demo: ~\n' } }),
  W('unreadable-folder', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w': { dirMode: 0 } }),
  W('unreadable-chart', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/Chart.yaml': { mode: 0, content: chartAt('deployments/w/d') } }),
  W('chart-not-yaml', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/Chart.yaml': 'dependencies: [\n' }),
  W('chart-no-dependencies', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/Chart.yaml': 'apiVersion: v2\nname: d\nversion: 0.1.0\n' }),
  W('chart-template-gone', 'deployments/w/d', DEP('deployments/w/d', { charts: ['gone'], values: valuesFor('d', 'gone') })),
  W('chart-two-templates', 'deployments/w/d', DEP('deployments/w/d', { charts: ['demo', 'other'] })),
  W('chart-is-folder', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/Chart.yaml': { dir: true } }),
  W('chart-empty', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/Chart.yaml': '' }),
  W('chart-deps-not-list', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/Chart.yaml': 'apiVersion: v2\nname: d\nversion: 0.1.0\ndependencies: demo\n' }),
  W('chart-dangling-link', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/Chart.yaml': { link: 'nowhere.yaml' } }),
  W('no-values', 'deployments/w/d', { 'deployments/w/d/Chart.yaml': chartAt('deployments/w/d') }),
  W('values-only', 'deployments/w/d', { 'deployments/w/d/values.yaml': valuesFor('d') }),
  W('values-yaml11', 'deployments/w/d', DEP('deployments/w/d', { values: valuesFor('y') })),
  W('values-is-folder', 'deployments/w/d', { ...DEP('deployments/w/d'), 'deployments/w/d/values.yaml': { dir: true } }),
  W('empty-folder', 'deployments/w/d', { 'deployments/w/d': { dir: true } }),
  W('file-not-folder', 'deployments/w/d', { 'deployments/w/d': 'just a file\n' }),
  W('legacy-flat', FLAT, {}),
  W('legacy-flat-second', 'deployments/demo/g-values.yaml', { 'deployments/demo/g-values.yaml': '_common:\n  team: shop\ncpu:\n  - job: g\n' }),

  // sync.yaml
  Y('sync-ok', BASE.SYNC),
  Y('sync-absent', { remove: true }),
  Y('sync-empty', ''),
  Y('sync-not-yaml', 'syncs: [\n'),
  Y('sync-top-list', `- source: ${A}\n`),
  Y('syncs-not-list', `syncs:\n  source: ${A}\n  targets: [${B}]\n`),
  Y('sync-scalar', 'just text\n'),
  Y('sync-comments-only', '# no syncs yet\n'),
  Y('syncs-scalar', 'syncs: none\n'),
  Y('syncs-null', 'syncs:\n'),
  Y('entry-no-targets', `syncs:\n  - source: ${A}\n`),
  Y('entry-targets-string', `syncs:\n  - source: ${A}\n    targets: ${B}\n`),
  Y('entry-target-number', `syncs:\n  - source: ${A}\n    targets: [${B}, 7]\n`),
  Y('entry-not-map', 'syncs:\n  - just text\n'),
  Y('target-backslash', `syncs:\n  - source: ${A}\n    targets: ['deployments\\t\\b']\n`),
  Y('target-dot-slash', `syncs:\n  - source: ${A}\n    targets: [./${B}/]\n`),
  Y('target-is-source', `syncs:\n  - source: ${A}\n    targets: [${A}]\n`),
  Y('chain', `syncs:\n  - source: ${A}\n    targets: [${B}]\n  - source: ${B}\n    targets: [${X}]\n`),
  Y('two-sources', `syncs:\n  - source: ${A}\n    targets: [${B}]\n  - source: ${X}\n    targets: [${B}]\n`),
  Y('duplicate-entries', `syncs:\n  - source: ${A}\n    targets: [${B}]\n  - source: ${A}\n    targets: [${B}]\n`),
  Y('target-hidden', `syncs:\n  - source: ${A}\n    targets: [deployments/.h/b]\n`, DEP('deployments/.h/b')),
  Y('target-link-outside', `syncs:\n  - source: ${A}\n    targets: [deployments/w/out]\n`, { 'deployments/w/out': { link: '__OUTSIDE__' } }),
  Y('target-dotdot', `syncs:\n  - source: ${A}\n    targets: [../outside]\n`),
  Y('target-charts', `syncs:\n  - source: ${A}\n    targets: [charts/demo]\n`),
  Y('target-gone', `syncs:\n  - source: ${A}\n    targets: [deployments/t/gone]\n`),
  Y('source-gone', BASE.SYNC, { [`${A}`]: { remove: true } }),
  Y('target-hand-edited', BASE.SYNC, { [`${B}/values.yaml`]: valuesFor('edited') }),
  Y('target-routing-hand-edited', BASE.SYNC, { [`${B}/routing.yaml`]: ROUTING.replace('ops@', 'mine@') }),
  Y('target-other-template', BASE.SYNC, { [`${B}/Chart.yaml`]: chartAt(B, ['other']), [`${B}/values.yaml`]: valuesFor('b', 'other') }),
  Y('target-twice', `syncs:\n  - source: ${A}\n    targets: [${B}, ${B}]\n`),
  Y('target-is-common', `syncs:\n  - source: ${A}\n    targets: [deployments/s/_common/demo]\n`),
  Y('source-is-common', `syncs:\n  - source: deployments/s/_common/demo\n    targets: [${B}]\n`),
  Y('target-link-inside', `syncs:\n  - source: ${A}\n    targets: [deployments/w/ln]\n`, { 'deployments/w/ln': { link: '../t/b' } }),
  Y('target-not-deployment', `syncs:\n  - source: ${A}\n    targets: [deployments/w/plain]\n`, { 'deployments/w/plain/notes.txt': 'x\n' }),
  Y('target-chart-unreadable', BASE.SYNC, { [`${B}/Chart.yaml`]: { mode: 0, content: chartAt(B) } }),
  Y('sync-unreadable', { mode: 0, content: BASE.SYNC }),
  Y('sync-is-folder', { dir: true }),
]
