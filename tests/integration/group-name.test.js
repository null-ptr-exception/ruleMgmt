// A group's own rule-group name (`name:`) through every way in: the save,
// Preview (Helm's output and its summary), gen-rules and gen-chart --check.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const GEN_RULES = path.resolve('scripts/gen-rules.mjs')
const GEN_CHART = path.resolve('scripts/gen-chart.mjs')

let server, baseURL, tmpDir

const CPU = name => `group: mariadb_cpu
${name}columns:
  db: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{db="\${db}"} > 1
    labels: {severity: warning}
`
const DISK = 'columns:\n  db: {type: string, required: true}\nrules:\n  - alert: DiskFull\n    expr: disk{db="${db}"} > 1\n'
const DIRECT = 'deployments/team/db'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-name-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const names = ['templates', 'deployments', 'folders', 'render']
  const routes = await Promise.all(names.map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  names.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const save = files => api('POST', '/api/v2/templates/demo/rules', { files })

describe('saving a rules file with name:', () => {
  it('takes one, and says so when it changes — never as a breaking change', async () => {
    expect((await save({ 'mariadb_cpu.yaml': CPU('') })).status).toBe(200)
    const { status, data } = await save({ 'mariadb_cpu.yaml': CPU('name: MariaDB CPU\n') })
    expect(status).toBe(200)
    expect(data.notices).toEqual([expect.objectContaining({ kind: 'group-name-changed', group: 'mariadb_cpu', from: 'mariadb-cpu', to: 'MariaDB CPU' })])
    expect(data.notices[0].description).toMatch(/alertgroup label/)
    // The template keeps its file, its object names and its values key.
    const template = await fs.readFile(path.join(tmpDir, 'charts/demo/templates/mariadb-cpu.yaml'), 'utf-8')
    expect(template).toContain('    - name: MariaDB CPU\n')
    expect(template).toContain('-mariadb-cpu-1-{{ add1 $chunkIndex }}')
    // Saved again unchanged: nothing to say.
    expect((await save({ 'mariadb_cpu.yaml': CPU('name: MariaDB CPU\n') })).data.notices).toEqual([])
  })

  it.each([
    ['name: null', CPU('name: null\n'), /name: is empty/],
    ['name: 5', CPU('name: 5\n'), /YAML reads this one as a number — quote it as written: name: \\"5\\"/],
    ['a leading space', CPU('name: " CPU"\n'), /starts or ends with a space/],
  ])('refuses %s, naming the file', async (_, text, why) => {
    const { status, data } = await save({ 'mariadb_cpu.yaml': text })
    expect(status).toBe(400)
    expect(JSON.stringify(data)).toMatch(why)
    expect(JSON.stringify(data)).toMatch(/mariadb_cpu\.yaml/)
  })

  it('refuses another group\'s name, its default included; a name differing in case is fine', async () => {
    const taken = await save({ 'mariadb_cpu.yaml': CPU(''), 'disk.yaml': `name: mariadb-cpu\n${DISK}` })
    expect(taken.status).toBe(400)
    expect(taken.data.errors).toEqual(['disk.yaml: name "mariadb-cpu" is already the rule-group name of mariadb_cpu.yaml (its default, from the file name) — two groups of a chart need two names'])
    expect((await save({ 'mariadb_cpu.yaml': CPU('name: CPU\n'), 'disk.yaml': `name: cpu\n${DISK}` })).status).toBe(200)
  })
})

describe.skipIf(!HAS_HELM)('Preview of a group with name:', () => {
  it('Helm renders the name, and the summary finds the group by it', async () => {
    expect((await save({ 'mariadb_cpu.yaml': CPU('name: MariaDB CPU {{ x }}\n'), 'disk.yaml': `name: "yes"\n${DISK}` })).status).toBe(200)
    expect((await api('POST', '/api/v2/folders/init', { folder: DIRECT, chart: 'demo' })).status).toBe(200)
    const values = { mariadb_cpu: [{ db: 'a' }, { db: 'b' }], disk: [{ db: 'a' }] }
    expect((await api('POST', `/api/v2/deployments/demo/db?folder=${encodeURIComponent(DIRECT)}`, { values })).status).toBe(200)
    const { data } = await api('POST', `/api/v2/render/demo/db?folder=${encodeURIComponent(DIRECT)}`)
    expect(data.ok).toBe(true)
    const groupNames = yaml.loadAll(data.output).filter(d => d?.kind === 'PrometheusRule').map(d => d.spec.groups[0].name).sort()
    expect(groupNames).toEqual(['MariaDB CPU {{ x }}', 'yes'])
    const byKey = Object.fromEntries(data.summary.groups.map(g => [g.valuesKey, g]))
    expect(byKey.mariadb_cpu).toMatchObject({ name: 'MariaDB CPU {{ x }}', state: 'ok', missing: [] })
    expect(byKey.mariadb_cpu.alerts.reduce((n, a) => n + a.count, 0)).toBe(2)
    expect(byKey.disk).toMatchObject({ name: 'yes', state: 'ok' })
    expect(data.summary.unmatchedGroups).toEqual([])
  })
})

describe.skipIf(!HAS_HELM)('Preview with a hand-written template rendering the same group name', () => {
  it('counts the generated group from its own template, and shows the other apart', async () => {
    expect((await save({ 'disk.yaml': `name: Infra\n${DISK}` })).status).toBe(200)
    // Hand-written, as an x-custom-template group's file is: only Helm knows what it renders.
    await fs.writeFile(path.join(tmpDir, 'charts/demo/templates/by-hand.yaml'), 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: {{ .Release.Name }}-by-hand\nspec:\n  groups:\n    - name: Infra\n      rules:\n        - alert: ByHand\n          expr: up == 0\n')
    expect((await api('POST', '/api/v2/folders/init', { folder: DIRECT, chart: 'demo' })).status).toBe(200)
    expect((await api('POST', `/api/v2/deployments/demo/db?folder=${encodeURIComponent(DIRECT)}`, { values: { disk: [{ db: 'a' }] } })).status).toBe(200)
    const { data } = await api('POST', `/api/v2/render/demo/db?folder=${encodeURIComponent(DIRECT)}`)
    expect(data.output).toContain('ByHand')
    const disk = data.summary.groups.find(g => g.valuesKey === 'disk')
    expect(disk.alerts.map(a => [a.alert, a.count])).toEqual([['DiskFull', 1]])
    expect(data.summary.unmatchedGroups).toEqual([expect.objectContaining({ name: 'Infra', alerts: [expect.objectContaining({ alert: 'ByHand', count: 1 })] })])
  })
})

describe('gen-rules and gen-chart --check', () => {
  const run = (script, args) => {
    try { return { status: 0, stdout: execFileSync('node', [script, ...args], { encoding: 'utf-8' }) } } catch (e) { return { status: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}` } }
  }
  const chart = async files => {
    const dir = path.join(tmpDir, 'cli')
    await fs.mkdir(path.join(dir, 'rules'), { recursive: true })
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, 'rules', name), text)
    return dir
  }

  it('generate a name, and pass --check', async () => {
    const dir = await chart({ 'mariadb_cpu.yaml': CPU('name: MariaDB CPU\n') })
    expect(run(GEN_RULES, [dir]).status).toBe(0)
    expect(await fs.readFile(path.join(dir, 'templates/mariadb-cpu.yaml'), 'utf-8')).toContain('    - name: MariaDB CPU\n')
    expect(run(GEN_RULES, [dir, '--check']).status).toBe(0)
    expect(run(GEN_CHART, [dir, '--check']).status).toBe(0)
  })

  it.each([['gen-rules', GEN_RULES, []], ['gen-rules --check', GEN_RULES, ['--check']], ['gen-chart --check', GEN_CHART, ['--check']]])('%s refuses one the save refuses', async (_, script, extra) => {
    const dir = await chart({ 'mariadb_cpu.yaml': CPU(''), 'disk.yaml': DISK })
    expect(run(GEN_RULES, [dir]).status).toBe(0)
    await fs.writeFile(path.join(dir, 'rules/disk.yaml'), `name: mariadb-cpu\n${DISK}`)
    const r = run(script, [dir, ...extra])
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/disk\.yaml: name "mariadb-cpu" is already the rule-group name of mariadb_cpu\.yaml \(its default, from the file name\)/)
  })
})
