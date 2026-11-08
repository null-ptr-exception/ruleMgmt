// #127: scripts/check-deployment.mjs checks a deployment outside the editor —
// its rule objects as Preview does, its routing.yaml as the Routing page
// does — with the real helm, promtool and vmalert.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import renderRouter from '../../server/routes/render.js'
import { buildRouting, writeRouting, routingState } from '../../server/lib/routingFiles.js'

const SCRIPT = path.resolve('scripts/check-deployment.mjs')
const has = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true } catch { return false } }
const HAS_HELM = has('helm', ['version'])
const HAS_PROMTOOL = has('promtool', ['--version'])
const HAS_VMALERT = has('vmalert', ['-version'])
const CAN_RUN = HAS_HELM && HAS_PROMTOOL
if (!CAN_RUN) console.warn('check-deployment: helm or promtool not found — the cases are skipped')

// One PrometheusRule, and a vlogs VMRule when `logs` is set.
const TEMPLATE = `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Release.Name }}-tiny
spec:
  groups:
    - name: tiny
      rules:
        - alert: TinyDown
          expr: {{ .Values.expr | quote }}
{{- if .Values.logs }}
---
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: {{ .Release.Name }}-logs
spec:
  groups:
    - name: logs
      type: vlogs
      rules:
        - alert: TooManyErrors
          expr: {{ .Values.logs | quote }}
{{- end }}
`

const ROUTING = `labels:
  severity: [critical]
configs:
  ops: { type: email, to: ops@example.com }
cells:
  - match: { severity: critical }
    configs: [ops]
`

let gitops, dir

async function deployment(values) {
  await fs.writeFile(path.join(dir, 'values.yaml'), `tiny:\n${values}`)
}

function check(target = dir, env = {}) {
  const r = spawnSync('node', [SCRIPT, target], { encoding: 'utf-8', env: { ...process.env, ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeEach(async () => {
  gitops = await fs.mkdtemp(path.join(os.tmpdir(), 'check-deployment-'))
  const chart = path.join(gitops, 'charts', 'tiny')
  await fs.mkdir(path.join(chart, 'templates'), { recursive: true })
  await fs.writeFile(path.join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: tiny\nversion: 0.1.0\n')
  await fs.writeFile(path.join(chart, 'templates', 'rules.yaml'), TEMPLATE)
  dir = path.join(gitops, 'deployments', 'tiny', 'prod')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'Chart.yaml'),
    'apiVersion: v2\nname: prod\nversion: 0.1.0\ndependencies:\n  - name: tiny\n    version: 0.1.0\n    repository: file://../../../charts/tiny\n')
  await deployment('  expr: up == 0\n')
})

afterEach(async () => {
  await fs.rm(gitops, { recursive: true, force: true })
})

describe.skipIf(!CAN_RUN)('check-deployment', () => {
  it('passes a deployment with good rules and no routing.yaml, checking only the rules', () => {
    const { code, out } = check()
    expect(out).toContain('Rules: passed (promtool)')
    expect(out).toContain('Routing: no routing.yaml — not checked')
    expect(code).toBe(0)
  })

  it('fails on a rule promtool cannot parse, naming it', async () => {
    await deployment('  expr: "up =="\n')
    const { code, out } = check()
    expect(out).toContain('Rules: failed (promtool)')
    expect(out).toContain('TinyDown')
    expect(code).toBe(1)
  })

  it.skipIf(!HAS_VMALERT)('checks a LogsQL rule with vmalert', async () => {
    await deployment('  expr: up == 0\n  logs: "error | stats count() as errors | filter errors:>10"\n')
    expect(check()).toMatchObject({ code: 0 })
    expect(check().out).toContain('Rules: passed (promtool, vmalert)')

    await deployment('  expr: up == 0\n  logs: "error | stats count( as"\n')
    const { code, out } = check()
    expect(out).toContain('Rules: failed (promtool, vmalert)')
    expect(code).toBe(1)
  })

  it('reports routing.yaml\'s problems as the Routing page does', async () => {
    await fs.writeFile(path.join(dir, 'routing.yaml'), ROUTING.replace('configs: [ops]', 'configs: [nobody]'))
    const { errors } = await routingState(dir)
    expect(errors.length).toBeGreaterThan(0)
    const { code, out } = check()
    expect(out).toContain('Routing: routing.yaml has problems')
    for (const e of errors) expect(out).toContain(e)
    expect(code).toBe(1)
  })

  it('passes a routing.yaml whose AlertmanagerConfig is current', async () => {
    await writeRouting(dir, buildRouting(ROUTING))
    const { code, out } = check()
    expect(out).toContain('Routing: passed')
    expect(code).toBe(0)
  })

  it('fails when routing.yaml was edited by hand and the AlertmanagerConfig not generated again', async () => {
    await writeRouting(dir, buildRouting(ROUTING))
    await fs.writeFile(path.join(dir, 'routing.yaml'), ROUTING.replace('ops@example.com', 'oncall@example.com'))
    const { code, out } = check()
    expect(out).toContain('templates/alertmanagerconfig.yaml is not what routing.yaml generates now')
    expect(code).toBe(1)
  })

  it('says the same about the rules as Preview', async () => {
    await deployment('  expr: "up =="\n')
    const app = express()
    app.use((req, _res, next) => { req.gitopsDir = gitops; next() })
    app.use('/render', renderRouter())
    const server = app.listen(0)
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/render/tiny/prod?folder=deployments/tiny/prod`, { method: 'POST' })
      const { check: preview } = await res.json()
      expect(preview.passed).toBe(false)
      // Each run checks in its own temp folder, which promtool names.
      const tmp = text => text.replace(/alertforge-check-[^/]+/g, 'alertforge-check-X')
      expect(tmp(check().out)).toContain(tmp(preview.output))
    } finally {
      server.close()
    }
  })

  it('runs with no writable home, as any uid in a container does', () => {
    const r = spawnSync('node', [SCRIPT, dir], {
      encoding: 'utf-8',
      env: Object.fromEntries(Object.entries({ ...process.env, HOME: '/nonexistent' }).filter(([k]) => !k.startsWith('HELM_') || k === 'HELM_BIN')),
    })
    expect(`${r.stdout}${r.stderr}`).toContain('Rules: passed')
    expect(r.status).toBe(0)
  })
})

describe('check-deployment on a folder it cannot check', () => {
  it('explains that a folder of <name>-values.yaml files is not supported', async () => {
    const legacy = path.join(gitops, 'deployments', 'old')
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, 'staging-values.yaml'), 'a: 1\n')
    const { code, out } = check(legacy)
    expect(out).toContain('Only a folder deployment')
    expect(code).toBe(2)
  })

  it('says a folder is not a deployment', async () => {
    const { code, out } = check(path.join(gitops, 'charts'))
    expect(out).toContain('is not a deployment')
    expect(code).toBe(2)
  })
})
