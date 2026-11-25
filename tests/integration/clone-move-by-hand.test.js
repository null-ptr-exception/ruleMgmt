// #178: moving a deployment to a cloned chart is done by hand. This follows
// doc/how-to.md, "Move a deployment to a cloned chart", step by step on a real
// deployment, and renders it with Helm: if the steps are wrong, this fails.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

const DEP = 'deployments/shop/prod'
const CPU = warn => `group: cpu
columns:
  namespace: {type: string, required: true}
  ${warn}: {type: number, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${${warn}}
`

let server, baseURL, tmpDir
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-move-'))
  await fs.mkdir(path.join(tmpDir, 'charts'), { recursive: true })
  const { default: chartsRouter } = await import('../../server/routes/charts.js')
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/charts', chartsRouter())
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})
afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const file = rel => path.join(tmpDir, rel)

describe.skipIf(!HAS_HELM)('moving a deployment to a cloned chart by hand, as the how-to says', () => {
  it('renders the clone\'s rules with the moved values', async () => {
    // The original, and a deployment on it.
    expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU('warn_pct') } })).status).toBe(200)
    expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
    expect((await api('POST', `/api/v2/deployments/demo/prod?folder=${encodeURIComponent(DEP)}`, { values: { cpu: [{ namespace: 'shop', warn_pct: 90 }] } })).status).toBe(200)

    // Cloned with warn_pct renamed, the clone edited to match.
    const migration = { columns: { cpu: { warn_pct: 'warn_ratio' } }, dropped: {}, groups: {} }
    expect((await api('POST', '/api/v2/charts/demo/clone', { newName: 'demo-v2', migration })).status).toBe(200)
    expect((await api('POST', '/api/v2/templates/demo-v2/rules', { files: { 'cpu.yaml': CPU('warn_ratio') } })).status).toBe(200)
    const schema = JSON.parse(await fs.readFile(file('charts/demo-v2/values.schema.json'), 'utf-8'))
    expect(schema['x-migrated-from']).toMatchObject({ chart: 'demo', columns: { cpu: { warn_pct: 'warn_ratio' } } })

    // Step 1: Chart.yaml's dependency gets the new name and folder.
    const chart = yaml.load(await fs.readFile(file(`${DEP}/Chart.yaml`), 'utf-8'))
    chart.dependencies = chart.dependencies.map(d => (d.name === 'demo'
      ? { ...d, name: 'demo-v2', repository: d.repository.replace(/\/demo$/, '/demo-v2') }
      : d))
    await fs.writeFile(file(`${DEP}/Chart.yaml`), yaml.dump(chart))

    // Step 2: values.yaml's top key, then the columns x-migrated-from renames.
    const values = yaml.load(await fs.readFile(file(`${DEP}/values.yaml`), 'utf-8'))
    const { demo: own, ...rest } = values
    const moved = { ...own, cpu: own.cpu.map(({ warn_pct: w, ...row }) => ({ ...row, warn_ratio: w })) }
    await fs.writeFile(file(`${DEP}/values.yaml`), yaml.dump({ ...rest, 'demo-v2': moved }))

    // Step 3: it renders, from the clone, with the value moved.
    const out = await renderChart(file(DEP), ['template', 'prod', file(DEP)])
    const rules = yaml.loadAll(out).filter(d => d?.kind === 'PrometheusRule').flatMap(d => d.spec.groups.flatMap(g => g.rules))
    expect(rules.map(r => r.expr)).toEqual(['cpu{ns="shop"} > 90'])
    expect(out).toContain('# Source: prod/charts/demo-v2/')
    // And the page reads it on the new chart, with nothing to fix.
    const { status, data } = await api('GET', `/api/v2/deployments/demo-v2/prod?folder=${encodeURIComponent(DEP)}`)
    expect(status).toBe(200)
    expect(data.parsed).toEqual({ cpu: [{ namespace: 'shop', warn_ratio: 90 }] })
  })
})
