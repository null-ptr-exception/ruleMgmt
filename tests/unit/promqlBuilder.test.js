import { describe, it, expect } from 'vitest'
import { buildFinalQuery, emptySegment } from '../../src/components/PromQLBuilder.jsx'

// Build a metric segment by spreading the factory and overriding fields.
const metricSeg = (overrides = {}) => ({ ...emptySegment(), ...overrides })
// Default outer (no wrapping aggregation).
const noOuter = { func: '', aggLabels: '', dim: 'by', param: '' }

// Helper to build a query from a single segment with no outer wrapper.
const build = (seg, outer = noOuter, outerOffset = '') =>
  buildFinalQuery([seg], outer, outerOffset)

describe('buildFinalQuery — selectors', () => {
  it('builds a simple metric selector with no matchers', () => {
    expect(build(metricSeg({ metric: 'up' }))).toBe('up')
  })

  it('builds a selector with a single equality matcher', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      matchers: [{ label: 'job', op: '=', value: 'api' }],
    })
    expect(build(seg)).toBe('http_requests_total{job="api"}')
  })

  it('supports all label match operators', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      matchers: [
        { label: 'job', op: '=', value: 'api' },
        { label: 'env', op: '!=', value: 'dev' },
        { label: 'path', op: '=~', value: '/v1/.*' },
        { label: 'code', op: '!~', value: '5..' },
      ],
    })
    expect(build(seg)).toBe(
      'http_requests_total{job="api", env!="dev", path=~"/v1/.*", code!~"5.."}'
    )
  })

  it('ignores matchers with blank label names', () => {
    const seg = metricSeg({
      metric: 'up',
      matchers: [
        { label: '', op: '=', value: 'ignored' },
        { label: 'job', op: '=', value: 'api' },
      ],
    })
    expect(build(seg)).toBe('up{job="api"}')
  })
})

describe('buildFinalQuery — range functions', () => {
  it('wraps with a range function and interval', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      rangeFunc: 'rate',
      rangeInterval: '5m',
    })
    expect(build(seg)).toBe('rate(http_requests_total[5m])')
  })

  it('defaults the interval to 5m when blank', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      rangeFunc: 'rate',
      rangeInterval: '',
    })
    expect(build(seg)).toBe('rate(http_requests_total[5m])')
  })

  it('appends a custom range offset', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      rangeFunc: 'rate',
      rangeInterval: '1m',
      rangeOffset: '10m',
    })
    expect(build(seg)).toBe('rate(http_requests_total[1m] offset 10m)')
  })

  it('handles the quantile_over_time special case with param', () => {
    const seg = metricSeg({
      metric: 'latency_seconds',
      rangeFunc: 'quantile_over_time',
      rangeInterval: '5m',
      rangeParam: '0.99',
    })
    expect(build(seg)).toBe('quantile_over_time(0.99, latency_seconds[5m])')
  })

  it('defaults quantile_over_time param to 0.95', () => {
    const seg = metricSeg({
      metric: 'latency_seconds',
      rangeFunc: 'quantile_over_time',
      rangeInterval: '5m',
      rangeParam: '',
    })
    expect(build(seg)).toBe('quantile_over_time(0.95, latency_seconds[5m])')
  })
})

describe('buildFinalQuery — instant functions', () => {
  it('wraps with a plain instant function', () => {
    const seg = metricSeg({ metric: 'temperature', instantFunc: 'abs' })
    expect(build(seg)).toBe('abs(temperature)')
  })

  it('handles histogram_quantile with a leading param', () => {
    const seg = metricSeg({
      metric: 'request_duration_bucket',
      instantFunc: 'histogram_quantile',
      instantParam: '0.9',
    })
    expect(build(seg)).toBe('histogram_quantile(0.9, request_duration_bucket)')
  })

  it('defaults histogram_quantile param to 0.95', () => {
    const seg = metricSeg({
      metric: 'request_duration_bucket',
      instantFunc: 'histogram_quantile',
      instantParam: '',
    })
    expect(build(seg)).toBe('histogram_quantile(0.95, request_duration_bucket)')
  })
})

describe('buildFinalQuery — aggregations', () => {
  it('aggregates with a "by" dimension clause', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      aggFunc: 'sum',
      aggDim: 'by',
      aggLabels: 'job, instance',
    })
    expect(build(seg)).toBe('sum by (job, instance)(http_requests_total)')
  })

  it('aggregates without a dimension clause when no labels', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      aggFunc: 'avg',
      aggLabels: '',
    })
    expect(build(seg)).toBe('avg(http_requests_total)')
  })

  it('supports a "without" dimension clause', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      aggFunc: 'sum',
      aggDim: 'without',
      aggLabels: 'instance',
    })
    expect(build(seg)).toBe('sum without (instance)(http_requests_total)')
  })

  it('topk uses a param and never a dimension clause', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      aggFunc: 'topk',
      aggParam: '3',
      aggLabels: 'job',
      aggDim: 'by',
    })
    expect(build(seg)).toBe('topk(3, http_requests_total)')
  })

  it('bottomk defaults its param to 5', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      aggFunc: 'bottomk',
      aggParam: '',
    })
    expect(build(seg)).toBe('bottomk(5, http_requests_total)')
  })

  it('quantile defaults its param to 0.95', () => {
    const seg = metricSeg({
      metric: 'http_requests_total',
      aggFunc: 'quantile',
      aggParam: '',
    })
    expect(build(seg)).toBe('quantile(0.95, http_requests_total)')
  })

  it('handles the count_values special case', () => {
    const seg = metricSeg({
      metric: 'build_version',
      aggFunc: 'count_values',
      aggParam: 'version',
    })
    expect(build(seg)).toBe('count_values("version", build_version)')
  })

  it('defaults count_values param to "value"', () => {
    const seg = metricSeg({
      metric: 'build_version',
      aggFunc: 'count_values',
      aggParam: '',
    })
    expect(build(seg)).toBe('count_values("value", build_version)')
  })
})

describe('buildFinalQuery — combining segments', () => {
  it('combines multiple segments with their operators', () => {
    const a = metricSeg({ metric: 'errors_total' })
    const b = metricSeg({ metric: 'requests_total', operator: '/' })
    expect(buildFinalQuery([a, b], noOuter, '')).toBe(
      'errors_total / requests_total'
    )
  })

  it('defaults a missing operator to +', () => {
    const a = metricSeg({ metric: 'a' })
    const b = metricSeg({ metric: 'b', operator: '' })
    expect(buildFinalQuery([a, b], noOuter, '')).toBe('a + b')
  })

  it('drops empty segments from the combination', () => {
    const a = metricSeg({ metric: 'a' })
    const empty = metricSeg({ operator: '*' })
    const c = metricSeg({ metric: 'c', operator: '-' })
    expect(buildFinalQuery([a, empty, c], noOuter, '')).toBe('a - c')
  })
})

describe('buildFinalQuery — outer wrapper', () => {
  it('wraps the combined expression in an outer aggregation', () => {
    const a = metricSeg({ metric: 'errors_total' })
    const b = metricSeg({ metric: 'requests_total', operator: '/' })
    const outer = { func: 'sum', aggLabels: 'job', dim: 'by', param: '' }
    expect(buildFinalQuery([a, b], outer, '')).toBe(
      'sum by (job)(errors_total / requests_total)'
    )
  })

  it('applies an outer offset wrapping in parentheses', () => {
    const seg = metricSeg({ metric: 'up' })
    expect(buildFinalQuery([seg], noOuter, '1h')).toBe('(up) offset 1h')
  })

  it('combines outer aggregation and outer offset', () => {
    const seg = metricSeg({ metric: 'up' })
    const outer = { func: 'count', aggLabels: '', dim: 'by', param: '' }
    expect(buildFinalQuery([seg], outer, '30m')).toBe('(count(up)) offset 30m')
  })
})

describe('buildFinalQuery — scalar and empty', () => {
  it('returns an empty string for an empty segment', () => {
    expect(build(emptySegment())).toBe('')
  })

  it('returns an empty string when given no segments', () => {
    expect(buildFinalQuery([], noOuter, '')).toBe('')
  })

  it('emits a scalar segment value, trimmed', () => {
    const seg = metricSeg({ kind: 'scalar', scalar: '  42  ' })
    expect(build(seg)).toBe('42')
  })
})

describe('emptySegment factory', () => {
  it('returns a segment with the expected default shape', () => {
    const seg = emptySegment()
    expect(seg).toMatchObject({
      kind: 'metric',
      operator: '',
      scalar: '',
      metric: '',
      matchers: [],
      rangeFunc: '',
      rangeInterval: '5m',
      rangeOffset: '',
      rangeParam: '0.95',
      instantFunc: '',
      instantParam: '0.95',
      aggFunc: '',
      aggDim: 'by',
      aggLabels: '',
      aggParam: '',
    })
    expect(seg.id).toBeDefined()
  })

  it('applies the operator argument', () => {
    expect(emptySegment('/').operator).toBe('/')
  })

  it('gives each segment a unique id', () => {
    expect(emptySegment().id).not.toBe(emptySegment().id)
  })
})
