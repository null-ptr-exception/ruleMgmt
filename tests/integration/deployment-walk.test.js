// Every list of deployments is the same one walk: migration, "which
// deployments use this chart", the commit checks, the Sync to candidates and
// the tree find a deployment at any depth, one inside another, and the ones
// under a folder a deployment was later made on. No new deployment is made
// inside another, around one, or inside a _common folder; the existing ones
// are still found, and flagged in the tree.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync, spawnSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { findDeploymentsUsing } from '../../server/lib/chartUsage.js'
import { listFolderDeployments } from '../../server/lib/commitChecks.js'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const HAS_PROMTOOL = (() => { try { execFileSync('promtool', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-walk-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const { default: chartsRouter } = await import('../../server/routes/charts.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  app.use('/api/v2/charts', chartsRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': WITH_WARN } })).status).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const exists = rel => fs.access(path.join(tmpDir, rel)).then(() => true, () => false)
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')

const WITH_WARN = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const WITH_THRESHOLD = WITH_WARN.replace('warn: {type: number}', 'threshold: {type: number}').replace('${warn}', '${threshold}')

// A deployment written by hand (or pulled), as AlertForge would write one,
// its dependency on charts/demo worked out from where it is. `deps` puts
// other dependencies first.
async function deployment(rel, { ns = path.basename(rel), deps = [] } = {}) {
  const dir = path.join(tmpDir, rel)
  await fs.mkdir(dir, { recursive: true })
  const repository = `file://${path.relative(dir, path.join(tmpDir, 'charts', 'demo'))}`
  await fs.writeFile(path.join(dir, 'Chart.yaml'), yaml.dump({
    apiVersion: 'v2', name: path.basename(rel), version: '0.1.0',
    dependencies: [...deps, { name: 'demo', version: '>=0.0.0-0', repository }],
  }))
  await fs.writeFile(path.join(dir, 'values.yaml'), yaml.dump({ demo: { cpu: [{ namespace: ns, warn: 90 }] } }))
}

// A _common chart as #75 lays one out: its dependency is reached through a
// link in its own charts/.
async function commonChart(rel) {
  const dir = path.join(tmpDir, rel)
  await fs.mkdir(path.join(dir, 'charts'), { recursive: true })
  await fs.writeFile(path.join(dir, 'Chart.yaml'), yaml.dump({ apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: 'demo', version: '>=0.0.0-0' }] }))
  await fs.writeFile(path.join(dir, 'values.yaml'), yaml.dump({ demo: { cpu: [{ namespace: 'c', warn: 70 }] } }))
  await fs.symlink(path.relative(path.join(dir, 'charts'), path.join(tmpDir, 'charts', 'demo')), path.join(dir, 'charts', 'demo'))
}

const DEEP = 'deep/b/c/d/e/f'
const NESTED = 'nest/prod/canary'

async function layout() {
  await deployment(DEEP)
  await deployment('deep3/b/c/d/e')
  await deployment('nest/prod')
  await deployment(NESTED)
  // Made first; a deployment was then made on the folder above it.
  await deployment('shop/inherit')
  await deployment('shop')
  await deployment('team/charts/prod')
  await deployment('second', { deps: [{ name: 'other', version: '0.1.0', repository: 'file://../charts/other' }] })
  await commonChart('cart/_common/demo')
  await deployment('cart/_common/demo/y')
  // Never looked into.
  await deployment('team/node_modules/x')
  await deployment('.hidden/x')
}

const ALL = [DEEP, 'deep3/b/c/d/e', 'nest/prod', NESTED, 'second', 'shop', 'shop/inherit', 'team/charts/prod', 'cart/_common/demo/y'].sort()

describe('one walk for every list', () => {
  it('"which deployments use this chart" finds every deployment, and the _common chart', async () => {
    await layout()
    const found = await findDeploymentsUsing(tmpDir, 'demo')
    // A hidden folder too: ArgoCD deploys whatever folder it is pointed at.
    expect(found.filter(d => d.kind !== 'common').map(d => d.path).sort()).toEqual([...ALL, '.hidden/x'].sort())
    expect(found.find(d => d.path === '.hidden/x')).toMatchObject({ hidden: true })
    expect(found.filter(d => d.kind === 'common').map(d => d.path)).toEqual(['cart/_common/demo'])
  })

  it('the commit checks walk the same deployments, the _common chart not among them', async () => {
    await layout()
    expect(await listFolderDeployments(tmpDir)).toEqual(ALL)
  })

  it('the Sync to candidates are the same deployments', async () => {
    await layout()
    const { status, data } = await api('GET', '/api/v2/folders/deployments')
    expect(status).toBe(200)
    expect(data.map(d => d.path).sort()).toEqual(ALL)
  })

  it('the tree shows the nested ones flagged, and the _common chart as no deployment', async () => {
    await layout()
    const canary = (await api('GET', '/api/v2/folders/tree?path=nest/prod')).data.find(n => n.name === 'canary')
    expect(canary).toMatchObject({ isDeployment: true, nestedIn: 'nest/prod' })
    const prod = (await api('GET', '/api/v2/folders/tree?path=nest')).data.find(n => n.name === 'prod')
    expect(prod).toMatchObject({ isDeployment: true, isLeaf: false })
    expect(prod.nestedIn).toBeUndefined()
    const inherit = (await api('GET', '/api/v2/folders/tree?path=shop')).data.find(n => n.name === 'inherit')
    expect(inherit).toMatchObject({ isDeployment: true, nestedIn: 'shop' })
    const common = (await api('GET', '/api/v2/folders/tree?path=cart/_common')).data.find(n => n.name === 'demo')
    expect(common).toMatchObject({ isCommon: true })
    expect(common.isDeployment).toBeUndefined()
    // Its link to the Template is the chart's own, no folder of the tree.
    const inside = (await api('GET', '/api/v2/folders/tree?path=cart/_common/demo')).data
    expect(inside.map(n => n.name)).toEqual(['y'])
    expect(inside[0]).toMatchObject({ isDeployment: true, inCommon: true })
  })
})

describe('a breaking change migrates every deployment the walk finds', () => {
  it.skipIf(!HAS_HELM)('a deep one, a nested one, one under a later deployment and one on a second dependency still render after the change', async () => {
    await layout()
    // What Helm renders from them before: one alert each, its threshold 90.
    const alertsOf = async rel => {
      const out = await renderChart(path.join(tmpDir, rel), ['template', 'x', path.join(tmpDir, rel)])
      return yaml.loadAll(out).filter(Boolean).flatMap(d => d.spec?.groups || []).flatMap(g => g.rules || []).map(r => r.expr)
    }
    const checked = [DEEP, NESTED, 'shop/inherit', 'second']
    // `second` asks for a chart that is not there; it renders only once
    // that is in place.
    await fs.mkdir(path.join(tmpDir, 'charts', 'other'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'charts', 'other', 'Chart.yaml'), 'apiVersion: v2\nname: other\nversion: 0.1.0\n')
    for (const rel of checked) expect(await alertsOf(rel)).toEqual([`cpu{ns="${path.basename(rel)}"} > 90`])

    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': WITH_THRESHOLD }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    expect(status).toBe(200)
    const migrated = data.migrated.map(d => d.path)
    for (const rel of [...ALL, 'cart/_common/demo']) expect(migrated).toContain(rel)
    expect(migrated).toContain('.hidden/x')
    expect(migrated).not.toContain('team/node_modules/x')
    for (const rel of checked) {
      expect(await read(`${rel}/values.yaml`)).toContain('threshold: 90')
      expect(await alertsOf(rel)).toEqual([`cpu{ns="${path.basename(rel)}"} > 90`])
    }
  })
})

describe('no new deployment where it cannot be told apart', () => {
  const init = folder => api('POST', '/api/v2/folders/init', { folder, chart: 'demo' })

  it('is refused inside another deployment, around one, inside a _common folder or chart, and where the walk never looks', async () => {
    await layout()
    await fs.mkdir(path.join(tmpDir, 'cart', '_common', 'legacy'), { recursive: true })
    const refused = {
      'nest/prod/new': /inside another deployment \(nest\/prod\)/,
      'nest/prod/canary/deeper': /inside another deployment \(nest\/prod\)/,
      nest: /already holds the deployment nest\/prod/,
      'cart/_common/legacy/x': /inside a _common folder/,
      'cart/_common/x': /inside a _common folder/,
      'team/node_modules/y': /team\/node_modules is node_modules/,
      'a/.git/y': /a\/\.git is a hidden folder/,
      'nest/prod/templates/x': /nest\/prod\/templates is a chart's own templates\/ folder/,
    }
    for (const [folder, why] of Object.entries(refused)) {
      const { status, data } = await init(folder)
      expect(status, folder).toBe(400)
      expect(data.error, folder).toMatch(why)
    }
    expect(await exists('nest/prod/new')).toBe(false)
    expect(await exists('nest/Chart.yaml')).toBe(false)
    expect(await exists('cart/_common/x')).toBe(false)
  })

  it('an existing deployment is found where it is, never written over', async () => {
    await layout()
    const before = await read('second/Chart.yaml')
    const { status, data } = await init('second')
    expect(status).toBe(200)
    expect(data).toMatchObject({ status: 'existing', chart: 'demo' })
    expect(await read('second/Chart.yaml')).toBe(before)
    // A nested one too: it is already there.
    expect((await init(NESTED)).data).toMatchObject({ status: 'existing' })
  })

  it('a deployment beside the others is made as before', async () => {
    await layout()
    expect((await init('nest/stg')).data).toMatchObject({ status: 'created' })
  })

  it('a new sync target is held to the same: not inside its source, nor in a _common folder', async () => {
    await layout()
    for (const target of ['nest/prod/copy', 'cart/_common/copy']) {
      const { status, data } = await api('POST', '/api/v2/sync', { source: 'nest/prod', target })
      expect(status, target).toBe(400)
      expect(data.error, target).toMatch(/cannot be made inside/)
      expect(await exists(target)).toBe(false)
    }
    expect((await api('POST', '/api/v2/sync', { source: 'nest/prod', target: 'nest/copy' })).status).toBe(200)
  })

  it('a _common chart is no sync source, nor target', async () => {
    await layout()
    const source = await api('POST', '/api/v2/sync', { source: 'cart/_common/demo', target: 'zz/copy' })
    expect(source.status).toBe(400)
    expect(source.data.error).toMatch(/not a valid deployment/)
    expect(await exists('zz/copy')).toBe(false)
    const target = await api('POST', '/api/v2/sync', { source: 'nest/prod', target: 'cart/_common/demo' })
    expect(target.status).toBe(400)
  })
})

describe('the walk, from every side', () => {
  const init = folder => api('POST', '/api/v2/folders/init', { folder, chart: 'demo' })
  const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

  it('a deployment under a charts/ folder further down inside a deployment is in every list, as in the tree', async () => {
    await deployment('app')
    await deployment('app/envs/charts/prod')
    // Right inside a deployment, charts/ is its own: not looked into.
    await deployment('app/charts/own')
    expect(await listFolderDeployments(tmpDir)).toEqual(['app', 'app/envs/charts/prod'])
    expect((await findDeploymentsUsing(tmpDir, 'demo')).map(d => d.path).sort()).toEqual(['app', 'app/envs/charts/prod'])
    expect((await api('GET', '/api/v2/folders/deployments')).data.map(d => d.path).sort()).toEqual(['app', 'app/envs/charts/prod'])
    const tree = (await api('GET', '/api/v2/folders/tree?path=app/envs/charts')).data
    expect(tree.map(n => n.name)).toEqual(['prod'])
    expect((await api('GET', '/api/v2/folders/tree?path=app')).data.map(n => n.name)).toEqual(['envs'])
  })

  it('no deployment is made where the walk does not look: the Templates folder, the shared configs\' folder', async () => {
    const { newDeploymentProblem: problem } = await import('../../server/repo/walk.js')
    const { openRepo } = await import('../../server/repo/openRepo.js')
    const newDeploymentProblem = (dir, rel) => problem(openRepo(dir), rel)
    await fs.mkdir(path.join(tmpDir, '_shared'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, '_shared', 'notification-configs.yaml'), 'configs: {}\n')
    expect(await newDeploymentProblem(tmpDir, 'charts/myapp')).toMatch(/charts is the Templates folder/)
    expect(await newDeploymentProblem(tmpDir, '_shared/x')).toMatch(/_shared is the shared notification configs' folder/)
    expect(await newDeploymentProblem(tmpDir, 'team/charts/prod')).toBeNull()
  })

  it('a new deployment in the Templates folder is refused saying which folder that is; in a folder only called charts it is made', async () => {
    for (const folder of ['charts', 'charts/myapp', 'charts/demo/prod']) {
      const { status, data } = await init(folder)
      expect(status).toBe(400)
      expect(data.error).toBe(`${folder}: a deployment there would not be seen — charts is the Templates folder, which AlertForge does not look into`)
      expect(await exists(`${folder}/values.yaml`)).toBe(false)
    }
    expect(await exists('charts/myapp')).toBe(false)

    // Not in a chart, and not the Templates folder: only its name is charts.
    expect((await init('infra/legacy/charts/prod')).data).toMatchObject({ status: 'created' })
    expect((await api('GET', '/api/v2/folders/tree?path=infra/legacy')).data).toEqual([{ name: 'charts', path: 'infra/legacy/charts', isLeaf: false }])
    expect((await api('GET', '/api/v2/folders/tree?path=infra/legacy/charts')).data).toEqual([expect.objectContaining({ name: 'prod', isDeployment: true, chart: 'demo' })])
    expect((await api('GET', '/api/v2/folders/deployments')).data.map(d => d.path)).toEqual(['infra/legacy/charts/prod'])
  })

  it('the Templates folder that is a link: a deployment or a _common in it is refused as the Templates folder, and no place in it is offered', async () => {
    await fs.rename(path.join(tmpDir, 'charts'), path.join(tmpDir, 'realcharts'))
    await fs.symlink('realcharts', path.join(tmpDir, 'charts'))
    await fs.symlink('realcharts', path.join(tmpDir, 'alias'))
    for (const folder of ['charts', 'charts/nd', 'charts/demo/nd']) {
      const { status, data } = await init(folder)
      expect(status, folder).toBe(400)
      expect(data.error, folder).toBe(`${folder}: a deployment there would not be seen — charts is the Templates folder, which AlertForge does not look into`)
      const common = await api('GET', `/api/v2/folders/common/plan?${new URLSearchParams({ action: 'create', folder, chart: 'demo' })}`)
      expect(common.status, folder).toBe(400)
      expect(common.data.error, folder).toBe(`${folder}: charts is the Templates folder, which AlertForge does not look into`)
    }
    // Another link that leads into it: refused as a link, and the Templates
    // folder is not offered instead.
    const made = await init('alias/nd')
    expect(made.status).toBe(400)
    expect(made.data.error).toBe('alias/nd: alias is a link to realcharts — a deployment is made in a folder of the repo, not through a link')
    const common = await api('GET', `/api/v2/folders/common/plan?${new URLSearchParams({ action: 'create', folder: 'alias/nd', chart: 'demo' })}`)
    expect(common.data.error).toBe('alias/nd: alias is a link to realcharts — AlertForge makes no _common through a link')
    for (const rel of ['realcharts/nd', 'realcharts/demo/nd']) expect(await exists(rel)).toBe(false)
  })

  it('the Templates folder somewhere else (CHARTS_DIR): that one is named', async () => {
    const before = process.env.CHARTS_DIR
    process.env.CHARTS_DIR = 'platform/tpl'
    try {
      const { status, data } = await init('platform/tpl/myapp')
      expect(status).toBe(400)
      expect(data.error).toMatch(/platform\/tpl is the Templates folder/)
      expect(await exists('platform/tpl/myapp')).toBe(false)
    } finally {
      if (before === undefined) delete process.env.CHARTS_DIR
      else process.env.CHARTS_DIR = before
    }
  })

  it('a folder that holds a _common is no deployment: its deployments go under it', async () => {
    await commonChart('solo/_common/demo')
    const { status, data } = await init('solo')
    expect(status).toBe(400)
    expect(data.error).toMatch(/holds a _common/)
    expect(await exists('solo/Chart.yaml')).toBe(false)
    expect((await init('solo/prod')).data).toMatchObject({ status: 'created' })
  })

  it('a Chart.yaml with no values.yaml uses its Template: listed for a breaking change, nothing written; it keeps the Template, and can be deleted', async () => {
    await deployment('nv')
    await fs.rm(path.join(tmpDir, 'nv', 'values.yaml'))
    expect(await findDeploymentsUsing(tmpDir, 'demo')).toEqual([expect.objectContaining({ path: 'nv', kind: 'chart-only' })])
    // Not a deployment of the lists that check values.
    expect(await listFolderDeployments(tmpDir)).toEqual([])
    expect((await api('GET', '/api/v2/folders/tree')).data.find(n => n.name === 'nv')).toMatchObject({ noValues: true, chart: 'demo' })

    const breaking = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': WITH_THRESHOLD } })
    expect(breaking.status).toBe(409)
    expect(breaking.data.deployments.map(d => d.path)).toEqual(['nv'])
    const migrated = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': WITH_THRESHOLD }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    expect(migrated.status).toBe(200)
    expect(await exists('nv/values.yaml')).toBe(false)

    const del = await api('DELETE', '/api/v2/charts/demo')
    expect(del.status).toBe(409)
    expect(del.data.deployments).toEqual([{ deployment: 'nv', path: 'nv', kind: 'chart-only' }])
    expect((await api('DELETE', `/api/v2/deployments/demo/nv?folder=nv`)).status).toBe(200)
    expect(await exists('nv')).toBe(false)
    expect((await api('DELETE', '/api/v2/charts/demo')).status).toBe(200)
  })

  // Helm deploys a deployment wherever it is; one made inside a folder that
  // has a Chart.yaml and no values.yaml is in every list, as any other is.
  it.skipIf(!HAS_HELM || !HAS_PROMTOOL)('a deployment inside the charts/ of a Chart.yaml with no values.yaml is listed, migrated, and checked by Commit and check-repo', async () => {
    await deployment('bare')
    await fs.rm(path.join(tmpDir, 'bare', 'values.yaml'))
    await deployment('bare/charts/prod')
    await deployment('bare/templates/stg')

    const inside = ['bare/charts/prod', 'bare/templates/stg']
    expect(await listFolderDeployments(tmpDir)).toEqual(inside)
    expect((await api('GET', '/api/v2/folders/deployments')).data.map(d => d.path)).toEqual(inside)
    expect((await findDeploymentsUsing(tmpDir, 'demo')).map(d => d.path).sort()).toEqual(['bare', ...inside])
    expect((await api('GET', '/api/v2/folders/tree?path=bare')).data.map(n => n.name)).toEqual(['charts', 'templates'])

    // Commit checks it: a values.yaml that is not YAML is refused, named.
    await fs.writeFile(path.join(tmpDir, 'bare/charts/prod/values.yaml'), 'demo: [\n')
    const { deploymentCommitBlockers } = await import('../../server/lib/commitChecks.js')
    const blockers = await deploymentCommitBlockers(tmpDir)
    expect(blockers.findings).toEqual([expect.objectContaining({ kind: 'values-unreadable', deployment: 'bare/charts/prod' })])
    await fs.writeFile(path.join(tmpDir, 'bare/charts/prod/values.yaml'), yaml.dump({ demo: { cpu: [{ namespace: 'prod', warn: 90 }] } }))

    // check-repo counts and renders both.
    const r = spawnSync('node', [path.resolve('scripts/check-repo.mjs'), tmpDir], { encoding: 'utf-8', timeout: 120000 })
    expect(r.stdout).toContain('1 Template, 2 deployments')
    expect(r.status).toBe(0)

    // A breaking change migrates them: Helm then deploys their value, not the default.
    const breaking = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': WITH_THRESHOLD } })
    expect(breaking.status).toBe(409)
    expect(breaking.data.deployments.map(d => d.path).sort()).toEqual(['bare', ...inside])
    const migrated = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': WITH_THRESHOLD }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    expect(migrated.status).toBe(200)
    for (const rel of inside) expect(await read(`${rel}/values.yaml`)).toContain('threshold: 90')
  })

  it.skipIf(IS_ROOT)('a folder that cannot be read is named, by its place in the repo, and stops nothing else', async () => {
    await deployment('ok/prod')
    await deployment('locked/dep')
    await fs.chmod(path.join(tmpDir, 'locked'), 0o000)
    try {
      const sync = await api('GET', '/api/v2/folders/deployments')
      expect(sync.status).toBe(200)
      expect(sync.data.map(d => d.path)).toEqual(['ok/prod'])
      const { deploymentCommitBlockers } = await import('../../server/lib/commitChecks.js')
      const blockers = await deploymentCommitBlockers(tmpDir)
      expect(blockers.findings).toEqual([])
      expect(blockers.unreadable).toEqual([{ path: 'locked', error: 'permission denied' }])
      const { findChartUsage } = await import('../../server/lib/chartUsage.js')
      const usage = await findChartUsage(tmpDir, 'demo')
      expect(usage.deployments.map(d => d.path)).toEqual(['ok/prod'])
      expect(usage.unreadable).toEqual([{ path: 'locked', error: 'permission denied' }])
      expect((await api('GET', '/api/v2/folders/tree')).data.find(n => n.name === 'locked')).toMatchObject({ unreadable: 'permission denied' })
      const breaking = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': WITH_THRESHOLD } })
      expect(breaking.status).toBe(409)
      expect(breaking.data.unreadable).toEqual([{ path: 'locked', error: 'permission denied' }])
      expect(JSON.stringify([sync.data, blockers, usage, breaking.data])).not.toContain(tmpDir)
    } finally {
      await fs.chmod(path.join(tmpDir, 'locked'), 0o755)
    }
  })
})
