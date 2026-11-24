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

const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\n  thr: {type: number, default: 80}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > ${thr}\n'
const UP = 'group: up\nonce: true\nrules:\n  - alert: Down\n    expr: up == 0\n'

let server, base, root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'display-reads-'))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  for (const n of ['templates', 'folders']) app.use(`/api/v2/${n}`, (await import(`../../server/routes/${n}.js`)).default())
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

  it('count each group\'s rows as Helm deploys them, a key written twice by the later one', async () => {
    await put('deployments/s/_common/demo/values.yaml', 'demo:\n  cpu:\n    - { job: a }\n')
    await put('deployments/s/x/values.yaml', 'common:\n  demo:\n    cpu:\n      - { job: x }\n    cpu:\n      - { job: y }\n      - { job: z }\n')
    expect((await users()).find(u => u.path === 'deployments/s/x').groups.cpu).toEqual({ from: 'own', rows: 2 })
  })
})
