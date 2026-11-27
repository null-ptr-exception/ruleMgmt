// Two deployments, each one cell picking the shared config relay, with the
// tables' own matchers (#225). `amtool`: whether some alert reaches relay
// through both (amtool 0.28.1 config routes test, the two resources as the
// operator puts them under one Alertmanager with strategy None; checked by
// tests/integration/shared-overlap-matchers.test.js on the alerts `tried`).
// `said`: whether the Shared configs page says the cells overlap. It runs no
// regex: `=`, `!=` and a regex that is plain text or alternatives of it
// (`a|b`) are decided, the same as amtool; any other regex counts as
// overlapping, a warning where amtool sends the alert once at most.
const m = (name, matchType, value) => ({ name, matchType, value })
const SEV = { severity: ['critical'] }

export const SCENARIOS = [
  { what: 'no matchers, the same cell', a: {}, b: {}, amtool: true, said: true },
  { what: '= and plain alternatives that do not take it', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', 'eu|us')] }, amtool: false, said: false },
  { what: '= and plain alternatives that take it', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', 'asia|apac')] }, amtool: true, said: true },
  { what: '= and a regex that does not take it: not run, counted', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', 'eu|eu-.*')] }, amtool: false, said: true },
  { what: '= and != of the same value', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '!=', 'asia')] }, amtool: false, said: false },
  { what: '= on one side only', a: { matchers: [m('region', '=', 'asia')] }, b: {}, amtool: true, said: true },
  { what: '= and a regex that takes it, case-insensitive', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', '(?i)ASIA')] }, amtool: true, said: true },
  { what: '= "" (no region) and = eu', a: { matchers: [m('region', '=', '')] }, b: { matchers: [m('region', '=', 'eu')] }, amtool: false, said: false },
  { what: '= "" (no region) and != eu', a: { matchers: [m('region', '=', '')] }, b: { matchers: [m('region', '!=', 'eu')] }, amtool: true, said: true },
  { what: 'a cell\'s value and the other\'s plain alternatives', a: { labels: { ...SEV, region: ['asia'] }, cell: { severity: 'critical', region: 'asia' } }, b: { matchers: [m('region', '=~', 'eu|us')] }, amtool: false, said: false },
  { what: 'a cell\'s value and the other\'s regex: not run, counted', a: { labels: { ...SEV, region: ['asia'] }, cell: { severity: 'critical', region: 'asia' } }, b: { matchers: [m('region', '=~', 'eu.*')] }, amtool: false, said: true },
  { what: 'a cell\'s value and the other\'s !~ that takes it', a: { labels: { ...SEV, region: ['asia'] }, cell: { severity: 'critical', region: 'asia' } }, b: { matchers: [m('region', '!~', 'eu.*')] }, amtool: true, said: true },
  { what: '!= and = of the same value', a: { matchers: [m('env', '!=', 'dev')] }, b: { matchers: [m('env', '=', 'dev')] }, amtool: false, said: false },
  { what: 'plain alternatives and their negation', a: { matchers: [m('region', '=~', 'asia|apac')] }, b: { matchers: [m('region', '!~', 'asia|apac')] }, amtool: false, said: false },
  { what: 'a regex and its negation: not run, counted', a: { matchers: [m('region', '=~', 'asia.*')] }, b: { matchers: [m('region', '!~', 'asia.*')] }, amtool: false, said: true },
  { what: '!= and != : another value takes both', a: { matchers: [m('region', '!=', 'asia')] }, b: { matchers: [m('region', '!=', 'eu')] }, amtool: true, said: true },
  { what: 'two namespace alternatives apart', a: { matchers: [m('namespace', '=~', 'a|b')] }, b: { matchers: [m('namespace', '=~', 'c|d')] }, amtool: false, said: false },
  { what: 'a case-insensitive regex: not run, counted', a: { matchers: [m('region', '=', 'asia')] }, b: { matchers: [m('region', '=~', '(?i)é')] }, amtool: false, said: true },
  // A value outside the BMP against a regex that matches the empty value:
  // once answered wrong by running the regex in JavaScript.
  { what: 'a value outside the BMP and !~ of a regex', a: { labels: { ...SEV, team: ['db😀'] }, cell: { severity: 'critical', team: 'db😀' } }, b: { matchers: [m('team', '!~', 'x?')] }, amtool: true, said: true },
  { what: 'plain alternatives of non-ASCII text and = of another', a: { matchers: [m('region', '=~', '東京|大阪')] }, b: { matchers: [m('region', '=', '福岡')] }, amtool: false, said: false },
  { what: 'plain alternatives of non-ASCII text and = of one of them', a: { matchers: [m('region', '=~', '東京|大阪')] }, b: { matchers: [m('region', '=', '大阪')] }, amtool: true, said: true },
  { what: 'a regex of non-ASCII text: not run, counted', a: { matchers: [m('region', '=~', '東京.*')] }, b: { matchers: [m('region', '=', '福岡')] }, amtool: false, said: true },
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
