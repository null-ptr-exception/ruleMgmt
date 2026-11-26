// The Shared configs page's overlap check with the tables' own matchers,
// held to amtool: two deployments' resources as the operator puts them
// under one Alertmanager (strategy None: each route under the root with
// continue, receivers prefixed with namespace and name), and alerts with
// every value the matchers and cells name, none, and one none names. Where
// the check decides, it says what amtool does; where it does not, it counts
// the cells as overlapping, so it never misses an alert sent twice.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { generateRouting } from '../../src/utils/routingGenerator.js'
import { sharedCellOverlaps } from '../../src/utils/sharedOverlap.js'
import { toAlertmanagerConfig, HAS_AMTOOL, amtoolTitle } from '../blind/harness.js'
import { SCENARIOS, SHARED, sideRouting } from '../fixtures/shared-overlap/matchers.js'

const specOf = text => yaml.load(text.replace('{{ .Release.Name }}-routing', 'x')).spec

function asDeployed(name, routing) {
  const { text, errors } = generateRouting(routing, { shared: SHARED })
  if (errors) throw new Error(errors.join('; '))
  const s = specOf(text)
  const rename = r => ({ ...r, ...(r.receiver ? { receiver: `ns/${name}/${r.receiver}` } : {}), ...(r.routes ? { routes: r.routes.map(rename) } : {}) })
  return { route: rename(s.route), receivers: s.receivers.map(r => ({ ...r, name: `ns/${name}/${r.name}` })) }
}

// Every label either side names, with each value it says, none, and another.
function alertsFor(sides) {
  const values = new Map([['severity', new Set(['critical'])]])
  const add = (name, v) => { if (!values.has(name)) values.set(name, new Set([undefined, 'none-of-these'])); values.get(name).add(v) }
  for (const r of sides) {
    for (const m of r.matchers || []) { add(m.name, m.value || undefined); add(m.name, m.value.split('|')[0].replace(/[^A-Za-z0-9_-]/g, '') || undefined) }
    for (const [k, v] of Object.entries(r.cells[0].match)) if (k !== 'severity') add(k, v)
  }
  let alerts = [{}]
  for (const [name, vs] of values) alerts = alerts.flatMap(a => [...vs].map(v => (v === undefined ? a : { ...a, [name]: v })))
  return alerts
}

describe.skipIf(!HAS_AMTOOL)(amtoolTitle('the overlap check against amtool routes'), () => {
  it.each(SCENARIOS.map(s => [s.what, s]))('%s', (_, s) => {
    const ra = sideRouting(s.a)
    const rb = sideRouting(s.b)
    const a = asDeployed('a', ra)
    const b = asDeployed('b', rb)
    const config = toAlertmanagerConfig({ route: { receiver: 'platform', routes: [a.route, b.route] }, receivers: [{ name: 'platform' }, ...a.receivers, ...b.receivers] })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-overlap-am-'))
    let twice
    try {
      const file = path.join(dir, 'alertmanager.yml')
      fs.writeFileSync(file, yaml.dump(config))
      twice = alertsFor([ra, rb]).some(alert => {
        const out = execFileSync('amtool', ['config', 'routes', 'test', `--config.file=${file}`, ...Object.entries(alert).map(([k, v]) => `${k}=${v}`)], { encoding: 'utf-8' })
        const hit = out.trim().split(',')
        return hit.includes('ns/a/relay') && hit.includes('ns/b/relay')
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(twice).toBe(s.amtool)
    const said = sharedCellOverlaps([{ deployment: 'shop/a', routing: ra }, { deployment: 'shop/b', routing: rb }], SHARED).overlaps.length > 0
    expect(said).toBe(s.said)
  })
})
