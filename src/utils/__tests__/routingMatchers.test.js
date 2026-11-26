import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { checkRouting, generateRouting, routingSpec } from '../routingGenerator'
import { matchersProblems } from '../routingSchema'
import { setMatchers, toSave, parseRouting, MATCHERS } from '../routingModel'

// The table's own matchers (#225): on the resource's top route, so only
// alerts that match every one reach a cell.
const table = matchers => ({
  ...(matchers !== undefined ? { matchers } : {}),
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  configs: { ops: { type: 'email', to: 'ops@example.com' } },
  cells: [{ match: { severity: 'critical', team: 'db' }, configs: ['ops'] }],
})
const m = (name, matchType, value) => ({ name, matchType, value })

describe('matchers in routing.yaml', () => {
  it.each([
    [[m('region', '=', 'eu')]],
    [[m('region', '!=', 'eu')]],
    [[m('region', '=~', 'eu|eu-.*')]],
    [[m('region', '!~', 'test.*')]],
    // An empty value: the alert has no such label.
    [[m('region', '=', '')]],
    // Allowed: with OnNamespace the operator adds its own beside it.
    [[m('namespace', '=~', 'a|b')]],
    // One name, two ways to compare.
    [[m('region', '=~', 'eu.*'), m('region', '!=', 'eu-test')]],
    // Taken by Go, though JavaScript refuses it.
    [[m('x', '=~', '^*')]],
    [[]],
  ])('takes %j', list => {
    expect(checkRouting(table(list))).toEqual([])
  })

  it.each([
    [[m('host-name', '=', 'a')], 'matchers[0]: name must be a label name: letters, digits and _, not starting with a digit'],
    [[m('1a', '=', 'a')], 'matchers[0]: name must be a label name'],
    [[m('', '=', 'a')], 'matchers[0]: name must be a label name'],
    [[{ matchType: '=', value: 'a' }], 'matchers[0]: name must be a label name'],
    [[m('region', '==', 'a')], 'matchers[0]: matchType must be one of = != =~ !~'],
    [[{ name: 'region', value: 'a' }], 'matchers[0]: matchType must be one of = != =~ !~'],
    [[m('region', '=', 5)], 'matchers[0]: value must be text'],
    [[m('region', '=', true)], 'matchers[0]: value must be text'],
    [[{ name: 'region', matchType: '=' }], 'matchers[0]: value must be text'],
    [[{ ...m('region', '=', 'a'), regex: true }], 'matchers[0]: unknown key "regex"'],
    [['region=a'], 'matchers[0]: must be a map with name, matchType and value'],
    ['region=a', 'matchers: must be a list of { name, matchType, value }'],
    [[m('severity', '=', 'critical')], 'matchers[0]: severity is a label of the table: each cell already says its value'],
    [[m('region', '=', 'eu'), m('region', '=', 'us')], 'matchers[1]: region= is written twice (matchers[0] too)'],
    [[m('region', '=~', 'eu.*'), m('region', '=~', '.*-1')], 'matchers[1]: region=~ is written twice (matchers[0] too): an alert has one value — write it as one regex'],
    [[m('region', '=~', '(?=eu)eu.*')], 'matchers[0]: value is a regex Alertmanager refuses — error parsing regexp: invalid or unsupported Perl syntax: `(?=`'],
    [[m('region', '!~', 'a{1001}')], 'matchers[0]: value is a regex Alertmanager refuses — error parsing regexp: invalid repeat count: `{1001}`'],
    [[m('region', '=~', '\\1')], 'matchers[0]: value is a regex Alertmanager refuses — error parsing regexp: invalid escape sequence: `\\1`'],
  ])('refuses %j, naming where', (list, why) => {
    const errors = checkRouting(table(list))
    expect(errors).toHaveLength(1)
    expect(errors[0].startsWith(why)).toBe(true)
    expect(generateRouting(table(list)).errors).toEqual(errors)
  })

  it('says what is wrong with the regex as written, not as Alertmanager wraps it', () => {
    expect(checkRouting(table([m('region', '=~', '[a')]))).toEqual(['matchers[0]: value is a regex Alertmanager refuses — error parsing regexp: missing closing ]: `[a`'])
    expect(checkRouting(table([m('region', '=~', '(eu')]))).toEqual(['matchers[0]: value is a regex Alertmanager refuses — error parsing regexp: missing closing ): `(eu`'])
  })

  it('a regex is not checked for = and !=: the value is text', () => {
    expect(checkRouting(table([m('region', '=', '(?=x')]))).toEqual([])
  })

  it('the page\'s check is the save\'s, one entry per matcher', () => {
    expect(matchersProblems([m('region', '=', 'eu'), m('team', '=', 'db'), m('', '=', '')], ['severity', 'team']))
      .toEqual([null, expect.stringMatching(/^team is a label of the table/), expect.stringMatching(/^name must be a label name/)])
  })
})

describe('the generated resource', () => {
  it('puts the matchers on the top route, as written, in their order', () => {
    const list = [m('region', '=~', 'eu|eu-.*'), m('env', '!=', 'dev'), m('owner', '!=', 'a"b\\c')]
    const { route } = routingSpec(table(list))
    expect(route.matchers).toEqual([
      { name: 'region', value: 'eu|eu-.*', matchType: '=~' },
      { name: 'env', value: 'dev', matchType: '!=' },
      { name: 'owner', value: 'a"b\\c', matchType: '!=' },
    ])
    expect(Object.keys(route)).toEqual(['receiver', 'matchers', 'continue', 'routes'])
    // The cells' routes are as without them.
    expect(route.routes).toEqual(routingSpec(table()).route.routes)
  })

  it('without matchers, or with none listed, is what it was', () => {
    const before = generateRouting(table()).text
    expect(before).not.toContain('matchers:\n      - name: region')
    expect(generateRouting(table([])).text).toBe(before)
    expect(routingSpec(table()).route).toEqual({ receiver: '_drop', continue: true, routes: routingSpec(table()).route.routes })
  })

  it('writes a value Helm would read as an action as text', () => {
    const { text } = generateRouting(table([m('x', '=~', 'a{{2}}')]))
    expect(text).toContain('{{ "{{" }}2{{ "}}" }}')
  })
})

describe('editing the matchers on the page', () => {
  it('saves them first, and leaves them out when there are none', () => {
    const r = setMatchers(table(), [m('region', '=', 'eu')])
    expect(Object.keys(toSave(r))[0]).toBe(MATCHERS)
    expect(toSave(setMatchers(r, []))).not.toHaveProperty(MATCHERS)
    expect(toSave(table([]))).not.toHaveProperty(MATCHERS)
    expect(Object.keys(toSave(table()))).toEqual(['labels', 'configs', 'cells'])
  })

  it('reads them back from the file as written', () => {
    const text = yaml.dump(toSave(setMatchers(table(), [m('region', '!~', 'test.*')])))
    expect(parseRouting(text)[MATCHERS]).toEqual([m('region', '!~', 'test.*')])
  })
})
