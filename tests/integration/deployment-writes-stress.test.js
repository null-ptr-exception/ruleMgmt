// The deployment side's writes under load (server/repo/write.js): two
// conflicting changes at once, and each kind beside a Commit. What must
// hold every round: each answer is a whole change or none of it, a Commit
// takes a change whole or not at all, the commit lock is free again, and no
// temp file is left.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { withSyncRegistryLock } from '../../server/repo/lock.js'
import { defineChange, planChange, applyChange } from '../../server/repo/write.js'
import { openRepo } from '../../server/repo/openRepo.js'
import { planMigration } from '../../server/lib/migrate.js'

let server, baseURL, root, errors

// The migration's writes into deployments as the Template's save takes
// them (a test kind: the save's own files left out), so the seam is tried
// with the writer as the save will use it.
defineChange('test-migration', {
  policy: 'save',
  async plan(repo, { migration }) {
    const targetSchema = JSON.parse((await repo.file('charts/demo/values.schema.json')).value.text)
    const m = await planMigration(repo, { chart: 'demo', targetSchema, migration })
    if (m.refusal) return { refusal: m.refusal }
    return { files: m.files, facts: { strict: m.strict } }
  },
  strict: plan => plan.facts.strict,
  table: () => 'save',
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: 'changed', changed: true } }),
  answer: () => ({ ok: true }),
})

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-writes-stress-'))
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const names = ['templates', 'charts', 'deployments', 'folders', 'sync', 'git']
  const routers = await Promise.all(names.map(r => import(`../../server/routes/${r}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  names.forEach((r, i) => app.use(`/api/v2/${r}`, routers[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  git('init', '-q'); git('config', 'user.email', 'stress@example.invalid'); git('config', 'user.name', 'stress'); git('config', 'commit.gpgsign', 'false')
  expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const d of [A, B, C, P, Q]) {
    expect((await api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' })).status).toBe(200)
    expect((await save(d, path.basename(d))).status).toBe(200)
  }
  await fs.writeFile(path.join(root, '.gitignore'), 'Chart.lock\n**/charts/*.tgz\n')
  git('add', '-A'); git('commit', '-qm', 'base')
})

afterEach(async () => {
  errors.mockRestore()
  if (server) await new Promise(r => server.close(r))
  await fs.rm(root, { recursive: true, force: true })
})

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const q = f => `?folder=${encodeURIComponent(f)}`
const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n'
const A = 'deployments/t/a'
const B = 'deployments/t/b'
const C = 'deployments/t/c'
const U = 'deployments/u'
const P = 'deployments/u/p'
const Q = 'deployments/u/q'
const save = (dep, job) => api('POST', `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`, { values: { cpu: [{ job }] } })
const commit = message => api('POST', '/api/v2/git/commit', { message })

// Every file of the work tree (no .git): path → its text, or 'link:<to>'.
async function files(rel = '') {
  const out = {}
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (p === '.git') continue
    if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(root, p))}`
    else if (e.isDirectory()) Object.assign(out, await files(p))
    else out[p] = await fs.readFile(path.join(root, p), 'utf-8')
  }
  return out
}
// What HEAD holds, for the paths of `like` (tracked files only).
function head(paths) {
  const out = {}
  for (const p of paths) {
    try {
      const mode = git('ls-tree', 'HEAD', '--', p).split(/\s/)[0]
      const blob = execFileSync('git', ['show', `HEAD:${p}`], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      out[p] = mode === '120000' ? `link:${blob}` : blob
    } catch { /* not in HEAD */ }
  }
  return out
}
const tracked = m => Object.fromEntries(Object.entries(m).filter(([p]) => !/(^|\/)Chart\.lock$|\/charts\/[^/]+\.tgz$/.test(p)))
const lockFree = async () => {
  let free = false
  await Promise.race([withSyncRegistryLock(root, async () => { free = true }), new Promise(r => setTimeout(r, 3000))])
  return free
}
const noTemp = async () => Object.keys(await files()).filter(p => /\.tmp$/.test(p))

// One round of `change` beside a Commit: the commit holds the change whole
// (everything it changed as before, or as after), the lock is free, no temp file.
async function besideCommit(round, change, want = [200]) {
  const before = tracked(await files())
  await fs.writeFile(path.join(root, 'marker.txt'), `${round}\n`)
  const [done, committed] = await Promise.all([change(), commit(`round ${round}`)])
  expect(want, `round ${round}: ${JSON.stringify(done.data)}`).toContain(done.status)
  expect(committed.status).toBe(200)
  const after = tracked(await files())
  delete before['marker.txt']
  delete after['marker.txt']
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(p => before[p] !== after[p])
  const inHead = head(changed)
  const is = state => changed.every(p => inHead[p] === state[p])
  expect(is(before) || is(after), `round ${round}: HEAD holds part of the change (${changed.join(', ')})`).toBe(true)
  expect(await lockFree()).toBe(true)
  expect(await noTemp()).toEqual([])
  if (git('status', '--porcelain')) { git('add', '-A'); git('commit', '-qm', `rest ${round}`) }
}

describe('stress: two changes at once', () => {
  it('20 rounds of a _common made beside a values save in that folder: never values of the old shape on the new stack', async () => {
    for (let round = 0; round < 20; round++) {
      const plan = (await api('GET', `/api/v2/folders/common/plan?folder=${U}&chart=demo`)).data
      const [made, saved] = await Promise.all([
        api('POST', '/api/v2/folders/common', { action: 'create', folder: U, chart: 'demo', expected: plan.expected }),
        save(P, `r${round}`),
      ])
      expect([200, 409]).toContain(made.status)
      expect([200, 409]).toContain(saved.status)
      // What p deploys is readable, and on the stack its Chart.yaml says.
      const open = await api('GET', `/api/v2/deployments/demo/p${q(P)}`)
      expect(open.status).toBe(200)
      if (saved.status === 200) expect(JSON.stringify(open.data)).toContain(`r${round}`)
      if (made.status === 200) expect(await fs.readFile(path.join(root, P, 'Chart.yaml'), 'utf-8')).toContain('_common/demo')
      expect(await lockFree()).toBe(true)
      expect(await noTemp()).toEqual([])
      if (made.status === 200) {
        const drop = (await api('GET', `/api/v2/folders/common/plan?action=delete&path=${U}/_common/demo`)).data
        expect((await api('POST', '/api/v2/folders/common', { action: 'delete', path: `${U}/_common/demo`, expected: drop.expected })).status).toBe(200)
      }
    }
  }, 300_000)

  it('20 rounds of the migration\'s deployment writes beside a values save: a save is never migrated over', async () => {
    const migrate = async () => applyChange(await planChange(openRepo(root), { kind: 'test-migration', migration: { columns: {} } }))
    for (let round = 0; round < 20; round++) {
      // Each round the migration has something to write, the saved file
      // too: files in flow style, which it writes in block style.
      await fs.writeFile(path.join(root, C, 'values.yaml'), `demo:\n  cpu: [{job: c${round}}]\n`)
      await fs.writeFile(path.join(root, A, 'values.yaml'), `demo:\n  cpu: [{job: a${round}}]\n`)
      const [m, s] = await Promise.all([migrate(), save(A, `r${round}`)])
      expect([200, 409]).toContain(m.status)
      expect([200, 409]).toContain(s.status)
      // One of the two is written whole; the other, planned on the file
      // before it, is refused, never written over it.
      const a = await fs.readFile(path.join(root, A, 'values.yaml'), 'utf-8')
      if (s.status === 200) expect(a).toContain(`r${round}`)
      else expect(m.status).toBe(200)
      if (m.status === 409) expect(s.status).toBe(200)
      expect(await lockFree()).toBe(true)
      expect(await noTemp()).toEqual([])
    }
  }, 300_000)
})

describe('stress: each kind beside a Commit, 50 rounds', () => {
  it('a sync link and unlink', async () => {
    for (let round = 0; round < 50; round++) {
      await besideCommit(round, () => (round % 2 ? api('DELETE', '/api/v2/sync', { target: B }) : api('POST', '/api/v2/sync', { source: A, target: B })))
    }
  }, 300_000)

  it('a new deployment, then deleting it', async () => {
    for (let round = 0; round < 50; round++) {
      const n = `deployments/t/n${Math.floor(round / 2)}`
      await besideCommit(round, () => (round % 2 ? api('DELETE', `/api/v2/deployments/demo/${path.basename(n)}${q(n)}`) : api('POST', '/api/v2/folders/init', { folder: n, chart: 'demo' })))
    }
  }, 300_000)

  it('deleting a sync source', async () => {
    for (let round = 0; round < 50; round++) {
      const s = `deployments/t/s${round}`
      expect((await api('POST', '/api/v2/folders/init', { folder: s, chart: 'demo' })).status).toBe(200)
      expect((await save(s, `s${round}`)).status).toBe(200)
      expect((await api('POST', '/api/v2/sync', { source: s, target: C })).status).toBe(200)
      git('add', '-A'); git('commit', '-qm', `made ${round}`)
      await besideCommit(round, () => api('DELETE', `/api/v2/deployments/demo/s${round}${q(s)}`))
    }
  }, 300_000)

  it('a _common made, then removed', async () => {
    for (let round = 0; round < 50; round++) {
      if (round % 2) {
        // In block YAML: what it gives can be moved down when it is removed.
        await fs.writeFile(path.join(root, U, '_common/demo/values.yaml'), `demo:\n  cpu:\n    - job: layer${round}\n`)
        git('add', '-A'); git('commit', '-qm', `layer ${round}`)
      }
      await besideCommit(round, async () => {
        if (round % 2 === 0) {
          const plan = (await api('GET', `/api/v2/folders/common/plan?folder=${U}&chart=demo`)).data
          return api('POST', '/api/v2/folders/common', { action: 'create', folder: U, chart: 'demo', expected: plan.expected })
        }
        const plan = (await api('GET', `/api/v2/folders/common/plan?action=delete&path=${U}/_common/demo`)).data
        return api('POST', '/api/v2/folders/common', { action: 'delete', path: `${U}/_common/demo`, expected: plan.expected })
      })
    }
  }, 300_000)

  it('the migration\'s deployment writes', async () => {
    for (let round = 0; round < 50; round++) {
      await fs.writeFile(path.join(root, C, 'values.yaml'), `demo:\n  cpu: [{job: c${round}}]\n`)
      await fs.writeFile(path.join(root, P, 'values.yaml'), `demo:\n  cpu: [{job: p${round}}]\n`)
      git('add', '-A'); git('commit', '-qm', `out of shape ${round}`)
      await besideCommit(round, async () => applyChange(await planChange(openRepo(root), { kind: 'test-migration', migration: { columns: {} } })))
    }
  }, 300_000)
})
