import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

// Uses real helm to verify that render does not write Chart.lock or charts/
// into the gitops working directory.

let server, baseURL, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-nopoll-'))

  // chart source
  const chartDir = path.join(tmpDir, 'charts', 'myalerts')
  await fs.mkdir(path.join(chartDir, 'templates'), { recursive: true })
  await fs.writeFile(path.join(chartDir, 'Chart.yaml'), [
    'apiVersion: v2',
    'name: myalerts',
    'version: 0.1.0',
    'type: application',
  ].join('\n') + '\n')
  await fs.writeFile(path.join(chartDir, 'values.yaml'), 'rules: []\n')
  await fs.writeFile(
    path.join(chartDir, 'templates', 'rule.yaml'),
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\n'
  )

  // non-folder mode: values file sits alongside the deployment name
  await fs.mkdir(path.join(tmpDir, 'deployments', 'myalerts'), { recursive: true })
  await fs.writeFile(path.join(tmpDir, 'deployments', 'myalerts', 'prod-values.yaml'), 'rules: []\n')

  // folder-mode deployment with file:// dependency
  const deployDir = path.join(tmpDir, 'deployments', 'myalerts', 'prod')
  await fs.mkdir(deployDir, { recursive: true })
  await fs.writeFile(path.join(deployDir, 'Chart.yaml'), [
    'apiVersion: v2',
    'name: myalerts-prod',
    'version: 0.1.0',
    'type: application',
    'dependencies:',
    '  - name: myalerts',
    '    version: "0.1.0"',
    '    repository: file://../../../charts/myalerts',
  ].join('\n') + '\n')
  await fs.writeFile(path.join(deployDir, 'values.yaml'), 'myalerts:\n  rules: []\n')

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
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('render does not pollute gitops working tree', () => {
  it('non-folder mode: no Chart.lock or charts/ written to chart source dir', async () => {
    const res = await fetch(
      `${baseURL}/api/v2/render/myalerts/prod`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    )
    const data = await res.json()
    expect(data.ok).toBe(true)

    const chartDir = path.join(tmpDir, 'charts', 'myalerts')
    const entries = await fs.readdir(chartDir)
    expect(entries).not.toContain('Chart.lock')
    expect(entries).not.toContain('charts')
  })

  it('folder mode: no Chart.lock or charts/ written to deployment dir', async () => {
    const folder = 'deployments/myalerts/prod'
    const res = await fetch(
      `${baseURL}/api/v2/render/myalerts/prod?folder=${encodeURIComponent(folder)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    )
    const data = await res.json()
    expect(data.ok).toBe(true)

    const deployDir = path.join(tmpDir, 'deployments', 'myalerts', 'prod')
    const entries = await fs.readdir(deployDir)
    expect(entries).not.toContain('Chart.lock')
    expect(entries).not.toContain('charts')
  })
})
