/**
 * What each entry point does with each Finding: one table per entry point.
 *
 * The default everywhere: refuse what Helm fails on (helm: 'fails'), what
 * AlertForge cannot tell Helm's answer for (helm: 'unknown'), what Helm
 * renders but not the same way each time (helm: 'renders-differently'), and
 * what Helm renders but the rule checker refuses (deploy: 'fails'); let the
 * rest through. A finding that leaves a file without a model (an invalid
 * state, loaded.js) is always one of these. A table changes that only with rows, and every row says why:
 *
 *   definePolicy('commit', {
 *     default: { refuse: 'list', why: 'Commit lists what Helm stops on; check-repo blocks it' },
 *     rows: {
 *       'values.unreadable': { action: 'refuse', why: 'a file that cannot be read is not committed as if fine' },
 *       'stack.*':           { action: 'warn', why: '…' },   // every code under stack.
 *     },
 *   })
 *
 * A row's key is a code, or a prefix ending in `.*`; the exact code wins,
 * then the longest prefix. `default.refuse` is what the table does with a
 * finding the default would refuse and no row names.
 *
 *   decide(findings, policy) → { refuse: Finding[], warn: Finding[], list: Finding[] }
 *     (policy: a table, or the name of one in POLICIES; 'ignore' drops it)
 *   explain(finding, policy) → { action, why }
 */
export const ACTIONS = Object.freeze(['refuse', 'warn', 'list', 'ignore'])

const DEFAULT_WHY = 'Helm fails on it (or AlertForge cannot tell what Helm does, or Helm does not render it the same way each time, or the rules it renders cannot be loaded)'
// A code has at least one dot (finding.js), so a row is a whole code or a
// prefix ending in `.*`; `yaml` alone could never match and is refused.
const KEY = /^[a-z0-9-]+(\.[a-z0-9-]+)*(\.[a-z0-9-]+|\.\*)$/

export const defaultAction = f => (f.helm === 'fails' || f.helm === 'unknown' || f.helm === 'renders-differently' || f.deploy === 'fails' ? 'refuse' : 'ignore')

const checkRule = (where, rule) => {
  if (!rule || typeof rule !== 'object') throw new TypeError(`${where}: a rule is { action, why }`)
  if (!ACTIONS.includes(rule.action)) throw new TypeError(`${where}: action is one of ${ACTIONS.join(', ')}, not ${JSON.stringify(rule.action)}`)
  if (typeof rule.why !== 'string' || !rule.why.trim()) throw new TypeError(`${where}: every exception says why`)
  return Object.freeze({ action: rule.action, why: rule.why })
}

export function definePolicy(name, { default: dflt, rows = {} } = {}) {
  if (typeof name !== 'string' || !name) throw new TypeError('a policy has a name')
  const table = Object.create(null)
  for (const key of Object.keys(rows)) {
    if (!KEY.test(key)) throw new TypeError(`${name}: ${JSON.stringify(key)} is not a code or a prefix ending in .*`)
    table[key] = checkRule(`${name} ${key}`, rows[key])
  }
  let base = null
  if (dflt !== undefined) {
    if (!ACTIONS.includes(dflt?.refuse)) throw new TypeError(`${name}: default.refuse is one of ${ACTIONS.join(', ')}`)
    base = checkRule(`${name} default`, { action: dflt.refuse, why: dflt.why })
  }
  return Object.freeze({ name, rows: Object.freeze(table), default: base })
}

/** The tables, one per entry point. */
export const POLICIES = Object.freeze({
  save: definePolicy('save'),
  saveLayer: definePolicy('saveLayer'),
  sync: definePolicy('sync'),
  commit: definePolicy('commit'),
  checkRepo: definePolicy('checkRepo'),
  preview: definePolicy('preview'),
  migration: definePolicy('migration'),
})

function tableOf(policy) {
  if (typeof policy === 'string') {
    if (!Object.hasOwn(POLICIES, policy)) throw new TypeError(`no policy named ${JSON.stringify(policy)}`)
    return POLICIES[policy]
  }
  if (!policy || !policy.rows) throw new TypeError('decide needs a policy made by definePolicy, or its name')
  return policy
}

function rowFor(table, code) {
  if (Object.hasOwn(table.rows, code)) return table.rows[code]
  const parts = code.split('.')
  for (let n = parts.length - 1; n >= 1; n--) {
    const key = `${parts.slice(0, n).join('.')}.*`
    if (Object.hasOwn(table.rows, key)) return table.rows[key]
  }
  return null
}

export function explain(f, policy) {
  const table = tableOf(policy)
  const row = rowFor(table, f.code)
  if (row) return row
  if (defaultAction(f) === 'refuse') return table.default ?? { action: 'refuse', why: DEFAULT_WHY }
  return { action: 'ignore', why: 'Helm renders it as written' }
}

export function decide(findings, policy) {
  const table = tableOf(policy)
  const out = { refuse: [], warn: [], list: [] }
  for (const f of findings) {
    const { action } = explain(f, table)
    if (action !== 'ignore') out[action].push(f)
  }
  return out
}
