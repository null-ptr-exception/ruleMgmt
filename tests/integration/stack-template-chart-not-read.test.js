// A deployment on a _common whose Template's Chart.yaml is there and is not
// read — a link that leads outside the repo, a link into git's own folder,
// a file larger than Helm reads: the editor and Preview name that file and
// say why, where the _common's link to the Template is in place. "No link"
// is said only when there is none.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

const SAMPLE = path.resolve('sample/charts/mariadb-alerts')
const C = 'mariadb-alerts'
const SHOP = `shop/_common/${C}`
const CHART = `charts/${C}/Chart.yaml`

let server, baseURL, work, tmpDir

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-template-'))
  tmpDir = path.join(work, 'repo')
  await fs.cp(SAMPLE, path.join(tmpDir, 'charts', C), { recursive: true })
  await fs.mkdir(path.join(tmpDir, '.git'))
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: renderRouter } = await import('../../server/routes/render.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/render', renderRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/folders/init', { folder: 'shop/a', chart: C })).status).toBe(200)
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
const open = () => api('GET', `/api/v2/deployments/${C}/a?folder=shop/a`)
const preview = () => api('POST', `/api/v2/render/${C}/a?folder=shop/a`)

// Each puts the same Chart.yaml where the reader does not read it.
const INPUTS = [
  ['a link that leads outside the repo', 'it is a link that leads outside the repo', async () => {
    await fs.rename(abs(CHART), path.join(work, 'Chart.yaml'))
    await fs.symlink(path.join(work, 'Chart.yaml'), abs(CHART))
  }],
  ['a link into git\'s own folder', 'it is a link into git\'s own folder', async () => {
    await fs.rename(abs(CHART), abs('.git/kept-chart.yaml'))
    await fs.symlink('../../.git/kept-chart.yaml', abs(CHART))
  }],
  ['larger than Helm reads', 'it is larger than 5 MiB, the most Helm reads in a chart file', async () => {
    await fs.appendFile(abs(CHART), `# ${'x'.repeat(1022)}\n`.repeat(5 * 1024 + 2))
  }],
]

describe('a _common whose Template\'s Chart.yaml is not read', () => {
  it.each(INPUTS)('%s: the file is named with why, not said to have no link', async (_, why, put) => {
    await put()
    // The link is where it was.
    expect(await fs.readlink(abs(`${SHOP}/charts/${C}`))).toBe(`../../../../charts/${C}`)
    const said = `the _common chart ${SHOP}: ${CHART} cannot be read (${why}), so Helm cannot render it`

    const shown = await open()
    expect(shown.status, JSON.stringify(shown.data)).toBe(200)
    expect(shown.data.stackProblems).toEqual([said])

    const rendered = await preview()
    expect(rendered.data).toEqual({ ok: false, error: `shop/a: ${said}` })
  })

  it('a _common with no link to its Template says so', async () => {
    await fs.rm(abs(`${SHOP}/charts/${C}`))
    const shown = await open()
    expect(shown.data.stackProblems).toEqual([`the _common chart ${SHOP} has no link to its Template ${C} in its charts/ (charts/${C}), so Helm renders nothing`])
  })
})
