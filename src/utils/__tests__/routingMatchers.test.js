import { describe, it, expect } from 'vitest'
import fs from 'fs'
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
    // One name, the same way twice: every one must hold, and can (amtool 0.28.1 and
    // prometheus-operator v0.95.1 take them).
    [[m('env', '!=', 'dev'), m('env', '!=', 'test')]],
    [[m('region', '=~', 'eu.*'), m('region', '=~', '.*-1')]],
    [[m('region', '!~', 'eu.*'), m('region', '!~', 'us.*')]],
    // = once beside other comparisons of the same name.
    [[m('region', '=', 'eu'), m('region', '!=', 'us'), m('region', '=~', 'e.*')]],
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
    // Two = on one label: an alert has one value of it.
    [[m('region', '=', 'eu'), m('region', '=', 'us')], 'matchers[1]: region= is written twice (matchers[0] too): an alert has one value of region, so region="eu" and region="us" never both hold and no alert would reach the table'],
    [[m('region', '=', 'eu'), m('env', '!=', 'dev'), m('region', '=', 'eu')], 'matchers[2]: region="eu" is written twice (matchers[0] too): keep one'],
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

  it('a matcher on a table label is named while another label\'s values are wrong', () => {
    const r = { ...table([m('severity', '=', 'critical')]), labels: { severity: ['critical'], team: 123 } }
    const errors = checkRouting(r)
    expect(errors).toContainEqual(expect.stringMatching(/^matchers\[0\]: severity is a label of the table/))
    expect(errors).toContainEqual(expect.stringMatching(/^labels\.team: /))
  })

  // Written to the resource as a \uD800 escape, which Helm refuses to read.
  it.each(['=', '!=', '=~', '!~'])('a lone surrogate in a %s value is refused; a pair and "" are not', type => {
    for (const value of ['a\ud800', '\udc00b', 'x\ud800\ud800']) {
      expect(checkRouting(table([m('region', type, value)]))).toEqual([expect.stringMatching(/^matchers\[0\]: value has a broken character \(a lone UTF-16 surrogate\)/)])
    }
    expect(checkRouting(table([m('region', type, 'db\u{1f600}')]))).toEqual([])
    expect(checkRouting(table([m('region', type, '')]))).toEqual([])
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

  // The resource from before matchers were read: written by the generator
  // at 975081492 (the commit this work started from), checked in. Both sides
  // are read with LF, as a CRLF checkout writes the file with CRLF.
  it('without matchers is what it was before they were read', () => {
    const lf = text => text.replace(/\r\n/g, '\n')
    const before = fs.readFileSync(new URL('../../../tests/fixtures/routing/no-matchers/alertmanagerconfig.yaml', import.meta.url), 'utf-8')
    expect(lf(generateRouting(table()).text)).toBe(lf(before))
  })

  it('with none listed is the same as without', () => {
    expect(generateRouting(table([])).text).toBe(generateRouting(table()).text)
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
