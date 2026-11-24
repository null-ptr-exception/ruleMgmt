// The command line tools that write a Template's files (gen-rules,
// gen-chart, import-rules) write each file whole: killed in the middle of
// writing one (tests/helpers/stopAtWrite.mjs: half of it written, then
// SIGKILL), every file of the Template is as it was before the run or as
// the run makes it, never cut off; what is left is at most the writer's
// own temp file, which Commit never adds. A file the run cannot write
// leaves the others as they were and is one ERROR line naming it (exit 2).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const STOP = path.resolve('tests/helpers/stopAtWrite.mjs')
const RULE = limit => `group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${job}"} > ${limit}\n    labels: {severity: critical}\n  - alert: CpuLow\n    expr: cpu{job="\${job}"} < ${limit}\n    labels: {severity: warning}\n`
const MEM = limit => `group: mem\ncolumns:\n  job: {type: string, required: true}\n  floor: {type: number, default: 1}\nrules:\n  - alert: MemHigh\n    expr: mem{job="\${job}"} > ${limit}\n    labels: {severity: critical}\n`
const IMPORT = 'groups:\n  - name: disk\n    rules:\n      - alert: DiskFull\n        expr: disk > 90\n        labels: {severity: warning}\n'

let work, repo, chart
const run = (script, args, env = {}) => spawnSync('node', [...(env.STOP_WRITE ? ['--import', STOP] : []), path.resolve('scripts', script), ...args], { encoding: 'utf-8', env: { ...process.env, ...env } })
const files = dir => {
  const out = {}
  const walk = r => {
    for (const e of fs.readdirSync(path.join(dir, r), { withFileTypes: true })) {
      const p = r ? `${r}/${e.name}` : e.name
      if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(path.join(dir, p), 'utf-8')
    }
  }
  walk('')
  return out
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-whole-'))
  repo = path.join(work, 'repo')
  chart = path.join(repo, 'charts/demo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(chart, 'rules'), { recursive: true })
  fs.writeFileSync(path.join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
  fs.writeFileSync(path.join(chart, 'values.yaml'), '{}\n')
  fs.writeFileSync(path.join(chart, 'rules/cpu.yaml'), RULE(1))
  fs.writeFileSync(path.join(chart, 'rules/mem.yaml'), MEM(1))
  fs.writeFileSync(path.join(work, 'import.yaml'), IMPORT)
  const first = run('gen-rules.mjs', [chart])
  if (first.status !== 0) throw new Error(`setup: ${first.stdout}${first.stderr}`)
})
afterEach(() => {
  spawnSync('chmod', ['-R', 'u+rwX', work])
  fs.rmSync(work, { recursive: true, force: true })
})

// The Template as a run leaves it, uninterrupted, from the same start: on
// a copy beside it.
function whatARunMakes(script, args) {
  const copy = path.join(work, 'copy')
  fs.cpSync(repo, copy, { recursive: true })
  const r = run(script, args.map(a => a.replace(repo, copy)))
  expect(r.status, r.stdout + r.stderr).toBe(0)
  const out = files(path.join(copy, 'charts/demo'))
  fs.rmSync(copy, { recursive: true, force: true })
  return out
}

const TOOLS = [
  ['gen-rules', 'gen-rules.mjs', () => [chart], () => { fs.writeFileSync(path.join(chart, 'rules/cpu.yaml'), RULE(5)); fs.writeFileSync(path.join(chart, 'rules/mem.yaml'), MEM(5)) }, 'cpu.yaml'],
  ['gen-chart', 'gen-chart.mjs', () => [chart], () => { fs.appendFileSync(path.join(chart, 'templates/cpu.yaml'), '# by hand\n'); fs.appendFileSync(path.join(chart, 'templates/mem.yaml'), '# by hand\n') }, 'mem.yaml'],
  ['import-rules', 'import-rules.mjs', () => [path.join(work, 'import.yaml'), chart], () => {}, 'disk.yaml'],
]

describe('a run killed in the middle of writing a file', () => {
  it.each(TOOLS)('%s: every file of the Template whole, as before or as the run makes it', (_, script, args, change, name) => {
    change()
    const before = files(chart)
    const after = whatARunMakes(script, args())
    const r = run(script, args(), { STOP_WRITE: name, STOP_WRITE_AT: '1' })
    expect(r.signal).toBe('SIGKILL')
    const now = files(chart)
    for (const [f, text] of Object.entries(now)) {
      if (/^(.*\/)?_[^/]+\.[0-9a-f]{8}\.tmp$/.test(f)) continue
      expect([before[f], after[f]], `${f} is cut off`).toContain(text)
    }
  })
})

describe.skipIf(IS_ROOT)('a file the run cannot write', () => {
  it.each(TOOLS)('%s: one ERROR line naming it in the repo, exit 2, the other files as they were', (_, script, args, change) => {
    change()
    fs.chmodSync(path.join(chart, 'templates'), 0o555)
    const before = files(chart)
    const r = run(script, args())
    fs.chmodSync(path.join(chart, 'templates'), 0o755)
    expect(r.status).toBe(2)
    expect(r.stdout).toMatch(/^ERROR {2}charts\/demo\/templates\/[\w-]+\.yaml cannot be written: permission denied$/m)
    expect(r.stdout + r.stderr).not.toContain(work)
    expect(files(chart)).toEqual(before)
  })
})
