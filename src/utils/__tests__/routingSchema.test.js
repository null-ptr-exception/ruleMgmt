import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
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

// Names are the user's: one may be __proto__ (YAML keeps it as an own key)
// or a word a message starts with. Every map of names is checked by its own
// keys, and its messages keep the name.
describe('names the user chose', () => {
  const fromYaml = text => checkRouting(yaml.load(text))
  const table = (extra = '') => `labels: {s: [x]${extra}}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {s: x}, configs: [m]}]\n`

  it('checks a config named __proto__ like any other', () => {
    expect(fromYaml('labels: {s: [x]}\nconfigs: {__proto__: 5}\ncells: [{match: {s: x}, configs: [__proto__]}]\n').join())
      .toMatch(/configs\.__proto__: names starting with "_" are reserved/)
    // Its value is checked too, not only its name.
    expect(fromYaml('labels: {s: [x]}\nconfigs: {__proto__: {type: sms}}\ncells: []\n')).toContain('configs.__proto__: type must be one of email, webhook')
  })

  it('checks a label named __proto__, and does not throw', () => {
    expect(() => fromYaml(table(', __proto__: 5'))).not.toThrow()
    expect(fromYaml(table(', __proto__: 5'))).toContain('labels.__proto__: list its values')
    expect(fromYaml(table(', __proto__: [1]')).join()).toMatch(/labels\.__proto__\[0\]: values must be text/)
  })

  it('checks a match value under __proto__', () => {
    const text = 'labels: {s: [x], __proto__: [a]}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {s: x, __proto__: 1}, configs: [m]}]\n'
    expect(fromYaml(text).join()).toMatch(/cells\[0\]\.match\.__proto__: /)
  })

  it('keeps a name that is the first word of its message', () => {
    expect(fromYaml(table(', list: []'))).toContain('labels.list: list its values')
    expect(fromYaml('labels: {s: [x]}\nconfigs: {a: {type: webhook}}\ncells: []\n')).toContain('configs.a: a webhook has either url or urlSecret')
    expect(fromYaml('labels: {s: [x]}\nconfigs: {must: 5}\ncells: []\n')).toContain('configs.must: must be a map with a "type"')
    expect(fromYaml('labels: {s: [x], must: [a]}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {s: x, must: 5}, configs: [m]}]\n').join())
      .toMatch(/cells\[0\]\.match\.must: /)
  })

  it('says which part of urlSecret is missing, once', () => {
    expect(fromYaml('labels: {s: [x]}\nconfigs: {a: {type: webhook, urlSecret: {name: n, key: ""}}}\ncells: []\n')).toEqual(['configs.a.urlSecret: key is required'])
  })

  it('names an unknown key as written, whatever it contains', () => {
    expect(checkRouting({ ...full(), 'a; b': 1 })).toContain('routing.yaml: unknown key "a; b" (expected labels, defaults, configs, cells)')
  })

  it('reports a bad label name and its bad values together', () => {
    const errors = fromYaml(table(', Bad-Name: x'))
    expect(errors).toContain('labels.Bad-Name: not a valid label name')
    expect(errors).toContain('labels.Bad-Name: list its values')
  })
})

describe('routing.schema.json', () => {
  it('is the schema as exported — run node scripts/gen-routing-schema.mjs after changing it', () => {
    const written = JSON.parse(readFileSync(new URL('../../../schema/routing.schema.json', import.meta.url), 'utf8'))
    expect(written).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(routingSchema))))
  })
})
