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
// Where a file is read or a folder listed, a dot-folder is fine (.github);
// .git never is.
const READ_VALUES = VALUES.filter(v => v !== 'deployments/.hidden/a')
// A template file is named as the listing gives it: `.hidden` is a name.
const FILE_SEGMENTS = SEGMENTS.filter(s => s !== '.hidden')
const q = v => encodeURIComponent(v)

const ROUTES = [
  ...['GET', 'POST', 'DELETE'].map(m => [`${m} a template file`, 'template', FILE_SEGMENTS.map(s => [m, `/api/v2/templates/demo/${s}`, m === 'POST' ? { content: SENTINEL } : undefined])]),
  ['rename a template file', 'template', FILE_SEGMENTS.map(s => ['POST', `/api/v2/templates/demo/${s}/rename`, { newName: 'moved' }])],
  ['a chart', 'chart', SEGMENTS.map(s => ['GET', `/api/v2/templates/${s}`])],
  ['read a deployment', 'folder', VALUES.map(v => ['GET', `/api/v2/deployments/demo/a?folder=${q(v)}`])],
  ['save a deployment', 'folder', VALUES.map(v => ['POST', `/api/v2/deployments/demo/a?folder=${q(v)}`, { values: { cpu: [{ namespace: 'p' }] } }])],
  ['save a deployment', 'deployment', SEGMENTS.map(s => ['POST', `/api/v2/deployments/demo/${s}?folder=${q('deployments/team/a')}`, { values: { cpu: [{ namespace: 'p' }] } }])],
  ['delete a deployment', 'folder', VALUES.map(v => ['DELETE', `/api/v2/deployments/demo/a?folder=${q(v)}`])],
  ['save routing', 'folder', VALUES.map(v => ['PUT', `/api/v2/deployments/demo/a/routing?folder=${q(v)}`, { routing: 'labels: {}\nconfigs: {}\ncells: []\n' }])],
  ['preview', 'folder', VALUES.map(v => ['POST', `/api/v2/render/demo/a?folder=${q(v)}`])],
  ['make a folder', 'path', VALUES.map(v => ['POST', '/api/v2/folders', { path: v }])],
  ['make a deployment', 'folder', VALUES.map(v => ['POST', '/api/v2/folders/init', { folder: v, chart: 'demo' }])],
  ['list a folder', 'path', READ_VALUES.map(v => ['GET', `/api/v2/folders/tree?path=${q(v)}`])],
  ['list a folder (old route)', 'path', READ_VALUES.map(v => ['GET', `/api/v2/folders?path=${q(v)}`])],
  ['who uses a _common', 'path', READ_VALUES.map(v => ['GET', `/api/v2/folders/common/users?path=${q(v)}`])],
  ['plan a _common', 'folder', VALUES.map(v => ['GET', `/api/v2/folders/common/plan?action=create&chart=demo&folder=${q(v)}`])],
  ['make a _common', 'folder', VALUES.map(v => ['POST', '/api/v2/folders/common', { action: 'create', folder: v, chart: 'demo', expected: {} }])],
  ['remove a _common', 'path', VALUES.map(v => ['POST', '/api/v2/folders/common', { action: 'delete', path: v, expected: {} }])],
  ['link a sync target', 'target', VALUES.map(v => ['POST', '/api/v2/sync', { source: 'deployments/team/a', target: v }])],
  ['link a sync source', 'source', VALUES.map(v => ['POST', '/api/v2/sync', { source: v, target: 'deployments/team/b' }])],
  ['unlink a sync target', 'target', VALUES.map(v => ['DELETE', '/api/v2/sync', { target: v }])],
  ['a file\'s diff', 'file', READ_VALUES.map(v => ['GET', `/api/v2/git/diff?file=${q(v)}`])],
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

// The same checks let through what a real repo holds: dot-files and
// dot-folders where a file is read or a folder listed, underscores, dashes
// and dots in names, nested folders, a legacy flat deployment, a sync path
// written with backslashes, the commit ids the Git panel sends.
describe('what the checks still take', () => {
  let sha
  beforeAll(async () => {
    await fs.mkdir(path.join(repo, '.github', 'workflows'), { recursive: true })
    await fs.writeFile(path.join(repo, '.github', 'workflows', 'ci.yaml'), 'on: push\n')
    await fs.writeFile(path.join(repo, '.gitignore'), 'Chart.lock\n')
    await fs.writeFile(path.join(repo, '.sops.yaml'), 'creation_rules: []\n')
    await fs.writeFile(path.join(repo, 'charts', 'demo', 'templates', '_extra-alerts.yaml'), '# hand-written\n')
    await fs.writeFile(path.join(repo, 'charts', 'demo', 'templates', 'my.alerts.yaml'), '# hand-written\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'a'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'b', '--allow-empty'], { cwd: repo })
    sha = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo, encoding: 'utf-8' }).trim()
  })

  it.each([
    ['.gitignore'], ['.sops.yaml'], ['.github/workflows/ci.yaml'],
  ])('a diff of %s', async file => {
    const { status, text } = await api('GET', `/api/v2/git/diff?file=${q(file)}`)
    expect(status, text).toBe(200)
    expect(JSON.parse(text).modified).not.toBe('')
  })

  it('a diff at the commit ids the Git panel sends, and at HEAD~1', async () => {
    for (const ref of [sha, sha.slice(0, 7), 'HEAD~1', 'HEAD^']) {
      const { status, text } = await api('GET', `/api/v2/git/diff?file=.gitignore&ref=${q(ref)}`)
      expect(status, `${ref} ${text}`).toBe(200)
    }
  })

  it('a listing of a dot-folder', async () => {
    const { status, text } = await api('GET', `/api/v2/folders/tree?path=${q('.github')}`)
    expect(status, text).toBe(200)
  })

  it.each([['_extra-alerts'], ['my.alerts']])('a template file named %s opens and can be deleted, as the listing gives it', async name => {
    const listed = JSON.parse((await api('GET', '/api/v2/templates/demo')).text).templateFiles
    expect(listed).toContain(name)
    expect((await api('GET', `/api/v2/templates/demo/${encodeURIComponent(name)}`)).status).toBe(200)
    expect((await api('DELETE', `/api/v2/templates/demo/${encodeURIComponent(name)}`)).status).toBe(200)
  })

  it('a deployment in folders with dots, dashes and underscores, made, saved, read and previewed', async () => {
    const folder = 'deployments/my.team_1/app-x.prod'
    expect((await api('POST', '/api/v2/folders/init', { folder, chart: 'demo' })).status).toBe(200)
    expect((await api('POST', `/api/v2/deployments/demo/app-x.prod?folder=${q(folder)}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
    expect((await api('GET', `/api/v2/deployments/demo/app-x.prod?folder=${q(folder)}`)).status).toBe(200)
    expect((await api('POST', `/api/v2/render/demo/app-x.prod?folder=${q(folder)}`)).status).toBe(200)
  })

  it('a legacy flat deployment, named without a folder', async () => {
    await fs.mkdir(path.join(repo, 'deployments', 'demo'), { recursive: true })
    await fs.writeFile(path.join(repo, 'deployments', 'demo', 'old-values.yaml'), 'cpu: []\n')
    expect((await api('GET', '/api/v2/deployments/demo/old')).status).toBe(200)
  })

  it('a sync link whose target sync.yaml spells with backslashes is still copied to', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/b', chart: 'demo' })).status).toBe(200)
    await fs.writeFile(path.join(repo, 'sync.yaml'), 'syncs:\n  - source: deployments/team/a\n    targets:\n      - deployments\\team\\b\n')
    const { status, text } = await api('POST', `/api/v2/deployments/demo/a?folder=${q('deployments/team/a')}`, { values: { cpu: [{ namespace: 'q' }] } })
    expect(status, text).toBe(200)
    expect(JSON.parse(text).syncFailed).toBe(undefined)
    expect(await fs.readFile(path.join(repo, 'deployments/team/b/values.yaml'), 'utf-8')).toContain('namespace: q')
    await fs.rm(path.join(repo, 'sync.yaml'))
  })

  it('making a deployment of a Template named like one, and not of `.cache`', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/c', chart: '.cache' })).status).toBe(400)
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/c', chart: 'demo' })).status).toBe(200)
  })
})

// A link in the repo is followed to where it really is: outside the repo,
// refused before anything is read or written there; inside, fine.
describe('links', () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(root, 'outdir'), { recursive: true })
    await fs.writeFile(path.join(root, 'outside-file.yaml'), SENTINEL)
    await fs.symlink(path.join(root, 'outside-file.yaml'), path.join(repo, 'charts/demo/templates/out-link.yaml'))
    await fs.symlink(path.join(root, 'outdir'), path.join(repo, 'deployments', 'out-link'))
    await fs.symlink(path.join(repo, 'deployments', 'team'), path.join(repo, 'deployments', 'in-link'))
    await fs.writeFile(path.join(repo, 'charts/demo/templates/kept.yaml'), '# kept\n')
    await fs.symlink('kept.yaml', path.join(repo, 'charts/demo/templates/in-link.yaml'))
  })

  it.each([
    ['GET', '/api/v2/templates/demo/out-link'],
    ['POST', '/api/v2/templates/demo/out-link', { content: 'x: 1\n' }],
    ['POST', '/api/v2/folders/init', { folder: 'deployments/out-link/new', chart: 'demo' }],
    ['POST', '/api/v2/folders', { path: 'deployments/out-link/new' }],
    ['POST', `/api/v2/deployments/demo/new?folder=${q('deployments/out-link/new')}`, { values: { cpu: [{ namespace: 'p' }] } }],
  ])('%s %s → refused, nothing outside read or written', async (method, url, body) => {
    const { status, text } = await api(method, url, body)
    expect(status, text).toBe(400)
    expect(text).not.toContain('sentinel: outside')
    expect(await fs.readdir(path.join(root, 'outdir'))).toEqual([])
    expect(await fs.readFile(path.join(root, 'outside-file.yaml'), 'utf-8')).toBe(SENTINEL)
  })

  it('a link to a place in the repo is followed to a Template file; a deployment folder reached through one is none', async () => {
    expect((await api('GET', '/api/v2/templates/demo/in-link')).status).toBe(200)
    expect((await api('GET', `/api/v2/deployments/demo/a?folder=${q('deployments/in-link/a')}`)).status).toBe(400)
  })
})

describe('a sync target through a link', () => {
  it('outside the repo: refused, and an existing sync.yaml link to it is not copied to', async () => {
    const { status, text } = await api('POST', '/api/v2/sync', { source: 'deployments/team/a', target: 'deployments/out-link/new' })
    expect(status, text).toBe(400)
    await fs.mkdir(path.join(root, 'outdir', 'old'), { recursive: true })
    await fs.writeFile(path.join(root, 'outdir', 'old', 'Chart.yaml'), 'apiVersion: v2\nname: old\nversion: 0.1.0\ndependencies:\n  - name: demo\n    version: ">=0.0.0-0"\n    repository: file://../../../charts/demo\n')
    await fs.writeFile(path.join(root, 'outdir', 'old', 'values.yaml'), SENTINEL)
    await fs.writeFile(path.join(repo, 'sync.yaml'), 'syncs:\n  - source: deployments/team/a\n    targets:\n      - deployments/out-link/old\n')
    const save = await api('POST', `/api/v2/deployments/demo/a?folder=${q('deployments/team/a')}`, { values: { cpu: [{ namespace: 'z' }] } })
    expect(save.status, save.text).toBe(200)
    expect(JSON.parse(save.text).syncFailed?.[0]?.target ?? JSON.stringify(JSON.parse(save.text).syncFailed)).toContain('deployments/out-link/old')
    expect(await fs.readFile(path.join(root, 'outdir', 'old', 'values.yaml'), 'utf-8')).toBe(SENTINEL)
    await fs.rm(path.join(repo, 'sync.yaml'))
  })
})

// A folder reached through a link is no deployment at any route that takes
// one: each says why, and for a link that stays in the repo which path to
// ask for instead; for one leading out, that it does, and no path of the
// machine.
describe('a deployment folder reached through a link', () => {
  const IN = 'deployments/in-link/a'
  const OUT = 'deployments/out-link/a'
  const calls = folder => [
    ['GET', `/api/v2/deployments/demo?folder=${q(folder)}`],
    ['GET', `/api/v2/deployments/demo/a?folder=${q(folder)}`],
    ['POST', `/api/v2/deployments/demo/a?folder=${q(folder)}`, { values: { cpu: [{ namespace: 'p' }] } }],
    ['GET', `/api/v2/deployments/demo/a/routing?folder=${q(folder)}`],
    ['PUT', `/api/v2/deployments/demo/a/routing?folder=${q(folder)}`, { routing: 'labels: {}\nconfigs: {}\ncells: []\n' }],
    ['DELETE', `/api/v2/deployments/demo/a/routing?folder=${q(folder)}`],
    ['POST', `/api/v2/deployments/demo/a/clone?folder=${q(folder)}`, { newName: 'copy' }],
    ['DELETE', `/api/v2/deployments/demo/a?folder=${q(folder)}`],
    ['POST', `/api/v2/render/demo/a?folder=${q(folder)}`],
    ['POST', '/api/v2/sync', { source: folder, target: 'deployments/team/z' }],
  ]

  it.each(calls(IN))('%s %s → 400 naming the path to ask for', async (method, url, body) => {
    const { status, text } = await api(method, url, body)
    expect(status, text).toBe(400)
    const { error } = JSON.parse(text)
    expect(error).toContain('deployments/in-link is a link to deployments/team')
    expect(error).toContain('ask for deployments/team/a')
  })

  it.each(calls(OUT))('%s %s → 400 saying it leads outside, without a path of the machine', async (method, url, body) => {
    const { status, text } = await api(method, url, body)
    expect(status, text).toBe(400)
    expect(JSON.parse(text).error).toContain('deployments/out-link is a link that leads outside the repo')
    expect(text).not.toContain(root)
  })

  it('a new deployment or _common through a link says where to make it instead', async () => {
    const init = await api('POST', '/api/v2/folders/init', { folder: 'deployments/in-link/new', chart: 'demo' })
    expect(init.status, init.text).toBe(400)
    expect(JSON.parse(init.text).error).toContain('make it in deployments/team/new')
    const plan = await api('GET', `/api/v2/folders/common/plan?action=create&chart=demo&folder=${q('deployments/in-link')}`)
    expect(plan.status, plan.text).toBe(400)
    expect(JSON.parse(plan.text).error).toContain('ask for deployments/team')
  })
})

// A name longer than one file name may be is refused naming the limit,
// wherever a name is taken: not the file system's error as a 500.
describe('a name longer than 255 bytes', () => {
  const LONG = 'x'.repeat(300)
  it.each([
    ['POST', '/api/v2/charts', { name: LONG }],
    ['POST', '/api/v2/charts/demo/clone', { newName: LONG }],
    ['DELETE', `/api/v2/charts/${LONG}`],
    ['GET', `/api/v2/templates/${LONG}/deployments`],
    ['GET', `/api/v2/templates/demo/${LONG}`],
    ['POST', `/api/v2/templates/demo/${LONG}`, { content: 'x: 1\n' }],
    ['POST', '/api/v2/folders', { path: `deployments/${LONG}` }],
    ['POST', '/api/v2/folders/init', { folder: `deployments/${LONG}`, chart: 'demo' }],
    ['DELETE', `/api/v2/deployments/demo/${LONG}?folder=${q('deployments/team/a')}`],
    ['POST', `/api/v2/deployments/demo/a/clone?folder=${q('deployments/team/a')}`, { newName: LONG }],
    ['GET', `/api/v2/deployments/demo/a?folder=${q(`deployments/${LONG}`)}`],
  ])('%s %s → 400 naming the limit', async (method, url, body) => {
    const { status, text } = await api(method, url, body)
    expect(status, text).toBe(400)
    expect(JSON.parse(text).error).toContain('at most 255 bytes')
  })

  it('a name of 255 bytes is taken', async () => {
    const { status, text } = await api('POST', '/api/v2/folders', { path: `deployments/${'y'.repeat(255)}` })
    expect(status, text).toBe(200)
  })
})

// A diff is shown at a commit only when git has it as one, and the work
// tree's file only when the folder it is in is really in the repo.
describe('a diff', () => {
  it.each([
    ['a commit id the repo has not', 'deadbeefdeadbeef'],
    ['a commit further back than the history', 'HEAD~99'],
  ])('at %s → 400', async (_, ref) => {
    const { status, text } = await api('GET', `/api/v2/git/diff?file=.gitignore&ref=${q(ref)}`)
    expect(status, text).toBe(400)
    expect(JSON.parse(text).error).toContain('no commit of this repo')
  })

  it('at a tree id → 400: it is no commit', async () => {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf-8' }).trim()
    const { status, text } = await api('GET', `/api/v2/git/diff?file=.gitignore&ref=${tree}`)
    expect(status, text).toBe(400)
  })

  it('of a file reached through a folder that is a link out of the repo → 400, nothing of it read', async () => {
    await fs.writeFile(path.join(root, 'outdir', 'secret.yaml'), SENTINEL)
    try {
      const { status, text } = await api('GET', `/api/v2/git/diff?file=${q('deployments/out-link/secret.yaml')}`)
      expect(status, text).toBe(400)
      expect(text).not.toContain('sentinel: outside')
      expect(text).not.toContain(root)
    } finally {
      await fs.rm(path.join(root, 'outdir', 'secret.yaml'))
    }
  })

  it('of a file reached through a link in the repo is read there', async () => {
    const { status, text } = await api('GET', `/api/v2/git/diff?file=${q('deployments/in-link/a/values.yaml')}`)
    expect(status, text).toBe(200)
    expect(JSON.parse(text).modified).not.toBe('')
  })
})

// A values.yaml that is not YAML is named with its reason whole, also in
// a folder whose name has a space.
it('a deployment in a folder with a space whose values.yaml is not YAML: the answer names the file and the reason', async () => {
  const folder = 'deployments/my team/a'
  // Made by hand: the links above leave the Template one init refuses.
  await fs.mkdir(path.join(repo, folder), { recursive: true })
  await fs.copyFile(path.join(repo, 'deployments/team/a/Chart.yaml'), path.join(repo, folder, 'Chart.yaml'))
  await fs.writeFile(path.join(repo, folder, 'values.yaml'), 'demo:\n  cpu: [\n')
  const { status, text } = await api('GET', `/api/v2/deployments/demo/a?folder=${q(folder)}`)
  expect(status, text).toBe(409)
  const { error } = JSON.parse(text)
  expect(error.startsWith('deployments/my team/a/values.yaml cannot be read: '), error).toBe(true)
  expect(error).not.toContain('team/a/values.yaml line')
})
