import { describe, it, expect } from 'vitest'
import { matchesFilter, getWsOperators, NUM_OPERATORS, STR_OPERATORS } from '../../src/utils/filterUtils.js'

// ─── getWsOperators ──────────────────────────────────────────────────────────

describe('getWsOperators', () => {
  it('returns STR_OPERATORS when varDef is undefined', () => {
    expect(getWsOperators(undefined)).toEqual(STR_OPERATORS)
  })

  it('returns STR_OPERATORS for string type', () => {
    expect(getWsOperators({ type: 'string' })).toEqual(STR_OPERATORS)
  })

  it('returns NUM_OPERATORS for number type', () => {
    expect(getWsOperators({ type: 'number' })).toEqual(NUM_OPERATORS)
  })

  it('returns NUM_OPERATORS for integer type', () => {
    expect(getWsOperators({ type: 'integer' })).toEqual(NUM_OPERATORS)
  })

  it('returns NUM_OPERATORS for numeric enum', () => {
    expect(getWsOperators({ type: 'enum', enum: [1, 2, 3] })).toEqual(NUM_OPERATORS)
  })

  it('returns ["="] for string enum', () => {
    expect(getWsOperators({ type: 'enum', enum: ['a', 'b'] })).toEqual(['='])
  })

  it('returns STR_OPERATORS for unrecognised type', () => {
    expect(getWsOperators({ type: 'boolean' })).toEqual(STR_OPERATORS)
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
    expect(matchesFilter({ instance_name: 'prod' }, { instance_name: null }, [STR_VAR])).toBe(true)
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
