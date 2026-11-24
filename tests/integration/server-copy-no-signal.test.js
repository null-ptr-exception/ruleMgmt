// The server's own stop is left as it is: a SIGTERM ends it, and its git
// and Helm children finish what they are doing. Checking a plan in a copy
// of the repo (a new deployment, a _common) takes over no signal, and the
// copy is removed when done. Its own file: the first copy in a process is
// the one that would take the signal over.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-copy-'))
  await fs.mkdir(path.join(tmpDir, 'charts'), { recursive: true })
  const names = ['charts', 'templates', 'deployments', 'folders']
  const routers = await Promise.all(names.map(r => import(`../../server/routes/${r}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  names.forEach((r, i) => app.use(`/api/v2/${r}`, routers[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})
afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  await fs.rm(tmpDir, { recursive: true, force: true })
})
const api = async (method, p, body) => {
  const res = await fetch(baseURL + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}

describe('checking in a copy of the repo', () => {
  it('takes over no stop signal of the server, and leaves no copy behind', async () => {
    const signals = () => ({ term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') })
    const before = signals()
    // A copy of this repo is known by a file only this repo has (other
    // test files make copies of their own meanwhile).
    const marker = `marker-${process.pid}-${Date.now()}.txt`
    await fs.writeFile(path.join(tmpDir, marker), 'x\n')
    const copies = async () => {
      const out = []
      for (const n of (await fs.readdir(os.tmpdir())).filter(n => n.startsWith('alertforge-copy-'))) {
        if (await fs.access(path.join(os.tmpdir(), n, 'repo', marker)).then(() => true, () => false)) out.push(n)
      }
      return out
    }
    expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n' } })).status).toBe(200)
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/u/p', chart: 'demo' })).status).toBe(200)
    expect((await api('GET', '/api/v2/folders/common/plan?folder=deployments/u&chart=demo')).status).toBe(200)
    expect(signals()).toEqual(before)
    expect(await copies()).toEqual([])
  })
})
