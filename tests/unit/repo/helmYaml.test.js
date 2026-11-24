// readHelmYaml without Helm: the answers here were measured with Helm 3.15.4
// and 3.19.0 (tests/integration/helm-yaml.test.js and helm-yaml-fuzz.test.js
// run the reader against Helm itself). Every refusal has a row beside it
// that is read.
import { describe, it, expect } from 'vitest'
import { readHelmYaml, float32Text, lineOf, MAX_BYTES, MAX_DEPTH } from '../../../server/repo/helmYaml.js'

const read = text => readHelmYaml(text, { file: 'deployments/a/values.yaml' })
const plain = v => JSON.parse(JSON.stringify(v))

describe('values as Helm reads them', () => {
  it.each([
    // YAML 1.1 numbers
    ['v: 010', 8], ['v: 0777', 511], ['v: -010', -8], ['v: 08', 8], ['v: 0o10', 8], ['v: 0x10', 16], ['v: 0b101', 5],
    ['v: 1_000', 1000], ['v: 0_7', 7], ['v: 1_0.5', 10.5], ['v: _1', '_1'], ['v: 0o8', '0o8'], ['v: 1e400', '1e400'],
    // not YAML 1.1's base 60: a text
    ['v: 1:30', '1:30'], ['v: 190:20:30', '190:20:30'],
    // booleans and nulls
    ['v: yes', true], ['v: No', false], ['v: ON', true], ['v: off', false], ['v: y', true], ['v: n', false], ['v: tRue', 'tRue'],
    ['v: ~', null], ['v: null', null], ['v:', null], ['v: nUll', 'nUll'],
    // a date stays the text written
    ['v: 2024-01-01', '2024-01-01'], ['v: 2024-01-01T10:00:00Z', '2024-01-01T10:00:00Z'],
    // quoted and tagged
    ['v: "010"', '010'], ["v: 'yes'", 'yes'], ['v: !!str 010', '010'], ['v: !!int "10"', 10], ['v: !!float 010', 8], ['v: !!bool yes', true],
    ['v: <<', '<<'],
    // quotes inside a [ ] or { } list's texts
    ["v: [don't, x]", ["don't", 'x']], ["v: {k: it's}", { k: "it's" }], ['v: [x"y, z]', ['x"y', 'z']], ['v: [-1, -a]', [-1, '-a']],
  ])('%s → %j', (text, want) => {
    const r = read(`${text}\n`)
    expect(r.ok).toBe(true)
    expect(r.value.v).toEqual(want)
  })

  it('reads keys as Helm does: n is "false", 010 is "8", 1.5 is "1.5"', () => {
    expect(plain(read('n: 1\non: 2\n010: 3\n1.5: 4\n2024-01-01: 5\n').value)).toEqual({ false: 1, true: 2, 8: 3, '1.5': 4, '2024-01-01': 5 })
  })

  it('takes the last of a key written twice, and merges << as go-yaml does', () => {
    expect(plain(read('a: 1\na: 2\n').value)).toEqual({ a: 2 })
    expect(plain(read('b: &b {x: 1}\nm:\n  x: 9\n  <<: *b\n').value.m)).toEqual({ x: 1 })
    expect(plain(read('a: &a {x: 1}\nb: &b {x: 2, z: 3}\nm:\n  <<: [*a, *b]\n').value.m)).toEqual({ x: 1, z: 3 })
  })

  it('reads the first document only', () => {
    expect(plain(read('a: 1\n---\nb: [\n').value)).toEqual({ a: 1 })
    expect(plain(read('a: 1\n---\n').value)).toEqual({ a: 1 })
    expect(plain(read('a: 1\n...\n').value)).toEqual({ a: 1 })
  })

  it('an empty file, comments only, ~ are an empty map', () => {
    for (const t of ['', '\n', '# a\n', '~\n', '---\n', '{}\n']) expect(plain(read(t).value)).toEqual({})
  })

  it('reads a byte order mark, CRLF and UTF-16', () => {
    expect(plain(read('\uFEFFa: 1\n').value)).toEqual({ a: 1 })
    expect(plain(read('a: 1\r\nb: 2\r\n').value)).toEqual({ a: 1, b: 2 })
    expect(plain(read(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a: 1\n', 'utf16le')])).value)).toEqual({ a: 1 })
  })

  it('reads a [ ] list over lines indented under its key', () => {
    expect(plain(read('demo:\n  cpu: [\n    {job: a},\n  ]\n').value)).toEqual({ demo: { cpu: [{ job: 'a' }] } })
  })
})

describe('what Helm stops on is refused, and says so', () => {
  it.each([
    ['v: .inf', 'yaml.not-json', 'v: 1.5'],
    ['v: -.inf', 'yaml.not-json', 'v: -1.5'],
    ['v: .nan', 'yaml.not-json', 'v: "nan"'],
    ['a:\n\tb: 1', 'yaml.not-yaml', 'a:\n  b: 1'],
    ['a: 1\n\t# c', 'yaml.not-yaml', 'a: 1\n# c'],
    ['-\tx', 'yaml.not-yaml', 'a:\t1'],
    ['...', 'yaml.not-yaml', '---\n...'],
    ['a: "\\/"', 'yaml.not-yaml', 'a: "\\\'"'],
    ['a: "\\uD800"', 'yaml.not-yaml', 'a: "\\u00e9"'],
    ['a: x\u0001y', 'yaml.not-yaml', 'a: "x\\x01y"'],
    ['~: a', 'yaml.bad-key', '"~": a'],
    ['18446744073709551615: a', 'yaml.bad-key', '9223372036854775807: a'],
    ['- a\n- b', 'yaml.not-map', 'a: [a, b]'],
    ['hello', 'yaml.not-map', 'hello: there'],
    ['v: !!null x', 'yaml.not-yaml', 'v: !!null ~'],
    ['v: !!int abc', 'yaml.not-yaml', 'v: !!int 10'],
    ['m:\n  <<: 5', 'yaml.not-yaml', 'm:\n  <<: {x: 5}'],
    ['a: b: c', 'yaml.not-yaml', 'a: "b: c"'],
    ['a:\n  b: 1\n c: 2', 'yaml.not-yaml', 'a:\n  b: 1\n  c: 2'],
    [' # x\n\t# c', 'yaml.not-yaml', ' # x\n# c'],
    ['b: *nope', 'yaml.not-yaml', 'a: &nope 1\nb: *nope'],
    ['a: &x [*x]', 'yaml.not-yaml', 'a: &x [1]\nb: *x'],
  ])('%j is refused (%s); %j is read', (bad, code, good) => {
    const r = read(`${bad}\n`)
    expect(r.ok).toBe(false)
    expect(r.finding).toMatchObject({ code, helm: 'fails', file: 'deployments/a/values.yaml' })
    expect(r.finding.message).toMatch(/^deployments\/a\/values\.yaml/)
    expect(read(`${good}\n`).ok).toBe(true)
  })

  it('refuses text that is not UTF-8', () => {
    const r = read(Buffer.from([0x61, 0x3a, 0x20, 0xff, 0x0a]))
    expect(r.finding).toMatchObject({ code: 'yaml.not-yaml', helm: 'fails' })
    expect(read(Buffer.from('a: é\n')).ok).toBe(true)
  })

  it('names the line', () => {
    expect(read('a: 1\nb: 2\n\tc: 3\n').finding).toMatchObject({ at: { line: 3 } })
  })

  it('refuses too many aliases, as go-yaml does; a few are read', () => {
    const laughs = ['a: &a ["x","x","x","x","x","x","x","x","x"]']
    for (let i = 1; i < 9; i++) laughs.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(9).fill(`*${String.fromCharCode(96 + i)}`).join(',')}]`)
    expect(read(laughs.join('\n')).finding?.message).toMatch(/too many aliases/)
    expect(read(`a: &a [1]\nb: [${Array(200).fill('*a').join(', ')}]\n`).ok).toBe(true)
  })
})

describe('where AlertForge cannot tell what Helm reads, it says so and gives no value', () => {
  it('two keys that become the same text', () => {
    const r = read('1: a\n"1": b\n')
    expect(r).toMatchObject({ ok: false, finding: { code: 'yaml.key-collision', helm: 'renders-differently' } })
    expect(r.value).toBeUndefined()
    expect(plain(read('1: a\n0x1: b\n').value)).toEqual({ 1: 'b' }) // the same key in Go: the last
  })

  it('two such keys, one holding a value Helm stops on: whether Helm stops depends on which it keeps', () => {
    expect(read('1:\n  x: .inf\n"1": ok\n').finding).toMatchObject({ code: 'yaml.key-collision', helm: 'renders-differently' })
    expect(read('a: .inf\nb: {1: x, "1": y}\n').finding).toMatchObject({ code: 'yaml.not-json', helm: 'fails' })
  })

  it('a control character after the first document', () => {
    expect(read('a: 1\n---\nb: x\u0001\n').finding).toMatchObject({ code: 'yaml.cannot-read', helm: 'unknown' })
    expect(read('a: 1\n---\nb: x\n').ok).toBe(true)
  })

  // Each construct outside the subset, named in the message, with the line;
  // and beside it the ordinary way to write the same thing, which is read.
  it.each([
    // a value Helm reads differently from what the parser would give
    ['! <<: {a: 1}\nb: 2', /a tag on a key \(!\)/, '<<: {a: 1}\nb: 2'],
    ['v: [!!str, 1]', /!!str directly followed by ","/, 'v: ["", 1]'],
    ['v: [?x]', /starting with \?/, 'v: ["?x"]'],
    ['v: {?a: 1}', /starting with \?/, 'v: {"?a": 1}'],
    ['v: [x:]', /key: value pair inside \[ \]/, 'v: ["x:"]'],
    ['v: [1 :]', /key: value pair inside \[ \]/, 'v: [1]'],
    ['k: |2\n    x\n    ', /block text header \|2/, 'k: |\n    x\n    '],
    // Helm fails, or reads: either way not what the parser says
    ['a: &é 1\nb: *é', /anchor name &é/, 'a: &e 1\nb: *e'],
    ['a: &x.y 1', /anchor name &x\.y/, 'a: &x-y 1'],
    ['v: [:x]', /starting with :/, 'v: [":x"]'],
    ['c: [Min? QPS]', /a \? inside a text/, 'c: ["Min? QPS"]'],
    ['a: "x"# c', /parser does not read it/, 'a: "x" # c'],
    ['v: [-]', /a block map or list inside \[ \]/, 'v: ["-"]'],
    ['a: &k kk\n*k: 1', /alias \*k: used as a key|alias \*k used as a key/, 'a: &k kk\nkk: 1'],
    ['v:\n  !!str : 1', /the tag !!str/, 'v:\n  "": 1'],
    ['k: {\n\tb: 1 }', /inside \[ \] or \{ \}|inside \{ \}/, 'k: {\n  b: 1 }'],
    ['k: [1,\n  \t2]', /a tab at the start of a line inside/, 'k: [1,\n   2]'],
    ['%YAML 1.1\n---\na: 1', /%YAML directive/, '---\na: 1'],
    ['v: !foo 1', /the tag !foo/, 'v: "1"'],
    ['v: !!binary aGVsbG8=', /the tag !!binary/, 'v: hello'],
    ['? a\n: 1', /\? key/, 'a: 1'],
    ['a: 1\rb: 2', /CR line break/, 'a: 1\r\nb: 2'],
    ['a: x\u2028y', /line separator/, 'a: "x\\Ly"'],
    ['# a\n\ufeff# b\na: 1', /byte order mark/, '\ufeff# a\n# b\na: 1'],
    ['a: [1,\n---\n2]', /not closed in the first document/, 'a: [1,\n  2]'],
  ])('%j: cannot tell (%s); %j is read', (odd, why, ordinary) => {
    const r = read(`${odd}\n`)
    expect(r.ok, JSON.stringify(r.value)).toBe(false)
    expect(r.finding).toMatchObject({ code: 'yaml.cannot-read', helm: 'unknown', file: 'deployments/a/values.yaml' })
    expect(r.why).toMatch(why)
    expect(r.finding.message).toMatch(/^deployments\/a\/values\.yaml( line \d+)?: AlertForge cannot tell/)
    const o = read(`${ordinary}\n`)
    expect(o.ok, o.why).toBe(true)
  })

  it('names the line of the construct', () => {
    expect(read('a: 1\nb: 2\nc: [?x]\n').finding.at).toEqual({ line: 3 })
  })
})

describe('limits: size, depth, time', () => {
  it(`a text larger than ${MAX_BYTES} bytes is not read`, () => {
    const big = `a: "${'x'.repeat(MAX_BYTES)}"\n`
    expect(read(big).finding).toMatchObject({ helm: 'unknown', message: expect.stringMatching(/larger than 5 MiB/) })
    expect(read(Buffer.from(big)).finding.helm).toBe('unknown')
  })

  it('nesting deeper than the limit is cannot-tell, and never throws, at any depth', () => {
    for (const n of [MAX_DEPTH + 1, 5000, 200000]) {
      const flow = `a: ${'['.repeat(n)}${']'.repeat(n)}\n`
      expect(read(flow).finding).toMatchObject({ helm: 'unknown', message: expect.stringMatching(/nest more than/) })
    }
    const block = Array.from({ length: 5000 }, (_, i) => `${' '.repeat(i)}k:`).join('\n') + ' 1\n'
    expect(read(block).finding.helm).toBe('unknown')
    expect(read(`a: ${'['.repeat(40)}${']'.repeat(40)}\n`).ok).toBe(true)
  })

  it('aliases nesting the values deeper than the limit: cannot tell', () => {
    const lines = ['a0: &a0 [1]']
    for (let i = 1; i < 60; i++) lines.push(`a${i}: &a${i} [[*a${i - 1}]]`)
    expect(read(lines.join('\n')).finding).toMatchObject({ helm: 'unknown', message: expect.stringMatching(/with the aliases followed/) })
  })

  it('returns soon on 1 MiB of each odd shape (the limit is 5 MiB; measured times are in the commit)', () => {
    const MiB = 1024 * 1024
    const fill = unit => unit.repeat(Math.floor(MiB / unit.length))
    for (const text of [
      `demo:\n  cpu:\n${fill('  - {job: api, threshold: 90, severity: warning}\n')}`,
      `demo:\n  cpu:\n${fill('  - job: api\n    threshold: 90\n')}`,
      `a: 1\n${fill('b:\t1 #\tc\n')}`,
      `a: "${'x'.repeat(MiB)}"\n`,
      `a: &a [${'1,'.repeat(50)}1]\nb:\n${fill('- *a\n')}`,
      `${fill('# a comment line\n')}a: 1\n`,
      `a: ${'['.repeat(90)}${']'.repeat(90)}\n`.repeat(Math.floor(MiB / 200)),
    ]) {
      const t0 = performance.now()
      read(text)
      expect(performance.now() - t0).toBeLessThan(20000)
    }
  }, 180000)
})

describe('where in the file', () => {
  it('counts each line break go-yaml counts', () => {
    expect(lineOf('a\nb\r\nc\rd\u0085e\u2028f\u2029g', 13)).toBe(7)
    expect(lineOf('a\r\nb', 3)).toBe(2)
  })

  it('a UTF-16 byte order mark followed by text that is not UTF-16: cannot tell, saying so', () => {
    const r = read(Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00]))
    expect(r.finding).toMatchObject({ helm: 'unknown' })
    expect(r.why).toMatch(/UTF-16LE byte order mark, and what follows is not UTF-16LE text/)
  })
})

describe('the map read has no prototype; every key is its own', () => {
  it('__proto__, constructor and toString are plain keys', () => {
    const r = read('__proto__: {polluted: 1}\nconstructor: x\ntoString: y\n')
    expect(r.ok).toBe(true)
    expect(Object.getPrototypeOf(r.value)).toBe(null)
    expect(Object.hasOwn(r.value, '__proto__')).toBe(true)
    expect(r.value.__proto__).toEqual(expect.objectContaining({ polluted: 1 }))
    expect(r.value.constructor).toBe('x')
    expect(r.value.toString).toBe(true) // `y` is YAML 1.1's true
    expect({}.polluted).toBeUndefined()
  })
})

describe('a number key written as Go writes a float32', () => {
  it.each([
    [1000, '1000'], [3, '3'], [0.1, '0.1'], [1.1, '1.1'], [123456789, '1.2345679e+08'], [1e20, '1e+20'], [1e39, '.inf'],
    [1e-5, '1e-05'], [0.0001, '0.0001'], [1234567, '1.234567e+06'], [123456, '123456'], [-0, '-0'], [NaN, '.nan'],
    [-Infinity, '-.inf'], [18446744073709551616, '1.8446744e+19'], [16777217, '1.6777216e+07'], [0.5, '0.5'],
  ])('%s → %s', (f, want) => expect(float32Text(f)).toBe(want))
})
