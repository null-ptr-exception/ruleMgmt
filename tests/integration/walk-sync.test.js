// The one walk and the one reader of sync.yaml, as the entry points answer
// with them: a deployment whose Chart.yaml cannot be read is named where
// deployments are listed, a folder that is a link is no deployment
// anywhere, and sync.yaml's rows are facts every entry point reads alike.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import express from 'express'
import { openRepo } from '../../server/repo/openRepo.js'
import { loadSync } from '../../server/repo/sync.js'
import { walk, folderEntry } from '../../server/repo/walk.js'
import { deploymentCommitBlockers } from '../../server/lib/commitChecks.js'
import { findChartUsage } from '../../server/lib/chartUsage.js'

const run = promisify(execFile)
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const ROOT = path.resolve(import.meta.dirname, '../..')
const MOUNTS = ['templates', 'deployments', 'folders', 'git', 'sync', 'render']
const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n'
const A = 'deployments/t/a'
const B = 'deployments/t/b'

let server, baseURL, tmpDir, locked

beforeEach(async () => {
  locked = []
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walk-sync-'))
  await run('git', ['init', '-q'], { cwd: tmpDir })
  const routes = await Promise.all(MOUNTS.map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  MOUNTS.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const d of [A, B]) {
    expect((await api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' })).status).toBe(200)
    await fs.writeFile(path.join(tmpDir, d, 'values.yaml'), `demo:\n  cpu:\n    - job: ${path.basename(d)}\n`)
  }
})

afterEach(async () => {
  for (const p of locked) await fs.chmod(p, 0o755).catch(() => {})
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const lock = async rel => { await fs.chmod(path.join(tmpDir, rel), 0o000); locked.push(path.join(tmpDir, rel)) }

describe('a deployment whose Chart.yaml cannot be read or used', () => {
  it.skipIf(IS_ROOT)('is named in the tree and by who uses the Template, not taken for a plain folder', async () => {
    await lock(`${A}/Chart.yaml`)
    const node = (await api('GET', '/api/v2/folders/tree?path=deployments/t')).data.find(n => n.name === 'a')
    expect(node).toMatchObject({ unreadable: 'its Chart.yaml cannot be read (permission denied)' })
    expect(node.isDeployment).toBeUndefined()
    const users = await findChartUsage(tmpDir, 'demo')
    expect(users.deployments.map(d => d.path)).toEqual([B])
    expect(users.unreadable).toEqual([{ path: A, error: 'its Chart.yaml cannot be read (permission denied)' }])
  })

  it('that is not YAML is listed by Commit as one it could not check, and named in the tree', async () => {
    await fs.writeFile(path.join(tmpDir, A, 'Chart.yaml'), 'dependencies: [\n')
    const blockers = await deploymentCommitBlockers(tmpDir)
    expect(blockers.unreadable).toEqual([{ path: A, error: expect.stringMatching(/^its Chart\.yaml cannot be used/) }])
    const node = (await api('GET', '/api/v2/folders/tree?path=deployments/t')).data.find(n => n.name === 'a')
    expect(node.unreadable).toMatch(/^its Chart\.yaml cannot be used/)
  })
})

describe('the tree', () => {
  it('shows a folder as a deployment by the walk\'s rule: not a values.yaml alone, nor a Chart.yaml naming no Template', async () => {
    const isDeployment = async (parent, name) => !!(await api('GET', `/api/v2/folders/tree?path=${parent}`)).data.find(n => n.name === name).isDeployment
    expect(await isDeployment('deployments/t', 'a')).toBe(true)
    await fs.mkdir(path.join(tmpDir, 'deployments/w/vo'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'deployments/w/vo/values.yaml'), 'demo: {}\n')
    expect(await isDeployment('deployments/w', 'vo')).toBe(false)
    await fs.writeFile(path.join(tmpDir, 'deployments/w/vo/Chart.yaml'), 'apiVersion: v2\nname: vo\nversion: 0.1.0\n')
    expect(await isDeployment('deployments/w', 'vo')).toBe(false)
  })
})

describe('a folder that is a link', () => {
  beforeEach(async () => {
    await fs.symlink('t/a', path.join(tmpDir, 'deployments', 'alias'))
  })

  it('is no deployment to the walk, wherever it leads', async () => {
    const repo = openRepo(tmpDir)
    expect(await folderEntry(repo, 'deployments/alias')).toMatchObject({ kind: 'folder', link: 'inside', why: `it is a link to ${A}` })
    expect((await walk(repo)).map(e => `${e.rel} ${e.kind}`)).toEqual(['deployments/alias folder', `${A} deployment`, `${B} deployment`])
  })

  it('is refused by sync, Preview and the deployment routes, naming what it leads to', async () => {
    const from = await api('POST', '/api/v2/sync', { source: 'deployments/alias', target: 'deployments/t/c' })
    expect(from).toEqual({ status: 400, data: { error: `deployments/alias: it is a link to ${A} — a folder that is a link is no deployment: ask for ${A}` } })
    const preview = await api('POST', '/api/v2/render/demo/alias?folder=deployments/alias')
    expect(preview.status).toBe(400)
    expect(preview.data.error).toContain(`it is a link to ${A}`)
    expect((await api('GET', '/api/v2/deployments/demo/alias/routing?folder=deployments/alias')).status).toBe(400)
  })

  it('as a sync target, refuses the commit and is not written to by a save', async () => {
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `syncs:\n  - source: ${A}\n    targets: [deployments/alias]\n`)
    const loaded = await loadSync(openRepo(tmpDir))
    expect(loaded.findings.map(f => [f.code, f.detail.role])).toEqual([['sync.not-deployment', 'target']])
    const blockers = await deploymentCommitBlockers(tmpDir)
    expect(blockers.findings.map(f => f.description)).toContain('sync.yaml syncs[0]: target deployments/alias is not a deployment')
  })

  it('given to check-deployment is not checked (exit 2), naming where it leads', async () => {
    let out, code = 0
    try {
      await run('node', [path.join(ROOT, 'scripts/check-deployment.mjs'), '--repo', tmpDir, path.join(tmpDir, 'deployments', 'alias')])
    } catch (err) { ({ code } = err); out = err.stderr + err.stdout }
    expect(code).toBe(2)
    expect(out).toContain(`is a link to ${A}: a folder that is a link is no deployment — check ${A}`)
  })
})

describe('check-deployment on a repo reached through a linked path', () => {
  it('with no repo given, checks the routing too: the deployment is inside the repo git finds', async () => {
    const via = `${tmpDir}-via`
    await fs.symlink(tmpDir, via)
    try {
      let out = ''
      try {
        ({ stdout: out } = await run('node', [path.join(ROOT, 'scripts/check-deployment.mjs'), path.join(via, A)]))
      } catch (err) { out = err.stdout + err.stderr }
      expect(out).toContain('Routing: no routing.yaml')
      expect(out).not.toContain('not a deployment folder inside the repo')
    } finally {
      await fs.rm(via, { force: true })
    }
  })
})

describe('check-deployment on a folder reached through a link inside the repo', () => {
  it('is not checked (exit 2), naming the link and the folder to check, with or without --repo', async () => {
    await fs.symlink('t', path.join(tmpDir, 'deployments', 'tl'))
    for (const args of [[], ['--repo', tmpDir]]) {
      let out = '', code = 0
      try {
        await run('node', [path.join(ROOT, 'scripts/check-deployment.mjs'), ...args, path.join(tmpDir, 'deployments', 'tl', 'a')])
      } catch (err) { ({ code } = err); out = err.stderr + err.stdout }
      expect(code).toBe(2)
      expect(out).toContain('deployments/tl is a link to deployments/t — a folder reached through a link is no deployment: check deployments/t/a')
    }
  })
})

describe('check-deployment given --repo and a folder outside it', () => {
  it('does not check it (exit 2), saying it is not in that repo', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'walk-sync-else-'))
    try {
      for (const f of ['Chart.yaml', 'values.yaml']) await fs.copyFile(path.join(tmpDir, A, f), path.join(elsewhere, f))
      let out = '', code = 0
      try {
        await run('node', [path.join(ROOT, 'scripts/check-deployment.mjs'), '--repo', tmpDir, elsewhere])
      } catch (err) { ({ code } = err); out = err.stderr + err.stdout }
      expect(code).toBe(2)
      expect(out).toContain(`${elsewhere} is not inside the repo ${tmpDir}`)
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('a folder that is a link leading outside the repo', () => {
  it('is named in the tree and by Commit, and holds none of the repo\'s deployments for who uses a Template', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'walk-sync-out-'))
    try {
      await fs.mkdir(path.join(outside, 'x'))
      await fs.symlink(outside, path.join(tmpDir, 'deployments', 'out'))
      await fs.symlink(path.join(outside, 'f.yaml'), path.join(tmpDir, 'deployments', 'f.yaml'))
      const tree = (await api('GET', '/api/v2/folders/tree?path=deployments')).data
      expect(tree.map(n => [n.name, n.unreadable ?? null])).toEqual([['out', 'it is a link that leads outside the repo'], ['t', null]])
      expect((await deploymentCommitBlockers(tmpDir)).unreadable).toEqual([{ path: 'deployments/out', error: 'it is a link that leads outside the repo' }])
      expect((await findChartUsage(tmpDir, 'demo')).unreadable).toEqual([])
      expect((await api('GET', '/api/v2/folders/tree?path=deployments/out')).data).toEqual([])
      // In a folder of its own, the folder opens to show it.
      await fs.mkdir(path.join(tmpDir, 'deployments', 'only'))
      await fs.symlink(outside, path.join(tmpDir, 'deployments', 'only', 'out'))
      expect((await api('GET', '/api/v2/folders/tree?path=deployments')).data.find(n => n.name === 'only')).toMatchObject({ isLeaf: false })
      expect((await api('GET', '/api/v2/folders/tree?path=deployments/only')).data.map(n => n.unreadable)).toEqual(['it is a link that leads outside the repo'])
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('deleting a sync source', () => {
  it('lets go only of the targets still on disk: one inside it went with it', async () => {
    const inner = `${A}/inner`
    expect((await api('POST', '/api/v2/folders/init', { folder: B, chart: 'demo' })).status).toBe(200)
    await fs.mkdir(path.join(tmpDir, inner), { recursive: true })
    for (const f of ['Chart.yaml', 'values.yaml']) await fs.copyFile(path.join(tmpDir, B, f), path.join(tmpDir, inner, f))
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `syncs:\n  - source: ${A}\n    targets: [${B}, ${inner}]\n`)
    const del = await api('DELETE', `/api/v2/deployments/demo/a?folder=${A}`)
    expect(del).toEqual({ status: 200, data: { ok: true, unlinked: [B] } })
  })
})

// Every file of the repo but .git, with its bytes: what a refused write leaves as it was.
async function treeSnapshot(dir, rel = '') {
  const out = {}
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.posix.join(rel, e.name)
    if (p === '.git') continue
    if (e.isDirectory()) Object.assign(out, await treeSnapshot(dir, p))
    else out[p] = await fs.readFile(path.join(dir, p), 'utf-8').catch(err => `<${err.code}>`)
  }
  return out
}

describe('sync.yaml that is YAML but not a registry', () => {
  it('a list, a scalar, or syncs that is not a list is invalid; an empty or comments-only file is no syncs', async () => {
    const at = async text => { await fs.writeFile(path.join(tmpDir, 'sync.yaml'), text); return loadSync(openRepo(tmpDir)) }
    for (const [text, code] of [[`- source: ${A}\n`, 'sync.not-map'], ['just text\n', 'sync.not-map'], ['syncs: none\n', 'sync.syncs-not-list'], [`syncs:\n  source: ${A}\n`, 'sync.syncs-not-list']]) {
      const loaded = await at(text)
      expect(loaded.state, text).toBe('invalid')
      expect(loaded.findings.map(f => f.code), text).toEqual([code])
    }
    for (const text of ['', '# no syncs yet\n', 'syncs:\n']) {
      const loaded = await at(text)
      expect(loaded.state, text).toBe('ok')
      expect(loaded.value.syncs, text).toEqual([])
    }
  })

  it('a sync made on a repo whose sync.yaml is a list is refused (409), and nothing changes', async () => {
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `- source: ${A}\n  targets: [${B}]\n`)
    const before = await treeSnapshot(tmpDir)
    const res = await api('POST', '/api/v2/sync', { source: A, target: B })
    expect(res.status).toBe(409)
    expect(res.data).toMatchObject({ file: 'sync.yaml', error: expect.stringMatching(/^sync\.yaml is not a map/) })
    expect(await treeSnapshot(tmpDir)).toEqual(before)
  })
})

describe('sync.yaml, read once for everyone', () => {
  it('read and not YAML is invalid, with a finding; one that cannot be read is unreadable', async () => {
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), 'syncs: [\n')
    const notYaml = await loadSync(openRepo(tmpDir))
    expect(notYaml.state).toBe('invalid')
    expect(notYaml.findings.map(f => f.code)).toEqual(['sync.not-yaml'])
    const get = await api('GET', '/api/v2/sync')
    expect(get.status).toBe(409)
    expect(get.data).toMatchObject({ file: 'sync.yaml', error: expect.stringMatching(/^sync\.yaml is not valid YAML \(/) })
    await fs.rm(path.join(tmpDir, 'sync.yaml'))
    await fs.mkdir(path.join(tmpDir, 'sync.yaml'))
    expect(await loadSync(openRepo(tmpDir))).toMatchObject({ state: 'unreadable', kind: 'folder' })
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ error: 'sync.yaml cannot be read (it is a folder, not a file)', file: 'sync.yaml', unreadable: true })
  })

  it('a backslash and a target listed twice are read as one link, said as facts Commit lets through', async () => {
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `syncs:\n  - source: ${A}\n    targets: ['deployments\\t\\b', ${B}]\n`)
    const loaded = await loadSync(openRepo(tmpDir))
    expect(loaded.value.syncs).toEqual([{ source: A, targets: [B, B] }])
    expect(loaded.findings.map(f => f.code)).toEqual(['sync.backslash', 'sync.duplicate-target'])
    expect((await deploymentCommitBlockers(tmpDir)).findings.filter(f => f.kind === 'sync-registry')).toEqual([])
  })

  it('one that is a folder is named (409) by a breaking change, its preview and a _common\'s plan', async () => {
    await fs.mkdir(path.join(tmpDir, 'sync.yaml'))
    const BREAKING = CPU.replace('job: {type: string, required: true}', 'job: {type: string, required: true}\n  team: {type: string, required: true}')
    const named = { error: 'sync.yaml cannot be read (it is a folder, not a file)', file: 'sync.yaml', unreadable: true }
    expect(await api('POST', '/api/v2/templates/demo/migration-preview', { files: { 'cpu.yaml': BREAKING }, migration: {} })).toEqual({ status: 409, data: named })
    expect(await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': BREAKING } })).toEqual({ status: 409, data: named })
    expect(await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': BREAKING }, confirmBreaking: true, migration: { columns: {} } })).toEqual({ status: 409, data: named })
    expect(await api('GET', '/api/v2/folders/common/plan?folder=deployments/t&chart=demo')).toEqual({ status: 409, data: named })
  })

  it('one that is a folder is named by Commit (409), not a 500', async () => {
    await fs.mkdir(path.join(tmpDir, 'sync.yaml'))
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'x\n')
    const res = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(res.status).toBe(409)
    expect(res.data.findings).toContainEqual(expect.objectContaining({ kind: 'sync-registry', description: 'sync.yaml cannot be read (it is a folder, not a file)' }))
  })

  it.skipIf(IS_ROOT)('one that cannot be read is named by a save and by deleting a deployment (409), and nothing is removed', async () => {
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `syncs:\n  - source: ${A}\n    targets: [${B}]\n`)
    await lock('sync.yaml')
    const open = await api('GET', `/api/v2/deployments/demo/a?folder=${A}`)
    const save = await api('POST', `/api/v2/deployments/demo/a?folder=${A}`, { values: 'demo:\n  cpu:\n    - job: z\n', ...(open.data?.version ? { version: open.data.version } : {}) })
    expect(save).toEqual({ status: 409, data: { error: 'sync.yaml cannot be read (permission denied)', file: 'sync.yaml', unreadable: true } })
    const del = await api('DELETE', `/api/v2/deployments/demo/a?folder=${A}`)
    expect(del.status).toBe(409)
    expect(await fs.stat(path.join(tmpDir, A, 'values.yaml')).then(() => true)).toBe(true)
  })
})
