import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import chartsRouter from '../../server/routes/charts.js'

describe('GET /api/v2/charts filters by annotations.app: alertforge', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charts-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/v2/charts', chartsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns only charts with annotations.app: alertforge', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const alertChart = path.join(chartsDir, 'my-alerts', 'templates')
    fs.mkdirSync(alertChart, { recursive: true })
    fs.writeFileSync(path.join(chartsDir, 'my-alerts', 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: application\nannotations:\n  app: alertforge\n')
    fs.writeFileSync(path.join(alertChart, 'rule.yaml'), 'content')

    fs.mkdirSync(path.join(chartsDir, 'regular'), { recursive: true })
    fs.writeFileSync(path.join(chartsDir, 'regular', 'Chart.yaml'),
      'apiVersion: v2\nname: regular\nversion: 0.1.0\ntype: application\n')

    const res = await request(app).get('/api/v2/charts')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('my-alerts')
    expect(res.body[0].templateCount).toBe(1)
  })

  it('uses CHARTS_DIR env var', async () => {
    const customDir = path.join(tmpDir, 'custom-charts')
    const alertChart = path.join(customDir, 'test-alerts', 'templates')
    fs.mkdirSync(alertChart, { recursive: true })
    fs.writeFileSync(path.join(customDir, 'test-alerts', 'Chart.yaml'),
      'apiVersion: v2\nname: test-alerts\nversion: 0.1.0\ntype: application\nannotations:\n  app: alertforge\n')
    fs.writeFileSync(path.join(alertChart, 'rule.yaml'), 'content')

    const origEnv = process.env.CHARTS_DIR
    process.env.CHARTS_DIR = 'custom-charts'
    try {
      const res = await request(app).get('/api/v2/charts')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].name).toBe('test-alerts')
    } finally {
      if (origEnv === undefined) delete process.env.CHARTS_DIR
      else process.env.CHARTS_DIR = origEnv
    }
  })
})
