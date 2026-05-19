import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import deploymentsRouter from '../../server/routes/deployments.js'

describe('deployments route with folder param', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/v2/deployments', deploymentsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads from default DEPLOYMENTS_DIR', async () => {
    const dir = path.join(tmpDir, 'deployments', 'my-chart')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'prod-values.yaml'), 'foo:\n  - bar: 1\n')

    const res = await request(app).get('/api/v2/deployments/my-chart')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('prod')
  })

  it('reads from custom folder via query param', async () => {
    const dir = path.join(tmpDir, 'teams', 'alpha')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'staging-values.yaml'), 'foo:\n  - bar: 1\n')

    const res = await request(app).get('/api/v2/deployments/any-chart?folder=teams/alpha')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('staging')
  })

  it('saves to custom folder via query param', async () => {
    const dir = path.join(tmpDir, 'teams', 'alpha')
    fs.mkdirSync(dir, { recursive: true })

    const res = await request(app)
      .post('/api/v2/deployments/any-chart/myenv?folder=teams/alpha')
      .send({ values: { test: [{ a: 1 }] } })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(dir, 'myenv-values.yaml'))).toBe(true)
  })

  it('rejects folder paths with ..', async () => {
    const res = await request(app).get('/api/v2/deployments/chart?folder=../../../etc')
    expect(res.status).toBe(400)
  })
})
