// A deployment's routing and the shared notification configs, as every
// entry point reads them (server/repo/routing.js, shared.js), and what each
// entry point's table does with them (routingPolicy.js).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openRepo } from '../../../server/repo/openRepo.js'
import { loadRouting, commonResource, buildRouting, ROUTING_CR_FILE } from '../../../server/repo/routing.js'
import { loadShared, loadSharedDir, sharedDirProblemOf, sharedForBuild } from '../../../server/repo/shared.js'
import { decide, explain } from '../../../server/repo/policy.js'
import { ROUTING_POLICIES } from '../../../server/repo/routingPolicy.js'
import { listRoutingCases, generateRoutingCase, ROUTING_CASES_DIR } from '../../blind/harness.js'
import { routingFindings } from '../../../server/lib/commit/routing.js'

const IS_ROOT = process.getuid?.() === 0
const DEP = 'deployments/t/a'
const ROUTING = 'labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ops@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n'
const SHARED = 'configs:\n  relay: { type: webhook, url: "http://relay.example.com:8080" }\n'

let repo
beforeEach(() => {
  delete process.env.RULE_OBJECT_LABELS
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-routing-'))
  fs.mkdirSync(path.join(repo, DEP, 'templates'), { recursive: true })
})
afterEach(() => {
  fs.chmodSync(repo, 0o755)
  fs.rmSync(repo, { recursive: true, force: true })
})
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
const load = () => loadRouting(openRepo(repo), DEP)
const codes = loaded => loaded.findings.map(f => f.code)
const saved = text => { write(`${DEP}/routing.yaml`, text); write(`${DEP}/${ROUTING_CR_FILE}`, buildRouting(text).cr) }

describe('a deployment\'s routing', () => {
  it('as saved: its text, the resource it makes, nothing to say', async () => {
    saved(ROUTING)
    const r = await load()
    expect(r.state).toBe('ok')
    expect(r.value).toMatchObject({ dep: DEP, text: ROUTING, stale: false, errors: [], uses: [] })
    expect(r.value.made).toBe(r.value.cr)
    expect(codes(r)).toEqual([])
  })

  it('neither file: absent, naming routing.yaml', async () => {
    const r = await load()
    expect(r).toMatchObject({ state: 'absent', file: `${DEP}/routing.yaml` })
  })

  it('a resource left without its routing.yaml is deployed: a finding Helm deploys otherwise than written', async () => {
    write(`${DEP}/${ROUTING_CR_FILE}`, buildRouting(ROUTING).cr)
    const r = await load()
    expect(r.value.text).toBe(null)
    expect(r.findings).toMatchObject([{ code: 'routing.orphaned', file: `${DEP}/${ROUTING_CR_FILE}`, helm: 'renders-differently' }])
  })

  it('a resource behind its routing.yaml, edited by hand', async () => {
    saved(ROUTING)
    write(`${DEP}/routing.yaml`, ROUTING.replace('ops@', 'oncall@'))
    const r = await load()
    expect(r.value.stale).toBe(true)
    expect(codes(r)).toEqual(['routing.stale'])
  })

  it('not YAML, or refused by the save checks: a problem of routing.yaml\'s own, the resource behind', async () => {
    saved(ROUTING)
    write(`${DEP}/routing.yaml`, 'labels: [\n')
    const r = await load()
    expect(r.value).toMatchObject({ doc: null, stale: true, usesUnknown: expect.stringMatching(/not valid YAML/) })
    expect(r.findings).toMatchObject([{ code: 'routing.problem', helm: 'n/a', message: expect.stringMatching(/^routing\.yaml is not valid YAML/) }])
  })

  it('a shared config the shared file does not give', async () => {
    saved(ROUTING)
    write(`${DEP}/routing.yaml`, ROUTING.replace('ops: { type: email, to: ops@example.com }', 'ops: { shared: true }'))
    const r = await load()
    expect(r.value.uses).toEqual(['ops'])
    expect(codes(r)).toEqual(['routing.shared-unresolved', 'routing.problem'])
  })

  it('uses the shared configs of the same snapshot', async () => {
    write('_shared/notification-configs.yaml', SHARED)
    write(`${DEP}/routing.yaml`, ROUTING.replace('ops: { type: email, to: ops@example.com }', 'relay: { shared: true }').replace('configs: [ops]', 'configs: [relay]'))
    write(`${DEP}/${ROUTING_CR_FILE}`, 'made before\n')
    const r = await load()
    expect(r.value.uses).toEqual(['relay'])
    expect(r.value.stale).toBe(true)
    expect(r.value.made).toContain('relay.example.com')
  })

  it.skipIf(IS_ROOT)('routing.yaml that cannot be read: unreadable, never "no routing"', async () => {
    saved(ROUTING)
    fs.chmodSync(path.join(repo, DEP, 'routing.yaml'), 0)
    try {
      expect(await load()).toMatchObject({ state: 'unreadable', file: `${DEP}/routing.yaml`, why: 'permission denied' })
    } finally {
      fs.chmodSync(path.join(repo, DEP, 'routing.yaml'), 0o644)
    }
  })

  it('a folder, a link to nothing, a link out of the repo: unreadable, saying which', async () => {
    const out = path.join(os.tmpdir(), `routing-outside-${process.pid}.yaml`)
    fs.writeFileSync(out, ROUTING)
    try {
      for (const [make, why] of [
        [abs => fs.mkdirSync(abs), 'it is a folder, not a file'],
        [abs => fs.symlinkSync('nowhere.yaml', abs), 'a link to a file that is not there'],
        [abs => fs.symlinkSync(out, abs), 'it is a link that leads outside the repo'],
      ]) {
        const abs = path.join(repo, DEP, 'routing.yaml')
        fs.rmSync(abs, { recursive: true, force: true })
        make(abs)
        expect(await load()).toMatchObject({ state: 'unreadable', why })
      }
    } finally {
      fs.rmSync(out, { force: true })
    }
  })

  it('a link inside the repo is read through', async () => {
    write('deployments/t/c/routing.yaml', ROUTING)
    fs.symlinkSync('../c/routing.yaml', path.join(repo, DEP, 'routing.yaml'))
    expect((await load()).value.text).toBe(ROUTING)
  })

  it.skipIf(IS_ROOT)('a resource that cannot be read: a finding Helm fails on, routing.yaml still read', async () => {
    saved(ROUTING)
    fs.chmodSync(path.join(repo, DEP, ROUTING_CR_FILE), 0)
    const r = await load()
    expect(r.value.text).toBe(ROUTING)
    expect(r.findings).toMatchObject([{ code: 'routing.cr-unreadable', helm: 'fails', message: `${DEP}/${ROUTING_CR_FILE} cannot be read (permission denied)` }])
  })

  it('is read once per snapshot', async () => {
    saved(ROUTING)
    const r = openRepo(repo)
    expect(await loadRouting(r, DEP)).toBe(await loadRouting(r, `${DEP}/`))
  })

  it('a _common chart outside the repo is named, not a crash', async () => {
    expect(await commonResource(openRepo(repo), '../../elsewhere/_common/x')).toMatchObject({ code: 'routing.common-resource', helm: 'unknown', message: expect.stringMatching(/is outside the repo/) })
  })

  it('an AlertmanagerConfig in a _common chart\'s templates/ is named', async () => {
    expect(await commonResource(openRepo(repo), 'deployments/t/_common/demo')).toBe(null)
    write(`deployments/t/_common/demo/${ROUTING_CR_FILE}`, 'kind: AlertmanagerConfig\n')
    expect(await commonResource(openRepo(repo), 'deployments/t/_common/demo')).toMatchObject({ code: 'routing.common-resource', helm: 'renders-differently', file: `deployments/t/_common/demo/${ROUTING_CR_FILE}` })
  })
})

describe('the commit check of one deployment', () => {
  const NONE = { syncs: [] }
  it('says a deployment once in its problems: a _common chart\'s resource and its own routing.yaml\'s', async () => {
    write(`deployments/t/_common/demo/${ROUTING_CR_FILE}`, 'kind: AlertmanagerConfig\n')
    saved(ROUTING)
    write(`${DEP}/routing.yaml`, 'labels: [\n')
    const out = await routingFindings(openRepo(repo), DEP, { registry: NONE, layers: [{ path: 'deployments/t/_common/demo' }] })
    expect(out.problems.map(p => p.deployment)).toEqual([DEP])
    expect(out.problems[0].errors).toEqual([expect.stringMatching(/_common\/demo\/templates\/alertmanagerconfig\.yaml is deployed with every deployment/), expect.stringMatching(/^routing\.yaml is not valid YAML/)])
  })

  it.skipIf(IS_ROOT)('names every refusal at once: a shared config not given and a resource it cannot read', async () => {
    write(`${DEP}/routing.yaml`, ROUTING.replace('ops: { type: email, to: ops@example.com }', 'ops: { shared: true }'))
    write(`${DEP}/${ROUTING_CR_FILE}`, 'old\n')
    fs.chmodSync(path.join(repo, DEP, ROUTING_CR_FILE), 0)
    try {
      const out = await routingFindings(openRepo(repo), DEP, { registry: NONE })
      expect(out.findings.map(f => f.kind).sort()).toEqual(['file-unreadable', 'routing-shared-unresolved'])
    } finally {
      fs.chmodSync(path.join(repo, DEP, ROUTING_CR_FILE), 0o644)
    }
  })
})

describe('every routing case', () => {
  // The resource the loader makes is the one the blind tests render and
  // route with amtool (tests/integration/routing-blind.test.js), byte for byte.
  it.each(listRoutingCases())('%s: the resource made is the blind test\'s', async name => {
    const dir = path.join(ROUTING_CASES_DIR, name)
    const metaFile = path.join(dir, 'object-meta.json')
    const env = { RULE_OBJECT_LABELS: undefined, RULE_OBJECT_ANNOTATIONS: undefined, RULE_OBJECT_LABELS_BY_PROFILE: undefined, RULE_OBJECT_ANNOTATIONS_BY_PROFILE: undefined }
    if (fs.existsSync(metaFile)) {
      const site = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      const names = { labels: 'RULE_OBJECT_LABELS', annotations: 'RULE_OBJECT_ANNOTATIONS', labelsByProfile: 'RULE_OBJECT_LABELS_BY_PROFILE', annotationsByProfile: 'RULE_OBJECT_ANNOTATIONS_BY_PROFILE' }
      for (const [k, v] of Object.entries(site)) env[names[k]] = JSON.stringify(v)
    }
    const before = { ...process.env }
    try {
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      write(`${DEP}/routing.yaml`, fs.readFileSync(path.join(dir, 'routing.yaml'), 'utf-8'))
      if (fs.existsSync(path.join(dir, 'shared.yaml'))) write('_shared/notification-configs.yaml', fs.readFileSync(path.join(dir, 'shared.yaml'), 'utf-8'))
      const r = await load()
      expect(r.value.errors).toEqual([])
      expect(r.value.made).toBe(generateRoutingCase(name))
    } finally {
      for (const k of Object.keys(env)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k] }
    }
  })
})

describe('the shared configs', () => {
  it('none: absent; the generator is given none', async () => {
    const s = await loadShared(openRepo(repo))
    expect(s.state).toBe('absent')
    expect(sharedForBuild(s)).toBe(null)
  })

  it('read and checked: problems are findings of the file\'s own, Helm never reads it', async () => {
    write('_shared/notification-configs.yaml', 'configs: [\n')
    const s = await loadShared(openRepo(repo))
    expect(s.value.errors[0]).toMatch(/is not valid YAML/)
    expect(s.findings).toMatchObject([{ code: 'shared.problem', helm: 'n/a' }])
  })

  it('a folder where the file should be: unreadable, and a problem for whoever uses it', async () => {
    fs.mkdirSync(path.join(repo, '_shared/notification-configs.yaml'), { recursive: true })
    const s = await loadShared(openRepo(repo))
    expect(s).toMatchObject({ state: 'unreadable', why: 'it is a folder, not a file' })
    expect(sharedForBuild(s).errors).toEqual(['_shared/notification-configs.yaml cannot be read (it is a folder, not a file)'])
  })

  it('_shared/ holding other files is the repo\'s own folder', async () => {
    write('_shared/notification-configs.yaml', SHARED)
    expect(sharedDirProblemOf(await loadSharedDir(openRepo(repo)))).toBe(null)
    write('_shared/notes.txt', 'mine\n')
    expect(sharedDirProblemOf(await loadSharedDir(openRepo(repo)))).toMatch(/^_shared\/ is a folder of this repo's \(it holds notes\.txt\)/)
  })
})

describe('each entry point\'s table', () => {
  const f = code => ({ code, helm: { 'routing.orphaned': 'renders-differently', 'routing.stale': 'renders-differently', 'routing.cr-unreadable': 'fails', 'routing.common-resource': 'renders-differently', 'routing.warning': 'renders' }[code] ?? 'n/a', message: code, file: '' })
  const actions = (policy, list) => Object.fromEntries(list.map(c => [c, explain(f(c), ROUTING_POLICIES[policy]).action]))
  const ALL = ['routing.orphaned', 'routing.cr-unreadable', 'routing.shared-unresolved', 'routing.problem', 'routing.stale', 'routing.warning', 'routing.common-resource']

  it('Commit blocks what it blocked, lists routing.yaml\'s own problems and a _common\'s resource', () => {
    expect(actions('commit', ALL)).toEqual({
      'routing.orphaned': 'refuse', 'routing.cr-unreadable': 'refuse', 'routing.shared-unresolved': 'refuse',
      'routing.problem': 'list', 'routing.stale': 'refuse', 'routing.warning': 'warn', 'routing.common-resource': 'list',
    })
  })

  it('check-deployment fails on anything deployed otherwise than routing.yaml says', () => {
    expect(actions('checkDeployment', ALL)).toEqual({
      'routing.orphaned': 'refuse', 'routing.cr-unreadable': 'refuse', 'routing.shared-unresolved': 'ignore',
      'routing.problem': 'refuse', 'routing.stale': 'refuse', 'routing.warning': 'warn', 'routing.common-resource': 'refuse',
    })
  })

  it('a save is stopped only by a resource it cannot replace; a sync copy by a routing.yaml it would spread broken', () => {
    expect(decide(ALL.map(f), ROUTING_POLICIES.routingSave).refuse.map(x => x.code)).toEqual(['routing.cr-unreadable'])
    expect(decide(ALL.map(f), ROUTING_POLICIES.syncCopy).refuse.map(x => x.code)).toEqual(['routing.orphaned', 'routing.problem', 'routing.common-resource'])
  })

  it('the Routing page refuses what it cannot show as the file, lists the rest', () => {
    expect(actions('routingPage', ALL)).toMatchObject({ 'routing.orphaned': 'refuse', 'routing.cr-unreadable': 'refuse', 'routing.problem': 'list', 'routing.stale': 'list', 'routing.warning': 'warn' })
  })
})
