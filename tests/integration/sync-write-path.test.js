// The one write path for a deployment's values and its sync targets (#180):
// what a save would refuse is not copied by POST /sync, a target that cannot
// be written is reported instead of swallowed, a hand-edited sync.yaml does
// not take every save down, and a save racing a sync link leaves the target
// a copy of its source.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'

// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let server, baseURL, tmpDir, errors

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-write-path-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  errors.mockRestore()
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) {
    // Undo the chmods, or the folder cannot be removed.
    for (const rel of [TGT, `${TGT}/templates`, `${TGT}/values.yaml`]) {
      await fs.chmod(path.join(tmpDir, rel), 0o755).catch(() => {})
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const exists = rel => fs.access(path.join(tmpDir, rel)).then(() => true, () => false)
const q = f => `?folder=${encodeURIComponent(f)}`

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const SRC = 'deployments/team/src'
const TGT = 'deployments/team/tgt'
const T2 = 'deployments/team/t2'
const saveSrc = warn => api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p', warn }] } })
const routingFixture = () => fs.readFile(path.resolve('tests/fixtures/routing/basic/routing.yaml'), 'utf-8')

// A source on the demo Template; `targets` are made and synced to it.
async function setup(targets = [TGT]) {
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const dep of [SRC, ...targets]) {
    expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)
  }
  expect((await saveSrc(90)).status).toBe(200)
  for (const t of targets) expect((await api('POST', '/api/v2/sync', { source: SRC, target: t })).status).toBe(200)
}

describe('POST /sync refuses a source a values save would refuse', () => {
  it.each([
    ['a required value is missing', 'demo:\n  cpu:\n    - warn: 90\n', 'Some values cannot be rendered'],
    ['values.yaml is not YAML', 'demo:\n  cpu: [\n', 'values.yaml is not valid YAML'],
  ])('when %s, and the target is left as it was', async (_, text, error) => {
    await setup([])
    expect((await api('POST', '/api/v2/folders/init', { folder: TGT, chart: 'demo' })).status).toBe(200)
    const before = await read(`${TGT}/values.yaml`)
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), text)

    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })

    expect(status).toBe(400)
    expect(data.error).toBe(`${SRC} cannot be synced: ${error}`)
    expect(data.problems.length).toBeGreaterThan(0)
    expect(await read(`${TGT}/values.yaml`)).toBe(before)
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [] })
  })

  // A source nobody has filled in yet: a required Common Value is empty.
  it('when a required Common Value is not filled in', async () => {
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: {
      '_common.yaml': 'columns:\n  owner: {type: string, required: true}\n',
      'cpu.yaml': CPU,
      'watchdog.yaml': 'once: true\nrules:\n  - alert: Watchdog\n    expr: vector(1)\n    labels: {owner: "${owner}"}\n',
    } })).status).toBe(200)
    expect((await api('POST', '/api/v2/folders/init', { folder: SRC, chart: 'demo' })).status).toBe(200)

    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })

    expect(status).toBe(400)
    expect(data.error).toBe(`${SRC} cannot be synced: Some values cannot be rendered`)
    expect(data.problems.map(p => p.message).join(' ')).toContain('owner')
    expect(await exists(TGT)).toBe(false)
  })

  // A `git pull` between the check and the copy must not reach the target
  // with text that was never checked.
  it('copies the values.yaml it checked, not a later read of it', async () => {
    await setup([])
    expect((await api('POST', '/api/v2/folders/init', { folder: TGT, chart: 'demo' })).status).toBe(200)
    const checked = await read(`${SRC}/values.yaml`)
    const readFile = fs.readFile.bind(fs)
    let reads = 0
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...rest) => {
      if (String(file) === path.join(tmpDir, SRC, 'values.yaml') && reads++ > 0) return 'demo:\n  cpu:\n    - warn: 1\n'
      return readFile(file, ...rest)
    })
    try {
      expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
    } finally {
      spy.mockRestore()
    }
    expect(await read(`${TGT}/values.yaml`)).toBe(checked)
  })

  it('says which cell, for a required value', async () => {
    await setup([])
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'demo:\n  cpu:\n    - warn: 90\n')
    const { data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })
    expect(data.problems).toEqual([expect.objectContaining({ group: 'cpu', row: 0, column: 'namespace' })])
  })
})

describe('POST /sync checks the source\'s routing (#166)', () => {
  const CR = 'templates/alertmanagerconfig.yaml'
  const putRouting = async text => expect((await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: text })).status).toBe(200)
  const fresh = async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: TGT, chart: 'demo' })).status).toBe(200)
    return { values: await read(`${TGT}/values.yaml`), routing: await exists(`${TGT}/routing.yaml`) }
  }

  it.each([
    ['not YAML', 'labels: [\n'],
    ['empty', ''],
    ['failing a save check', 'labels:\n  env: [prod, prod]\n'],
  ])('a routing.yaml that is %s refuses the whole sync, and the target is left as it was', async (_, broken) => {
    await setup([])
    await putRouting(await routingFixture())
    await fs.writeFile(path.join(tmpDir, SRC, 'routing.yaml'), broken)
    const before = await fresh()

    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })

    expect(status).toBe(400)
    expect(data.error).toBe(`${SRC} cannot be synced: its routing.yaml has problems`)
    expect(data.problems.length).toBeGreaterThan(0)
    expect({ values: await read(`${TGT}/values.yaml`), routing: await exists(`${TGT}/routing.yaml`) }).toEqual(before)
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [] })
  })

  it('a resource behind its routing.yaml is made again, not copied', async () => {
    await setup([])
    const routing = await routingFixture()
    await putRouting(routing)
    const made = await read(`${SRC}/${CR}`)
    // routing.yaml edited by hand, the resource not regenerated.
    const edited = routing.replace('4h', '6h')
    expect(edited).not.toBe(routing)
    await fs.writeFile(path.join(tmpDir, SRC, 'routing.yaml'), edited)

    expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)

    expect(await read(`${TGT}/routing.yaml`)).toBe(edited)
    const copied = await read(`${TGT}/${CR}`)
    expect(copied).not.toBe(made)
    // What a save of that routing.yaml makes (read before the save, which
    // copies to the target too).
    await putRouting(edited)
    expect(copied).toBe(await read(`${SRC}/${CR}`))
  })

  it('a resource edited by hand is made again from routing.yaml, not copied', async () => {
    await setup([])
    await putRouting(await routingFixture())
    const made = await read(`${SRC}/${CR}`)
    await fs.writeFile(path.join(tmpDir, SRC, CR), `# edited by hand\n${made}`)

    expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
    expect(await read(`${TGT}/${CR}`)).toBe(made)
  })

  it('a resource without a routing.yaml refuses the sync', async () => {
    await setup([])
    await putRouting(await routingFixture())
    await fs.rm(path.join(tmpDir, SRC, 'routing.yaml'))
    const before = await fresh()

    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })

    expect(status).toBe(400)
    expect(data.problems).toEqual([{ message: expect.stringContaining('without a routing.yaml') }])
    expect({ values: await read(`${TGT}/values.yaml`), routing: await exists(`${TGT}/routing.yaml`) }).toEqual(before)
    expect(await exists(`${TGT}/${CR}`)).toBe(false)
  })

  it('broken values and broken routing are both listed', async () => {
    await setup([])
    await putRouting(await routingFixture())
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'demo:\n  cpu: [\n')
    await fs.writeFile(path.join(tmpDir, SRC, 'routing.yaml'), 'labels: [\n')

    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })

    expect(status).toBe(400)
    expect(data.error).toBe(`${SRC} cannot be synced: values.yaml is not valid YAML; its routing.yaml has problems`)
    expect(data.problems.map(p => p.message)).toEqual([expect.any(String), expect.stringContaining('routing.yaml is not valid YAML')])
  })

  it('a target that has routing of its own keeps it, byte for byte, when the sync is refused', async () => {
    await setup([])
    const routing = await routingFixture()
    await putRouting(routing)
    expect((await api('POST', '/api/v2/folders/init', { folder: TGT, chart: 'demo' })).status).toBe(200)
    expect((await api('PUT', `/api/v2/deployments/demo/tgt/routing${q(TGT)}`, { routing: routing.replace('4h', '8h') })).status).toBe(200)
    const before = { routing: await read(`${TGT}/routing.yaml`), cr: await read(`${TGT}/${CR}`), values: await read(`${TGT}/values.yaml`) }
    await fs.writeFile(path.join(tmpDir, SRC, 'routing.yaml'), 'labels: [\n')

    expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(400)
    expect({ routing: await read(`${TGT}/routing.yaml`), cr: await read(`${TGT}/${CR}`), values: await read(`${TGT}/values.yaml`) }).toEqual(before)
  })

  it('a resource that is missing is made', async () => {
    await setup([])
    await putRouting(await routingFixture())
    const made = await read(`${SRC}/${CR}`)
    await fs.rm(path.join(tmpDir, SRC, CR))

    expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
    expect(await read(`${TGT}/${CR}`)).toBe(made)
  })

  it('a source without routing syncs as before', async () => {
    await setup([])
    expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
    expect(await exists(`${TGT}/routing.yaml`)).toBe(false)
  })
})

describe('POST /sync checks a source whose Chart.yaml dependency has no name', () => {
  it('refuses its values.yaml when it is not YAML', async () => {
    await setup([])
    const chart = path.join(tmpDir, SRC, 'Chart.yaml')
    const doc = yaml.load(await fs.readFile(chart, 'utf-8'))
    delete doc.dependencies[0].name
    await fs.writeFile(chart, yaml.dump(doc))
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'cpu: [\n')
    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })
    expect(status).toBe(400)
    expect(data.error).toBe(`${SRC} cannot be synced: values.yaml is not valid YAML`)
    expect(await exists(TGT)).toBe(false)
  })
})

describe('a values save refuses text that is not YAML', () => {
  it('and leaves values.yaml as it was', async () => {
    await setup([])
    const before = await read(`${SRC}/values.yaml`)
    const { status, data } = await api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: 'demo:\n  cpu: [\n' })
    expect(status).toBe(400)
    expect(data.error).toBe('values.yaml is not valid YAML')
    expect(await read(`${SRC}/values.yaml`)).toBe(before)
  })
})

describe.skipIf(IS_ROOT)('a target that cannot be written is reported, and the source is saved', () => {
  it('saving the values', async () => {
    await setup([TGT, T2])
    await fs.chmod(path.join(tmpDir, TGT, 'values.yaml'), 0o444)

    const { status, data } = await saveSrc(50)

    expect(status).toBe(200)
    expect(data).toEqual({ ok: true, syncFailed: [{ target: TGT, error: 'EACCES' }] })
    expect(await read(`${SRC}/values.yaml`)).toContain('warn: 50')
    expect(await read(`${T2}/values.yaml`)).toBe(await read(`${SRC}/values.yaml`))
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`could not be copied to ${TGT}`), expect.anything())
  })

  it.each([
    ['saving the routing', async () => api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: await routingFixture() })],
    ['deleting the routing', () => api('DELETE', `/api/v2/deployments/demo/src/routing${q(SRC)}`)],
  ])('%s', async (_, act) => {
    await setup()
    expect((await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: (await routingFixture()).replace('4h', '3h') })).status).toBe(200)
    const before = await read(`${TGT}/routing.yaml`)
    await fs.chmod(path.join(tmpDir, TGT, 'templates'), 0o555)
    await fs.chmod(path.join(tmpDir, TGT), 0o555)

    const { status, data } = await act()

    expect(status).toBe(200)
    expect(data).toEqual({ ok: true, syncFailed: [{ target: TGT, error: 'EACCES' }] })
    expect(await read(`${SRC}/routing.yaml`).catch(() => null)).not.toBe(before)
    expect(await read(`${TGT}/routing.yaml`)).toBe(before)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`could not be copied to ${TGT}`), expect.anything())
  })
})

describe('a hand-edited sync.yaml', () => {
  it('an entry without a targets list does not stop saves', async () => {
    await setup([])
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [{ source: 'deployments/team/other' }] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await saveSrc(60)).toEqual({ status: 200, data: { ok: true } })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping an entry'), expect.anything())
    } finally {
      warn.mockRestore()
    }
  })

  // js-yaml keeps an alias that refers to its own anchor, so the rejected
  // entry cannot be turned into JSON.
  it('an entry that refers to itself does not stop saves or the sync list', async () => {
    await setup()
    const registry = await read('sync.yaml')
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `${registry}  - &bad {unexpected: *bad}\n`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await saveSrc(60)).toEqual({ status: 200, data: { ok: true } })
      expect(await read(`${TGT}/values.yaml`)).toBe(await read(`${SRC}/values.yaml`))
      expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [{ source: SRC, targets: [TGT] }] })
    } finally {
      warn.mockRestore()
    }
  })

  it('a target that is not a path is skipped, and the others are still copied to', async () => {
    await setup([TGT, T2])
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `syncs:
  - source: ${SRC}
    targets:
      - {toString: null}
      - &self {self: *self}
      - ${TGT}
      - ${T2}
`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await saveSrc(60)).toEqual({ status: 200, data: { ok: true } })
      for (const t of [TGT, T2]) expect(await read(`${t}/values.yaml`)).toBe(await read(`${SRC}/values.yaml`))
      expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [{ source: SRC, targets: [TGT, T2] }] })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping 2 target(s) that are not a path'))
    } finally {
      warn.mockRestore()
    }
  })

  it('a folder without a Chart.yaml is reported, and nothing is written into it', async () => {
    await setup([])
    const bare = 'deployments/team/bare'
    await fs.mkdir(path.join(tmpDir, bare), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [{ source: SRC, targets: [bare] }] }))
    expect((await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: await routingFixture() })).status).toBe(200)

    const saved = await saveSrc(60)
    const removed = await api('DELETE', `/api/v2/deployments/demo/src/routing${q(SRC)}`)

    for (const { status, data } of [saved, removed]) {
      expect(status).toBe(200)
      expect(data.syncFailed).toEqual([{ target: bare, error: 'not a deployment on disk' }])
    }
    expect(await fs.readdir(path.join(tmpDir, bare))).toEqual([])
  })

  it('a source hand-listed as its own target stays read-only, as before', async () => {
    await setup()
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [{ source: SRC, targets: [TGT, TGT, SRC] }] }))
    // Hand-edited so that the source is also a target: its own save is refused
    // as read-only before any copy, as it was before this change.
    expect((await saveSrc(60)).status).toBe(409)
  })

  it('a target that is not a deployment on disk is reported, not created', async () => {
    await setup([])
    const ghost = 'deployments/team/ghost'
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [{ source: SRC, targets: [ghost] }] }))

    const saved = await saveSrc(60)
    const routed = await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: await routingFixture() })

    for (const { status, data } of [saved, routed]) {
      expect(status).toBe(200)
      expect(data.syncFailed).toEqual([{ target: ghost, error: 'not a deployment on disk' }])
    }
    expect(await exists(ghost)).toBe(false)
  })
})

describe('deleting a sync source', () => {
  const del = f => api('DELETE', `/api/v2/deployments/demo/${f.split('/').pop()}${q(f)}`)

  it('lets go of its targets: they keep what they have and can be saved again', async () => {
    await setup([TGT, T2])
    const copied = await read(`${TGT}/values.yaml`)

    expect(await del(SRC)).toEqual({ status: 200, data: { ok: true, unlinked: [TGT, T2] } })

    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [] })
    expect(await read(`${TGT}/values.yaml`)).toBe(copied)
    expect((await api('POST', `/api/v2/deployments/demo/tgt${q(TGT)}`, { values: { cpu: [{ namespace: 'own', warn: 1 }] } })).status).toBe(200)
    expect((await api('PUT', `/api/v2/deployments/demo/tgt/routing${q(TGT)}`, { routing: await routingFixture() })).status).toBe(200)
  })

  it('a hand-edited sync.yaml listing it twice, or also as a target, is cleared of it', async () => {
    await setup([TGT, T2])
    const other = 'deployments/team/other'
    expect((await api('POST', '/api/v2/folders/init', { folder: other, chart: 'demo' })).status).toBe(200)
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [
      { source: SRC, targets: [TGT] },
      { source: SRC, targets: [T2, TGT] },
      { source: other, targets: [SRC] },
    ] }))

    expect(await del(SRC)).toEqual({ status: 200, data: { ok: true, unlinked: [TGT, T2] } })
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [] })
  })

  // The folder query is not always spelled as sync.yaml spells it.
  it.each([`${SRC}/`, SRC.replace('team/', 'team/./'), SRC.replace('team/', 'team//')])('the folder spelled %s still lets go of its targets', async folder => {
    await setup()
    expect(await api('DELETE', `/api/v2/deployments/demo/src${q(folder)}`)).toEqual({ status: 200, data: { ok: true, unlinked: [TGT] } })
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [] })
  })

  it.each([`${TGT}/`, TGT.replace('team/', 'team/./')])('a target spelled %s is still read-only', async folder => {
    await setup()
    expect((await api('POST', `/api/v2/deployments/demo/tgt${q(folder)}`, { values: { cpu: [{ namespace: 'x', warn: 1 }] } })).status).toBe(409)
    expect((await api('PUT', `/api/v2/deployments/demo/tgt/routing${q(folder)}`, { routing: await routingFixture() })).status).toBe(409)
  })

  it('only targets that are let go are listed, and other sync links stay', async () => {
    await setup([TGT, T2])
    const other = 'deployments/team/other'
    const ghost = 'deployments/team/ghost'
    expect((await api('POST', '/api/v2/folders/init', { folder: other, chart: 'demo' })).status).toBe(200)
    // A hand edit: T2 also listed under another source, and a target not on disk.
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [
      { source: SRC, targets: [TGT, T2, ghost] },
      { source: other, targets: [T2] },
    ] }))
    expect(await del(SRC)).toEqual({ status: 200, data: { ok: true, unlinked: [TGT] } })
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [{ source: other, targets: [T2] }] })
  })

  // The folder cannot be removed: nothing is let go, as nothing was deleted.
  it.skipIf(IS_ROOT)('a source that cannot be removed keeps its sync links', async () => {
    await setup()
    const parent = path.join(tmpDir, 'deployments/team')
    await fs.chmod(parent, 0o555)
    try {
      expect((await del(SRC)).status).toBe(500)
    } finally {
      await fs.chmod(parent, 0o755)
    }
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [{ source: SRC, targets: [TGT] }] })
  })

  it('a deployment that is no source says nothing was let go', async () => {
    await setup([])
    expect(await del(SRC)).toEqual({ status: 200, data: { ok: true } })
  })
})

describe('saves racing sync changes leave the target a copy of its source', () => {
  it('a values save at the same time as a new sync link', async () => {
    await setup([])
    let behind = 0
    for (let i = 0; i < 20; i++) {
      const t = `deployments/team/r${i}`
      expect((await api('POST', '/api/v2/folders/init', { folder: t, chart: 'demo' })).status).toBe(200)
      const [s, y] = await Promise.all([saveSrc(100 + i), api('POST', '/api/v2/sync', { source: SRC, target: t })])
      expect([s.status, y.status]).toEqual([200, 200])
      if ((await read(`${t}/values.yaml`)) !== (await read(`${SRC}/values.yaml`))) behind++
    }
    expect(behind).toBe(0)
  })

  // What the lock is for once every write has its own temp file: a save
  // writes routing.yaml, then the AlertmanagerConfig made from it. If a
  // second save runs between the two, the source ends up with one save's
  // routing.yaml and the other's resource. The first save is held at its
  // second file to make that order certain.
  it('a routing save that starts during another waits for it', async () => {
    await setup()
    const routing = await routingFixture()
    const save = h => api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: routing.replace('4h', `${h}h`) })
    expect((await save(2)).status).toBe(200)

    // The second save starts only once the first is held. The first is let
    // go when the second finishes (it got past the lock: the bug) or after
    // 500 ms (it is waiting on the lock), whichever comes first.
    const rename = fs.rename.bind(fs)
    let held = false, reached, release
    const atHold = new Promise(r => { reached = r })
    const gate = new Promise(r => { release = r })
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!held && String(to).endsWith(path.join(SRC, 'templates', 'alertmanagerconfig.yaml'))) {
        held = true
        reached()
        await gate
      }
      return rename(from, to)
    })
    try {
      const first = save(5)
      await atHold
      const second = save(7)
      await Promise.race([second, new Promise(r => setTimeout(r, 500))])
      release()
      const results = await Promise.all([first, second])
      expect(results.map(r => r.status)).toEqual([200, 200])
    } finally {
      release()
      spy.mockRestore()
    }
    expect(held).toBe(true)

    // The resource on disk is the one its routing.yaml generates, and the
    // target has the same two files.
    const state = (await api('GET', `/api/v2/deployments/demo/src/routing${q(SRC)}`)).data
    expect(state.stale).toBe(false)
    for (const rel of ['routing.yaml', 'templates/alertmanagerconfig.yaml']) {
      expect(await read(`${TGT}/${rel}`)).toBe(await read(`${SRC}/${rel}`))
    }
  })
})
