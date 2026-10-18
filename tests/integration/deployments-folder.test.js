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

  // #90: GET, POST and DELETE pick the same file, the one Preview and sync use.
  describe('which values file a deployment uses', () => {
    const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf-8')

    it('reads and saves values.yaml when a leftover <name>-values.yaml sits beside it', async () => {
      const dir = path.join(tmpDir, 'shop', 'prod')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'values.yaml'), 'disk:\n  - threshold: 85\n')
      fs.writeFileSync(path.join(dir, 'prod-values.yaml'), 'disk:\n  - threshold: 50\n')

      const before = await request(app).get('/api/v2/deployments/c/prod?folder=shop/prod')
      expect(before.body.parsed).toEqual({ disk: [{ threshold: 85 }] })
      expect(before.body.unusedFile).toBe('prod-values.yaml')

      const save = await request(app)
        .post('/api/v2/deployments/c/prod?folder=shop/prod')
        .send({ values: { disk: [{ threshold: 70 }] } })
      expect(save.status).toBe(200)

      const after = await request(app).get('/api/v2/deployments/c/prod?folder=shop/prod')
      expect(after.body.parsed).toEqual({ disk: [{ threshold: 70 }] })
      expect(read(dir, 'prod-values.yaml')).toBe('disk:\n  - threshold: 50\n')
    })

    it('keeps a differently named sibling off the folder deployment\'s values.yaml', async () => {
      const dir = path.join(tmpDir, 'teams', 'alpha')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'values.yaml'), 'cpu:\n  - threshold: 90\n')
      fs.writeFileSync(path.join(dir, 'staging-values.yaml'), 'cpu:\n  - threshold: 60\n')

      const save = await request(app)
        .post('/api/v2/deployments/c/staging?folder=teams/alpha')
        .send({ values: { cpu: [{ threshold: 65 }] } })
      expect(save.status).toBe(200)
      expect(read(dir, 'values.yaml')).toBe('cpu:\n  - threshold: 90\n')
      expect(read(dir, 'staging-values.yaml')).toContain('threshold: 65')

      const del = await request(app).delete('/api/v2/deployments/c/staging?folder=teams/alpha')
      expect(del.status).toBe(200)
      expect(fs.existsSync(path.join(dir, 'staging-values.yaml'))).toBe(false)
      expect(read(dir, 'values.yaml')).toBe('cpu:\n  - threshold: 90\n')
    })

    it('still reads a lone values.yaml, with nothing to report', async () => {
      const dir = path.join(tmpDir, 'shop', 'stg')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'values.yaml'), 'disk:\n  - threshold: 80\n')

      const res = await request(app).get('/api/v2/deployments/c/stg?folder=shop/stg')
      expect(res.body.parsed).toEqual({ disk: [{ threshold: 80 }] })
      expect(res.body.unusedFile).toBeUndefined()
    })

    it('still reads a lone <name>-values.yaml named after the folder', async () => {
      const dir = path.join(tmpDir, 'shop', 'dev')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'dev-values.yaml'), 'disk:\n  - threshold: 75\n')

      const res = await request(app).get('/api/v2/deployments/c/dev?folder=shop/dev')
      expect(res.body.parsed).toEqual({ disk: [{ threshold: 75 }] })
    })
  })

  it('rejects folder paths with ..', async () => {
    const res = await request(app).get('/api/v2/deployments/chart?folder=../../../etc')
    expect(res.status).toBe(400)
  })
})
