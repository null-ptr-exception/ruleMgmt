import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-test-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'test-chart', 'templates'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'deployments', 'test-chart'), { recursive: true })

  await fs.writeFile(path.join(tmpDir, 'charts', 'test-chart', 'Chart.yaml'), 'apiVersion: v2\nname: test-chart\nversion: 0.1.0\ntype: application\n')
  await fs.writeFile(path.join(tmpDir, 'deployments', 'test-chart', 'staging-values.yaml'), 'replicas: 1\n')
  await fs.writeFile(path.join(tmpDir, 'charts', 'test-chart', 'templates', 'config.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n')

  const customDeploymentsDir = path.join(tmpDir, 'custom-deployments')
  await fs.mkdir(customDeploymentsDir, { recursive: true })
  await fs.writeFile(path.join(customDeploymentsDir, 'staging-values.yaml'), 'replicas: 2\n')

  const fakeHelm = path.join(tmpDir, 'fake-helm')
  await fs.writeFile(fakeHelm, '#!/bin/sh\necho "---"\necho "apiVersion: v1"\necho "kind: ConfigMap"\necho "metadata:"\necho "  name: rendered"', { mode: 0o755 })
  process.env.HELM_BIN = fakeHelm

  const { default: renderRouter } = await import('../../server/routes/render.js')

  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/render', renderRouter())

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

afterAll(async () => {
  delete process.env.HELM_BIN
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${urlPath}`, opts)
  return { status: res.status, data: await res.json() }
}

describe('POST /api/v2/render/:chart/:deployment', () => {
  it('returns ok with rendered output for valid chart and deployment', async () => {
    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.output).toContain('rendered')
  })

  it('returns 400 for invalid chart name', async () => {
    const { status, data } = await api('POST', '/api/v2/render/Invalid_Chart/staging')
    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })

  it('returns 400 for invalid deployment name', async () => {
    const { status, data } = await api('POST', '/api/v2/render/test-chart/Bad%20Name')
    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })

  it('uses custom deployments dir when folder query param is provided', async () => {
    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging?folder=custom-deployments')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.output).toContain('rendered')
  })

  it('returns 400 when folder query param contains ..', async () => {
    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging?folder=../etc')
    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })
})
