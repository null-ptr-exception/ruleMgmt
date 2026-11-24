// The commit check's whole answer, kept: for each repo below, what
// deploymentCommitBlockers returns, what POST /api/v2/git/commit answers and,
// where routing is behind, what Regenerate does and the commit after it —
// findings in their order. The check is being taken apart into one function
// per kind of file; this says nothing it answers changed while it is.
//
// The answers are today's, recorded in commit-check-answers.json, not what
// is right: a change meant to change one is recorded again with
// ANSWERS_UPDATE=1 and its diff read line by line.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import git from '../../server/lib/git.js'
import { deploymentCommitBlockers } from '../../server/lib/commitChecks.js'

const ANSWERS = path.join(import.meta.dirname, 'commit-check-answers.json')
const UPDATE = !!process.env.ANSWERS_UPDATE
const recorded = UPDATE ? {} : JSON.parse(readFileSync(ANSWERS, 'utf-8'))
const asRoot = process.getuid?.() === 0
// Root reads a mode-0 file or folder all the same: these cases mean nothing
// run as root, and would not answer as recorded.
const NEEDS_NON_ROOT = new Set(['a Template whose rules cannot be read', 'a folder that cannot be read'])
if (asRoot) for (const name of NEEDS_NON_ROOT) process.stderr.write(`commit-check-answers: "${name}" SKIPPED (running as root reads an unreadable file)\n`)


let server, baseURL, tmpDir, savedLabels

const A = 'deployments/team/a'
const B = 'deployments/team/b'
const C = 'deployments/team/c'
const D = 'deployments/team/d'
const CR = 'templates/alertmanagerconfig.yaml'
const SHARED = '_shared/notification-configs.yaml'
const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const ROUTING = `# kept as written
labels:
  severity: [critical]
configs:
  ops: {type: email, to: ops@example.com}
cells:
  - match: {severity: critical}
    configs: [ops]
`
const SHARED_ROUTING = `labels:
  severity: [critical]
configs:
  relay: { shared: true }
cells:
  - match: { severity: critical }
    configs: [relay]
`
const SHARED_TEXT = `configs:
  relay: { type: webhook, url: http://relay.example.com:8080 }
`

beforeEach(async () => {
  savedLabels = process.env.RULE_OBJECT_LABELS
  delete process.env.RULE_OBJECT_LABELS
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-check-answers-'))
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

  // a: routing, synced to b; c: its own routing; d: values only.
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const dep of [A, B, C, D]) expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)
  for (const dep of [A, C, D]) {
    expect((await api('POST', `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`, { values: { cpu: [{ namespace: path.basename(dep) }] } })).status).toBe(200)
  }
  for (const dep of [A, C]) expect((await api('PUT', `/api/v2/deployments/demo/${path.basename(dep)}/routing${q(dep)}`, { routing: ROUTING })).status).toBe(200)
  expect((await api('POST', '/api/v2/sync', { source: A, target: B })).status).toBe(200)
  expect((await commit('setup')).status).toBe(200)
})

afterEach(async () => {
  if (savedLabels === undefined) delete process.env.RULE_OBJECT_LABELS
  else process.env.RULE_OBJECT_LABELS = savedLabels
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) {
    // a folder made unreadable by a case
    await fs.chmod(tmpDir, 0o755).catch(() => {})
    for (const rel of ['charts/demo/rules', 'deployments/hidden']) await fs.chmod(path.join(tmpDir, rel), 0o755).catch(() => {})
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

afterAll(() => {
  // A case skipped as root keeps the answer it had.
  if (UPDATE && asRoot) for (const name of NEEDS_NON_ROOT) recorded[name] = JSON.parse(readFileSync(ANSWERS, 'utf-8'))[name]
  if (UPDATE) writeFileSync(ANSWERS, `${JSON.stringify(Object.fromEntries(Object.entries(recorded).sort()), null, 2)}\n`)
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const q = f => `?folder=${encodeURIComponent(f)}`
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const write = async (rel, text) => {
  await fs.mkdir(path.dirname(path.join(tmpDir, rel)), { recursive: true })
  await fs.writeFile(path.join(tmpDir, rel), text)
}
const commit = async (message = 'check') => {
  await write('notes.txt', `${message} ${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message })
}
const regenerate = () => api('POST', '/api/v2/git/routing/regenerate')
const newLabels = async labels => {
  process.env.RULE_OBJECT_LABELS = labels
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
}
const newDeployment = async dep => expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)

// What does not repeat from run to run: the temp folder, a commit's sha.
const stable = value => JSON.parse(JSON.stringify(value).split(tmpDir).join('<repo>').replace(/"sha":"[0-9a-f]+"/g, '"sha":"<sha>"'))

async function answer({ regen = false } = {}) {
  const out = { blockers: stable(await deploymentCommitBlockers(tmpDir)), commit: stable(await commit()) }
  if (regen) {
    out.regenerate = stable(await regenerate())
    out.afterRegenerate = { blockers: stable(await deploymentCommitBlockers(tmpDir)), commit: stable(await commit('after')) }
  }
  return out
}

const CASES = [
  ['nothing behind', async () => {}],
  ['the object labels change: every routing behind', async () => newLabels('{"release":"kps"}'), { regen: true }],
  ['a routing.yaml edited by hand', async () => write(`${A}/routing.yaml`, ROUTING.replace('ops@', 'oncall@')), { regen: true }],
  ['a resource edited by hand', async () => write(`${C}/${CR}`, `# hand edit\n${await read(`${C}/${CR}`)}`), { regen: true }],
  ['a sync target edited by hand', async () => write(`${B}/routing.yaml`, ROUTING.replace('ops@', 'mine@')), { regen: true }],
  ['a routing.yaml removed, its resource left', async () => fs.rm(path.join(tmpDir, C, 'routing.yaml'))],
  ['a routing.yaml with errors', async () => write(`${C}/routing.yaml`, 'labels: [\n')],
  ['a source whose routing.yaml has errors, and its target', async () => write(`${A}/routing.yaml`, 'labels: [\n'), { regen: true }],
  ['a config that notifies nobody', async () => {
    expect((await api('PUT', `/api/v2/deployments/demo/c/routing${q(C)}`, { routing: ROUTING.replace('to: ops@example.com', 'to: "undisclosed-recipients:;"') })).status).toBe(200)
  }],
  ['sync.yaml not YAML', async () => write('sync.yaml', 'syncs: [\n'), { regen: true }],
  ['sync.yaml: syncs is not a list', async () => write('sync.yaml', 'syncs: {a: 1}\n')],
  ['sync.yaml with every kind of bad entry', async () => {
    await newDeployment('deployments/team/e')
    await write('sync.yaml', yaml.dump({
      syncs: [
        { source: A, targets: [B, 'deployments/team/gone', 7] },
        { source: C, targets: [B, C] },
        { source: B, targets: [D] },
        { source: A, targets: ['deployments/team/e'] },
        { source: 'deployments/none', targets: [] },
        { source: D },
        'not an entry',
      ],
    }))
  }, { regen: true }],
  ['sync.yaml spelling a target another way', async () => {
    await write('sync.yaml', yaml.dump({ syncs: [{ source: A, targets: ['deployments/./team//b/'] }] }))
    await write(`${B}/routing.yaml`, ROUTING.replace('ops@', 'mine@'))
  }, { regen: true }],
  ['the Template deleted', async () => fs.rm(path.join(tmpDir, 'charts', 'demo'), { recursive: true })],
  ['a deployment asking for another version of its Template', async () => {
    const chart = yaml.load(await read(`${D}/Chart.yaml`))
    chart.dependencies[0].version = '9.9.9'
    await write(`${D}/Chart.yaml`, yaml.dump(chart))
    const other = yaml.load(await read(`${C}/Chart.yaml`))
    delete other.dependencies[0].version
    await write(`${C}/Chart.yaml`, yaml.dump(other))
  }],
  ['a Template whose Chart.yaml is broken', async () => write('charts/demo/Chart.yaml', 'version: [\n')],
  ['a Template whose rules cannot be read', async () => {
    await fs.chmod(path.join(tmpDir, 'charts/demo/rules'), 0o000)
  }],
  ['values that are not YAML, a values.yaml that is a folder, rows that repeat', async () => {
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU, '_common.yaml': 'rowIdentity: true\n' } })).status).toBe(200)
    await write(`${D}/values.yaml`, 'demo: [\n')
    await fs.rm(path.join(tmpDir, C, 'values.yaml'))
    await fs.mkdir(path.join(tmpDir, C, 'values.yaml'))
    await write(`${A}/values.yaml`, yaml.dump({ demo: { cpu: [{ namespace: 'p', warn: 80 }, { namespace: 'p', warn: 95 }] } }))
  }],
  ['a shared config used and not there', async () => {
    expect((await api('DELETE', '/api/v2/sync', { target: B })).status).toBe(200)
    await write(`${C}/routing.yaml`, SHARED_ROUTING)
  }],
  ['the shared configs broken while used', async () => {
    await write(SHARED, SHARED_TEXT)
    await write(`${C}/routing.yaml`, SHARED_ROUTING)
    await write(SHARED, 'configs: [\n')
  }],
  ['the shared configs broken, used by no one', async () => write(SHARED, 'configs: [\n')],
  ['the shared configs used, routing made before they changed', async () => {
    await write(SHARED, SHARED_TEXT)
    expect((await api('PUT', `/api/v2/deployments/demo/c/routing${q(C)}`, { routing: SHARED_ROUTING })).status).toBe(200)
    await write(SHARED, SHARED_TEXT.replace('8080', '9090'))
  }, { regen: true }],
  ['a deployment on a _common, with a hand-written null', async () => {
    const S = 'deployments/stack/s'
    await newDeployment(S)
    const shown = await api('GET', `/api/v2/folders/common/plan?${new URLSearchParams({ action: 'create', folder: 'deployments/stack', chart: 'demo' })}`)
    expect(shown.status, JSON.stringify(shown.data)).toBe(200)
    const done = await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/stack', chart: 'demo', expected: shown.data.expected })
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    await write(`${S}/values.yaml`, 'common:\n  demo:\n    cpu: null\n')
  }],
  ['the shared configs notifying nobody, used', async () => {
    await write(SHARED, SHARED_TEXT.replace('{ type: webhook, url: http://relay.example.com:8080 }', '{ type: email, to: "undisclosed-recipients:;" }'))
    expect((await api('PUT', `/api/v2/deployments/demo/c/routing${q(C)}`, { routing: SHARED_ROUTING })).status).toBe(200)
  }],
  ['a folder that cannot be read', async () => {
    await newDeployment('deployments/hidden/x')
    await fs.chmod(path.join(tmpDir, 'deployments/hidden'), 0o000)
  }],
  ['a deployment inside another\'s folder', async () => {
    const inner = `${A}/inner`
    await write(`${inner}/Chart.yaml`, await read(`${D}/Chart.yaml`).then(t => t.replace('file://../../../charts/demo', 'file://../../../../charts/demo')))
    await write(`${inner}/values.yaml`, await read(`${D}/values.yaml`))
    await write(`${inner}/routing.yaml`, ROUTING)
  }],
  ['several deployments, each with another problem', async () => {
    await newDeployment('deployments/team/e')
    await write(`${A}/routing.yaml`, ROUTING.replace('ops@', 'oncall@'))
    await fs.rm(path.join(tmpDir, C, 'routing.yaml'))
    await write(`${D}/values.yaml`, 'demo: [\n')
    const chart = yaml.load(await read('deployments/team/e/Chart.yaml'))
    chart.dependencies[0].version = '9.9.9'
    await write('deployments/team/e/Chart.yaml', yaml.dump(chart))
    await write('deployments/team/e/values.yaml', 'demo: [\n')
    await write(`${B}/routing.yaml`, ROUTING.replace('ops@', 'mine@'))
    await write('sync.yaml', yaml.dump({ syncs: [{ source: A, targets: [B] }, { source: A, targets: [D] }] }))
    await write(SHARED, 'configs: [\n')
  }, { regen: true }],
]

describe('the commit check answers as it did', () => {
  for (const [name, damage, options = {}] of CASES) {
    it.skipIf(asRoot && NEEDS_NON_ROOT.has(name))(name, async () => {
      await damage()
      const got = await answer(options)
      if (UPDATE) recorded[name] = got
      // byte for byte: findings in their order, keys in theirs
      else expect(JSON.stringify(got, null, 2)).toBe(JSON.stringify(recorded[name], null, 2))
    })
  }

  it('every case has a recorded answer, and none is left over', () => {
    if (!UPDATE) expect(Object.keys(recorded).sort()).toEqual(CASES.map(([name]) => name).sort())
  })
})
