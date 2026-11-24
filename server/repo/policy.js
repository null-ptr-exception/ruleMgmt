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
import { TEMPLATE_ROWS } from './findings/templateRows.js'

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

// The deployment values rows (loadDeployment's findings), the same for a
// save of the deployment and of a _common, and for a sync (which copies what
// a save would write, to a target that cannot fix it).
const EDITOR = 'the editor\'s rule: a cell is filled or left out, holds one line a label can take, and selector rows can be told apart'
const SAVE_ROWS = {
  'values.required-empty': { action: 'refuse', why: 'a required cell written \'\' is refused: fill it in, or leave the row out' },
  'values.cell': { action: 'refuse', why: EDITOR },
  'values.selector': { action: 'refuse', why: EDITOR },
  'values.rows-alike': { action: 'warn', why: 'rows the row identity label cannot tell apart are said, not refused' },
  'yaml.duplicate-key': { action: 'refuse', why: 'the text was just written: which of the two was meant cannot be told (Helm keeps the last)' },
  'stack.*': { action: 'warn', why: 'what a _common above (or the Template) gives is fixed there: saving this deployment does not change it' },
  'template.schema-unchecked': { action: 'warn', why: 'a Template schema AlertForge cannot check as Helm does is the Template\'s: the deployment is checked by its columns, and Preview by Helm' },
}
const LISTED = why => ({ action: 'list', why })
const MOVED = { action: 'ignore', why: 'moved as written, and rendered by Helm before and after the move: the same values deploy the same way' }

/** The tables, one per entry point. */
export const POLICIES = Object.freeze({
  save: definePolicy('save', { rows: SAVE_ROWS }),
  saveLayer: definePolicy('saveLayer', { rows: SAVE_ROWS }),
  sync: definePolicy('sync', { rows: SAVE_ROWS }),
  commit: definePolicy('commit', {
    default: { refuse: 'list', why: 'Commit lists what Helm stops on in values; check-repo refuses it' },
    rows: {
      'values.unreadable': { action: 'refuse', why: 'a values file that cannot be read is not committed as if fine: Helm renders something other than the repo holds' },
      'yaml.not-yaml': { action: 'refuse', why: 'a values file that is not YAML stops every render of the deployment, as it did before' },
      'yaml.not-map': { action: 'refuse', why: 'a values file that is not a map stops every render of the deployment' },
      'values.chart-key': { action: 'refuse', why: 'a chart key that is not a map stops every render of the deployment' },
      'stack.chart-key': { action: 'refuse', why: 'a _common whose chart key is not a map stops every render of the deployments below it' },
      'values.rows-alike': LISTED('rows the row identity label cannot tell apart are said'),
      'values.required-empty': LISTED(EDITOR),
      'values.cell': LISTED(EDITOR),
      'values.selector': LISTED(EDITOR),
      'yaml.duplicate-key': LISTED('Helm keeps the last of two keys; said so it can be written once'),
      'values.null-on-stack': { action: 'refuse', why: 'a null on a _common stack deploys differently on the two supported Helm versions (one keeps it, the other removes the key and falls back to the layer above or the default): what deploys would depend on the Helm version' },
      'stack.null-on-stack': { action: 'refuse', why: 'a null in a _common above, or in the Template\'s values.yaml, on a stack deploys differently on the two supported Helm versions (measured: 3.15.4 keeps the key as null, 3.19.0 drops it): what deploys would depend on the Helm version' },
      'stack.duplicate-key': LISTED('a key a _common writes twice deploys the later one, which may not be the one meant: said'),
      ...TEMPLATE_ROWS.commit,
    },
  }),
  checkRepo: definePolicy('checkRepo', {
    rows: {
      ...TEMPLATE_ROWS.checkRepo,
      'values.unreadable': { action: 'refuse', why: 'Helm renders something other than the repo holds' },
      'values.rows-alike': { action: 'warn', why: 'rows the row identity label cannot tell apart are said' },
      'values.required-empty': { action: 'warn', why: EDITOR },
      'values.cell': { action: 'warn', why: EDITOR },
      'values.selector': { action: 'warn', why: EDITOR },
      'yaml.duplicate-key': { action: 'warn', why: 'Helm keeps the last of two keys: it renders, the text should say it once' },
      'stack.duplicate-key': { action: 'warn', why: 'a key a _common writes twice deploys the later one, which may not be the one meant' },
    },
  }),
  preview: definePolicy('preview', {
    rows: {
      'stack.duplicate-key': { action: 'warn', why: 'a key a _common writes twice deploys the later one, which may not be the one meant' },
    },
  }),
  // A new deployment writes no values of its own: what it deploys is the
  // Template's and its _common's. What Helm fails on there is refused, so
  // it is not made where it cannot deploy.
  init: definePolicy('init', {
    rows: {
      'values.required-empty': { action: 'ignore', why: 'a new deployment is made to be filled in: its required cells are said when it is saved' },
      'values.required': { action: 'ignore', why: 'a new deployment is made to be filled in: a required value nothing gives yet is asked for when it is saved, and by Commit' },
      'values.rows-alike': { action: 'ignore', why: 'rows the row identity label cannot tell apart are said when it is saved' },
      'template.schema-unchecked': { action: 'ignore', why: 'a Template schema AlertForge cannot check is the Template\'s: the deployment is checked by its columns' },
    },
  }),
  // Making or removing a _common moves each chart's values as written, and
  // Helm renders every deployment it touches before and after: what Helm
  // makes of the values does not change, so what they already are is not
  // the move's to judge. What it refuses is what it cannot move as Helm
  // reads it.
  commonMove: definePolicy('commonMove', {
    rows: {
      'values.schema': MOVED,
      'values.required': MOVED,
      'values.cell': MOVED,
      'values.derived': MOVED,
      'values.required-empty': MOVED,
      'values.selector': MOVED,
      'values.rows-alike': MOVED,
      'stack.*': { action: 'ignore', why: 'a problem of the stack itself is said by the plan as the chart\'s; one of the values a layer gives is moved as it is' },
      'yaml.read-differently': { action: 'ignore', why: 'the text is moved as written: Helm reads it the same way before and after' },
      'template.schema-unchecked': { action: 'ignore', why: 'a Template schema AlertForge cannot check is the Template\'s; Helm renders the deployments before and after' },
      'yaml.duplicate-key': { action: 'refuse', why: 'which of the two keys to move cannot be told from the text' },
    },
  }),
  migration: definePolicy('migration', { rows: SAVE_ROWS }),
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
