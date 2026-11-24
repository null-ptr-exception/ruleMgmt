// Removing a _common whose own Chart.yaml is there and is not read — a link
// that leads outside the repo, a link into git's own folder, a file larger
// than Helm reads: the plan and the write refuse, naming the file and why,
// and nothing is written. Which deployments are on it is told from that
// file, so they would be left depending on a chart that is gone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'

const SAMPLE = path.resolve('sample/charts/mariadb-alerts')
const C = 'mariadb-alerts'
const SHOP = `shop/_common/${C}`
const CHART = `${SHOP}/Chart.yaml`

let server, baseURL, work, tmpDir

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'common-remove-'))
  tmpDir = path.join(work, 'repo')
  await fs.cp(SAMPLE, path.join(tmpDir, 'charts', C), { recursive: true })
  await fs.mkdir(path.join(tmpDir, '.git'))
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/folders', foldersRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  for (const folder of ['shop/a', 'shop/b']) expect((await api('POST', '/api/v2/folders/init', { folder, chart: C })).status).toBe(200)
  const shown = await api('GET', `/api/v2/folders/common/plan?folder=shop&chart=${C}`)
  expect(shown.status, JSON.stringify(shown.data)).toBe(200)
  const made = await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: shown.data.expected })
  expect(made.status, JSON.stringify(made.data)).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (work) await fs.rm(work, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const abs = rel => path.join(tmpDir, rel)
// Every file of the repo, with its size or where a link leads.
async function snapshot() {
  const out = {}
  async function walk(dir) {
    for (const e of await fs.readdir(abs(dir), { withFileTypes: true })) {
      const child = dir ? `${dir}/${e.name}` : e.name
      if (e.isSymbolicLink()) out[child] = `-> ${await fs.readlink(abs(child))}`
      else if (e.isDirectory()) await walk(child)
      else out[child] = (await fs.stat(abs(child))).size
    }
  }
  await walk('')
  return out
}

// Each puts the same Chart.yaml where the reader does not read it.
const INPUTS = [
  ['a link that leads outside the repo', 'it is a link that leads outside the repo', async () => {
    await fs.rename(abs(CHART), path.join(work, 'Chart.yaml'))
    await fs.symlink(path.join(work, 'Chart.yaml'), abs(CHART))
  }],
  ['a link into git\'s own folder', 'it is a link into git\'s own folder', async () => {
    await fs.rename(abs(CHART), abs('.git/kept-chart.yaml'))
    await fs.symlink('../../../.git/kept-chart.yaml', abs(CHART))
  }],
  ['larger than Helm reads', 'it is larger than 5 MiB, the most Helm reads in a chart file', async () => {
    await fs.appendFile(abs(CHART), `# ${'x'.repeat(1022)}\n`.repeat(5 * 1024 + 2))
  }],
]

describe('removing a _common whose own Chart.yaml is not read', () => {
  it.each(INPUTS)('%s: the plan and the write refuse, and nothing is written', async (_, why, put) => {
    await put()
    const before = await snapshot()
    const said = `Not removed: ${CHART} cannot be read (${why})`

    const shown = await api('GET', `/api/v2/folders/common/plan?action=delete&path=${SHOP}`)
    expect(shown.status, JSON.stringify(shown.data)).toBe(409)
    expect(shown.data.error).toBe(said)
    expect(shown.data.problems).toEqual([{ path: CHART, message: why }])

    const done = await api('POST', '/api/v2/folders/common', { action: 'delete', path: SHOP, expected: shown.data.expected ?? {} })
    expect(done.status, JSON.stringify(done.data)).toBe(409)
    expect(done.data.error).toBe(said)

    expect(await snapshot()).toEqual(before)
    // The deployments still depend on it, and it is still there.
    for (const dep of ['shop/a', 'shop/b']) {
      const chart = yaml.load(await fs.readFile(abs(`${dep}/Chart.yaml`), 'utf-8'))
      expect(chart.dependencies.map(d => d.repository)).toEqual([`file://../_common/${C}`])
    }
  })

  it('a _common whose Chart.yaml is read is removed, its deployments put back on the Template', async () => {
    const shown = await api('GET', `/api/v2/folders/common/plan?action=delete&path=${SHOP}`)
    expect(shown.status, JSON.stringify(shown.data)).toBe(200)
    expect(shown.data.changes.map(c => c.path)).toEqual(['shop/a', 'shop/b'])
    const done = await api('POST', '/api/v2/folders/common', { action: 'delete', path: SHOP, expected: shown.data.expected })
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    await expect(fs.lstat(abs(SHOP))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
