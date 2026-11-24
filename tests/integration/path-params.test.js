// Every request value that becomes part of a file path — a chart, a template
// file, a folder, a deployment, a sync path, a git file or ref — is checked:
// a name like a chart's, or a path inside the repo with no `..`, no folder
// starting with a dot, no backslash, no NUL, nothing absolute. Refused with
// 400, and nothing outside the repo (or in its .git) is read, written or
// removed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'

let server, baseURL, root, repo

const SENTINEL = 'sentinel: outside\n'
const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: A\n    expr: cpu{ns="${namespace}"} > 1\n'

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'path-params-'))
  repo = path.join(root, 'repo')
  await fs.mkdir(path.join(repo, 'charts', 'demo'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  const names = { templates: 'templates', deployments: 'deployments', folders: 'folders', render: 'render', sync: 'sync', git: 'git', charts: 'charts' }
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = repo; next() })
  for (const [at, file] of Object.entries(names)) app.use(`/api/v2/${at}`, (await import(`../../server/routes/${file}.js`)).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
})

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  if (root) await fs.rm(root, { recursive: true, force: true })
})

async function api(method, url, body) {
  const res = await fetch(`${baseURL}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, text: await res.text() }
}

// What there is outside the repo and in its .git, with each file's text.
async function outside() {
  const out = {}
  const walk = async (dir, skipRepo) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (skipRepo && p === repo) continue
      if (e.isDirectory()) await walk(p, false)
      else out[path.relative(root, p)] = await fs.readFile(p, 'utf-8').catch(err => err.code)
    }
  }
  await walk(root, true)
  await walk(path.join(repo, '.git'), false)
  return out
}

// Spellings of a path that leaves where it should stay, as a URL segment and
// as a value (a query or a body field).
const SEGMENTS = ['..%2F..%2F..%2F..%2Foutside', '..%5C..%5C..%5C..%5Coutside', '%2Ftmp%2Foutside', 'a%00b', '.hidden', '..']
const VALUES = ['../outside', '../../outside', 'deployments/../../outside', '/tmp/outside', 'deployments\\..\\..\\outside', 'deployments/a\0b', '.git/hooks', 'deployments/.hidden/a', '..']
const q = v => encodeURIComponent(v)

const ROUTES = [
  ...['GET', 'POST', 'DELETE'].map(m => [`${m} a template file`, 'template', SEGMENTS.map(s => [m, `/api/v2/templates/demo/${s}`, m === 'POST' ? { content: SENTINEL } : undefined])]),
  ['rename a template file', 'template', SEGMENTS.map(s => ['POST', `/api/v2/templates/demo/${s}/rename`, { newName: 'moved' }])],
  ['a chart', 'chart', SEGMENTS.map(s => ['GET', `/api/v2/templates/${s}`])],
  ['read a deployment', 'folder', VALUES.map(v => ['GET', `/api/v2/deployments/demo/a?folder=${q(v)}`])],
  ['save a deployment', 'folder', VALUES.map(v => ['POST', `/api/v2/deployments/demo/a?folder=${q(v)}`, { values: { cpu: [{ namespace: 'p' }] } }])],
  ['save a deployment', 'deployment', SEGMENTS.map(s => ['POST', `/api/v2/deployments/demo/${s}?folder=${q('deployments/team/a')}`, { values: { cpu: [{ namespace: 'p' }] } }])],
  ['delete a deployment', 'folder', VALUES.map(v => ['DELETE', `/api/v2/deployments/demo/a?folder=${q(v)}`])],
  ['save routing', 'folder', VALUES.map(v => ['PUT', `/api/v2/deployments/demo/a/routing?folder=${q(v)}`, { routing: 'labels: {}\nconfigs: {}\ncells: []\n' }])],
  ['preview', 'folder', VALUES.map(v => ['POST', `/api/v2/render/demo/a?folder=${q(v)}`])],
  ['make a folder', 'path', VALUES.map(v => ['POST', '/api/v2/folders', { path: v }])],
  ['make a deployment', 'folder', VALUES.map(v => ['POST', '/api/v2/folders/init', { folder: v, chart: 'demo' }])],
  ['list a folder', 'path', VALUES.map(v => ['GET', `/api/v2/folders/tree?path=${q(v)}`])],
  ['list a folder (old route)', 'path', VALUES.map(v => ['GET', `/api/v2/folders?path=${q(v)}`])],
  ['who uses a _common', 'path', VALUES.map(v => ['GET', `/api/v2/folders/common/users?path=${q(v)}`])],
  ['plan a _common', 'folder', VALUES.map(v => ['GET', `/api/v2/folders/common/plan?action=create&chart=demo&folder=${q(v)}`])],
  ['make a _common', 'folder', VALUES.map(v => ['POST', '/api/v2/folders/common', { action: 'create', folder: v, chart: 'demo', expected: {} }])],
  ['remove a _common', 'path', VALUES.map(v => ['POST', '/api/v2/folders/common', { action: 'delete', path: v, expected: {} }])],
  ['link a sync target', 'target', VALUES.map(v => ['POST', '/api/v2/sync', { source: 'deployments/team/a', target: v }])],
  ['link a sync source', 'source', VALUES.map(v => ['POST', '/api/v2/sync', { source: v, target: 'deployments/team/b' }])],
  ['unlink a sync target', 'target', VALUES.map(v => ['DELETE', '/api/v2/sync', { target: v }])],
  ['a file\'s diff', 'file', VALUES.map(v => ['GET', `/api/v2/git/diff?file=${q(v)}`])],
  ['a file\'s diff at a commit', 'ref', ['--output=../outside', '--output=outside.patch', '--upload-pack=touch x', '-p', '--', 'HEAD;x', '../x', 'main..HEAD'].map(v => ['GET', `/api/v2/git/diff?file=a.yaml&ref=${q(v)}`])],
  ['a file\'s diff', 'file starting with -', ['--output=../outside', '-p'].map(v => ['GET', `/api/v2/git/diff?file=${q(v)}&ref=${q('--output=../x')}`])],
  ['clone a chart', 'name', SEGMENTS.map(s => ['POST', `/api/v2/charts/${s}/clone`, { newName: 'copy' }])],
  ['delete a chart', 'name', SEGMENTS.map(s => ['DELETE', `/api/v2/charts/${s}`])],
]

describe.each(ROUTES)('%s: %s', (_, __, calls) => {
  it.each(calls.map(c => [decodeURIComponent(c[1].replace(/%00/g, '%5C0')), ...c]))('%s → refused, nothing outside touched', async (___, method, url, body) => {
    await fs.writeFile(path.join(root, 'outside.yaml'), SENTINEL)
    await fs.writeFile(path.join(repo, '.git', 'sentinel.yaml'), SENTINEL)
    const before = await outside()
    const { status, text } = await api(method, url, body)
    expect(status, text).toBeGreaterThanOrEqual(400)
    expect(status, text).toBeLessThan(500)
    expect(text).not.toContain('sentinel: outside')
    expect(await outside()).toEqual(before)
  })
})
