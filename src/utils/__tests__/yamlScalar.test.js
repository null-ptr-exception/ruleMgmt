import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { readsAsNonStringInYaml11, nameScalar, keyScalar, yamlName, helmLiteralText, needsQuote, KUBERNETES_DUMP_SCHEMA } from '../yamlScalar.js'

// What `kubectl create --dry-run=client -o json` (kubectl v1.36) makes of
// each one written bare: Kubernetes reads YAML 1.1.
const NOT_TEXT = ['yes', 'Yes', 'YES', 'on', 'ON', 'y', 'Y', 'n', 'no', 'off', 'true', 'False',
  'null', '~', '123', '1e3', '0x1f', '1_000', '0_7', '08', '-0b11', '.5', '-.inf', '.NaN']
const TEXT = ['cpu', 'yEs', 'High CPU', '5xx', '1:20', '2024-01-01', '0.1.0', '30s', 'job:rate:5m', '=', '中文']

describe('readsAsNonStringInYaml11', () => {
  it.each(NOT_TEXT)('%s is not text', v => expect(readsAsNonStringInYaml11(v)).toBe(true))
  it.each(TEXT)('%s is text', v => expect(readsAsNonStringInYaml11(v)).toBe(false))
})

describe('nameScalar', () => {
  it.each(NOT_TEXT)('quotes %s', v => expect(nameScalar(v)).toBe(JSON.stringify(v)))

  // Bare as before: existing charts generate the same templates.
  it.each(TEXT.filter(v => v !== '='))('leaves %s bare', v => expect(nameScalar(v)).toBe(v))

  // promtool takes any text as an alert name; bare, these do not parse or
  // lose part of the name (helm template + kubectl, v1.36).
  it.each(['CPU: high', 'a #b', 'a:\tb', 'trailing:', ' lead', 'tail ', '-', '- a', '? a', ': a', '[a]', '{a}', '*a', '&a', '!a', "'a", '"a', '%a', '@a', '`a', ','])(
    'quotes %j, which does not survive bare', v => {
      const out = nameScalar(v)
      expect(out).toBe(JSON.stringify(v))
      expect(yaml.load(`k: ${out}`).k).toBe(v)
    })

  // These read back as written bare, so they stay as they were generated.
  it.each(['-a', '?a', ':a', 'a\tb', 'a:b', 'a#b', 'a b'])('leaves %j bare', v => expect(nameScalar(v)).toBe(v))

  // JSON.stringify leaves these raw, and helm template fails on them inside
  // double quotes: DEL, the C1 controls, NEL and the Unicode line and
  // paragraph separators, and the noncharacters U+FFFE and U+FFFF.
  it.each([0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029, 0xfffe, 0xffff])('escapes U+%s', cp => {
    const v = `a${String.fromCharCode(cp)}b`
    const hex = cp.toString(16).padStart(4, '0')
    expect(nameScalar(v)).toBe(`"a\\u${hex}b"`)
    expect(yaml.load(`k: ${nameScalar(v)}`).k).toBe(v)
  })
})

// Each as a bare map key, read by kubectl (v1.36): the key it becomes, or
// null where kubectl refuses the document.
const KEYS_READ_AS = {
  yes: 'true', Yes: 'true', YES: 'true', y: 'true', Y: 'true', on: 'true', On: 'true', ON: 'true',
  n: 'false', N: 'false', no: 'false', No: 'false', NO: 'false', off: 'false', Off: 'false', OFF: 'false',
  True: 'true', TRUE: 'true', False: 'false', FALSE: 'false',
  '~': null, null: null, Null: null, NULL: null, '<<': null,
  '00': '0', '07': '7', '08': '8', '0o7': '7', '0x1F': '31', '0b101': '5', '-0b11': '-3',
  '1_000': '1000', '1_': '1', '0_7': '7', '+1': '1', '-0': '0', '.5': '0.5', '5.': '5', '1e3': '1000',
  '1.0': '1', '1e21': '1e+21', '.Inf': '.inf', '+.inf': '.inf', '.NaN': '.nan',
  true: 'true', false: 'false', 0: '0', 10: '10', '-1': '-1', 123: '123', '9223372036854775807': '9223372036854775807', '9223372036854775808': null,
  '.inf': '.inf', '-.inf': '-.inf', '.nan': '.nan',
  yEs: 'yEs', _1: '_1', '3scale.net/team': '3scale.net/team', '5xx': '5xx', '1:30': '1:30', '2026-11-20': '2026-11-20', '=': '=',
}

describe('keyScalar', () => {
  // A key is quoted exactly when, bare, Kubernetes would read another key —
  // or none. One it reads back as written is left bare, as it always was.
  it.each(Object.entries(KEYS_READ_AS))('%s', (key, readAs) => {
    expect(keyScalar(key)).toBe(readAs === key ? key : JSON.stringify(key))
  })
})

describe('yamlName', () => {
  it('quotes what nameScalar quotes', () => {
    for (const v of ['yes', '1_000', 'CPU: high', 'mariadb-alerts']) expect(yamlName(v)).toBe(nameScalar(v))
  })
})

describe('needsQuote', () => {
  // A label value: -.inf is -Infinity to YAML 1.1, and kubectl fails on it.
  it.each(['-.inf', '+.inf', '1_000'])('quotes %s', v => expect(needsQuote(v)).toBe(true))
})

describe('KUBERNETES_DUMP_SCHEMA', () => {
  it('quotes what YAML 1.1 reads as a number, which js-yaml leaves bare', () => {
    expect(yaml.dump({ a: '1_000', b: '0_7' })).toBe('a: 1_000\nb: 0_7\n')
    expect(yaml.dump({ a: '1_000', b: '0_7' }, { schema: KUBERNETES_DUMP_SCHEMA })).toBe("a: '1_000'\nb: '0_7'\n")
  })

  it('leaves everything else as js-yaml writes it', () => {
    const doc = { version: '0.1.0', wait: '30s', n: 1, on: true, s: 'cpu', list: ['a', 'yes'] }
    expect(yaml.dump(doc, { schema: KUBERNETES_DUMP_SCHEMA })).toBe(yaml.dump(doc))
  })
})

// A name is literal text in a file Helm renders: each {{ and }} becomes an
// action that prints it (checked with helm template + kubectl).
describe('helmLiteralText', () => {
  it.each([
    ['x: {{ .db }}', 'x: {{ `{{` }} .db {{ `}}` }}'],
    ['a}}b{{c', 'a{{ `}}` }}b{{ `{{` }}c'],
    // A whole run at once: in `{}}` the `{` would join the action after it.
    ['{{{', '{{ `{{{` }}'],
    ['{}}', '{{ `{}}` }}'],
    ['a{"b":{}}', 'a{"b":{{ `{}}` }}'],
    // A run with no {{ or }} is no action, and stays.
    ['{}{}', '{}{}'],
    ['plain', 'plain'],
  ])('%s', (text, out) => expect(helmLiteralText(text)).toBe(out))

  it('is applied to names and keys, not to Chart.yaml', () => {
    expect(nameScalar('{{ .Release.Name }}-down')).toBe('"{{ `{{` }} .Release.Name {{ `}}` }}-down"')
    expect(keyScalar('a{{b')).toBe('a{{ `{{` }}b')
    expect(yamlName('a{{b')).toBe('a{{b')
  })
})
