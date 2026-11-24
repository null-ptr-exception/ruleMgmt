// The display pin: what each place that shows a deployment's alert count or
// values shows (the folder tree, the deployment list, the Sync dialogs' list,
// the rule owner page, Preview's summary, a _common's users), on every input
// of the deployment-values pin, next to what real Helm deploys from the same
// files. This module records; the test (display.pin.test.js, through
// tests/pin/lib) compares the record with the checked-in baseline and
// allowlist.
//
// A count shown by the browser is computed there from the route's answer
// (the Preview modal adds a group's alerts); those sums are done here on the
// same answer, without a browser.
//
// Helm's side: `helm template` of the deployment as a release (the flat file
// with -f), with one more template put into the Template for that run only:
// it prints the Template's `.Values` as JSON, which is what the rules are
// rendered from (`010` is 8 there). The alerts counted are the rule objects'.
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { makeWorkspace as valuesWorkspace, SUBJECT } from '../deployment-values/harness.mjs'
import { HELM, run, oneLine } from '../lib/tools.mjs'
import { put } from '../lib/repoState.mjs'
import { alertsOf } from '../lib/deployable.mjs'
import { probesFor } from './cases.mjs'

export { SUBJECT }
// The base repo is the deployment-values pin's: the same files, made the same way.
export const makeWorkspace = valuesWorkspace

// The entry points, in the order a row's cells are listed.
export const ENTRIES = ['tree', 'all-list', 'editor', 'preview', 'common-users']
// Which apply to a target (see ../deployment-values/cases.mjs): the flat
// file is in no folder of the tree and not in the Sync dialogs' list; a
// _common's users list is the stack's.
const APPLIES = {
  A: ['tree', 'all-list', 'editor', 'preview'],
  T: ['tree', 'all-list', 'editor', 'preview'],
  S: ['tree', 'all-list', 'editor', 'preview', 'common-users'],
  L: ['tree', 'all-list', 'editor', 'preview', 'common-users'],
  F: ['editor', 'preview'],
}
const LAYER = 'deployments/s/_common/demo'
const PROBE_FILE = 'charts/demo/templates/zz-pin-values.yaml'
const PROBE = '# PIN-VALUES {{ .Values | toJson }}\n'

const q = f => `?folder=${encodeURIComponent(f)}`
const at = (v, p) => p.split('.').reduce((o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), v)
// `path=json` for each probe that holds something: text and type in one.
const probeText = (get, probes) => probes.map(p => [p, get(p)]).filter(([, x]) => x !== undefined).map(([p, x]) => `${p}=${JSON.stringify(x)}`).join('; ') || '-'

// What Helm makes of the files on disk: exit, alerts, the first cpu row's
// CpuHigh count (one per row) and its CpuRate range (the derived w), and the
// Template's .Values at the probes.
async function helmSide(ws, sub, probes) {
  const { root, home } = ws
  const env = { ...process.env, HELM_CACHE_HOME: path.join(home, 'c'), HELM_CONFIG_HOME: path.join(home, 'g'), HELM_DATA_HOME: path.join(home, 'd') }
  await fs.writeFile(path.join(root, PROBE_FILE), PROBE)
  try {
    let args
    if (sub.dep) {
      const dir = path.join(root, sub.dep)
      const du = await run(HELM(), ['dependency', 'update', '--skip-refresh', dir], { env })
      if (du.status !== 0) return { helmExit: String(du.status), helmAlerts: '-', helmRows: '-', helmValues: '-', w: '-', names: '-' }
      args = ['template', `demo-${sub.name}`, dir]
    } else {
      args = ['template', 'demo-f', path.join(root, 'charts/demo'), '-f', path.join(root, sub.file)]
    }
    const t = await run(HELM(), args, { env })
    if (t.status !== 0) return { helmExit: String(t.status), helmAlerts: '-', helmRows: '-', helmValues: '-', w: '-', names: '-' }
    const { alerts } = alertsOf(t.stdout)
    const m = /^# PIN-VALUES (.*)$/m.exec(t.stdout)
    let values = null
    try { values = m ? JSON.parse(m[1]) : null } catch { values = null }
    const w = (/CpuRate:rate\(cpu_total\{[^}]*\}\[([^\]]*)\]\)/.exec(alerts.find(a => a.startsWith('CpuRate:')) || '') || [])[1]
    return {
      helmExit: '0',
      helmAlerts: String(alerts.length),
      helmRows: String(alerts.filter(a => a.startsWith('CpuHigh:')).length),
      helmValues: values ? probeText(p => at(values, p), probes) : 'no-probe',
      names: [...new Set(alerts.map(a => a.split(':')[0]))].sort().join(',') || '-',
      w: w ?? '-',
    }
  } finally {
    await fs.rm(path.join(root, PROBE_FILE), { force: true })
  }
}

// A count shown: the number, or '-' when the entry shows none.
const shown = n => (typeof n === 'number' ? String(n) : '-')
// The editor's table: no group (or null) is an empty table, not none.
const rowsOf = v => (Array.isArray(v) ? String(v.length) : v === undefined || v === null ? '0' : '-')

// One row: every display entry point that applies, each on the row's repo state.
export async function runRow(ws, c) {
  const { root, api, git, baseSha, outside, work } = ws
  const sub = SUBJECT[c.target]
  const probes = probesFor(c.target)
  const touched = [sub.file, ...Object.keys(c.files || {}), PROBE_FILE]
  const reset = async () => {
    for (const rel of touched) { await fs.chmod(path.join(root, rel), 0o755).catch(() => {}); await fs.rm(path.join(root, rel), { recursive: true, force: true }) }
    await fs.chmod(path.join(root, 'charts/demo/rules'), 0o755).catch(() => {})
    git('reset', '-q', '--hard', baseSha); git('clean', '-fdq')
  }
  await reset()
  for (const [rel, spec] of Object.entries(c.files || {})) await put(root, rel, spec, outside)
  await put(root, sub.file, c.text, outside)
  const h = await helmSide(ws, sub, probes)

  const dep = sub.dep || null
  const leaks = s => (s.includes(work) || s.includes(os.tmpdir() + path.sep) ? 'yes' : 'no')
  const cells = []
  const record = async (entry, fn) => {
    if (!APPLIES[c.target].includes(entry)) return
    let r
    try { r = await fn() } catch (err) { r = { cls: 'error', status: 'throw', note: err.message, raw: '' } }
    cells.push({
      id: c.id, target: c.target, entry, cls: r.cls, status: String(r.status), leak: leaks(r.raw || ''),
      mark: r.mark || '-', rows: r.rows ?? '-', alertsShown: r.alertsShown ?? '-', values: r.values || '-',
      helmExit: h.helmExit, helmAlerts: h.helmAlerts, helmRows: h.helmRows,
      helmValues: entry === 'editor' ? h.helmValues : entry === 'preview' ? `w=${h.w}; names=${h.names}` : '-',
      note: oneLine(r.note).slice(0, 400),
    })
  }
  const cls = res => (res.status >= 500 ? 'error' : res.status === 404 ? 'absent' : res.status >= 400 ? 'refused' : 'ok')
  // Nothing on disk changes in these: the reads run one after another on
  // the same state (Preview's `helm dependency update` writes only what the
  // repo ignores).

  // The folder tree: the deployment's node and its alertCount.
  await record('tree', async () => {
    const parent = path.posix.dirname(dep)
    const res = await api('GET', `/api/v2/folders/tree?path=${encodeURIComponent(parent)}`)
    const node = Array.isArray(res.data) ? res.data.find(n => n.path === dep) : null
    const marks = node ? ['problems', 'unreadable', 'noValues', 'nestedIn'].filter(k => node[k]) : []
    return {
      cls: res.status >= 400 ? cls(res) : !node ? 'absent' : node.isDeployment ? 'ok' : 'not-deployment',
      status: res.status, rows: node ? shown(node.alertCount) : '-', mark: marks.join(',') || '-',
      note: node?.problems?.join(' / ') || res.data?.error, raw: res.text,
    }
  })
  // Every deployment in the repo: the Sync to / Sync from dialogs' list,
  // whose count is said when a sync moves a deployment to another Template.
  await record('all-list', async () => {
    const res = await api('GET', '/api/v2/folders/deployments?chart=demo')
    const mine = Array.isArray(res.data) ? res.data.find(d => d.path === dep) : null
    return { cls: res.status >= 400 ? cls(res) : mine ? 'ok' : 'absent', status: res.status, rows: mine ? shown(mine.alertCount) : '-', mark: mine && mine.alertCount === null ? 'null' : '-', note: res.data?.error, raw: res.text }
  })
  // The rule owner page: the rows of the cpu table and the probe cells, its
  // own values first, else what it shows inherited from a _common.
  await record('editor', async () => {
    const p = sub.layer ? `/api/v2/deployments/demo/demo${q(sub.layer)}` : dep ? `/api/v2/deployments/demo/${sub.name}${q(dep)}` : '/api/v2/deployments/demo/f'
    const res = await api('GET', p)
    const d = res.data || {}
    const ok = res.status === 200
    const own = d.parsed && typeof d.parsed === 'object' ? d.parsed : {}
    const inherited = d.inherited?.values || {}
    const pick = x => (at(own, x) !== undefined ? at(own, x) : at(inherited, x))
    const marks = [...new Set((d.findings || []).map(f => f.code))]
    if (d.stackProblems?.length) marks.push('stackProblems')
    return {
      cls: res.status === 409 && d.unreadable ? 'unreadable' : cls(res), status: res.status,
      rows: sub.layer ? 'n/a' : ok ? rowsOf(pick('cpu')) : '-',
      values: ok ? probeText(pick, probes) : '-',
      mark: marks.join(',') || '-', note: d.error || d.stackProblems?.join(' / '), raw: res.text,
    }
  })
  // Preview: "N alerts total", the cpu group's rows and alerts (summed as the
  // modal sums them), its derived w for row 1, and the alerts it lists as
  // producing nothing.
  await record('preview', async () => {
    const res = await api('POST', dep ? `/api/v2/render/demo/${sub.name}${q(dep)}` : '/api/v2/render/demo/f')
    const d = res.data || {}
    const marks = []
    if (!d.ok) marks.push('error')
    if (d.ok && d.check && !d.check.passed) marks.push('check-failed')
    if (d.ok && d.selfCheck && !d.selfCheck.passed) marks.push('self-check')
    if (d.valueWarnings?.length) marks.push('warnings')
    if (d.ok && !d.summary) marks.push('no-summary')
    const s = d.ok ? d.summary : null
    const cpu = s?.groups?.find(g => g.valuesKey === 'cpu')
    const others = (s?.groups || []).filter(g => g.valuesKey !== 'cpu' && g.state !== 'ok').map(g => `${g.valuesKey}:${g.state}`)
    const w = cpu?.derived?.rows?.[0]?.values?.w
    const missing = (cpu?.missing || []).map(m => `${m.alert}/${m.severity}`)
    const values = s ? [
      `w=${w ? (w.value !== undefined ? `${w.value}${w.unit || ''}` : w.omitted ? 'omitted' : `problem`) : '-'}`,
      ...(missing.length ? [`missing=${missing.join(',')}`] : []),
      ...(others.length ? [`groups=${others.join(',')}`] : []),
      ...(s.orphanFields?.length ? [`orphans=${s.orphanFields.join(',')}`] : []),
    ].join('; ') : '-'
    return {
      cls: res.status >= 500 ? 'error' : res.status >= 400 ? 'refused' : !d.ok ? 'failed' : 'ok', status: res.status,
      rows: !s ? '-' : cpu && cpu.state !== 'custom' ? String(cpu.rowCount) : 'n/a',
      alertsShown: s ? String(s.total) : '-',
      values, mark: marks.join(',') || '-',
      note: d.ok ? `check ${d.check?.passed ? 'passed' : 'failed'}` : String(d.error || '').split('\n').filter(Boolean).pop(), raw: res.text,
    }
  })
  // A _common's page: who inherits from it, with each group's rows.
  await record('common-users', async () => {
    const res = await api('GET', `/api/v2/folders/common/users?path=${encodeURIComponent(LAYER)}`)
    const mine = Array.isArray(res.data) ? res.data.find(u => u.path === dep) : null
    const g = mine?.groups?.cpu
    return { cls: res.status >= 400 ? cls(res) : mine ? 'ok' : 'absent', status: res.status, rows: g ? shown(g.rows) : '-', values: g ? `cpu from ${g.from === LAYER ? 'here' : g.from}` : '-', note: res.data?.error, raw: res.text }
  })
  // Each count against the others the same input shows.
  const counted = cells.filter(x => x.cls !== 'absent' && x.rows !== 'n/a')
  const vector = counted.map(x => `${x.entry}=${x.rows}`).join(' ')
  const split = new Set(counted.map(x => x.rows)).size > 1
  for (const x of cells) x.vsEntries = split && counted.includes(x) ? vector : ''
  await reset()
  return cells
}
