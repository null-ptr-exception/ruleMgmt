// Values not under the chart's name (#203): Helm passes none of them to the
// Template and renders only the Template's own, so the rows written there
// deploy nothing. A save of such text is refused with one sentence, which
// names the file and says where the values belong. A Template's breaking
// change that meets such a file says the same sentence and writes nothing
// until the file is fixed: wrapping it would start deploying its rows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'

let server, baseURL, tmpDir

const RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
  app: {type: string}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > \${warn}
`

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'values-not-under-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': RULES } })).status).toBe(200)

  // deployments/t/a and deployments/t/b on the Template; deployments/s/x on
  // the _common of deployments/s.
  await deployment(A, 'demo', 'charts/demo', { demo: { cpu: [{ namespace: 'a', warn: 1 }] } })
  await deployment(B, 'demo', 'charts/demo', { demo: { cpu: [{ namespace: 'b', warn: 2 }] } })
  await write(`${LAYER}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: 'demo', version: '>=0.0.0-0' }] })
  await fs.mkdir(abs(`${LAYER}/charts`), { recursive: true })
  await fs.symlink(path.relative(abs(`${LAYER}/charts`), abs('charts/demo')), abs(`${LAYER}/charts/demo`))
  await write(`${LAYER}/values.yaml`, { demo: { cpu: [{ namespace: 'top', warn: 3 }] } })
  await deployment(X, 'common', LAYER, { common: { demo: { cpu: [{ namespace: 'x', warn: 4 }] } } })
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
const abs = rel => path.join(tmpDir, rel)
const write = async (rel, doc) => {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true })
  await fs.writeFile(abs(rel), typeof doc === 'string' ? doc : yaml.dump(doc))
}
const read = rel => fs.readFile(abs(rel), 'utf-8')
async function deployment(rel, dependsOn, on, values) {
  await write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name: path.basename(rel), version: '0.1.0', dependencies: [{ name: dependsOn, version: '>=0.0.0-0', repository: `file://${path.relative(abs(rel), abs(on))}` }] })
  await write(`${rel}/values.yaml`, values)
}

const A = 'deployments/t/a'
const B = 'deployments/t/b'
const X = 'deployments/s/x'
const LAYER = 'deployments/s/_common/demo'

const sentence = (file, under, where) => `${file}: the values are not under ${under}: Helm passes none of them to the Template demo, and renders only its own. Write them under ${where}`

// [what, the deployment or _common, its name in the route, the text, the sentence]
const CASES = [
  ['a deployment\'s values under no name', A, 'a', 'cpu:\n  - namespace: a\n    warn: 9\n', sentence(`${A}/values.yaml`, 'demo', 'demo:')],
  ['a deployment\'s values under another name', A, 'a', 'demox:\n  cpu:\n    - namespace: a\n      warn: 9\n', sentence(`${A}/values.yaml`, 'demo', 'demo:')],
  ['a deployment\'s values on a _common, under the Template\'s name only', X, 'x', 'demo:\n  cpu:\n    - namespace: x\n      warn: 9\n', sentence(`${X}/values.yaml`, 'common', 'common:   demo:')],
  ['a _common\'s own values under no name', LAYER, 'demo', 'cpu:\n  - namespace: top\n    warn: 9\n', sentence(`${LAYER}/values.yaml`, 'demo', 'demo:')],
]

describe('a save of values not under the chart\'s name', () => {
  it.each(CASES)('%s is refused (400) with the sentence, and nothing is written', async (_, rel, name, text, said) => {
    const before = await read(`${rel}/values.yaml`)
    const res = await api('POST', `/api/v2/deployments/demo/${name}?folder=${encodeURIComponent(rel)}`, { values: text })
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('Some values are not what Helm reads')
    expect(res.data.problems).toEqual([{ message: said, code: 'values.not-under-chart-key' }])
    expect(await read(`${rel}/values.yaml`)).toBe(before)
  })
})

const RENAMED = RULES.replace('warn: {type: number}', 'threshold: {type: number}').replace('${warn}', '${threshold}')
const RENAME = { columns: { cpu: { warn: 'threshold' } } }
const preview = () => api('POST', '/api/v2/templates/demo/migration-preview', { files: { 'cpu.yaml': RENAMED }, migration: RENAME })
const migrate = () => api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': RENAMED }, confirmBreaking: true, migration: RENAME })
const FILES = [`${A}/values.yaml`, `${B}/values.yaml`, `${X}/values.yaml`, `${LAYER}/values.yaml`, 'charts/demo/rules/cpu.yaml', 'charts/demo/templates/cpu.yaml', 'charts/demo/values.schema.json']
const everyFile = async () => Object.fromEntries(await Promise.all(FILES.map(async f => [f, await read(f)])))

describe('a breaking change that meets values not under the chart\'s name', () => {
  it.each(CASES)('%s: the preview says the save\'s sentence, and the change is refused with no file written', async (_, rel, name, text, said) => {
    await write(`${rel}/values.yaml`, text)
    const before = await everyFile()

    const p = await preview()
    expect(p.status).toBe(200)
    const mine = p.data.deployments.find(d => d.path === rel)
    expect(mine.problems).toEqual([{ message: said, before: false }])
    expect(mine.rowsChanged).toBe(0)
    // The others are listed as they would be migrated.
    for (const other of [A, B, X, LAYER].filter(o => o !== rel)) {
      expect(p.data.deployments.find(d => d.path === other)).toMatchObject({ problems: [], rowsChanged: 1 })
    }

    const m = await migrate()
    expect(m.status).toBe(409)
    expect(m.data.migrationProblems).toEqual([{ path: rel, readonly: false, problems: [{ message: said, before: false }] }])
    // All or none: not this file, not the other deployments', not the Template's.
    expect(await everyFile()).toEqual(before)
  })

  it('goes through once the file is fixed', async () => {
    await write(`${A}/values.yaml`, 'cpu:\n  - namespace: a\n    warn: 9\n')
    expect((await migrate()).status).toBe(409)
    await write(`${A}/values.yaml`, 'demo:\n  cpu:\n    - namespace: a\n      warn: 9\n')
    expect((await migrate()).status).toBe(200)
    expect(yaml.load(await read(`${A}/values.yaml`))).toEqual({ demo: { cpu: [{ namespace: 'a', threshold: 9 }] } })
    expect(yaml.load(await read(`${B}/values.yaml`))).toEqual({ demo: { cpu: [{ namespace: 'b', threshold: 2 }] } })
  })

  // A value written by hand that Helm reads otherwise (010 is 8) is listed
  // as there before, and is no reason to refuse; the two are told apart.
  it('is refused for that file only, beside a deployment whose 010 is listed as there before', async () => {
    await write(`${A}/values.yaml`, 'cpu:\n  - namespace: a\n    warn: 9\n')
    await write(`${B}/values.yaml`, 'demo:\n  cpu:\n    - namespace: b\n      warn: 010\n')
    const before = await everyFile()

    const p = await preview()
    const b = p.data.deployments.find(d => d.path === B)
    expect(b.problems.length).toBeGreaterThan(0)
    expect(b.problems.every(x => x.before)).toBe(true)
    expect(p.data.deployments.find(d => d.path === A).problems).toEqual([{ message: sentence(`${A}/values.yaml`, 'demo', 'demo:'), before: false }])

    const m = await migrate()
    expect(m.status).toBe(409)
    expect(m.data.migrationProblems.map(d => d.path)).toEqual([A])
    expect(await everyFile()).toEqual(before)

    // With the first file fixed, the 010 does not hold the change up.
    await write(`${A}/values.yaml`, 'demo:\n  cpu:\n    - namespace: a\n      warn: 9\n')
    expect((await migrate()).status).toBe(200)
    expect(yaml.load(await read(`${B}/values.yaml`))).toEqual({ demo: { cpu: [{ namespace: 'b', threshold: 8 }] } })
  })
})

// A change that is not breaking writes no deployment. Rows Helm passes to
// no Template cannot get a new problem from it, so they do not stop it.
describe('a Template change that is not breaking', () => {
  const SELECTED = RULES.replace('group: cpu\n', 'group: cpu\nselectors: [namespace, app]\n')
    .replace('app: {type: string}', 'app: {type: string, default: ".*"}')
    .replace('warn: {type: number}', 'warn: {type: number, default: 80}')
    .replace('expr: cpu{ns="${namespace}"} > ${warn}', 'expr: cpu{${selector}} > ${warn}')

  it('is not stopped by rows not under the chart\'s name that would overlap if they were', async () => {
    const text = 'cpu:\n  - {namespace: a, app: api, warn: 1}\n  - {namespace: a, app: api, warn: 2}\n'
    await write(`${A}/values.yaml`, text)
    const res = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': SELECTED } })
    expect(res.status).toBe(200)
    expect(await read(`${A}/values.yaml`)).toBe(text)
  })
})
