// Helm's side of a cell when the rendered objects are of more than one
// output profile: each rule object is checked by the checker its kind says,
// read from the object itself, not from AlertForge's profile table:
//   PrometheusRule                                     promtool
//   PrometheusRule annotated alertforge.io/profile: prometheus3   promtool3
//   VMRule (MetricsQL or LogsQL groups)                vmalert -dryRun
// deployable.mjs judges with promtool alone (every object of the
// deployment-values pin is a Prometheus 2 one); this is for slices whose
// inputs render every profile.
//
//   judgeObjects(helmResult, { have, tmp, promise }) →
//     { helm, helmExit, alerts, rendered, deploy, others }
//   helm: 'fails' | 'deploy-fails' | 'renders-empty' | 'renders-fewer' |
//         'renders-twice' | 'renders'
//     deploy-fails   a checker refuses an object
//     renders-fewer  fewer of an alert than `promise` asks for
//     renders-twice  one rule (alert, expr, labels) in two places: it fires twice
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import yaml from 'js-yaml'
import { CHECKERS, run } from './tools.mjs'

const NOTHING = { alerts: '-', rendered: '-', deploy: '-', others: '-' }

/** The checker an object's own kind and annotation say. */
export function checkerOf(doc) {
  if (doc?.kind === 'VMRule') return 'vmalert'
  if (doc?.kind === 'PrometheusRule') return doc?.metadata?.annotations?.['alertforge.io/profile'] === 'prometheus3' ? 'promtool3' : 'promtool'
  return null
}

/** The rule objects of a rendered stream, or null when it is not YAML. */
export function ruleObjects(rendered) {
  try {
    return yaml.loadAll(rendered).filter(d => checkerOf(d) && Array.isArray(d?.spec?.groups))
  } catch {
    return null
  }
}

async function check(name, groups, tmp) {
  const file = path.join(tmp, `check-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`)
  await fs.writeFile(file, yaml.dump({ groups }, { lineWidth: -1 }))
  const r = await run(CHECKERS[name](), name === 'vmalert' ? ['-dryRun', `-rule=${file}`] : ['check', 'rules', file])
  await fs.rm(file, { force: true })
  return r.status === 0
}

export async function judgeObjects(t, { have, tmp, promise = {} }) {
  if (t.status !== 0) return { helm: 'fails', helmExit: t.status, ...NOTHING }
  const docs = ruleObjects(t.stdout)
  if (docs === null) return { helm: 'deploy-fails', helmExit: 0, ...NOTHING, deploy: 'unparsable' }
  const verdict = {}
  const rules = []
  for (const d of docs) {
    const name = checkerOf(d)
    for (const g of d.spec.groups) for (const r of g.rules || []) if (r?.alert) rules.push(r)
    if (!have[name]) { verdict[name] = 'missing'; continue }
    const ok = await check(name, d.spec.groups, tmp)
    verdict[name] = verdict[name] === 'fails' || !ok ? 'fails' : 'ok'
  }
  const count = new Map()
  for (const r of rules) count.set(r.alert, (count.get(r.alert) || 0) + 1)
  const same = new Map()
  for (const r of rules) {
    const k = JSON.stringify([r.alert, String(r.expr), r.labels || {}])
    same.set(k, (same.get(k) || 0) + 1)
  }
  const twice = [...same.values()].some(n => n > 1)
  const fewer = Object.entries(promise).some(([name, n]) => (count.get(name) || 0) < n)
  const fails = Object.values(verdict).includes('fails')
  const helm = fails ? 'deploy-fails' : rules.length === 0 ? 'renders-empty' : fewer ? 'renders-fewer' : twice ? 'renders-twice' : 'renders'
  // What renders, short enough to read: each alert's name and count, and a
  // hash of every rule's alert, expr and labels, which changes with any of them.
  const names = [...count.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => (c > 1 ? `${n}x${c}` : n))
  const hash = createHash('sha1').update(JSON.stringify(rules.map(r => [r.alert, String(r.expr), r.labels || {}]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex').slice(0, 8)
  return {
    helm,
    helmExit: 0,
    alerts: String(rules.length),
    rendered: rules.length ? `${names.join(' ')} #${hash}` : '-',
    deploy: Object.entries(verdict).sort().map(([k, v]) => `${k}=${v}`).join(' ') || 'none',
    others: '-',
  }
}

/** Helm's answers that say no by this standard. */
export const SAYS_NO = new Set(['fails', 'deploy-fails', 'renders-empty', 'renders-fewer', 'renders-twice'])
