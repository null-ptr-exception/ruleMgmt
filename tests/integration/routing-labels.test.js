// Adding or taking away a routing label (#94), through real helm and amtool:
// who an alert reaches is asked of Alertmanager's own route tree, before and
// after, for every combination of the labels — each listed value, one not
// listed, and the label left out.
import { describe, it, expect } from 'vitest'
import { reshapeLabels, setCellConfigs, setCellTiming, toSave } from '../../src/utils/routingModel.js'
import { generateRouting } from '../../src/utils/routingGenerator.js'
import { renderRoutingCase, amtoolRoutes, hasBinary } from '../blind/harness.js'

const READY = hasBinary('helm', ['version']) && hasBinary('amtool')

const CONFIGS = {
  'db-email': { type: 'email', to: 'db@example.com' },
  ops: { type: 'webhook', url: 'http://ops:8080' },
  relay: { type: 'webhook', url: 'http://relay:8080' },
}
function base() {
  let r = { labels: { severity: ['critical', 'warning'], team: ['db', 'web'] }, configs: CONFIGS, cells: [] }
  r = setCellConfigs(r, { severity: 'critical', team: 'db' }, ['db-email', 'ops'])
  r = setCellTiming(r, { severity: 'critical', team: 'db' }, 'repeatInterval', '1h')
  r = setCellConfigs(r, { severity: 'warning', team: 'db' }, ['db-email'])
  r = setCellConfigs(r, { severity: 'critical', team: 'web' }, ['relay'])
  return r
}
const rowsOf = r => Object.entries(r.labels).map(([name, values]) => ({ name, values: [...values], was: name }))

// Every alert: each label at each listed value, `zz-other`, or left out.
function alerts(labels) {
  return Object.entries(labels).reduce((acc, [name, values]) => acc.flatMap(a =>
    [...values, 'zz-other', undefined].map(v => (v === undefined ? a : { ...a, [name]: v }))), [{}])
}
function reach(routing, list, tag) {
  const { text, errors } = generateRouting(toSave(routing))
  expect(errors).toBeFalsy()
  const { spec } = renderRoutingCase(`labels-${tag}`, text)
  return amtoolRoutes(`labels-${tag}`, spec, list.map(a => ({ labels: { alertname: 'X', ...a } }))).map(r => r.join(','))
}
const key = a => JSON.stringify(Object.entries(a).sort())

// About 130 helm and amtool runs a test: more than vitest's 5 s under load.
describe.skipIf(!READY)('who an alert reaches', { timeout: 60000 }, () => {
  const env = ['prod', 'dev']
  const added = () => reshapeLabels(base(), [...rowsOf(base()), { name: 'env', values: env }]).routing

  it('after adding env, the same for an alert with a listed env; nobody here for one without', () => {
    const list = alerts({ ...base().labels, env })
    const before = reach(base(), list, 'add-b')
    const after = reach(added(), list, 'add-a')
    // The names amtool gives carry the config's: the check below can see one.
    expect(before[list.findIndex(a => a.severity === 'critical' && a.team === 'db' && a.env === undefined)]).toMatch(/db-email/)
    const ours = new Set(Object.keys(CONFIGS))
    list.forEach((a, i) => {
      if (env.includes(a.env)) expect(after[i], key(a)).toBe(before[i])
      // No cell matches it now: this resource notifies nobody (the next
      // resource still takes critical alerts).
      else expect(after[i].split(',').some(r => [...ours].some(c => r.includes(c))), key(a)).toBe(false)
    })
    // What the notice on the page says actually happens: some alerts that
    // were notified are not now.
    expect(list.some((a, i) => !env.includes(a.env) && after[i] !== before[i])).toBe(true)
  })

  it('after taking env away again, the same as before for every alert', () => {
    const list = alerts({ ...base().labels, env })
    const back = reshapeLabels(added(), rowsOf(base())).routing
    expect(reach(back, list, 'remove-a')).toEqual(reach(base(), list, 'remove-b'))
  })

  it('after a rename, the same for every alert under the new name', () => {
    const renamed = reshapeLabels(base(), rowsOf(base()).map(r => (r.name === 'team' ? { ...r, name: 'squad' } : r))).routing
    const list = alerts(base().labels)
    const asSquad = list.map(({ team, ...a }) => (team === undefined ? a : { ...a, squad: team }))
    expect(reach(renamed, asSquad, 'rename-a')).toEqual(reach(base(), list, 'rename-b'))
  })
})
