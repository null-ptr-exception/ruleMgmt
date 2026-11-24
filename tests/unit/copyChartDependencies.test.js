import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { copyChartDependencies } from '../../server/lib/deploymentWrite.js'

let dir
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chart-deps-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function write(rel, doc) {
  await fs.mkdir(path.join(dir, rel), { recursive: true })
  await fs.writeFile(path.join(dir, rel, 'Chart.yaml'), typeof doc === 'string' ? doc : yaml.dump(doc))
}
const read = async rel => yaml.load(await fs.readFile(path.join(dir, rel, 'Chart.yaml'), 'utf-8'))

describe('copyChartDependencies', () => {
  it('only a relative file:// path is worked out again; other repositories are copied as they are', async () => {
    await write('a/src', { apiVersion: 'v2', name: 'src', version: '0.1.0', dependencies: [
      { name: 'demo', version: '1.0.0', repository: 'file://../../charts/demo', alias: 'x' },
      { name: 'abs', version: '1.0.0', repository: 'file:///srv/charts/abs' },
      { name: 'remote', version: '2.0.0', repository: 'https://charts.example.com' },
    ] })
    await write('a/b/tgt', { apiVersion: 'v2', name: 'tgt', version: '0.3.0' })
    expect(await copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'a/b/tgt'))).toBe(true)
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
    expect(await copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'a/tgt'))).toBe(false)
    expect(await fs.readFile(path.join(dir, 'a/tgt/Chart.yaml'), 'utf-8')).toBe(text)
  })

  it.each([
    ['keys in another order', 'dependencies:\n  - repository: file://../charts/demo\n    name: demo\n'],
    ['the same folder spelled another way', 'dependencies:\n  - name: demo\n    repository: file://../charts/demo/\n'],
  ])('the same dependencies with %s are not rewritten', async (_, deps) => {
    await write('a/src', { name: 'src', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    const text = `# keep me\nname: tgt\n${deps}`
    await write('a/tgt', text)
    expect(await copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'a/tgt'))).toBe(false)
    expect(await fs.readFile(path.join(dir, 'a/tgt/Chart.yaml'), 'utf-8')).toBe(text)
  })

  it('an empty file:// path is copied as it is, not read as the source folder', async () => {
    await write('a/src', { name: 'src', dependencies: [{ name: 'x', repository: 'file://' }] })
    await write('b/tgt', { name: 'tgt' })
    await copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'b/tgt'))
    expect((await read('b/tgt')).dependencies).toEqual([{ name: 'x', repository: 'file://' }])
  })

  it('a target Chart.yaml that is not a mapping is replaced by one, not spread into it', async () => {
    await write('a/src', { name: 'src', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    await write('a/tgt', 'just a string\n')
    await copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'a/tgt'))
    expect(await read('a/tgt')).toEqual({ dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
  })

  it('a new target gets the source\'s Chart.yaml under its own folder name', async () => {
    await write('a/src', { apiVersion: 'v2', name: 'src', version: '0.1.0', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    await fs.mkdir(path.join(dir, 'new'), { recursive: true })
    await copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'new'))
    expect(await read('new')).toEqual({ apiVersion: 'v2', name: 'new', version: '0.1.0', dependencies: [{ name: 'demo', repository: 'file://../a/charts/demo' }] })
  })

  it('a source without dependencies leaves the target with none', async () => {
    await write('a/src', { name: 'src' })
    await write('a/tgt', { name: 'tgt', dependencies: [{ name: 'demo', repository: 'file://../charts/demo' }] })
    await copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'a/tgt'))
    expect(await read('a/tgt')).toEqual({ name: 'tgt', dependencies: [] })
  })

  it('a source Chart.yaml that is not YAML throws, and the target is not touched', async () => {
    await write('a/src', 'dependencies: [\n')
    await write('a/tgt', 'name: tgt\n')
    await expect(copyChartDependencies(path.join(dir, 'a/src'), path.join(dir, 'a/tgt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, 'a/tgt/Chart.yaml'), 'utf-8')).toBe('name: tgt\n')
  })
})
