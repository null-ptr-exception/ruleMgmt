import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'

let server, baseURL, tmpDir, helmOutputFile, helmArgsFile, promtoolCaptureFile, promtoolCaptureDir, fakePromtool

async function readPromtoolInvocations() {
  const files = (await fs.readdir(promtoolCaptureDir)).sort((a, b) => parseInt(a) - parseInt(b))
  return Promise.all(files.map(async f => yaml.load(await fs.readFile(path.join(promtoolCaptureDir, f), 'utf-8'))))
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-test-'))
  helmOutputFile = path.join(tmpDir, 'helm-output.yaml')
  helmArgsFile = path.join(tmpDir, 'helm-args.log')
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
echo "$@" >> "$FAKE_HELM_ARGS_FILE"
if [ "$1" = "dependency" ]; then
  mkdir -p "$3/charts"
  echo "generated" > "$3/Chart.lock"
  exit 0
fi
cat "$FAKE_HELM_OUTPUT_FILE"
`, { mode: 0o755 })
  process.env.HELM_BIN = fakeHelm
  process.env.FAKE_HELM_OUTPUT_FILE = helmOutputFile
  process.env.FAKE_HELM_ARGS_FILE = helmArgsFile

  fakePromtool = path.join(tmpDir, 'fake-promtool')
  // Capture every invocation: render.js now checks one temp file per rendered
  // CR, so a single capture path would only ever hold the last one.
  await fs.writeFile(fakePromtool, `#!/bin/sh
n=$(cat "$PROMTOOL_CAPTURE_COUNTER" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$PROMTOOL_CAPTURE_COUNTER"
cp "$3" "$PROMTOOL_CAPTURE_DIR/$n.yaml"
cp "$3" "$PROMTOOL_CAPTURE_FILE"
if [ "$PROMTOOL_FAIL" = "1" ]; then
  echo "bad promql" >&2
  exit 1
fi
echo "Checking rules"
`, { mode: 0o755 })
  process.env.PROMTOOL_BIN = fakePromtool
  process.env.PROMTOOL_CAPTURE_FILE = promtoolCaptureFile
  promtoolCaptureDir = path.join(tmpDir, 'promtool-invocations')
  await fs.mkdir(promtoolCaptureDir, { recursive: true })
  process.env.PROMTOOL_CAPTURE_DIR = promtoolCaptureDir
  process.env.PROMTOOL_CAPTURE_COUNTER = path.join(tmpDir, 'promtool-counter')

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
  await fs.rm(promtoolCaptureDir, { recursive: true, force: true })
  await fs.mkdir(promtoolCaptureDir, { recursive: true })
  await fs.rm(process.env.PROMTOOL_CAPTURE_COUNTER, { force: true })
})

afterAll(async () => {
  delete process.env.HELM_BIN
  delete process.env.FAKE_HELM_OUTPUT_FILE
  delete process.env.PROMTOOL_BIN
  delete process.env.PROMTOOL_CAPTURE_FILE
  delete process.env.PROMTOOL_CAPTURE_DIR
  delete process.env.PROMTOOL_CAPTURE_COUNTER
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
    expect(data.check.passed).toBe(true)
    expect(data.check.errors).toEqual([])
    // More than one object, so the aggregated output names each one.
    expect(data.check.output).toContain('first:')
    expect(data.check.output).toContain('second:')

    // Each CR is checked in its own file, never merged.
    const invocations = await readPromtoolInvocations()
    expect(invocations.map(inv => inv.groups.map(g => g.name))).toEqual([
      ['first.rules'],
      ['second.rules'],
    ])
  })

  it('checks each CR in its own file, so a group sharded across objects is not a false duplicate', async () => {
    // A group over the row/byte budget renders as several CRs that all carry
    // the same spec.groups[].name. Merged into one file, promtool would report
    // "groupname ... is repeated in the same file"; per file it is fine.
    await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-traffic-1-1
spec:
  groups:
    - name: traffic
      rules:
        - alert: TrafficHigh
          expr: up == 0
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-traffic-1-2
spec:
  groups:
    - name: traffic
      rules:
        - alert: TrafficHigh
          expr: up == 1
`)

    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(status).toBe(200)
    expect(data.check.passed).toBe(true)

    const invocations = await readPromtoolInvocations()
    expect(invocations).toHaveLength(2)
    for (const inv of invocations) {
      expect(inv.groups.map(g => g.name)).toEqual(['traffic'])
    }
  })

  it('names the offending object when one CR fails promtool', async () => {
    await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-good-1-1
spec:
  groups:
    - name: good
      rules:
        - alert: GoodAlert
          expr: up == 0
`)
    process.env.PROMTOOL_FAIL = '1'

    const { data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(data.ok).toBe(true)
    expect(data.check.passed).toBe(false)
    expect(data.check.output).toContain('rel-good-1-1')
    expect(data.check.output).toContain('bad promql')
  })

  it('flags <no value> and leftover ${...} placeholders in the rendered output', async () => {
    await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-x-1-1
spec:
  groups:
    - name: x
      rules:
        - alert: XAlert
          expr: up > <no value>
          annotations:
            summary: "over \${recv_warn}"
`)

    const { data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(data.selfCheck.passed).toBe(false)
    expect(data.selfCheck.problems.join('\n')).toContain('<no value>')
    expect(data.selfCheck.problems.join('\n')).toContain('${recv_warn}')
  })

  it('passes the self-check for clean rendered output', async () => {
    await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-x-1-1
spec:
  groups:
    - name: x
      rules:
        - alert: XAlert
          expr: up == 0
`)

    const { data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(data.selfCheck).toMatchObject({ passed: true, problems: [] })
  })

  describe('summary', () => {
    const schemaFile = () => path.join(tmpDir, 'charts', 'test-chart', 'values.schema.json')
    const valuesFile = () => path.join(tmpDir, 'deployments', 'test-chart', 'staging-values.yaml')

    afterEach(async () => {
      await fs.rm(schemaFile(), { force: true })
      await fs.writeFile(valuesFile(), 'replicas: 1\n')
    })

    it('counts rendered alerts by group, name and severity, and lists template alerts that produced nothing', async () => {
      await fs.writeFile(schemaFile(), JSON.stringify({
        type: 'object',
        properties: {
          traffic: {
            type: 'array',
            'x-rules': [
              { alert: 'TrafficHigh', expr: 'x > ${warn}', labels: { severity: 'warning' } },
              { alert: 'TrafficHigh', expr: 'x > ${crit}', labels: { severity: 'critical' } },
            ],
            items: { type: 'object', properties: { warn: { type: 'number' }, crit: { type: 'number' } } },
          },
          errors: {
            type: 'array',
            'x-rules': [{ alert: 'ErrorsHigh', expr: 'e > ${t}', labels: { severity: 'warning' } }],
            items: { type: 'object', properties: { t: { type: 'number' } } },
          },
        },
      }))
      await fs.writeFile(valuesFile(), yaml.dump({
        traffic: [{ warn: 1, crit: 2 }, { warn: 3 }],
        errors: [],
      }))
      await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-traffic-1-1
spec:
  groups:
    - name: traffic
      rules:
        - alert: TrafficHigh
          expr: x > 1
          labels: { severity: warning }
        - alert: TrafficHigh
          expr: x > 3
          labels: { severity: warning }
        - alert: TrafficHigh
          expr: x > 2
          labels: { severity: critical }
`)

      const { data } = await api('POST', '/api/v2/render/test-chart/staging')

      expect(data.summary.total).toBe(3)
      const traffic = data.summary.groups.find(g => g.name === 'traffic')
      expect(traffic.rowCount).toBe(2)
      expect(traffic.state).toBe('ok')
      expect(traffic.alerts).toEqual([
        { alert: 'TrafficHigh', severity: 'critical', count: 1 },
        { alert: 'TrafficHigh', severity: 'warning', count: 2 },
      ])
      // Both of the template's (alert, severity) pairs rendered at least once.
      expect(traffic.missing).toEqual([])

      const errors = data.summary.groups.find(g => g.name === 'errors')
      expect(errors.rowCount).toBe(0)
      expect(errors.state).toBe('empty')
      expect(errors.missing).toEqual([{ alert: 'ErrorsHigh', severity: 'warning' }])
    })

    it('marks a group with rows but no rendered alerts as no-alerts, distinct from empty', async () => {
      await fs.writeFile(schemaFile(), JSON.stringify({
        type: 'object',
        properties: {
          errors: {
            type: 'array',
            'x-rules': [{ alert: 'ErrorsHigh', expr: 'e > ${t}', labels: { severity: 'warning' } }],
            items: { type: 'object', properties: { t: { type: 'number' } } },
          },
        },
      }))
      await fs.writeFile(valuesFile(), yaml.dump({ errors: [{ t: 5 }] }))
      // Helm rendered no PrometheusRule at all (e.g. every rule guarded off).
      await fs.writeFile(helmOutputFile, '---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rendered\n')

      const { data } = await api('POST', '/api/v2/render/test-chart/staging')

      const errors = data.summary.groups.find(g => g.name === 'errors')
      expect(errors.rowCount).toBe(1)
      expect(errors.state).toBe('no-alerts')
    })

    it('reports value keys the schema no longer has as orphan fields', async () => {
      await fs.writeFile(schemaFile(), JSON.stringify({
        type: 'object',
        properties: {
          _common: { type: 'object', properties: { owner: { type: 'string' } } },
          traffic: {
            type: 'array',
            'x-rules': [{ alert: 'TrafficHigh', expr: 'x > ${warn}', labels: { severity: 'warning' } }],
            items: { type: 'object', properties: { warn: { type: 'number' } } },
          },
        },
      }))
      await fs.writeFile(valuesFile(), yaml.dump({
        _common: { owner: 'team-a', old_common: 'x' },
        traffic: [{ warn: 1, dropped_field: 9 }],
        gone_group: [{ a: 1 }],
      }))
      await fs.writeFile(helmOutputFile, '---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rendered\n')

      const { data } = await api('POST', '/api/v2/render/test-chart/staging')

      expect(data.summary.orphanFields.sort()).toEqual(['dropped_field', 'gone_group', 'old_common'])
    })
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

  // Renders run in place, per the decision in #29 → PR #30 (closed) → PR #31:
  // helm's on-disk artifacts are kept out of version control by the gitops
  // repo's own .gitignore (doc/gitops-repo-setup.md), not app-level temp-dir
  // isolation. `dependency update` rather than `build` matters: build
  // hard-errors on a stale Chart.lock as soon as a chart version is bumped.
  it('runs helm dependency update against the live chart dir', async () => {
    const chartDir = path.join(tmpDir, 'charts', 'test-chart')
    await fs.rm(helmArgsFile, { force: true })

    const { status, data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    const helmCalls = (await fs.readFile(helmArgsFile, 'utf-8')).trim().split('\n')
    expect(helmCalls[0]).toContain(`dependency update ${chartDir}`)
    expect(helmCalls[1]).toContain(`template test-chart-staging ${chartDir}`)
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
