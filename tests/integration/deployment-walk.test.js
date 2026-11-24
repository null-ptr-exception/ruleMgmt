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
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { findDeploymentsUsing } from '../../server/lib/chartUsage.js'
import { listFolderDeployments } from '../../server/lib/commitChecks.js'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-walk-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
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
    expect(found.filter(d => d.kind !== 'common').map(d => d.path).sort()).toEqual(ALL)
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
    for (const rel of ['team/node_modules/x', '.hidden/x']) expect(migrated).not.toContain(rel)
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
      'team/node_modules/y': /under node_modules\//,
      'a/.git/y': /under \.git\//,
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
    expect(data).toMatchObject({ status: 'existing', chart: 'other' })
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
