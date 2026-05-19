import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import foldersRouter from '../../server/routes/folders.js'

describe('folders API', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-test-'))
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

  it('GET / returns folder tree', async () => {
    fs.mkdirSync(path.join(tmpDir, 'charts', 'my-alerts'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'deployments', 'prod'), { recursive: true })

    const res = await request(app).get('/api/v2/folders')
    expect(res.status).toBe(200)
    expect(res.body).toBeInstanceOf(Array)
    const names = res.body.map(f => f.name)
    expect(names).toContain('charts')
    expect(names).toContain('deployments')

    const chartsNode = res.body.find(f => f.name === 'charts')
    expect(chartsNode.children).toHaveLength(1)
    expect(chartsNode.children[0].name).toBe('my-alerts')
  })

  it('GET / excludes .git and node_modules', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'objects'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'real-folder'), { recursive: true })

    const res = await request(app).get('/api/v2/folders')
    const names = res.body.map(f => f.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    expect(names).toContain('real-folder')
  })

  it('POST / creates a new folder', async () => {
    const res = await request(app).post('/api/v2/folders').send({ path: 'teams/new-team' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(tmpDir, 'teams', 'new-team'))).toBe(true)
  })

  it('POST / rejects paths with ..', async () => {
    const res = await request(app).post('/api/v2/folders').send({ path: '../outside' })
    expect(res.status).toBe(400)
  })

  it('POST /init scaffolds Chart.yaml and values.yaml', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'my-alerts')
    fs.mkdirSync(path.join(chartDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: alert-templates\n')
    fs.writeFileSync(path.join(chartDir, 'values.yaml'),
      'latency:\n  - threshold: 100\n')

    const deployFolder = 'teams/alpha'
    fs.mkdirSync(path.join(tmpDir, deployFolder), { recursive: true })

    const res = await request(app).post('/api/v2/folders/init').send({
      folder: deployFolder,
      chart: 'my-alerts'
    })
    expect(res.status).toBe(200)

    const chartYaml = yaml.load(fs.readFileSync(path.join(tmpDir, deployFolder, 'Chart.yaml'), 'utf-8'))
    expect(chartYaml.dependencies).toHaveLength(1)
    expect(chartYaml.dependencies[0].name).toBe('my-alerts')
    expect(chartYaml.dependencies[0].repository).toMatch(/^file:\/\//)

    const valuesContent = fs.readFileSync(path.join(tmpDir, deployFolder, 'values.yaml'), 'utf-8')
    expect(valuesContent).toContain('latency')
  })

  it('POST /init returns existing chart info when folder already has alert-template dependency', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'my-alerts')
    fs.mkdirSync(path.join(chartDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: alert-templates\n')
    fs.writeFileSync(path.join(chartDir, 'values.yaml'), 'foo: bar\n')

    const deployFolder = 'existing-deploy'
    fs.mkdirSync(path.join(tmpDir, deployFolder), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, deployFolder, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2',
      name: 'existing',
      version: '0.1.0',
      dependencies: [{ name: 'my-alerts', version: '0.1.0', repository: 'file://../../charts/my-alerts' }]
    }))

    const res = await request(app).post('/api/v2/folders/init').send({
      folder: deployFolder,
      chart: 'my-alerts'
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('existing')
    expect(res.body.chart).toBe('my-alerts')
  })
})
