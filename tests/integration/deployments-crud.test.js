import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import deploymentsRouter from '../../server/routes/deployments.js'

describe('deployments CRUD route', () => {
  let tmpDir, app, chartDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-crud-test-'))
    chartDir = path.join(tmpDir, 'deployments', 'my-chart')
    fs.mkdirSync(chartDir, { recursive: true })
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

  describe('clone deployment', () => {
    it('clones an existing deployment into a new file with same content', async () => {
      const content = 'alerts:\n  - name: cpu-high\n  - name: mem-high\n'
      fs.writeFileSync(path.join(chartDir, 'prod-values.yaml'), content)

      const res = await request(app)
        .post('/api/v2/deployments/my-chart/prod/clone')
        .send({ newName: 'staging' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)

      const clonedPath = path.join(chartDir, 'staging-values.yaml')
      expect(fs.existsSync(clonedPath)).toBe(true)
      expect(fs.readFileSync(clonedPath, 'utf-8')).toBe(content)
    })

    it('rejects newName with special characters', async () => {
      fs.writeFileSync(path.join(chartDir, 'prod-values.yaml'), 'alerts: []\n')

      const res = await request(app)
        .post('/api/v2/deployments/my-chart/prod/clone')
        .send({ newName: 'bad name!' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid newName')
    })

    it('rejects newName containing ..', async () => {
      fs.writeFileSync(path.join(chartDir, 'prod-values.yaml'), 'alerts: []\n')

      const res = await request(app)
        .post('/api/v2/deployments/my-chart/prod/clone')
        .send({ newName: '../escape' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid newName')
    })

    it('rejects a missing newName', async () => {
      fs.writeFileSync(path.join(chartDir, 'prod-values.yaml'), 'alerts: []\n')

      const res = await request(app)
        .post('/api/v2/deployments/my-chart/prod/clone')
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid newName')
    })

    it('rejects an invalid source deployment name', async () => {
      const res = await request(app)
        .post('/api/v2/deployments/my-chart/Bad..Name/clone')
        .send({ newName: 'staging' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid deployment name')
    })

    it('returns 500 when source deployment does not exist', async () => {
      const res = await request(app)
        .post('/api/v2/deployments/my-chart/ghost/clone')
        .send({ newName: 'staging' })
      expect(res.status).toBe(500)
      expect(res.body.error).toBeDefined()
    })
  })

  describe('delete deployment', () => {
    it('removes the deployment values file', async () => {
      const filePath = path.join(chartDir, 'prod-values.yaml')
      fs.writeFileSync(filePath, 'alerts: []\n')
      expect(fs.existsSync(filePath)).toBe(true)

      const res = await request(app).delete('/api/v2/deployments/my-chart/prod')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('succeeds for a nonexistent deployment (idempotent rm with force)', async () => {
      const res = await request(app).delete('/api/v2/deployments/my-chart/ghost')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('rejects an invalid deployment name', async () => {
      const res = await request(app).delete('/api/v2/deployments/my-chart/Bad..Name')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid deployment name')
    })
  })

  describe('list deployments', () => {
    it('returns array of legacy deployments with name, file, and alertCount', async () => {
      fs.writeFileSync(
        path.join(chartDir, 'prod-values.yaml'),
        'groupA:\n  - alert: a1\n  - alert: a2\ngroupB:\n  - alert: b1\n'
      )

      const res = await request(app).get('/api/v2/deployments/my-chart')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0]).toEqual({ name: 'prod', file: 'prod-values.yaml', alertCount: 3 })
    })

    it('reports an alertCount of 0 when there are no array values', async () => {
      fs.writeFileSync(path.join(chartDir, 'prod-values.yaml'), 'enabled: true\nname: prod\n')

      const res = await request(app).get('/api/v2/deployments/my-chart')
      expect(res.status).toBe(200)
      expect(res.body[0].alertCount).toBe(0)
    })

    it('returns an empty array when the chart has no deployment files', async () => {
      const res = await request(app).get('/api/v2/deployments/empty-chart')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('handles mixed direct (values.yaml) and legacy (<name>-values.yaml) files', async () => {
      fs.writeFileSync(
        path.join(chartDir, 'values.yaml'),
        'direct:\n  - alert: d1\n  - alert: d2\n'
      )
      fs.writeFileSync(
        path.join(chartDir, 'prod-values.yaml'),
        'legacy:\n  - alert: l1\n'
      )

      const res = await request(app).get('/api/v2/deployments/my-chart')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(2)

      const byFile = Object.fromEntries(res.body.map((d) => [d.file, d]))
      expect(byFile['values.yaml']).toEqual({ name: 'my-chart', file: 'values.yaml', alertCount: 2 })
      expect(byFile['prod-values.yaml']).toEqual({ name: 'prod', file: 'prod-values.yaml', alertCount: 1 })
    })

    it('rejects an invalid chart name', async () => {
      const res = await request(app).get('/api/v2/deployments/Bad..Chart')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid chart name')
    })
  })
})
