import { describe, it, expect } from 'vitest'
import { parseRulesDir, modelToFiles, commonFileText, genSchema, parseGroupFile, rowIdentityRepeats } from '../rulesFile.js'
import { checkRules, saveBlockers } from '../ruleChecks.js'
import { rowIdentityColumns, ROW_IDENTITY_LABEL } from '../templateGenerator.js'
import { rowIdentityValue } from '../helmTestGenerator.js'

// The row identity label, an opt-in per chart in rules/_common.yaml.

const GROUP = `columns:
  db: { type: string, required: true }
  warn: { type: number, default: 80 }
rules:
  - alert: DbSlow
    expr: slow{db="\${db}"} > \${warn}
    labels: { severity: warning }
`

describe('rowIdentity in _common.yaml', () => {
  it('is off unless written, and a chart without it writes _common.yaml as before', () => {
    const common = 'columns:\n  env: {type: string}\n'
    const { model, errors } = parseRulesDir({ '_common.yaml': common, 'db.yaml': GROUP })
    expect(errors).toEqual([])
    expect(model.common.rowIdentity).toBeUndefined()
    expect(modelToFiles(model)['_common.yaml']).toBe(common)
    expect(commonFileText({ env: { type: 'string' } })).toBe(common)
  })

  it('reads true, and writes it back first', () => {
    const { model, errors } = parseRulesDir({ '_common.yaml': 'rowIdentity: true\ncolumns:\n  env: { type: string }\n', 'db.yaml': GROUP })
    expect(errors).toEqual([])
    expect(model.common.rowIdentity).toBe(true)
    expect(modelToFiles(model)['_common.yaml']).toBe('rowIdentity: true\ncolumns:\n  env: {type: string}\n')
  })

  it('needs no columns beside it', () => {
    const { model, errors } = parseRulesDir({ '_common.yaml': 'rowIdentity: true\n', 'db.yaml': GROUP })
    expect(errors).toEqual([])
    expect(modelToFiles(model)['_common.yaml']).toBe('rowIdentity: true\n')
    // false written out is off, and the file keeps it.
    const off = parseRulesDir({ '_common.yaml': 'rowIdentity: false\n', 'db.yaml': GROUP }).model
    expect(off.common.rowIdentity).toBe(false)
    expect(modelToFiles(off)['_common.yaml']).toBe('rowIdentity: false\n')
    expect(genSchema(off).properties.db.rowIdentity).toBeUndefined()
  })

  it.each([['yes'], ['"true"'], [1]])('refuses rowIdentity: %s', value => {
    const { errors } = parseRulesDir({ '_common.yaml': `rowIdentity: ${value}\n`, 'db.yaml': GROUP })
    expect(errors).toContain('_common.yaml: rowIdentity must be true or false')
  })
})

describe('the columns a row is told apart by', () => {
  it('are the text and true/false columns and the selectors, not numbers or durations', () => {
    const def = {
      selectors: ['cluster', 'namespace'],
      items: { properties: {
        namespace: { type: 'string' }, page: { type: 'boolean' }, team: { type: 'string', enum: ['a', 'b'] },
        warn: { type: 'number' }, count: { type: 'integer' },
        window: { type: 'string', pattern: '…', 'x-type': 'duration' },
      } },
    }
    expect(rowIdentityColumns(def)).toEqual(['cluster', 'namespace', 'page', 'team'])
    expect(rowIdentityColumns({ items: { properties: { warn: { type: 'number' } } } })).toEqual([])
  })
})

describe('the value', () => {
  // Worked out by hand: printf '%s' '<json>' | sha256sum | cut -c1-16, the
  // JSON as Go writes it (keys sorted, & as \u0026).
  it('is the first 16 hex digits of the sha256 of the cells as Go writes them', () => {
    expect(rowIdentityValue(['workload', 'namespace', 'page', 'team'], { namespace: 'dev', workload: 'web', page: true }))
      .toBe('3d4b96ef0896658b')
    // Only the cells the row sets: page left out is not in it.
    expect(rowIdentityValue(['namespace', 'page', 'team', 'workload'], { namespace: 'prod', workload: 'api', team: 'db&ops' }))
      .toBe('9bcd584eefe5c529')
  })
})

describe(`a label named ${ROW_IDENTITY_LABEL}`, () => {
  it('is refused on a rule, the option on or off', () => {
    const { model } = parseRulesDir({ 'db.yaml': GROUP.replace('{ severity: warning }', `{ severity: warning, ${ROW_IDENTITY_LABEL}: x }`) })
    const found = saveBlockers(checkRules(genSchema(model)))
    expect(found.map(f => f.message)).toEqual([`rule "DbSlow": the label ${ROW_IDENTITY_LABEL} is reserved for AlertForge's row identity label`])
  })

  it('is refused on a recording rule', () => {
    const { model } = parseRulesDir({ 'db.yaml': GROUP.replace(/rules:[\s\S]*/, `rules:\n  - record: db:slow\n    expr: slow{db="\${db}"}\n    labels: { ${ROW_IDENTITY_LABEL}: x }\n`) })
    expect(saveBlockers(checkRules(genSchema(model))).map(f => f.kind)).toEqual(['reserved-label'])
  })

  it('is refused as a group label', () => {
    const { errors } = parseGroupFile(`type: prometheus3\nlabels: { ${ROW_IDENTITY_LABEL}: x }\n${GROUP}`, 'db')
    expect(errors.join()).toContain(`labels "${ROW_IDENTITY_LABEL}": the name is reserved for AlertForge's row identity label`)
  })
})

describe('rows the label cannot tell apart', () => {
  const on = (group = GROUP) => parseRulesDir({ '_common.yaml': 'rowIdentity: true\n', 'db.yaml': group }).model
  const WITH_TEAM = GROUP.replace('  warn: { type: number, default: 80 }', '  team: { type: string }\n  warn: { type: number, default: 80 }')

  it('are named, with the cells they share', () => {
    expect(rowIdentityRepeats({ db: [{ db: 'a', warn: 1 }, { db: 'b' }, { db: 'a', warn: 2 }, { db: 'a', team: 'x' }, { db: 'a' }] }, on(WITH_TEAM)))
      .toEqual([{ group: 'db', rows: [1, 3, 5], message: 'db: rows 1, 3 and 5 set the same db "a" — they get the same alertforge_row, so Prometheus pairs their alerts by position again; tell them apart in a text or true/false column' }])
  })

  it('are only rows setting the same cells: a cell written out is one set', () => {
    expect(rowIdentityRepeats({ db: [{ db: 'a' }, { db: 'a', team: '' }] }, on(WITH_TEAM))).toEqual([])
  })

  it('are not looked for with the option off, in a group with nothing to tell rows by, or with no alerting rule', () => {
    const off = parseRulesDir({ 'db.yaml': GROUP }).model
    expect(rowIdentityRepeats({ db: [{ db: 'a' }, { db: 'a' }] }, off)).toEqual([])
    const numbers = on('columns:\n  warn: { type: number }\nrules:\n  - alert: A\n    expr: x > ${warn}\n')
    expect(rowIdentityRepeats({ db: [{ warn: 1 }, { warn: 1 }] }, numbers)).toEqual([])
    const recording = on('columns:\n  db: { type: string }\nrules:\n  - record: r\n    expr: x{db="${db}"}\n')
    expect(rowIdentityRepeats({ db: [{ db: 'a' }, { db: 'a' }] }, recording)).toEqual([])
  })

  it('read a _common selector as the row does', () => {
    const model = parseRulesDir({ '_common.yaml': 'rowIdentity: true\ncolumns:\n  cluster: { type: string }\n', 'db.yaml': GROUP.replace('columns:', 'selectors: [cluster]\ncolumns:') }).model
    expect(rowIdentityRepeats({ _common: { cluster: 'c1' }, db: [{ db: 'a' }, { db: 'a', warn: 9 }] }, model).map(r => r.message))
      .toEqual(['db: rows 1 and 2 set the same cluster "c1", db "a" — they get the same alertforge_row, so Prometheus pairs their alerts by position again; tell them apart in a text or true/false column'])
  })
})
