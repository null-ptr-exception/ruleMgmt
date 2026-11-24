// Values written by hand in a form Helm (YAML 1.1) reads otherwise than a
// YAML 1.2 reader: `010` is 8, `1_000` is 1000, `yes` is true, a key `y` is
// "true" (#202). Each form, next to what real Helm deploys from the same
// file: a save as text refuses it naming the line, Commit lists it under its
// deployment, and a Template change that migrates the file lists it too —
// the migration writes the value as Helm reads it, so what deploys stays the
// same and the file says it. Run with HELM_BIN set to each Helm version.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import git from '../../server/lib/git.js'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HELM = process.env.HELM_BIN || 'helm'
const HAS_HELM = (() => { try { execFileSync(HELM, ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

const RULES = column => `group: cpu
columns:
  namespace: {type: string, required: true}
  ${column}: {type: number, default: 80}
  page: {type: boolean, default: false}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${${column}}
    labels: {page: "\${page}"}
`
const BEFORE = RULES('warn')
// A breaking change with its mapping: `warn` renamed to `threshold`.
const AFTER = RULES('threshold')
const RENAME = { columns: { cpu: { warn: 'threshold' } } }
const DEP = 'deployments/shop/prod'
const FILE = `${DEP}/values.yaml`

let server, baseURL, tmpDir

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const q = f => `?folder=${encodeURIComponent(f)}`
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const write = (rel, text) => fs.writeFile(path.join(tmpDir, rel), text)
const saveText = async text => {
  const opened = await api('GET', `/api/v2/deployments/demo/prod${q(DEP)}`)
  return api('POST', `/api/v2/deployments/demo/prod${q(DEP)}`, { values: text, ...(opened.data.version ? { version: opened.data.version } : {}) })
}
const commit = async () => {
  await write('notes.txt', `${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message: 'test' })
}
const preview = () => api('POST', '/api/v2/templates/demo/migration-preview', { files: { 'cpu.yaml': AFTER }, migration: RENAME })
const migrate = () => api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': AFTER }, confirmBreaking: true, migration: RENAME })
const problemsOf = async () => (await preview()).data.deployments.find(d => d.path === DEP).problems
// What Helm deploys from the deployment: its one rule's expr and page label,
// or Helm's refusal.
async function deployed() {
  let out
  try { out = await renderChart(path.join(tmpDir, DEP), ['template', 'x', path.join(tmpDir, DEP)]) } catch (err) { return { fails: /values don't meet the specifications of the schema/.test(`${err.stderr}${err.message}`) ? 'schema' : String(err.message) } }
  const rules = yaml.loadAll(out).filter(Boolean).flatMap(d => d.spec?.groups ?? []).flatMap(g => g.rules ?? [])
  return rules.map(r => `${r.expr} page=${r.labels.page}`)
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'values-yaml11-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const names = ['templates', 'deployments', 'folders', 'git']
  const routers = await Promise.all(names.map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  names.forEach((n, i) => app.use(`/api/v2/${n}`, routers[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': BEFORE } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

const row = cells => `demo:\n  cpu:\n    - namespace: p\n      ${cells}\n`
const value = (text, helm) => `${FILE} line 4: Helm reads ${text} as ${helm} (YAML 1.1); the editor would write ${helm}. Write ${helm}, or '${text}' in quotes for the text`
const key = (text, helm) => `${FILE} line 4: Helm reads the key ${text} as "${helm}" (YAML 1.1). Write '${text}' in quotes for the key ${text}`

// [the hand-written cells, what is said, what Helm deploys from them, the cells a migration writes]
const FORMS = [
  ['warn: 010', value('010', 8), ['cpu{ns="p"} > 8 page=false'], 'threshold: 8'],
  ['warn: -010', value('-010', -8), ['cpu{ns="p"} > -8 page=false'], 'threshold: -8'],
  ['warn: 0777', value('0777', 511), ['cpu{ns="p"} > 511 page=false'], 'threshold: 511'],
  ['warn: 0_7', value('0_7', 7), ['cpu{ns="p"} > 7 page=false'], 'threshold: 7'],
  ['warn: 1_000', value('1_000', 1000), ['cpu{ns="p"} > 1000 page=false'], 'threshold: 1000'],
  ['page: yes', value('yes', true), ['cpu{ns="p"} > 80 page=true'], 'page: true'],
  ['page: no', value('no', false), ['cpu{ns="p"} > 80 page=false'], 'page: false'],
  ['page: on', value('on', true), ['cpu{ns="p"} > 80 page=true'], 'page: true'],
  ['page: off', value('off', false), ['cpu{ns="p"} > 80 page=false'], 'page: false'],
  ['page: y', value('y', true), ['cpu{ns="p"} > 80 page=true'], 'page: true'],
  ['page: n', value('n', false), ['cpu{ns="p"} > 80 page=false'], 'page: false'],
  ['n: 1', key('n', 'false'), ['cpu{ns="p"} > 80 page=false'], "'false': 1"],
  ['y: 1', key('y', 'true'), ['cpu{ns="p"} > 80 page=false'], "'true': 1"],
  ['on: 1', key('on', 'true'), ['cpu{ns="p"} > 80 page=false'], "'true': 1"],
]

describe.skipIf(!HAS_HELM)('a value or key written by hand that Helm reads otherwise', { timeout: 120000 }, () => {
  it.each(FORMS)('%s: a save as text refuses it and Commit lists it, naming the line', async (cells, said, helm) => {
    const base = await read(FILE)
    const saved = await saveText(row(cells))
    expect(saved.status).toBe(400)
    expect(saved.data.error).toBe('Some values are not what Helm reads')
    expect(saved.data.problems.map(p => p.message)).toEqual([said])
    expect(await read(FILE)).toBe(base)

    await write(FILE, row(cells))
    expect(await deployed()).toEqual(helm)
    const committed = await commit()
    expect(committed.status).toBe(200)
    expect(committed.data.valueWarnings).toEqual([{ deployment: DEP, warnings: [said] }])
  })

  it.each(FORMS)('%s: a Template change that migrates the file lists it as there before, and writes what Helm read', async (cells, said, helm, written) => {
    await write(FILE, row(cells))
    expect(await problemsOf()).toEqual([{ message: said, before: true }])

    const migrated = await migrate()
    expect(migrated.status).toBe(200)
    expect(await read(FILE)).toBe(row(written))
    // What deploys is what deployed before, and the file now says it.
    expect(await deployed()).toEqual(helm)
    expect((await commit()).data.valueWarnings).toBeUndefined()
  })

  it('text where the column wants it, written yes: Helm stops on its schema; listed with the cell, both as there before, and migrated as it is', async () => {
    await write(FILE, 'demo:\n  cpu:\n    - namespace: yes\n      warn: 90\n')
    expect(await deployed()).toEqual({ fails: 'schema' })
    const said = [`${FILE} line 3: Helm reads yes as true (YAML 1.1); the editor would write true. Write true, or 'yes' in quotes for the text`, 'cpu row 1, "namespace": true is not text']
    expect((await saveText(await read(FILE))).data.problems.map(p => p.message)).toEqual(said)
    expect((await problemsOf()).map(p => [p.message, p.before])).toEqual(said.map(m => [m, true]))

    expect((await migrate()).status).toBe(200)
    expect(await read(FILE)).toBe('demo:\n  cpu:\n    - namespace: true\n      threshold: 90\n')
    expect(await deployed()).toEqual({ fails: 'schema' })
  })
})

describe('values Helm reads as they are written', () => {
  it.each([
    ['in quotes', "namespace: '010'\n      warn: 8", "namespace: '010'\n      threshold: 8"],
    ['the number as it is meant', 'warn: 10', 'threshold: 10'],
    ['the booleans', 'page: true', 'page: true'],
    ['a key in quotes', "'y': 1", "'y': 1"],
  ])('%s: saved, committed and migrated with nothing said', async (_, cells, written) => {
    const text = cells.startsWith('namespace') ? `demo:\n  cpu:\n    - ${cells}\n` : row(cells)
    const saved = await saveText(text)
    expect(saved.status).toBe(200)
    expect((await commit()).data.valueWarnings).toBeUndefined()
    expect(await problemsOf()).toEqual([])
    expect((await migrate()).status).toBe(200)
    expect(await read(FILE)).toBe(cells.startsWith('namespace') ? `demo:\n  cpu:\n    - ${written}\n` : row(written))
  })

  it('a file the editor wrote: text Helm would read otherwise is in quotes, and nothing is said of it', async () => {
    expect((await api('POST', `/api/v2/deployments/demo/prod${q(DEP)}`, { values: { cpu: [{ namespace: '010', warn: 8 }, { namespace: 'yes' }, { namespace: '1_000' }] } })).status).toBe(200)
    expect(await read(FILE)).toBe("demo:\n  cpu:\n    - namespace: '010'\n      warn: 8\n    - namespace: 'yes'\n    - namespace: '1_000'\n")
    expect((await commit()).data.valueWarnings).toBeUndefined()
    expect(await problemsOf()).toEqual([])
  })
})

describe('a Template change that writes no deployment', () => {
  it('is not held up by, and does not rewrite, a value Helm reads otherwise', async () => {
    await write(FILE, row('warn: 010'))
    const added = BEFORE.replace('rules:', '  note: {type: string}\nrules:')
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': added } })).status).toBe(200)
    expect(await read(FILE)).toBe(row('warn: 010'))
  })
})
