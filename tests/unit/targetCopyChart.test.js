import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { targetCopy } from '../../server/lib/deploymentWrite.js'
import { openRepo } from '../../server/repo/openRepo.js'
import { writeFiles } from '../../server/repo/write.js'

let dir
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chart-deps-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function write(rel, doc) {
  await fs.mkdir(path.join(dir, rel), { recursive: true })
  await fs.writeFile(path.join(dir, rel, 'Chart.yaml'), typeof doc === 'string' ? doc : yaml.dump(doc))
}
const read = async rel => yaml.load(await fs.readFile(path.join(dir, rel, 'Chart.yaml'), 'utf-8'))

// A sync target's copy, as it is planned (targetCopy) and written by the
// writer: `what` picks the files. true when it wrote something.
async function copyTo(src, tgt, what) {
  const copy = await targetCopy(openRepo(dir), src, tgt, what)
  if (copy.refusal) throw new Error(copy.refusal.body.error)
  if (!copy.files.length) return false
  expect((await writeFiles(dir, copy.files)).ok).toBe(true)
  return true
}
// Only the target's Chart.yaml: it depends on what the source's does.
const copyChartDependencies = (src, tgt) => copyTo(src, tgt, { values: false, chart: true, routing: false })

describe('a sync target\'s Chart.yaml, copied from its source\'s', () => {
  it('only a relative file:// path is worked out again; other repositories are copied as they are', async () => {
    await write('a/src', { apiVersion: 'v2', name: 'src', version: '0.1.0', dependencies: [
      { name: 'demo', version: '1.0.0', repository: 'file://../../charts/demo', alias: 'x' },
      { name: 'abs', version: '1.0.0', repository: 'file:///srv/charts/abs' },
      { name: 'remote', version: '2.0.0', repository: 'https://charts.example.com' },
    ] })
    await write('a/b/tgt', { apiVersion: 'v2', name: 'tgt', version: '0.3.0' })
    expect(await copyChartDependencies('a/src', 'a/b/tgt')).toBe(true)
    expect(await read('a/b/tgt')).toEqual({ apiVersion: 'v2', name: 'tgt', version: '0.3.0', dependencies: [
      { name: 'demo', version: '1.0.0', repository: 'file://../../../charts/demo', alias: 'x' },
      { name: 'abs', version: '1.0.0', repository: 'file:///srv/charts/abs' },
      { name: 'remote', version: '2.0.0', repository: 'https://charts.example.com' },
    ] })
  })

  it('writes nothing when the dependencies are already the same', async () => {
    await write('a/src', { name: 'src', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    const text = '# keep me\nname: tgt\ndependencies:\n  - name: demo\n    repository: file://../charts/demo\n'
    await write('a/tgt', text)
    expect(await copyChartDependencies('a/src', 'a/tgt')).toBe(false)
    expect(await fs.readFile(path.join(dir, 'a/tgt/Chart.yaml'), 'utf-8')).toBe(text)
  })

  it.each([
    ['keys in another order', 'dependencies:\n  - repository: file://../charts/demo\n    name: demo\n'],
    ['the same folder spelled another way', 'dependencies:\n  - name: demo\n    repository: file://../charts/demo/\n'],
  ])('the same dependencies with %s are not rewritten', async (_, deps) => {
    await write('a/src', { name: 'src', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    const text = `# keep me\nname: tgt\n${deps}`
    await write('a/tgt', text)
    expect(await copyChartDependencies('a/src', 'a/tgt')).toBe(false)
    expect(await fs.readFile(path.join(dir, 'a/tgt/Chart.yaml'), 'utf-8')).toBe(text)
  })

  it('an empty file:// path is copied as it is, not read as the source folder', async () => {
    await write('a/src', { name: 'src', dependencies: [{ name: 'x', repository: 'file://' }] })
    await write('b/tgt', { name: 'tgt' })
    await copyChartDependencies('a/src', 'b/tgt')
    expect((await read('b/tgt')).dependencies).toEqual([{ name: 'x', repository: 'file://' }])
  })

  // It used to become a bare `dependencies:` — no apiVersion, name or
  // version, so Helm could not load the target.
  it('a target Chart.yaml that is not a mapping is replaced by the source\'s, under the target\'s name', async () => {
    await write('a/src', { name: 'src', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    await write('a/tgt', 'just a string\n')
    await copyChartDependencies('a/src', 'a/tgt')
    expect(await read('a/tgt')).toEqual({ name: 'tgt', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
  })

  it('a new target gets the source\'s Chart.yaml under its own folder name', async () => {
    await write('a/src', { apiVersion: 'v2', name: 'src', version: '0.1.0', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    await fs.mkdir(path.join(dir, 'new'), { recursive: true })
    await copyChartDependencies('a/src', 'new')
    expect(await read('new')).toEqual({ apiVersion: 'v2', name: 'new', version: '0.1.0', dependencies: [{ name: 'demo', repository: 'file://../a/charts/demo' }] })
  })

  // It used to give the target none too: no longer a deployment, gone from
  // the tree and from every later sync.
  it('a source without dependencies is refused, and the target keeps its own', async () => {
    await write('a/src', { name: 'src' })
    await write('a/tgt', { name: 'tgt', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    await expect(copyChartDependencies('a/src', 'a/tgt')).rejects.toThrow('a/src cannot be copied: the source\'s Chart.yaml names no Template')
    expect(await read('a/tgt')).toEqual({ name: 'tgt', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
  })

  it('a source Chart.yaml that is not YAML is refused, and the target is not touched', async () => {
    await write('a/src', 'dependencies: [\n')
    await write('a/tgt', 'name: tgt\n')
    await expect(copyChartDependencies('a/src', 'a/tgt')).rejects.toThrow(/^a\/src cannot be copied: its Chart\.yaml or a\/tgt\/Chart\.yaml is not valid YAML/)
    expect(await fs.readFile(path.join(dir, 'a/tgt/Chart.yaml'), 'utf-8')).toBe('name: tgt\n')
  })
})

// Two ways a target lost its alerts.
describe('a target the source is copied to', () => {
  const src = { apiVersion: 'v2', name: 'src', version: '0.1.0', dependencies: [{ name: 'cpu', version: '>=0.0.0-0', repository: 'file://../charts/cpu' }] }

  it('whose Chart.yaml is not a mapping is made again from the source\'s, under its own name: a chart Helm can load', async () => {
    await write('src', src)
    await write('tgt', 'just a string\n')
    await copyChartDependencies('src', 'tgt')
    expect(await read('tgt')).toEqual({ ...src, name: 'tgt' })
  })

  it('keeps its Template when only routing is copied: the values that go with it are not', async () => {
    await write('src', src)
    await fs.writeFile(path.join(dir, 'src/values.yaml'), 'cpu: {}\n')
    const mem = { apiVersion: 'v2', name: 'tgt', version: '0.1.0', dependencies: [{ name: 'mem', version: '>=0.0.0-0', repository: 'file://../charts/mem' }] }
    await write('tgt', mem)
    await fs.writeFile(path.join(dir, 'tgt/values.yaml'), 'mem: {}\n')
    await copyTo('src', 'tgt', { values: false, routing: false })
    expect(await read('tgt')).toEqual(mem)
    // With the values, the Template moves too.
    await copyTo('src', 'tgt', { values: true, routing: false })
    expect((await read('tgt')).dependencies[0].name).toBe('cpu')
    expect(await fs.readFile(path.join(dir, 'tgt/values.yaml'), 'utf-8')).toBe('cpu: {}\n')
  })
})
