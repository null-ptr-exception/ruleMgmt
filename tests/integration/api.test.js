import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import chartsRouter from '../../server/routes/charts.js'
import templatesRouter from '../../server/routes/templates.js'
import deploymentsRouter from '../../server/routes/deployments.js'
import renderRouter from '../../server/routes/render.js'

let app, server, baseUrl, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruleMgmt-test-'))
  await fs.mkdir(path.join(tmpDir, 'charts'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'deployments'), { recursive: true })

  app = express()
  app.use(express.json())
  app.use('/api/v2/charts', chartsRouter(tmpDir))
  app.use('/api/v2/templates', templatesRouter(tmpDir))
  app.use('/api/v2/deployments', deploymentsRouter(tmpDir))
  app.use('/api/v2/render', renderRouter(tmpDir))

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  server?.close()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${path}`, opts)
  return { status: res.status, data: await res.json() }
}

describe('Charts API', () => {
  it('lists empty charts initially', async () => {
    const { data } = await api('GET', '/api/v2/charts')
    expect(data).toEqual([])
  })

  it('creates a chart', async () => {
    const { data } = await api('POST', '/api/v2/charts', { name: 'test-app' })
    expect(data.ok).toBe(true)
  })

  it('lists created chart', async () => {
    const { data } = await api('GET', '/api/v2/charts')
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('test-app')
  })

  it('deletes a chart', async () => {
    const { data } = await api('DELETE', '/api/v2/charts/test-app')
    expect(data.ok).toBe(true)

    const { data: list } = await api('GET', '/api/v2/charts')
    expect(list).toEqual([])
  })
})

describe('Templates API', () => {
  beforeAll(async () => {
    await api('POST', '/api/v2/charts', { name: 'tmpl-app' })
  })

  it('lists empty templates', async () => {
    const { data } = await api('GET', '/api/v2/templates/tmpl-app')
    expect(data).toEqual([])
  })

  it('creates a template', async () => {
    const { data } = await api('POST', '/api/v2/templates/tmpl-app/my_alert', {
      content: 'apiVersion: v1\nkind: PrometheusRule\n',
      meta: {
        description: 'Test alert',
        vars: [{ name: 'cluster', type: 'text', description: 'Cluster name' }],
      },
    })
    expect(data.ok).toBe(true)
  })

  it('lists created template with meta', async () => {
    const { data } = await api('GET', '/api/v2/templates/tmpl-app')
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('my_alert')
    expect(data[0].vars).toHaveLength(1)
  })

  it('gets single template', async () => {
    const { data } = await api('GET', '/api/v2/templates/tmpl-app/my_alert')
    expect(data.content).toContain('PrometheusRule')
    expect(data.meta.description).toBe('Test alert')
  })

  it('deletes a template', async () => {
    const { data } = await api('DELETE', '/api/v2/templates/tmpl-app/my_alert')
    expect(data.ok).toBe(true)

    const { data: list } = await api('GET', '/api/v2/templates/tmpl-app')
    expect(list).toEqual([])
  })
})

describe('Deployments API', () => {
  beforeAll(async () => {
    await api('POST', '/api/v2/charts', { name: 'deploy-app' })
  })

  it('lists empty deployments', async () => {
    const { data } = await api('GET', '/api/v2/deployments/deploy-app')
    expect(data).toEqual([])
  })

  it('creates a deployment', async () => {
    const values = { my_alert: [{ cluster: 'us-east', threshold: 0.8 }] }
    const { data } = await api('POST', '/api/v2/deployments/deploy-app/staging', { values })
    expect(data.ok).toBe(true)
  })

  it('gets deployment values', async () => {
    const { data } = await api('GET', '/api/v2/deployments/deploy-app/staging')
    expect(data.parsed.my_alert).toHaveLength(1)
    expect(data.parsed.my_alert[0].cluster).toBe('us-east')
  })

  it('clones a deployment', async () => {
    const { data } = await api('POST', '/api/v2/deployments/deploy-app/staging/clone', { newName: 'prod' })
    expect(data.ok).toBe(true)

    const { data: prod } = await api('GET', '/api/v2/deployments/deploy-app/prod')
    expect(prod.parsed.my_alert[0].cluster).toBe('us-east')
  })

  it('lists deployments with counts', async () => {
    const { data } = await api('GET', '/api/v2/deployments/deploy-app')
    expect(data).toHaveLength(2)
    expect(data.map(d => d.name).sort()).toEqual(['prod', 'staging'])
    expect(data[0].alertCount).toBe(1)
  })

  it('deletes a deployment', async () => {
    const { data } = await api('DELETE', '/api/v2/deployments/deploy-app/prod')
    expect(data.ok).toBe(true)

    const { data: list } = await api('GET', '/api/v2/deployments/deploy-app')
    expect(list).toHaveLength(1)
  })
})
