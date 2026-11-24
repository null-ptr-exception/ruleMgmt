// No route answers the browser with where the workspace is on the server: a
// file that cannot be read or written makes the error name it, and the
// answer carries the path inside the workspace only (#187).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

// chmod does not stop root from reading or writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let server, baseURL, tmpDir, real, errors
const SRC = 'deployments/team/src'
const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > 1\n'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'answers-'))
  real = await fs.realpath(tmpDir)
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  for (const [mount, file] of [['charts', 'charts'], ['templates', 'templates'], ['deployments', 'deployments'], ['folders', 'folders'], ['sync', 'sync'], ['render', 'render'], ['routing/shared', 'routingShared'], ['git', 'git']]) {
    const { default: router } = await import(`../../server/routes/${file}.js`)
    app.use(`/api/v2/${mount}`, router())
  }
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: SRC, chart: 'demo' })).status).toBe(200)
})

afterEach(async () => {
  errors.mockRestore()
  if (server) await new Promise(r => server.close(r))
  for (const rel of ['charts/demo/Chart.yaml', 'charts/demo/rules', `${SRC}/values.yaml`, 'charts']) await fs.chmod(path.join(tmpDir, rel), 0o755).catch(() => {})
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, text: await res.text() }
}
const q = f => `?folder=${encodeURIComponent(f)}`

describe.skipIf(IS_ROOT)('an error answer', () => {
  it.each([
    ['a Template whose default values are a folder', async () => {
      await fs.rm(path.join(tmpDir, 'charts/demo/values.yaml'), { force: true })
      await fs.mkdir(path.join(tmpDir, 'charts/demo/values.yaml'))
    },
      () => api('POST', '/api/v2/templates/demo/values', { values: {} })],
    ['a Template whose Chart.yaml cannot be read', () => fs.chmod(path.join(tmpDir, 'charts/demo/Chart.yaml'), 0o000),
      () => api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: 'x' } })],
    ['a deployment whose values cannot be read', () => fs.chmod(path.join(tmpDir, SRC, 'values.yaml'), 0o000),
      () => api('GET', `/api/v2/deployments/demo/src${q(SRC)}`)],
    ['a new Template where charts/ cannot be written', () => fs.chmod(path.join(tmpDir, 'charts'), 0o555),
      () => api('POST', '/api/v2/charts', { name: 'other' })],
    ['a deployment whose values cannot be written', () => fs.chmod(path.join(tmpDir, SRC, 'values.yaml'), 0o444),
      () => api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p' }] } })],
  ])('for %s names no server path', async (_, breakIt, request) => {
    await breakIt()
    const { status, text } = await request()
    expect(status).toBeGreaterThanOrEqual(400)
    expect(text).not.toContain(tmpDir)
    expect(text).not.toContain(real)
  })
})
