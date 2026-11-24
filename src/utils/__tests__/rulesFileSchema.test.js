// The JSON Schemas for hand-written rules files and config/outputs.json
// (#68): written from the tables the checks read, and never refusing a file
// the parser takes.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import yaml from 'js-yaml'
import Ajv from 'ajv'
import { SCHEMA_FILES, rulesFileSchema, commonFileSchema, outputsSchema } from '../rulesFileSchema.js'
import { parseRulesDir, GROUP_KEYS, RULE_KEYS, COLUMN_KEYS, COMMON_KEYS } from '../rulesFile.js'
import { parseOutputs, PROFILE_KEYS } from '../outputs.js'

const root = new URL('../../../', import.meta.url)
const ajv = new Ajv({ allErrors: true })
const validateGroup = ajv.compile(rulesFileSchema())
const validateCommon = ajv.compile(commonFileSchema())
const validateOutputs = ajv.compile(outputsSchema())

// The document as an editor sees it: an empty file is null.
const load = text => yaml.load(text) ?? null
const schemaTakes = (name, text) => {
  let doc
  try { doc = load(text) } catch { return false }
  return (name === '_common.yaml' ? validateCommon : validateGroup)(doc)
}
const schemaErrors = (name, text) => {
  schemaTakes(name, text)
  return ajv.errorsText((name === '_common.yaml' ? validateCommon : validateGroup).errors)
}
const parserTakes = files => {
  try { return parseRulesDir(files).errors.length === 0 } catch { return false }
}

// Every rules/ directory in the repository: the blind-test cases and the
// sample charts.
function rulesDirs() {
  const dirs = []
  for (const base of ['tests/fixtures/charts', 'sample/charts']) {
    for (const chart of readdirSync(new URL(base, root))) {
      const dir = new URL(`${base}/${chart}/rules/`, root)
      if (!existsSync(dir)) continue
      const files = Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.yaml')).map(f => [f, readFileSync(new URL(f, dir), 'utf8')]))
      dirs.push([`${base}/${chart}`, files])
    }
  }
  return dirs
}
const DIRS = rulesDirs()

describe('schema/*.schema.json', () => {
  it.each(Object.keys(SCHEMA_FILES))('%s is the schema as built — run node scripts/gen-rules-schema.mjs after changing it', name => {
    const written = JSON.parse(readFileSync(new URL(`schema/${name}`, root), 'utf8'))
    expect(written).toEqual(JSON.parse(JSON.stringify(SCHEMA_FILES[name]())))
  })

  it('names every key the parser reads, and no other', () => {
    const group = rulesFileSchema()
    expect(Object.keys(group.properties).sort()).toEqual([...GROUP_KEYS].sort())
    expect(group.additionalProperties).toBe(false)
    expect(Object.keys(group.properties.rules.items.properties).sort()).toEqual([...RULE_KEYS].sort())
    const column = group.properties.columns.anyOf[0].additionalProperties.anyOf[0]
    expect(Object.keys(column.properties).sort()).toEqual([...COLUMN_KEYS].sort())
    expect(Object.keys(commonFileSchema().properties).sort()).toEqual([...COMMON_KEYS].sort())
    const profile = outputsSchema().properties.outputs.additionalProperties
    expect(Object.keys(profile.properties).sort()).toEqual([...PROFILE_KEYS].sort())
  })
})

describe('rules-file.schema.json and common-file.schema.json', () => {
  it('finds the repository\'s rules files', () => {
    expect(DIRS.length).toBeGreaterThanOrEqual(40)
  })

  it.each(DIRS)('takes every file of %s, which the parser takes', (_, files) => {
    expect(parseRulesDir(files).errors).toEqual([])
    for (const [name, text] of Object.entries(files)) expect(schemaErrors(name, text), name).toBe('No errors')
  })

  // Values at the edges the parser takes — some only because it reads them
  // leniently. The schema has to take each one too.
  const base = 'columns:\n  job: { type: string }\n'
  const alert = extra => `${base}rules:\n  - alert: A\n    expr: up{job="\${job}"}\n${extra}`
  const ACCEPTED = {
    'no type, so prometheus2': alert(''),
    'type: prometheus (the alias)': `type: prometheus\n${alert('')}`,
    'once: false beside columns': `once: false\n${alert('')}`,
    'interval: "0"': `interval: "0"\n${alert('')}`,
    'limit: 0': `limit: 0\n${alert('')}`,
    'limit: 2.0': `limit: 2.0\n${alert('')}`,
    'eval_offset equal to the interval': `type: vm\ninterval: 1m\neval_offset: 1m\n${alert('')}`,
    'rules: []': `${base}rules: []\n`,
    'columns: with nothing': 'columns:\nrules: []\n',
    'columns: {}': 'columns: {}\nrules: []\n',
    'a column with nothing': 'columns:\n  job:\nrules: []\n',
    'a column with type: and nothing': 'columns:\n  job: { type: null }\nrules: []\n',
    'a column named a-b': 'columns:\n  a-b: { type: string }\nrules: []\n',
    'required: "yes"': 'columns:\n  job: { required: "yes" }\nrules: []\n',
    'enum: a, not a list': 'columns:\n  job: { enum: a }\nrules: []\n',
    'an integer column with default abc': 'columns:\n  n: { type: integer, default: abc }\nrules: []\n',
    'a duration default 0s': 'columns:\n  w: { type: duration, default: 0s }\nrules: []\n',
    'vars: abc': `vars: abc\n${alert('')}`,
    'vars: { t: 5 }': `vars: { t: 5 }\n${alert('')}`,
    'vars: with nothing': `vars:\n${alert('')}`,
    'derived: with nothing': `derived:\n${alert('')}`,
    'selectors: []': `selectors: []\n${alert('')}`,
    'selectorLabels: {}': `selectorLabels: {}\n${alert('')}`,
    'group: matching the file': `group: g\n${alert('')}`,
    'labels: { severity: 5 }': alert('    labels: { severity: 5 }\n'),
    'labels: with nothing': alert('    labels:\n'),
    'alert: with nothing': `${base}rules:\n  - alert:\n    expr: up\n`,
    'alert: 5': `${base}rules:\n  - alert: 5\n    expr: up\n`,
    'an alert with no expr': `${base}rules:\n  - alert: A\n`,
    'note: 5': alert('    note: 5\n'),
    'raw: with nothing': 'rules:\n  - raw:\n',
    'raw beside alert': 'rules:\n  - raw: "- alert: X\\n  expr: up"\n    alert: Y\n',
    'record: with nothing': `${base}rules:\n  - record:\n    expr: up\n`,
    'for: with nothing': alert('    for:\n'),
    'for: ""': alert('    for: ""\n'),
    'for: 0': alert('    for: 0\n'),
    'for: "0"': alert('    for: "0"\n'),
    'for: 0s': alert('    for: 0s\n'),
    'for: ${w}': 'columns:\n  w: { type: duration }\nrules:\n  - alert: A\n    expr: up\n    for: ${w}\n',
    'for: ${n}m': 'columns:\n  n: { type: integer }\nrules:\n  - alert: A\n    expr: up\n    for: ${n}m\n',
    'keep_firing_for: with nothing': alert('    keep_firing_for:\n'),
  }
  it.each(Object.entries(ACCEPTED))('takes %s, as the parser does', (_, text) => {
    expect(parseRulesDir({ 'g.yaml': text }).errors).toEqual([])
    expect(schemaErrors('g.yaml', text)).toBe('No errors')
  })

  it.each([
    ['an empty _common.yaml', ''],
    ['rowIdentity: false', 'rowIdentity: false\n'],
    ['columns: with nothing', 'columns:\n'],
  ])('takes %s, as the parser does', (_, text) => {
    expect(parseRulesDir({ '_common.yaml': text, 'g.yaml': 'rules: []\n' }).errors).toEqual([])
    expect(schemaErrors('_common.yaml', text)).toBe('No errors')
  })

  // Every key of every file, set to each value of the boundary list: what
  // the parser takes, the schema takes.
  const VALUES = [null, 0, 1, 2.5, -1, 1e20, '', '0', '0s', '5m', '-5m', '1.5h', 'x', 'yes', true, false, [], ['x'], [1], [null], [{}], {}, { a: 'x' }, { a: 1 }, { a: ['x'] }, '${a}', '${a}}', '{{ x }}']
  it('takes every value at every key that the parser takes, in every repository file', () => {
    let tried = 0
    let taken = 0
    const wrong = []
    for (const [dir, files] of DIRS) {
      for (const [name, text] of Object.entries(files)) {
        const doc = load(text) || {}
        const at = []
        if (name === '_common.yaml') {
          for (const k of COMMON_KEYS) at.push(v => ({ ...doc, [k]: v }))
        } else {
          for (const k of GROUP_KEYS) at.push(v => ({ ...doc, [k]: v }))
          if (doc.rules?.[0]) for (const k of RULE_KEYS) at.push(v => ({ ...doc, rules: [{ ...doc.rules[0], [k]: v }, ...doc.rules.slice(1)] }))
          const derived = Object.keys(doc.derived || {})[0]
          if (derived) for (const k of ['expr', 'unit']) at.push(v => ({ ...doc, derived: { ...doc.derived, [derived]: { ...doc.derived[derived], [k]: v } } }))
        }
        const column = Object.keys(doc.columns || {})[0]
        if (column) at.push(v => ({ ...doc, columns: { ...doc.columns, [column]: v } }))
        if (doc.rules?.[0]) at.push(v => ({ ...doc, rules: [v, ...doc.rules.slice(1)] }))
        if (column) for (const k of COLUMN_KEYS) at.push(v => ({ ...doc, columns: { ...doc.columns, [column]: { ...doc.columns[column], [k]: v } } }))
        for (const mutate of at) {
          for (const v of VALUES) {
            const changed = yaml.dump(mutate(v))
            tried++
            // Only _common.yaml is read beside a group file.
            const read = name === '_common.yaml' ? { ...files, [name]: changed } : { ...(files['_common.yaml'] !== undefined ? { '_common.yaml': files['_common.yaml'] } : {}), [name]: changed }
            if (!parserTakes(read)) continue
            taken++
            if (!schemaTakes(name, changed)) wrong.push(`${dir}/${name}: ${schemaErrors(name, changed)}\n${changed}`)
          }
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([])
    expect(tried).toBeGreaterThan(10000)
    expect(taken).toBeGreaterThan(1000)
  }, 120000)

  // Files the parser refuses, most from rulesFile.test.js. The schema
  // refuses what it can see in one file's shape; the rest (a name colliding,
  // a value past a limit, two fields that go together) is the save's.
  const ok = 'columns:\n  job: { type: string }\nrules:\n  - alert: A\n    expr: up\n'
  const REFUSED = [
    ['a misspelled group key (intervel)', `intervel: 1m\n${ok}`, true],
    ['a misspelled column key', 'columns:\n  ns: { type: string, wat: 1 }\nrules: []\n', true],
    ['a misspelled rule key', `${ok}    severity: page\n`, true],
    // Read as written they would deploy something else (labels 0, 1, 2; a
    // label "undefined"; the text "null").
    ['labels: abc', `${ok}    labels: abc\n`, true],
    ['labels as a list', `${ok}    labels:\n      - severity: warning\n`, true],
    ['labels as a list of key and value', `${ok}    labels: [{ key: severity, value: warning }]\n`, true],
    ['a label of null', `${ok}    labels: { severity: null }\n`, true],
    ['an annotation that is a list', `${ok}    annotations: { summary: [a] }\n`, true],
    ['expr as a list', 'columns:\n  job: { type: string }\nrules:\n  - alert: A\n    expr: [up]\n', true],
    ['alert as a mapping', 'rules:\n  - alert: { a: 1 }\n    expr: up\n', true],
    ['raw as a mapping', 'rules:\n  - raw: { a: 1 }\n', true],
    ['record as a list', 'rules:\n  - record: [x]\n    expr: up\n', true],
    ['a type that is no profile', `type: graphite\n${ok}`, true],
    ['type: routing', `type: routing\n${ok}`, true],
    ['interval: 1 m', `interval: 1 m\n${ok}`, true],
    ['interval: 30, a number', `interval: 30\n${ok}`, true],
    ['interval: 30m1h', `interval: 30m1h\n${ok}`, true],
    ['interval: with nothing', `interval:\n${ok}`, true],
    ['interval: 293y, longer than a duration can be', `interval: 293y\n${ok}`, false],
    ['limit: -1', `limit: -1\n${ok}`, true],
    ['limit: 1.5', `limit: 1.5\n${ok}`, true],
    ['limit: past what is held exactly', `limit: 99999999999999999999\n${ok}`, true],
    ['labels on a prometheus2 group', `labels: { team: x }\n${ok}`, true],
    ['concurrency on a prometheus group', `type: prometheus\nconcurrency: 2\n${ok}`, true],
    ['query_offset on a vm group', `type: vm\nquery_offset: 1m\n${ok}`, true],
    ['eval_offset: -30s', `type: vm\ninterval: 1m\neval_offset: -30s\n${ok}`, true],
    ['eval_offset with no interval', `type: vm\neval_offset: 30s\n${ok}`, false],
    ['a header with no "Name:"', `type: vm\nheaders: [nocolon]\n${ok}`, false],
    ['a group label starting with __', `type: vm\nlabels: { __x: y }\n${ok}`, false],
    ['a group label of a number', `type: vm\nlabels: { x: 1 }\n${ok}`, true],
    ['for: 30m1h', `${ok}    for: 30m1h\n`, true],
    ['for: 21, a number', `${ok}    for: 21\n`, true],
    ['for: -5m', `${ok}    for: -5m\n`, true],
    ['for: a brace beside ${window}', `${ok}    for: '{\${window}}'\n`, false],
    ['keep_firing_for: 1.5h', `${ok}    keep_firing_for: 1.5h\n`, true],
    ['a column type that is none (strng)', 'columns:\n  c: { type: strng }\nrules: []\n', true],
    ['a column type: false', 'columns:\n  c: { type: false }\nrules: []\n', true],
    ['a description that is not text', 'columns:\n  c: { description: 5 }\nrules: []\n', true],
    ['a duration column with an enum', 'columns:\n  c: { type: duration, enum: [5m] }\nrules: []\n', true],
    ['a duration column defaulting to 5, a number', 'columns:\n  c: { type: duration, default: 5 }\nrules: []\n', true],
    ['a duration column defaulting to "0"', 'columns:\n  c: { type: duration, default: "0" }\nrules: []\n', true],
    ['a column named selector', 'columns:\n  selector: { type: string }\nrules: []\n', true],
    ['columns as a list', 'columns: [a]\nrules: []\n', true],
    ['a group: not matching the file', 'group: other\nrules: []\n', false],
    ['a group: that is no group name', 'group: Cpu-high\nrules: []\n', true],
    ['no rules', 'columns: {}\n', true],
    ['an empty file', '', true],
    ['a file that is a list', '- a\n- b\n', true],
    ['a rule that is not a mapping', 'rules:\n  -\n  - 3\n', true],
    ['a rule with both alert and record', 'rules:\n  - alert: A\n    record: r\n    expr: up\n', true],
    ['a rule with neither alert nor record', 'rules:\n  - expr: up\n', true],
    ['for, keep_firing_for and annotations on a recording rule', 'rules:\n  - record: r\n    expr: up\n    for: 5m\n    annotations: { summary: x }\n', true],
    ['once: yes please', 'once: yes please\nrules: []\n', true],
    ['a once group with columns', 'once: true\ncolumns:\n  ns: { type: string }\nrules: []\n', true],
    ['a once group with derived', 'once: true\nderived:\n  d: { expr: "1", unit: m }\nrules: []\n', true],
    ['selectors: foo', `selectors: foo\n${ok}`, true],
    ['selectorLabels: foo', `selectorLabels: foo\n${ok}`, true],
    ['a rule\'s selectorLabels to a number', `${ok}    selectorLabels: { job: 5 }\n`, true],
    ['derived: a list', `derived: [a]\n${ok}`, true],
    ['derived with no unit', 'columns:\n  w: { type: integer }\nderived:\n  d: { expr: w }\nrules: []\n', true],
    ['derived with unit: weeks', 'columns:\n  w: { type: integer }\nderived:\n  d: { expr: w, unit: weeks }\nrules: []\n', true],
    ['derived with an empty expr', 'derived:\n  d: { expr: " ", unit: m }\nrules: []\n', true],
    ['derived named 1d', 'columns:\n  w: { type: integer }\nderived:\n  1d: { expr: w, unit: m }\nrules: []\n', true],
    ['derived reading a string column', 'columns:\n  w: { type: string }\nderived:\n  d: { expr: w, unit: m }\nrules: []\n', false],
    ['vars colliding with a column', 'vars:\n  ns: x\ncolumns:\n  ns: { type: string }\nrules: []\n', false],
    ['vars named selector', 'vars:\n  selector: x\nrules: []\n', true],
    ['YAML that does not parse', 'rules: [\n', true],
  ]
  it.each(REFUSED)('the parser refuses %s; the schema too: %s', (_, text, schemaRefuses) => {
    expect(parserTakes({ 'g.yaml': text })).toBe(false)
    expect(schemaTakes('g.yaml', text)).toBe(!schemaRefuses)
  })

  it.each([
    ['an unknown key', 'rules: []\n', true],
    ['rowIdentity: yes please', 'rowIdentity: yes please\n', true],
    ['a column type that is none', 'columns:\n  c: { type: strng }\n', true],
    ['a file that is a list', '- a\n', true],
  ])('the parser refuses a _common.yaml with %s; the schema too: %s', (_, text, schemaRefuses) => {
    expect(parserTakes({ '_common.yaml': text, 'g.yaml': 'rules: []\n' })).toBe(false)
    expect(schemaTakes('_common.yaml', text)).toBe(!schemaRefuses)
  })

  it('refuses a group file read as _common.yaml, and the other way round', () => {
    expect(schemaTakes('_common.yaml', ok)).toBe(false)
    expect(schemaTakes('g.yaml', 'columns:\n  c: { type: string }\n')).toBe(false)
  })
})

describe('outputs.schema.json', () => {
  const raw = JSON.parse(readFileSync(new URL('config/outputs.json', root), 'utf8'))
  const parses = doc => { try { parseOutputs(doc); return true } catch { return false } }
  const edit = change => { const doc = structuredClone(raw); change(doc); return doc }

  it('takes config/outputs.json', () => {
    expect(validateOutputs(raw), ajv.errorsText(validateOutputs.errors)).toBe(true)
  })

  it.each([
    ['an unknown top key', d => { d.extra = 1 }, true],
    ['no routing', d => { delete d.routing }, true],
    ['routing with no kind', d => { delete d.routing.kind }, true],
    ['no prometheus2', d => { delete d.outputs.prometheus2 }, true],
    ['a profile named Bad', d => { d.outputs.Bad = d.outputs.vm }, true],
    ['a profile named routing', d => { d.outputs.routing = d.outputs.vm }, true],
    ['an unknown profile key', d => { d.outputs.vm.extra = 1 }, true],
    ['no apiVersion', d => { delete d.outputs.vm.apiVersion }, true],
    ['an empty kind', d => { d.outputs.vm.kind = '' }, true],
    ['validate: nope', d => { d.outputs.vm.validate = 'nope' }, true],
    ['no query', d => { delete d.outputs.vm.query }, true],
    ['groupKeys naming no field', d => { d.outputs.vm.groupKeys = ['intervel'] }, true],
    ['an alias that is a profile', d => { d.outputs.vm.aliases = ['vlogs'] }, false],
    ['an alias of two profiles', d => { d.outputs.vm.aliases = ['prometheus'] }, false],
    ['an annotation key with a space', d => { d.outputs.vm.annotations = { 'a b': 'x' } }, true],
    ['an empty annotation value', d => { d.outputs.vm.annotations = { a: '' } }, true],
    ['groupFields setting interval', d => { d.outputs.vm.groupFields = { interval: '1m' } }, true],
    ['groupFields holding a list', d => { d.outputs.vm.groupFields = { x: [] } }, true],
  ])('parseOutputs refuses %s; the schema too: %s', (_, change, schemaRefuses) => {
    const doc = edit(change)
    expect(parses(doc)).toBe(false)
    expect(validateOutputs(doc)).toBe(!schemaRefuses)
  })
})
