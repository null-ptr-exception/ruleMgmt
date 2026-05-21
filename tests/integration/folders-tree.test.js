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

  it('returns folder tree with path field', async () => {
    fs.mkdirSync(path.join(tmpDir, 'deployments', 'app1'), { recursive: true })
    const res = await request(app).get('/api/v2/folders/tree')
    expect(res.status).toBe(200)
    const depNode = res.body.find(f => f.name === 'deployments')
    expect(depNode.path).toBe('deployments')
    expect(depNode.isDeployment).toBe(false)
    expect(depNode.children[0].path).toBe('deployments/app1')
  })

  it('marks folders with Chart.yaml + values.yaml as deployments', async () => {
    const dir = path.join(tmpDir, 'deployments', 'prod')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: 'prod', version: '0.1.0',
      dependencies: [{ name: 'mariadb-alerts', version: '0.1.0', repository: 'file://../../charts/mariadb-alerts' }]
    }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump({
      latency: [{ owner: 'team-a', threshold: 100 }, { owner: 'team-a', threshold: 200 }],
      traffic: [{ owner: 'team-a', rate: 50 }]
    }))

    const res = await request(app).get('/api/v2/folders/tree')
    const depNode = res.body.find(f => f.name === 'deployments')
    const prod = depNode.children.find(f => f.name === 'prod')
    expect(prod.isDeployment).toBe(true)
    expect(prod.chart).toBe('mariadb-alerts')
    expect(prod.alertCount).toBe(3)
  })

  it('returns isDeployment false for folders without Chart.yaml', async () => {
    fs.mkdirSync(path.join(tmpDir, 'plain-folder'), { recursive: true })
    const res = await request(app).get('/api/v2/folders/tree')
    const node = res.body.find(f => f.name === 'plain-folder')
    expect(node.isDeployment).toBe(false)
    expect(node.chart).toBeUndefined()
    expect(node.alertCount).toBeUndefined()
  })

  it('returns isDeployment false for folders with Chart.yaml but no values.yaml', async () => {
    const dir = path.join(tmpDir, 'no-values')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: 'test', version: '0.1.0',
      dependencies: [{ name: 'some-chart', version: '0.1.0', repository: 'file://../../charts/some-chart' }]
    }))
    const res = await request(app).get('/api/v2/folders/tree')
    const node = res.body.find(f => f.name === 'no-values')
    expect(node.isDeployment).toBe(false)
  })

  it('handles Chart.yaml with no dependencies gracefully', async () => {
    const dir = path.join(tmpDir, 'no-deps')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({ apiVersion: 'v2', name: 'test', version: '0.1.0' }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), 'foo: bar\n')
    const res = await request(app).get('/api/v2/folders/tree')
    const node = res.body.find(f => f.name === 'no-deps')
    expect(node.isDeployment).toBe(false)
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

  it('handles nested deployment structure', async () => {
    const dir = path.join(tmpDir, 'deployments', 'mariadb-1', 'site-1', 'production')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: 'production', version: '0.1.0',
      dependencies: [{ name: 'mariadb-alerts', version: '0.1.0', repository: 'file://../../../../charts/mariadb-alerts' }]
    }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump({ latency: [{ threshold: 100 }] }))

    const res = await request(app).get('/api/v2/folders/tree')
    const dep = res.body.find(f => f.name === 'deployments')
    const m1 = dep.children.find(f => f.name === 'mariadb-1')
    expect(m1.isDeployment).toBe(false)
    const s1 = m1.children.find(f => f.name === 'site-1')
    expect(s1.isDeployment).toBe(false)
    const prod = s1.children.find(f => f.name === 'production')
    expect(prod.isDeployment).toBe(true)
    expect(prod.chart).toBe('mariadb-alerts')
    expect(prod.path).toBe('deployments/mariadb-1/site-1/production')
  })
})
