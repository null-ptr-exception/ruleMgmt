// A routing.yaml edited by hand, as doc/how-to.md says to keep its comments:
// Commit is refused while the AlertmanagerConfig is behind the file, and the
// Regenerate the refused Commit offers makes the resource from the file as
// written, comments kept; the commit then goes through.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir, savedLabels

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
const DEP = 'deployments/team/a'
const CR = 'templates/alertmanagerconfig.yaml'
const ROUTING = `labels:
  severity: [critical]
configs:
  ops: {type: email, to: ops@example.com}
cells:
  - match: {severity: critical}
    configs: [ops]
`
const HAND = `# routed to the on-call rota from November
labels:
  severity: [critical]
configs:
  ops: {type: email, to: oncall@example.com}  # was ops@
cells:
  - match: {severity: critical}
    configs: [ops]
`

beforeEach(async () => {
  savedLabels = process.env.RULE_OBJECT_LABELS
  delete process.env.RULE_OBJECT_LABELS
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hand-edit-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  for (const r of ['templates', 'deployments', 'folders', 'git']) app.use(`/api/v2/${r}`, (await import(`../../server/routes/${r}.js`)).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/a${q(DEP)}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
  expect((await api('PUT', `/api/v2/deployments/demo/a/routing${q(DEP)}`, { routing: ROUTING })).status).toBe(200)
  expect((await commit('setup')).status).toBe(200)
})

afterEach(async () => {
  if (savedLabels === undefined) delete process.env.RULE_OBJECT_LABELS
  else process.env.RULE_OBJECT_LABELS = savedLabels
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const q = f => `?folder=${encodeURIComponent(f)}`
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const commit = message => api('POST', '/api/v2/git/commit', { message })

describe('a routing.yaml edited by hand', () => {
  it('is refused at Commit, made by Regenerate as written, comments kept, then committed', async () => {
    const before = await read(`${DEP}/${CR}`)
    expect(before).toContain('ops@example.com')
    await fs.writeFile(path.join(tmpDir, DEP, 'routing.yaml'), HAND)

    // (2) Commit is refused, naming the stale routing, with Regenerate offered.
    const refused = await commit('hand edit')
    expect(refused.status).toBe(409)
    expect(refused.data.error).toBe('Commit refused')
    expect(refused.data.findings.map(f => `${f.kind} ${f.deployment}`)).toEqual([`routing-stale ${DEP}`])
    expect(refused.data.regenerable).toBe(1)

    // (3) The Regenerate the refused Commit's dialog calls (GitChanges.jsx).
    expect(await api('POST', '/api/v2/git/routing/regenerate')).toEqual({ status: 200, data: { regenerated: [DEP], failed: [] } })

    // (4) routing.yaml is the hand edit byte for byte; the resource follows it.
    expect(await read(`${DEP}/routing.yaml`)).toBe(HAND)
    const after = await read(`${DEP}/${CR}`)
    expect(after).toContain('oncall@example.com')
    expect(after).not.toContain('ops@example.com')
    const shown = await api('GET', `/api/v2/deployments/demo/a/routing${q(DEP)}`)
    expect(shown.status).toBe(200)
    expect(shown.data).toMatchObject({ text: HAND, stale: false })

    // (5) The commit goes through, with the hand edit in it.
    expect((await commit('hand edit')).status).toBe(200)
    expect(String(await git(tmpDir, 'show', `HEAD:${DEP}/routing.yaml`)).trimEnd()).toBe(HAND.trimEnd())
  })
})
