// A breaking change's migration rewrites every level of a _common stack
// (#100): each _common chart's rows and each deployment's, each under its own
// keys. Left in a _common, an old column reaches every deployment under it;
// unwrapped one key short, a deployment's values would be written as empty.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'common-stack-migration-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: chartsRouter } = await import('../../server/routes/charts.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/charts', chartsRouter())
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
const abs = rel => path.join(tmpDir, rel)
const write = async (rel, doc) => {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true })
  await fs.writeFile(abs(rel), yaml.dump(doc))
}
const readYaml = async rel => yaml.load(await fs.readFile(abs(rel), 'utf-8'))

const WITH_WARN = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const WITH_THRESHOLD = WITH_WARN.replace('warn: {type: number}', 'threshold: {type: number}').replace('${warn}', '${threshold}')

async function common(rel, below, belowDir, values) {
  await write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: below, version: '>=0.0.0-0' }] })
  await fs.mkdir(abs(`${rel}/charts`), { recursive: true })
  await fs.symlink(path.relative(abs(`${rel}/charts`), abs(belowDir)), abs(`${rel}/charts/${below}`))
  await write(`${rel}/values.yaml`, values)
}
async function deployment(rel, layerDir, values) {
  await write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name: path.basename(rel), version: '0.1.0', dependencies: [{ name: 'common', version: '>=0.0.0-0', repository: `file://${path.relative(abs(rel), abs(layerDir))}` }] })
  await write(`${rel}/values.yaml`, values)
}

const TOP = 'shop/_common/demo'
const MID = 'shop/team/_common/demo'

describe('a breaking change on a stack', () => {
  it.skipIf(!HAS_HELM)('migrates every _common and every deployment, each under its keys, and they render the same', async () => {
    await common(TOP, 'demo', 'charts/demo', { demo: { cpu: [{ namespace: 'top', warn: 70 }] } })
    await common(MID, 'common', TOP, { common: { demo: { _common: {} } } })
    await deployment('shop/prod', TOP, { common: { demo: { cpu: [{ namespace: 'prod', warn: 90 }] } } })
    await deployment('shop/inherit', TOP, { common: { demo: {} } })
    await deployment('shop/team/dev', MID, { common: { common: { demo: { cpu: [{ namespace: 'dev', warn: 80 }] } } }, other: 1 })

    const exprs = async rel => {
      const out = await renderChart(abs(rel), ['template', 'x', abs(rel)])
      return yaml.loadAll(out).filter(Boolean).flatMap(d => d.spec?.groups || []).flatMap(g => g.rules || []).map(r => r.expr)
    }
    // What Helm renders before.
    expect(await exprs('shop/prod')).toEqual(['cpu{ns="prod"} > 90'])
    expect(await exprs('shop/inherit')).toEqual(['cpu{ns="top"} > 70'])
    expect(await exprs('shop/team/dev')).toEqual(['cpu{ns="dev"} > 80'])

    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': WITH_THRESHOLD }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    expect(status).toBe(200)
    expect(data.migrated.map(d => d.path).sort()).toEqual([MID, TOP, 'shop/inherit', 'shop/prod', 'shop/team/dev'].sort())

    expect(await readYaml(`${TOP}/values.yaml`)).toEqual({ demo: { cpu: [{ namespace: 'top', threshold: 70 }] } })
    expect(await readYaml('shop/prod/values.yaml')).toEqual({ common: { demo: { cpu: [{ namespace: 'prod', threshold: 90 }] } } })
    expect(await readYaml('shop/team/dev/values.yaml')).toEqual({ common: { common: { demo: { cpu: [{ namespace: 'dev', threshold: 80 }] } } }, other: 1 })
    // And Helm renders the same alerts from them.
    expect(await exprs('shop/prod')).toEqual(['cpu{ns="prod"} > 90'])
    expect(await exprs('shop/inherit')).toEqual(['cpu{ns="top"} > 70'])
    expect(await exprs('shop/team/dev')).toEqual(['cpu{ns="dev"} > 80'])
  })

  // A Template change that makes owner required, owner given by the top
  // _common: a save of any deployment under it goes through, so does the
  // migration. A row a _common holds that the change leaves without a
  // required column is that _common's, and refuses it.
  const OWNER = req => `columns:\n  owner: {type: string${req ? ', required: true' : ''}}\n`
  async function threeLevels() {
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': WITH_WARN, '_common.yaml': OWNER(false) } })).status).toBe(200)
    await common(TOP, 'demo', 'charts/demo', { demo: { _common: { owner: 'team-a' }, cpu: [{ namespace: 'top', warn: 70 }] } })
    await common(MID, 'common', TOP, { common: { demo: { _common: {} } } })
    await deployment('shop/prod', TOP, { common: { demo: { cpu: [{ namespace: 'prod', warn: 90 }] } } })
    await deployment('shop/team/dev', MID, { common: { common: { demo: {} } } })
  }

  it('a required Common Value a _common gives does not refuse the deployments and the _common under it', async () => {
    await threeLevels()
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': WITH_THRESHOLD, '_common.yaml': OWNER(true) }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    expect(status, JSON.stringify(data.migrationProblems)).toBe(200)
    expect(data.migrated.map(d => d.path).sort()).toEqual([MID, TOP, 'shop/prod', 'shop/team/dev'].sort())
  })

  it('a row a _common holds that the change leaves without a required column refuses it, naming the _common', async () => {
    await threeLevels()
    const required = WITH_THRESHOLD.replace('threshold: {type: number}', 'threshold: {type: number, required: true}')
    await fs.writeFile(abs(`${MID}/values.yaml`), yaml.dump({ common: { demo: { cpu: [{ namespace: 'mid' }] } } }))
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': required, '_common.yaml': OWNER(false) }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    expect(status).toBe(409)
    expect(data.migrationProblems.map(p => p.path)).toEqual([MID])
  })

  it('a deployment whose _common is gone still uses its Template: the Template is kept, and a breaking change waits for it', async () => {
    await common(TOP, 'demo', 'charts/demo', { demo: { cpu: [{ namespace: 'top', warn: 70 }] } })
    await deployment('shop/prod', TOP, { common: { demo: { cpu: [{ namespace: 'prod', warn: 90 }] } } })
    await fs.rm(abs('shop/_common'), { recursive: true })

    const { findDeploymentsUsing } = await import('../../server/lib/chartUsage.js')
    expect(await findDeploymentsUsing(tmpDir, 'demo')).toEqual([expect.objectContaining({ path: 'shop/prod', broken: expect.stringContaining('its _common chart shop/_common/demo is not in the repo') })])

    // A change that writes no deployment goes through.
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': WITH_WARN.replace('rules:', 'rules:\n  - alert: B\n    expr: up == 0\n') } })).status).toBe(200)
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': WITH_THRESHOLD }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    expect(status).toBe(409)
    expect(data.migrationProblems.map(p => p.path)).toEqual(['shop/prod'])
    expect(yaml.load(await fs.readFile(abs('shop/prod/values.yaml'), 'utf-8'))).toEqual({ common: { demo: { cpu: [{ namespace: 'prod', warn: 90 }] } } })
    const del = await api('DELETE', '/api/v2/charts/demo')
    expect(del.status).toBe(409)
    expect(del.data.deployments.map(d => d.path)).toEqual(['shop/prod'])
  })
})
