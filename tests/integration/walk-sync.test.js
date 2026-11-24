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
    const users = (await api('GET', '/api/v2/templates/demo/deployments')).data
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
    expect(from).toEqual({ status: 400, data: { error: `deployments/alias: it is a link to ${A} — a folder that is a link is no deployment` } })
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
      expect((await api('GET', '/api/v2/templates/demo/deployments')).data.unreadable).toEqual([])
      expect((await api('GET', '/api/v2/folders/tree?path=deployments/out')).data).toEqual([])
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('sync.yaml, read once for everyone', () => {
  it('a backslash and a target listed twice are read as one link, said as facts Commit lets through', async () => {
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `syncs:\n  - source: ${A}\n    targets: ['deployments\\t\\b', ${B}]\n`)
    const loaded = await loadSync(openRepo(tmpDir))
    expect(loaded.value.syncs).toEqual([{ source: A, targets: [B, B] }])
    expect(loaded.findings.map(f => f.code)).toEqual(['sync.backslash', 'sync.duplicate-target'])
    expect((await deploymentCommitBlockers(tmpDir)).findings.filter(f => f.kind === 'sync-registry')).toEqual([])
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
