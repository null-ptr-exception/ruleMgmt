// A group's own rule-group name (`name:`): what `spec.groups[].name` says,
// while the values key, the template file and the object names stay the
// file name's.
import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { parseRulesDir, groupFileText, groupName, groupNameProblem, GROUP_NAME_MAX } from '../rulesFile.js'
import { generateProducts } from '../drift.js'
import { groupNameChanges, describeChange } from '../schemaCompat.js'
import { importRules, modelGroupFromImport } from '../ruleImport.js'
import { summarizeGroups, tallyRendered } from '../renderSummary.js'
import { generateHelmUnittestSuite } from '../helmTestGenerator.js'

const RULES = 'columns:\n  db: { type: string, required: true }\nrules:\n  - alert: CpuHigh\n    expr: cpu{db="${db}"} > 1\n'
const file = head => `${head}${RULES}`
const errorsOf = files => parseRulesDir(files).errors

describe('reading name:', () => {
  it.each([
    ['MariaDB CPU', 'MariaDB CPU'],
    ['中文 名字', '中文 名字'],
    ['"{{ .x }} usage"', '{{ .x }} usage'],
    ['"a: b"', 'a: b'],
    ['yes', 'yes'],
    ['"null"', 'null'],
    ['_', '_'],
    ['"CPU #1"', 'CPU #1'],
    ['mariadb-cpu', 'mariadb-cpu'],
    [`"${'x'.repeat(GROUP_NAME_MAX)}"`, 'x'.repeat(GROUP_NAME_MAX)],
    [`"${'中'.repeat(GROUP_NAME_MAX)}"`, '中'.repeat(GROUP_NAME_MAX)],
    ['"a\tb"'.replace('\t', ' '), 'a b'],
  ])('takes name: %s', (written, name) => {
    const { model, errors } = parseRulesDir({ 'mariadb_cpu.yaml': file(`name: ${written}\n`) })
    expect(errors).toEqual([])
    expect(model.groups.mariadb_cpu.name).toBe(name)
    expect(groupName('mariadb_cpu', model.groups.mariadb_cpu)).toBe(name)
  })

  it('a group with no name: is the key with _ as -, as always', () => {
    const { model, errors } = parseRulesDir({ 'mariadb_cpu.yaml': file('') })
    expect(errors).toEqual([])
    expect(model.groups.mariadb_cpu.name).toBeUndefined()
    expect(groupName('mariadb_cpu', model.groups.mariadb_cpu)).toBe('mariadb-cpu')
  })

  it.each([
    ['written empty (name:)', 'name:\n', /name: is empty/],
    ['null', 'name: null\n', /name: is empty/],
    ['""', 'name: ""\n', /must not be empty/],
    ['a number', 'name: 5\n', /YAML reads this one as a number — quote it as written: name: "5"$/],
    // The hint says it as written, never what YAML made of it (10, 1000, a Date, Infinity).
    ['010', 'name: 010\n', /YAML reads this one as a number — quote it as written: name: "010"$/],
    ['1e3, with a comment', 'name: 1e3  # one thousand\n', /quote it as written: name: "1e3"$/],
    ['a date', 'name: 2026-11-22\n', /YAML reads this one as a date — quote it as written: name: "2026-11-22"$/],
    ['.inf', 'name: .inf\n', /quote it as written: name: ".inf"$/],
    ['true', 'name: true\n', /YAML reads this one as true or false — quote it as written: name: "true"$/],
    ['a list', 'name: [a]\n', /must be text, not a list$/],
    ['a mapping', 'name: { a: 1 }\n', /must be text, not a mapping$/],
    ['a leading space', 'name: " CPU"\n', /starts or ends with a space/],
    ['a trailing space', 'name: "CPU "\n', /starts or ends with a space/],
    ['a no-break space at the end', 'name: "CPU\\u00a0"\n', /starts or ends with a space/],
    ['a line break', 'name: "CPU\\nhigh"\n', /line break/],
    ['a tab', 'name: "CPU\\thigh"\n', /control character/],
    ['U+2028', 'name: "CPU\\u2028high"\n', /line break/],
    ['201 characters', `name: "${'x'.repeat(GROUP_NAME_MAX + 1)}"\n`, /201 characters long — at most 200/],
  ])('refuses name: %s, naming the file', (_, head, why) => {
    const errors = errorsOf({ 'cpu.yaml': file(head) })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^cpu\.yaml: /)
    expect(errors[0]).toMatch(why)
  })

  it('refuses two groups with one name, and one taking another\'s default — said on the file that wrote name:, whatever the order; case alone is two names', () => {
    expect(errorsOf({ 'a.yaml': file('name: CPU\n'), 'b.yaml': file('name: CPU\n') })).toEqual([
      'a.yaml: name "CPU" is already the rule-group name of b.yaml — two groups of a chart need two names',
      'b.yaml: name "CPU" is already the rule-group name of a.yaml — two groups of a chart need two names',
    ])
    expect(errorsOf({ 'a_cpu.yaml': file(''), 'b.yaml': file('name: a-cpu\n') }))
      .toEqual(['b.yaml: name "a-cpu" is already the rule-group name of a_cpu.yaml (its default, from the file name) — two groups of a chart need two names'])
    expect(errorsOf({ 'a.yaml': file('name: b-cpu\n'), 'b_cpu.yaml': file('') }))
      .toEqual(['a.yaml: name "b-cpu" is already the rule-group name of b_cpu.yaml (its default, from the file name) — two groups of a chart need two names'])
    expect(errorsOf({ 'a.yaml': file('name: CPU\n'), 'b.yaml': file('name: cpu\n') })).toEqual([])
    // Its own default, written out, is its name and nobody else's.
    expect(errorsOf({ 'mariadb_cpu.yaml': file('name: mariadb-cpu\n'), 'b.yaml': file('') })).toEqual([])
  })

  // Unicode normalisation is not applied: "Café" written with é (NFC) and
  // with e and a combining accent (NFD) are two names, to AlertForge as to
  // Prometheus and vmalert, which compare the bytes.
  it('takes Café in NFC and in NFD as two names', () => {
    const nfc = 'Caf\u00e9'
    const nfd = 'Cafe\u0301'
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'))
    expect(errorsOf({ 'a.yaml': file(`name: "${nfc}"\n`), 'b.yaml': file(`name: "${nfd}"\n`) })).toEqual([])
  })

  it('reads own keys only: groups named constructor and toString', () => {
    expect(errorsOf({ 'constructor.yaml': file('name: toString\n'), 'tostring.yaml': file('name: constructor\n') })).toEqual([])
    expect(groupName('constructor', {})).toBe('constructor')
  })

  it('what is refused and what is taken agree with groupNameProblem', () => {
    for (const v of ['ok', ' x', 'x ', '', 'a\nb', 'a\u0085b', 'a b', ' a']) {
      const refused = errorsOf({ 'g.yaml': file(`name: ${JSON.stringify(v)}\n`) }).length > 0
      expect(refused, JSON.stringify(v)).toBe(groupNameProblem(v) !== null)
    }
    // A no-break space inside is text.
    expect(groupNameProblem('a b')).toBeNull()
  })
})

describe('writing name: back', () => {
  it('keeps it, quoted where YAML would read it as something else, and reads back the same', () => {
    for (const name of ['MariaDB CPU', 'yes', 'null', '5', 'a: b', '{{ .x }}', 'mariadb-cpu']) {
      const { model } = parseRulesDir({ 'mariadb_cpu.yaml': file(`name: ${JSON.stringify(name)}\n`) })
      const text = groupFileText(model.groups.mariadb_cpu)
      expect(text.split('\n')[1]).toMatch(/^name: /)
      const again = parseRulesDir({ 'mariadb_cpu.yaml': text })
      expect(again.errors).toEqual([])
      expect(again.model.groups.mariadb_cpu.name).toBe(name)
    }
  })

  it('writes nothing for a group without one', () => {
    const { model } = parseRulesDir({ 'cpu.yaml': file('') })
    expect(groupFileText(model.groups.cpu)).not.toMatch(/^name:/m)
  })
})

describe('the generated template', () => {
  const generate = files => {
    const { model, errors } = parseRulesDir(files)
    expect(errors).toEqual([])
    return generateProducts(model, null, null)
  }

  it('says the name in spec.groups[].name only: template file, object names and the values key stay', () => {
    const { templates, schemaText } = generate({ 'mariadb_cpu.yaml': file('name: MariaDB CPU\n') })
    expect(Object.keys(templates)).toEqual(['mariadb-cpu.yaml'])
    const t = templates['mariadb-cpu.yaml']
    expect(t).toContain('    - name: MariaDB CPU\n')
    expect(t).toContain('name: {{ $.Release.Name }}-mariadb-cpu-1-{{ add1 $chunkIndex }}\n')
    expect(t).toContain('$.Values.mariadb_cpu')
    expect(Object.keys(JSON.parse(schemaText).properties)).toEqual(['mariadb_cpu'])
  })

  it('leaves a group without one exactly as before', () => {
    const before = generate({ 'mariadb_cpu.yaml': file('') }).templates
    const same = generate({ 'mariadb_cpu.yaml': file('name: mariadb-cpu\n') }).templates
    expect(same).toEqual(before)
  })
})

describe('the notice when it changes', () => {
  const model = head => parseRulesDir({ 'cpu.yaml': file(head), 'disk.yaml': file('') }).model

  it.each([
    ['set', '', 'name: CPU\n', 'cpu', 'CPU'],
    ['changed', 'name: CPU\n', 'name: CPU load\n', 'CPU', 'CPU load'],
    ['removed', 'name: CPU\n', '', 'CPU', 'cpu'],
  ])('is said when a name is %s', (_, before, after, from, to) => {
    const changes = groupNameChanges(model(before), model(after))
    expect(changes).toEqual([{ kind: 'group-name-changed', group: 'cpu', from, to }])
    const text = describeChange(changes[0])
    expect(text).toContain(`"${from}" to "${to}"`)
    expect(text).toMatch(/pending alert waits its full `for` again/)
    expect(text).toMatch(/alertgroup label/)
  })

  it('is not said when the name it renders is the same', () => {
    expect(groupNameChanges(model(''), model('name: cpu\n'))).toEqual([])
    expect(groupNameChanges(model('name: CPU\n'), model('name: CPU\n'))).toEqual([])
    // A group that is new has nothing to change from.
    expect(groupNameChanges({ groups: {} }, model('name: CPU\n'))).toEqual([])
  })
})

describe('import', () => {
  const imported = text => importRules(text).groups.map(g => modelGroupFromImport(g))

  it('keeps the source\'s group name when the key alone would render another', () => {
    const [g] = imported('groups:\n  - name: MariaDB traffic\n    rules:\n      - alert: A\n        expr: up\n')
    expect(g.group).toBe('mariadb_traffic')
    expect(g.name).toBe('MariaDB traffic')
  })

  it('writes no name when the key renders the same', () => {
    const [g] = imported('groups:\n  - name: mariadb-traffic\n    rules:\n      - alert: A\n        expr: up\n')
    expect(g.group).toBe('mariadb_traffic')
    expect(g.name).toBeUndefined()
  })

  it('leaves one the format refuses to the key\'s', () => {
    const [g] = imported('groups:\n  - name: " padded"\n    rules:\n      - alert: A\n        expr: up\n')
    expect(g.name).toBeUndefined()
  })
})

describe('Preview\'s summary', () => {
  const rendered = tallyRendered(yaml.dump({
    apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule', metadata: { name: 'r-cpu-1-1' },
    spec: { groups: [{ name: 'MariaDB CPU', rules: [{ alert: 'CpuHigh', expr: 'up', labels: { severity: 'warning' } }] }] },
  }))

  it('finds a group by the name it renders as', () => {
    const { groups, unmatchedGroups } = summarizeGroups({
      rendered, possible: { mariadb_cpu: [{ alert: 'CpuHigh', severity: 'warning' }] }, groupRows: { mariadb_cpu: 1 }, schema: null,
      names: { mariadb_cpu: 'MariaDB CPU' },
    })
    expect(groups).toEqual([expect.objectContaining({ name: 'MariaDB CPU', valuesKey: 'mariadb_cpu', state: 'ok', missing: [] })])
    expect(unmatchedGroups).toEqual([])
  })

  it('reads own keys of the names only', () => {
    const { groups } = summarizeGroups({ rendered, possible: { constructor: [] }, groupRows: { constructor: 1 }, schema: null, names: {} })
    expect(groups[0].name).toBe('constructor')
  })
})

describe('the generated helm-unittest suite', () => {
  it('expects the group\'s own name in every document', () => {
    const { model } = parseRulesDir({ 'mariadb_cpu.yaml': file('name: MariaDB CPU\n') })
    const suite = yaml.load(generateHelmUnittestSuite(model))
    const names = suite.tests.flatMap(t => t.asserts).filter(a => a.equal?.path === 'spec.groups[0].name').map(a => a.equal.value)
    expect(names.length).toBeGreaterThan(0)
    expect(new Set(names)).toEqual(new Set(['MariaDB CPU']))
  })
})

// Helm's output read as text: a group named 2026-11-22 written bare — as a
// chart from before quoting it, or a hand-written template — is that text,
// as Kubernetes reads it, not a date.
describe('Preview\'s summary reading a date-like name', () => {
  it('finds the group by its text', () => {
    const rendered = tallyRendered('apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata: { name: r-d-1-1 }\nspec:\n  groups:\n    - name: 2026-11-22\n      rules:\n        - alert: A\n          expr: up\n')
    expect([...rendered.byGroup.keys()]).toEqual(['2026-11-22'])
    const { groups, unmatchedGroups } = summarizeGroups({ rendered, possible: { d: [{ alert: 'A', severity: '' }] }, groupRows: { d: 1 }, schema: null, names: { d: '2026-11-22' } })
    expect(groups[0]).toMatchObject({ name: '2026-11-22', state: 'ok' })
    expect(unmatchedGroups).toEqual([])
  })

  it('is what the generator writes, quoted', () => {
    const { model } = parseRulesDir({ 'd.yaml': file('name: "2026-11-22"\n') })
    expect(generateProducts(model, null, null).templates['d.yaml']).toContain('    - name: "2026-11-22"\n')
  })
})

// A hand-written template (an x-custom-template group's) may render a group
// of the same name as a generated one; which file rendered what is in
// helm template's `# Source:` lines, so each is counted from its own file.
describe('Preview\'s summary with two templates rendering one group name', () => {
  const doc = (source, alert) => `---\n# Source: dep/charts/demo/templates/${source}\napiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata: { name: r }\nspec:\n  groups:\n    - name: Infra\n      rules:\n        - alert: ${alert}\n          expr: up\n`
  const rendered = tallyRendered(doc('disk.yaml', 'DiskFull') + doc('foo.yaml', 'FooDown') + doc('foo.yaml', 'FooDown').replace(/^# Source.*\n/m, ''))

  it('counts the generated group from its own template only, and leaves the other unmatched', () => {
    const { groups, unmatchedGroups } = summarizeGroups({
      rendered, possible: { disk: [{ alert: 'DiskFull', severity: '' }] }, groupRows: { disk: 1 }, schema: { properties: { foo: { 'x-custom-template': true } } },
      names: { disk: 'Infra' },
    })
    expect(groups.find(g => g.valuesKey === 'disk').alerts).toEqual([{ alert: 'DiskFull', severity: '', count: 1 }])
    // The second FooDown document has no Source line of its own: it is foo.yaml's, the one above it.
    expect(unmatchedGroups).toEqual([{ name: 'Infra', alerts: [{ alert: 'FooDown', severity: '', count: 2 }] }])
  })
})
