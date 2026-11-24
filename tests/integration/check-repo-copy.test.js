// check-repo renders in a copy of the repo (server/repo/copyRepo.js): the
// copy must be the repo as Helm reads it, or what is rendered is not what
// deploys. Each case builds a repo from sample/, then holds the copy to the
// repo: every deployment's _common stack read the same way from both.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { copyRepo } from '../../server/repo/copyRepo.js'
import { openRepo } from '../../server/repo/openRepo.js'
import { walk } from '../../server/repo/walk.js'
import { resolveStack } from '../../server/lib/stack.js'

const SAMPLE = path.resolve('sample')
const T = 'mariadb-alerts'
let work, repo
beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-repo-copy-')))
  repo = path.join(work, 'gitops')
  fs.cpSync(SAMPLE, repo, { recursive: true })
  fs.rmSync(path.join(repo, 'promtool-tests'), { recursive: true, force: true })
})
afterEach(() => {
  execFileSync('chmod', ['-R', 'u+rwX', work])
  fs.rmSync(work, { recursive: true, force: true })
})
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }

// A _common stack over the Template; its charts/ link written as `link`.
function stack(link) {
  write(`deployments/s/_common/${T}/Chart.yaml`, `apiVersion: v2\nname: common-s\nversion: 0.1.0\ndependencies:\n  - name: ${T}\n    version: ">=0.0.0-0"\n    repository: file://../../../../charts/${T}\n`)
  write(`deployments/s/_common/${T}/values.yaml`, `${T}:\n  _common:\n    owner: s\n`)
  fs.mkdirSync(path.join(repo, `deployments/s/_common/${T}/charts`), { recursive: true })
  fs.symlinkSync(link, path.join(repo, `deployments/s/_common/${T}/charts/${T}`))
  write('deployments/s/d1/Chart.yaml', `apiVersion: v2\nname: d1\nversion: 0.1.0\ndependencies:\n  - name: common-s\n    version: ">=0.0.0-0"\n    repository: file://../_common/${T}\n`)
  write('deployments/s/d1/values.yaml', `common-s:\n  ${T}:\n    mariadb_traffic_qps_low:\n      - min_qps: 5\n`)
}

// What each deployment's stack is, from the repo and from the copy.
async function stacks(root) {
  const r = openRepo(root)
  const out = {}
  for (const d of (await walk(r)).filter(e => e.kind === 'deployment')) {
    const s = await resolveStack(root, path.join(root, d.rel), { repo: r })
    out[d.rel] = { problems: s.problems.map(p => p.kind), layers: s.layers.map(l => l.path), chart: s.chart }
  }
  return out
}
async function bothViews() {
  const copy = await copyRepo(repo)
  try {
    return { repo: await stacks(repo), copy: await stacks(copy.root) }
  } finally {
    await copy.remove()
  }
}

describe('the copy check-repo renders in', () => {
  it('reads every stack as the repo does: a plain stack', async () => {
    stack(`../../../../../charts/${T}`)
    const v = await bothViews()
    expect(v.repo['deployments/s/d1'].problems).toEqual([])
    expect(v.copy).toEqual(v.repo)
  })

  // A link climbing out of the repo's folder and back in by its name: copied
  // as written, it leads nowhere in the copy.
  it('reads every stack as the repo does: a link out of the repo folder and back in by its name', async () => {
    stack(`../../../../../../gitops/charts/${T}`)
    const v = await bothViews()
    expect(v.repo['deployments/s/d1'].problems).toEqual([])
    expect(v.copy).toEqual(v.repo)
  })

  it('reads every stack as the repo does: a link to nothing, and one in a circle', async () => {
    stack(`../../../../../charts/nothing-there`)
    fs.symlinkSync('self', path.join(repo, 'deployments/mariadb-2/self'))
    const v = await bothViews()
    expect(v.repo['deployments/s/d1'].problems).toEqual(['template-missing'])
    expect(v.copy).toEqual(v.repo)
  })

  it('a link leading out of the repo leads to the same place from the copy', async () => {
    const outside = path.join(work, 'outside-values.yaml')
    fs.copyFileSync(path.join(repo, 'deployments/mariadb-1/staging/values.yaml'), outside)
    fs.rmSync(path.join(repo, 'deployments/mariadb-1/staging/values.yaml'))
    fs.symlinkSync('../../../../outside-values.yaml', path.join(repo, 'deployments/mariadb-1/staging/values.yaml'))
    const copy = await copyRepo(repo)
    try {
      expect(fs.realpathSync(path.join(copy.root, 'deployments/mariadb-1/staging/values.yaml'))).toBe(outside)
    } finally {
      await copy.remove()
    }
  })
})
