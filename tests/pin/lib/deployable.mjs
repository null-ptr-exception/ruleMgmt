// Helm's side of a cell, by the "deployable" standard: Helm renders, the
// output profile's checker (promtool, for Prometheus 2) accepts the rules it
// renders, and it is not 0 alerts. promtool3 and vmalert are recorded
// beside it, not judged.
//
// It is also not deployable when fewer alerts render than what was written
// promises: N rows of a group whose rule is CpuHigh, and fewer than N
// CpuHigh render (values Helm never passes to the Template, #203).
//
//   judge(helmResult, { have, tmp, promise }) → { helm, helmExit, alerts, rendered, deploy, others }
//     promise: { alertName: at least this many } (optional)
//     helm: 'fails' | 'deploy-fails' | 'renders-empty' | 'renders-fewer' | 'renders'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { CHECKERS, run } from './tools.mjs'

const NOTHING = { alerts: '-', rendered: '-', deploy: '-', others: '-' }

/** What each alert of a rendered stream reads, in order, and the severities. */
export function alertsOf(rendered) {
  const alerts = []
  const re = /- alert: (\w+)\s+expr: \|-\s+([^\n]+)/g
  let m
  while ((m = re.exec(rendered))) alerts.push(`${m[1]}:${m[2].trim()}`)
  const severities = [...rendered.matchAll(/severity: "([^"]*)"/g)].map(x => x[1])
  return { alerts, severities }
}

/** The rendered rule objects, each checked by every checker there is. */
export async function checkRendered(rendered, tmp, have) {
  let docs
  try { docs = yaml.loadAll(rendered).filter(d => Array.isArray(d?.spec?.groups)) } catch { return { promtool: 'unparsable', others: '-' } }
  if (!docs.length) return { promtool: 'empty', others: '-' }
  const verdict = {}
  for (const name of Object.keys(CHECKERS)) {
    if (!have[name]) { verdict[name] = 'missing'; continue }
    let failed = false
    for (const [i, d] of docs.entries()) {
      const file = path.join(tmp, `check-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${i}.yaml`)
      await fs.writeFile(file, yaml.dump({ groups: d.spec.groups }, { lineWidth: -1 }))
      const r = await run(CHECKERS[name](), name === 'vmalert' ? ['-dryRun', `-rule=${file}`] : ['check', 'rules', file])
      await fs.rm(file, { force: true })
      if (r.status !== 0) failed = true
    }
    verdict[name] = failed ? 'fails' : 'ok'
  }
  return { promtool: verdict.promtool, others: `promtool3=${verdict.promtool3} vmalert=${verdict.vmalert}` }
}

/** A failed Helm step (dependency update, template …), as the cell records it. */
export const helmFailed = status => ({ helm: 'fails', helmExit: status, ...NOTHING })

/** Helm's answer for one `helm template` result ({ status, stdout }). */
export async function judge(t, { have, tmp, promise = {} }) {
  if (t.status !== 0) return helmFailed(t.status)
  const { alerts, severities } = alertsOf(t.stdout)
  const { promtool, others } = await checkRendered(t.stdout, tmp, have)
  const count = name => alerts.filter(a => a.startsWith(`${name}:`)).length
  const fewer = Object.entries(promise).some(([name, n]) => count(name) < n)
  const helm = promtool === 'fails' || promtool === 'unparsable' ? 'deploy-fails' : alerts.length === 0 ? 'renders-empty' : fewer ? 'renders-fewer' : 'renders'
  return { helm, helmExit: 0, alerts: String(alerts.length), rendered: [...alerts, ...severities.map(s => `sev=${s}`)].join(' | '), deploy: promtool, others }
}

/** Helm's answers that say no by the deployable standard. */
export const HELM_SAYS_NO = new Set(['fails', 'deploy-fails', 'renders-empty', 'renders-fewer'])
