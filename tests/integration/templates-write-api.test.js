import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmpl-write-test-'))
  const chartDir = path.join(tmpDir, 'charts', 'test-chart', 'templates')
  await fs.mkdir(chartDir, { recursive: true })
  await fs.writeFile(path.join(tmpDir, 'charts', 'test-chart', 'Chart.yaml'), 'apiVersion: v2\nname: test-chart\nversion: 0.1.0\n')
  await fs.writeFile(path.join(tmpDir, 'charts', 'test-chart', 'values.yaml'), 'replicas: 1\n')

  const { default: templatesRouter } = await import('../../server/routes/templates.js')

  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())

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

describe('Templates write API', () => {
  it('saves values as object and reflects in GET /:chart', async () => {
    const { status, data } = await api('POST', '/api/v2/templates/test-chart/values', {
      values: { replicas: 3, image: { tag: 'latest' } },
    })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)

    const { data: info } = await api('GET', '/api/v2/templates/test-chart')
    expect(info.values.replicas).toBe(3)
    expect(info.values.image.tag).toBe('latest')
  })

  it('saves values as string and reflects in GET /:chart', async () => {
    const yamlStr = 'replicas: 5\nenv: production\n'
    const { status, data } = await api('POST', '/api/v2/templates/test-chart/values', {
      values: yamlStr,
    })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)

    const { data: info } = await api('GET', '/api/v2/templates/test-chart')
    expect(info.values.replicas).toBe(5)
    expect(info.values.env).toBe('production')
  })

  it('saves Chart.yaml metadata and reflects in GET /:chart', async () => {
    const chartMeta = { apiVersion: 'v2', name: 'test-chart', version: '1.2.3', description: 'Updated chart' }
    const { status, data } = await api('POST', '/api/v2/templates/test-chart/chart-meta', { chartMeta })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)

    const { data: info } = await api('GET', '/api/v2/templates/test-chart')
    expect(info.chartMeta.version).toBe('1.2.3')
    expect(info.chartMeta.description).toBe('Updated chart')
  })

  it('returns 404 for nonexistent template', async () => {
    const { status, data } = await api('GET', '/api/v2/templates/test-chart/no-such-template')
    expect(status).toBe(404)
    expect(data.error).toBeTruthy()
  })

  it('returns 400 for invalid chart name', async () => {
    const { status } = await api('GET', '/api/v2/templates/BAD CHART!')
    expect(status).toBe(400)
  })
})
