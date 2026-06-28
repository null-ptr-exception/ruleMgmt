import { describe, it, expect } from 'vitest'
import { matchesFilter, getFilterOperators, mergeFilters, NUM_OPERATORS, STR_OPERATORS } from '../../src/utils/filterUtils.js'

// ─── getFilterOperators ───────────────────────────────────────────────────────
// Used by both FilterHeader (AlertTable column headers) and WorkspaceFilterBar.

describe('getFilterOperators', () => {
  it('returns STR_OPERATORS when varDef is undefined', () => {
    expect(getFilterOperators(undefined)).toEqual(STR_OPERATORS)
  })

  it('returns STR_OPERATORS for string type', () => {
    expect(getFilterOperators({ type: 'string' })).toEqual(STR_OPERATORS)
  })

  it('returns NUM_OPERATORS for number type', () => {
    expect(getFilterOperators({ type: 'number' })).toEqual(NUM_OPERATORS)
  })

  it('returns NUM_OPERATORS for integer type', () => {
    expect(getFilterOperators({ type: 'integer' })).toEqual(NUM_OPERATORS)
  })

  it('returns NUM_OPERATORS for numeric enum', () => {
    expect(getFilterOperators({ type: 'enum', enum: [1, 2, 3] })).toEqual(NUM_OPERATORS)
  })

  it('returns ["="] for string enum', () => {
    expect(getFilterOperators({ type: 'enum', enum: ['a', 'b'] })).toEqual(['='])
  })

  it('returns STR_OPERATORS for unrecognised type', () => {
    expect(getFilterOperators({ type: 'boolean' })).toEqual(STR_OPERATORS)
  })
})

// ─── mergeFilters ─────────────────────────────────────────────────────────────
// Section filters take precedence over workspace filters for the same key.

describe('mergeFilters', () => {
  it('returns wsFilters unchanged when sectionFilters is empty', () => {
    const ws = { threshold: { op: '>=', value: '100' } }
    expect(mergeFilters(ws, {})).toEqual(ws)
  })

  it('merges non-overlapping keys', () => {
    const ws = { threshold: { op: '>=', value: '100' } }
    const section = { instance_name: { op: 'contains', value: 'prod' } }
    expect(mergeFilters(ws, section)).toEqual({ ...ws, ...section })
  })

  it('section filter overrides workspace filter for same key', () => {
    const ws = { instance_name: { op: 'contains', value: 'prod' } }
    const section = { instance_name: { op: '=', value: 'staging' } }
    expect(mergeFilters(ws, section)).toEqual({ instance_name: { op: '=', value: 'staging' } })
  })

  it('skips section entries with empty string value', () => {
    const ws = { threshold: { op: '>=', value: '100' } }
    const section = { threshold: { op: '=', value: '' } }
    expect(mergeFilters(ws, section)).toEqual(ws)
  })

  it('skips section entries with null value', () => {
    const ws = { threshold: { op: '>=', value: '100' } }
    const section = { threshold: { op: '=', value: null } }
    expect(mergeFilters(ws, section)).toEqual(ws)
  })

  it('returns empty object when both are empty', () => {
    expect(mergeFilters({}, {})).toEqual({})
  })

  it('does not mutate wsFilters input', () => {
    const ws = { threshold: { op: '>=', value: '100' } }
    const wsCopy = JSON.parse(JSON.stringify(ws))
    mergeFilters(ws, { threshold: { op: '=', value: '200' } })
    expect(ws).toEqual(wsCopy)
  })
})

// ─── WorkspaceFilterBar key semantics (documented behaviour) ─────────────────
// wsFilters is keyed by column *name* only. When the same column name exists
// in two alert sections with different types, the UI shows them as separate
// selectable options (e.g. "threshold (number)" vs "threshold (string)"), but
// both write to the same key. Only one ws filter per column name can be active
// at a time — the last one written wins. This is intentional: a workspace
// filter applies across all sections regardless of their local type.

describe('wsFilters key semantics — same name, different types', () => {
  it('merging a second filter for the same name overwrites the first', () => {
    const ws1 = { threshold: { op: '>=', value: '100' } }          // set by "threshold (number)"
    const ws2 = { threshold: { op: 'contains', value: 'high' } }   // then user picks "threshold (string)"
    // simulate addFilter overwrite: { ...wsFilters, [colName]: newFilter }
    const result = { ...ws1, ...ws2 }
    expect(result).toEqual({ threshold: { op: 'contains', value: 'high' } })
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('matchesFilter uses the section-local varDef to evaluate the shared filter', () => {
    // Both sections have a "threshold" column but different types.
    // The ws filter {op:'>=', value:'100'} applies to both; each section
    // evaluates it against its own type.
    const numVars = [{ name: 'threshold', type: 'number' }]
    const strVars = [{ name: 'threshold', type: 'string' }]
    const filter = { threshold: { op: '>=', value: '100' } }

    // number section: numeric comparison — row with 150 passes
    expect(matchesFilter({ threshold: 150 }, filter, numVars)).toBe(true)
    // string section: falls back to string path — op '>=' is not '=', so contains check
    // '200' contains '100'? No → false (string "200".includes("100") === false)
    expect(matchesFilter({ threshold: '200' }, filter, strVars)).toBe(false)
    // string section: 'above-100-limit' contains '100' → true
    expect(matchesFilter({ threshold: 'above-100-limit' }, filter, strVars)).toBe(true)
  })
})

// ─── matchesFilter ────────────────────────────────────────────────────────────

const STR_VAR = { name: 'instance_name', type: 'string' }
const NUM_VAR = { name: 'threshold', type: 'number' }
const INT_VAR = { name: 'count', type: 'integer' }
const ENUM_NUM_VAR = { name: 'level', type: 'enum', enum: [1, 2, 3] }
const ENUM_STR_VAR = { name: 'env', type: 'enum', enum: ['prod', 'staging'] }

describe('matchesFilter — empty / null filter guard', () => {
  it('returns true when filters is empty', () => {
    expect(matchesFilter({ instance_name: 'prod' }, {}, [STR_VAR])).toBe(true)
  })

  it('returns true when filter value is empty string', () => {
    expect(matchesFilter({ instance_name: 'prod' }, { instance_name: { op: 'contains', value: '' } }, [STR_VAR])).toBe(true)
  })

  it('returns true when filter value is null', () => {
    expect(matchesFilter({ instance_name: 'prod' }, { instance_name: { op: 'contains', value: null } }, [STR_VAR])).toBe(true)
  })

  it('returns true when filter value is undefined', () => {
    expect(matchesFilter({ instance_name: 'prod' }, { instance_name: { op: 'contains', value: undefined } }, [STR_VAR])).toBe(true)
  })
})

describe('matchesFilter — string contains (default op)', () => {
  const vars = [STR_VAR]

  it('matches substring (case-insensitive)', () => {
    expect(matchesFilter({ instance_name: 'Production' }, { instance_name: { op: 'contains', value: 'prod' } }, vars)).toBe(true)
  })

  it('does not match when substring absent', () => {
    expect(matchesFilter({ instance_name: 'staging' }, { instance_name: { op: 'contains', value: 'prod' } }, vars)).toBe(false)
  })

  it('unknown op falls back to contains', () => {
    expect(matchesFilter({ instance_name: 'prod' }, { instance_name: { op: 'unknown', value: 'pro' } }, vars)).toBe(true)
  })
})

describe('matchesFilter — string exact op =', () => {
  const vars = [STR_VAR]

  it('matches exact value (case-insensitive)', () => {
    expect(matchesFilter({ instance_name: 'PROD' }, { instance_name: { op: '=', value: 'prod' } }, vars)).toBe(true)
  })

  it('rejects partial match', () => {
    expect(matchesFilter({ instance_name: 'production' }, { instance_name: { op: '=', value: 'prod' } }, vars)).toBe(false)
  })
})

describe('matchesFilter — numeric ops', () => {
  const vars = [NUM_VAR]

  it('>= includes equal', () => {
    expect(matchesFilter({ threshold: 100 }, { threshold: { op: '>=', value: '100' } }, vars)).toBe(true)
  })

  it('>= excludes smaller', () => {
    expect(matchesFilter({ threshold: 99 }, { threshold: { op: '>=', value: '100' } }, vars)).toBe(false)
  })

  it('<= includes equal', () => {
    expect(matchesFilter({ threshold: 100 }, { threshold: { op: '<=', value: '100' } }, vars)).toBe(true)
  })

  it('> excludes equal', () => {
    expect(matchesFilter({ threshold: 100 }, { threshold: { op: '>', value: '100' } }, vars)).toBe(false)
  })

  it('< excludes equal', () => {
    expect(matchesFilter({ threshold: 100 }, { threshold: { op: '<', value: '100' } }, vars)).toBe(false)
  })

  it('= matches exact', () => {
    expect(matchesFilter({ threshold: 42 }, { threshold: { op: '=', value: '42' } }, vars)).toBe(true)
  })

  it('= rejects different value', () => {
    expect(matchesFilter({ threshold: 42 }, { threshold: { op: '=', value: '43' } }, vars)).toBe(false)
  })

  it('works for integer type', () => {
    const vars = [INT_VAR]
    expect(matchesFilter({ count: 5 }, { count: { op: '>', value: '3' } }, vars)).toBe(true)
  })
})

describe('matchesFilter — NaN / non-numeric cell handling', () => {
  const vars = [NUM_VAR]

  it('returns false when cell value is NaN', () => {
    expect(matchesFilter({ threshold: 'not-a-number' }, { threshold: { op: '>=', value: '0' } }, vars)).toBe(false)
  })

  it('returns false when filter value is NaN', () => {
    expect(matchesFilter({ threshold: 100 }, { threshold: { op: '>=', value: 'abc' } }, vars)).toBe(false)
  })

  it('returns false when cell is null for numeric filter', () => {
    expect(matchesFilter({ threshold: null }, { threshold: { op: '>=', value: '0' } }, vars)).toBe(false)
  })

  it('rejects cell value with numeric prefix ("100ms" is not a valid number)', () => {
    expect(matchesFilter({ threshold: '100ms' }, { threshold: { op: '>=', value: '0' } }, vars)).toBe(false)
  })

  it('rejects filter value with numeric prefix ("100ms" as filter value)', () => {
    expect(matchesFilter({ threshold: 100 }, { threshold: { op: '>=', value: '100ms' } }, vars)).toBe(false)
  })
})

describe('matchesFilter — numeric enum', () => {
  const vars = [ENUM_NUM_VAR]

  it('treats numeric enum as number — >= match', () => {
    expect(matchesFilter({ level: 2 }, { level: { op: '>=', value: '2' } }, vars)).toBe(true)
  })

  it('treats numeric enum as number — = mismatch', () => {
    expect(matchesFilter({ level: 1 }, { level: { op: '=', value: '2' } }, vars)).toBe(false)
  })
})

describe('matchesFilter — string enum', () => {
  const vars = [ENUM_STR_VAR]

  it('does exact match (= op)', () => {
    expect(matchesFilter({ env: 'prod' }, { env: { op: '=', value: 'prod' } }, vars)).toBe(true)
  })

  it('rejects partial match with = op', () => {
    expect(matchesFilter({ env: 'production' }, { env: { op: '=', value: 'prod' } }, vars)).toBe(false)
  })
})

describe('matchesFilter — commonValues lookup', () => {
  const vars = [STR_VAR, { name: 'namespace', type: 'string' }]
  const commonValues = { namespace: 'monitoring' }

  it('reads common var value from commonValues, not row', () => {
    const row = { instance_name: 'prod' } // no namespace field on row
    expect(matchesFilter(row, { namespace: { op: 'contains', value: 'monit' } }, vars, commonValues)).toBe(true)
  })

  it('common var filter excludes rows when value does not match', () => {
    const row = { instance_name: 'prod' }
    expect(matchesFilter(row, { namespace: { op: '=', value: 'default' } }, vars, commonValues)).toBe(false)
  })

  it('non-common var still reads from row even when same key absent in commonValues', () => {
    const row = { instance_name: 'staging' }
    expect(matchesFilter(row, { instance_name: { op: '=', value: 'staging' } }, vars, commonValues)).toBe(true)
  })
})

describe('matchesFilter — multiple filters (AND semantics)', () => {
  const vars = [STR_VAR, NUM_VAR]

  it('passes when all filters match', () => {
    expect(matchesFilter(
      { instance_name: 'prod', threshold: 200 },
      { instance_name: { op: 'contains', value: 'prod' }, threshold: { op: '>=', value: '100' } },
      vars
    )).toBe(true)
  })

  it('fails when one filter does not match', () => {
    expect(matchesFilter(
      { instance_name: 'prod', threshold: 50 },
      { instance_name: { op: 'contains', value: 'prod' }, threshold: { op: '>=', value: '100' } },
      vars
    )).toBe(false)
  })
})

describe('matchesFilter — unknown var (no varDef found)', () => {
  it('falls back to string contains when var not in vars array', () => {
    expect(matchesFilter({ extra: 'hello' }, { extra: { op: 'contains', value: 'hell' } }, [])).toBe(true)
  })

  it('falls back to string = when var not in vars array', () => {
    expect(matchesFilter({ extra: 'hello' }, { extra: { op: '=', value: 'hello' } }, [])).toBe(true)
  })
})
