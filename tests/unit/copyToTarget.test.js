// A copy to a sync target that fails part way leaves the target as it was:
// its Template, its values and its routing, and no file it did not have.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { copyToTarget } from '../../server/lib/deploymentWrite.js'

// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let dir, errors
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-to-target-'))
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  errors.mockRestore()
  await fs.chmod(path.join(dir, 'tgt', 'templates'), 0o755).catch(() => {})
  await fs.rm(dir, { recursive: true, force: true })
})

const chart = tmpl => `apiVersion: v2\nname: x\nversion: 0.1.0\ndependencies:\n  - name: ${tmpl}\n    version: 0.1.0\n    repository: file://../charts/${tmpl}\n`
async function put(rel, text) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  await fs.writeFile(path.join(dir, rel), text)
}
// Every file under the target, with its text.
async function files(rel) {
  const out = {}
  async function walk(d) {
    for (const e of await fs.readdir(path.join(dir, d), { withFileTypes: true }).catch(() => [])) {
      const p = `${d}/${e.name}`
      if (e.isDirectory()) await walk(p)
      else out[p] = await fs.readFile(path.join(dir, p), 'utf-8')
    }
  }
  await walk(rel)
  return out
}

beforeEach(async () => {
  await put('src/Chart.yaml', chart('cpu'))
  await put('src/values.yaml', 'cpu:\n  cpu: [{namespace: p}]\n')
  await put('src/routing.yaml', 'labels: {}\n')
  await put('src/templates/alertmanagerconfig.yaml', '# the resource\n')
})

describe.skipIf(IS_ROOT)('a copy whose routing cannot be written', () => {
  it('leaves a target on another Template with its own Template and values', async () => {
    await put('tgt/Chart.yaml', chart('mem'))
    await put('tgt/values.yaml', 'mem:\n  mem: [{namespace: q}]\n')
    await fs.mkdir(path.join(dir, 'tgt/templates'))
    const before = await files('tgt')
    await fs.chmod(path.join(dir, 'tgt/templates'), 0o555)

    await expect(copyToTarget(path.join(dir, 'src'), path.join(dir, 'tgt'))).rejects.toMatchObject({ code: 'EACCES' })

    expect(await files('tgt')).toEqual(before)
  })

  it('takes out the files it made in a folder that had none', async () => {
    await fs.mkdir(path.join(dir, 'tgt/templates'), { recursive: true })
    await fs.chmod(path.join(dir, 'tgt/templates'), 0o555)

    await expect(copyToTarget(path.join(dir, 'src'), path.join(dir, 'tgt'))).rejects.toMatchObject({ code: 'EACCES' })

    expect(await files('tgt')).toEqual({})
  })
})
