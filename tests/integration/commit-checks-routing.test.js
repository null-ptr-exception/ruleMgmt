// A commit through AlertForge is refused while a deployment's notification
// routing is behind its routing.yaml, a sync target's routing is not its
// source's, sync.yaml cannot be right, or a deployment's Template is gone
// (#179). Regenerate makes the routing again; it writes files and commits
// nothing. A routing.yaml with errors does not stop a commit: it is listed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir, savedLabels

beforeEach(async () => {
  savedLabels = process.env.RULE_OBJECT_LABELS
  delete process.env.RULE_OBJECT_LABELS
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-checks-routing-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  app.use('/api/v2/git', gitRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })

  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const dep of [SRC, TGT]) expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
  expect((await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: ROUTING })).status).toBe(200)
  expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
  expect((await commit('setup')).status).toBe(200)
})

afterEach(async () => {
  if (savedLabels === undefined) delete process.env.RULE_OBJECT_LABELS
  else process.env.RULE_OBJECT_LABELS = savedLabels
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const q = f => `?folder=${encodeURIComponent(f)}`
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const write = (rel, text) => fs.writeFile(path.join(tmpDir, rel), text)
// Something to commit, so the checks run.
const commit = async (message = 'e2e') => {
  await write('notes.txt', `${message} ${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message })
}
const regenerate = () => api('POST', '/api/v2/git/routing/regenerate')
const kinds = data => (data.findings || []).map(f => `${f.kind} ${f.deployment || ''}`.trim())
// The object labels reach the chart's rules too: the chart is made again as
// the editor's Save would, leaving the routing behind.
const newLabels = async labels => {
  process.env.RULE_OBJECT_LABELS = labels
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
}

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
const SRC = 'deployments/team/src'
const TGT = 'deployments/team/tgt'
const OTHER = 'deployments/team/other'
const CR = 'templates/alertmanagerconfig.yaml'
const ROUTING = `# kept as written
labels:
  severity: [critical]
configs:
  ops: {type: email, to: ops@example.com}
cells:
  - match: {severity: critical}
    configs: [ops]
`

describe('a commit is refused while routing is behind', () => {
  it('after the object labels change, naming every deployment with routing', async () => {
    await newLabels('{"release":"kps"}')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.error).toBe('Commit refused')
    // The target is held to its source, which is behind; it is not compared
    // with its own routing.yaml.
    expect(kinds(data)).toEqual([`routing-stale ${SRC}`])
    // What Regenerate makes: the source, and its target copied from it.
    expect(data.regenerable).toBe(2)
  })

  it.each([
    ['the resource edited by hand', async () => write(`${SRC}/${CR}`, `# hand edit\n${await read(`${SRC}/${CR}`)}`)],
    ['routing.yaml edited by hand and not saved', async () => write(`${SRC}/routing.yaml`, ROUTING.replace('ops@', 'oncall@'))],
  ])('after %s', async (_, edit) => {
    await edit()
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toContain(`routing-stale ${SRC}`)
  })

  it('routing.yaml removed, its resource left: refused, and not regenerated', async () => {
    expect((await api('DELETE', '/api/v2/sync', { target: TGT })).status).toBe(200)
    await fs.rm(path.join(tmpDir, SRC, 'routing.yaml'))
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toEqual([`routing-orphaned ${SRC}`])
    expect(data.regenerable).toBe(0)
  })

  it('a sync target edited by hand: refused; Regenerate makes it its source\'s again', async () => {
    await write(`${TGT}/routing.yaml`, ROUTING.replace('ops@', 'mine@'))
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toEqual([`routing-target-differs ${TGT}`])

    expect(await regenerate()).toEqual({ status: 200, data: { regenerated: [TGT], failed: [] } })
    for (const rel of ['routing.yaml', CR]) expect(await read(`${TGT}/${rel}`)).toBe(await read(`${SRC}/${rel}`))
    expect((await commit()).status).toBe(200)
  })
})

describe('Regenerate', () => {
  it('makes the resource again from routing.yaml, leaves the text as written, and commits nothing', async () => {
    await newLabels('{"release":"kps"}')
    const head = await git(tmpDir, 'rev-parse', 'HEAD')

    expect(await regenerate()).toEqual({ status: 200, data: { regenerated: [SRC, TGT], failed: [] } })

    expect(await read(`${SRC}/routing.yaml`)).toBe(ROUTING)
    expect(yaml.load(await read(`${SRC}/${CR}`).then(t => t.replace(/\{\{[^}]*\}\}/g, 'x'))).metadata.labels).toMatchObject({ release: 'kps' })
    expect(await read(`${TGT}/${CR}`)).toBe(await read(`${SRC}/${CR}`))
    expect(await git(tmpDir, 'rev-parse', 'HEAD')).toBe(head)
    expect((await commit()).status).toBe(200)
  })

  // A target in sync.yaml
  // is a hand edit or a pull away from any path. Regenerate wrote routing
  // there, outside the workspace too.
  it.each([
    ['outside the workspace', '../outside', 'not a path sync may write to'],
    ['inside the Templates', 'charts/demo', 'not a path sync may write to'],
    ['no deployment', 'deployments/team/gone', 'not a deployment on disk'],
  ])('a target %s is not written: listed as failed', async (_, target, error) => {
    await write('sync.yaml', yaml.dump({ syncs: [{ source: SRC, targets: [TGT, target] }] }))
    await newLabels('{"release":"kps"}')
    const { status, data } = await regenerate()
    expect(status).toBe(200)
    expect(data.regenerated).toEqual([SRC, TGT])
    expect(data.failed).toEqual([{ deployment: target, error }])
    for (const file of ['routing.yaml', CR]) {
      expect(await fs.access(path.resolve(tmpDir, target, file)).then(() => true, () => false)).toBe(false)
    }
  })

  it('one that cannot be written is listed, the others are made, and the commit is still refused', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: OTHER, chart: 'demo' })).status).toBe(200)
    expect((await api('PUT', `/api/v2/deployments/demo/other/routing${q(OTHER)}`, { routing: ROUTING })).status).toBe(200)
    await newLabels('{"release":"kps"}')
    await fs.chmod(path.join(tmpDir, OTHER, 'templates'), 0o555)
    try {
      const { data } = await regenerate()
      if (process.getuid?.() !== 0) {
        expect(data.failed).toEqual([{ deployment: OTHER, error: 'EACCES' }])
        expect(data.regenerated).toEqual([SRC, TGT])
        expect(kinds((await commit()).data)).toEqual([`routing-stale ${OTHER}`])
      }
    } finally {
      await fs.chmod(path.join(tmpDir, OTHER, 'templates'), 0o755)
    }
  })
})

describe('a routing.yaml with errors', () => {
  it('does not stop a commit, and the commit lists it', async () => {
    expect((await api('DELETE', '/api/v2/sync', { target: TGT })).status).toBe(200)
    await write(`${SRC}/routing.yaml`, 'labels: [\n')
    const { status, data } = await commit()
    expect(status).toBe(200)
    expect(data.routingProblems).toEqual([{ deployment: SRC, errors: [expect.stringContaining('not valid YAML')] }])
  })

  it('still says its resource is behind, on the Routing page', async () => {
    await write(`${SRC}/routing.yaml`, 'labels: [\n')
    const { data } = await api('GET', `/api/v2/deployments/demo/src/routing${q(SRC)}`)
    expect(data).toMatchObject({ stale: true })
    expect(data.errors.length).toBeGreaterThan(0)
  })
})

describe('sync.yaml that cannot be right', () => {
  beforeEach(async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: OTHER, chart: 'demo' })).status).toBe(200)
  })

  it.each([
    ['a chain', () => ({ syncs: [{ source: SRC, targets: [TGT] }, { source: TGT, targets: [OTHER] }] }), `${TGT} follows ${SRC} and is a source itself`],
    ['a target with two sources', () => ({ syncs: [{ source: SRC, targets: [TGT] }, { source: OTHER, targets: [TGT] }] }), `${TGT} follows two sources: ${SRC} and ${OTHER}`],
    ['a target that is not there', () => ({ syncs: [{ source: SRC, targets: [TGT, 'deployments/team/gone'] }] }), 'syncs[0]: target deployments/team/gone is not a deployment'],
    ['an entry without targets', () => ({ syncs: [{ source: SRC, targets: [TGT] }, { source: OTHER }] }), 'syncs[1]: is not { source, targets: [...] }'],
  ])('%s is refused, naming the entry', async (_, registry, why) => {
    await write('sync.yaml', yaml.dump(registry()))
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings.map(f => f.description)).toContainEqual(expect.stringContaining(why))
  })
})

// A deployment listed as its own sync target
// skipped its own routing check (its "source" was itself, always the same).
describe('a deployment listed as its own target', () => {
  it('still has its routing checked: a stale resource is named too', async () => {
    await write('sync.yaml', yaml.dump({ syncs: [{ source: SRC, targets: [SRC] }] }))
    await newLabels('{"release":"kps"}')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toEqual(expect.arrayContaining([`routing-stale ${SRC}`]))
  })
})

describe('a Template deleted outside AlertForge', () => {
  it('refuses the commit, naming each deployment that uses it', async () => {
    await fs.rm(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toEqual(expect.arrayContaining([`template-missing ${SRC}`, `template-missing ${TGT}`]))
  })
})

describe('nothing behind', () => {
  it('commits as before', async () => {
    const { status, data } = await commit()
    expect(status).toBe(200)
    expect(data.routingProblems).toBeUndefined()
  })
})

describe('more that a commit checks', () => {
  it('a sync.yaml that is not YAML is refused, naming it, and Regenerate says to fix it first', async () => {
    await write('sync.yaml', 'syncs: [\n')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings.map(f => f.description)).toContainEqual(expect.stringContaining('sync.yaml : is not valid YAML'))
    expect(await regenerate()).toEqual({ status: 200, data: { regenerated: [], failed: [{ deployment: 'sync.yaml', error: 'not valid YAML: fix it first' }] } })
  })

  it('an empty syncs: is no sync at all', async () => {
    await write('sync.yaml', 'syncs:\n')
    expect((await commit()).status).toBe(200)
  })

  it('a source listed twice is refused', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: OTHER, chart: 'demo' })).status).toBe(200)
    await write('sync.yaml', yaml.dump({ syncs: [{ source: SRC, targets: [TGT] }, { source: SRC, targets: [OTHER] }] }))
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings.map(f => f.description)).toContainEqual(expect.stringContaining(`syncs[1]: ${SRC} is listed as a source again`))
  })

  it('a deployment inside another\'s folder is checked too', async () => {
    // One made by hand, or pulled: AlertForge makes none there.
    const inner = `${SRC}/inner`
    await fs.mkdir(path.join(tmpDir, inner), { recursive: true })
    await write(`${inner}/Chart.yaml`, (await read(`${SRC}/Chart.yaml`)).replace('file://', 'file://../'))
    await write(`${inner}/values.yaml`, 'demo: {}\n')
    expect((await api('PUT', `/api/v2/deployments/demo/inner/routing${q(inner)}`, { routing: ROUTING })).status).toBe(200)
    await write(`${inner}/${CR}`, `# hand edit\n${await read(`${inner}/${CR}`)}`)
    expect(kinds((await commit()).data)).toEqual([`routing-stale ${inner}`])
  })

  it('a target spelled another way in sync.yaml is still held to its source', async () => {
    await write('sync.yaml', yaml.dump({ syncs: [{ source: `${SRC}/`, targets: [`./${TGT}`] }] }))
    await write(`${TGT}/routing.yaml`, ROUTING.replace('ops@', 'mine@'))
    expect(kinds((await commit()).data)).toEqual([`routing-target-differs ${TGT}`])
  })

  it('a target whose source has routing problems is not offered to Regenerate', async () => {
    await write(`${TGT}/routing.yaml`, ROUTING.replace('ops@', 'mine@'))
    await write(`${SRC}/routing.yaml`, 'labels: [\n')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings).toEqual([expect.objectContaining({ kind: 'routing-target-differs', deployment: TGT, regenerable: false, description: expect.stringContaining('fix the source first') })])
    expect(data.regenerable).toBe(0)
  })

  it('a charts directory spelled ./charts is not taken for deployments', async () => {
    const saved = process.env.CHARTS_DIR
    process.env.CHARTS_DIR = './charts'
    try {
      // A Template with values.yaml and a file:// dependency looks like one.
      const chart = yaml.load(await read('charts/demo/Chart.yaml'))
      await write('charts/demo/Chart.yaml', yaml.dump({ ...chart, dependencies: [{ name: 'x', repository: 'file://../gone' }] }))
      await write('charts/demo/values.yaml', 'cpu: []\n')
      expect(kinds((await commit()).data)).not.toContainEqual(expect.stringContaining('charts/demo'))
    } finally {
      if (saved === undefined) delete process.env.CHARTS_DIR
      else process.env.CHARTS_DIR = saved
    }
  })

  it('the Routing page says a target is behind when its routing is not its source\'s', async () => {
    // Its own two files agree: it is only its source it differs from.
    expect((await api('DELETE', '/api/v2/sync', { target: TGT })).status).toBe(200)
    expect((await api('PUT', `/api/v2/deployments/demo/tgt/routing${q(TGT)}`, { routing: ROUTING.replace('ops@', 'mine@') })).status).toBe(200)
    await write('sync.yaml', yaml.dump({ syncs: [{ source: SRC, targets: [TGT] }] }))
    const { data } = await api('GET', `/api/v2/deployments/demo/tgt/routing${q(TGT)}`)
    expect(data).toMatchObject({ stale: true, differsFromSource: true })
  })
})
