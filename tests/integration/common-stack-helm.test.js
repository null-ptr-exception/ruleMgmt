// What AlertForge says a deployment on a _common stack renders is what Helm
// renders, or AlertForge reports a problem (#100). Each case is a layout
// Helm was run on; `helm` is what Helm 3.15.4 and 3.19.0 rendered from it,
// written by hand: the number of alerts, 0 when it renders nothing, 'error'
// when it stops, 'varies' when the two versions differ (a hand-written
// null). `js` is what AlertForge must do: 'same' — the values it works out
// for the Template render exactly Helm's alerts, with no problem — or the
// problem it reports, or 'value' — a value issue in a file.
// Run with HELM_BIN set to each version. A layout AlertForge makes runs
// helm several times (before and after each change): a minute, not 5 s.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'
import { resolveStack } from '../../server/lib/stack.js'
import { openRepo } from '../../server/repo/openRepo.js'
import { loadDeployment } from '../../server/repo/deployment.js'
import { findingsOf } from '../../server/repo/loaded.js'
import { deploymentOnCommon } from '../../server/lib/commonEdit.js'
import { planChange, applyChange } from '../../server/repo/changes/index.js'

const HELM = process.env.HELM_BIN || 'helm'
const HAS_HELM = (() => { try { execFileSync(HELM, ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const C = 'mariadb-alerts'
const DISK = 'mariadb_saturation_disk'
const CPU = 'mariadb_saturation_cpu'
const SAMPLE = path.resolve('sample/charts', C)
const L1 = `shop/_common/${C}`
const L2 = `shop/b/_common/${C}`
const L3 = `shop/b/c/_common/${C}`
const DEP = ['shop/d', 'shop/b/d', 'shop/b/c/d']

let work, empty
beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'common-stack-helm-'))
  const groups = Object.entries(yaml.load(await fs.readFile(path.join(SAMPLE, 'values.yaml'), 'utf-8'))).filter(([, v]) => Array.isArray(v)).map(([k]) => k)
  empty = Object.fromEntries(groups.map(g => [g, []]))
})
afterAll(async () => { if (work) await fs.rm(work, { recursive: true, force: true }) })

// One repo per case.
function repo(name) {
  const root = path.join(work, name.replace(/[^a-z0-9]+/gi, '-'))
  const abs = rel => path.join(root, rel)
  const write = async (rel, doc) => {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true })
    await fs.writeFile(abs(rel), typeof doc === 'string' ? doc : yaml.dump(doc))
  }
  const link = async (fromLayer, entry, toDir) => {
    await fs.mkdir(abs(`${fromLayer}/charts`), { recursive: true })
    await fs.symlink(path.relative(abs(`${fromLayer}/charts`), abs(toDir)), abs(`${fromLayer}/charts/${entry}`))
  }
  const common = async (rel, below, belowDir, values, { name = 'common', dep = {}, linkAs = below } = {}) => {
    await write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name, version: '0.1.0', dependencies: [{ name: below, version: '>=0.0.0-0', ...dep }] })
    if (linkAs) await link(rel, linkAs, belowDir)
    await write(`${rel}/values.yaml`, values)
  }
  const fileDep = (from, to, name = 'common', extra = {}) => ({ name, version: '>=0.0.0-0', repository: `file://${path.relative(abs(from), abs(to))}`, ...extra })
  const deployment = (rel, deps, values) => Promise.all([
    write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name: path.basename(rel), version: '0.1.0', dependencies: deps }),
    write(`${rel}/values.yaml`, values),
  ])
  const wrap = (n, v) => { let o = v; for (let i = 0; i < n; i++) o = { common: o }; return o }
  // shop's _common: owner team-a, namespace c1, disk 85 and 86, cpu 70;
  // one layer above another for each level asked.
  const base = async (levels = 1, over = {}) => {
    await fs.cp(SAMPLE, abs(`charts/${C}`), { recursive: true })
    await common(L1, C, `charts/${C}`, { [C]: { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 85, critical_pct: 95 }, { warn_pct: 86, critical_pct: 96 }], [CPU]: [{ warn_pct: 70, critical_pct: 90 }], ...over.l1 } })
    if (levels >= 2) await common(L2, 'common', L1, wrap(1, { [C]: { _common: { namespace: 'c2' }, ...over.l2 } }))
    if (levels >= 3) await common(L3, 'common', L2, wrap(2, { [C]: { _common: { owner: 'team-c' }, ...over.l3 } }))
  }
  const onLayer = (n, values) => deployment(DEP[n - 1], [fileDep(DEP[n - 1], [L1, L2, L3][n - 1])], wrap(n, { [C]: values }))
  // A stack AlertForge makes or takes apart (#101): what it writes, all of it.
  const template = () => fs.cp(SAMPLE, abs(`charts/${C}`), { recursive: true })
  const direct = (rel, values) => deployment(rel, [fileDep(rel, `charts/${C}`, C)], { [C]: values })
  const apply = async change => {
    const out = await applyChange(await planChange(openRepo(root), { kind: 'common', ...change }))
    if (out.status !== 200) throw new Error(JSON.stringify(out.body))
  }
  const make = folder => apply({ action: 'create', folder, chart: C })
  const drop = rel => apply({ action: 'delete', path: rel })
  const born = async rel => {
    const made = await deploymentOnCommon(root, rel, C)
    await write(`${rel}/Chart.yaml`, made.chartYaml)
    await write(`${rel}/values.yaml`, made.valuesYaml)
  }
  return { root, abs, write, link, common, fileDep, deployment, wrap, base, onLayer, template, direct, make, drop, born }
}

const cases = [
  // name, layout, Helm's alerts (hand-written), what AlertForge must say
  ['no _common: the Template directly', async r => {
    await r.base(1); await r.deployment('shop/d', [r.fileDep('shop/d', `charts/${C}`, C)], { [C]: { _common: { owner: 'x', namespace: 'n' }, ...empty, [CPU]: [{ warn_pct: 1, critical_pct: 2 }] } })
  }, 2, 'same'],
  ['one layer, inherit', async r => { await r.base(1); await r.onLayer(1, {}) }, 6, 'same'],
  ['one layer, own owner and disk', async r => { await r.base(1); await r.onLayer(1, { _common: { owner: 'mine' }, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] }) }, 4, 'same'],
  ['one layer, deployment clears disk', async r => { await r.base(1); await r.onLayer(1, { [DISK]: [] }) }, 2, 'same'],
  ['two layers, inherit', async r => { await r.base(2); await r.onLayer(2, {}) }, 6, 'same'],
  ['two layers, middle layer clears disk', async r => { await r.base(2, { l2: { [DISK]: [] } }); await r.onLayer(2, {}) }, 2, 'same'],
  ['three layers, own disk', async r => { await r.base(3); await r.onLayer(3, { [DISK]: [{ warn_pct: 80, critical_pct: 92 }] }) }, 4, 'same'],
  ['_common gives no [] for the other groups: the example rows render', async r => {
    await r.base(1); await r.write(`${L1}/values.yaml`, { [C]: { _common: { owner: 'team-a', namespace: 'c1' }, [DISK]: [{ warn_pct: 85, critical_pct: 95 }] } }); await r.onLayer(1, {})
  }, 20, 'same'],
  ['middle layer has an empty values.yaml', async r => { await r.base(2); await r.write(`${L2}/values.yaml`, ''); await r.onLayer(2, {}) }, 6, 'same'],
  ['middle layer values not under the next key: Helm passes none of them down', async r => {
    await r.base(2); await r.write(`${L2}/values.yaml`, { [C]: { [DISK]: [{ warn_pct: 50, critical_pct: 60 }] } }); await r.onLayer(2, {})
  }, 6, 'same'],
  ['first layer values not under the Template key', async r => {
    await r.base(1); await r.write(`${L1}/values.yaml`, { _common: { owner: 'flat', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 85, critical_pct: 95 }] }); await r.onLayer(1, {})
  }, 20, 'same'],
  // Helm renders what the layers give; what the deployment wrote reaches no Template: said.
  ['the deployment wraps one level short', async r => { await r.base(2); await r.deployment('shop/b/d', [r.fileDep('shop/b/d', L2)], { common: { [C]: { [DISK]: [] } } }) }, 6, 'value'],
  ['a link under another folder name', async r => {
    await r.base(1); await fs.rm(r.abs(`${L1}/charts`), { recursive: true }); await r.link(L1, 'tpl', `charts/${C}`); await r.onLayer(1, {})
  }, 6, 'same'],
  ['the _common link asks a version the Template is not at', async r => { await r.base(1); await r.write(`${L1}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: C, version: '9.9.9' }] }); await r.onLayer(1, {}) }, 6, 'same'],
  ['the _common folder is a link', async r => {
    await r.base(1); await fs.rename(r.abs('shop/_common'), r.abs('shop/real-common')); await fs.symlink('real-common', r.abs('shop/_common')); await r.onLayer(1, {})
    // Helm renders through it; a hand-made link is not supported, and said.
  }, 6, /shop\/_common is a link to shop\/real-common — a _common reached through a link made by hand is not supported, and nothing is written to it: replace the link with a folder of its own in git$/m],
  ['a _common named as the deployment asks (shared)', async r => {
    await r.base(1); await r.write(`${L1}/Chart.yaml`, { apiVersion: 'v2', name: 'shared', version: '0.1.0', dependencies: [{ name: C, version: '>=0.0.0-0' }] })
    await r.deployment('shop/d', [r.fileDep('shop/d', L1, 'shared')], { shared: { [C]: { _common: { owner: 'mine' } } } })
  }, 6, 'same'],
  ['the deployment\'s dependency has an alias', async r => {
    await r.base(1); await r.deployment('shop/d', [r.fileDep('shop/d', L1, 'common', { alias: 'base' })], { base: { [C]: { _common: { owner: 'aliased' } } }, common: { [C]: { _common: { owner: 'named' } } } })
  }, 6, 'same'],
  ['the _common\'s dependency has an alias, its values under it', async r => {
    await r.base(1)
    await r.write(`${L1}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: C, alias: 'tpl', version: '>=0.0.0-0' }] })
    await r.write(`${L1}/values.yaml`, { tpl: { _common: { owner: 'via-alias', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 85, critical_pct: 95 }] } })
    await r.deployment('shop/d', [r.fileDep('shop/d', L1)], { common: { tpl: {} } })
  }, 2, 'same'],
  ['another chart listed first, then the _common', async r => {
    await r.base(1); await r.write('charts/other/Chart.yaml', { apiVersion: 'v2', name: 'other', version: '0.1.0' })
    await r.deployment('shop/d', [r.fileDep('shop/d', 'charts/other', 'other'), r.fileDep('shop/d', L1)], { common: { [C]: {} } })
  }, 6, 'same'],
  ['a _common whose own Chart.yaml depends on something else, its charts/ link still there', async r => {
    await r.base(2); await r.write(`${L1}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: 'common', version: '>=0.0.0-0', repository: `file://${path.relative(r.abs(L1), r.abs(L2))}` }] })
    await r.onLayer(2, {})
  }, 6, 'same'],
  ['made by AlertForge: a _common over a deployment on the Template', async r => {
    await r.template(); await r.direct('shop/d', { _common: { owner: 'x', namespace: 'n' }, ...empty, [CPU]: [{ warn_pct: 1, critical_pct: 2 }] }); await r.make('shop')
  }, 2, 'same'],
  ['made by AlertForge: the deployment wrote no groups, its example rows kept', async r => {
    await r.template(); await r.direct('shop/d', { _common: { owner: 'x', namespace: 'n' } }); await r.make('shop')
  }, 20, 'same'],
  ['made by AlertForge: a second level, and an own disk row under it', async r => {
    await r.template(); await r.direct('shop/b/d', { _common: { owner: 'x', namespace: 'n' }, ...empty, [DISK]: [{ warn_pct: 1, critical_pct: 2 }] })
    await r.make('shop'); await r.make('shop/b')
  }, 2, 'same'],
  ['made by AlertForge: above a folder that has one', async r => {
    await r.template(); await r.direct('shop/b/d', { _common: { owner: 'x', namespace: 'n' }, ...empty, [DISK]: [{ warn_pct: 1, critical_pct: 2 }] })
    await r.make('shop/b'); await r.make('shop')
  }, 2, 'same'],
  ['made by AlertForge, then removed: the deployment on the Template again', async r => {
    await r.template(); await r.direct('shop/d', { _common: { owner: 'x', namespace: 'n' }, ...empty, [CPU]: [{ warn_pct: 1, critical_pct: 2 }] })
    await r.make('shop'); await r.drop(L1)
  }, 2, 'same'],
  ['removed by AlertForge: what the deployment inherited copied into it', async r => {
    await r.base(1); await r.onLayer(1, { _common: { owner: 'mine' }, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] }); await r.drop(L1)
  }, 4, 'same'],
  ['removed by AlertForge: the middle of three levels', async r => {
    await r.base(3, { l2: { [CPU]: [] } }); await r.onLayer(3, { [DISK]: [{ warn_pct: 80, critical_pct: 92 }] }); await r.drop(L2)
  }, 2, 'same'],
  ['a new deployment made under a _common: it inherits everything', async r => { await r.base(1); await r.born('shop/d') }, 6, 'same'],
  ['a new deployment made under two levels', async r => { await r.base(2, { l2: { [CPU]: [] } }); await r.born('shop/b/d') }, 4, 'same'],
  ['a condition that is true', async r => { await r.base(1); await r.deployment('shop/d', [r.fileDep('shop/d', L1, 'common', { condition: 'common.enabled' })], { common: { enabled: true, [C]: {} } }) }, 6, 'same'],

  ['the _common depends on the Template by file:// with no link', async r => {
    await r.base(1); await fs.rm(r.abs(`${L1}/charts`), { recursive: true })
    await r.write(`${L1}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: C, version: '>=0.0.0-0', repository: `file://${path.relative(r.abs(L1), r.abs(`charts/${C}`))}` }] })
    await r.onLayer(1, {})
  }, 0, /the _common chart shop\/_common\/mariadb-alerts has no link to its Template mariadb-alerts/],
  ['the link to the Template gone', async r => { await r.base(1); await fs.rm(r.abs(`${L1}/charts/${C}`)); await r.onLayer(1, {}) }, 0, /has no link to its Template/],
  ['the link in the second layer gone', async r => { await r.base(2); await fs.rm(r.abs(`${L2}/charts/common`)); await r.onLayer(2, {}) }, 0, /shop\/b\/_common\/mariadb-alerts has no link to the chart common/],
  ['the second layer depends on the first by file:// with no link', async r => {
    await r.base(2); await fs.rm(r.abs(`${L2}/charts`), { recursive: true })
    await r.write(`${L2}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: 'common', version: '>=0.0.0-0', repository: `file://${path.relative(r.abs(L2), r.abs(L1))}` }] })
    await r.onLayer(2, {})
  }, 0, /shop\/b\/_common\/mariadb-alerts has no link/],
  ['the link checked out as a text file (symlinks off)', async r => {
    await r.base(1); await fs.rm(r.abs(`${L1}/charts/${C}`)); await r.write(`${L1}/charts/${C}`, `../../../../charts/${C}`); await r.onLayer(1, {})
  }, 'error', /has charts\/mariadb-alerts as a file, not a link/],
  ['a packed chart in the _common\'s charts/', async r => {
    await r.base(1); await fs.rm(r.abs(`${L1}/charts`), { recursive: true }); await fs.mkdir(r.abs(`${L1}/charts`))
    execFileSync(HELM, ['package', r.abs(`charts/${C}`), '-d', r.abs(`${L1}/charts`)], { stdio: 'ignore' }); await r.onLayer(1, {})
  }, 6, /packed chart/],
  ['a condition that is false on the deployment\'s dependency', async r => { await r.base(1); await r.deployment('shop/d', [r.fileDep('shop/d', L1, 'common', { condition: 'common.enabled' })], { common: { enabled: false, [C]: {} } }) }, 0, /condition common\.enabled is false/],
  ['a condition that is false on the _common\'s dependency', async r => {
    await r.base(1, { l1: { enabled: false } }); await r.write(`${L1}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: C, version: '>=0.0.0-0', condition: `${C}.enabled` }] })
    await r.onLayer(1, {})
  }, 0, /condition mariadb-alerts\.enabled is false/],
  ['the deployment names the _common other than its Chart.yaml does', async r => {
    await r.base(1); await r.write(`${L1}/Chart.yaml`, { apiVersion: 'v2', name: 'shared', version: '0.1.0', dependencies: [{ name: C, version: '>=0.0.0-0' }] }); await r.onLayer(1, {})
  }, 'error', /is named "shared"/],
  ['the _common it names is not there', async r => { await r.base(1); await fs.rm(r.abs('shop/_common'), { recursive: true }); await r.onLayer(1, {}) }, 'error', /its _common chart shop\/_common\/mariadb-alerts is not in the repo/],
  ['the Template directly and the _common too', async r => {
    await r.base(1); await r.deployment('shop/d', [r.fileDep('shop/d', `charts/${C}`, C), r.fileDep('shop/d', L1)], { [C]: { _common: { owner: 'direct', namespace: 'n' }, ...empty, [CPU]: [{ warn_pct: 1, critical_pct: 2 }] }, common: { [C]: {} } })
  }, 8, /Helm renders each of them/],
  ['a _common\'s values.yaml that is not YAML', async r => { await r.base(2); await r.write(`${L1}/values.yaml`, 'x: [\n'); await r.onLayer(2, {}) }, 'error', /shop\/_common\/mariadb-alerts\/values\.yaml: AlertForge cannot tell how Helm reads this/],

  ['a null group in the deployment', async r => { await r.base(1); await r.onLayer(1, { [DISK]: null }) }, 'varies', 'value'],
  ['a null group in the second layer', async r => { await r.base(2, { l2: { [DISK]: null } }); await r.onLayer(2, {}) }, 'varies', 'value'],
  ['a null owner in the deployment', async r => { await r.base(1); await r.onLayer(1, { _common: { owner: null } }) }, 'varies', 'value'],
  ['a null wrapping key', async r => { await r.base(1); await r.deployment('shop/d', [r.fileDep('shop/d', L1)], 'common: null\n') }, 'error', 'value'],
  ['false and 0 as groups', async r => { await r.base(1); await r.onLayer(1, { [DISK]: false, [CPU]: 0 }) }, 'error', 'value'],
  ['a group as a map', async r => { await r.base(1); await r.onLayer(1, { [DISK]: {} }) }, 'error', 'value'],
  ['Common Values as a list', async r => { await r.base(1); await r.onLayer(1, { _common: [] }) }, 'error', 'value'],
]

const alertsOf = out => yaml.loadAll(out).filter(Boolean).flatMap(d => d.spec?.groups || []).flatMap(g => g.rules || []).filter(r => r.alert)
  .map(r => `${r.alert}|${r.labels?.owner}|${r.labels?.namespace}|${/>\s*(\S+)\s*$/.exec(r.expr)?.[1]}`).sort()

describe.skipIf(!HAS_HELM).concurrent('a stack as Helm renders it', { timeout: 60000 }, () => {
  it.each(cases)('%s', async (name, build, helmSays, jsSays) => {
    const r = repo(name)
    await build(r)
    const dir = (await fs.access(r.abs('shop/b/c/d')).then(() => 'shop/b/c/d', () => null))
      ?? (await fs.access(r.abs('shop/b/d/Chart.yaml')).then(() => 'shop/b/d', () => 'shop/d'))
    let helm
    try {
      helm = alertsOf(await renderChart(r.abs(dir), ['template', 'x', r.abs(dir)]))
    } catch {
      helm = 'error'
    }
    if (helmSays !== 'varies') expect(Array.isArray(helm) ? helm.length : helm, 'what Helm renders').toBe(helmSays)

    const stack = await resolveStack(r.root, r.abs(dir))
    // What the loader says of the values: anything Helm fails on, reads
    // otherwise, or AlertForge cannot tell.
    const dep = await loadDeployment(openRepo(r.root), dir)
    const issues = dep.state !== 'ok' ? [dep.state] : findingsOf(dep).filter(f => f.helm !== 'renders' && !f.detail?.stack).map(f => f.code)
    if (jsSays === 'same') {
      expect(stack.problems).toEqual([])
      expect(issues).toEqual([])
      // The Template rendered with what AlertForge works out it is given.
      const merged = dep.value.effective
      const file = path.join(r.root, 'merged.yaml')
      await fs.writeFile(file, yaml.dump(merged))
      const js = alertsOf(execFileSync(HELM, ['template', 'x', r.abs(`charts/${stack.chart}`), '-f', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }))
      expect(js).toEqual(helm)
    } else if (jsSays === 'value') {
      expect(issues.length, 'a value issue').toBeGreaterThan(0)
    } else {
      expect(stack.problems.map(p => p.description).join('\n')).toMatch(jsSays)
    }
  })
})
