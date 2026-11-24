// decide(findings, policy): the default refuses only what Helm fails on (or
// what AlertForge cannot tell Helm's answer for, or what Helm does not render
// the same way each time); a table changes that only with rows that say why.
import { describe, it, expect } from 'vitest'
import { decide, definePolicy, explain, POLICIES, defaultAction } from '../../../server/repo/policy.js'
import { finding } from '../../../server/repo/finding.js'

const f = (code, helm, extra = {}) => finding({ code, file: 'deployments/a/values.yaml', helm, message: `${code} ${helm}`, ...extra })

describe('the default', () => {
  it('refuses what Helm fails on; what Helm renders goes through', () => {
    const fails = f('values.schema', 'fails')
    const renders = f('values.note', 'renders')
    expect(decide([fails, renders], definePolicy('t'))).toEqual({ refuse: [fails], warn: [], list: [] })
  })

  it('refuses what AlertForge cannot tell, what Helm renders differently, and what renders into rules that cannot be loaded', () => {
    const unknown = f('yaml.cannot-read', 'unknown')
    const deploy = f('values.derived', 'renders', { deploy: 'fails' })
    const differently = f('yaml.key-collision', 'renders-differently')
    const na = f('rules.note', 'n/a')
    expect(decide([unknown, deploy, differently, na], definePolicy('t'))).toEqual({ refuse: [unknown, deploy, differently], warn: [], list: [] })
    expect(defaultAction(differently)).toBe('refuse')
  })

  it('a file read with two keys Helm keeps one of at random is refused by every table but Commit, which lists it', async () => {
    const { readHelmYaml } = await import('../../../server/repo/helmYaml.js')
    const { invalid } = await import('../../../server/repo/loaded.js')
    const r = readHelmYaml('1: a\n"1": b\n', { file: 'v.yaml' })
    const state = invalid('v.yaml', [r.finding])
    expect(() => state.value).toThrow()
    for (const name of Object.keys(POLICIES)) expect(decide(state.findings, name)[name === 'commit' ? 'list' : 'refuse'], name).toEqual([r.finding])
  })

  it('a finding the default lets through cannot make a file invalid', async () => {
    const { invalid } = await import('../../../server/repo/loaded.js')
    expect(() => invalid('a', [f('values.note', 'renders')])).toThrow(/cannot make a file invalid/)
    expect(() => invalid('a', [f('rules.note', 'n/a')])).toThrow(/cannot make a file invalid/)
    expect(invalid('a', [f('values.derived', 'renders', { deploy: 'fails' })]).state).toBe('invalid')
  })

  it('what Helm fails on is refused by every table but Commit, which lists it; no table lets it pass unsaid', () => {
    for (const name of Object.keys(POLICIES)) {
      const d = decide([f('values.schema', 'fails'), f('yaml.cannot-read', 'unknown'), f('values.not-under-chart-key', 'renders-differently')], name)
      expect(d[name === 'commit' ? 'list' : 'refuse'], name).toHaveLength(3)
    }
  })

  it('every row says why', () => {
    for (const table of Object.values(POLICIES)) for (const row of Object.values(table.rows)) expect(row.why.length).toBeGreaterThan(10)
  })
})

describe('rows', () => {
  const table = definePolicy('commit', {
    default: { refuse: 'list', why: 'Commit lists what Helm stops on' },
    rows: {
      'values.unreadable': { action: 'refuse', why: 'not committed as if fine' },
      'stack.*': { action: 'warn', why: 'the stack is broken whatever this commit holds' },
      'stack.link.*': { action: 'refuse', why: 'Helm renders nothing of it' },
      'values.not-under-chart-key': { action: 'list', why: 'none of it reaches the Template' },
    },
  })

  it('the exact code wins, then the longest prefix, then the table default', () => {
    const a = f('values.unreadable', 'fails')
    const b = f('stack.null', 'renders-differently')
    const c = f('stack.link.missing', 'renders')
    const d = f('values.schema', 'fails')
    const e = f('values.not-under-chart-key', 'renders-differently')
    const g = f('values.note', 'renders')
    expect(decide([a, b, c, d, e, g], table)).toEqual({ refuse: [a, c], warn: [b], list: [d, e] })
    expect(explain(d, table)).toEqual({ action: 'list', why: 'Commit lists what Helm stops on' })
    expect(explain(g, table).action).toBe('ignore')
  })

  it('a row needs an action it knows and a reason', () => {
    expect(() => definePolicy('t', { rows: { 'a.b': { action: 'refuse' } } })).toThrow(/says why/)
    expect(() => definePolicy('t', { rows: { 'a.b': { action: 'refuse', why: '  ' } } })).toThrow(/says why/)
    expect(() => definePolicy('t', { rows: { 'a.b': { action: 'block', why: 'x' } } })).toThrow(/action is one of/)
    expect(() => definePolicy('t', { rows: { 'A b': { action: 'refuse', why: 'x' } } })).toThrow(/not a code/)
    // A code always has a dot: a row `yaml` could never match.
    expect(() => definePolicy('t', { rows: { yaml: { action: 'refuse', why: 'x' } } })).toThrow(/not a code/)
    expect(() => definePolicy('t', { rows: { 'yaml.*': { action: 'refuse', why: 'x' } } })).not.toThrow()
    expect(() => definePolicy('t', { default: { refuse: 'list' } })).toThrow(/says why/)
    expect(() => definePolicy('t', { rows: { 'a.b': { action: 'warn', why: 'x' } } })).not.toThrow()
  })

  it('a policy is named by a table or by its name', () => {
    expect(() => decide([], 'nope')).toThrow(/no policy named/)
    expect(() => decide([], 'toString')).toThrow(/no policy named/)
    expect(() => decide([], {})).toThrow(/definePolicy/)
    expect(decide([], 'commit')).toEqual({ refuse: [], warn: [], list: [] })
  })

  it('a code that names a property of every object matches no row', () => {
    const t = definePolicy('t', { rows: { 'a.b': { action: 'warn', why: 'x' } } })
    for (const code of ['constructor.x', 'to-string.x', 'has-own-property.x']) expect(explain(f(code, 'renders'), t).action).toBe('ignore')
    expect(Object.getPrototypeOf(t.rows)).toBe(null)
    expect(explain(f('constructor.x', 'fails'), t).action).toBe('refuse')
  })
})

describe('a finding', () => {
  it('takes only the five helm answers and a dotted code', () => {
    expect(() => f('values.x', 'maybe')).toThrow(/helm is one of/)
    expect(() => f('values', 'fails')).toThrow(/code/)
    expect(() => f('values.x', 'fails', { deploy: 'renders' })).toThrow(/deploy/)
    expect(() => finding({ code: 'a.b', helm: 'fails', message: '' })).toThrow(/message/)
    expect(Object.isFrozen(f('values.x', 'fails'))).toBe(true)
    const p = f('values.schema', 'fails', { at: { path: ['cpu', 0] } })
    expect(Object.isFrozen(p.at)).toBe(true)
    expect(Object.isFrozen(p.at.path)).toBe(true)
    expect(() => p.at.path.push('x')).toThrow()
  })
})
