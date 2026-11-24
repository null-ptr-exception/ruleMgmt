// values.yaml and Chart.yaml changed as text (#101): lines moved and
// re-indented, never parsed and written again, so every value means to
// Helm (YAML 1.1) what it did.
import { describe, it, expect } from 'vitest'
import { loadMap, wrapEntry, liftEntry, addMissing, setDependency } from '../../server/lib/valuesText.js'

const FILE = `# top
global:
  x: 1   # keep
mariadb-alerts:
  # owner first
  _common: { owner: on, namespace: n }
  cpu:
    - warn_pct: 010
      critical_pct: 1_0
      note: |
        two
          lines
  disk: &d
    - {warn_pct: 1:10}
other: *d
`

describe('wrapEntry and liftEntry', () => {
  it('move an entry one level down and back, every byte as it was', () => {
    const wrapped = wrapEntry(FILE, [], 'mariadb-alerts').text
    expect(wrapped).toBe(`# top
global:
  x: 1   # keep
common:
  mariadb-alerts:
    # owner first
    _common: { owner: on, namespace: n }
    cpu:
      - warn_pct: 010
        critical_pct: 1_0
        note: |
          two
            lines
    disk: &d
      - {warn_pct: 1:10}
other: *d
`)
    expect(wrapped).toContain('      - warn_pct: 010\n        critical_pct: 1_0\n')
    expect(liftEntry(wrapped, [], 'mariadb-alerts').text).toBe(FILE)
  })

  it('one level deeper too, under the keys above it', () => {
    const two = 'common:\n  mariadb-alerts:\n    cpu: []\n'
    const wrapped = wrapEntry(two, ['common'], 'mariadb-alerts').text
    expect(wrapped).toBe('common:\n  common:\n    mariadb-alerts:\n      cpu: []\n')
    expect(liftEntry(wrapped, ['common'], 'mariadb-alerts').text).toBe(two)
  })

  it('an entry not there: left out, or added empty when asked', () => {
    expect(wrapEntry('global: 1\n', [], 'mariadb-alerts').text).toBeNull()
    expect(wrapEntry('global: 1\n', [], 'mariadb-alerts', { create: true }).text).toBe('global: 1\ncommon:\n  mariadb-alerts: {}\n')
    expect(wrapEntry('# none yet\n', [], 'mariadb-alerts', { create: true }).text).toBe('# none yet\ncommon:\n  mariadb-alerts: {}\n')
  })

  it('refuses what it cannot move as written', () => {
    expect(wrapEntry('a: [\n', [], 'a').why).toMatch(/^is not valid YAML/)
    expect(wrapEntry('- a\n', [], 'a').why).toBe('does not hold a map at its top level')
    expect(wrapEntry('{a: 1}\n', [], 'a').why).toMatch(/flow map/)
    expect(wrapEntry('a: 1\ncommon: 2\n', [], 'a').why).toBe('already has a common key beside a')
    expect(liftEntry('common:\n  a: 1\n  b: 2\n', [], 'a').why).toMatch(/has b under common beside a/)
  })
})

describe('addMissing', () => {
  const base = 'mariadb-alerts:\n  _common:\n    owner: team-a   # from the _common\n    cluster: c1\n  cpu: []\n  mem:\n    - warn_pct: 070\n'
  it('copies in what the map lacks as written there, maps key by key', () => {
    const own = 'mariadb-alerts:\n  _common:\n    owner: mine\n  cpu:\n    - warn_pct: 1\n'
    const out = addMissing(own, ['mariadb-alerts'], base, ['mariadb-alerts'])
    expect(out.text).toBe('mariadb-alerts:\n  _common:\n    owner: mine\n    cluster: c1\n  cpu:\n    - warn_pct: 1\n  mem:\n    - warn_pct: 070\n')
    expect(out.added).toEqual(['_common.cluster', 'mem'])
  })

  it('makes the map there when it is missing or written {}', () => {
    expect(addMissing('common:\n  mariadb-alerts: {}\n', ['common', 'mariadb-alerts'], base, ['mariadb-alerts'], { only: ['cpu'] }).text)
      .toBe('common:\n  mariadb-alerts:\n    cpu: []\n')
    expect(addMissing('{}\n', ['mariadb-alerts'], base, ['mariadb-alerts'], { only: ['cpu'] }).text).toBe('\nmariadb-alerts:\n  cpu: []\n')
  })
})

describe('setDependency', () => {
  it('changes only the name and repository, in the style they were written', () => {
    const chart = 'apiVersion: v2\nname: a # x\ndependencies:\n  - name: mariadb-alerts # tpl\n    version: ">=0.0.0-0"\n    repository: "file://../../charts/mariadb-alerts"\n'
    expect(setDependency(chart, 0, { name: 'common', repository: 'file://../_common/mariadb-alerts' }).text)
      .toBe(chart.replace('name: mariadb-alerts # tpl', 'name: common # tpl').replace('"file://../../charts/mariadb-alerts"', '"file://../_common/mariadb-alerts"'))
  })
})

describe('loadMap', () => {
  it('an empty file, comments only or {} are no values', () => {
    for (const t of ['', '# x\n', '{}\n']) expect(loadMap(t).map.items).toEqual([])
  })
})
