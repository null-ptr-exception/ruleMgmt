// Deleting a chart a deployment still uses is refused (#177): the deployment
// would fail to render as soon as the chart is gone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import chartsRouter from '../../server/routes/charts.js'
import foldersRouter from '../../server/routes/folders.js'
import deploymentsRouter from '../../server/routes/deployments.js'
import templatesRouter from '../../server/routes/templates.js'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

const RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
const FOLDER = 'deployments/shop/prod'
const q = f => `?folder=${encodeURIComponent(f)}`

describe('DELETE /api/v2/charts/:name', () => {
  let tmpDir, app

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-delete-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
    app.use('/api/v2/charts', chartsRouter())
    app.use('/api/v2/folders', foldersRouter())
    app.use('/api/v2/deployments', deploymentsRouter())
    app.use('/api/v2/templates', templatesRouter())
    expect((await request(app).post('/api/v2/charts').send({ name: 'demo' })).status).toBe(200)
    expect((await request(app).post('/api/v2/templates/demo/rules').send({ files: { 'cpu.yaml': RULES } })).status).toBe(200)
  })

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  async function deploy() {
    expect((await request(app).post('/api/v2/folders/init').send({ folder: FOLDER, chart: 'demo' })).status).toBe(200)
    expect((await request(app).post(`/api/v2/deployments/demo/prod${q(FOLDER)}`).send({ values: { cpu: [{ namespace: 'shop' }] } })).status).toBe(200)
  }
  const render = async () => {
    const abs = path.join(tmpDir, FOLDER)
    return renderChart(abs, ['template', 'prod', abs])
  }

  it('is refused while a deployment uses the chart, and names it', async () => {
    await deploy()
    const res = await request(app).delete('/api/v2/charts/demo')
    expect(res.status).toBe(409)
    expect(res.body.deployments).toEqual([{ deployment: 'prod', path: FOLDER }])
    expect(res.body.error).toContain('1 deployment')
    expect(fs.existsSync(path.join(tmpDir, 'charts', 'demo', 'Chart.yaml'))).toBe(true)
  })

  // What the refusal protects: the deployment still renders its alert.
  it.skipIf(!HAS_HELM)('leaves the deployment rendering its alerts', async () => {
    await deploy()
    await request(app).delete('/api/v2/charts/demo')
    expect(await render()).toContain('alert: CpuHigh')
  })

  it('deletes a chart no deployment uses', async () => {
    const res = await request(app).delete('/api/v2/charts/demo')
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(tmpDir, 'charts', 'demo'))).toBe(false)
  })

  it('deletes the chart once its deployment is gone', async () => {
    await deploy()
    expect((await request(app).delete(`/api/v2/deployments/demo/prod${q(FOLDER)}`)).status).toBe(200)
    expect((await request(app).delete('/api/v2/charts/demo')).status).toBe(200)
  })
})
