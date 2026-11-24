// The loops doc/how-to.md gives for regenerating and checking every chart
// after an upgrade, run as written: the image form with node standing in for
// docker, and the source-checkout form. Each must go through every chart and
// exit non-zero when any one failed — a CI step running it is only as good
// as its exit status.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

const REPO = path.resolve('.')
const HOWTO = fs.readFileSync(path.join(REPO, 'doc/how-to.md'), 'utf-8')
const blocks = [...HOWTO.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1])
const loop = (form, check) => {
  const found = blocks.filter(b => b.includes(form === 'image' ? 'for c in charts/*/' : 'for c in /path/to/gitops/charts/*/') &&
    b.includes('gen-rules.mjs') && b.includes('--check') === check)
  expect(found, `${form} ${check ? '--check' : 'write'} loop`).toHaveLength(1)
  return found[0]
}

// docker run … "$IMAGE" <command>: the command, run in the AlertForge
// checkout with /work read as the gitops repo.
const DOCKER_SHIM = `docker() {
  shift
  while [ "$1" != "$IMAGE" ]; do shift; done
  shift
  local a=()
  for x in "$@"; do a+=("\${x//\\/work/$GITOPS}"); done
  (cd "$REPO" && "\${a[@]}")
}
`

let gitops
beforeEach(() => {
  gitops = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-loops-'))
  const sample = path.join(REPO, 'sample/charts/mariadb-alerts')
  for (const name of ['good', 'stale one', 'broken']) fs.cpSync(sample, path.join(gitops, 'charts', name), { recursive: true })
  fs.mkdirSync(path.join(gitops, 'charts', 'no-rules'))
  // A product edited by hand: stale.
  const tmpl = path.join(gitops, 'charts', 'stale one', 'templates', 'mariadb-saturation-cpu.yaml')
  fs.appendFileSync(tmpl, '# edited\n')
  // A value the release refuses.
  const rules = path.join(gitops, 'charts', 'broken', 'rules', 'mariadb_saturation_cpu.yaml')
  fs.writeFileSync(rules, fs.readFileSync(rules, 'utf-8').replace(/^group: .*\n/, m => `${m}interval: 30m1h\n`))
})
afterEach(() => fs.rmSync(gitops, { recursive: true, force: true }))

function run(form, check) {
  // The site's labels would be exported here; the sample chart is made
  // without any.
  const script = loop(form, check).replace(/^export RULE_OBJECT_.*\n/m, '').replaceAll('/path/to/gitops', gitops).replaceAll('<version>', 'test')
  const env = { ...process.env, REPO, GITOPS: gitops }
  for (const k of Object.keys(env)) if (k.startsWith('RULE_OBJECT_')) delete env[k]
  const r = spawnSync('bash', ['-c', (form === 'image' ? DOCKER_SHIM : '') + script], { cwd: form === 'image' ? gitops : REPO, env, encoding: 'utf-8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

describe.each(['image', 'source'])('the how-to loops, %s form', form => {
  it('--check names the stale and the broken chart and exits 1; once both are fixed, 0', () => {
    const first = run(form, true)
    expect(first.status).toBe(1)
    expect(first.out).toMatch(/DIFFERS\s+templates\/mariadb-saturation-cpu\.yaml/)
    expect(first.out).toMatch(/ERROR .*interval "30m1h"/)

    // Writing regenerates the stale one, refuses the broken one, exits 1.
    const write = run(form, false)
    expect(write.status).toBe(1)
    expect(fs.readFileSync(path.join(gitops, 'charts', 'stale one', 'templates', 'mariadb-saturation-cpu.yaml'), 'utf-8')).not.toContain('# edited')
    expect(run(form, true).status).toBe(1)

    const rules = path.join(gitops, 'charts', 'broken', 'rules', 'mariadb_saturation_cpu.yaml')
    fs.writeFileSync(rules, fs.readFileSync(rules, 'utf-8').replace('interval: 30m1h\n', ''))
    expect(run(form, false).status).toBe(0)
    const last = run(form, true)
    expect(last.out).not.toMatch(/DIFFERS|ERROR/)
    expect(last.status).toBe(0)
  })
})
