// scripts/check-repo.mjs checks a whole gitops repo as Commit does, then
// renders every deployment with Helm and runs the rule checker on it: run
// here as CI runs it, on small repos made from sample/, with the real helm
// and promtool. Each case says which wrong implementation it would catch.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const SCRIPT = path.resolve('scripts/check-repo.mjs')
const SAMPLE = path.resolve('sample')
const has = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true } catch { return false } }
const CAN_RUN = has(process.env.HELM_BIN || 'helm', ['version']) && has('promtool', ['--version'])
if (!CAN_RUN) console.warn('check-repo: helm or promtool not found — the cases are skipped')
const asRoot = process.getuid?.() === 0

const P1 = 'deployments/mariadb-1/production'
const S1 = 'deployments/mariadb-1/staging'
const P2 = 'deployments/mariadb-2/production'
const T = 'charts/mariadb-alerts'
const BROKEN = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: broken\nspec:\n  groups:\n    - name: broken\n      rules:\n        - alert: Broken\n          expr: "up{"\n'

let work, repo
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-repo-test-'))
  repo = path.join(work, 'gitops')
  fs.cpSync(SAMPLE, repo, { recursive: true })
  fs.rmSync(path.join(repo, 'promtool-tests'), { recursive: true, force: true })
})
afterEach(() => {
  execFileSync('chmod', ['-R', 'u+rwX', work])
  fs.rmSync(work, { recursive: true, force: true })
})

const gitInit = dir => {
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' })
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test')
  git('add', '-A'); git('commit', '-qm', 'base')
  return git
}
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
const edit = (rel, from, to) => write(rel, fs.readFileSync(path.join(repo, rel), 'utf-8').replace(from, to))

// The site's labels are not this test's: none set, as for a plain CI job.
const env = (more = {}) => {
  const e = { ...process.env, ...more }
  for (const k of Object.keys(e)) if (k.startsWith('RULE_OBJECT_')) delete e[k]
  return e
}
const run = (args, { cwd = work, extraEnv } = {}) => {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf-8', env: env(extraEnv), timeout: 120000 })
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}
const json = (args = [], opts) => {
  const r = run([repo, '--json', ...args], opts)
  return { ...r, data: JSON.parse(r.out) }
}
const codes = data => data.problems.map(p => `${p.action}${p.notChecked ? '/not-checked' : ''} ${p.code} ${p.file}`)

describe.skipIf(!CAN_RUN)('check-repo', () => {
  // Catches: a gate that fails a clean repo, or prints more than the counts.
  it('a clean repo: exit 0, one line with the counts', () => {
    gitInit(repo)
    const r = run([repo])
    expect(r.err).toBe('')
    expect(r.out).toBe('check-repo: 1 Template, 3 deployments: 0 refused, 0 not checked, 0 warnings\n')
    expect(r.status).toBe(0)
  })

  // Catches: collecting with Commit's table (which only lists a value Helm
  // stops on), or not rendering (Helm's own refusal is named too).
  it('a value Helm stops on (Commit only lists it): exit 1, naming the values file', () => {
    edit(`${P2}/values.yaml`, 'warn_threshold: 0.3', 'warn_threshold: abc')
    const { status, data } = json()
    expect(status).toBe(1)
    expect(codes(data)).toEqual([
      `refuse values.schema ${P2}/values.yaml`,
      `refuse deployment.render ${P2}`,
    ])
    const r = run([repo])
    expect(r.out).toContain(`${P2}\n  refused      ${P2}/values.yaml: mariadb_latency_slow_queries row 1, "warn_threshold": "abc" is not a number\n`)
    expect(r.out.trim().split('\n').pop()).toBe('check-repo: 1 Template, 3 deployments: 2 refused, 0 not checked, 0 warnings')
  })

  // Catches: leaving the Templates out (only deployments walked).
  it('a Template whose generated file is gone: exit 1, naming the Template', () => {
    fs.rmSync(path.join(repo, `${T}/templates/mariadb-traffic-qps-low.yaml`))
    const { status, data } = json()
    expect(status).toBe(1)
    expect(codes(data)).toEqual([`refuse template.drift-missing ${T}`])
    expect(data.problems[0].group).toBe(T)
  })

  // Catches: the routing check with Commit's table (a routing.yaml's own
  // problems are only listed there).
  it('a routing.yaml with problems (Commit only lists it): exit 1, naming it', () => {
    write(`${P1}/routing.yaml`, 'labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ops@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [nobody]\n')
    const { status, data } = json()
    expect(status).toBe(1)
    expect(codes(data)).toContain(`refuse routing.problem ${P1}/routing.yaml`)
    expect(data.problems.every(p => p.group === P1)).toBe(true)
  })

  // Catches: leaving the shared configs out when no deployment uses them.
  it('a shared configs file with problems that no deployment uses (Commit only lists it): exit 1', () => {
    write('_shared/notification-configs.yaml', 'configs:\n  relay: { type: nosuch }\n')
    const { status, data } = json()
    expect(status).toBe(1)
    expect(codes(data)).toEqual(['refuse shared.problem _shared/notification-configs.yaml'])
  })

  // Catches: leaving sync.yaml out.
  it('a sync.yaml target that is no deployment: exit 1, naming sync.yaml', () => {
    write('sync.yaml', `syncs:\n  - source: ${P1}\n    targets: [deployments/nowhere/x]\n`)
    const { status, data } = json()
    expect(status).toBe(1)
    expect(codes(data)).toEqual(['refuse sync.not-deployment sync.yaml'])
  })

  // Catches: rendering without running the rule checker on what it renders.
  it('a rule object promtool refuses: exit 1, naming the deployment', () => {
    write(`${S1}/templates/broken.yaml`, BROKEN)
    const { status, data } = json()
    expect(status).toBe(1)
    expect(codes(data)).toEqual([`refuse deployment.rules ${S1}`])
    expect(data.problems[0].message).toMatch(/^its rules failed \(promtool\)/)
    expect(data.problems[0].message).not.toContain(os.tmpdir())
  })

  // Catches: a copy whose links lead elsewhere than the repo's (one climbing
  // out of the repo's folder and back in by its name), and a deployment
  // the copy cannot render skipped without a word: a false pass.
  it('a _common stack whose link climbs out of the repo folder and back in: rendered, its rules checked', () => {
    write(`deployments/s/_common/${T.split('/')[1]}/Chart.yaml`, `apiVersion: v2\nname: common-s\nversion: 0.1.0\ndependencies:\n  - name: mariadb-alerts\n    version: ">=0.0.0-0"\n    repository: file://../../../../charts/mariadb-alerts\n`)
    write('deployments/s/_common/mariadb-alerts/values.yaml', 'mariadb-alerts:\n  _common:\n    owner: s\n')
    fs.mkdirSync(path.join(repo, 'deployments/s/_common/mariadb-alerts/charts'), { recursive: true })
    fs.symlinkSync('../../../../../../gitops/charts/mariadb-alerts', path.join(repo, 'deployments/s/_common/mariadb-alerts/charts/mariadb-alerts'))
    write('deployments/s/d1/Chart.yaml', 'apiVersion: v2\nname: d1\nversion: 0.1.0\ndependencies:\n  - name: common-s\n    version: ">=0.0.0-0"\n    repository: file://../_common/mariadb-alerts\n')
    write('deployments/s/d1/values.yaml', 'common-s:\n  mariadb-alerts:\n    mariadb_traffic_qps_low:\n      - min_qps: 5\n')
    write('deployments/s/d1/templates/broken.yaml', BROKEN)
    const { status, data } = json()
    expect(codes(data)).toEqual(['refuse deployment.rules deployments/s/d1'])
    expect(status).toBe(1)
  })

  // The exit codes follow check-deployment's rule: 1 for a deployment that
  // would not deploy as written, a file of its own that cannot be read
  // included; 2 where AlertForge cannot tell, or did not look.
  // Catches: a file it cannot read taken for one that is fine (exit 0).
  it.skipIf(asRoot)('a values file that cannot be read: exit 1, naming it', () => {
    fs.chmodSync(path.join(repo, `${S1}/values.yaml`), 0)
    const { status, data } = json()
    expect(status).toBe(1)
    expect(codes(data)).toEqual([`refuse values.unreadable ${S1}/values.yaml`])
    expect(run([repo]).out).toContain(`  refused      ${S1}/values.yaml: `)
  })

  // Catches: values AlertForge cannot tell Helm's reading of left
  // unrendered as "not checked": Helm, at hand, decides; Commit refuses them.
  it('values AlertForge cannot tell Helm\'s reading of: refused as Commit refuses them, and rendered by Helm', () => {
    edit(`${P2}/values.yaml`, 'owner: app-b', 'owner: !foo app-b')
    const { status, data } = json()
    expect(codes(data)).toEqual([`refuse yaml.cannot-read ${P2}/values.yaml`])
    expect(status).toBe(1)
    edit(`${P2}/values.yaml`, 'owner: !foo app-b', 'owner: !foo [')
    expect(codes(json().data)).toEqual([`refuse yaml.cannot-read ${P2}/values.yaml`, `refuse deployment.render ${P2}`])
  })

  // The same for a _common's values: rendered by Helm, which decides, and
  // refused as Commit refuses them. Catches: a _common AlertForge cannot
  // tell taken for one Helm cannot render, and not rendered.
  it('a _common\'s values AlertForge cannot tell Helm\'s reading of: refused as Commit refuses them, and rendered by Helm', () => {
    write(`deployments/s/_common/${T.split('/')[1]}/Chart.yaml`, `apiVersion: v2\nname: common\nversion: 0.1.0\ndependencies:\n  - name: mariadb-alerts\n    version: ">=0.0.0-0"\n`)
    write('deployments/s/_common/mariadb-alerts/values.yaml', 'mariadb-alerts:\n  _common:\n    owner: s\n  note: |2\n     two spaces more\n')
    fs.mkdirSync(path.join(repo, 'deployments/s/_common/mariadb-alerts/charts'), { recursive: true })
    fs.symlinkSync('../../../../../charts/mariadb-alerts', path.join(repo, 'deployments/s/_common/mariadb-alerts/charts/mariadb-alerts'))
    write('deployments/s/d1/Chart.yaml', 'apiVersion: v2\nname: d1\nversion: 0.1.0\ndependencies:\n  - name: common\n    version: ">=0.0.0-0"\n    repository: file://../_common/mariadb-alerts\n')
    write('deployments/s/d1/values.yaml', 'common:\n  mariadb-alerts:\n    _common:\n      namespace: ns1\n')
    write('deployments/s/d1/templates/broken.yaml', BROKEN)
    const { status, data } = json()
    // Rendered: its rules are checked (the broken one is found).
    expect(codes(data)).toEqual(['refuse stack.values-cannot-tell deployments/s/d1/Chart.yaml', 'refuse deployment.rules deployments/s/d1'])
    expect(status).toBe(1)
  })

  // A _common's own values.yaml is read as a deployment's own is: what
  // Helm reads otherwise than written, or passes on to no Template, is
  // refused naming the _common's file. Helm renders the deployment below.
  const stackOn = layerValues => {
    write('deployments/s/_common/mariadb-alerts/Chart.yaml', 'apiVersion: v2\nname: common\nversion: 0.1.0\ndependencies:\n  - name: mariadb-alerts\n    version: ">=0.0.0-0"\n')
    write('deployments/s/_common/mariadb-alerts/values.yaml', layerValues)
    fs.mkdirSync(path.join(repo, 'deployments/s/_common/mariadb-alerts/charts'), { recursive: true })
    fs.symlinkSync('../../../../../charts/mariadb-alerts', path.join(repo, 'deployments/s/_common/mariadb-alerts/charts/mariadb-alerts'))
    write('deployments/s/d1/Chart.yaml', 'apiVersion: v2\nname: d1\nversion: 0.1.0\ndependencies:\n  - name: common\n    version: ">=0.0.0-0"\n    repository: file://../_common/mariadb-alerts\n')
    write('deployments/s/d1/values.yaml', 'common:\n  mariadb-alerts:\n    _common:\n      owner: d1\n      namespace: ns1\n')
  }
  const LAYER = 'deployments/s/_common/mariadb-alerts'

  it('a _common as Helm reads it: exit 0', () => {
    stackOn('mariadb-alerts:\n  mariadb_saturation_cpu:\n    - { warn_pct: 8, critical_pct: 95 }\n')
    const { status, data } = json()
    expect(codes(data)).toEqual([])
    expect(status).toBe(0)
  })

  it('a _common\'s value Helm reads otherwise (010): exit 1, naming the _common\'s file and line', () => {
    stackOn('mariadb-alerts:\n  mariadb_saturation_cpu:\n    - { warn_pct: 010, critical_pct: 95 }\n')
    const { status, data } = json()
    expect(codes(data)).toEqual([`refuse yaml.read-differently ${LAYER}/values.yaml`])
    expect(data.problems[0].message).toBe(`${LAYER}/values.yaml line 3: Helm reads 010 as 8 (YAML 1.1); the editor would write 8. Write 8, or '010' in quotes for the text`)
    expect(data.problems[0].group).toBe(LAYER)
    expect(status).toBe(1)
  })

  it('a _common\'s values not under the chart\'s name: exit 1, naming the _common\'s file', () => {
    stackOn('mariadb_saturation_cpu:\n  - { warn_pct: 8, critical_pct: 95 }\n')
    const { status, data } = json()
    expect(codes(data)).toEqual([`refuse values.not-under-chart-key ${LAYER}/values.yaml`])
    expect(data.problems[0].message).toContain('the values are not under mariadb-alerts: Helm passes none of them to the Template mariadb-alerts')
    expect(status).toBe(1)
  })

  // Catches: a folder whose deployments were not looked at taken for none.
  it.skipIf(asRoot)('a folder that cannot be listed: exit 2, naming it', () => {
    fs.mkdirSync(path.join(repo, 'deployments/locked'))
    fs.chmodSync(path.join(repo, 'deployments/locked'), 0)
    const { status, data } = json()
    expect(codes(data)).toEqual(['refuse/not-checked walk.folder-unreadable deployments/locked'])
    expect(status).toBe(2)
  })

  // Catches: a file the copy cannot take left out of it without a word:
  // no loader reads a deployment's own templates/, and Helm, which fails on
  // it in the repo, renders the copy without it.
  it.skipIf(asRoot)('a file of a deployment that cannot be read, which no check reads: exit 1, naming it', () => {
    write(`${S1}/templates/extra.yaml`, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: extra\ndata:\n  a: b\n')
    fs.chmodSync(path.join(repo, `${S1}/templates/extra.yaml`), 0)
    const { status, data } = json()
    expect(codes(data)).toEqual([`refuse repo.not-copied ${S1}/templates/extra.yaml`])
    expect(data.problems[0].group).toBe(S1)
    expect(status).toBe(1)
  })

  // Outside every deployment and Template: what is in it was not looked at.
  it.skipIf(asRoot)('a file outside every deployment that cannot be read: exit 2, naming it', () => {
    write('notes/todo.txt', 'x')
    fs.chmodSync(path.join(repo, 'notes/todo.txt'), 0)
    const { status, data } = json()
    expect(codes(data)).toEqual(['refuse/not-checked repo.not-copied notes/todo.txt'])
    expect(status).toBe(2)
  })

  // The same file named once: by the check that read it.
  it.skipIf(asRoot)('a values file that cannot be read is named once', () => {
    fs.chmodSync(path.join(repo, `${S1}/values.yaml`), 0)
    expect(codes(json().data)).toEqual([`refuse values.unreadable ${S1}/values.yaml`])
  })

  // Catches: a folder Helm fails on, or whose rows deploy nothing, taken
  // for no deployment and passed without a word.
  it('a Chart.yaml that cannot be used, or a link round in a circle: exit 2; values with no Template: exit 1', () => {
    write('deployments/x/empty/Chart.yaml', '')
    write('deployments/x/empty/values.yaml', 'a: 1\n')
    const first = json()
    expect(codes(first.data)).toEqual(['refuse/not-checked walk.chart-unreadable deployments/x/empty'])
    expect(first.status).toBe(2)
    fs.rmSync(path.join(repo, 'deployments/x'), { recursive: true })
    fs.symlinkSync('self', path.join(repo, 'deployments/self'))
    expect(codes(json().data)).toEqual(['refuse/not-checked walk.link-circle deployments/self'])
    fs.rmSync(path.join(repo, 'deployments/self'))
    write('deployments/x/none/Chart.yaml', 'apiVersion: v2\nname: none\nversion: 0.1.0\n')
    write('deployments/x/none/values.yaml', 'mariadb-alerts:\n  mariadb_traffic_qps_low:\n    - min_qps: 5\n')
    const last = json()
    expect(codes(last.data)).toEqual(['refuse walk.values-no-template deployments/x/none/values.yaml'])
    expect(last.status).toBe(1)
  })

  // Catches: deployments the walk does not look into passed without a word.
  // A warning each, the exit code as it was: flat files are not supported,
  // a hidden folder is not walked, a repo's root is no deployment folder.
  it('a deployment in a hidden folder, one at the repo\'s root and flat <name>-values.yaml files: a warning each', () => {
    fs.cpSync(path.join(repo, P1), path.join(repo, 'deployments/.old/p1'), { recursive: true })
    fs.copyFileSync(path.join(repo, `${P1}/values.yaml`), path.join(repo, 'values.yaml'))
    write('Chart.yaml', 'apiVersion: v2\nname: root\nversion: 0.1.0\ndependencies:\n  - name: mariadb-alerts\n    version: ">=0.0.0-0"\n    repository: file://charts/mariadb-alerts\n')
    write('deployments/mariadb-alerts/shop-values.yaml', 'mariadb-alerts: {}\n')
    const { status, data } = json()
    expect(codes(data)).toEqual([
      'warn walk.repo-root Chart.yaml',
      'warn walk.hidden deployments/.old/p1',
      'warn walk.flat deployments/mariadb-alerts/shop-values.yaml',
    ])
    expect(data.problems.map(p => p.message)).toEqual([
      'not checked: a Chart.yaml and values.yaml at the repo\'s root are no deployment AlertForge reads: put the deployment in a folder of its own',
      'not checked: it is in a hidden folder, which the checks do not walk into',
      'not checked: deployments kept as <name>-values.yaml files are not supported: move it to a folder deployment',
    ])
    expect(status).toBe(0)
  })

  // Catches: "nothing to check" taken for a failure.
  it('a repo with no deployments: exit 0', () => {
    fs.rmSync(path.join(repo, 'deployments'), { recursive: true })
    const r = run([repo])
    expect(r.out).toBe('check-repo: 1 Template, 0 deployments: 0 refused, 0 not checked, 0 warnings\n')
    expect(r.status).toBe(0)
  })

  // Catches: needing git when the repo is given (a plain copy, another
  // uid's checkout), and guessing a repo when none is given.
  it('a folder that is no git checkout is checked when given; with none given, outside a checkout, exit 2', () => {
    expect(run([repo]).status).toBe(0)
    const r = run([], { cwd: repo })
    expect(r.status).toBe(2)
    expect(r.err).toBe("check-repo: the current folder is in no git checkout: give the gitops repo's root\n")
  })

  it('with no repo given, the checkout the current folder is in', () => {
    gitInit(repo)
    const r = run([], { cwd: path.join(repo, P1) })
    expect(r.out).toBe('check-repo: 1 Template, 3 deployments: 0 refused, 0 not checked, 0 warnings\n')
    expect(r.status).toBe(0)
  })

  // Catches: a path split at a space, or the copy's path in what is said.
  it('a path with a space: checked, and only the path given is shown', () => {
    const spaced = path.join(work, 'my gitops')
    fs.renameSync(repo, spaced)
    repo = spaced
    edit(`${P2}/values.yaml`, 'warn_threshold: 0.3', 'warn_threshold: abc')
    const r = run([repo])
    expect(r.status).toBe(1)
    expect(r.all).not.toMatch(/check-repo-[A-Za-z0-9]{6}/)
    const j = json()
    expect(j.data.repo).toBe(repo)
  })

  // Catches: rendering in the repo itself (Helm writes Chart.lock and
  // charts/*.tgz into every deployment it renders).
  it('writes nothing into the repo: git status the same before and after, a read-only tree included', () => {
    const git = gitInit(repo)
    const before = git('status', '--porcelain', '--ignored')
    expect(run([repo]).status).toBe(0)
    expect(git('status', '--porcelain', '--ignored')).toBe(before)
    if (asRoot) return
    execFileSync('chmod', ['-R', 'a-w', repo])
    const r = run([repo])
    expect(r.all).toBe('check-repo: 1 Template, 3 deployments: 0 refused, 0 not checked, 0 warnings\n')
    expect(r.status).toBe(0)
    execFileSync('chmod', ['-R', 'u+w', repo])
    expect(git('status', '--porcelain', '--ignored')).toBe(before)
  })

  // Catches: the copy, Helm's home and the checkers' files left in the
  // temp folder when the run is stopped.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    it(`stopped with ${signal}: nothing of it is left in the temp folder`, async () => {
      for (let i = 0; i < 20; i++) fs.cpSync(path.join(repo, P1), path.join(repo, `deployments/many/d${i}`), { recursive: true })
      for (let i = 0; i < 20; i++) edit(`deployments/many/d${i}/Chart.yaml`, 'name: mariadb-1-production', `name: d${i}`)
      const tmp = path.join(work, 'tmp')
      fs.mkdirSync(tmp)
      const child = spawn('node', [SCRIPT, repo, '--jobs', '1'], { env: env({ TMPDIR: tmp }), stdio: 'ignore' })
      const exited = new Promise(resolve => child.on('exit', (c, s) => resolve(c ?? s)))
      // Stopped once Helm is at work in the copy.
      const started = performance.now()
      while (!fs.readdirSync(tmp).length || !fs.readdirSync(tmp).some(n => fs.readdirSync(path.join(tmp, n)).length)) {
        if (performance.now() - started > 30000) throw new Error('it never started')
        await new Promise(r => setTimeout(r, 50))
      }
      await new Promise(r => setTimeout(r, 500))
      child.kill(signal)
      const how = await exited
      expect(fs.readdirSync(tmp)).toEqual([])
      // Nor written again by a Helm or checker it had started.
      await new Promise(r => setTimeout(r, 1500))
      expect(fs.readdirSync(tmp)).toEqual([])
      expect(how).toBe(code)
    }, 60000)
  }

  // The same, with the signal at one chosen moment (tests/helpers/stopAt.mjs)
  // rather than wherever a timer lands. Catches: a temp folder made but not
  // yet known to the handler; a copy that goes on making folders while they
  // are removed; a Helm that outlives the run and writes into its folder
  // again; a folder no longer known while it is being removed; a second
  // signal that kills the run in the middle of its cleanup; a signal before
  // any folder exists answered otherwise than one after.
  const STOP_AT = path.resolve('tests/helpers/stopAt.mjs')
  for (const [at, signal] of [['before', 'SIGTERM'], ['made', 'SIGTERM'], ['copy', 'SIGTERM'], ['helm', 'SIGTERM'], ['removing', 'SIGTERM'], ['second', 'SIGINT']]) {
    it(`stopped with ${signal} at a chosen moment (${at}): nothing of it is left, no Helm of it running`, async () => {
      for (let i = 0; i < 20; i++) fs.cpSync(path.join(repo, P1), path.join(repo, `deployments/many/d${i}`), { recursive: true })
      for (let i = 0; i < 20; i++) edit(`deployments/many/d${i}/Chart.yaml`, 'name: mariadb-1-production', `name: d${i}`)
      const tmp = path.join(work, 'tmp')
      fs.mkdirSync(tmp)
      // A Helm that takes a while, then makes a folder in the chart it was
      // given, as `helm dependency update` makes charts/; its pid is noted.
      const pids = path.join(work, 'helm-pids')
      const helm = path.join(work, 'slow-helm')
      fs.writeFileSync(helm, `#!/bin/sh\necho $$ >> '${pids}'\nfor a; do last=$a; done\nsleep 1\nmkdir -p "$last/charts/late"\nexec '${execFileSync('sh', ['-c', `command -v ${process.env.HELM_BIN || 'helm'}`], { encoding: 'utf-8' }).trim()}' "$@"\n`, { mode: 0o755 })
      const log = path.join(work, 'signals')
      const child = spawn('node', ['--import', STOP_AT, SCRIPT, repo, '--jobs', '4'], { env: env({ TMPDIR: tmp, HELM_BIN: helm, STOP_AT: at, STOP_SIGNAL: signal, STOP_LOG: log }), stdio: 'ignore' })
      const how = await new Promise(resolve => child.on('exit', (c, s) => resolve(c ?? s)))
      expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual(at === 'second' ? [`${signal} 1`, `${signal} 2`] : [`${signal} 1`])
      expect(fs.readdirSync(tmp)).toEqual([])
      // Nor made again by a Helm it had started, which is no longer running.
      await new Promise(r => setTimeout(r, 1500))
      expect(fs.readdirSync(tmp)).toEqual([])
      const alive = (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf-8').trim().split('\n') : []).filter(pid => { try { process.kill(Number(pid), 0); return true } catch { return false } })
      expect(alive).toEqual([])
      expect(how).toBe(signal === 'SIGINT' ? 130 : 143)
    }, 60000)
  }

  // Catches: a path of the run's temp folder (its copy of the repo, Helm's
  // home) or of the home folder in what is said: a Helm error about a link
  // climbing out of the repo, a remote dependency missing from Helm's cache.
  it('says no path of its temp folder or the home folder', () => {
    edit(`${P2}/Chart.yaml`, /$/, '  - name: foo\n    version: "1.0.0"\n    repository: https://example.invalid/charts\n')
    fs.rmSync(path.join(repo, `${S1}/values.yaml`))
    fs.writeFileSync(path.join(repo, 'deployments/shared-values.yaml'), 'mariadb-alerts:\n  _common:\n    namespace: "a\\"b"\n')
    fs.symlinkSync('../../../../gitops/deployments/shared-values.yaml', path.join(repo, `${S1}/values.yaml`))
    const tmp = path.join(work, 'tmp')
    fs.mkdirSync(tmp)
    const all = [run([repo], { extraEnv: { TMPDIR: tmp } }), run([repo, '--json'], { extraEnv: { TMPDIR: tmp } })].map(r => r.all).join('\n')
    expect(all).toContain(P2)
    expect(all).not.toContain(tmp)
    expect(all).not.toContain(os.homedir())
  })

  // Catches: a missing tool read as a pass or a refusal.
  it('helm missing: exit 2, saying so', () => {
    const r = run([repo], { extraEnv: { HELM_BIN: path.join(work, 'no-helm') } })
    expect(r.status).toBe(2)
    expect(r.err).toBe(`check-repo: helm is not available: ${path.join(work, 'no-helm')}\n`)
  })

  it('wrong arguments: exit 2 with the usage', () => {
    for (const args of [['--jobs', '0'], ['--jobs', '2.5'], ['--nope'], [repo, repo]]) {
      const r = run(args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.err).toContain('usage: node scripts/check-repo.mjs')
    }
    expect(run([repo, '--jobs=1']).status).toBe(0)
  })

  // Catches: --json that answers some ways out in text only.
  it('with --json, every way out is JSON on stdout', () => {
    for (const args of [['--jobs', '0'], ['--nope'], [repo, repo], [path.join(work, 'nowhere')], ['--repo']]) {
      const r = run([...args, '--json'])
      expect(r.status, args.join(' ')).toBe(2)
      const data = JSON.parse(r.out)
      expect(data.exit).toBe(2)
      expect(data.error).toBeTruthy()
    }
    const missing = run([repo, '--json'], { extraEnv: { HELM_BIN: path.join(work, 'no-helm') } })
    expect(JSON.parse(missing.out)).toMatchObject({ exit: 2, error: `helm is not available: ${path.join(work, 'no-helm')}` })
  })

  // check-deployment takes the repo as --repo: so does check-repo.
  it('takes the repo as --repo too', () => {
    expect(run(['--repo', repo]).out).toBe('check-repo: 1 Template, 3 deployments: 0 refused, 0 not checked, 0 warnings\n')
    expect(run(['--repo', repo, '--json']).status).toBe(0)
    for (const args of [['--repo'], ['--repo', repo, repo], [repo, '--repo', repo]]) {
      const r = run(args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.err).toContain('usage: node scripts/check-repo.mjs')
    }
  })

  // Catches: a wrong path in a CI job that looks green ("0 deployments").
  it('a folder inside the checkout, not its root: exit 2, naming the root', () => {
    gitInit(repo)
    const r = run([path.join(repo, 'deployments')])
    expect(r.err).toBe(`check-repo: ${path.join(repo, 'deployments')} is inside the git checkout ${repo}: give that, its root\n`)
    expect(r.status).toBe(2)
  })

  it('deployments/ of a folder that is no checkout: exit 2, it is not the repo\'s root', () => {
    const r = run([path.join(repo, 'deployments')])
    expect(r.err).toBe(`check-repo: ${path.join(repo, 'deployments')} has deployments and no charts/ folder: it is not the gitops repo's root — give the folder that holds charts/\n`)
    expect(r.status).toBe(2)
  })

  it('a folder with nothing in it to check: exit 0, and it says so', () => {
    const empty = path.join(work, 'empty')
    fs.mkdirSync(empty)
    const r = run([empty])
    expect(r.out).toBe(`check-repo: nothing found to check in ${empty}: no charts/ folder and no deployment\ncheck-repo: 0 Templates, 0 deployments: 0 refused, 0 not checked, 0 warnings\n`)
    expect(r.status).toBe(0)
    expect(JSON.parse(run([empty, '--json']).out)).toMatchObject({ exit: 0, nothingFound: true })
  })

  it('a repo that is not there: exit 2', () => {
    const r = run([path.join(work, 'nowhere')])
    expect(r.status).toBe(2)
    expect(r.err).toBe(`check-repo: ${path.join(work, 'nowhere')} does not exist\n`)
  })
})
