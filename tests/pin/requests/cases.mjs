// The requests pin's inputs. Three kinds of row:
//   path  a value put where a route takes a path, a file name or a name
//         (every slot of routes.mjs whose kind the row has a value for)
//   ref   a value put where a route takes a git ref
//   body  a body, or one field of it, of every write route
//
// A path row builds its value from the slot's kind and its legitimate value
// (`good`); `null` means the row says nothing for that kind. Each value that
// should be refused sits next to a legitimate one of the same sort
// (`legit`: the kinds where the route should take it) — a check that refuses
// too much shows there. `ctx.outside` is a folder outside the repo whose
// files all hold OUTSIDE_TOKEN.

export const OUTSIDE_TOKEN = 'pin-outside-7d1c5e'
export const GITDIR_TOKEN = 'pin-gitdir-3b9a2f'

const SEG = new Set(['chart', 'name-new', 'template', 'rules-file', 'deployment'])
const dirOf = p => p.split('/').slice(0, -1).join('/')
const firstSegToDot = p => p.replace(/^([^/]+)\//, '$1/./')
const LONG = n => 'x'.repeat(n)

// The base repo's legitimate twins (harness.mjs makes them):
//   charts/hand/templates/a..b.yaml, _extra-alerts.yaml, inlink.yaml (a link
//   to notes.yaml), outlink.yaml (a link outside); charts/inchart (a link to
//   demo), charts/outchart (a link outside); deployments/team/a..b (a
//   deployment), deployments/team/inlink (a link to a), outlink (a link to a
//   deployment outside), outfile.yaml (a link to a file outside);
//   deployments/inteam (a link to team), deployments/outdir (a link outside);
//   .gitignore, .github/workflows/ci.yaml; deployments/s/_common/demo.
const PATH_CASES = [
  { id: 'good', legit: 'all', v: (k, g) => g },

  { id: 'up', v: () => '..' },
  { id: 'up-twin', legit: ['template', 'folder', 'folder-new', 'tree', 'file'], v: (k, g) => ({
    chart: 'demo..x', 'name-new': `${g}..x`, template: 'a..b', 'rules-file': 'a..b.yaml',
    folder: 'deployments/team/a..b', 'folder-new': `${g}..x`, tree: 'deployments/team/a..b', file: 'deployments/team/a..b/values.yaml',
  })[k] ?? null },

  // A path that goes up out of the repo, to a thing outside it of the
  // slot's sort (a chart, a template file, a deployment, a file).
  { id: 'climb', v: k => ({
    chart: '../../outside/chart', 'name-new': '../../outside/new', template: '../../../../outside/tpl', 'rules-file': '../../../../outside/rules.yaml',
    deployment: '../../../../outside/dep', folder: 'deployments/../../outside/dep', 'folder-new': 'deployments/../../outside/new',
    'folder-parent': 'deployments/../../outside', common: 'deployments/../../outside/dep', tree: 'deployments/../../outside', file: 'deployments/../../outside/secret.txt',
  })[k] ?? null },
  { id: 'climb-twin', legit: ['folder', 'folder-new', 'folder-parent', 'common', 'tree', 'file'], v: (k, g) => (SEG.has(k) || k === 'ref' ? null : firstSegToDot(g)) },

  { id: 'absolute', v: (k, g, ctx) => ({
    chart: `${ctx.outside}/chart`, 'name-new': `${ctx.outside}/new`, template: `${ctx.outside}/tpl`, 'rules-file': `${ctx.outside}/rules.yaml`,
    deployment: `${ctx.outside}/dep`, folder: `${ctx.outside}/dep`, 'folder-new': `${ctx.outside}/new`, 'folder-parent': ctx.outside,
    common: `${ctx.outside}/dep`, tree: ctx.outside, file: `${ctx.outside}/secret.txt`,
  })[k] ?? null },

  // `%2F` written into the value itself: a second decoding would make it a
  // separator. In a URL segment it arrives as `%2F` (sent as %252F).
  { id: 'encoded-slash', v: (k, g) => (SEG.has(k) ? '..%2F..%2Foutside' : g.replaceAll('/', '%2F')) },
  { id: 'nul', v: (k, g) => `${g}\0x` },
  { id: 'backslash', v: (k, g) => (SEG.has(k) ? '..\\..\\outside' : g.replaceAll('/', '\\')) },
  { id: 'trailing-slash', legit: ['folder', 'folder-new', 'folder-parent', 'common', 'tree'], v: (k, g) => `${g}/` },
  { id: 'empty', v: () => '' },
  // Longer than a file name may be (255), and a long one that fits.
  { id: 'long', v: (k, g) => (SEG.has(k) ? LONG(300) : k === 'file' ? `deployments/team/${LONG(300)}.yaml` : `${dirOf(g) || 'deployments'}/${LONG(300)}`) },
  // A long name that fits is legitimate where a thing is made; elsewhere it
  // names nothing, and the answer is recorded.
  { id: 'long-twin', legit: ['name-new', 'folder-new'],
    v: (k, g) => (SEG.has(k) ? (k === 'rules-file' ? `${LONG(200)}.yaml` : LONG(200)) : k === 'file' ? `deployments/team/${LONG(200)}.yaml` : `${dirOf(g) || 'deployments'}/${LONG(200)}`) },

  // git's own folder never; a dot-file or dot-folder where it is read.
  { id: 'dot-git', v: k => ({
    chart: '.git', 'name-new': '.git', template: '.git', 'rules-file': '.git', deployment: '.git',
    folder: '.git', 'folder-new': '.git/x', 'folder-parent': '.git', common: '.git/x/_common/demo', tree: '.git', file: '.git/info/pin-note',
  })[k] ?? null },
  { id: 'dot-gitignore', legit: ['file', 'tree', 'template'], v: k => ({
    chart: '.gitignore', 'name-new': '.gitignore', template: '.gitignore', tree: '.gitignore', file: '.gitignore',
  })[k] ?? null },
  { id: 'dot-github', legit: ['file', 'tree'], v: k => ({
    'folder-new': '.github/x', folder: '.github/workflows', tree: '.github', file: '.github/workflows/ci.yaml',
  })[k] ?? null },

  // Names starting with _ : reserved for a new folder; an existing _common
  // chart is opened and read; a hand-written template may be called so.
  { id: 'reserved-common', legit: ['folder:read', 'tree', 'file', 'template'], v: k => ({
    chart: '_common', 'name-new': '_common', template: '_common', folder: 'deployments/s/_common/demo',
    'folder-new': 'deployments/team/_common', tree: 'deployments/s/_common', file: 'deployments/s/_common/demo/values.yaml',
  })[k] ?? null },
  { id: 'reserved-shared', legit: ['tree', 'file'], v: k => ({
    'name-new': '_shared', 'folder-new': '_shared/x', tree: '_shared', file: '_shared/notification-configs.yaml',
  })[k] ?? null },
  { id: 'reserved-extra', legit: ['template'], v: k => ({
    chart: '_extra-alerts', 'name-new': '_extra-alerts', template: '_extra-alerts', 'rules-file': '_extra-alerts.yaml',
    'folder-new': 'deployments/team/_extra-alerts',
  })[k] ?? null },

  // Links: to a place in the repo (fine), to a place outside it, and a
  // folder on the way that is a link outside.
  { id: 'link-in', legit: 'all', v: k => ({
    chart: 'inchart', template: 'inlink', folder: 'deployments/team/inlink', 'folder-new': 'deployments/inteam/new',
    'folder-parent': 'deployments/inteam', tree: 'deployments/inteam', file: 'deployments/team/inlink/values.yaml',
  })[k] ?? null },
  { id: 'link-out', v: k => ({
    chart: 'outchart', template: 'outlink', folder: 'deployments/team/outlink', 'folder-new': 'deployments/team/outlink',
    tree: 'deployments/team/outlink', file: 'deployments/team/outfile.yaml',
  })[k] ?? null },
  { id: 'link-via', v: k => ({
    folder: 'deployments/outdir/dep', 'folder-new': 'deployments/outdir/new', 'folder-parent': 'deployments/outdir',
    common: 'deployments/outdir/dep', tree: 'deployments/outdir', file: 'deployments/outdir/secret.txt',
  })[k] ?? null },
]

// What git makes of each ref is asked of git itself (harness.mjs).
const REF_CASES = [
  { id: 'ref:full', v: ctx => ctx.head },
  { id: 'ref:short', v: ctx => ctx.head.slice(0, 7) },
  { id: 'ref:HEAD', v: () => 'HEAD' },
  { id: 'ref:HEAD~1', v: () => 'HEAD~1' },
  { id: 'ref:HEAD^', v: () => 'HEAD^' },
  { id: 'ref:branch', v: () => 'main' },
  { id: 'ref:missing', v: () => 'deadbeefdeadbeef' },
  { id: 'ref:dash', v: () => '-x' },
  { id: 'ref:option', v: ctx => `--output=${ctx.work}/out-x` },
]

// Bodies. Whole-body rows go to every write route; field rows to every
// field, each with a value of another type than the field takes (a row
// whose type the field takes is not a bad body there: `fits`).
const deep = n => { let v = {}; for (let i = 0; i < n; i++) v = { a: v }; return v }
const BODY_CASES = [
  { id: 'body:good', whole: true, body: 'good' },
  { id: 'body:extra-field', whole: true, body: 'extra' },
  { id: 'body:none', whole: true, body: 'none' },
  { id: 'body:text-plain', whole: true, body: 'text-plain' },
  { id: 'body:not-json', whole: true, body: 'not-json' },
  { id: 'body:array', whole: true, body: 'array' },
  { id: 'body:over-limit', whole: true, body: 'over-limit' },
  { id: 'field:number', value: 5, type: 'n' },
  { id: 'field:text', value: 'x', type: 's' },
  { id: 'field:array', value: ['x'], type: 'a' },
  { id: 'field:map', value: {}, type: 'o' },
  { id: 'field:empty-list', value: [], type: 'a' },
  { id: 'field:null', value: null, type: 'z' },
  { id: 'field:bool', value: true, type: 'b' },
  { id: 'field:empty', value: '', type: 's', empty: true },
  { id: 'field:long', value: LONG(60_000), type: 's', long: true },
  { id: 'field:deep', value: deep(2000), type: 'o', deep: true },
]

export const CASES = [
  ...PATH_CASES.map(c => ({ ...c, kind: 'path' })),
  ...REF_CASES.map(c => ({ ...c, kind: 'ref' })),
  ...BODY_CASES.map(c => ({ ...c, kind: 'body' })),
]

// `legit` names a kind, or a kind where it is only read ('folder:read').
export const isLegit = (c, kind, mode) => c.legit === 'all' || (Array.isArray(c.legit) && (c.legit.includes(kind) || c.legit.includes(`${kind}:${mode}`)))
