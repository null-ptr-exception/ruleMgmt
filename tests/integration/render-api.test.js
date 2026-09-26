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
  // CR, so a single capture path would only ever hold the last one. render.js
  // runs these concurrently (Promise.all), so the capture name is derived
  // from $3's own basename — which already carries a deterministic,
  // zero-padded index — rather than a shared counter file, which would race
  // across concurrent shells.
  await fs.writeFile(fakePromtool, `#!/bin/sh
cp "$3" "$PROMTOOL_CAPTURE_DIR/$(basename "$3")"
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
})

afterAll(async () => {
  delete process.env.HELM_BIN
  delete process.env.FAKE_HELM_OUTPUT_FILE
  delete process.env.PROMTOOL_BIN
  delete process.env.PROMTOOL_CAPTURE_FILE
  delete process.env.PROMTOOL_CAPTURE_DIR
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

  it('flags <no value> in the rendered output', async () => {
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
`)

    const { data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(data.selfCheck.passed).toBe(false)
    expect(data.selfCheck.problems.join('\n')).toContain('<no value>')
  })

  it('does not flag a literal ${...} placeholder — that integrity is owned by the save-time check', async () => {
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
          annotations:
            summary: "using grafana var \${__interval:raw}"
`)

    const { data } = await api('POST', '/api/v2/render/test-chart/staging')

    expect(data.selfCheck).toMatchObject({ passed: true, problems: [] })
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

    // A migrated chart's schema carries no rules — they live in rules/ — so the
    // summary and the self-check have to read them from there. Reading the
    // schema instead left every group with no possible alerts: `missing` never
    // fired, and no `{{ }}` was ever checked.
    it('reads a migrated chart\'s rules/ for missing alerts and preserved {{ }}', async () => {
      const rulesDir = path.join(tmpDir, 'charts', 'test-chart', 'rules')
      await fs.mkdir(rulesDir, { recursive: true })
      try {
        await fs.writeFile(path.join(rulesDir, 'traffic.yaml'), `group: traffic
columns:
  warn: {type: number}
rules:
  - alert: TrafficHigh
    expr: x > \${warn}
    labels: {severity: warning}
    annotations: {summary: "{{ $value }} on {{ $labels.pod }}"}
  - alert: TrafficLow
    expr: x < \${warn}
    labels: {severity: warning}
`)
        await fs.writeFile(schemaFile(), JSON.stringify({
          type: 'object',
          properties: { traffic: { type: 'array', items: { type: 'object', properties: { warn: { type: 'number' } } } } },
        }))
        await fs.writeFile(valuesFile(), yaml.dump({ traffic: [{ warn: 1 }] }))
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
          annotations: { summary: "{{ $value }} on " }
`)

        const { data } = await api('POST', '/api/v2/render/test-chart/staging')

        const traffic = data.summary.groups.find(g => g.name === 'traffic')
        expect(traffic.missing).toEqual([{ alert: 'TrafficLow', severity: 'warning' }])
        expect(data.selfCheck.passed).toBe(false)
        expect(data.selfCheck.problems.join('\n')).toContain('"TrafficHigh" rendered without `{{ $labels.pod }}`')
      } finally {
        await fs.rm(rulesDir, { recursive: true, force: true })
      }
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

    // 7-c: an `x-custom-template` group is a hand-written CR free to use any
    // rendered group name — guessing `valuesKey.replace('_','-')` for it and
    // reporting the (likely) mismatch as "no-alerts" would blame the chart
    // for our own wrong guess. It should show as `custom` instead, with its
    // actual rendered output — under whatever name it really used — listed
    // separately rather than silently dropped.
    it('does not force-match an x-custom-template group by guessed name', async () => {
      await fs.writeFile(schemaFile(), JSON.stringify({
        type: 'object',
        properties: {
          weird_naming: {
            type: 'array',
            'x-custom-template': true,
            items: { type: 'object', properties: { t: { type: 'number' } } },
          },
        },
      }))
      await fs.writeFile(valuesFile(), yaml.dump({ weird_naming: [{ t: 5 }] }))
      // Rendered under a group name nothing would guess from the values key.
      await fs.writeFile(helmOutputFile, `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-custom-1-1
spec:
  groups:
    - name: totally-different-name
      rules:
        - alert: CustomAlert
          expr: up == 0
`)

      const { data } = await api('POST', '/api/v2/render/test-chart/staging')

      const custom = data.summary.groups.find(g => g.valuesKey === 'weird_naming')
      expect(custom.state).toBe('custom')

      expect(data.summary.unmatchedGroups).toEqual([
        { name: 'totally-different-name', alerts: [{ alert: 'CustomAlert', severity: '', count: 1 }] },
      ])
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
    // --skip-refresh: the dependencies are file://, and a refresh would fetch
    // every repo index configured on the machine first.
    expect(helmCalls[0]).toContain(`dependency update --skip-refresh ${chartDir}`)
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
