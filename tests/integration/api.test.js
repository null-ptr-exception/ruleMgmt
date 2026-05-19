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
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/charts', chartsRouter())
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())

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
  it('gets chart info (initially no templates)', async () => {
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data.templateFiles).toEqual([])
    expect(data.schema).toBeTruthy()
    expect(data.chartMeta).toBeTruthy()
  })

  it('creates a template file', async () => {
    const { data } = await api('POST', '/api/v2/templates/test-app/cpu-alert', {
      content: 'groups:\n  - name: cpu\n    rules: []\n',
    })
    expect(data.ok).toBe(true)
  })

  it('lists template files after creation', async () => {
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data.templateFiles).toHaveLength(1)
    expect(data.templateFiles[0]).toBe('cpu-alert')
  })

  it('gets template file content', async () => {
    const { data } = await api('GET', '/api/v2/templates/test-app/cpu-alert')
    expect(data.content).toContain('groups:')
  })

  it('saves and reads schema', async () => {
    const schema = {
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              threshold: { type: 'number', description: 'Alert threshold' }
            }
          }
        }
      }
    }
    const { data: saveResult } = await api('POST', '/api/v2/templates/test-app/schema', { schema })
    expect(saveResult.ok).toBe(true)
    const { data: info } = await api('GET', '/api/v2/templates/test-app')
    expect(info.schema.properties.instances.items.properties.threshold.type).toBe('number')
  })

  it('preserves x- extensions in schema', async () => {
    const schema = {
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        disk_alert: {
          type: 'array',
          'x-promql': 'disk_usage{ns="{{ .namespace }}"} > {{ THRESHOLD }}',
          'x-for': '10m',
          items: {
            type: 'object',
            properties: {
              namespace: { type: 'string', 'x-var-type': 'selector' },
              warn_pct: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        }
      }
    }
    await api('POST', '/api/v2/templates/test-app/schema', { schema })
    const { data: info } = await api('GET', '/api/v2/templates/test-app')
    const disk = info.schema.properties.disk_alert
    expect(disk['x-promql']).toContain('{{ THRESHOLD }}')
    expect(disk['x-for']).toBe('10m')
    expect(disk.items.properties.namespace['x-var-type']).toBe('selector')
    expect(disk.items.properties.warn_pct['x-var-type']).toBe('threshold')
    expect(disk.items.properties.warn_pct['x-severity']).toBe('warning')
  })

  it('renames a template file', async () => {
    await api('POST', '/api/v2/templates/test-app/cpu-alert/rename', { newName: 'cpu-sat' })
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data.templateFiles[0]).toBe('cpu-sat')
  })

  it('deletes a template file', async () => {
    await api('DELETE', '/api/v2/templates/test-app/cpu-sat')
    const { data } = await api('GET', '/api/v2/templates/test-app')
    expect(data.templateFiles).toEqual([])
  })
})

describe('Deployments API', () => {
  it('lists deployments (initially empty)', async () => {
    const { data } = await api('GET', '/api/v2/deployments/test-app')
    expect(data).toEqual([])
  })

  it('creates a deployment by saving values', async () => {
    const values = { cpu_alert: [{ threshold: 80 }] }
    const { data } = await api('POST', '/api/v2/deployments/test-app/staging', { values })
    expect(data.ok).toBe(true)
  })

  it('lists deployments after creation', async () => {
    const { data } = await api('GET', '/api/v2/deployments/test-app')
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('staging')
    expect(data[0].alertCount).toBe(1)
  })

  it('gets deployment values', async () => {
    const { data } = await api('GET', '/api/v2/deployments/test-app/staging')
    expect(data.parsed.cpu_alert).toEqual([{ threshold: 80 }])
  })

  it('saves deployment with string values', async () => {
    const yamlStr = 'cpu_alert:\n  - threshold: 90\n'
    const { data } = await api('POST', '/api/v2/deployments/test-app/staging', { values: yamlStr })
    expect(data.ok).toBe(true)
    const { data: fetched } = await api('GET', '/api/v2/deployments/test-app/staging')
    expect(fetched.parsed.cpu_alert[0].threshold).toBe(90)
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
