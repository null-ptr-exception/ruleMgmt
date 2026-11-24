// A deployment's values save, as one write of the repo: the source and its
// sync targets' copies are written all or none; a file that cannot be
// written is a 409 naming it in the repo, never a 5xx; a change made while
// the save waits is not written over, version or not; a refused new
// deployment leaves no folder; a folder swapped for a link at write time is
// not written through. Two saves at once, and a save beside a Commit, are
// run many times: each ends whole. Events are ordered by the lock's waiter
// count and a hook on the temp file's write, not by timing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { withSyncRegistryLock, lockWaiters } from '../../server/repo/lock.js'
import { hooks } from '../../server/repo/write.js'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n    labels: {severity: critical}\n'
const SRC = 'deployments/t/a'
const TGT = 'deployments/t/b'
const T2 = 'deployments/t/c'
// Not synced to anything.
const D4 = 'deployments/t/d'
// The Template with a free env column, and with env one of [dev, prod].
const CPU_ENV = CPU.replace('columns:\n', 'columns:\n  env: {type: string}\n')
const CPU_ENUM = CPU.replace('columns:\n', 'columns:\n  env: {type: string, enum: [dev, prod]}\n')
const q = f => `?folder=${encodeURIComponent(f)}`
const vals = dep => `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`

// One hook on fs.writeFile, run once when a temp file is made in `dir`.
const writeHooks = new Set()
const plainWriteFile = fs.writeFile
beforeAll(() => {
  fs.writeFile = async function (file, ...rest) {
    for (const h of writeHooks) if (typeof file === 'string' && h.matches(file)) { writeHooks.delete(h); await h.run() }
    return plainWriteFile.call(this, file, ...rest)
  }
})
afterAll(() => { fs.writeFile = plainWriteFile })

let server, base, work, root, errors
let baseSha

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, data: JSON.parse(text), text }
}
const read = rel => fs.readFile(path.join(root, rel), 'utf-8')
const exists = rel => fs.lstat(path.join(root, rel)).then(() => true, () => false)
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
const version = async dep => (await api('GET', vals(dep))).data.version
const save = (dep, job, extra = {}) => api('POST', vals(dep), { values: { cpu: [{ job }] }, ...extra })

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'values-save-writer-'))
  root = path.join(work, 'repo')
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const routes = Object.fromEntries(await Promise.all(['templates', 'charts', 'deployments', 'folders', 'sync', 'git'].map(async n => [n, (await import(`../../server/routes/${n}.js`)).default])))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  for (const [n, r] of Object.entries(routes)) app.use(`/api/v2/${n}`, r())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r() }) })
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text}`); return r }
  await must(api('POST', '/api/v2/charts', { name: 'demo' }))
  await must(api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } }))
  for (const d of [SRC, TGT, T2, D4]) await must(api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  for (const d of [SRC, TGT, T2, D4]) await must(save(d, path.basename(d)))
  await must(api('POST', '/api/v2/sync', { source: SRC, target: TGT }))
  await must(api('POST', '/api/v2/sync', { source: SRC, target: T2 }))
  await must(api('POST', '/api/v2/git/commit', { message: 'base' }))
  baseSha = git('rev-parse', 'HEAD').trim()
}, 60_000)

afterAll(async () => {
  server?.close()
  execFileSync('chmod', ['-R', 'u+rwX', work])
  await fs.rm(work, { recursive: true, force: true })
})

beforeEach(async () => {
  execFileSync('chmod', ['-R', 'u+rwX', work])
  for (const e of await fs.readdir(root)) if (e !== '.git') await fs.rm(path.join(root, e), { recursive: true, force: true })
  for (const e of await fs.readdir(work)) if (e !== 'repo') await fs.rm(path.join(work, e), { recursive: true, force: true })
  git('reset', '-q', '--hard', baseSha); git('clean', '-ffdxq')
  hooks.planned = hooks.locked = hooks.beforeRename = null
  errors?.mockRestore()
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

// Every file of the repo but .git, with its content.
async function tree(dir = root) {
  const out = {}
  async function walk(r) {
    for (const e of await fs.readdir(path.join(dir, r), { withFileTypes: true })) {
      const p = r ? `${r}/${e.name}` : e.name
      if (p === '.git') continue
      if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(dir, p))}`
      else if (e.isDirectory()) { out[p] = 'dir'; await walk(p) } else out[p] = await fs.readFile(path.join(dir, p), 'utf-8').catch(() => 'unreadable')
    }
  }
  await walk('')
  return out
}

describe.skipIf(IS_ROOT)('a sync target that cannot be written fails the whole save', () => {
  it.each([
    ['its values.yaml is read-only', () => fs.chmod(path.join(root, T2, 'values.yaml'), 0o444)],
    ['its folder is read-only', () => fs.chmod(path.join(root, T2), 0o555)],
  ])('when %s: 409 naming it, the source and the other target as they were', async (_, setUp) => {
    await setUp()
    const before = await tree()
    const { status, data, text } = await save(SRC, 'new', { version: await version(SRC) })
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${T2}/values.yaml cannot be written: permission denied`, file: `${T2}/values.yaml` })
    expect(text).not.toContain(work)
    expect(await tree()).toEqual(before)
  })
})

describe.skipIf(IS_ROOT)('a file a save cannot write is a 409, never a 5xx', () => {
  it('the whole work tree read-only', async () => {
    execFileSync('chmod', ['-R', 'a-w', path.join(root, 'deployments')])
    const before = await tree()
    const { status, data } = await save(SRC, 'new')
    expect(status).toBe(409)
    expect(data.file).toBe(`${SRC}/values.yaml`)
    expect(data.error).toBe(`${SRC}/values.yaml cannot be written: permission denied`)
    expect(await tree()).toEqual(before)
  })

  it('a legacy <name>-values.yaml in a read-only folder', async () => {
    await fs.mkdir(path.join(root, 'deployments/demo'), { recursive: true })
    await fs.writeFile(path.join(root, 'deployments/demo/old-values.yaml'), 'demo:\n  cpu:\n    - job: old\n')
    await fs.chmod(path.join(root, 'deployments/demo'), 0o555)
    const { status, data } = await api('POST', '/api/v2/deployments/demo/old', { values: 'demo:\n  cpu:\n    - job: new\n' })
    expect(status).toBe(409)
    expect(data.error).toBe('deployments/demo/old-values.yaml cannot be written: permission denied')
  })
})

describe.skipIf(IS_ROOT)('a sync target whose file cannot be read fails the save before anything is written', () => {
  it('409 naming the file', async () => {
    await fs.chmod(path.join(root, T2, 'values.yaml'), 0)
    const before = await read(`${SRC}/values.yaml`)
    const { status, data } = await save(SRC, 'new')
    expect(status).toBe(409)
    expect(data.error).toBe(`${T2}/values.yaml cannot be read: permission denied`)
    expect(await read(`${SRC}/values.yaml`)).toBe(before)
  })
})

describe('a change made while a save waits for the lock is not written over', () => {
  it.each([['without a version', false], ['with the version the page loaded', true]])('%s: 409, the change kept', async (_, withVersion) => {
    const extra = withVersion ? { version: await version(SRC) } : {}
    let letGo
    const holding = withSyncRegistryLock(root, () => new Promise(r => { letGo = r }))
    // Held (not only asked for) before the save is sent.
    while (!letGo) await new Promise(r => setImmediate(r))
    const pending = save(SRC, 'mine', extra)
    // The save waits for the lock (planned, if it plans first); the file is changed meanwhile.
    for (let i = 0; i < 2000 && lockWaiters(root) === 0; i++) await new Promise(r => setTimeout(r, 5))
    expect(lockWaiters(root)).toBe(1)
    await fs.appendFile(path.join(root, SRC, 'values.yaml'), '# someone else\n')
    const changed = await read(`${SRC}/values.yaml`)
    letGo(); await holding
    const { status, data } = await pending
    expect(status).toBe(409)
    expect(data.changed).toBe(true)
    expect(await read(`${SRC}/values.yaml`)).toBe(changed)
    expect(await read(`${TGT}/values.yaml`)).not.toContain('mine')
  })
})

describe('a new deployment the save refuses leaves nothing behind', () => {
  it.each([
    ['values as a map', { cpu: [{}] }],
    ['values that are not YAML', 'demo:\n  cpu: [\n'],
  ])('%s: refused, no folder made', async (_, values) => {
    const { status } = await api('POST', vals('deployments/t/new'), { values })
    expect(status).toBe(400)
    expect(await exists('deployments/t/new')).toBe(false)
  })
})

describe('a folder swapped for a link while the save writes into it', () => {
  it('is not written through: 409, nothing outside the repo changed, the targets as they were', async () => {
    const outside = path.join(work, 'outside')
    const dir = path.join(root, SRC)
    const realDir = await fs.realpath(dir)
    await fs.cp(dir, outside, { recursive: true })
    const outsideBefore = await tree(outside)
    const before = await tree()
    let swapped = false
    writeHooks.add({
      matches: f => /\.tmp$/.test(f) && (path.dirname(f) === dir || path.dirname(f) === realDir),
      run: async () => { await fs.rename(dir, path.join(work, 'parked')); await fs.symlink(outside, dir); swapped = true },
    })
    const { status, data } = await save(SRC, 'new')
    expect(swapped).toBe(true)
    expect(status).toBe(409)
    expect(data.file).toBe(`${SRC}/values.yaml`)
    expect(await tree(outside)).toEqual(outsideBefore)
    await fs.rm(dir); await fs.rename(path.join(work, 'parked'), dir)
    const after = await tree()
    // What the swap left in the folder moved away: at most the temp file.
    for (const k of Object.keys(after)) if (/\.tmp$/.test(k)) delete after[k]
    expect(after).toEqual(before)
  })
})

// Runs `fn` once, the first time a save has been planned (before it waits
// for the lock).
const oncePlanned = fn => { let done = false; hooks.planned = async () => { if (done) return; done = true; await fn() } }

describe('a save is checked against the Template as it is when it is written', () => {
  it('a Template saved between the plan and the write that refuses the values: 400 with the field, nothing written', async () => {
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU_ENV } })).status).toBe(200)
    const before = await tree()
    let template
    oncePlanned(async () => { template = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU_ENUM }, confirmBreaking: true }) })
    const { status, data } = await api('POST', vals(SRC), { values: { cpu: [{ job: 'a', env: 'staging' }] } })
    expect(template.status).toBe(200)
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message).join(' ')).toMatch(/env/)
    for (const d of [SRC, TGT, T2]) expect(await read(`${d}/values.yaml`)).toBe(before[`${d}/values.yaml`])
  })

  it('50 rounds of a values save and a Template save at once: never values the Template on disk refuses', async () => {
    let stale = 0
    for (let round = 0; round < 50; round++) {
      expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU_ENV } })).status).toBe(200)
      expect((await api('POST', vals(SRC), { values: { cpu: [{ job: 'a', env: 'dev' }] } })).status).toBe(200)
      const [s] = await Promise.all([
        api('POST', vals(SRC), { values: { cpu: [{ job: `m${round}`, env: 'staging' }] } }),
        api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU_ENUM }, confirmBreaking: true }),
      ])
      expect([200, 400]).toContain(s.status)
      const onDisk = await read(`${SRC}/values.yaml`)
      if (onDisk.includes('staging') && (await read('charts/demo/rules/cpu.yaml')).includes('enum')) stale++
    }
    expect(stale).toBe(0)
  }, 300_000)
})

describe('a sync link made while a save is planned', () => {
  it('the save is planned again and written to the new target too', async () => {
    let linked
    oncePlanned(async () => { linked = await api('POST', '/api/v2/sync', { source: SRC, target: D4 }) })
    const { status, data } = await save(SRC, 'with-d')
    expect(linked.status).toBe(200)
    expect(status).toBe(200)
    expect(data.changed).toBeUndefined()
    const src = await read(`${SRC}/values.yaml`)
    expect(src).toContain('job: with-d')
    for (const d of [TGT, T2, D4]) expect(await read(`${d}/values.yaml`)).toBe(src)
  })

  it('an unrelated sync link (another source): saved', async () => {
    let linked
    oncePlanned(async () => { linked = await api('POST', '/api/v2/sync', { source: D4, target: 'deployments/t/e' }) })
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/t/e', chart: 'demo' })).status).toBe(200)
    const { status } = await save(SRC, 'unrelated')
    expect(linked.status).toBe(200)
    expect(status).toBe(200)
  })

  it('but the values file itself changed: 409, the change kept', async () => {
    oncePlanned(async () => { await fs.appendFile(path.join(root, SRC, 'values.yaml'), '# someone else\n') })
    const { status, data } = await save(SRC, 'mine')
    expect(status).toBe(409)
    expect(data.changed).toBe(true)
    expect(await read(`${SRC}/values.yaml`)).toContain('# someone else')
  })
})

describe('a sync target reached through a link is not written', () => {
  it('a target folder that is a link to another deployment: 409 naming it, that deployment untouched', async () => {
    await fs.rename(path.join(root, T2), path.join(work, 'parked'))
    await fs.symlink(path.join(root, D4), path.join(root, T2))
    const before = await tree()
    const { status, data } = await save(SRC, 'new')
    expect(status).toBe(409)
    expect(data.file).toBe(T2)
    expect(await tree()).toEqual(before)
  })

  it('swapped for such a link while the source is written: 409, that deployment untouched', async () => {
    const dir = path.join(root, SRC)
    const realDir = await fs.realpath(dir)
    const before = await tree()
    let swapped = false
    writeHooks.add({
      matches: f => /\.tmp$/.test(f) && (path.dirname(f) === dir || path.dirname(f) === realDir),
      run: async () => { await fs.rename(path.join(root, T2), path.join(work, 'parked')); await fs.symlink(path.join(root, D4), path.join(root, T2)); swapped = true },
    })
    const { status, data } = await save(SRC, 'new')
    expect(swapped).toBe(true)
    expect(status).toBe(409)
    expect(data.file).toBe(`${T2}/values.yaml`)
    expect(await read(`${D4}/values.yaml`)).toBe(before[`${D4}/values.yaml`])
    await fs.rm(path.join(root, T2)); await fs.rename(path.join(work, 'parked'), path.join(root, T2))
    const after = await tree()
    for (const k of Object.keys(after)) if (/\.tmp$/.test(k)) delete after[k]
    expect(after).toEqual(before)
  })
})

describe('a sync target whose files are there and cannot be used fails the save; one that is gone is listed', () => {
  it.skipIf(IS_ROOT)('its Chart.yaml cannot be read: 409 naming it, nothing written', async () => {
    await fs.chmod(path.join(root, TGT, 'Chart.yaml'), 0)
    const before = await read(`${SRC}/values.yaml`)
    const { status, data } = await save(SRC, 'new')
    expect(status).toBe(409)
    expect(data.error).toBe(`${TGT}/Chart.yaml cannot be read: permission denied`)
    expect(await read(`${SRC}/values.yaml`)).toBe(before)
  })

  it('its folder is gone: the source and the other target saved, it listed', async () => {
    await fs.rm(path.join(root, T2), { recursive: true })
    const { status, data } = await save(SRC, 'new')
    expect(status).toBe(200)
    expect(data.syncFailed).toEqual([{ target: T2, error: 'not a deployment on disk' }])
    expect(await read(`${TGT}/values.yaml`)).toBe(await read(`${SRC}/values.yaml`))
  })
})

describe('Commit never adds a temp file a write left', () => {
  it('_values.yaml.<hex>.tmp is not committed; the rest is', async () => {
    await fs.writeFile(path.join(root, SRC, '_values.yaml.0123abcd.tmp'), 'half\n')
    await fs.writeFile(path.join(root, 'marker.txt'), 'x\n')
    expect((await api('POST', '/api/v2/git/commit', { message: 'with a temp file there' })).status).toBe(200)
    const files = git('ls-files').split('\n')
    expect(files).toContain('marker.txt')
    expect(files.filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('Commit with content a write moved aside and did not put back', () => {
  it('is refused naming it and what to do; nothing is committed', async () => {
    await fs.mkdir(path.join(root, 'deployments/t/_gone.0123abcd.parked/templates'), { recursive: true })
    await fs.writeFile(path.join(root, 'deployments/t/_gone.0123abcd.parked/values.yaml'), 'kept\n')
    await fs.writeFile(path.join(root, 'marker.txt'), 'y\n')
    const head = git('rev-parse', 'HEAD')
    const { status, data } = await api('POST', '/api/v2/git/commit', { message: 'with a folder parked' })
    expect(status).toBe(409)
    expect(data.findings).toEqual([expect.objectContaining({ kind: 'parked', description: 'deployments/t/_gone.0123abcd.parked is deployments/t/gone as it was, moved aside by a write that did not finish: rename it back to deployments/t/gone to keep it, or remove it, then commit' })])
    expect(git('rev-parse', 'HEAD')).toBe(head)
    // Shown by git status, not hidden as a temp file is.
    expect(git('status', '--porcelain')).toContain('deployments/t/_gone.0123abcd.parked/')
  })
})

describe('Commit with a parked deployment that sync.yaml still names', () => {
  // A delete stopped after the folder was moved aside, before sync.yaml was written.
  const parked = 'deployments/t/_gone.0123abcd.parked'
  const said = `${parked} is deployments/t/gone as it was, moved aside by a write that did not finish: rename it back to deployments/t/gone to keep it, or remove it, then commit`
  const refusal = async () => {
    await fs.mkdir(path.join(root, parked), { recursive: true })
    await fs.writeFile(path.join(root, parked, 'values.yaml'), 'kept\n')
    const { status, data } = await api('POST', '/api/v2/git/commit', { message: 'with a folder parked' })
    expect(status).toBe(409)
    return data.findings.map(f => f.description)
  }
  it('a sync target: removing it is not enough, and the message says to unlink it too', async () => {
    await fs.writeFile(path.join(root, 'sync.yaml'), `syncs:\n  - source: ${SRC}\n    targets: [deployments/t/gone]\n`)
    expect(await refusal()).toEqual([`${said} — sync.yaml still lists deployments/t/gone as a sync target of ${SRC}: removed, unlink it too (Unlink sync), or Commit refuses that next`])
  })
  it('a sync source: the message names the targets to unlink', async () => {
    await fs.writeFile(path.join(root, 'sync.yaml'), `syncs:\n  - source: deployments/t/gone\n    targets: [${SRC}, deployments/t/other]\n`)
    expect(await refusal()).toEqual([`${said} — sync.yaml still lists deployments/t/gone as the sync source of ${SRC}, deployments/t/other: removed, unlink them too (Unlink sync), or Commit refuses that next`])
  })
  it('sync.yaml that cannot be read: the message is the plain one', async () => {
    await fs.writeFile(path.join(root, 'sync.yaml'), 'syncs: [\n')
    expect(await refusal()).toEqual([said])
  })
})

describe('a Commit with nothing but a temp file a write left', () => {
  it('is "no changes to commit", not a failed commit', async () => {
    await fs.writeFile(path.join(root, SRC, '_values.yaml.0123abcd.tmp'), 'half\n')
    const { status, data } = await api('POST', '/api/v2/git/commit', { message: 'only a temp file' })
    expect(status).toBe(400)
    expect(data.error).toBe('no changes to commit')
  })
})

describe('stress: saves at once, and beside a Commit', () => {
  it('20 rounds of two saves at once with the same version: one is written, whole, with its copies', async () => {
    for (let round = 0; round < 20; round++) {
      const v = await version(SRC)
      const answers = await Promise.all([save(SRC, `x${round}`, { version: v }), save(SRC, `y${round}`, { version: v })])
      expect(answers.map(a => a.status).sort()).toEqual([200, 409])
      const won = answers.find(a => a.status === 200) === answers[0] ? `x${round}` : `y${round}`
      const src = await read(`${SRC}/values.yaml`)
      expect(src).toContain(`job: ${won}`)
      expect(await read(`${TGT}/values.yaml`)).toBe(src)
      expect(await read(`${T2}/values.yaml`)).toBe(src)
    }
  }, 120_000)

  it('20 rounds of two saves at once without a version: each answer is a whole write, the copies follow the source', async () => {
    for (let round = 0; round < 20; round++) {
      const answers = await Promise.all([save(SRC, `x${round}`), save(SRC, `y${round}`)])
      for (const a of answers) expect([200, 409]).toContain(a.status)
      expect(answers.some(a => a.status === 200)).toBe(true)
      const src = await read(`${SRC}/values.yaml`)
      expect(src).toMatch(new RegExp(`job: (x|y)${round}\\n`))
      expect(await read(`${TGT}/values.yaml`)).toBe(src)
      expect(await read(`${T2}/values.yaml`)).toBe(src)
    }
  }, 120_000)

  it('50 rounds of a save beside a Commit: what the commit took is the save whole, or none of it', async () => {
    const files = [SRC, TGT, T2].map(d => `${d}/values.yaml`)
    for (let round = 0; round < 50; round++) {
      const before = Object.fromEntries(await Promise.all(files.map(async f => [f, await read(f)])))
      await fs.writeFile(path.join(root, 'marker.txt'), `${round}\n`)
      const [saved, committed] = await Promise.all([save(SRC, `r${round}`), api('POST', '/api/v2/git/commit', { message: `round ${round}` })])
      expect(saved.status).toBe(200)
      expect(committed.status).toBe(200)
      const after = Object.fromEntries(await Promise.all(files.map(async f => [f, await read(f)])))
      const head = Object.fromEntries(files.map(f => [f, git('show', `HEAD:${f}`)]))
      const all = state => files.every(f => head[f] === state[f])
      expect(all(before) || all(after)).toBe(true)
      // Commit everything left, so the next round starts committed.
      if (git('status', '--porcelain')) git('commit', '-qam', `rest ${round}`)
    }
  }, 300_000)
})

// A target that was not copied to is listed with why, in words: never an
// error code, a multi-line parser message, or a path of the machine.
describe('a sync target left as it is is listed with a sentence saying why', () => {
  const CHART = `${SRC}/Chart.yaml`
  const listed = async () => {
    const { status, data, text } = await save(SRC, 'new')
    expect(status).toBe(200)
    expect(text).not.toContain(work)
    expect(data.syncFailed.map(f => f.target)).toEqual([TGT, T2])
    for (const f of data.syncFailed) {
      expect(f.error).not.toMatch(/\n/)
      expect(f.error).not.toMatch(/\b(E[A-Z]{3,}|[A-Z]+_[A-Z_]+)\b/)
    }
    // The targets are as they were.
    expect(await read(`${TGT}/values.yaml`)).not.toBe(await read(`${SRC}/values.yaml`))
    return data.syncFailed[0].error
  }

  it('the source\'s Chart.yaml names no Template', async () => {
    await fs.writeFile(path.join(root, CHART), 'apiVersion: v2\nname: a\nversion: 0.1.0\n')
    expect(await listed()).toBe(`${CHART} names no Template: put its dependencies back, then save ${SRC} again`)
  })

  it('the source\'s Chart.yaml is not there', async () => {
    await fs.rm(path.join(root, CHART))
    expect(await listed()).toBe(`${CHART} is not there: restore it, then save ${SRC} again`)
  })

  it.skipIf(IS_ROOT)('the source\'s Chart.yaml cannot be read', async () => {
    await fs.chmod(path.join(root, CHART), 0)
    expect(await listed()).toBe(`${CHART} cannot be read (permission denied): once it can, save ${SRC} again`)
  })

  it('the source\'s Chart.yaml is not YAML', async () => {
    await fs.writeFile(path.join(root, CHART), 'a: [\n')
    expect(await listed()).toBe(`${CHART} is not valid YAML (unexpected end of the stream within a flow collection): fix it, then save ${SRC} again`)
  })

  it('a target that could not be checked (an error with a code and a path of the machine): words, neither', async () => {
    const { syncTargets } = await import('../../server/lib/deploymentWrite.js')
    const { openRepo } = await import('../../server/repo/openRepo.js')
    const { syncAnswer } = await import('../../server/repo/sync.js')
    const repo = openRepo(root)
    const { registry } = await syncAnswer(repo)
    const failing = { ...repo, file: async rel => { throw Object.assign(new Error(`EIO: i/o error, read '${path.join(root, rel)}'`), { code: 'EIO' }) }, with: () => failing }
    const { failed } = await syncTargets(failing, registry, SRC)
    expect(failed).toEqual([TGT, T2].map(target => ({ target, error: 'it could not be checked (the disk could not read it)' })))
  })
})
