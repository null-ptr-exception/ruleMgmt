// The expr editor's lint with ${column} references, run with the editor's
// own PromQL linter: no reference is shown as a problem, and a real mistake
// beside one, in every position, is still shown.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { withColumnRefs, parsed } from '../promqlLint.js'

// The package's CommonJS build with CodeMirror's: under Node its ES build
// is read beside another copy of @codemirror/state, which CodeMirror refuses.
const require = createRequire(import.meta.url)
const { EditorState } = require('@codemirror/state')
const { ensureSyntaxTree } = require('@codemirror/language')
const { PromQLExtension } = require('@prometheus-io/codemirror-promql/dist/cjs/index.js')

const promql = new PromQLExtension()
const extension = promql.asExtension()
const lint = promql.getLinter().promQL()
const diagnose = text => lint({ state: parsed(EditorState.create({ doc: text, extensions: [extension] }), ensureSyntaxTree) })

const NUMBERS = new Set(['thr', 'v', 'warn', 'n', 'q', 'k', 't', 'a', 'b', 'win', 'w', 'o'])
const kindOf = name => (NUMBERS.has(name) ? 'number' : undefined)
const shown = text => withColumnRefs(text, diagnose, kindOf).map(d => `${d.from}-${d.to} ${d.message}`)

describe('no reference is a problem', () => {
  it.each([
    'rate(x[${win}])', 'rate(x[${win}]) > 0', 'x offset ${o}', 'rate(x[5m] offset ${o})', 'x[${a}:${b}]', 'max_over_time(x[${a}:${b}])', 'rate(x[${a}:])',
    'x{job="${job}"}', 'x{job=~"${a}|${b}"}', 'sum by (${l}) (x)', '${metric}{a="b"}', 'x > ${a}${b}', 'x > ${ spaced }', 'x{${l}="a"}', 'rate(x[${win}m])', 'x[${n}m]',
    'histogram_quantile(${q}, rate(x[5m]))', 'topk(${k}, x)', 'x @ ${t}', 'x > bool ${v}', 'label_replace(x, "${dst}", "$1", "src", "(.*)")',
    'x unless on(${l}) y', '${a} + ${b}', 'sum(rate(x{ns="${ns}"}[${w}])) by (pod) > ${thr}', 'rate(x[${w}]) offset ${o} > 0', 'rate(${m})',
    'rate(cpu_seconds_total{namespace="${namespace}"}[5m]) > ${warn}', 'abs(${metric})', 'count_values("${l}", x)',
  ])('%s', text => {
    expect(shown(text)).toEqual([])
  })
})

describe('a mistake beside a reference is shown', () => {
  it.each([
    // next to a number
    'rate(x[5m]) >> ${v}', 'x > ${v} >> 1', 'sum(x) > ${thr} by (job)', 'rate(x[5m]) > ${thr} 5', 'rate(x[5m]) > ${v} ${v}', 'x > ${a} + ',
    // next to a duration
    'rate(x[${win}]) >> 1', 'rate(x[${w}]) offset > 0', 'rate(x[${w}] > 1',
    // next to a label value
    'x{job="${job}" > 1',
    // next to a label name
    'sum by (${l} (x)', 'x{${l}="a"} >> 1', 'sum by (${l}) (x) >> 1',
    // next to a metric name
    '${metric}{a="b" > 1', '${m}{a="b"} >> 1',
    // an unknown function
    'foo(${v})',
  ])('%s', text => {
    expect(shown(text).length).toBeGreaterThan(0)
  })
})

it('with no reference, the linter on the text as it is', () => {
  expect(shown('rate(x[5m]) >> 1')).toEqual(diagnose('rate(x[5m]) >> 1').map(d => `${d.from}-${d.to} ${d.message}`))
})

// A new state parses for a few milliseconds only. On a busy machine that
// leaves a tree of the first characters, which the linter then reads: a
// clock that jumps 30 ms at every look stands for that machine: past the
// few milliseconds a new state parses for, within what parsed() allows.
describe('a machine too busy to parse at once', () => {
  const slowly = fn => {
    const now = Date.now
    let t = now()
    Date.now = () => (t += 30)
    try { return fn() } finally { Date.now = now }
  }
  const text = 'rate(cpu_seconds_total{namespace="0000000000000"}[5m]) > 0000000'

  it('the state as made holds a part of the tree, and the linter says a mistake that is not there', () => {
    const state = slowly(() => EditorState.create({ doc: text, extensions: [extension] }))
    ensureSyntaxTree(state, text.length, 5000)
    expect(lint({ state }).length).toBeGreaterThan(0)
  })

  it('parsed() gives the whole tree: no mistake', () => {
    const state = slowly(() => EditorState.create({ doc: text, extensions: [extension] }))
    expect(lint({ state: parsed(state, ensureSyntaxTree) })).toEqual([])
  })

  it('a text with references is not a problem either', () => {
    expect(slowly(() => shown('rate(cpu_seconds_total{namespace="${namespace}"}[5m]) > ${warn}'))).toEqual([])
  })
})

// The parse's time allowance is counted on the computer's clock. Where that
// clock is set forward while the lint parses (a time sync stepping it nine
// seconds), the allowance is over at once. The state here is made on a busy
// machine, so the whole parse is left to parsed(); the clock then steps once,
// at each of the looks parsed() takes at it in turn.
describe('the clock set forward while the lint parses', () => {
  const text = 'sum by (namespace) (rate(cpu_seconds_total{namespace="0000"}[5m])) > 0000 >> 1'
  const mistake = diagnose(text)
  const steppedAt = (look, by) => {
    const now = Date.now
    let t = now(), busy = true, looks = 0
    Date.now = () => {
      if (busy) return (t += 30)
      if (++looks === look) t += by
      return (t += 0.01)
    }
    try {
      const state = EditorState.create({ doc: text, extensions: [extension] })
      busy = false
      return { found: lint({ state: parsed(state, ensureSyntaxTree) }), looks }
    } finally { Date.now = now }
  }

  it('the mistake at the end of the text is found', () => {
    expect(mistake.length).toBeGreaterThan(0)
    const looks = steppedAt(0, 0).looks
    expect(looks).toBeGreaterThan(10)
    for (let look = 1; look <= looks; look++) {
      expect(steppedAt(look, 9300).found, `stepped forward at look ${look}`).toEqual(mistake)
      expect(steppedAt(look, -6500).found, `stepped back at look ${look}`).toEqual(mistake)
    }
  })
})

