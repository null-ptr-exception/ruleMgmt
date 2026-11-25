// The command line tools read a Template as the app does (the repo loader)
// and answer as Commit does: one comparison says whether the generated
// files are current, the rest of the Template is checked, a file that
// cannot be read is one ERROR line and exit 2. Each refusal has a value
// next to it that still goes through.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawnSync, execFileSync } from 'child_process'
import express from 'express'

const ROOT = path.resolve(import.meta.dirname, '../..')
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const HAS_HELM = spawnSync(process.env.HELM_BIN || 'helm', ['version'], { encoding: 'utf-8' }).status === 0
const tool = (name, ...args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', `${name}.mjs`), ...args], { encoding: 'utf-8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const CPU = 'columns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n    labels: {severity: warning}\n'
const RULE_OBJECT = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: {{ .Release.Name }}-extra\nspec:\n  groups:\n    - name: extra\n      rules:\n        - alert: Extra\n          expr: vector(1)\n'
const LEGACY = path.join(ROOT, 'tests/fixtures/legacy-1x/charts/mariadb-alerts')

let tmpDir, server, baseURL, chart
const abs = rel => path.join(tmpDir, rel)
const write = async (rel, text) => { await fs.mkdir(path.dirname(abs(rel)), { recursive: true }); await fs.writeFile(abs(rel), text) }
async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'template-cli-'))
  execFileSync('git', ['init', '-q'], { cwd: tmpDir })
  const names = ['templates', 'charts', 'folders']
  const routes = await Promise.all(names.map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  names.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  chart = abs('charts/demo')
})
afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  await fs.chmod(abs('charts/demo/values.schema.json'), 0o644).catch(() => {})
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('gen-rules --check and gen-chart --check answer as Commit does', () => {
  it('a current Template passes both', () => {
    expect(tool('gen-rules', chart, '--check').code).toBe(0)
    expect(tool('gen-chart', chart, '--check').code).toBe(0)
  })

  it('a schema behind rules/ fails gen-chart --check too, naming it', async () => {
    await write('charts/demo/values.schema.json', '{\n  "type": "object",\n  "properties": {}\n}\n')
    const r = tool('gen-chart', chart, '--check')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/DIFFERS\s+values\.schema\.json/)
  })

  it('a schema saved before x-once-groups is current, as Commit says', async () => {
    const schema = JSON.parse(await fs.readFile(abs('charts/demo/values.schema.json'), 'utf-8'))
    delete schema['x-once-groups']
    await write('charts/demo/values.schema.json', `${JSON.stringify(schema, null, 2)}\n`)
    expect(tool('gen-rules', chart, '--check').code).toBe(0)
  })

  it('a partial holding a rule object stops them, before anything is written; one with defines only does not', async () => {
    await write('charts/demo/templates/_helpers.yaml', '{{- define "demo.x" -}}y{{- end -}}\n')
    expect(tool('gen-rules', chart, '--check').code).toBe(0)
    await write('charts/demo/templates/_extra.yaml', RULE_OBJECT)
    const r = tool('gen-rules', chart)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^ERROR {2}charts\/demo\/templates\/_extra\.yaml starts with _/m)
  })
})

describe('a chart not converted, or whose rules/ is gone', () => {
  it('gen-chart refuses a 1.x chart (its rule file would render each alert twice); gen-rules converts it', async () => {
    await fs.cp(LEGACY, abs('charts/mariadb-alerts'), { recursive: true })
    const before = await fs.readdir(abs('charts/mariadb-alerts/templates'))
    const r = tool('gen-chart', abs('charts/mariadb-alerts'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/not converted to rules\/ yet.*run gen-rules\.mjs/)
    expect(await fs.readdir(abs('charts/mariadb-alerts/templates'))).toEqual(before)
    expect(tool('gen-rules', abs('charts/mariadb-alerts')).code).toBe(0)
  })

  it('gen-rules refuses to convert a generated schema when rules/ is gone: it would write groups with no rules', async () => {
    await fs.rm(abs('charts/demo/rules'), { recursive: true })
    const r = tool('gen-rules', chart)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/restore rules\//)
    await expect(fs.access(abs('charts/demo/rules'))).rejects.toThrow()
  })
})

describe('a file the tools cannot read', () => {
  it.skipIf(IS_ROOT)('import-rules: one ERROR line and exit 2, not a stack trace', async () => {
    await write('rules.yaml', 'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n')
    await fs.chmod(abs('charts/demo/values.schema.json'), 0)
    const r = tool('import-rules', abs('rules.yaml'), chart)
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/^ERROR {2}.*values\.schema\.json cannot be read: permission denied$/m)
    expect(r.out).not.toMatch(/^\s+at /m)
  })
})

describe.skipIf(!HAS_HELM)('check-deployment, its Template\'s part', () => {
  it('a generated template missing fails it; the Template as generated passes', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/demo/d', chart: 'demo' })).status).toBe(200)
    await write('deployments/demo/d/values.yaml', 'demo:\n  cpu:\n    - { job: api }\n')
    const dep = abs('deployments/demo/d')
    const ok = tool('check-deployment', '--repo', tmpDir, dep)
    expect(ok.code, ok.out).toBe(0)
    await fs.rm(abs('charts/demo/templates/cpu.yaml'))
    const r = tool('check-deployment', '--repo', tmpDir, dep)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/Template: failed[\s\S]*templates\/cpu\.yaml/)
  })
})

describe('the tools on files already there, shared values and names in use', () => {
  it('gen-rules --init leaves a Chart.yaml that is there as it is; --init --check passes it', async () => {
    const before = await fs.readFile(abs('charts/demo/Chart.yaml'), 'utf-8')
    expect(tool('gen-rules', chart, '--init', '--check').code).toBe(0)
    expect(tool('gen-rules', chart, '--init').code).toBe(0)
    expect(await fs.readFile(abs('charts/demo/Chart.yaml'), 'utf-8')).toBe(before)
  })

  it.skipIf(IS_ROOT)('a Chart.yaml or values.yaml that cannot be read is exit 2 in all three', async () => {
    await write('rules.yaml', 'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n')
    for (const file of ['Chart.yaml', 'values.yaml']) {
      await fs.chmod(abs(`charts/demo/${file}`), 0)
      try {
        for (const [name, ...args] of [['gen-rules', chart], ['gen-rules', chart, '--check'], ['gen-chart', chart, '--check'], ['import-rules', abs('rules.yaml'), chart, '--dry-run']]) {
          const r = tool(name, ...args)
          expect(r.code, `${file} ${name} ${args.join(' ')}: ${r.out}`).toBe(2)
          expect(r.out).toMatch(new RegExp(`^ERROR {2}.*charts/demo/${file.replace('.', '\\.')} cannot be read: permission denied$`, 'm'))
        }
      } finally {
        await fs.chmod(abs(`charts/demo/${file}`), 0o644)
      }
    }
  })

  it('a chart given as a link outside any repo is worked on where it leads', async () => {
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'template-cli-copy-'))
    try {
      await fs.cp(chart, path.join(copy, 'demo'), { recursive: true })
      // the link somewhere else than the folder it leads to
      await fs.mkdir(path.join(copy, 'elsewhere'))
      await fs.symlink(path.join(copy, 'demo'), path.join(copy, 'elsewhere', 'link'))
      const r = tool('gen-rules', path.join(copy, 'elsewhere', 'link'), '--check')
      expect(r.code, r.out).toBe(0)
    } finally {
      await fs.rm(copy, { recursive: true, force: true })
    }
  })

  it('--check names a missing file and a hand-changed one together', async () => {
    await fs.rm(abs('charts/demo/templates/cpu.yaml'))
    await write('charts/demo/values.schema.json', '{\n  "type": "object",\n  "properties": {}\n}\n')
    const r = tool('gen-rules', chart, '--check')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/MISSING\s+templates\/cpu\.yaml/)
    expect(r.out).toMatch(/DIFFERS\s+values\.schema\.json/)
  })

  it('a values.yaml that is not YAML is said once, without the reader\'s own words repeated', async () => {
    await write('charts/demo/values.yaml', 'cpu: x: y\n')
    const r = tool('gen-rules', chart, '--check')
    expect(r.out).toMatch(/^ERROR {2}values\.yaml is not valid YAML: line 1: /m)
    expect(r.out).not.toMatch(/not valid YAML.*not valid YAML/)
  })
})

describe.skipIf(!HAS_HELM)('check-deployment, on a _common', () => {
  it('its Template is checked through the _common: a generated template missing fails it', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/d', chart: 'demo' })).status).toBe(200)
    await write('deployments/team/d/values.yaml', 'demo:\n  cpu:\n    - { job: api }\n')
    const plan = await api('GET', `/api/v2/folders/common/plan?${new URLSearchParams({ action: 'create', folder: 'deployments/team', chart: 'demo' })}`)
    expect(plan.status, JSON.stringify(plan.data)).toBe(200)
    const made = await fetch(`${baseURL}/api/v2/folders/common`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', folder: 'deployments/team', chart: 'demo', expected: plan.data.plan?.expected ?? plan.data.expected }) })
    expect(made.status, await made.text()).toBe(200)
    const dep = abs('deployments/team/d')
    expect(tool('check-deployment', '--repo', tmpDir, dep).code).toBe(0)
    await fs.rm(abs('charts/demo/templates/cpu.yaml'))
    const r = tool('check-deployment', '--repo', tmpDir, dep)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/Template: failed[\s\S]*templates\/cpu\.yaml/)
  })
})
