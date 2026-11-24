// The Template side's writes as one write of the repo each: a Template's
// rules and what is made from them, its Chart.yaml, a new, cloned or
// deleted Template, a deployment's routing with its sync targets' copies,
// the shared configs with every resource made from them, and Regenerate.
// All files or none; a file that cannot be written is a 409 naming it in
// the repo, never a 5xx; a folder reached through a link is not written
// to; a file that is itself a link is replaced by the file saved. Events
// are ordered with the writer's hooks, not by timing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { hooks } from '../../server/repo/write.js'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

const CPU = (limit = 1, col = 'job') => `group: cpu\ncolumns:\n  ${col}: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${${col}}"} > ${limit}\n    labels: {severity: critical}\n`
const ROUTING = to => `labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ${to}@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n`
const SHARED_USE = 'labels:\n  severity: [critical]\nconfigs:\n  relay: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [relay]\n'
const SHARED = (port = 8080) => `configs:\n  relay: { type: webhook, url: "http://relay.example.com:${port}" }\n`
const SHARED_FILE = '_shared/notification-configs.yaml'
const CR = 'templates/alertmanagerconfig.yaml'
const A = 'deployments/t/a'
const B = 'deployments/t/b'
const C = 'deployments/t/c'
const T = 'charts/demo'
const q = f => `?folder=${encodeURIComponent(f)}`
const vals = dep => `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`
const route = dep => `/api/v2/deployments/demo/${path.basename(dep)}/routing${q(dep)}`

let server, base, work, root, errors, baseSha

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
  return { status: res.status, data, text }
}
const read = rel => fs.readFile(path.join(root, rel), 'utf-8')
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'template-writes-'))
  root = path.join(work, 'repo')
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const mounts = [['templates', 'templates'], ['charts', 'charts'], ['deployments', 'deployments'], ['folders', 'folders'], ['sync', 'sync'], ['git', 'git'], ['routing/shared', 'routingShared']]
  const routes = await Promise.all(mounts.map(([, f]) => import(`../../server/routes/${f}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  mounts.forEach(([at], i) => app.use(`/api/v2/${at}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r() }) })
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text}`); return r }
  await must(api('POST', '/api/v2/charts', { name: 'demo' }))
  await must(api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU() } }))
  await must(api('POST', '/api/v2/charts', { name: 'spare' }))
  await must(api('POST', '/api/v2/templates/spare/rules', { files: { 'cpu.yaml': CPU() } }))
  for (const d of [A, B, C]) await must(api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  for (const d of [A, B, C]) await must(api('POST', vals(d), { values: { cpu: [{ job: path.basename(d) }] } }))
  await must(api('PUT', '/api/v2/routing/shared', { shared: SHARED() }))
  await must(api('PUT', route(A), { routing: ROUTING('a') }))
  await must(api('PUT', route(C), { routing: SHARED_USE }))
  await must(api('POST', '/api/v2/sync', { source: A, target: B }))
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

// Every entry of the repo but .git, with its content.
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

// `rel`'s folder moved to a copy elsewhere in the repo, and a link to the
// copy put in its place.
async function linkFolder(rel) {
  const there = `notes/copy-of-${path.basename(rel)}`
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.cp(path.join(root, rel), path.join(root, there), { recursive: true })
  await fs.rm(path.join(root, rel), { recursive: true })
  await fs.symlink(path.relative(path.dirname(path.join(root, rel)), path.join(root, there)), path.join(root, rel))
}

describe('a Template\'s description (Chart.yaml)', () => {
  const save = description => api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description } })

  it.skipIf(IS_ROOT)('a Chart.yaml that cannot be written: 409 naming it, nothing changed', async () => {
    await fs.chmod(path.join(root, T, 'Chart.yaml'), 0o444)
    const before = await tree()
    const { status, data, text } = await save('new')
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${T}/Chart.yaml cannot be written: permission denied`, file: `${T}/Chart.yaml` })
    expect(text).not.toContain(work)
    expect(await tree()).toEqual(before)
  })

  it('the Template\'s folder is a link to another folder of the repo: 409 naming it, nothing written through it', async () => {
    await linkFolder(T)
    const before = await tree()
    const { status, data } = await save('new')
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${T}/Chart.yaml cannot be written: ${T} is a link: a folder reached through a link is not written to`, file: `${T}/Chart.yaml` })
    expect(await tree()).toEqual(before)
  })

  it('Chart.yaml changed by hand while the save waits for the lock: what was changed is kept, the description set in it', async () => {
    hooks.locked = async () => { await fs.appendFile(path.join(root, T, 'Chart.yaml'), 'keywords: [by-hand]\n') }
    const { status } = await save('new')
    expect(status).toBe(200)
    const text = await read(`${T}/Chart.yaml`)
    expect(text).toContain('description: new')
    expect(text).toContain('by-hand')
  })
})

describe('opening a Template fills in what is not there, all or none', () => {
  it.skipIf(IS_ROOT)('Chart.yaml and a product missing, the product\'s folder read-only: 409 naming it, Chart.yaml not made', async () => {
    await fs.rm(path.join(root, T, 'Chart.yaml'))
    await fs.rm(path.join(root, T, 'templates/cpu.yaml'))
    await fs.chmod(path.join(root, T, 'templates'), 0o555)
    const before = await tree()
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${T}/templates/cpu.yaml cannot be written: permission denied`, file: `${T}/templates/cpu.yaml` })
    expect(await tree()).toEqual(before)
  })

  it('both missing, nothing in the way: both written, and the Template opens', async () => {
    await fs.rm(path.join(root, T, 'Chart.yaml'))
    await fs.rm(path.join(root, T, 'templates/cpu.yaml'))
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(200)
    expect(data.drift.state).toBe('ok')
    expect(await read(`${T}/Chart.yaml`)).toContain('name: demo')
  })
})

describe('a new Template: all its files or nothing of it', () => {
  it('a folder where its values.yaml goes: 409 naming it, nothing of the new Template left', async () => {
    await fs.mkdir(path.join(root, 'charts/fresh/values.yaml'), { recursive: true })
    await fs.writeFile(path.join(root, 'charts/fresh/values.yaml/keep'), 'x\n')
    const before = await tree()
    const { status, data } = await api('POST', '/api/v2/charts', { name: 'fresh' })
    expect(status).toBe(409)
    expect(data).toEqual({ error: 'charts/fresh/values.yaml cannot be written: a folder is in its place', file: 'charts/fresh/values.yaml' })
    expect(await tree()).toEqual(before)
  })

  it.skipIf(IS_ROOT)('the Templates\' folder read-only: 409 naming the first file, no folder made', async () => {
    await fs.chmod(path.join(root, 'charts'), 0o555)
    const before = await tree()
    const { status, data } = await api('POST', '/api/v2/charts', { name: 'fresh' })
    expect(status).toBe(409)
    expect(data.file).toBe('charts/fresh/templates')
    expect(await tree()).toEqual(before)
  })
})

describe('a cloned Template: all its files or nothing of it', () => {
  it('the last file of the copy cannot be written: 409 naming it, nothing of the copy left', async () => {
    // The file system refuses the copy's schema, its last file.
    const realRename = fs.rename
    fs.rename = async function (from, to, ...rest) {
      if (String(to).endsWith(path.join('spare2', 'values.schema.json'))) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      return realRename.call(this, from, to, ...rest)
    }
    const before = await tree()
    let answer
    try { answer = await api('POST', '/api/v2/charts/spare/clone', { newName: 'spare2' }) } finally { fs.rename = realRename }
    expect(answer.status).toBe(409)
    expect(answer.data).toEqual({ error: 'charts/spare2/values.schema.json cannot be written: the disk is full', file: 'charts/spare2/values.schema.json' })
    expect(await tree()).toEqual(before)
  })

  it('the copy is the source, with its own Chart.yaml name and the source recorded in its schema', async () => {
    const { status, data } = await api('POST', '/api/v2/charts/spare/clone', { newName: 'spare2' })
    expect(status).toBe(200)
    expect(data).toEqual({ ok: true, chart: 'spare2' })
    expect(await read('charts/spare2/rules/cpu.yaml')).toBe(await read('charts/spare/rules/cpu.yaml'))
    expect(await read('charts/spare2/templates/cpu.yaml')).toBe(await read('charts/spare/templates/cpu.yaml'))
    expect(await read('charts/spare2/Chart.yaml')).toContain('name: spare2')
    expect(JSON.parse(await read('charts/spare2/values.schema.json'))['x-migrated-from']).toEqual({ chart: 'spare' })
  })
})

describe('a deleted Template: every file of it, or nothing', () => {
  it.skipIf(IS_ROOT)('a folder of it that cannot be read: 409 naming it in the repo, nothing removed', async () => {
    await fs.chmod(path.join(root, 'charts/spare/templates'), 0)
    const { status, data, text } = await api('DELETE', '/api/v2/charts/spare')
    await fs.chmod(path.join(root, 'charts/spare/templates'), 0o755)
    expect(status).toBe(409)
    expect(data).toEqual({ error: 'charts/spare/templates cannot be read (permission denied)', file: 'charts/spare/templates', unreadable: true })
    expect(text).not.toContain(work)
    expect(await read('charts/spare/Chart.yaml')).toContain('name: spare')
    expect(await read('charts/spare/templates/cpu.yaml')).toBeTruthy()
  })

  it('a removal that fails at its last step puts back every file and folder removed', async () => {
    const before = await tree()
    hooks.beforeRename = null
    // The file system refuses to move charts/spare itself aside, the last step.
    const realRename = fs.rename
    fs.rename = async function (from, to, ...rest) { if (String(from).endsWith(`${path.sep}spare`) && /_spare\.[0-9a-f]{8}\.parked$/.test(String(to))) throw Object.assign(new Error('refused'), { code: 'EACCES' }); return realRename.call(this, from, to, ...rest) }
    let answer
    try { answer = await api('DELETE', '/api/v2/charts/spare') } finally { fs.rename = realRename }
    expect(answer.status).toBe(409)
    expect(answer.data).toEqual({ error: 'charts/spare cannot be removed: permission denied', file: 'charts/spare' })
    expect(await tree()).toEqual(before)
  })

  it('the Template\'s folder is a link: 409 saying so and to remove it in git, neither the link nor what it leads to removed', async () => {
    await linkFolder('charts/spare')
    const before = await tree()
    const { status, data } = await api('DELETE', '/api/v2/charts/spare')
    expect(status).toBe(409)
    expect(data).toEqual({ error: 'charts/spare is a link made by hand: it is not deleted through the link — remove the link in git', file: 'charts/spare' })
    expect(await tree()).toEqual(before)
  })
})

describe('a Template\'s rules save', () => {
  it('a rules file changed by hand while the save waits for the lock: 409, the change kept, nothing made from the save', async () => {
    const before = await read(`${T}/templates/cpu.yaml`)
    hooks.locked = async () => { await fs.appendFile(path.join(root, T, 'rules/cpu.yaml'), '# by hand\n') }
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(2) } })
    expect(status).toBe(409)
    expect(data).toEqual({ error: 'demo: its rules changed while it was being saved: reload it to see what is there now', changed: true })
    expect(await read(`${T}/rules/cpu.yaml`)).toContain('# by hand')
    expect(await read(`${T}/templates/cpu.yaml`)).toBe(before)
  })

  it('a deployment\'s values the migration rewrites, saved while it waits: 409, the saved values kept, the Template as it was', async () => {
    // A migration that renames job → name; t/c's values are saved meanwhile.
    hooks.locked = async plan => { if (plan.kind === 'rules') await fs.writeFile(path.join(root, C, 'values.yaml'), 'demo:\n  cpu:\n    - job: c-by-hand\n') }
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(1, 'name') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'name' } } } })
    expect(status).toBe(409)
    expect(data.changed).toBe(true)
    expect(await read(`${C}/values.yaml`)).toContain('job: c-by-hand')
    expect(await read(`${T}/rules/cpu.yaml`)).toBe(CPU())
  })
})

describe('a routing save and its sync targets: all or none', () => {
  it.skipIf(IS_ROOT)('a sync target\'s resource that cannot be written: 409 naming it, the source and its own files as they were', async () => {
    await fs.chmod(path.join(root, B, CR), 0o444)
    const before = await tree()
    const { status, data, text } = await api('PUT', route(A), { routing: ROUTING('a2') })
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${B}/${CR} cannot be written: permission denied`, file: `${B}/${CR}` })
    expect(text).not.toContain(work)
    expect(await tree()).toEqual(before)
  })

  it.skipIf(IS_ROOT)('removed, a target that cannot be written: 409, nothing removed', async () => {
    await fs.chmod(path.join(root, B, 'templates'), 0o555)
    const before = await tree()
    const { status, data } = await api('DELETE', route(A))
    expect(status).toBe(409)
    expect(data.file).toBe(`${B}/${CR}`)
    expect(await tree()).toEqual(before)
  })

  it('routing.yaml changed by hand while the save waits for the lock: 409, the change kept', async () => {
    hooks.locked = async () => { await fs.appendFile(path.join(root, A, 'routing.yaml'), '# by hand\n') }
    const { status, data } = await api('PUT', route(A), { routing: ROUTING('a2') })
    expect(status).toBe(409)
    expect(data.changed).toBe(true)
    expect(await read(`${A}/routing.yaml`)).toContain('# by hand')
    expect(await read(`${B}/routing.yaml`)).toBe(ROUTING('a'))
  })

  it('saved: the source and its target get the same two files', async () => {
    const { status, data } = await api('PUT', route(A), { routing: ROUTING('a2') })
    expect(status).toBe(200)
    expect(data).toEqual({ ok: true })
    expect(await read(`${B}/routing.yaml`)).toBe(await read(`${A}/routing.yaml`))
    expect(await read(`${B}/${CR}`)).toBe(await read(`${A}/${CR}`))
  })

  it('removed: both files gone from the source and the target, and the templates/ made for them', async () => {
    const { status } = await api('DELETE', route(A))
    expect(status).toBe(200)
    for (const d of [A, B]) {
      await expect(fs.lstat(path.join(root, d, 'routing.yaml'))).rejects.toThrow()
      await expect(fs.lstat(path.join(root, d, 'templates'))).rejects.toThrow()
    }
  })
})

describe('the shared configs and every resource made from them, with their sync targets\' copies: all or none', () => {
  it.skipIf(IS_ROOT)('a sync target of a user that cannot be written: 409 naming it, the shared file and every user as they were', async () => {
    expect((await api('PUT', route(A), { routing: SHARED_USE })).status).toBe(200)
    await fs.chmod(path.join(root, B, CR), 0o444)
    const before = await tree()
    const { status, data } = await api('PUT', '/api/v2/routing/shared', { shared: SHARED(9090) })
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${B}/${CR} cannot be written: permission denied`, file: `${B}/${CR}` })
    expect(await tree()).toEqual(before)
  })

  it.skipIf(IS_ROOT)('a rename, a user\'s routing.yaml that cannot be written: 409, nothing renamed', async () => {
    await fs.chmod(path.join(root, C, 'routing.yaml'), 0o444)
    const before = await tree()
    const { status, data } = await api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay2' })
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${C}/routing.yaml cannot be written: permission denied`, file: `${C}/routing.yaml` })
    expect(await tree()).toEqual(before)
  })

  it('the shared file changed by hand while a save waits: 409, the change kept', async () => {
    hooks.locked = async () => { await fs.appendFile(path.join(root, SHARED_FILE), '# by hand\n') }
    const { status, data } = await api('PUT', '/api/v2/routing/shared', { shared: SHARED(9090) })
    expect(status).toBe(409)
    expect(data.changed).toBe(true)
    expect(await read(SHARED_FILE)).toContain('# by hand')
  })

  it('saved: a user\'s sync target gets its source\'s new resource too', async () => {
    expect((await api('PUT', route(A), { routing: SHARED_USE })).status).toBe(200)
    const { status } = await api('PUT', '/api/v2/routing/shared', { shared: SHARED(9090) })
    expect(status).toBe(200)
    expect(await read(`${A}/${CR}`)).toContain('9090')
    expect(await read(`${B}/${CR}`)).toBe(await read(`${A}/${CR}`))
  })
})

describe('Regenerate: what can be made is written all or none', () => {
  const regenerate = () => api('POST', '/api/v2/git/routing/regenerate')
  it.skipIf(IS_ROOT)('a target that cannot be written: 409 naming it, the source\'s resource not made again either', async () => {
    await fs.writeFile(path.join(root, A, 'routing.yaml'), ROUTING('by-hand'))
    await fs.chmod(path.join(root, B, CR), 0o444)
    const before = await tree()
    const { status, data } = await regenerate()
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${B}/${CR} cannot be written: permission denied`, file: `${B}/${CR}` })
    expect(await tree()).toEqual(before)
  })

  it.skipIf(IS_ROOT)('one whose routing.yaml cannot be read is listed; the others are made again', async () => {
    await fs.writeFile(path.join(root, A, 'routing.yaml'), ROUTING('by-hand'))
    await fs.chmod(path.join(root, C, 'routing.yaml'), 0)
    const { status, data } = await regenerate()
    expect(status).toBe(200)
    expect(data.regenerated).toEqual([A, B])
    expect(data.failed.map(f => f.deployment)).toContain(C)
    expect(await read(`${A}/${CR}`)).toContain('by-hand@example.com')
    expect(await read(`${B}/${CR}`)).toBe(await read(`${A}/${CR}`))
  })
})

// What a plan reads of the deployments is read through its snapshot: a
// deployment made, changed or removed between the plan and the write is
// seen under the lock, and the change is planned again.
describe('a deployment made or changed while a Template write is planned', () => {
  const once = fn => { hooks.planned = async plan => { hooks.planned = null; await fn(plan) } }

  it('deleting a Template while a deployment using it is made: refused, naming it, nothing deleted', async () => {
    once(async () => { expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/t/z', chart: 'spare' })).status).toBe(200) })
    const { status, data } = await api('DELETE', '/api/v2/charts/spare')
    expect(status).toBe(409)
    expect(data.deployments.map(d => d.path)).toEqual(['deployments/t/z'])
    expect(await read('charts/spare/Chart.yaml')).toContain('name: spare')
  })

  it('a confirmed breaking change with a migration while a deployment on the old columns is made: it is migrated too', async () => {
    once(async () => {
      expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/t/z', chart: 'demo' })).status).toBe(200)
      await fs.writeFile(path.join(root, 'deployments/t/z/values.yaml'), 'demo:\n  cpu:\n    - job: z\n')
    })
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(1, 'name') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'name' } } } })
    expect(status, JSON.stringify(data)).toBe(200)
    expect(data.migrated.map(d => d.path)).toContain('deployments/t/z')
    expect(await read('deployments/t/z/values.yaml')).toContain('name: z')
  })

  it('a breaking change on a Template no one used while a deployment using it is made: the dialog, nothing saved', async () => {
    once(async () => { expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/t/z', chart: 'spare' })).status).toBe(200) })
    const before = await read('charts/spare/rules/cpu.yaml')
    const { status, data } = await api('POST', '/api/v2/templates/spare/rules', { files: { 'cpu.yaml': CPU(1, 'name') } })
    expect(status).toBe(409)
    expect(data.error).toBe('Breaking schema change')
    expect(data.deployments.map(d => d.path)).toEqual(['deployments/t/z'])
    expect(await read('charts/spare/rules/cpu.yaml')).toBe(before)
  })
})

describe('Regenerate: a folder where a resource is to be written', () => {
  it('cannot be written: 409 naming it, nothing written — not listed with the others made', async () => {
    await fs.writeFile(path.join(root, A, 'routing.yaml'), ROUTING('by-hand'))
    await fs.rm(path.join(root, C, CR))
    await fs.mkdir(path.join(root, C, CR))
    await fs.writeFile(path.join(root, C, CR, 'keep'), 'x\n')
    const before = await tree()
    const { status, data } = await api('POST', '/api/v2/git/routing/regenerate')
    expect(status).toBe(409)
    expect(data).toEqual({ error: `${C}/${CR} cannot be written: a folder is in its place`, file: `${C}/${CR}` })
    expect(await tree()).toEqual(before)
  })
})

describe('a removal that is refused says it could not remove', () => {
  it.skipIf(IS_ROOT)('a Template file that cannot be removed: "cannot be removed", nothing removed', async () => {
    await fs.chmod(path.join(root, 'charts/spare/templates'), 0o555)
    const before = await tree()
    const { status, data } = await api('DELETE', '/api/v2/charts/spare')
    expect(status).toBe(409)
    expect(data).toEqual({ error: 'charts/spare/templates/cpu.yaml cannot be removed: permission denied', file: 'charts/spare/templates/cpu.yaml' })
    expect(await tree()).toEqual(before)
  })
})

describe('opening a Template it refuses writes nothing', () => {
  it('Chart.yaml a folder, a product missing: 409 naming Chart.yaml, the product not written', async () => {
    await fs.rm(path.join(root, T, 'Chart.yaml'))
    await fs.mkdir(path.join(root, T, 'Chart.yaml'))
    await fs.rm(path.join(root, T, 'templates/cpu.yaml'))
    const before = await tree()
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    expect(data.unreadable).toBe(true)
    expect(data.error).toContain(`${T}/Chart.yaml`)
    expect(await tree()).toEqual(before)
  })
})

describe('a deployment folder that is a link leading out of the repo', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(work, 'elsewhere'), { recursive: true })
    await fs.symlink(path.join(work, 'elsewhere'), path.join(root, 'deployments/t/out'))
  })
  it('a confirmed migration is refused naming it, nothing written', async () => {
    const before = await tree()
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(1, 'name') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'name' } } } })
    expect(status).toBe(409)
    expect(data.file).toBe('deployments/t/out')
    expect(data.error).toMatch(/^deployments\/t\/out: it is a link that leads outside the repo — a deployment behind it would be left not migrated/)
    expect(await tree()).toEqual(before)
  })
  it('a shared config rename is refused naming it, nothing written', async () => {
    const before = await tree()
    const { status, data } = await api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay2' })
    expect(status).toBe(409)
    expect(data.file).toBe('deployments/t/out')
    expect(await tree()).toEqual(before)
  })
})
