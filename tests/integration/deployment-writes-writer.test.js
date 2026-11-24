// The deployment side's writes through the one writer (server/repo/write.js):
// a sync link, a new deployment, a deployment deleted and a _common made
// or removed are written all or none — a file that cannot be written puts
// back everything written before it and answers 409 naming it; what is
// refused leaves nothing behind; a change made while the write waits for
// the lock is never written over. Events are ordered with the writer's
// hooks, never by timing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import express from 'express'
import { hooks } from '../../server/repo/write.js'

// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let server, baseURL, tmpDir, errors

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-writes-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const routers = await Promise.all(['templates', 'deployments', 'folders', 'sync'].map(r => import(`../../server/routes/${r}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  ;['templates', 'deployments', 'folders', 'sync'].forEach((r, i) => app.use(`/api/v2/${r}`, routers[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  hooks.planned = null
  hooks.locked = null
  hooks.beforeRename = null
  errors.mockRestore()
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) {
    await chmodBack(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(`${tmpDir}-outside.yaml`, { force: true })
  }
})

async function chmodBack(dir) {
  await fs.chmod(dir, 0o755).catch(() => {})
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) await chmodBack(p)
    else await fs.chmod(p, 0o644).catch(() => {})
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const exists = rel => fs.lstat(path.join(tmpDir, rel)).then(() => true, () => false)
const q = f => `?folder=${encodeURIComponent(f)}`

// Every entry of the repo: path → 'dir', 'link:<to>' or the sha of the file.
async function tree(rel = '') {
  const out = {}
  for (const e of (await fs.readdir(path.join(tmpDir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(tmpDir, p))}`
    else if (e.isDirectory()) { out[p] = 'dir'; Object.assign(out, await tree(p)) } else out[p] = createHash('sha256').update(await fs.readFile(path.join(tmpDir, p))).digest('hex').slice(0, 12)
  }
  return out
}
const tempFiles = async () => Object.keys(await tree()).filter(p => /\.tmp$/.test(p))

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const ROUTING = to => `labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ${to}@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n`
const SRC = 'deployments/team/src'
const TGT = 'deployments/team/tgt'
const save = (dep, warn) => api('POST', `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`, { values: { cpu: [{ namespace: path.basename(dep), warn }] } })
const route = dep => `/api/v2/deployments/demo/${path.basename(dep)}/routing${q(dep)}`

// The demo Template; `deps` made on it with values of their own; SRC with routing.
async function setup(deps = [SRC, TGT]) {
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const dep of deps) {
    expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)
    expect((await save(dep, 1)).status).toBe(200)
  }
  if (deps.includes(SRC)) expect((await api('PUT', route(SRC), { routing: ROUTING('src') })).status).toBe(200)
  if (deps.includes(TGT)) expect((await api('PUT', route(TGT), { routing: ROUTING('tgt') })).status).toBe(200)
}

describe.skipIf(IS_ROOT)('a sync link: all of it or none', () => {
  it('a target file that cannot be written in the middle puts back what was written before it, and names it', async () => {
    await setup()
    await fs.chmod(path.join(tmpDir, TGT, 'routing.yaml'), 0o444)
    const was = await tree()
    const res = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })
    expect(res).toEqual({ status: 409, data: { error: `${TGT}/routing.yaml cannot be written: permission denied`, file: `${TGT}/routing.yaml` } })
    expect(await tree()).toEqual(was)
  })

  it('sync.yaml that cannot be written leaves no new target behind', async () => {
    await setup([SRC])
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), 'syncs: []\n')
    await fs.chmod(path.join(tmpDir, 'sync.yaml'), 0o444)
    const was = await tree()
    const res = await api('POST', '/api/v2/sync', { source: SRC, target: 'deployments/team/new' })
    expect(res).toEqual({ status: 409, data: { error: 'sync.yaml cannot be written: permission denied', file: 'sync.yaml' } })
    expect(await tree()).toEqual(was)
    expect(await exists('deployments/team/new')).toBe(false)
  })

  it('a source saved while the link waits for the lock is copied as it is then', async () => {
    await setup()
    hooks.planned = async () => {
      hooks.planned = null
      await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'demo:\n  cpu:\n    - namespace: src\n      warn: 7\n')
    }
    expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
    expect(await read(`${TGT}/values.yaml`)).toBe(await read(`${SRC}/values.yaml`))
    expect(await read(`${TGT}/values.yaml`)).toContain('warn: 7')
  })

  it('two links to the same target at once: each whole, the last one made holds', async () => {
    await setup([SRC, TGT, 'deployments/team/other'])
    for (let round = 0; round < 20; round++) {
      const answers = await Promise.all([
        api('POST', '/api/v2/sync', { source: SRC, target: TGT }),
        api('POST', '/api/v2/sync', { source: 'deployments/team/other', target: TGT }),
      ])
      expect(answers.map(a => a.status)).toEqual([200, 200])
      const registry = (await api('GET', '/api/v2/sync')).data
      const holder = registry.syncs.find(s => s.targets.includes(TGT)).source
      expect(registry.syncs.flatMap(s => s.targets).filter(t => t === TGT)).toEqual([TGT])
      expect(await read(`${TGT}/values.yaml`)).toBe(await read(`${holder}/values.yaml`))
      expect(await tempFiles()).toEqual([])
    }
  })
})

const del = dep => api('DELETE', `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`)

describe.skipIf(IS_ROOT)('a deployment deleted: all of it or none', () => {
  it('sync.yaml that cannot be written leaves the deployment as it was', async () => {
    await setup()
    expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
    const was = await tree()
    await fs.chmod(tmpDir, 0o555)
    let res
    try {
      res = await del(SRC)
    } finally {
      await fs.chmod(tmpDir, 0o755)
    }
    expect(res).toEqual({ status: 409, data: { error: 'sync.yaml cannot be written: permission denied', file: 'sync.yaml' } })
    expect(await tree()).toEqual(was)
  })

  // What is in it is not read to remove it: a broken deployment can be
  // deleted from the page.
  it.each([
    ['a read-only folder', async () => fs.chmod(path.join(tmpDir, TGT, 'templates'), 0o555)],
    ['a file that cannot be read', async () => fs.chmod(path.join(tmpDir, TGT, 'values.yaml'), 0)],
    ['a read-only file', async () => fs.chmod(path.join(tmpDir, TGT, 'values.yaml'), 0o444)],
    ['a pipe', async () => execFileSync('mkfifo', [path.join(tmpDir, TGT, 'notes.fifo')])],
    ['a values.yaml that is a link leading outside the repo', async () => {
      const outside = `${tmpDir}-outside.yaml`
      await fs.writeFile(outside, 'outside\n')
      await fs.rm(path.join(tmpDir, TGT, 'values.yaml'))
      await fs.symlink(outside, path.join(tmpDir, TGT, 'values.yaml'))
    }],
    ['a values.yaml that is a link to nothing', async () => {
      await fs.rm(path.join(tmpDir, TGT, 'values.yaml'))
      await fs.symlink('nowhere.yaml', path.join(tmpDir, TGT, 'values.yaml'))
    }],
  ])('one with %s in it is deleted whole, nothing left beside it', async (_, make) => {
    await setup()
    await make()
    expect(await del(TGT)).toEqual({ status: 200, data: { ok: true } })
    expect(await exists(TGT)).toBe(false)
    expect((await fs.readdir(path.join(tmpDir, 'deployments/team'))).sort()).toEqual(['src'])
  })

  it('a file added while it waits for the lock goes with the rest', async () => {
    await setup()
    hooks.planned = async () => {
      hooks.planned = null
      await fs.writeFile(path.join(tmpDir, TGT, 'notes.txt'), 'added\n')
    }
    expect(await del(TGT)).toEqual({ status: 200, data: { ok: true } })
    expect(await exists(TGT)).toBe(false)
  })
})

const init = (folder, chart = 'demo') => api('POST', '/api/v2/folders/init', { folder, chart })

describe.skipIf(IS_ROOT)('a new deployment: both files or neither', () => {
  it('a Chart.yaml there that cannot be written is named, and nothing is written', async () => {
    await setup([])
    const NEW = 'deployments/team/n'
    await fs.mkdir(path.join(tmpDir, NEW), { recursive: true })
    await fs.writeFile(path.join(tmpDir, NEW, 'Chart.yaml'), 'apiVersion: v2\nname: n\nversion: 0.1.0\n')
    await fs.chmod(path.join(tmpDir, NEW, 'Chart.yaml'), 0o444)
    const was = await tree()
    expect(await init(NEW)).toEqual({ status: 409, data: { error: `${NEW}/Chart.yaml cannot be written: permission denied`, file: `${NEW}/Chart.yaml` } })
    expect(await tree()).toEqual(was)
  })

  it('a values.yaml that cannot be written after its Chart.yaml leaves no folder behind', async () => {
    await setup([])
    const NEW = 'deployments/fresh/n'
    hooks.beforeRename = async rel => {
      if (rel === `${NEW}/values.yaml`) throw Object.assign(new Error('stopped'), { code: 'EACCES' })
    }
    const was = await tree()
    expect(await init(NEW)).toEqual({ status: 409, data: { error: `${NEW}/values.yaml cannot be written: permission denied`, file: `${NEW}/values.yaml` } })
    expect(await tree()).toEqual(was)
    expect(await exists('deployments/fresh')).toBe(false)
  })

  it('a deployment made there while it waits for the lock is not written over', async () => {
    await setup([SRC])
    const NEW = 'deployments/team/n'
    hooks.planned = async () => {
      hooks.planned = null
      await fs.mkdir(path.join(tmpDir, NEW), { recursive: true })
      await fs.copyFile(path.join(tmpDir, SRC, 'Chart.yaml'), path.join(tmpDir, NEW, 'Chart.yaml'))
      await fs.writeFile(path.join(tmpDir, NEW, 'values.yaml'), 'demo:\n  cpu:\n    - namespace: mine\n')
    }
    expect(await init(NEW)).toEqual({ status: 200, data: { status: 'existing', chart: 'demo' } })
    expect(await read(`${NEW}/values.yaml`)).toBe('demo:\n  cpu:\n    - namespace: mine\n')
  })
})

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version', '--short'], { stdio: 'ignore' }); return true } catch { return false } })()
const U = 'deployments/u'
const commonPlan = query => api('GET', `/api/v2/folders/common/plan?${query}`)
// Made as the page makes it: the plan shown first, its expected sent back.
const makeCommon = async () => api('POST', '/api/v2/folders/common', { action: 'create', folder: U, chart: 'demo', expected: (await commonPlan(`folder=${U}&chart=demo`)).data.expected })

describe.skipIf(!HAS_HELM)('a _common plan checked with Helm writes nothing into the repo', { timeout: 60000 }, () => {
  it('no Chart.lock or charts/*.tgz is left by the plan, nor by a refused write', async () => {
    await setup([`${U}/p`, `${U}/q`])
    const was = await tree()
    const shown = await commonPlan(`folder=${U}&chart=demo`)
    expect(shown.status).toBe(200)
    expect(shown.data.checkedWith).toBe('helm')
    expect(await tree()).toEqual(was)
    await fs.writeFile(path.join(tmpDir, U, 'p/values.yaml'), 'demo:\n  cpu:\n    - namespace: changed\n')
    const changed = await tree()
    const stale = await api('POST', '/api/v2/folders/common', { action: 'create', folder: U, chart: 'demo', expected: shown.data.expected })
    expect(stale.status).toBe(409)
    expect(await tree()).toEqual(changed)
  })
})

describe.skipIf(IS_ROOT)('a _common made or removed: all of it or none', () => {
  it('a deployment that cannot be rewritten after the _common is made takes the _common back too', async () => {
    await setup([`${U}/p`, `${U}/q`])
    await fs.chmod(path.join(tmpDir, U, 'q/values.yaml'), 0o444)
    const was = await tree()
    const res = await makeCommon()
    expect(res).toEqual({ status: 409, data: { error: `${U}/q/values.yaml cannot be written: permission denied`, file: `${U}/q/values.yaml` } })
    expect(await tree()).toEqual(was)
  })

  it('a _common folder that cannot be removed puts back the deployments rewritten before it', async () => {
    await setup([`${U}/p`])
    expect((await makeCommon()).status).toBe(200)
    // In block YAML: what it gives can be moved down when it is removed.
    await fs.writeFile(path.join(tmpDir, U, '_common/demo/values.yaml'), 'demo:\n  cpu:\n    - namespace: layer\n')
    await fs.chmod(path.join(tmpDir, U, '_common'), 0o555)
    const was = await tree()
    const res = await api('POST', '/api/v2/folders/common', { action: 'delete', path: `${U}/_common/demo`, expected: (await commonPlan(`action=delete&path=${U}/_common/demo`)).data.expected })
    expect(res.status).toBe(409)
    expect(res.data.file).toBe(`${U}/_common/demo`)
    await fs.chmod(path.join(tmpDir, U, '_common'), 0o755)
    expect(await tree()).toEqual(was)
  })

  it('a values save in the folder while the _common waits for the lock refuses it, with the plan as it is now', async () => {
    await setup([`${U}/p`])
    const shown = await commonPlan(`folder=${U}&chart=demo`)
    hooks.planned = async () => {
      hooks.planned = null
      expect((await save(`${U}/p`, 7)).status).toBe(200)
    }
    const res = await api('POST', '/api/v2/folders/common', { action: 'create', folder: U, chart: 'demo', expected: shown.data.expected })
    expect(res.status).toBe(409)
    expect(res.data.plan.common).toBe(`${U}/_common/demo`)
    expect(await exists(`${U}/_common`)).toBe(false)
    expect(await read(`${U}/p/values.yaml`)).toContain('warn: 7')
  })
})


describe.skipIf(IS_ROOT)('what a plan reads besides the files it writes is held to the repo as it is under the lock', () => {
  it('a Template file that cannot be read, added while a new deployment waits, refuses it', async () => {
    await setup([SRC])
    const NEW = 'deployments/team/n'
    hooks.planned = async () => {
      hooks.planned = null
      await fs.writeFile(path.join(tmpDir, 'charts/demo/templates/hand.yaml'), 'x: 1\n')
      await fs.chmod(path.join(tmpDir, 'charts/demo/templates/hand.yaml'), 0)
    }
    const res = await init(NEW)
    await fs.chmod(path.join(tmpDir, 'charts/demo/templates/hand.yaml'), 0o644)
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.data)).toContain('charts/demo/templates/hand.yaml')
    expect(await exists(NEW)).toBe(false)
  })

  it('a _common\'s link that leads elsewhere by the time it is removed refuses the removal', async () => {
    await setup([`${U}/p`])
    expect((await makeCommon()).status).toBe(200)
    await fs.writeFile(path.join(tmpDir, U, '_common/demo/values.yaml'), 'demo:\n  cpu:\n    - namespace: layer\n')
    const shown = await commonPlan(`action=delete&path=${U}/_common/demo`)
    expect(shown.status).toBe(200)
    await fs.mkdir(path.join(tmpDir, 'charts/elsewhere'), { recursive: true })
    hooks.planned = async () => {
      hooks.planned = null
      const link = path.join(tmpDir, U, '_common/demo/charts/demo')
      await fs.rm(link)
      await fs.symlink('../../../../../charts/elsewhere', link)
    }
    const res = await api('POST', '/api/v2/folders/common', { action: 'delete', path: `${U}/_common/demo`, expected: shown.data.expected })
    expect(res.status).toBe(409)
    expect(res.data.error).toMatch(/changed since the list was made/)
    expect(await exists(`${U}/_common/demo/Chart.yaml`)).toBe(true)
  })
})

describe('a _common made on a Template with no group in its values', () => {
  it('can be removed again, giving back the deployments\' files as they were', async () => {
    await setup([`${U}/p`])
    await fs.writeFile(path.join(tmpDir, 'charts/demo/values.yaml'), '{}\n')
    const before = { chart: await read(`${U}/p/Chart.yaml`), values: await read(`${U}/p/values.yaml`) }
    expect((await makeCommon()).status).toBe(200)
    const drop = await commonPlan(`action=delete&path=${U}/_common/demo`)
    expect(drop.status, JSON.stringify(drop.data)).toBe(200)
    expect((await api('POST', '/api/v2/folders/common', { action: 'delete', path: `${U}/_common/demo`, expected: drop.data.expected })).status).toBe(200)
    expect({ chart: await read(`${U}/p/Chart.yaml`), values: await read(`${U}/p/values.yaml`) }).toEqual(before)
  })
})

// A deployment folder swapped for a link to another deployment while the
// delete waits: refused, and no file of the other deployment is touched,
// at any moment.
describe.skipIf(IS_ROOT)('deleting a deployment whose folder became a link to another', () => {
  it.each(['planned', 'locked'])('swapped at %s: refused, the other deployment never touched', async point => {
    await setup()
    const other = path.join(tmpDir, SRC)
    const calls = []
    const plain = { rm: fs.rm, rmdir: fs.rmdir, rename: fs.rename, unlink: fs.unlink }
    const spies = Object.keys(plain).map(n => vi.spyOn(fs, n).mockImplementation(async (...a) => {
      if (String(a[0]).startsWith(other) || String(a[1] ?? '').startsWith(other)) calls.push(`${n} ${path.relative(tmpDir, String(a[0]))}`)
      return plain[n].apply(fs, a)
    }))
    const before = await tree(SRC)
    hooks[point] = async () => {
      hooks[point] = null
      await plain.rename(path.join(tmpDir, TGT), path.join(tmpDir, `${TGT}.parked`))
      await fs.symlink(other, path.join(tmpDir, TGT))
    }
    let res
    try {
      res = await del(TGT)
    } finally {
      for (const s of spies) s.mockRestore()
      await plain.rm(path.join(tmpDir, TGT))
      await plain.rename(path.join(tmpDir, `${TGT}.parked`), path.join(tmpDir, TGT))
    }
    expect(res.status).toBe(400)
    expect(res.data.error).toMatch(/link/)
    expect(calls).toEqual([])
    expect(await tree(SRC)).toEqual(before)
  })
})

// The order a change is written in decides what a server killed midway
// leaves: for a sync link, sync.yaml first — a target listed and not yet
// its source's copy is what Commit refuses.
describe('a sync link to a target whose templates/ is a link made by hand', () => {
  it('is refused naming the link, as a routing save to it is: nothing is written through it', async () => {
    await setup()
    // TGT/templates → notes/tpl, a folder of the repo holding what it held.
    await fs.mkdir(path.join(tmpDir, 'notes'), { recursive: true })
    await fs.rename(path.join(tmpDir, TGT, 'templates'), path.join(tmpDir, 'notes/tpl'))
    await fs.symlink('../../../notes/tpl', path.join(tmpDir, TGT, 'templates'))
    const was = await tree()
    const res = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })
    expect(res.status).toBe(409)
    expect(res.data).toEqual({ error: `${TGT}/templates/alertmanagerconfig.yaml cannot be written: ${TGT}/templates is a link: a folder reached through a link is not written to`, file: `${TGT}/templates/alertmanagerconfig.yaml` })
    expect(await tree()).toEqual(was)
    // The routing save of a deployment whose templates/ is such a link says the same.
    const saved = await api('PUT', route(TGT), { routing: ROUTING('other') })
    expect(saved.status).toBe(409)
    expect(saved.data.error).toBe(res.data.error)
    expect(await tree()).toEqual(was)
  })
})

describe('a sync link writes sync.yaml first', () => {
  it('to an existing target and to a new one', async () => {
    await setup()
    const { planChange } = await import('../../server/repo/changes/index.js')
    const { openRepo } = await import('../../server/repo/openRepo.js')
    for (const target of [TGT, 'deployments/team/new']) {
      const plan = await planChange(openRepo(tmpDir), { kind: 'sync-link', source: SRC, target })
      expect(plan.refusal).toBeNull()
      expect(plan.files[0].rel).toBe('sync.yaml')
      expect(plan.files.length).toBeGreaterThan(1)
    }
  })
})

// The plan's check renders in a copy of a few folders of the repo: a link
// there that leads outside the repo leads nowhere in the copy, so neither
// the check's writes nor Helm's Chart.lock and charts/*.tgz land outside —
// a deployment folder swapped for such a link just as the copy is made
// included (the moment the copy's folder is made, by a hook on it).
describe.skipIf(!HAS_HELM)('a _common plan beside a link that leads outside the repo', { timeout: 60000 }, () => {
  it('changes nothing outside the repo', async () => {
    await setup([`${U}/p`, `${U}/q`])
    const outside = `${tmpDir}-outside`
    await fs.cp(path.join(tmpDir, U, 'p'), outside, { recursive: true })
    await fs.writeFile(path.join(outside, 'SENTINEL'), 'outside data\n')
    const listing = async () => Object.fromEntries(await Promise.all((await fs.readdir(outside, { recursive: true })).sort().map(async f => [f, await fs.readFile(path.join(outside, f), 'utf-8').catch(() => 'dir')])))
    const before = await listing()
    const fsSync = (await import('fs')).default
    const mkdtemp = fsSync.mkdtempSync
    let swapped = false
    const spy = vi.spyOn(fsSync, 'mkdtempSync').mockImplementation((prefix, ...rest) => {
      const made = mkdtemp.call(fsSync, prefix, ...rest)
      if (!swapped && /alertforge-copy-|check-repo-/.test(String(prefix))) {
        swapped = true
        fsSync.renameSync(path.join(tmpDir, U, 'p'), path.join(tmpDir, U, 'p.parked'))
        fsSync.symlinkSync(outside, path.join(tmpDir, U, 'p'))
      }
      return made
    })
    try {
      await commonPlan(`folder=${U}&chart=demo`)
      expect(swapped).toBe(true)
      expect(await listing()).toEqual(before)
    } finally {
      spy.mockRestore()
      await fs.rm(path.join(tmpDir, U, 'p'), { force: true })
      await fs.rename(path.join(tmpDir, U, 'p.parked'), path.join(tmpDir, U, 'p')).catch(() => {})
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
