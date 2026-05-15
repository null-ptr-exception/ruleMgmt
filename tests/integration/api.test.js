import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rulemgmt-test-'))
  await fs.mkdir(path.join(tmpDir, 'charts'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'deployments'), { recursive: true })

  const { default: chartsRouter } = await import('../../server/routes/charts.js')
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')

  const app = express()
  app.use(express.json())
  app.use('/api/v2/charts', chartsRouter(tmpDir))
  app.use('/api/v2/templates', templatesRouter(tmpDir))
  app.use('/api/v2/deployments', deploymentsRouter(tmpDir))

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${path}`, opts)
  return { status: res.status, data: await res.json() }
}

describe('Charts API', () => {
  it('lists charts (initially empty)', async () => {
    const { data } = await api('GET', '/api/v2/charts')
    expect(data).toEqual([])
  })

  it('creates a chart', async () => {
    const { data } = await api('POST', '/api/v2/charts', { name: 'test-app' })
    expect(data.ok).toBe(true)
  })

  it('rejects invalid chart name', async () => {
    const { status } = await api('POST', '/api/v2/charts', { name: 'BAD NAME!' })
    expect(status).toBe(400)
  })

  it('lists charts after creation', async () => {
    const { data } = await api('GET', '/api/v2/charts')
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('test-app')
  })

  it('deletes a chart', async () => {
    await api('POST', '/api/v2/charts', { name: 'to-delete' })
    const { data } = await api('DELETE', '/api/v2/charts/to-delete')
    expect(data.ok).toBe(true)
    const { data: list } = await api('GET', '/api/v2/charts')
    expect(list.find(c => c.name === 'to-delete')).toBeUndefined()
  })
})

describe('Templates API', () => {
  it('lists templates (initially empty)', async () => {
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data).toEqual([])
  })

  it('creates a template', async () => {
    const { data } = await api('POST', '/api/v2/templates/test-app/cpu-alert', {
      content: 'groups:\n  - name: cpu\n    rules: []\n',
      meta: { description: 'CPU alert', vars: [{ name: 'threshold', type: 'number' }] },
    })
    expect(data.ok).toBe(true)
  })

  it('lists templates after creation', async () => {
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('cpu-alert')
    expect(data[0].description).toBe('CPU alert')
  })

  it('gets template content and meta', async () => {
    const { data } = await api('GET', '/api/v2/templates/test-app/cpu-alert')
    expect(data.content).toContain('groups:')
    expect(data.meta.vars).toHaveLength(1)
  })

  it('renames a template', async () => {
    await api('POST', '/api/v2/templates/test-app/cpu-alert/rename', { newName: 'cpu-sat' })
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data[0].name).toBe('cpu-sat')
  })

  it('deletes a template', async () => {
    await api('DELETE', '/api/v2/templates/test-app/cpu-sat')
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data).toEqual([])
  })
})

describe('Deployments API', () => {
  it('lists deployments (initially empty)', async () => {
    const { data } = await api('GET', '/api/v2/deployments/test-app')
    expect(data).toEqual([])
  })

  it('creates a deployment by saving values', async () => {
    const values = { kpi_cpu: [{ threshold: 80 }] }
    const { data } = await api('POST', '/api/v2/deployments/test-app/staging', { values })
    expect(data.ok).toBe(true)
  })

  it('lists deployments after creation', async () => {
    const { data } = await api('GET', '/api/v2/deployments/test-app')
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('staging')
  })

  it('gets deployment values', async () => {
    const { data } = await api('GET', '/api/v2/deployments/test-app/staging')
    expect(data.parsed.kpi_cpu).toEqual([{ threshold: 80 }])
  })

  it('saves deployment with string values', async () => {
    const yamlStr = 'kpi_cpu:\n  - threshold: 90\n'
    const { data } = await api('POST', '/api/v2/deployments/test-app/staging', { values: yamlStr })
    expect(data.ok).toBe(true)
    const { data: fetched } = await api('GET', '/api/v2/deployments/test-app/staging')
    expect(fetched.parsed.kpi_cpu[0].threshold).toBe(90)
  })

  it('clones a deployment', async () => {
    const { data } = await api('POST', '/api/v2/deployments/test-app/staging/clone', { newName: 'prod' })
    expect(data.ok).toBe(true)
    const { data: list } = await api('GET', '/api/v2/deployments/test-app')
    expect(list).toHaveLength(2)
  })

  it('deletes a deployment', async () => {
    await api('DELETE', '/api/v2/deployments/test-app/prod')
    const { data } = await api('GET', '/api/v2/deployments/test-app')
    expect(data).toHaveLength(1)
  })
})
