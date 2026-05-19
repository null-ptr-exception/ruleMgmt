import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amconfig-test-'))

  const { default: alertmanagerConfigsRouter } = await import('../../server/routes/alertmanagerConfigs.js')

  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/alertmanager-configs', alertmanagerConfigsRouter())

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

async function api(method, urlPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${urlPath}`, opts)
  return { status: res.status, data: await res.json() }
}

const validYaml = 'route:\n  receiver: default\nreceivers:\n  - name: default\n'
const updatedYaml = 'route:\n  receiver: updated\nreceivers:\n  - name: updated\n'

describe('Alertmanager Configs API', () => {
  it('lists configs (initially empty)', async () => {
    const { status, data } = await api('GET', '/api/v2/alertmanager-configs')
    expect(status).toBe(200)
    expect(data).toEqual([])
  })

  it('creates a config', async () => {
    const { status, data } = await api('PUT', '/api/v2/alertmanager-configs/test-config', { content: validYaml })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
  })

  it('lists configs after creation', async () => {
    const { status, data } = await api('GET', '/api/v2/alertmanager-configs')
    expect(status).toBe(200)
    expect(data).toContain('test-config')
  })

  it('reads the config back with content and parsed fields', async () => {
    const { status, data } = await api('GET', '/api/v2/alertmanager-configs/test-config')
    expect(status).toBe(200)
    expect(data.content).toBe(validYaml)
    expect(data.parsed).toMatchObject({ route: { receiver: 'default' }, receivers: [{ name: 'default' }] })
  })

  it('updates an existing config', async () => {
    const { status, data } = await api('PUT', '/api/v2/alertmanager-configs/test-config', { content: updatedYaml })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    const { data: fetched } = await api('GET', '/api/v2/alertmanager-configs/test-config')
    expect(fetched.content).toBe(updatedYaml)
    expect(fetched.parsed.route.receiver).toBe('updated')
  })

  it('returns 404 for nonexistent config', async () => {
    const { status, data } = await api('GET', '/api/v2/alertmanager-configs/does-not-exist')
    expect(status).toBe(404)
    expect(data.error).toBeTruthy()
  })

  it('deletes a config', async () => {
    const { status, data } = await api('DELETE', '/api/v2/alertmanager-configs/test-config')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    const { data: list } = await api('GET', '/api/v2/alertmanager-configs')
    expect(list).not.toContain('test-config')
  })

  it('returns 404 when deleting an already-deleted config', async () => {
    const { status, data } = await api('DELETE', '/api/v2/alertmanager-configs/test-config')
    expect(status).toBe(404)
    expect(data.error).toBeTruthy()
  })

  it('rejects PUT with missing content', async () => {
    const { status, data } = await api('PUT', '/api/v2/alertmanager-configs/test-config', {})
    expect(status).toBe(400)
    expect(data.error).toBeTruthy()
  })
})
