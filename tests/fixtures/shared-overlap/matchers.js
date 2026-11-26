// Two deployments, each one cell picking the shared config relay, with the
// tables' own matchers (#225). `amtool`: whether some alert reaches relay
// through both (amtool 0.28.1 config routes test, the two resources as the
// operator puts them under one Alertmanager with strategy None; checked by
// tests/integration/shared-overlap-matchers.test.js on the alerts `tried`).
// `said`: whether the Shared configs page says the cells overlap — the same
// as amtool where the matchers decide it, else true (counted as
// overlapping: two regexes, or a regex this cannot read safely).
const m = (name, matchType, value) => ({ name, matchType, value })
const SEV = { severity: ['critical'] }

export const SCENARIOS = [
  { what: 'no matchers, the same cell', a: {}, b: {}, amtool: true, said: true },
  { what: '= and a regex that does not take it', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', 'eu|eu-.*')] }, amtool: false, said: false },
  { what: '= and != of the same value', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '!=', 'asia')] }, amtool: false, said: false },
  { what: '= on one side only', a: { matchers: [m('region', '=', 'asia')] }, b: {}, amtool: true, said: true },
  { what: '= and a regex that takes it, case-insensitive', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', '(?i)ASIA')] }, amtool: true, said: true },
  { what: '= "" (no region) and = eu', a: { matchers: [m('region', '=', '')] }, b: { matchers: [m('region', '=', 'eu')] }, amtool: false, said: false },
  { what: '= "" (no region) and != eu', a: { matchers: [m('region', '=', '')] }, b: { matchers: [m('region', '!=', 'eu')] }, amtool: true, said: true },
  { what: 'a cell\'s value and the other\'s regex', a: { labels: { ...SEV, region: ['asia'] }, cell: { severity: 'critical', region: 'asia' } }, b: { matchers: [m('region', '=~', 'eu.*')] }, amtool: false, said: false },
  { what: 'a cell\'s value and the other\'s !~ that takes it', a: { labels: { ...SEV, region: ['asia'] }, cell: { severity: 'critical', region: 'asia' } }, b: { matchers: [m('region', '!~', 'eu.*')] }, amtool: true, said: true },
  { what: '!= and = of the same value', a: { matchers: [m('env', '!=', 'dev')] }, b: { matchers: [m('env', '=', 'dev')] }, amtool: false, said: false },
  { what: 'a regex and its negation: not decided, counted', a: { matchers: [m('region', '=~', 'asia|apac')] }, b: { matchers: [m('region', '!~', 'asia|apac')] }, amtool: false, said: true },
  { what: 'two namespace regexes apart: not decided, counted', a: { matchers: [m('namespace', '=~', 'a|b')] }, b: { matchers: [m('namespace', '=~', 'c|d')] }, amtool: false, said: true },
  { what: 'a case-insensitive é: not read, counted', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', '(?i)é')] }, amtool: false, said: true },
  { what: 'a matcher and the other\'s table label', a: { matchers: [m('team', '=', 'db')] }, b: { labels: { ...SEV, team: ['web'] }, cell: { severity: 'critical', team: 'web' } }, amtool: false, said: false },
]

/** A scenario's side as a routing.yaml. */
export function sideRouting(side) {
  const labels = side.labels || SEV
  return {
    ...(side.matchers ? { matchers: side.matchers } : {}),
    labels,
    configs: { relay: { shared: true } },
    cells: [{ match: side.cell || { severity: 'critical' }, configs: ['relay'] }],
  }
}

export const SHARED = { configs: { relay: { type: 'webhook', url: 'http://relay.example.com:8080/' } }, errors: [] }
