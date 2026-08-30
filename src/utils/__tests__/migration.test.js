import { describe, it, expect } from 'vitest'
import { migrateRows, migrateValues, migrationLosses } from '../migration'

const targetSchema = {
  properties: {
    traffic: {
      type: 'array',
      items: { properties: { namespace: { type: 'string' }, warn_ratio: { type: 'number' } } }
    }
  }
}

const migration = {
  chart: 'mariadb-alerts',
  columns: { warn_pct: 'warn_ratio' },
  dropped: ['crit_pct']
}

const rows = [
  { namespace: 'prod', warn_pct: 80, crit_pct: 95 },
  { namespace: 'stage', warn_pct: 70, crit_pct: 90 }
]

describe('migrateRows', () => {
  it('renames the columns the declaration names', () => {
    expect(migrateRows(rows, migration)).toEqual([
      { namespace: 'prod', warn_ratio: 80 },
      { namespace: 'stage', warn_ratio: 70 }
    ])
  })

  it('leaves columns nobody mentioned alone', () => {
    expect(migrateRows([{ namespace: 'prod' }], { columns: {} })).toEqual([{ namespace: 'prod' }])
  })

  it('drops what the declaration says to drop', () => {
    expect(migrateRows(rows, migration)[0]).not.toHaveProperty('crit_pct')
  })

  it('is a no-op without a declaration', () => {
    expect(migrateRows(rows, undefined)).toEqual(rows)
  })
})

describe('migrateValues', () => {
  it('moves a deployment onto the clone', () => {
    const { values, orphaned } = migrateValues({ traffic: rows }, migration, targetSchema)
    expect(values.traffic).toHaveLength(2)
    expect(values.traffic[0].warn_ratio).toBe(80)
    expect(orphaned).toEqual([])
  })

  it('reports groups the clone no longer has instead of guessing', () => {
    const { values, orphaned } = migrateValues({ traffic: rows, gone: [{ x: 1 }] }, migration, targetSchema)
    expect(orphaned).toEqual(['gone'])
    expect(values).not.toHaveProperty('gone')
  })

  it('follows a renamed group', () => {
    const { values } = migrateValues(
      { old_traffic: rows },
      { ...migration, groups: { old_traffic: 'traffic' } },
      targetSchema
    )
    expect(values.traffic).toHaveLength(2)
  })
})

describe('migrationLosses', () => {
  it('names what a row loses before the move happens', () => {
    expect(migrationLosses({ traffic: rows }, migration, targetSchema))
      .toEqual([{ group: 'traffic', columns: ['crit_pct'] }])
  })

  it('counts a column with nowhere to land as a loss, declaration or not', () => {
    const withExtra = [{ namespace: 'prod', warn_pct: 80, stray: 'x' }]
    expect(migrationLosses({ traffic: withExtra }, migration, targetSchema))
      .toEqual([{ group: 'traffic', columns: ['stray'] }])
  })

  it('is empty when everything lands somewhere', () => {
    const clean = [{ namespace: 'prod', warn_pct: 80 }]
    expect(migrationLosses({ traffic: clean }, migration, targetSchema)).toEqual([])
  })
})
