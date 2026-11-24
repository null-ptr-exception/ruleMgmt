import { describe, it, expect } from 'vitest'
import { groupMark, groupMarkLabel, markCounts, commonValueMarks, identityColumnsOf, columnDefaultsOf } from '../commonMarks.js'
import { parseRulesDir, genSchema } from '../rulesFile.js'

// What the server sends for a deployment on a _common: the values its layers
// give one that writes nothing, and which layer gives each.
const SHOP = 'shop/_common/app'
const EU = 'shop/eu/_common/app'
const inheritedOf = (values, groups, common = {}) => ({
  values,
  from: { groups: Object.fromEntries(Object.entries(groups).map(([g, from]) => [g, { from, rows: values[g]?.length ?? null }])), common },
})
const ONE = inheritedOf({ disk: [{ name: 'A', warn: 70 }, { name: 'B', warn: 80 }], mem: [{ warn: 70 }], _common: { owner: 'team-shop' } }, { disk: SHOP, mem: SHOP, cpu: 'template' }, { owner: SHOP })

describe('a group against the _common that gives it', () => {
  it('is nothing to mark when no _common gives it', () => {
    expect(groupMark({ cpu: [{ name: 'A' }] }, ONE, 'cpu')).toBeNull()
    expect(groupMark({ disk: [] }, null, 'disk')).toBeNull()
    // A name every object has is no group of the _common.
    expect(groupMark({}, ONE, 'constructor')).toBeNull()
  })

  it('is inherited when the deployment does not write it', () => {
    expect(groupMark({}, ONE, 'disk')).toMatchObject({ state: 'inherited', from: SHOP, given: 2 })
  })

  it('overrides when it writes rows, clears when it writes none where the _common gives some', () => {
    expect(groupMark({ disk: [{ name: 'A', warn: 70 }] }, ONE, 'disk')).toMatchObject({ state: 'overrides', from: SHOP, given: 2 })
    expect(groupMark({ disk: [] }, ONE, 'disk')).toMatchObject({ state: 'clears', from: SHOP, given: 2 })
    // Nothing given, nothing written: nothing is cleared.
    const none = inheritedOf({ disk: [] }, { disk: SHOP })
    expect(groupMark({ disk: [] }, none, 'disk')).toMatchObject({ state: 'overrides', given: 0 })
  })

  it('names the nearest layer that gives the group, of two', () => {
    // shop gives disk and mem; shop/eu gives its own disk.
    const two = inheritedOf({ disk: [{ name: 'E', warn: 60 }], mem: [{ warn: 70 }] }, { disk: EU, mem: SHOP })
    expect(groupMark({ disk: [{ name: 'E', warn: 61 }], mem: [{ warn: 70 }] }, two, 'disk')).toMatchObject({ state: 'overrides', from: EU, given: 1 })
    expect(groupMark({ disk: [{ name: 'E', warn: 61 }], mem: [{ warn: 70 }] }, two, 'mem')).toMatchObject({ state: 'overrides', from: SHOP })
  })
})

describe('the word the group list shows', () => {
  it('is inherited, overrides or clears, and own where the _common gives no rows', () => {
    expect(groupMarkLabel(null)).toBeNull()
    expect(groupMarkLabel(groupMark({}, ONE, 'disk'))).toEqual({ word: 'inherited', title: `Inherited from ${SHOP}: 2 rows` })
    expect(groupMarkLabel(groupMark({ mem: [{ warn: 1 }] }, ONE, 'mem'))).toEqual({ word: 'overrides', title: `Overrides ${SHOP} (1 row there)` })
    expect(groupMarkLabel(groupMark({ disk: [] }, ONE, 'disk'))).toEqual({ word: 'clears', title: `This deployment writes no rows: ${SHOP} gives 2` })
    const none = inheritedOf({ disk: [] }, { disk: SHOP })
    expect(groupMarkLabel(groupMark({ disk: [{ name: 'A' }] }, none, 'disk'))).toEqual({ word: 'own', title: `This deployment's own rows: ${SHOP} gives none` })
    // No rows given, none written: it claims no rows it does not have.
    expect(groupMarkLabel(groupMark({ disk: [] }, none, 'disk'))).toEqual({ word: 'clears', title: `This deployment writes no rows: ${SHOP} gives none either` })
  })
})

describe('Common Values against the _common', () => {
  it('says which are inherited and which the deployment sets over it, with the _common\'s value', () => {
    const two = inheritedOf({ _common: { owner: 'team-shop', tier: 'gold' } }, {}, { owner: SHOP, tier: EU })
    expect(commonValueMarks({ owner: 'team-prod', region: 'eu' }, two)).toEqual({
      owner: { state: 'overrides', from: SHOP, value: 'team-shop' },
      tier: { state: 'inherited', from: EU, value: 'gold' },
    })
    expect(commonValueMarks({ owner: 'x' }, null)).toEqual({})
  })
})

describe('the columns rows are told apart by', () => {
  const files = {
    'disk.yaml': 'columns:\n  name: {type: string}\n  warn: {type: number}\nrules:\n  - alert: D\n    expr: d{n="${name}"} > ${warn}\n',
    'mem.yaml': 'columns:\n  warn: {type: number}\nrules:\n  - alert: M\n    expr: m > ${warn}\n',
  }
  it('come from the rules model, or from the schema without one', () => {
    const { model, errors } = parseRulesDir(files)
    expect(errors).toEqual([])
    expect(identityColumnsOf(model, null, 'disk')).toEqual(['name'])
    expect(identityColumnsOf(model, null, 'mem')).toEqual([])
    expect(identityColumnsOf(null, genSchema(model), 'disk')).toEqual(['name'])
    expect(identityColumnsOf(null, null, 'disk')).toEqual([])
  })
})

describe('the rows of an overridden group against the _common\'s', () => {
  const ID = ['name']
  const given = rows => inheritedOf({ disk: rows }, { disk: SHOP })
  const AB = given([{ name: 'A', warn: 70 }, { name: 'B', warn: 80 }])
  const marksOf = m => m.rows.map(r => r.mark)

  it('marks nothing on a row that is the same, says what differs, what is added and what is not taken', () => {
    const common = given([{ name: 'A', warn: 70 }, { name: 'B', warn: 80 }, { name: 'D', warn: 60 }])
    const m = groupMark({ disk: [{ name: 'A', warn: 70 }, { name: 'B', warn: 95 }, { name: 'C', warn: 50 }] }, common, 'disk', ID)
    expect(m).toMatchObject({ state: 'overrides', from: SHOP, given: 3, aligned: true, same: false })
    expect(m.rows).toEqual([{ mark: 'same' }, { mark: 'differs', there: { warn: 80 } }, { mark: 'added' }])
    expect(m.notTaken).toEqual([{ name: 'D', warn: 60 }])
    expect(markCounts(m)).toEqual({ differs: 1, added: 1, notTaken: 1 })
  })

  it('is the same rows when each row is, in any order', () => {
    const m = groupMark({ disk: [{ name: 'B', warn: 80 }, { name: 'A', warn: 70 }] }, AB, 'disk', ID)
    expect(m).toMatchObject({ aligned: true, same: true, notTaken: [] })
    expect(marksOf(m)).toEqual(['same', 'same'])
  })

  it('shows a cell only one side sets, and takes an empty cell for one not set', () => {
    const common = given([{ name: 'A', warn: 70, crit: 90 }, { name: 'B', warn: 80, note: '' }])
    const m = groupMark({ disk: [{ name: 'A', warn: 70, page: true }, { name: 'B', warn: 80, crit: null }] }, common, 'disk', ID)
    // crit is the _common's only; page is this deployment's only (undefined: not set there).
    expect(m.rows[0]).toEqual({ mark: 'differs', there: { crit: 90, page: undefined } })
    expect(Object.hasOwn(m.rows[0].there, 'page')).toBe(true)
    expect(m.rows[1]).toEqual({ mark: 'same' })
  })

  it('marks a group with no column to tell rows apart as a whole', () => {
    const common = inheritedOf({ mem: [{ warn: 70 }, { warn: 80 }] }, { mem: SHOP })
    const differs = groupMark({ mem: [{ warn: 70 }, { warn: 85 }] }, common, 'mem', [])
    expect(differs).toMatchObject({ state: 'overrides', aligned: false, same: false, rows: null, notTaken: [] })
    expect(markCounts(differs)).toBeNull()
    expect(groupMark({ mem: [{ warn: 70 }, { warn: 80 }] }, common, 'mem', [])).toMatchObject({ aligned: false, same: true, rows: null })
    // Without such a column the order is all there is to go by.
    expect(groupMark({ mem: [{ warn: 80 }, { warn: 70 }] }, common, 'mem', [])).toMatchObject({ aligned: false, same: false })
    expect(groupMark({ mem: [{ warn: 70 }] }, common, 'mem', [])).toMatchObject({ aligned: false, same: false })
  })

  it('compares with the nearest layer that gives the group, of two', () => {
    // shop gives disk A 70; shop/eu gives its own disk A 60: that one is what the deployment replaces.
    const two = inheritedOf({ disk: [{ name: 'A', warn: 60 }], mem: [{ warn: 70 }] }, { disk: EU, mem: SHOP })
    const m = groupMark({ disk: [{ name: 'A', warn: 70 }] }, two, 'disk', ID)
    expect(m).toMatchObject({ from: EU, same: false })
    expect(m.rows).toEqual([{ mark: 'differs', there: { warn: 60 } }])
  })

  it('pairs rows that repeat a name with the one they equal first, then in order', () => {
    // Twice here, once there: the one that equals it is the same, the other is added.
    const here = groupMark({ disk: [{ name: 'A', warn: 75 }, { name: 'A', warn: 70 }, { name: 'B', warn: 80 }] }, AB, 'disk', ID)
    expect(here.rows).toEqual([{ mark: 'added', repeated: true }, { mark: 'same', repeated: true }, { mark: 'same' }])
    expect(here.notTaken).toEqual([])
    // Twice there, once here.
    const there = given([{ name: 'A', warn: 70 }, { name: 'A', warn: 80 }])
    const one = groupMark({ disk: [{ name: 'A', warn: 80 }] }, there, 'disk', ID)
    expect(one.rows).toEqual([{ mark: 'same', repeated: true }])
    expect(one.notTaken).toEqual([{ name: 'A', warn: 70 }])
    // Neither equal: paired in the order written.
    const none = groupMark({ disk: [{ name: 'A', warn: 1 }, { name: 'A', warn: 2 }] }, there, 'disk', ID)
    expect(none.rows).toEqual([{ mark: 'differs', there: { warn: 70 }, repeated: true }, { mark: 'differs', there: { warn: 80 }, repeated: true }])
  })

  it('takes rows that set no telling column as rows of one name', () => {
    const common = given([{ warn: 70 }, { name: 'B', warn: 80 }])
    const m = groupMark({ disk: [{ name: '', warn: 71 }, { name: 'B', warn: 80 }] }, common, 'disk', ID)
    expect(m.rows).toEqual([{ mark: 'differs', there: { warn: 70 } }, { mark: 'same' }])
  })

  it('lists every row of the _common as not taken where the group is cleared', () => {
    const m = groupMark({ disk: [] }, AB, 'disk', ID)
    expect(m).toMatchObject({ state: 'clears', same: false, rows: [], notTaken: [{ name: 'A', warn: 70 }, { name: 'B', warn: 80 }] })
    // An inherited group has no rows of its own to mark.
    expect(groupMark({}, AB, 'disk', ID)).toEqual({ state: 'inherited', from: SHOP, given: 2 })
  })

  it('compares a row that is no map as a whole', () => {
    const m = groupMark({ disk: ['x', { name: 'A', warn: 70 }] }, AB, 'disk', ID)
    expect(marksOf(m)).toEqual(['added', 'same'])
    expect(m.notTaken).toEqual([{ name: 'B', warn: 80 }])
  })
})

// Helm deploys a cell left out as its column's default (the generator digs
// the cell with it): a row that writes the default is the row that leaves
// it out, both to pair rows and to compare their cells.
describe('a cell left out and one written as its column\'s default', () => {
  const files = {
    'disk.yaml': 'columns:\n  name: {type: string}\n  port: {type: string, default: p0}\n  strict: {type: boolean, default: false}\n  warn: {type: number, default: 80}\nrules:\n  - alert: D\n    expr: d{n="${name}",p="${port}",s="${strict}"} > ${warn}\n',
    'sel.yaml': 'selectors: [namespace, pod]\ncolumns:\n  namespace: {type: string, required: true}\n  pod: {type: string, default: ".*"}\n  warn: {type: number, default: 80}\nrules:\n  - alert: S\n    expr: cpu{${selector}} > ${warn}\n',
  }
  const { model } = parseRulesDir(files)
  const of = g => [identityColumnsOf(model, null, g), columnDefaultsOf(model, null, g)]
  const given = (g, rows) => inheritedOf({ [g]: rows }, { [g]: SHOP })
  const DISK = given('disk', [{ name: 'A', warn: 70 }, { name: 'E' }])

  it('takes the defaults from the rules model, or from the schema without one', () => {
    expect(columnDefaultsOf(model, null, 'disk')).toEqual({ port: 'p0', strict: false, warn: 80 })
    expect(columnDefaultsOf(null, genSchema(model), 'sel')).toEqual({ pod: '.*', warn: 80 })
    expect(columnDefaultsOf(null, null, 'disk')).toEqual({})
  })

  it('a true/false column written false, its default, is the row that leaves it out', () => {
    const m = groupMark({ disk: [{ name: 'A', warn: 70, strict: false }, { name: 'E' }] }, DISK, 'disk', ...of('disk'))
    expect(m).toMatchObject({ same: true, notTaken: [] })
    expect(m.rows).toEqual([{ mark: 'same' }, { mark: 'same' }])
  })

  it('a text column written as its default is the row that leaves it out; another value differs from the default', () => {
    expect(groupMark({ disk: [{ name: 'A', warn: 70 }, { name: 'E', port: 'p0' }] }, DISK, 'disk', ...of('disk'))).toMatchObject({ same: true, notTaken: [] })
    const other = groupMark({ disk: [{ name: 'A', warn: 70 }, { name: 'E', port: 'p1' }] }, DISK, 'disk', ...of('disk'))
    expect(other.rows[1]).toEqual({ mark: 'added' })
    expect(other.notTaken).toEqual([{ name: 'E' }])
  })

  it('a number column written as its default is the same cell; on the other side too', () => {
    expect(groupMark({ disk: [{ name: 'A', warn: 70 }, { name: 'E', warn: 80 }] }, DISK, 'disk', ...of('disk'))).toMatchObject({ same: true })
    const common = given('disk', [{ name: 'A', warn: 80 }])
    expect(groupMark({ disk: [{ name: 'A' }] }, common, 'disk', ...of('disk')).rows).toEqual([{ mark: 'same' }])
    // A cell that differs shows what the _common deploys: its default.
    expect(groupMark({ disk: [{ name: 'E', warn: 90 }] }, DISK, 'disk', ...of('disk')).rows).toEqual([{ mark: 'differs', there: { warn: 80 } }])
  })

  it('a selector column left out is the row that writes its default', () => {
    const common = given('sel', [{ namespace: 'ns1', pod: '.*', warn: 70 }, { namespace: 'ns1', pod: 'api', warn: 90 }])
    const m = groupMark({ sel: [{ namespace: 'ns1', warn: 70 }, { namespace: 'ns1', pod: 'api', warn: 90 }] }, common, 'sel', ...of('sel'))
    expect(m).toMatchObject({ same: true, notTaken: [] })
  })

  it('with the row identity label, a telling column written as its default is another row: the label is made of the cells written', () => {
    const { model: labelled } = parseRulesDir({ ...files, '_common.yaml': 'rowIdentity: true\n' })
    expect(columnDefaultsOf(labelled, null, 'disk')).toEqual({ warn: 80 })
    const m = groupMark({ disk: [{ name: 'A', warn: 70, strict: false }, { name: 'E', warn: 80 }] }, DISK, 'disk', identityColumnsOf(labelled, null, 'disk'), columnDefaultsOf(labelled, null, 'disk'))
    expect(m.rows).toEqual([{ mark: 'added' }, { mark: 'same' }])
  })
})
