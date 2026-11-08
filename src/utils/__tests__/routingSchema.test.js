import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { checkRouting, generateRouting, configProblems } from '../routingGenerator'
import { routingSchema } from '../routingSchema'

// Every key of routing.yaml, filled.
const full = () => ({
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  defaults: { groupWait: '30s', groupInterval: '5m', repeatInterval: '4h' },
  configs: {
    'db-email': { type: 'email', to: 'db@example.com' },
    'ops-webhook': { type: 'webhook', urlSecret: { name: 'ops', key: 'url' } },
    pager: { type: 'webhook', url: 'http://pager.monitoring.svc:8080' },
  },
  cells: [{ match: { severity: 'critical', team: 'db' }, configs: ['db-email', 'pager'], groupWait: '10s', groupInterval: '1m', repeatInterval: '1h' }],
})

const PATHS = [
  ['labels'], ['labels', 'severity'], ['labels', 'severity', 0],
  ['defaults'], ['defaults', 'groupWait'], ['defaults', 'groupInterval'], ['defaults', 'repeatInterval'],
  ['configs'], ['configs', 'db-email'], ['configs', 'db-email', 'type'], ['configs', 'db-email', 'to'],
  ['configs', 'ops-webhook', 'type'], ['configs', 'ops-webhook', 'urlSecret'],
  ['configs', 'ops-webhook', 'urlSecret', 'name'], ['configs', 'ops-webhook', 'urlSecret', 'key'],
  ['configs', 'pager', 'url'],
  ['cells'], ['cells', 0], ['cells', 0, 'match'], ['cells', 0, 'match', 'severity'],
  ['cells', 0, 'configs'], ['cells', 0, 'configs', 0],
  ['cells', 0, 'groupWait'], ['cells', 0, 'groupInterval'], ['cells', 0, 'repeatInterval'],
]
const MAPS = [[], ['labels'], ['defaults'], ['configs'], ['configs', 'db-email'], ['configs', 'ops-webhook'],
  ['configs', 'ops-webhook', 'urlSecret'], ['configs', 'pager'], ['cells', 0], ['cells', 0, 'match']]

const set = (obj, path, value) => {
  const parent = path.slice(0, -1).reduce((o, k) => o[k], obj)
  parent[path.at(-1)] = value
  return obj
}

describe('the shape of routing.yaml', () => {
  it('passes every key filled', () => {
    expect(checkRouting(full())).toEqual([])
  })

  // A value of the wrong type is refused wherever it is, and nothing throws
  // on the way: a list, a number, null and true in place of each value.
  for (const path of PATHS) {
    for (const bad of [['x'], 5, null, true]) {
      it(`refuses ${JSON.stringify(bad)} as ${path.join('.')}`, () => {
        const routing = set(full(), path, bad)
        expect(checkRouting(routing)).not.toEqual([])
        expect(generateRouting(routing).errors).not.toEqual([])
      })
    }
  }

  for (const path of MAPS) {
    it(`refuses a key nobody reads in ${path.join('.') || 'the file'}`, () => {
      const routing = full()
      const map = path.reduce((o, k) => o[k], routing)
      map.surplus = 'x'
      // In labels, configs and match a key is a name: there it is read as one.
      const isNames = path.length === 1 && path[0] !== 'defaults' || path.at(-1) === 'match'
      expect(checkRouting(routing).join()).toMatch(isNames ? /surplus/ : /unknown key "surplus"/)
    })
  }

  it('names where each problem is, as before', () => {
    const routing = full()
    routing.labels.severity = []
    routing.defaults.groupWait = 'soon'
    routing.configs['db-email'].to = ' '
    routing.cells[0].configs = [1]
    routing.extra = 1
    expect(checkRouting(routing)).toEqual([
      'labels.severity: list its values',
      'defaults: groupWait must be a duration such as 30s, 5m or 4h',
      'configs.db-email: to is required',
      'cells[0].configs[0]: config must be a name (text), not 1',
      'routing.yaml: unknown key "extra" (expected labels, defaults, configs, cells)',
    ])
  })

  it('refuses a file that is not a map, with one message', () => {
    for (const bad of [null, [], 'labels', 5]) {
      expect(checkRouting(bad)).toEqual(['routing.yaml must be a map with labels, configs and cells'])
    }
  })

  it('checks a config on its own the same way', () => {
    expect(configProblems('db-email', { type: 'email', to: ['a@example.com'] })).toEqual(['configs.db-email: to is required'])
    expect(configProblems('_x', { type: 'email', to: 'a@example.com' }).join()).toMatch(/reserved/)
    expect(configProblems('Ops', { type: 'email', to: 'a@example.com' }).join()).toMatch(/lower-case/)
    expect(configProblems('w', { type: 'webhook', url: 'https://hooks.example.com/a?token=abc' }).join()).toMatch(/use urlSecret/)
    expect(configProblems('w', { type: 'webhook', url: 'http://relay:8080' })).toEqual([])
  })
})

describe('routing.schema.json', () => {
  it('is the schema as exported — run node scripts/gen-routing-schema.mjs after changing it', () => {
    const written = JSON.parse(readFileSync(new URL('../../../schema/routing.schema.json', import.meta.url), 'utf8'))
    expect(written).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(routingSchema))))
  })
})
