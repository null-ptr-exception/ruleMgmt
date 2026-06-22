import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import foldersRouter from '../../server/routes/folders.js'

describe('GET /api/v2/folders/tree', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/v2/folders', foldersRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns immediate children of root', async () => {
    fs.mkdirSync(path.join(tmpDir, 'deployments', 'app1'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'charts'), { recursive: true })

    const res = await request(app).get('/api/v2/folders/tree')
    expect(res.status).toBe(200)
    const names = res.body.map(f => f.name)
    expect(names).toContain('deployments')
    expect(names).toContain('charts')
    expect(res.body.find(f => f.name === 'deployments').isLeaf).toBe(false)
  })

  it('returns children of a specific path', async () => {
    const dir = path.join(tmpDir, 'deployments', 'app1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: 'app1', version: '0.1.0',
      dependencies: [{ name: 'my-chart', version: '0.1.0', repository: 'file://../../charts/my-chart' }]
    }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), 'foo: bar\n')

    const res = await request(app).get('/api/v2/folders/tree?path=deployments')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('app1')
    expect(res.body[0].path).toBe('deployments/app1')
    expect(res.body[0].isDeployment).toBe(true)
    expect(res.body[0].chart).toBe('my-chart')
  })

  it('marks folders with Chart.yaml + dependencies + values.yaml as deployments', async () => {
    const dir = path.join(tmpDir, 'prod')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: 'prod', version: '0.1.0',
      dependencies: [{ name: 'mariadb-alerts', version: '0.1.0', repository: 'file://../../charts/mariadb-alerts' }]
    }))
    // values.yaml is written in subchart-wrapped format (as the backend now saves it)
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump({
      'mariadb-alerts': {
        latency: [{ owner: 'team-a', threshold: 100 }, { owner: 'team-a', threshold: 200 }],
        traffic: [{ owner: 'team-a', rate: 50 }]
      }
    }))

    const res = await request(app).get('/api/v2/folders/tree')
    const prod = res.body.find(f => f.name === 'prod')
    expect(prod.isDeployment).toBe(true)
    expect(prod.chart).toBe('mariadb-alerts')
    expect(prod.alertCount).toBe(3)
  })

  it('counts alertCount for legacy bare-key values.yaml (backward compatibility)', async () => {
    const dir = path.join(tmpDir, 'legacy')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: 'legacy', version: '0.1.0',
      dependencies: [{ name: 'mariadb-alerts', version: '0.1.0', repository: 'file://../../charts/mariadb-alerts' }]
    }))
    // pre-migration bare keys (no subchart wrap) must still count correctly
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump({
      latency: [{ owner: 'team-a', threshold: 100 }, { owner: 'team-a', threshold: 200 }],
      traffic: [{ owner: 'team-a', rate: 50 }]
    }))

    const res = await request(app).get('/api/v2/folders/tree')
    const legacy = res.body.find(f => f.name === 'legacy')
    expect(legacy.isDeployment).toBe(true)
    expect(legacy.alertCount).toBe(3)
  })

  it('does not prune non-deployment folders', async () => {
    fs.mkdirSync(path.join(tmpDir, 'plain-folder'), { recursive: true })
    const res = await request(app).get('/api/v2/folders/tree')
    expect(res.body.map(f => f.name)).toContain('plain-folder')
  })

  it('marks folders without Chart.yaml as non-deployments', async () => {
    fs.mkdirSync(path.join(tmpDir, 'no-chart'), { recursive: true })
    const res = await request(app).get('/api/v2/folders/tree')
    const node = res.body.find(f => f.name === 'no-chart')
    expect(node.isDeployment).toBeUndefined()
  })

  it('marks folders with Chart.yaml but no dependencies as non-deployments', async () => {
    const dir = path.join(tmpDir, 'no-deps')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({ apiVersion: 'v2', name: 'test', version: '0.1.0' }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), 'foo: bar\n')
    const res = await request(app).get('/api/v2/folders/tree')
    const node = res.body.find(f => f.name === 'no-deps')
    expect(node.isDeployment).toBeUndefined()
  })

  it('excludes .git and node_modules', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'objects'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'real-folder'), { recursive: true })

    const res = await request(app).get('/api/v2/folders/tree')
    const names = res.body.map(f => f.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    expect(names).toContain('real-folder')
  })

  it('sets isLeaf correctly', async () => {
    fs.mkdirSync(path.join(tmpDir, 'parent', 'child'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'leaf'), { recursive: true })

    const res = await request(app).get('/api/v2/folders/tree')
    expect(res.body.find(f => f.name === 'parent').isLeaf).toBe(false)
    expect(res.body.find(f => f.name === 'leaf').isLeaf).toBe(true)
  })

  it('rejects path traversal', async () => {
    const res = await request(app).get('/api/v2/folders/tree?path=../etc')
    expect(res.status).toBe(400)
  })

  it('returns empty array for non-existent path', async () => {
    const res = await request(app).get('/api/v2/folders/tree?path=does-not-exist')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('supports nested path queries', async () => {
    const dir = path.join(tmpDir, 'deployments', 'mariadb-1', 'production')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: 'production', version: '0.1.0',
      dependencies: [{ name: 'mariadb-alerts', version: '0.1.0', repository: 'file://../../../../charts/mariadb-alerts' }]
    }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump({ latency: [{ threshold: 100 }] }))

    const res1 = await request(app).get('/api/v2/folders/tree?path=deployments')
    expect(res1.body[0].name).toBe('mariadb-1')
    expect(res1.body[0].path).toBe('deployments/mariadb-1')

    const res2 = await request(app).get('/api/v2/folders/tree?path=deployments/mariadb-1')
    expect(res2.body[0].name).toBe('production')
    expect(res2.body[0].path).toBe('deployments/mariadb-1/production')
    expect(res2.body[0].isDeployment).toBe(true)
    expect(res2.body[0].chart).toBe('mariadb-alerts')
  })
})
