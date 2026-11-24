// The repo's shared notification configs (#123): written once in
// _shared/notification-configs.yaml, used by name from a deployment's
// routing.yaml. A change to one makes every resource using it again, all or
// none; a git edit that leaves them behind stops the commit until Regenerate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import { execFileSync } from 'child_process'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import git from '../../server/lib/git.js'
import { toAlertmanagerConfig, HAS_AMTOOL, amtoolTitle } from '../blind/harness.js'
import { withSyncRegistryLock } from '../../server/lib/sync.js'

let server, baseURL, tmpDir, savedLabels

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
const A = 'deployments/a/prod'
const B = 'deployments/b/prod'
const C = 'deployments/c/prod'
const TGT = 'deployments/c/stg'
const SHARED = '_shared/notification-configs.yaml'
const CR = 'templates/alertmanagerconfig.yaml'
const RELAY = 'http://alert-relay.monitoring.svc:8080'
const sharedText = url => `# the repo's shared configs
configs:
  relay-webhook: { type: webhook, url: ${url} }
  ops-email: { type: email, to: ops@example.com }
`
const routing = own => `# kept as written
labels:
  severity: [critical]
configs:
  relay-webhook: { shared: true }
${own}cells:
  - match: { severity: critical }
    configs: [relay-webhook]
`

beforeEach(async () => {
  savedLabels = process.env.RULE_OBJECT_LABELS
  delete process.env.RULE_OBJECT_LABELS
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-shared-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const routers = {}
  for (const name of ['templates', 'deployments', 'folders', 'sync', 'git', 'routingShared']) {
    routers[name] = (await import(`../../server/routes/${name}.js`)).default
  }
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', routers.templates())
  app.use('/api/v2/deployments', routers.deployments())
  app.use('/api/v2/folders', routers.folders())
  app.use('/api/v2/sync', routers.sync())
  app.use('/api/v2/git', routers.git())
  app.use('/api/v2/routing/shared', routers.routingShared())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })

  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const dep of [A, B, C, TGT]) {
    expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)
    expect((await api('POST', `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
  }
  expect((await api('PUT', '/api/v2/routing/shared', { shared: sharedText(RELAY) })).status).toBe(200)
  for (const dep of [A, B, C]) expect((await putRouting(dep, routing(''))).status).toBe(200)
  expect((await api('POST', '/api/v2/sync', { source: C, target: TGT })).status).toBe(200)
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
const putRouting = (dep, text) => api('PUT', `/api/v2/deployments/demo/${path.basename(dep)}/routing${q(dep)}`, { routing: text })
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const write = (rel, text) => fs.writeFile(path.join(tmpDir, rel), text)
const commit = async (message = 'test') => {
  await write('notes.txt', `${message} ${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message })
}
const crOf = async dep => yaml.load((await read(`${dep}/${CR}`)).replace(/\{\{ \.Release\.Name \}\}/, 'r'))
const urlIn = async dep => (await crOf(dep)).spec.receivers.find(r => r.webhookConfigs)?.webhookConfigs[0].url
const snapshot = () => Promise.all([A, B, C, TGT].flatMap(d => [read(`${d}/routing.yaml`), read(`${d}/${CR}`)]))

describe('a deployment using a shared config', () => {
  it('gets the shared config written into its resource in full', async () => {
    expect(await urlIn(A)).toBe(RELAY)
    expect(await read(`${A}/routing.yaml`)).toBe(routing(''))
  })

  it('cannot use one there is not', async () => {
    const { status, data } = await putRouting(A, routing('  nobody: { shared: true }\n').replace('[relay-webhook]', '[relay-webhook, nobody]'))
    expect(status).toBe(400)
    expect(data.problems).toEqual(['configs.nobody: there is no shared config named nobody'])
  })

  it('is listed with who uses each config, a sync target with its source', async () => {
    const { data } = await api('GET', '/api/v2/routing/shared')
    expect(data.exists).toBe(true)
    expect(Object.keys(data.configs)).toEqual(['relay-webhook', 'ops-email'])
    expect(data.usage).toEqual({ 'relay-webhook': [{ deployment: A }, { deployment: B }, { deployment: C }, { deployment: TGT, syncedFrom: C }] })
    expect(data.stale).toEqual([])
  })
})

describe('changing a shared config', () => {
  it('makes every resource using it again, the sync target\'s too; no routing.yaml changes', async () => {
    const before = await Promise.all([A, B, C, TGT].map(d => read(`${d}/routing.yaml`)))
    const { status, data } = await api('PUT', '/api/v2/routing/shared', { shared: sharedText('http://relay.example.com:9090') })
    expect(status).toBe(200)
    expect(data.written).toEqual([SHARED, `${A}/${CR}`, `${B}/${CR}`, `${C}/${CR}`])
    for (const dep of [A, B, C, TGT]) expect(await urlIn(dep)).toBe('http://relay.example.com:9090')
    expect(await Promise.all([A, B, C, TGT].map(d => read(`${d}/routing.yaml`)))).toEqual(before)
    expect((await commit()).status).toBe(200)
  })

  it('from the page, keeps the shared file\'s comments', async () => {
    const { status } = await api('PUT', '/api/v2/routing/shared', { shared: { configs: { 'relay-webhook': { type: 'webhook', url: 'http://relay.example.com:9090' }, 'ops-email': { type: 'email', to: 'ops@example.com' } } } })
    expect(status).toBe(200)
    expect(await read(SHARED)).toBe(sharedText('http://relay.example.com:9090'))
  })

  it('writes nothing when one user\'s routing cannot be made, naming it', async () => {
    // B's routing.yaml, edited with git: a cell names a config that is not there.
    await write(`${B}/routing.yaml`, routing('').replace('[relay-webhook]', '[relay-webhook, gone]'))
    const before = await snapshot()
    const shared = await read(SHARED)
    const { status, data } = await api('PUT', '/api/v2/routing/shared', { shared: sharedText('http://relay.example.com:9090') })
    expect(status).toBe(400)
    expect(data.failed.map(f => f.deployment)).toEqual([B])
    expect(data.failed[0].errors).toEqual(['cells[0]: config "gone" is not in configs'])
    expect(await snapshot()).toEqual(before)
    expect(await read(SHARED)).toBe(shared)
  })

  it('refuses a shared config that reads a Secret, or fails a deployment config\'s checks', async () => {
    let r = await api('PUT', '/api/v2/routing/shared', { shared: { configs: { 'relay-webhook': { type: 'webhook', urlSecret: { name: 's', key: 'url' } } } } })
    expect(r.status).toBe(400)
    expect(r.data.problems.join()).toMatch(/configs\.relay-webhook: a shared config cannot read a Secret \(urlSecret\)/)
    r = await api('PUT', '/api/v2/routing/shared', { shared: { configs: { 'relay-webhook': { type: 'webhook', url: 'http://u:p@relay/' } } } })
    expect(r.status).toBe(400)
    expect(r.data.problems.join()).toMatch(/carries a user name or password/)
  })

  it('cannot remove a config still used, and says by whom; one nobody uses can go', async () => {
    let r = await api('PUT', '/api/v2/routing/shared', { shared: { configs: { 'ops-email': { type: 'email', to: 'ops@example.com' } } } })
    expect(r.status).toBe(409)
    // A sync target uses it too, through its source.
    expect(r.data.usedBy).toEqual({ 'relay-webhook': [A, B, C, TGT] })
    r = await api('PUT', '/api/v2/routing/shared', { shared: { configs: { 'relay-webhook': { type: 'webhook', url: RELAY } } } })
    expect(r.status).toBe(200)
  })
})

// A routing.yaml that cannot be read may use any shared config: a change
// that left it behind would leave it sending to the old address.
// Cells of different deployments that send one alert to the same shared
// config: said on the Shared configs page, never refused.
describe('the same alert to one shared config from two deployments', () => {
  it('is one entry listing the deployments and their cells; a synced target is left out, counted', async () => {
    const { data } = await api('GET', '/api/v2/routing/shared')
    expect(data.overlaps).toEqual({
      overlaps: [{
        config: 'relay-webhook', count: 3, more: 0,
        deployments: [A, B, C].map(deployment => ({ deployment, cells: [{ severity: 'critical' }], more: 0 })),
      }],
      unchecked: [],
      synced: 1,
    })
  })

  it('goes once the cells cannot match one alert, and neither the save nor the commit is refused', async () => {
    const two = own => `labels:\n  severity: [critical]\n  team: [${own}]\nconfigs:\n  relay-webhook: { shared: true }\ncells:\n  - match: { severity: critical, team: ${own} }\n    configs: [relay-webhook]\n`
    // A and B both name team, with two values; C (and its target) stop using it.
    expect((await putRouting(A, two('db'))).status).toBe(200)
    expect((await putRouting(B, two('web'))).status).toBe(200)
    expect((await putRouting(C, routing('').replace('relay-webhook: { shared: true }', 'own: { type: webhook, url: http://own:8080 }').replace('configs: [relay-webhook]', 'configs: [own]'))).status).toBe(200)
    expect((await api('GET', '/api/v2/routing/shared')).data.overlaps.overlaps).toEqual([])
    // B with no team: it is no condition for B, so A's db cell and B's meet.
    const saved = await putRouting(B, routing(''))
    expect(saved.status).toBe(200)
    const { data } = await api('GET', '/api/v2/routing/shared')
    expect(data.overlaps.overlaps.map(o => o.deployments.map(d => d.deployment))).toEqual([[A, B]])
    expect((await commit()).status).toBe(200)
  })

  // Written by hand, a cell missing a label would match every value of it:
  // not compared, and said so.
  it('leaves out a routing.yaml the save would refuse, naming it', async () => {
    await write(`${B}/routing.yaml`, 'labels:\n  severity: [critical]\n  team: [db]\nconfigs:\n  relay-webhook: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [relay-webhook]\n')
    const { data } = await api('GET', '/api/v2/routing/shared')
    expect(data.overlaps.unchecked).toEqual([B])
    expect(data.overlaps.overlaps[0].deployments.map(d => d.deployment)).toEqual([A, C])
  })
})

describe('a shared config named constructor', () => {
  it('is read, used and listed like any other', async () => {
    const text = sharedText(RELAY).replace('  ops-email:', '  constructor: { type: webhook, url: http://c:8080 }\n  ops-email:')
    expect((await api('PUT', '/api/v2/routing/shared', { shared: text })).status).toBe(200)
    const r = 'labels:\n  severity: [critical]\nconfigs:\n  constructor: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [constructor]\n'
    expect((await putRouting(A, r)).status).toBe(200)
    const { status, data } = await api('GET', '/api/v2/routing/shared')
    expect(status).toBe(200)
    expect(data.usage.constructor).toEqual([{ deployment: A }])
    // Taken out while A uses it: refused, naming A.
    const gone = await api('PUT', '/api/v2/routing/shared', { shared: sharedText(RELAY) })
    expect(gone.status).toBe(409)
    expect(gone.data.usedBy).toEqual({ constructor: [A] })
  })
})

describe('a user whose routing.yaml cannot be read', () => {
  const breakB = () => write(`${B}/routing.yaml`, routing('').replace('cells:', 'cells: [\n'))

  it.each([
    ['not valid YAML', 'cells: [\n', /is not valid YAML/],
    ['not a map', null, /is not a map/],
  ])('stops a change, a rename and a removal, naming it, with nothing written (%s)', async (_, broken, why) => {
    await write(`${B}/routing.yaml`, broken ? routing('').replace('cells:', broken) : '- a list\n')
    const before = await snapshot()
    const shared = await read(SHARED)
    for (const r of [
      await api('PUT', '/api/v2/routing/shared', { shared: sharedText('http://relay.example.com:9090') }),
      await api('POST', '/api/v2/routing/shared/rename', { from: 'relay-webhook', to: 'relay' }),
      // ops-email is used by nobody readable.
      await api('PUT', '/api/v2/routing/shared', { shared: { configs: { 'relay-webhook': { type: 'webhook', url: RELAY } } } }),
    ]) {
      expect(r.status).toBe(409)
      expect(r.data.unreadable).toEqual([{ deployment: B, error: expect.stringMatching(why) }])
      expect(r.data.error).toMatch(new RegExp(`routing\\.yaml of ${B} cannot be read`))
    }
    expect(await snapshot()).toEqual(before)
    expect(await read(SHARED)).toBe(shared)
  })

  it('is listed as a problem of the shared configs', async () => {
    await breakB()
    const { data } = await api('GET', '/api/v2/routing/shared')
    expect(data.unreadable).toEqual([{ deployment: B, error: expect.stringMatching(/is not valid YAML/) }])
  })
})

describe('saving while the shared configs change', () => {
  // The routing save reads the shared configs under the commit lock: one
  // queued behind a change to them is made with the new ones.
  it('a routing saved behind a change to a shared config gets the new one', async () => {
    let release
    const held = withSyncRegistryLock(tmpDir, () => new Promise(r => { release = r }))
    const change = api('PUT', '/api/v2/routing/shared', { shared: sharedText('http://relay.example.com:9090') })
    await new Promise(r => setTimeout(r, 100))
    const save = putRouting(A, routing('  mine: { type: email, to: me@example.com }\n'))
    await new Promise(r => setTimeout(r, 100))
    release()
    await held
    expect((await change).status).toBe(200)
    expect((await save).status).toBe(200)
    for (const dep of [A, B, C]) expect(await urlIn(dep)).toBe('http://relay.example.com:9090')
    expect((await api('GET', '/api/v2/routing/shared')).data.stale).toEqual([])
  })
})

describe('a shared file that cannot be read', () => {
  // A directory where the file goes: reading it fails with EISDIR.
  const unreadable = async () => {
    await fs.rm(path.join(tmpDir, SHARED))
    await fs.mkdir(path.join(tmpDir, SHARED))
  }

  it('is its own problem: a deployment using no shared config is read and saved as before', async () => {
    expect((await putRouting(A, routing('').replace('relay-webhook: { shared: true }', 'relay-webhook: { type: webhook, url: http://own:1 }'))).status).toBe(200)
    await unreadable()
    const state = await api('GET', `/api/v2/deployments/demo/prod/routing${q(A)}`)
    expect(state.status).toBe(200)
    expect(state.data.errors).toEqual([])
    expect((await putRouting(A, routing('').replace('relay-webhook: { shared: true }', 'relay-webhook: { type: webhook, url: http://own:2 }'))).status).toBe(200)
    const { status, data } = await api('GET', '/api/v2/routing/shared')
    expect(status).toBe(200)
    expect(data.errors).toEqual(['_shared/notification-configs.yaml cannot be read (it is a folder, not a file)'])
    // B and C still use it: the commit says so, naming the file.
    const c = await commit()
    expect(c.status).toBe(409)
    expect(c.data.findings.find(f => f.kind === 'routing-shared-broken').description).toMatch(/cannot be read \(it is a folder, not a file\)/)
    expect((await api('POST', '/api/v2/routing/shared/regenerate')).status).toBe(200)
  })
})

describe.skipIf(process.getuid?.() === 0)('a write that fails midway', () => {
  it('puts every file back and names the one that could not be written, by its path in the repo', async () => {
    await fs.chmod(path.join(tmpDir, B, 'templates'), 0o555)
    try {
      const before = await snapshot()
      const shared = await read(SHARED)
      const { status, data } = await api('PUT', '/api/v2/routing/shared', { shared: sharedText('http://relay.example.com:9090') })
      expect(status).toBe(500)
      expect(data.error).toBe(`${B}/${CR} could not be written (EACCES): nothing was changed`)
      expect(JSON.stringify(data)).not.toContain(tmpDir)
      expect(await snapshot()).toEqual(before)
      expect(await read(SHARED)).toBe(shared)
    } finally {
      await fs.chmod(path.join(tmpDir, B, 'templates'), 0o755)
    }
  })
})

describe('renaming a shared config', () => {
  it('renames it in every routing.yaml using it, comments kept, and routes to the same place', async () => {
    const { status, data } = await api('POST', '/api/v2/routing/shared/rename', { from: 'relay-webhook', to: 'relay' })
    expect(status).toBe(200)
    expect(data.written).toEqual([SHARED, `${A}/routing.yaml`, `${A}/${CR}`, `${B}/routing.yaml`, `${B}/${CR}`, `${C}/routing.yaml`, `${C}/${CR}`])
    for (const dep of [A, B, C, TGT]) {
      expect(await read(`${dep}/routing.yaml`)).toBe(routing('').replaceAll('relay-webhook', 'relay'))
      const cr = await crOf(dep)
      expect(cr.spec.route.routes[0].receiver).toBe('relay')
      expect(cr.spec.receivers[1]).toEqual({ name: 'relay', webhookConfigs: [{ url: RELAY }] })
    }
    expect(await read(SHARED)).toBe(sharedText(RELAY).replace('relay-webhook', 'relay'))
    expect((await commit()).status).toBe(200)
  })

  it('is refused when a user has a config of its own by the new name', async () => {
    expect((await putRouting(A, routing('  relay: { type: email, to: r@example.com }\n'))).status).toBe(200)
    const before = await snapshot()
    const { status, data } = await api('POST', '/api/v2/routing/shared/rename', { from: 'relay-webhook', to: 'relay' })
    expect(status).toBe(409)
    expect(data.clash).toEqual([A])
    expect(await snapshot()).toEqual(before)
  })
})

describe('the shared file edited with git', () => {
  it('stops the commit, naming every deployment behind, until Regenerate makes them all again', async () => {
    await write(SHARED, sharedText('http://relay.example.com:9090'))
    const { data: state } = await api('GET', '/api/v2/routing/shared')
    expect(state.stale).toEqual([A, B, C, TGT])
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect((data.findings || []).map(f => `${f.kind} ${f.deployment}`)).toEqual([A, B, C].map(d => `routing-stale ${d}`))
    expect(data.findings[0].description).toMatch(/shared notification configs/)

    const regen = await api('POST', '/api/v2/routing/shared/regenerate')
    expect(regen.data).toEqual({ regenerated: [A, B, C, TGT], failed: [] })
    for (const dep of [A, B, C, TGT]) expect(await urlIn(dep)).toBe('http://relay.example.com:9090')
    expect((await api('GET', '/api/v2/routing/shared')).data.stale).toEqual([])
    expect((await commit()).status).toBe(200)
  })

  // The file changed under deployments that use it: nothing to send to.
  it.each([
    ['a config they use taken out', () => write(SHARED, '# s\nconfigs:\n  ops-email: { type: email, to: ops@example.com }\n'), /there is no shared config named relay-webhook/],
    ['not valid YAML', () => write(SHARED, 'configs:\n  relay-webhook: { type: webhook, url: http://x:1\n'), /has problems — fix it first/],
    ['failing its checks', () => write(SHARED, 'configs:\n  relay-webhook: { type: webhook }\n'), /has problems — fix it first/],
    ['removed', () => fs.rm(path.join(tmpDir, SHARED)), /there are no shared configs/],
  ])('stops the commit when it is %s, naming the config and each deployment using it', async (_, change, why) => {
    await change()
    const { status, data } = await commit()
    expect(status).toBe(409)
    const unresolved = data.findings.filter(f => f.kind === 'routing-shared-unresolved')
    expect(unresolved.map(f => f.deployment)).toEqual([A, B, C])
    for (const f of unresolved) expect(f.description).toMatch(/configs\.relay-webhook: /)
    for (const f of unresolved) expect(f.description).toMatch(why)
    expect(unresolved.every(f => f.regenerable === false)).toBe(true)
  })

  it('names the shared file itself when it has problems and is used', async () => {
    await write(SHARED, 'configs:\n  relay-webhook: { type: webhook }\n')
    const { data } = await commit()
    const file = data.findings.find(f => f.kind === 'routing-shared-broken')
    expect(file.deployment).toBe(SHARED)
    expect(file.description).toMatch(new RegExp(`used by ${A}, ${B}, ${C}: configs\\.relay-webhook: a webhook has either url or urlSecret`))
  })

  // A shared config that notifies nobody: saved, and said on the shared
  // page, on each routing that uses it, and in the commit.
  it('says a shared config notifies nobody, everywhere it is used, never refusing', async () => {
    const text = sharedText(RELAY).replace('ops-email: { type: email, to: ops@example.com }', 'ops-email: { type: email, to: "undisclosed-recipients:;" }')
    const save = await api('PUT', '/api/v2/routing/shared', { shared: text })
    expect(save.status).toBe(200)
    const said = 'configs.ops-email: to "undisclosed-recipients:;" is a group with no members — this config notifies nobody'
    expect(save.data.warnings).toEqual([said])
    expect((await api('GET', '/api/v2/routing/shared')).data.warnings).toEqual([said])
    expect((await putRouting(A, routing('  ops-email: { shared: true }\n'))).data.warnings).toEqual([said.replace('configs.ops-email:', 'configs.ops-email (shared):')])
    const { status, data } = await commit()
    expect(status).toBe(200)
    expect(data.routingWarnings.map(w => w.deployment)).toEqual([A, SHARED])
  })

  // A shared config has no password (it would be a Secret): a server of its
  // own is taken, saying it is handed the platform's login.
  it('takes a shared e-mail config with its own SMTP server, warning whose login it gets', async () => {
    const text = sharedText(RELAY).replace('ops-email: { type: email, to: ops@example.com }', 'ops-email: { type: email, to: ops@example.com, smarthost: relay.example.com:25 }')
    const save = await api('PUT', '/api/v2/routing/shared', { shared: text })
    expect(save.status).toBe(200)
    expect(save.data.warnings).toEqual([expect.stringContaining('configs.ops-email: smarthost relay.example.com:25 has no login of its own')])
  })

  // A shared config has no password, so no identity or secret of its own.
  it('refuses a shared e-mail config with authIdentity or authSecret', async () => {
    for (const extra of ['authIdentity: ops', 'authSecret: { name: s, key: cram }']) {
      const text = sharedText(RELAY).replace('ops-email: { type: email, to: ops@example.com }', `ops-email: { type: email, to: ops@example.com, ${extra} }`)
      const save = await api('PUT', '/api/v2/routing/shared', { shared: text })
      expect(save.status, extra).toBe(400)
      expect(JSON.stringify(save.data), extra).toMatch(/a shared config cannot use auth(Identity|Secret)/)
    }
  })

  it('lists a shared file with problems that nobody uses, and lets the commit through', async () => {
    for (const dep of [A, B, C]) expect((await api('DELETE', `/api/v2/deployments/demo/${path.basename(dep)}/routing${q(dep)}`)).status).toBe(200)
    await write(SHARED, 'configs:\n  relay-webhook: { type: webhook }\n')
    const { status, data } = await commit()
    expect(status).toBe(200)
    expect(data.routingProblems.map(p => p.deployment)).toEqual([SHARED])
  })
})

describe('the _shared folder', () => {
  it('is no deployment and no sync target, and is not in the tree', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: '_shared/x', chart: 'demo' })).status).toBe(400)
    expect((await api('POST', '/api/v2/sync', { source: C, target: '_shared/x' })).status).toBe(400)
    const { data } = await api('GET', '/api/v2/folders/tree')
    expect(JSON.stringify(data)).not.toMatch(/_shared/)
  })

  it('lists no deployment from it, for sync or for the commit checks', async () => {
    const list = await api('GET', '/api/v2/folders/deployments')
    expect(JSON.stringify(list.data)).not.toMatch(/_shared/)
    expect((await api('POST', '/api/v2/folders', { path: '_shared/x' })).status).toBe(400)
  })

  // A repo that already had a _shared/ of its own, with a deployment in it:
  // that folder stays the repo's, as any existing folder does (#99), and the
  // shared configs are refused until it is renamed.
  it('of the repo\'s own, with a deployment in it, stays an ordinary folder', async () => {
    await fs.rm(path.join(tmpDir, '_shared'), { recursive: true })
    const own = '_shared/team/prod'
    expect((await api('POST', '/api/v2/folders/init', { folder: own, chart: 'demo' })).status).toBe(400)
    // Made as it would have been before: by hand.
    await fs.mkdir(path.join(tmpDir, own), { recursive: true })
    await fs.copyFile(path.join(tmpDir, A, 'Chart.yaml'), path.join(tmpDir, own, 'Chart.yaml'))
    await fs.copyFile(path.join(tmpDir, A, 'values.yaml'), path.join(tmpDir, own, 'values.yaml'))
    expect(JSON.stringify((await api('GET', '/api/v2/folders/tree')).data)).toMatch(/_shared/)
    expect(JSON.stringify((await api('GET', '/api/v2/folders/deployments')).data)).toContain(own)
    // A source whose routing needs no shared configs (they are gone with _shared/).
    expect((await api('DELETE', `/api/v2/deployments/demo/prod/routing${q(B)}`)).status).toBe(200)
    const sync = await api('POST', '/api/v2/sync', { source: B, target: own })
    expect(sync.status).toBe(200)
    const { status, data } = await api('PUT', '/api/v2/routing/shared', { shared: sharedText(RELAY) })
    expect(status).toBe(409)
    expect(data.error).toMatch(/rename it/)
  })

  it('is refused when it is one of the repo\'s own folders', async () => {
    await fs.mkdir(path.join(tmpDir, '_shared', 'mine'), { recursive: true })
    const { status, data } = await api('PUT', '/api/v2/routing/shared', { shared: sharedText(RELAY) })
    expect(status).toBe(409)
    expect(data.error).toMatch(/_shared\/ is a folder of this repo's .*rename it/)
    // …and then shown in the tree as the folder it is.
    expect(JSON.stringify((await api('GET', '/api/v2/folders/tree')).data)).toMatch(/_shared/)
  })
})

// Two deployments' resources carry the same shared config as a receiver of
// the same name. The operator prefixes each receiver with its resource's
// namespace and name, so in Alertmanager's configuration they do not clash.
describe.skipIf(!HAS_AMTOOL)(amtoolTitle('two deployments using one shared config'), () => {
  it('give a configuration amtool accepts', async () => {
    const specs = await Promise.all([A, B].map(async d => (await crOf(d)).spec))
    const configs = specs.map((spec, i) => {
      const prefix = `ns${i}/${[A, B][i].replaceAll('/', '-')}-routing/`
      const rename = r => ({ ...r, ...(r.receiver ? { receiver: prefix + r.receiver } : {}), ...(r.routes ? { routes: r.routes.map(rename) } : {}) })
      return toAlertmanagerConfig({ route: rename(spec.route), receivers: spec.receivers.map(r => ({ ...r, name: prefix + r.name })) })
    })
    const merged = {
      ...configs[0],
      route: { ...configs[0].route, routes: [configs[0].route.routes[0], configs[1].route.routes[0]] },
      receivers: [...configs[0].receivers, ...configs[1].receivers.filter(r => !['platform-default', 'other-team'].includes(r.name))],
    }
    expect(merged.receivers.filter(r => r.name.endsWith('/relay-webhook'))).toHaveLength(2)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-amtool-'))
    try {
      await fs.writeFile(path.join(dir, 'alertmanager.yml'), yaml.dump(merged))
      expect(() => execFileSync('amtool', ['check-config', path.join(dir, 'alertmanager.yml')], { stdio: 'pipe' })).not.toThrow()
      // One alert, both deployments' cells: the shared webhook is notified
      // once through each receiver — the reason the Shared configs page says so.
      const routed = execFileSync('amtool', ['config', 'routes', 'test', `--config.file=${path.join(dir, 'alertmanager.yml')}`, 'severity=critical'], { encoding: 'utf-8' })
      expect(routed.trim().split(',').filter(r => r.endsWith('/relay-webhook'))).toHaveLength(2)
      // Without the prefix, the two would clash: amtool refuses that.
      await fs.writeFile(path.join(dir, 'clash.yml'), yaml.dump({ ...merged, receivers: [...merged.receivers, { name: merged.receivers.at(-1).name }] }))
      expect(() => execFileSync('amtool', ['check-config', path.join(dir, 'clash.yml')], { stdio: 'pipe' })).toThrow()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
