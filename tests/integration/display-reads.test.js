// What the pages show of a deployment's values — the Sync dialogs' row
// count, the folder tree's marks, a _common's users — is what Helm deploys
// from the same files: the repo loader's values (its own over each
// _common's over the Template's), never a second reading of the file.
// Expected values are what Helm renders from these files (one CpuHigh per
// cpu row), written by hand.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import { execFileSync } from 'child_process'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\n  thr: {type: number, default: 80}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > ${thr}\n'
const UP = 'group: up\nonce: true\nrules:\n  - alert: Down\n    expr: up == 0\n'

let server, base, root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'display-reads-'))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  for (const n of ['templates', 'folders', 'render', 'deployments', 'sync']) app.use(`/api/v2/${n}`, (await import(`../../server/routes/${n}.js`)).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r() }) })
  await must(api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU, 'up.yaml': UP } }))
  for (const f of ['deployments/t/a', 'deployments/s/x']) await must(api('POST', '/api/v2/folders/init', { folder: f, chart: 'demo' }))
  const plan = await must(api('GET', '/api/v2/folders/common/plan?folder=deployments/s&chart=demo'))
  await must(api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/s', chart: 'demo', expected: plan.data.expected }))
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  await fs.chmod(root, 0o755).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}
async function must(p) {
  const r = await p
  if (r.status !== 200) throw new Error(`setup: ${r.status} ${JSON.stringify(r.data)}`)
  return r
}
const put = (rel, text) => fs.writeFile(path.join(root, rel), text)
const listed = async rel => (await api('GET', '/api/v2/folders/deployments?chart=demo')).data.find(d => d.path === rel)

describe('the Sync dialogs\' row count', () => {
  it('counts the rows a deployment inherits from its _common: Helm deploys them', async () => {
    await put('deployments/s/_common/demo/values.yaml', 'demo:\n  cpu:\n    - { job: a }\n    - { job: b }\n')
    await put('deployments/s/x/values.yaml', 'common:\n  demo: {}\n')
    expect((await listed('deployments/s/x')).alertCount).toBe(2)
  })

  it('counts the rows of a key written twice as Helm does, by the later one', async () => {
    await put('deployments/t/a/values.yaml', 'demo:\n  cpu:\n    - { job: a }\n  cpu:\n    - { job: b }\n    - { job: c }\n')
    expect((await listed('deployments/t/a')).alertCount).toBe(2)
  })

  it('counts only the Template\'s groups: rows under a key no group reads deploy nothing', async () => {
    await put('deployments/t/a/values.yaml', 'demo:\n  cpu:\n    - { job: a }\n  mem:\n    - { job: b }\n')
    expect((await listed('deployments/t/a')).alertCount).toBe(1)
  })

  it('gives no count for values Helm stops on, as for values it cannot read', async () => {
    await put('deployments/t/a/values.yaml', 'demo:\n  cpu:\n    - { job: a, thr: abc }\n')
    expect((await listed('deployments/t/a')).alertCount).toBeNull()
  })

  it('reads 010 as Helm does: one row, its value 8, and counted', async () => {
    await put('deployments/t/a/values.yaml', 'demo:\n  cpu:\n    - { job: a, thr: 010 }\n')
    expect((await listed('deployments/t/a')).alertCount).toBe(1)
  })
})

describe('the folder tree', () => {
  const node = async rel => (await api('GET', `/api/v2/folders/tree?path=${encodeURIComponent(path.posix.dirname(rel))}`)).data.find(n => n.path === rel)

  it('marks a deployment whose values.yaml cannot be read, as it marks a folder it cannot read', async () => {
    await fs.rm(path.join(root, 'deployments/t/a/values.yaml'))
    await fs.mkdir(path.join(root, 'deployments/t/a/values.yaml'))
    expect(await node('deployments/t/a')).toMatchObject({ isDeployment: true, unreadable: 'its values.yaml cannot be read (it is a folder, not a file)' })
  })

  it('marks a deployment whose values Helm cannot read as values', async () => {
    await put('deployments/t/a/values.yaml', 'demo: null\n')
    const n = await node('deployments/t/a')
    expect(n.isDeployment).toBe(true)
    expect(n.unreadable).toMatch(/^its values\.yaml cannot be used \(deployments\/t\/a\/values\.yaml: demo must be a map of values/)
  })

  it('marks nothing on a deployment Helm deploys', async () => {
    expect(await node('deployments/t/a')).not.toHaveProperty('unreadable')
  })
})

describe('a _common\'s users', () => {
  const users = async () => (await api('GET', '/api/v2/folders/common/users?path=deployments/s/_common/demo')).data

  // One rule with the Sync dialogs' count: no number where Helm stops on the
  // deployment's values, they cannot be read, or what deploys cannot be told.
  for (const [name, write] of [
    ['its values cannot be read', async () => { await put('deployments/s/x/values.yaml', 'common:\n  demo: {}\n'); await fs.chmod(path.join(root, 'deployments/s/x/values.yaml'), 0) }],
    ['its chart key holds nothing', () => put('deployments/s/x/values.yaml', 'common:\n  demo: null\n')],
    ['a value Helm stops on', () => put('deployments/s/x/values.yaml', 'common:\n  demo:\n    cpu:\n      - { job: x, thr: abc }\n')],
    ['a null over the _common\'s rows', () => put('deployments/s/x/values.yaml', 'common:\n  demo:\n    cpu: null\n')],
  ]) {
    it.skipIf(process.getuid?.() === 0 && name.includes('read'))(`give no row count when ${name}`, async () => {
      await put('charts/demo/values.yaml', 'cpu: []\n')
      await put('deployments/s/_common/demo/values.yaml', 'demo:\n  cpu:\n    - { job: a }\n    - { job: b }\n')
      await write()
      try {
        const x = (await users()).find(u => u.path === 'deployments/s/x')
        expect(x.groups.cpu).toMatchObject({ rows: null })
        expect((await listed('deployments/s/x')).alertCount).toBeNull()
      } finally {
        await fs.chmod(path.join(root, 'deployments/s/x/values.yaml'), 0o644).catch(() => {})
      }
    })
  }

  it('count each group\'s rows as Helm deploys them, a key written twice by the later one', async () => {
    await put('deployments/s/_common/demo/values.yaml', 'demo:\n  cpu:\n    - { job: a }\n')
    await put('deployments/s/x/values.yaml', 'common:\n  demo:\n    cpu:\n      - { job: x1 }\n    cpu:\n      - { job: y1 }\n      - { job: z1 }\n')
    expect((await users()).find(u => u.path === 'deployments/s/x').groups.cpu).toEqual({ from: 'own', rows: 2 })
  })
})

// A _common whose values AlertForge cannot tell Helm's reading of (a |2
// block): Helm decides what deploys, as for a deployment's own values.
describe.skipIf(!HAS_HELM)('a _common AlertForge cannot tell', () => {
  const LAYER = 'demo:\n  cpu:\n    - { job: a }\n  note: |2\n     two spaces more\n'

  it('is rendered by Preview, said beside the check, with no summary of values not known', async () => {
    await put('deployments/s/_common/demo/values.yaml', LAYER)
    const { data } = await api('POST', `/api/v2/render/demo/x?folder=${encodeURIComponent('deployments/s/x')}`)
    expect(data.ok).toBe(true)
    expect(data.output).toContain('alert: CpuHigh')
    expect(data.check.output).toContain('deployments/s/_common/demo/values.yaml: AlertForge cannot tell how Helm reads this')
    expect(data.summary).toBeNull()
  })

  it('gives its users no row count either', async () => {
    await put('charts/demo/values.yaml', 'cpu: []\n')
    await put('deployments/s/_common/demo/values.yaml', LAYER)
    const users = (await api('GET', '/api/v2/folders/common/users?path=deployments/s/_common/demo')).data
    // Where the rows come from cannot be told either: only that no number is said.
    const x = users.find(u => u.path === 'deployments/s/x')
    expect(x).toMatchObject({ told: false, groups: { cpu: { rows: null } } })
  })

  it('gives the Sync dialogs no row count: what it gives is not known', async () => {
    await put('deployments/s/_common/demo/values.yaml', LAYER)
    expect((await listed('deployments/s/x')).alertCount).toBeNull()
  })
})

// A null on a _common stack: Helm 3.15 and 3.19 deploy different rows for
// it, so Preview says no row count for the group (and not "has N rows but
// produced no alerts").
describe.skipIf(!HAS_HELM)('Preview of a group nulled over a _common\'s rows', () => {
  it('gives the group no row count', async () => {
    await put('charts/demo/values.yaml', 'cpu: []\n')
    await put('deployments/s/_common/demo/values.yaml', 'demo:\n  cpu:\n    - { job: a }\n    - { job: b }\n')
    await put('deployments/s/x/values.yaml', 'common:\n  demo:\n    cpu: null\n')
    const { data } = await api('POST', `/api/v2/render/demo/x?folder=${encodeURIComponent('deployments/s/x')}`)
    expect(data.ok).toBe(true)
    const cpu = data.summary.groups.find(g => g.valuesKey === 'cpu')
    expect(cpu.rowCount).toBeNull()
    expect(cpu.state).not.toBe('no-alerts')
  })
})

// A _common folder shared by a hand-made link is not supported: every
// entry says so in the same words, none shows what it would inherit.
describe('a _common reached through a hand-made link', () => {
  const SAID = 'its _common chart deployments/t/_common/demo: deployments/t/_common is a link to deployments/s/_common — a _common reached through a link made by hand is not supported, and nothing is written to it: replace the link with a folder of its own in git, or depend on deployments/s/_common/demo'
  beforeEach(async () => {
    await put('deployments/s/_common/demo/values.yaml', 'demo:\n  cpu:\n    - { job: shared }\n')
    await fs.symlink('../s/_common', path.join(root, 'deployments/t/_common'))
    await put('deployments/t/a/Chart.yaml', "apiVersion: v2\nname: a\nversion: 0.1.0\ndependencies:\n  - name: common\n    version: '>=0.0.0-0'\n    repository: file://../_common/demo\n")
    await put('deployments/t/a/values.yaml', 'common:\n  demo: {}\n')
  })

  it('is marked in the tree, with its Template', async () => {
    const n = (await api('GET', '/api/v2/folders/tree?path=deployments/t')).data.find(x => x.path === 'deployments/t/a')
    expect(n).toMatchObject({ isDeployment: true, chart: 'demo', unreadable: SAID })
  })

  it('gives the Sync dialogs no row count', async () => {
    expect((await listed('deployments/t/a')).alertCount).toBeNull()
  })

  // Every write that touches it: 409, the same sentence, nothing written.
  const snapshot = async () => Promise.all(['deployments/t/a/values.yaml', 'deployments/t/a/Chart.yaml', 'deployments/s/x/values.yaml', 'deployments/s/x/Chart.yaml', 'deployments/s/_common/demo/values.yaml', 'sync.yaml']
    .map(f => fs.readFile(path.join(root, f), 'utf-8').catch(() => null)))
  const REFUSED = { error: `deployments/t/a: ${SAID}`, file: 'deployments/t/a' }
  it('is opened as the refusal, not as rows of no group', async () => {
    const r = await api('GET', `/api/v2/deployments/demo/a?folder=${encodeURIComponent('deployments/t/a')}`)
    expect(r.status).toBe(409)
    expect(r.data).toMatchObject(REFUSED)
  })
  for (const [name, values] of [['as values', { cpu: [{ job: 'b' }] }], ['as text', 'common:\n  demo:\n    cpu:\n      - { job: b }\n']]) {
    it(`is not saved ${name}`, async () => {
      const before = await snapshot()
      const r = await api('POST', `/api/v2/deployments/demo/a?folder=${encodeURIComponent('deployments/t/a')}`, { values })
      expect(r.status).toBe(409)
      expect(r.data).toMatchObject(REFUSED)
      expect(await snapshot()).toEqual(before)
    })
  }
  for (const [name, body] of [['to it', { source: 'deployments/s/x', target: 'deployments/t/a' }], ['from it', { source: 'deployments/t/a', target: 'deployments/s/x' }]]) {
    it(`is not synced ${name}`, async () => {
      const before = await snapshot()
      const r = await api('POST', '/api/v2/sync', body)
      expect(r.status).toBe(409)
      expect(r.data).toMatchObject(REFUSED)
      expect(await snapshot()).toEqual(before)
    })
  }

  // A write that would put a deployment or a _common on it, or take away
  // the _common it leads to: the same sentence, about the folder or the
  // deployment it is said of.
  const everything = async (rel = 'deployments') => {
    const out = {}
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(root, p))}`
      else if (e.isDirectory()) Object.assign(out, { [`${p}/`]: 'folder' }, await everything(p))
      else out[p] = await fs.readFile(path.join(root, p), 'utf-8')
    }
    return out
  }
  const refusedAs = async (rel, ask) => {
    const before = await everything()
    const r = await ask()
    expect(r.status).toBe(409)
    expect(r.data).toMatchObject({ error: `${rel}: ${SAID}`, file: rel })
    expect(await everything()).toEqual(before)
  }
  it('takes no new deployment in the folder', async () => {
    await refusedAs('deployments/t/n', () => api('POST', '/api/v2/folders/init', { folder: 'deployments/t/n', chart: 'demo' }))
  })
  it('takes no new deployment in a folder below it', async () => {
    await fs.mkdir(path.join(root, 'deployments/t/sub'))
    await refusedAs('deployments/t/sub/n', () => api('POST', '/api/v2/folders/init', { folder: 'deployments/t/sub/n', chart: 'demo' }))
  })
  it('is not made a _common over, in its folder or one above', async () => {
    await refusedAs('deployments/t', () => api('GET', '/api/v2/folders/common/plan?folder=deployments/t&chart=demo'))
    await refusedAs('deployments/t', () => api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/t', chart: 'demo', expected: {} }))
    await refusedAs('deployments/t/a', () => api('GET', '/api/v2/folders/common/plan?folder=deployments&chart=demo'))
    await refusedAs('deployments/t/a', () => api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments', chart: 'demo', expected: {} }))
  })
  it('is not removed through the link', async () => {
    await refusedAs('deployments/t', () => api('GET', '/api/v2/folders/common/plan?action=delete&path=deployments/t/_common/demo'))
    await refusedAs('deployments/t', () => api('POST', '/api/v2/folders/common', { action: 'delete', path: 'deployments/t/_common/demo', expected: {} }))
  })
  it('keeps the _common it leads to: removing that one would leave the deployment on nothing', async () => {
    await refusedAs('deployments/t/a', () => api('GET', '/api/v2/folders/common/plan?action=delete&path=deployments/s/_common/demo'))
    await refusedAs('deployments/t/a', () => api('POST', '/api/v2/folders/common', { action: 'delete', path: 'deployments/s/_common/demo', expected: {} }))
  })
  it('takes a sync to a new deployment in the folder, which is made on the _common the source is on, not through the link', async () => {
    const r = await api('POST', '/api/v2/sync', { source: 'deployments/s/x', target: 'deployments/t/new' })
    expect(r.status).toBe(200)
    expect(await fs.readFile(path.join(root, 'deployments/t/new/Chart.yaml'), 'utf-8')).toContain('file://../../s/_common/demo')
  })

  it('is refused by Preview in the same words', async () => {
    const { data } = await api('POST', `/api/v2/render/demo/a?folder=${encodeURIComponent('deployments/t/a')}`)
    expect(data).toMatchObject({ ok: false, error: `deployments/t/a: ${SAID}` })
  })
})

describe('the rule owner page\'s values', () => {
  it('are the values and what Helm does with them, not the file\'s text (no page shows it)', async () => {
    const { data, status } = await api('GET', `/api/v2/deployments/demo/a?folder=${encodeURIComponent('deployments/t/a')}`)
    expect(status).toBe(200)
    expect(data).toHaveProperty('parsed')
    expect(data).not.toHaveProperty('content')
  })
})
