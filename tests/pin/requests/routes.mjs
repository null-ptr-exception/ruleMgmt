// Every route of the app, and every value of a request that becomes a path,
// a file name or a git ref in it (`inputs`), and every field of its body
// (`fields`). The pin enumerates its cells from this table; a route the
// routers have and this table has not fails the pin's first test, so a new
// route cannot be forgotten.
//
// A route:
//   id, method, path         path with :params, mounted as server.js mounts it
//   params, query, body      a request that is legitimate in the base repo
//                            (harness.mjs); '$plan:create' / '$plan:delete' in
//                            the body stand for the plan's `expected`
//   inputs: { name: input }  the values that become a path or a ref
//     at      'param' | 'query' | 'body' | 'files-key' (a key of body.files)
//     kind    what the value names (cases.mjs builds each case's value from it)
//     good    the legitimate value (default: the request's own)
//     mode    'read' | 'write': what the route does with it
//     follow  'deployment': the deployment param is the folder's last name
//     twins   false: only `good` is legitimate (no other value can be)
//     req     { query, body }: the request this input is tried in, when not
//             the route's own (a _common's removal is asked with action=delete)
//   none     why the route has no such input
//   fields: [{ name, types, required, emptyOk }]   the body's fields; types of
//            's' text, 'o' a map, 'b' true/false, 'z' null; `name` may be
//            dotted (chartMeta.description)
//   prep     'change': a change in the repo before each cell (Commit needs one),
//            and the base repo's Templates Commit refuses (the links to a
//            Template outside the repo or with another chart name) taken
//            out, so that the answer is about the body, not about them

// As server.js mounts the routers (the pin checks it against server.js).
export const MOUNTS = [
  ['/api/v2/charts', 'charts'],
  ['/api/v2/templates', 'templates'],
  ['/api/v2/deployments', 'deployments'],
  ['/api/v2/render', 'render'],
  ['/api/v2/git', 'git'],
  ['/api/v2/folders', 'folders'],
  ['/api/v2/sync', 'sync'],
  ['/api/v2/routing/shared', 'routingShared'],
]

export const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n    labels: {severity: critical}\n'
export const NOTE = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-notes\ndata:\n  a: b\n'
export const ROUTING = 'labels:\n  severity: [critical]\nconfigs:\n  ops: {type: email, to: ops@example.com}\ncells:\n  - match: {severity: critical}\n    configs: [ops]\n'
export const SHARED = 'configs:\n  team: {type: email, to: team@example.com}\n'

const DEP = 'deployments/team/a'
const chart = (mode = 'read') => ({ at: 'param', kind: 'chart', mode })
const dep = (mode = 'read') => ({ at: 'param', kind: 'deployment', mode })
// The page names a folder's deployment after the folder: the deployment
// follows the folder tried (harness.mjs), where it can be a name.
const folder = (mode = 'read') => ({ at: 'query', kind: 'folder', mode, follow: 'deployment' })
const S = (name, extra = {}) => ({ name, types: ['s'], required: true, ...extra })

// A deployment route: chart, deployment and folder, as the page asks.
const depRoute = (id, method, sub, mode, extra = {}) => ({
  id, method, path: `/api/v2/deployments/:chart${sub}`,
  params: { chart: 'demo', ...(sub ? { deployment: 'a' } : {}) },
  query: { folder: DEP },
  inputs: { chart: chart(mode), ...(sub ? { deployment: dep(mode) } : {}), folder: folder(mode), ...(extra.inputs || {}) },
  ...extra.rest,
})

export const ROUTES = [
  // charts
  { id: 'charts.list', method: 'GET', path: '/api/v2/charts', none: 'reads no request value' },
  { id: 'charts.create', method: 'POST', path: '/api/v2/charts', body: { name: 'fresh' },
    inputs: { name: { at: 'body', kind: 'name-new', mode: 'write' } }, fields: [S('name')] },
  { id: 'charts.clone', method: 'POST', path: '/api/v2/charts/:name/clone', params: { name: 'demo' }, body: { newName: 'copy' },
    inputs: { name: { at: 'param', kind: 'chart', mode: 'read' }, newName: { at: 'body', kind: 'name-new', mode: 'write' } },
    fields: [S('newName'), { name: 'migration', types: ['o'], required: false }] },
  { id: 'charts.delete', method: 'DELETE', path: '/api/v2/charts/:name', params: { name: 'spare' },
    inputs: { name: { at: 'param', kind: 'chart', mode: 'write' } } },

  // templates
  { id: 'templates.get', method: 'GET', path: '/api/v2/templates/:chart', params: { chart: 'demo' }, inputs: { chart: chart() } },
  { id: 'templates.rules', method: 'POST', path: '/api/v2/templates/:chart/rules', params: { chart: 'demo' }, body: { files: { 'cpu.yaml': CPU } },
    inputs: { chart: chart('write'), file: { at: 'files-key', kind: 'rules-file', mode: 'write' } },
    fields: [{ name: 'files', types: ['o'], required: true }, { name: 'confirmBreaking', types: ['b'], required: false }, { name: 'migration', types: ['o'], required: false }] },
  { id: 'templates.migration-preview', method: 'POST', path: '/api/v2/templates/:chart/migration-preview', params: { chart: 'demo' }, body: { files: { 'cpu.yaml': CPU }, migration: {} },
    inputs: { chart: chart(), file: { at: 'files-key', kind: 'rules-file', mode: 'read' } },
    fields: [{ name: 'files', types: ['o'], required: true }, { name: 'migration', types: ['o'], required: false }] },
  { id: 'templates.chart-meta', method: 'POST', path: '/api/v2/templates/:chart/chart-meta', params: { chart: 'demo' }, body: { chartMeta: { description: 'd' } },
    inputs: { chart: chart('write') },
    fields: [{ name: 'chartMeta', types: ['o'], required: true }, { name: 'chartMeta.description', types: ['s', 'z'], required: false, emptyOk: true }] },

  // deployments
  depRoute('deployments.get', 'GET', '/:deployment', 'read'),
  depRoute('deployments.save', 'POST', '/:deployment', 'write', { rest: { body: { values: { cpu: [{ job: 'a' }] } },
    fields: [{ name: 'values', types: ['s', 'o'], required: true, emptyOk: true }, { name: 'version', types: ['s'], required: false }] } }),
  depRoute('deployments.routing-get', 'GET', '/:deployment/routing', 'read'),
  depRoute('deployments.routing-put', 'PUT', '/:deployment/routing', 'write', { rest: { body: { routing: ROUTING },
    fields: [{ name: 'routing', types: ['s', 'o'], required: true, emptyOk: true }] } }),
  depRoute('deployments.routing-delete', 'DELETE', '/:deployment/routing', 'write'),
  depRoute('deployments.delete', 'DELETE', '/:deployment', 'write'),

  // render
  { id: 'render.preview', method: 'POST', path: '/api/v2/render/:chart/:deployment', params: { chart: 'demo', deployment: 'a' }, query: { folder: DEP },
    inputs: { chart: chart(), deployment: dep(), folder: folder() } },

  // git
  { id: 'git.status', method: 'GET', path: '/api/v2/git/status', none: 'reads no request value' },
  { id: 'git.regenerate', method: 'POST', path: '/api/v2/git/routing/regenerate', none: 'reads no request value' },
  { id: 'git.commit', method: 'POST', path: '/api/v2/git/commit', body: { message: 'pin' }, prep: 'change',
    none: 'the message is passed to git as the value of -m, never as a path or an option', fields: [S('message')] },
  { id: 'git.push', method: 'POST', path: '/api/v2/git/push', none: 'reads no request value' },
  { id: 'git.discard', method: 'POST', path: '/api/v2/git/discard', none: 'reads no request value' },
  { id: 'git.log', method: 'GET', path: '/api/v2/git/log', query: { limit: '5' }, none: 'limit and skip are read as numbers' },
  { id: 'git.diff', method: 'GET', path: '/api/v2/git/diff', query: { file: `${DEP}/values.yaml` },
    inputs: {
      file: { at: 'query', kind: 'file', mode: 'read' },
      'file@HEAD': { at: 'query', name: 'file', kind: 'file', mode: 'read', req: { query: { file: `${DEP}/values.yaml`, ref: 'HEAD' } } },
      ref: { at: 'query', kind: 'ref', mode: 'read', req: { query: { file: `${DEP}/values.yaml`, ref: 'HEAD' } } },
    } },
  { id: 'git.pull', method: 'POST', path: '/api/v2/git/pull', none: 'reads no request value' },
  { id: 'git.sync', method: 'POST', path: '/api/v2/git/sync', none: 'reads no request value' },

  // folders
  { id: 'folders.common-plan', method: 'GET', path: '/api/v2/folders/common/plan', query: { folder: 'deployments/c', chart: 'demo' },
    inputs: {
      folder: { at: 'query', kind: 'folder-parent', mode: 'read' },
      chart: { at: 'query', kind: 'chart', mode: 'read' },
      path: { at: 'query', kind: 'common', mode: 'read', req: { query: { action: 'delete', path: 'deployments/s/_common/demo' } } },
    } },
  { id: 'folders.common', method: 'POST', path: '/api/v2/folders/common', body: { action: 'create', folder: 'deployments/c', chart: 'demo', expected: '$plan:create' },
    inputs: {
      folder: { at: 'body', kind: 'folder-parent', mode: 'write' },
      chart: { at: 'body', kind: 'chart', mode: 'write' },
      path: { at: 'body', kind: 'common', mode: 'write', req: { body: { action: 'delete', path: 'deployments/s/_common/demo', expected: '$plan:delete' } } },
    },
    // path: the _common removed (action delete); a create has none.
    fields: [S('action'), { name: 'expected', types: ['o'], required: true }, S('folder'), S('chart'), { name: 'path', types: ['s'], required: false }] },
  { id: 'folders.common-users', method: 'GET', path: '/api/v2/folders/common/users', query: { path: 'deployments/s/_common/demo' },
    inputs: { path: { at: 'query', kind: 'common', mode: 'read' } } },
  { id: 'folders.init', method: 'POST', path: '/api/v2/folders/init', body: { folder: 'deployments/team/new', chart: 'demo' },
    inputs: { folder: { at: 'body', kind: 'folder-new', mode: 'write' }, chart: { at: 'body', kind: 'chart', mode: 'read' } },
    fields: [S('folder'), S('chart')] },
  { id: 'folders.tree', method: 'GET', path: '/api/v2/folders/tree', query: { path: 'deployments' }, inputs: { path: { at: 'query', kind: 'tree', mode: 'read' } } },
  { id: 'folders.deployments', method: 'GET', path: '/api/v2/folders/deployments', query: { chart: 'demo' }, inputs: { chart: { at: 'query', kind: 'chart', mode: 'read' } } },

  // sync
  { id: 'sync.get', method: 'GET', path: '/api/v2/sync', query: { source: DEP },
    inputs: {
      source: { at: 'query', kind: 'folder', mode: 'read' },
      target: { at: 'query', kind: 'folder', mode: 'read', good: 'deployments/team/b', req: { query: { target: 'deployments/team/b' } } },
    } },
  { id: 'sync.create', method: 'POST', path: '/api/v2/sync', body: { source: DEP, target: 'deployments/team/new' },
    inputs: { source: { at: 'body', kind: 'folder', mode: 'read' }, target: { at: 'body', kind: 'folder-new', mode: 'write' } },
    fields: [S('source'), S('target')] },
  { id: 'sync.delete', method: 'DELETE', path: '/api/v2/sync', body: { target: 'deployments/team/b' },
    // Only b is a sync target: no other value can be a legitimate one here.
    inputs: { target: { at: 'body', kind: 'folder', mode: 'write', twins: false } }, fields: [S('target')] },

  // shared notification configs
  { id: 'shared.get', method: 'GET', path: '/api/v2/routing/shared', none: 'reads no request value' },
  { id: 'shared.put', method: 'PUT', path: '/api/v2/routing/shared', body: { shared: SHARED }, none: 'writes one fixed file',
    fields: [{ name: 'shared', types: ['s', 'o'], required: true, emptyOk: true }] },
  { id: 'shared.rename', method: 'POST', path: '/api/v2/routing/shared/rename', body: { from: 'team', to: 'crew' },
    none: 'from and to are config names inside one file, never paths', fields: [S('from'), S('to')] },
  { id: 'shared.regenerate', method: 'POST', path: '/api/v2/routing/shared/regenerate', none: 'reads no request value' },

  // server.js's own
  { id: 'user', method: 'GET', path: '/api/v2/user', none: 'reads no request value', own: true },
]

const isWrite = r => r.method !== 'GET'

/** Every path slot: one route × one input. */
export const PATH_SLOTS = ROUTES.flatMap(r => Object.entries(r.inputs || {}).map(([input, def]) => ({
  entry: `${r.id}:${input}`, route: r, input, name: def.name || input, ...def,
})))

/** Every body slot: a write route as a whole (`route`), and each of its fields. */
export const BODY_SLOTS = ROUTES.filter(r => isWrite(r) && !r.own).flatMap(r => [
  { entry: `${r.id}{}`, route: r },
  ...(r.fields || []).map(f => ({ entry: `${r.id}{${f.name}}`, route: r, field: f })),
])

/** The routes the routers have: 'METHOD /api/v2/…', for the table's check. */
export async function routerRoutes() {
  const out = []
  for (const [at, file] of MOUNTS) {
    const router = (await import(`../../../server/routes/${file}.js`)).default()
    for (const layer of router.stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${at}${layer.route.path === '/' ? '' : layer.route.path}`)
      } else if (layer.handle?.stack) {
        // A router inside a router: its routes' paths are not known here.
        out.push(`NESTED ROUTER in ${file}.js: list its routes in routes.mjs and here`)
      }
    }
  }
  return out
}
