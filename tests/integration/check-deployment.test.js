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

// Preview's check of the same deployment, through its server route.
async function previewCheck() {
  const app = express()
  app.use((req, _res, next) => { req.gitopsDir = gitops; next() })
  app.use('/render', renderRouter())
  const server = app.listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/render/tiny/prod?folder=deployments/tiny/prod`, { method: 'POST' })
    return (await res.json()).check
  } finally {
    server.close()
  }
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
    // Once, and without the temp file it was checked in.
    expect(out.match(/could not parse expression/g)).toHaveLength(1)
    expect(out).not.toContain('alertforge-check-')
    expect(out).not.toContain('Command failed')
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
    const preview = await previewCheck()
    expect(preview.passed).toBe(false)
    expect(check().out).toContain(preview.output)
  })

  it('runs with no writable home, as any uid in a container does, and leaves no temp folder behind', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'check-deployment-tmpdir-'))
    try {
      const r = spawnSync('node', [SCRIPT, dir], {
        encoding: 'utf-8',
        env: Object.fromEntries(Object.entries({ ...process.env, HOME: '/nonexistent', TMPDIR: tmp }).filter(([k]) => !k.startsWith('HELM_') || k === 'HELM_BIN')),
      })
      expect(`${r.stdout}${r.stderr}`).toContain('Rules: passed')
      expect(r.status).toBe(0)
      expect(await fs.readdir(tmp)).toEqual([])
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('checks a deployment whose folder name has a space', async () => {
    const spaced = path.join(gitops, 'deployments', 'tiny', 'my env')
    await fs.cp(dir, spaced, { recursive: true })
    const { code, out } = check(spaced)
    expect(out).toContain('Rules: passed')
    expect(code).toBe(0)
  })

  it('reads the site\'s object labels: a CR generated with them is current only when they are passed', async () => {
    const labels = '{"release":"kps"}'
    process.env.RULE_OBJECT_LABELS = labels
    try {
      await writeRouting(dir, buildRouting(ROUTING))
    } finally {
      delete process.env.RULE_OBJECT_LABELS
    }
    expect(check(dir, { RULE_OBJECT_LABELS: '' })).toMatchObject({ code: 1 })
    const { code, out } = check(dir, { RULE_OBJECT_LABELS: labels })
    expect(out).toContain('Routing: passed')
    expect(code).toBe(0)
  })

  it.skipIf(!HAS_VMALERT)('says the same as Preview for a deployment that passes, with two objects', async () => {
    await deployment('  expr: up == 0\n  logs: "error | stats count() as errors | filter errors:>10"\n')
    const preview = await previewCheck()
    expect(preview.passed).toBe(true)
    expect(check().out).toContain(preview.output)
  })
})

// Exit 2: the check could not be made, as opposed to 1, a problem found.
describe.skipIf(!CAN_RUN)('check-deployment when it cannot check', () => {
  it('only warns on site labels that are not JSON, as gen-rules does', () => {
    const { code, out } = check(dir, { RULE_OBJECT_LABELS: '{team:a}' })
    expect(out).toContain('note:')
    expect(code).toBe(0)
  })

  // helm reads every file of the folder too, so it says so first.
  it.skipIf(process.getuid?.() === 0)('says which file it cannot read, in a line, after what it did check', async () => {
    await writeRouting(dir, buildRouting(ROUTING))
    const file = path.join(dir, 'routing.yaml')
    await fs.chmod(file, 0o000)
    try {
      const { code, out } = check()
      expect(out).toContain('helm could not render the deployment')
      expect(out).toMatch(/could not check: EACCES/)
      expect(out).not.toContain('    at ')
      expect(code).toBe(2)
    } finally {
      await fs.chmod(file, 0o644)
    }
  })

  it('says how a checker ended when it printed nothing', async () => {
    const silent = path.join(gitops, 'silent-promtool')
    await fs.writeFile(silent, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const { code, out } = check(dir, { PROMTOOL_BIN: silent })
    expect(out).toContain('Promtool check failed (exit code 3).')
    expect(code).toBe(1)
  })

  it('stops on site label settings it cannot read, as gen-rules does', () => {
    const { code, out } = check(dir, { RULE_OBJECT_LABELS_BY_PROFILE: '{"nope":{}}' })
    expect(out).toMatch(/nope/)
    expect(code).toBe(2)
  })

  it('says a missing helm or promtool is missing', () => {
    const helm = check(dir, { HELM_BIN: '/nope/helm' })
    expect(helm.out).toContain('helm is not available: /nope/helm')
    expect(helm.code).toBe(2)
    const { code, out } = check(dir, { PROMTOOL_BIN: '/nope/promtool' })
    expect(out).toContain('not available')
    expect(code).toBe(2)
  })
})

describe('check-deployment on a folder it cannot check', () => {
  it('explains that a folder of <name>-values.yaml files is not supported', async () => {
    const legacy = path.join(gitops, 'deployments', 'old')
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, 'staging-values.yaml'), 'a: 1\n')
    const { code, out } = check(legacy)
    expect(out).toContain('Only a folder deployment')
    expect(out).not.toContain('open it in AlertForge')
    expect(code).toBe(2)
  })

  it('refuses a file, extra arguments, or none, without a stack trace', () => {
    const file = check(path.join(dir, 'values.yaml'))
    expect(file.out).toContain('is not a folder')
    expect(file.out).not.toContain('    at ')
    expect(file.code).toBe(2)
    const r = spawnSync('node', [SCRIPT, dir, 'extra'], { encoding: 'utf-8' })
    expect(r.stderr).toContain('usage:')
    expect(r.status).toBe(2)
    const none = spawnSync('node', [SCRIPT], { encoding: 'utf-8' })
    expect(none.stderr).toContain('usage:')
    expect(none.status).toBe(2)
  })

  it('says a folder does not exist', () => {
    const { code, out } = check(path.join(gitops, 'nowhere'))
    expect(out).toContain('does not exist')
    expect(code).toBe(2)
  })

  it('says a folder is not a deployment', async () => {
    const { code, out } = check(path.join(gitops, 'charts'))
    expect(out).toContain('is not a deployment')
    expect(code).toBe(2)
  })
})
