import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'

let server, baseURL, tmpDir, helmOutputFile, promtoolCaptureFile, fakePromtool

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-test-'))
  helmOutputFile = path.join(tmpDir, 'helm-output.yaml')
  promtoolCaptureFile = path.join(tmpDir, 'promtool-rules.yaml')
  await fs.mkdir(path.join(tmpDir, 'charts', 'test-chart', 'templates'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'deployments', 'test-chart'), { recursive: true })

  await fs.writeFile(path.join(tmpDir, 'charts', 'test-chart', 'Chart.yaml'), 'apiVersion: v2\nname: test-chart\nversion: 0.1.0\ntype: application\n')
  await fs.writeFile(path.join(tmpDir, 'deployments', 'test-chart', 'staging-values.yaml'), 'replicas: 1\n')
  await fs.writeFile(path.join(tmpDir, 'charts', 'test-chart', 'templates', 'config.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n')

  const customDeploymentsDir = path.join(tmpDir, 'custom-deployments')
  await fs.mkdir(customDeploymentsDir, { recursive: true })
  await fs.writeFile(path.join(customDeploymentsDir, 'staging-values.yaml'), 'replicas: 2\n')

  const fakeHelm = path.join(tmpDir, 'fake-helm')
  await fs.writeFile(fakeHelm, `#!/bin/sh
if [ "$1" = "dependency" ]; then
  mkdir -p "$3/charts"
  echo "generated" > "$3/Chart.lock"
  exit 0
fi
cat "$FAKE_HELM_OUTPUT_FILE"
`, { mode: 0o755 })
  process.env.HELM_BIN = fakeHelm
  process.env.FAKE_HELM_OUTPUT_FILE = helmOutputFile

  fakePromtool = path.join(tmpDir, 'fake-promtool')
  await fs.writeFile(fakePromtool, `#!/bin/sh
cp "$3" "$PROMTOOL_CAPTURE_FILE"
if [ "$PROMTOOL_FAIL" = "1" ]; then
  echo "bad promql" >&2
  exit 1
fi
echo "Checking rules"
`, { mode: 0o755 })
  process.env.PROMTOOL_BIN = fakePromtool
  process.env.PROMTOOL_CAPTURE_FILE = promtoolCaptureFile

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

beforeEach(async () => {
  delete process.env.PROMTOOL_FAIL
  process.env.PROMTOOL_BIN = fakePromtool
  await fs.writeFile(helmOutputFile, '---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rendered\n')
  await fs.rm(promtoolCaptureFile, { force: true })
})

afterAll(async () => {
  delete process.env.HELM_BIN
  delete process.env.FAKE_HELM_OUTPUT_FILE
  delete process.env.PROMTOOL_BIN
  delete process.env.PROMTOOL_CAPTURE_FILE
  delete process.env.PROMTOOL_FAIL
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${urlPath}`, opts)
  return { status: res.status, data: await res.json() }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

describe('POST /api/v2/render/:chart/:deployment', () => {
  it('returns ok with rendered output for valid chart and deployment', async () => {
    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.output).toContain('rendered')
    expect(data.check).toMatchObject({ passed: true, skipped: true, errors: [] })
  })

  it('runs promtool check rules for rendered PrometheusRule groups', async () => {
    await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: first
spec:
  groups:
    - name: first.rules
      rules:
        - alert: FirstAlert
          expr: up == 0
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: second
spec:
  groups:
    - name: second.rules
      rules:
        - alert: SecondAlert
          expr: up == 1
`)

    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.check).toMatchObject({ passed: true, errors: [], output: 'Checking rules' })

    const checkedRules = yaml.load(await fs.readFile(promtoolCaptureFile, 'utf-8'))
    expect(checkedRules.groups.map(group => group.name)).toEqual(['first.rules', 'second.rules'])
  })

  it('keeps preview response ok when promtool reports rule errors', async () => {
    await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: invalid
spec:
  groups:
    - name: invalid.rules
      rules:
        - alert: InvalidAlert
          expr: broken(
`)
    process.env.PROMTOOL_FAIL = '1'

    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.output).toContain('PrometheusRule')
    expect(data.check.passed).toBe(false)
    expect(data.check.errors[0]).toContain('bad promql')
  })

  it('reports promtool check failure when the binary is unavailable', async () => {
    await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: valid
spec:
  groups:
    - name: valid.rules
      rules:
        - alert: ValidAlert
          expr: up == 0
`)
    process.env.PROMTOOL_BIN = path.join(tmpDir, 'missing-promtool')

    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.check).toMatchObject({
      passed: false
    })
    expect(data.check.errors[0]).toContain('Promtool is not available')
    expect(data.check.output).toContain('Promtool is not available')
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

  it('does not leave helm dependency artifacts in the live chart checkout', async () => {
    const chartDir = path.join(tmpDir, 'charts', 'test-chart')

    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(await pathExists(path.join(chartDir, 'Chart.lock'))).toBe(false)
    expect(await pathExists(path.join(chartDir, 'charts'))).toBe(false)
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
