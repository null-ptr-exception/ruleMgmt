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
import { buildRouting, writeRouting } from '../../server/lib/routingFiles.js'
import { openRepo } from '../../server/repo/openRepo.js'
import { loadRouting } from '../../server/repo/routing.js'

const SCRIPT = path.resolve('scripts/check-deployment.mjs')
const has = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true } catch { return false } }
const HAS_HELM = has('helm', ['version'])
const HAS_PROMTOOL = has('promtool', ['--version'])
const HAS_VMALERT = has('vmalert', ['-version'])
const PROMTOOL3 = process.env.PROMTOOL3_BIN || 'promtool3'
const HAS_PROMTOOL3 = has(PROMTOOL3, ['--version'])
if (!HAS_PROMTOOL3) console.warn(`check-deployment: promtool 3 (${PROMTOOL3}) not found — its case is skipped`)
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
{{- if .Values.twice }}
        - alert: TinyDown
          expr: {{ .Values.expr | quote }}
{{- end }}
{{- if .Values.p3 }}
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Release.Name }}-p3
  annotations:
    alertforge.io/profile: prometheus3
spec:
  groups:
    - name: p3
      rules:
        - alert: P3
          expr: {{ .Values.p3 | quote }}
          labels:
            service.name: api
{{- end }}
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

function check(target = dir, env = {}, args = []) {
  const r = spawnSync('node', [SCRIPT, ...args, target], { encoding: 'utf-8', env: { ...process.env, ...env } })
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
  // Helm names the file it stops on by its place on this machine: said in
  // the repo's terms, as Preview says it.
  it('says what Helm stops on without where the repo is on this machine', async () => {
    const values = path.join(gitops, 'charts', 'tiny', 'values.yaml')
    await fs.writeFile(values, 'x: 1\n')
    await fs.chmod(values, 0o000)
    try {
      const { code, out } = check(dir, {}, ['--repo', gitops])
      expect(out).toContain('helm could not render the deployment')
      expect(out).toContain('charts/tiny/values.yaml')
      expect(out).not.toContain(gitops)
      expect(code).toBe(1)
    } finally {
      await fs.chmod(values, 0o644)
    }
  })

  it('passes a deployment with good rules and no routing.yaml, checking only the rules', () => {
    const { code, out } = check()
    expect(out).toContain('Rules: passed (promtool)')
    expect(out).toContain('Routing: no routing.yaml — not checked')
    expect(code).toBe(0)
  })

  // promtool's lint (a duplicate rule) passes, as in Preview, but says so.
  it('checks the rules of a deployment of a repo reached through a link to it', async () => {
    const via = `${gitops}-via`
    await fs.symlink(gitops, via)
    try {
      execFileSync('git', ['init', '-q', gitops])
      const { out } = check(path.join(via, 'deployments', 'tiny', 'prod'))
      // Its rules and values; the routing part's own reading is the routing check's.
      expect(out).toContain('Rules: passed (promtool)')
      expect(out).not.toMatch(/not a path in the repo|cannot be read/)
    } finally {
      await fs.rm(via, { force: true })
    }
  })

  // Values AlertForge cannot tell Helm's reading of: Helm, at hand, decides.
  // Named by its place in the repo, or (no git, no --repo) in its folder's parent.
  const CANNOT_TELL = 'Values: AlertForge cannot tell how Helm reads prod/values.yaml'
  it('values AlertForge cannot tell Helm\'s reading of, which Helm renders, are checked as rendered, and said once', async () => {
    await deployment('  expr: up == 0\n  a: !!binary aGk=\n')
    const { code, out } = check()
    expect(out).toContain('Rules: passed')
    expect(out).toContain(CANNOT_TELL)
    expect(out.split('values.yaml').length - 1).toBe(1)
    expect(code).toBe(0)
  })

  it('a |2 block Helm renders is checked as rendered', async () => {
    await deployment('  expr: up == 0\n  note: |2\n     two spaces more\n')
    const { code, out } = check()
    expect(out).toContain(CANNOT_TELL)
    expect(code).toBe(0)
  })

  it('values larger than MAX_VALUES_BYTES that Helm renders are checked, naming the limit', async () => {
    await deployment(`  expr: up == 0\n  pad: "${'x'.repeat(1_150_000)}"\n`)
    const { code, out } = check()
    expect(out).toContain('Rules: passed')
    expect(out).toContain(CANNOT_TELL)
    expect(out).toContain('MAX_VALUES_BYTES')
    expect(code).toBe(0)
  })

  it('values it cannot tell that Helm fails on: the deployment would not deploy (exit 1), Helm\'s error and the file named', async () => {
    await deployment('  expr: up == 0\n  _common: [\n')
    const { code, out } = check()
    expect(out).toContain('helm could not render the deployment')
    expect(out).toContain(CANNOT_TELL)
    expect(code).toBe(1)
  })

  it('passes with warnings on a lint finding, and says it', async () => {
    await deployment('  expr: up == 0\n  twice: true\n')
    const { code, out } = check()
    expect(out).toContain('Rules: passed with warnings (promtool)')
    expect(out).toContain('duplicate rule')
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

  it('with no repo root, reads a routing.yaml linked to a file elsewhere in the repo', async () => {
    await writeRouting(dir, buildRouting(ROUTING))
    await fs.mkdir(path.join(gitops, 'notes'))
    await fs.rename(path.join(dir, 'routing.yaml'), path.join(gitops, 'notes', 'r.yaml'))
    await fs.symlink('../../../notes/r.yaml', path.join(dir, 'routing.yaml'))
    const { code, out } = check()
    expect(out).toContain('Routing: passed')
    expect(code).toBe(0)
  })

  it.skipIf(process.getuid?.() === 0)('names a resource it cannot read in a folder whose name has brackets', async () => {
    const odd = path.join(gitops, 'deployments', 'tiny', 'prod (old)')
    await fs.rename(dir, odd)
    dir = odd
    await writeRouting(dir, buildRouting(ROUTING))
    const cr = path.join(dir, 'templates', 'alertmanagerconfig.yaml')
    await fs.chmod(cr, 0)
    try {
      const { code, out } = check(dir, {}, ['--repo', gitops])
      expect(out).toContain('Routing: templates/alertmanagerconfig.yaml cannot be read (permission denied)')
      // A file of its own that cannot be read: it would not deploy as written.
      expect(code).toBe(1)
    } finally {
      await fs.chmod(cr, 0o644)
    }
  })

  it('a deployment that is the repo\'s root itself is a named refusal, not a crash', () => {
    const { code, out } = check(dir, {}, ['--repo', dir])
    expect(out).not.toContain('TypeError')
    expect(out).toContain('is not a deployment folder inside the repo')
    expect(code).toBe(2)
  })

  it('reports routing.yaml\'s problems as the Routing page does', async () => {
    await fs.writeFile(path.join(dir, 'routing.yaml'), ROUTING.replace('configs: [ops]', 'configs: [nobody]'))
    // The Routing page's reading of it: the one loader.
    const { errors } = (await loadRouting(openRepo(path.dirname(dir)), path.basename(dir))).value
    expect(errors.length).toBeGreaterThan(0)
    const { code, out } = check()
    expect(out).toContain('Routing: routing.yaml has problems')
    for (const e of errors) expect(out).toContain(e)
    expect(code).toBe(1)
  })

  it('passes a routing whose config notifies nobody, and says so', async () => {
    const routing = ROUTING.replace('ops@example.com', '"undisclosed-recipients:;"')
    await writeRouting(dir, buildRouting(routing))
    const { code, out } = check()
    expect(out).toContain('Routing: passed\n  warning: configs.ops: to "undisclosed-recipients:;" is a group with no members — this config notifies nobody')
    expect(code).toBe(0)
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
      expect(out).toContain('Routing: routing.yaml cannot be read (permission denied)')
      expect(out).not.toContain('    at ')
      expect(code).toBe(1)
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

  // Results on stdout, why it could not check on stderr.
  it('writes results to stdout and reasons it could not check to stderr', () => {
    const ok = spawnSync('node', [SCRIPT, dir], { encoding: 'utf-8' })
    expect(ok.stdout).toContain('Rules: passed')
    expect(ok.stdout).toContain('Routing:')
    const bad = spawnSync('node', [SCRIPT, dir], { encoding: 'utf-8', env: { ...process.env, PROMTOOL_BIN: '/nope/promtool' } })
    expect(bad.stderr).toContain('not available')
    expect(bad.stdout).not.toContain('not available')
  })

  // 3.x reads a UTF-8 label name and offset 0s, which 2.x refuses.
  it.skipIf(!HAS_PROMTOOL3)('checks a prometheus3 object with promtool 3, and says when it is missing', async () => {
    await deployment('  expr: up == 0\n  p3: "up offset 0s == 0"\n')
    const ok = check(dir, { PROMTOOL3_BIN: PROMTOOL3 })
    expect(ok.out).toContain('Rules: passed (promtool, promtool3)')
    expect(ok.code).toBe(0)

    await deployment('  expr: up == 0\n  p3: "up offset == 0"\n')
    const bad = check(dir, { PROMTOOL3_BIN: PROMTOOL3 })
    expect(bad.out).toContain('Rules: failed (promtool, promtool3)')
    expect(bad.code).toBe(1)

    const missing = check(dir, { PROMTOOL3_BIN: '/nope/promtool3' })
    expect(missing.out).toContain('Promtool 3 is not available: /nope/promtool3')
    expect(missing.code).toBe(2)
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

// A routing.yaml using shared notification configs (#123) is checked with
// the file the server reads: _shared/ at the repo's root — the git checkout,
// or --repo — and never one above it.
describe.skipIf(!CAN_RUN)('check-deployment with shared configs', () => {
  const SHARED_ROUTING = ROUTING.replace('ops: { type: email, to: ops@example.com }', 'ops: { shared: true }')
  const shared = to => `configs:\n  ops: { type: email, to: ${to} }\n`
  const writeShared = async (root, to) => {
    await fs.mkdir(path.join(root, '_shared'), { recursive: true })
    await fs.writeFile(path.join(root, '_shared', 'notification-configs.yaml'), shared(to))
  }
  // routing.yaml and its resource, made with the shared configs at the repo's root.
  const withRouting = async () => {
    const built = buildRouting(SHARED_ROUTING, { configs: { ops: { type: 'email', to: 'ops@example.com' } }, errors: [] })
    await writeRouting(dir, built)
  }

  it('reads the shared configs at the root of the git checkout', async () => {
    execFileSync('git', ['init', '-q', gitops])
    await writeShared(gitops, 'ops@example.com')
    await withRouting()
    const { code, out } = check()
    expect(out).toContain('Routing: passed')
    expect(code).toBe(0)
  })

  it('never one above the repo', async () => {
    // The repo is a folder inside another one, which has shared configs.
    const repo = path.join(gitops, 'inner')
    await fs.mkdir(repo)
    await fs.rename(path.join(gitops, 'charts'), path.join(repo, 'charts'))
    await fs.rename(path.join(gitops, 'deployments'), path.join(repo, 'deployments'))
    dir = path.join(repo, 'deployments', 'tiny', 'prod')
    execFileSync('git', ['init', '-q', repo])
    await writeShared(gitops, 'ops@example.com')
    await withRouting()
    const { code, out } = check()
    expect(out).toContain('uses the shared config ops, but there are no shared configs')
    expect(code).toBe(1)
  })

  it('takes the root from --repo, and says when it cannot tell it', async () => {
    await writeShared(gitops, 'ops@example.com')
    await withRouting()
    // Not a checkout: git says so, and the hint is --repo.
    let r = check()
    expect(r.out).toMatch(/uses shared configs \(ops\), and the repo's root cannot be told — git says: fatal: not a git repository[^\n]*\. Pass --repo <the gitops repo's root> \(in the image: --repo \/work\)/)
    expect(r.code).toBe(2)
    // git refusing a checkout it will not read (as for another uid's):
    // its own words are passed on.
    execFileSync('git', ['init', '-q', gitops])
    r = check(dir, { GIT_DIR: path.join(gitops, 'nowhere') })
    expect(r.out).toMatch(/cannot be told — git says: fatal: not a git repository: .*nowhere/)
    expect(r.code).toBe(2)
    r = check(dir, { GIT_DIR: path.join(gitops, 'nowhere') }, ['--repo', gitops])
    expect(r.out).toContain('Routing: passed')
    expect(r.code).toBe(0)
    await fs.rm(path.join(gitops, '.git'), { recursive: true, force: true })
    r = check(dir, {}, ['--repo', gitops])
    expect(r.out).toContain('Routing: passed')
    expect(r.code).toBe(0)
    r = check(dir, {}, ['--repo', path.join(gitops, 'charts')])
    expect(r.out).toMatch(/is not inside the repo/)
    expect(r.code).toBe(2)
  })

  it('names a shared file that cannot be read, and does not crash', async () => {
    execFileSync('git', ['init', '-q', gitops])
    await fs.mkdir(path.join(gitops, '_shared', 'notification-configs.yaml'), { recursive: true })
    await withRouting()
    const { code, out } = check()
    expect(out).toContain('_shared/notification-configs.yaml has problems')
    expect(code).toBe(1)
  })
})

// A deployment on a _common chart is checked with the repo's Templates, so
// with the repo's root: the git checkout, or --repo. When neither tells it,
// it stops and says why, rather than look in a smaller folder and report
// what Helm does not do. A deployment on no _common does not need git.
describe.skipIf(!CAN_RUN)('check-deployment on a _common stack', () => {
  // deployments/_common/tiny passes its values to charts/tiny, a Template.
  beforeEach(async () => {
    await fs.writeFile(path.join(gitops, 'charts', 'tiny', 'Chart.yaml'), 'apiVersion: v2\nname: tiny\nversion: 0.1.0\nannotations:\n  app: alertforge\n')
    const layer = path.join(gitops, 'deployments', '_common', 'tiny')
    await fs.mkdir(path.join(layer, 'charts'), { recursive: true })
    await fs.writeFile(path.join(layer, 'Chart.yaml'), 'apiVersion: v2\nname: common\nversion: 0.1.0\ndependencies:\n  - name: tiny\n    version: 0.1.0\n')
    await fs.symlink(path.relative(path.join(layer, 'charts'), path.join(gitops, 'charts', 'tiny')), path.join(layer, 'charts', 'tiny'))
    await fs.writeFile(path.join(layer, 'values.yaml'), 'tiny:\n  expr: up == 0\n')
    await fs.writeFile(path.join(dir, 'Chart.yaml'),
      'apiVersion: v2\nname: prod\nversion: 0.1.0\ndependencies:\n  - name: common\n    version: 0.1.0\n    repository: file://../../_common/tiny\n')
    await fs.writeFile(path.join(dir, 'values.yaml'), 'common:\n  tiny: {}\n')
  })

  it('checks it in a git checkout, or with --repo', () => {
    let r = check(dir, {}, ['--repo', gitops])
    expect(r.out).toContain('Rules: passed')
    expect(r.code).toBe(0)
    execFileSync('git', ['init', '-q', gitops])
    r = check()
    expect(r.out).toContain('Rules: passed')
    expect(r.code).toBe(0)
  })

  it('says when the root cannot be told, in git\'s words, and how to give it', () => {
    let r = check()
    expect(r.out).toMatch(/Rules: the deployment renders on a _common chart, and the repo's root cannot be told — git says: fatal: not a git repository[^\n]*\. Pass --repo <the gitops repo's root> \(in the image: --repo \/work\)/)
    expect(r.out).not.toContain('Helm would not render it')
    expect(r.code).toBe(2)
    // A checkout git will not read (as another uid's).
    execFileSync('git', ['init', '-q', gitops])
    r = check(dir, { GIT_DIR: path.join(gitops, 'nowhere') })
    expect(r.out).toMatch(/cannot be told — git says: fatal: not a git repository: .*nowhere/)
    expect(r.code).toBe(2)
  })

  it('says when the root given with --repo is a folder inside the repo, not its root', () => {
    const r = check(dir, {}, ['--repo', path.join(gitops, 'deployments')])
    expect(r.out).toContain(`Rules: the deployment renders on a _common chart, and ${path.join(gitops, 'deployments')}, given with --repo, is not the gitops repo's root: it has no charts/ folder with the Templates. Pass --repo`)
    expect(r.out).not.toContain('has no link to')
    expect(r.code).toBe(2)
  })

  it('a deployment on no _common does not read --repo when it is inside it; outside it, it is not checked', async () => {
    const plain = path.join(gitops, 'deployments', 'tiny', 'dev')
    await fs.mkdir(plain, { recursive: true })
    await fs.writeFile(path.join(plain, 'Chart.yaml'),
      'apiVersion: v2\nname: dev\nversion: 0.1.0\ndependencies:\n  - name: tiny\n    version: 0.1.0\n    repository: file://../../../charts/tiny\n')
    await fs.writeFile(path.join(plain, 'values.yaml'), 'tiny:\n  expr: up == 0\n')
    const r = check(plain, {}, ['--repo', os.tmpdir()])
    expect(r.out).toContain('Rules: passed')
    expect(r.code).toBe(0)
    const outside = check(plain, {}, ['--repo', path.join(gitops, 'charts')])
    expect(outside.code).toBe(2)
    expect(outside.out).toContain('is not inside the repo')
  })

  it('a deployment on no _common is checked without git, as before', async () => {
    const plain = path.join(gitops, 'deployments', 'tiny', 'dev')
    await fs.mkdir(plain, { recursive: true })
    await fs.writeFile(path.join(plain, 'Chart.yaml'),
      'apiVersion: v2\nname: dev\nversion: 0.1.0\ndependencies:\n  - name: tiny\n    version: 0.1.0\n    repository: file://../../../charts/tiny\n')
    await fs.writeFile(path.join(plain, 'values.yaml'), 'tiny:\n  expr: up == 0\n')
    // A PATH with node, helm and promtool, and no git.
    const bin = path.join(gitops, 'bin')
    await fs.mkdir(bin)
    const where = name => execFileSync('which', [name], { encoding: 'utf-8' }).trim()
    await fs.symlink(process.execPath, path.join(bin, 'node'))
    await fs.symlink(process.env.HELM_BIN || where('helm'), path.join(bin, 'helm'))
    await fs.symlink(where('promtool'), path.join(bin, 'promtool'))
    const r = check(plain, { PATH: bin })
    expect(spawnSync('git', ['--version'], { env: { PATH: bin } }).error?.code).toBe('ENOENT')
    expect(r.out).toContain('Rules: passed')
    expect(r.code).toBe(0)
  })
})
