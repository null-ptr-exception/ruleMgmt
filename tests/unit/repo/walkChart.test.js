// A folder with a Chart.yaml the walk reads but cannot use as a
// deployment's, or a values.yaml with rows and no Template to render them,
// or a link round in a circle: Helm fails on it or renders nothing, so the
// walk says so, as it says a Chart.yaml it cannot read — never a plain
// folder nobody names.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openRepo } from '../../../server/repo/openRepo.js'
import { folderEntry, walk, walkFindings } from '../../../server/repo/walk.js'
import { decide } from '../../../server/repo/policy.js'
import { deploymentCommitBlockers } from '../../../server/lib/commitChecks.js'

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-chart-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
const entry = rel => folderEntry(openRepo(root), rel)
const ROWS = 'demo:\n  cpu:\n    - job: x\n'

describe('the walk and a Chart.yaml it cannot use', () => {
  it('an empty Chart.yaml: cannot be used, named', async () => {
    put('deployments/a/Chart.yaml', '')
    put('deployments/a/values.yaml', ROWS)
    expect(await entry('deployments/a')).toMatchObject({ kind: 'unreadable', cause: 'chart', why: 'its Chart.yaml cannot be used (it is empty)' })
  })

  it('dependencies that are not a list: cannot be used, named', async () => {
    put('deployments/b/Chart.yaml', 'apiVersion: v2\nname: b\ndependencies: demo\n')
    put('deployments/b/values.yaml', ROWS)
    expect(await entry('deployments/b')).toMatchObject({ kind: 'unreadable', cause: 'chart', why: 'its Chart.yaml cannot be used (its dependencies are not a list)' })
  })

  it('no dependencies, and a values.yaml with rows: a folder, said, its rows deploy nothing', async () => {
    put('deployments/c/Chart.yaml', 'apiVersion: v2\nname: c\nversion: 0.1.0\n')
    put('deployments/c/values.yaml', ROWS)
    expect(await entry('deployments/c')).toMatchObject({ kind: 'folder', valuesWithoutTemplate: true })
    const facts = walkFindings(await walk(openRepo(root)))
    expect(facts.map(f => [f.code, f.file])).toEqual([['walk.values-no-template', 'deployments/c/values.yaml']])
    expect(decide(facts, 'commit').list).toHaveLength(1)
    expect(decide(facts, 'checkRepo').refuse).toHaveLength(1)
  })

  it('no dependencies and no rows (a chart of someone else\'s, an empty values.yaml): a folder, nothing said', async () => {
    put('deployments/d/Chart.yaml', 'apiVersion: v2\nname: d\nversion: 0.1.0\n')
    put('deployments/d/values.yaml', '{}\n')
    expect(await entry('deployments/d')).toEqual({ rel: 'deployments/d', kind: 'folder' })
    expect(walkFindings(await walk(openRepo(root)))).toEqual([])
  })

  it('a folder that is a link round in a circle: named, Helm cannot read it', async () => {
    fs.mkdirSync(path.join(root, 'deployments'), { recursive: true })
    fs.symlinkSync('self', path.join(root, 'deployments/self'))
    expect(await entry('deployments/self')).toMatchObject({ kind: 'unreadable', cause: 'circle', link: 'circle' })
    const facts = walkFindings(await walk(openRepo(root)))
    expect(facts.map(f => [f.code, f.file, f.helm])).toEqual([['walk.link-circle', 'deployments/self', 'fails']])
  })

  it('the Chart.yaml and values.yaml of a deployment: a deployment, as before', async () => {
    put('deployments/e/Chart.yaml', 'apiVersion: v2\nname: e\ndependencies:\n  - name: demo\n    repository: file://../../charts/demo\n')
    put('deployments/e/values.yaml', ROWS)
    expect((await entry('deployments/e')).kind).toBe('deployment')
  })

  it('Commit lists each of them, and refuses none', async () => {
    put('deployments/a/Chart.yaml', '')
    put('deployments/a/values.yaml', ROWS)
    put('deployments/c/Chart.yaml', 'apiVersion: v2\nname: c\nversion: 0.1.0\n')
    put('deployments/c/values.yaml', ROWS)
    fs.symlinkSync('self', path.join(root, 'deployments/self'))
    const answer = await deploymentCommitBlockers(root)
    expect(answer.findings).toEqual([])
    expect(answer.unreadable.map(u => u.path)).toEqual(['deployments/a', 'deployments/c/values.yaml', 'deployments/self'])
  })
})
