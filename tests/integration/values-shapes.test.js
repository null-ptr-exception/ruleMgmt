// A deployment's values in a shape the Template's schema can never take —
// the values, Common Values or a row not a map, a group not a list, a cell
// that is a list or a map — is refused at save, JSON or text, naming the
// group and the row; the file stays as it was. Helm (3.15.4, 3.19.0) refuses
// each of these on render: "got null, want object", "got array, want
// object", "got string, want array" and so on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'

let server, baseURL, tmpDir
const DEP = 'deployments/t/a'
const URL_ = `/api/v2/deployments/demo/a?folder=${encodeURIComponent(DEP)}`

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'values-shapes-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const routes = await Promise.all(['templates', 'deployments', 'folders'].map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  ;['templates', 'deployments', 'folders'].forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  const files = { '_common.yaml': 'columns:\n  owner: {type: string, required: true}\n', 'cpu.yaml': 'group: cpu\ncolumns:\n  pct: {type: number, default: 80}\nrules:\n  - alert: CpuHigh\n    expr: cpu{owner="${owner}"} > ${pct}\n', 'up.yaml': 'group: up\nonce: true\nrules:\n  - alert: Down\n    expr: up{owner="${owner}"} == 0\n' }
  expect((await api('POST', '/api/v2/templates/demo/rules', { files })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
})
afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})
async function api(method, url, body) {
  const res = await fetch(`${baseURL}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}

const O = { owner: 'o' }
const REFUSED = [
  [{ _common: null, cpu: [] }, 'Common Values must be a map of name to value, not null'],
  [{ _common: [], cpu: [] }, 'Common Values must be a map of name to value, not a list'],
  [{ _common: 'x', cpu: [] }, 'Common Values must be a map of name to value, not "x"'],
  [{ _common: 5, cpu: [] }, 'Common Values must be a map of name to value, not 5'],
  [{ _common: O, cpu: [null] }, 'cpu row 1: must be a map of column to value, not null'],
  [{ _common: O, cpu: [5] }, 'cpu row 1: must be a map of column to value, not 5'],
  [{ _common: O, cpu: [[]] }, 'cpu row 1: must be a map of column to value, not a list'],
  [{ _common: O, cpu: {} }, 'cpu: must be a list of rows, not a map'],
  [{ _common: O, cpu: 'x' }, 'cpu: must be a list of rows, not "x"'],
  [{ _common: O, cpu: null }, 'cpu: must be a list of rows, not null'],
  [{ _common: O, cpu: [{ pct: [] }] }, 'cpu row 1, "pct": a list — a value is text, a number or true/false'],
  [{ _common: O, cpu: [{ pct: {} }] }, 'cpu row 1, "pct": a map — a value is text, a number or true/false'],
  [{ _common: { owner: { a: 1 } }, cpu: [{}] }, 'Common Values, "owner": a map — a value is text, a number or true/false'],
]
const TEXT_REFUSED = [
  ['5\n', 'deployments/t/a/values.yaml: the file must be a map of keys, not a number'],
  ['- a\n', 'deployments/t/a/values.yaml: the file must be a map of keys, not a list'],
  ['demo:\n  _common: x\n  cpu: []\n', 'Common Values must be a map of name to value, not "x"'],
  ['demo:\n  _common: {owner: o}\n  cpu:\n    - "s"\n', 'cpu row 1: must be a map of column to value, not "s"'],
]

describe('a deployment save', () => {
  it.each(REFUSED.map(([v, m]) => [JSON.stringify(v), v, m]))('refuses %s', async (_, values, message) => {
    const before = await fs.readFile(path.join(tmpDir, DEP, 'values.yaml'), 'utf-8')
    const { status, data } = await api('POST', URL_, { values })
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toContain(message)
    expect(await fs.readFile(path.join(tmpDir, DEP, 'values.yaml'), 'utf-8')).toBe(before)
  })

  it.each(TEXT_REFUSED.map(([t, m]) => [JSON.stringify(t), t, m]))('refuses the text %s', async (_, text, message) => {
    const before = await fs.readFile(path.join(tmpDir, DEP, 'values.yaml'), 'utf-8')
    const { status, data } = await api('POST', URL_, { values: text })
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toContain(message)
    expect(await fs.readFile(path.join(tmpDir, DEP, 'values.yaml'), 'utf-8')).toBe(before)
  })

  // What Helm (3.15.4, 3.19.0) renders, each of these is saved.
  it.each([
    ['a once group written as nothing', { _common: O, cpu: [], up: null }],
    ['a once group written as a map', { _common: O, cpu: [], up: {} }],
    ['a once group with a row', { _common: O, cpu: [], up: [{}] }],
    ['a row group that is empty', { _common: O, cpu: [] }],
    // Keys the schema does not declare are Helm's to leave alone.
    ['a list in a row key no column declares', { _common: O, cpu: [{ extra: [1] }] }],
    ['a list in a Common Values key no column declares', { _common: { owner: 'o', tags: ['a'] }, cpu: [] }],
  ])('takes %s', async (_, values) => {
    const { status, data } = await api('POST', URL_, { values })
    expect(status, JSON.stringify(data)).toBe(200)
  })

  it('takes a null group where the Template gives one (Helm renders the Template\'s)', async () => {
    await fs.writeFile(path.join(tmpDir, 'charts/demo/values.yaml'), yaml.dump({ cpu: [], up: [], _common: { owner: 't' } }))
    try {
      // (`_common: null` alone is refused here for another reason: the
      // save check does not read the Template's own Common Values yet.)
      for (const text of ['demo:\n  cpu:\n  _common: {owner: o}\n', 'demo:\n  cpu: null\n  _common: {owner: o}\n']) {
        const { status, data } = await api('POST', URL_, { values: text })
        expect(status, `${text} ${JSON.stringify(data)}`).toBe(200)
      }
    } finally {
      await fs.writeFile(path.join(tmpDir, 'charts/demo/values.yaml'), '{}\n')
    }
  })

  it('takes a row with no cells and Common Values that are a map', async () => {
    expect((await api('POST', URL_, { values: { _common: O, cpu: [{}] } })).status).toBe(200)
    expect(yaml.load(await fs.readFile(path.join(tmpDir, DEP, 'values.yaml'), 'utf-8')).demo.cpu).toEqual([{}])
  })
})
