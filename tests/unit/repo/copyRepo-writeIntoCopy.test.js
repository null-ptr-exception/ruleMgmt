// A plan's files written into a copy of the repo (writeIntoCopy): each
// kind of entry the writer takes means the same in the copy.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { writeIntoCopy } from '../../../server/repo/copyRepo.js'

let work, root
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'write-into-copy-'))
  root = path.join(work, 'copy')
  fs.mkdirSync(root)
})
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }) })

describe('writeIntoCopy', () => {
  it('{ makeFolder: true } makes the folder, with the folders on the way', async () => {
    await writeIntoCopy(root, [{ rel: 'charts/demo/templates', makeFolder: true }])
    expect(fs.statSync(path.join(root, 'charts/demo/templates')).isDirectory()).toBe(true)
    expect(fs.readdirSync(path.join(root, 'charts/demo/templates'))).toEqual([])
  })

  it('{ makeFolder: true } leaves a folder that is there, and what it holds, as it is', async () => {
    fs.mkdirSync(path.join(root, 'charts/demo/templates'), { recursive: true })
    fs.writeFileSync(path.join(root, 'charts/demo/templates/cpu.yaml'), '# kept\n')
    await writeIntoCopy(root, [{ rel: 'charts/demo/templates', makeFolder: true }])
    expect(fs.readFileSync(path.join(root, 'charts/demo/templates/cpu.yaml'), 'utf-8')).toBe('# kept\n')
  })

  it('{ makeFolder: true } beside the other kinds, in order: a file, a folder, a file in it, a removal', async () => {
    fs.mkdirSync(path.join(root, 'old'))
    fs.writeFileSync(path.join(root, 'old/x.yaml'), 'x\n')
    await writeIntoCopy(root, [
      { rel: 'charts/demo/Chart.yaml', text: 'name: demo\n' },
      { rel: 'charts/demo/templates', makeFolder: true },
      { rel: 'charts/demo/templates/cpu.yaml', text: '# made\n' },
      { rel: 'old', removeFolder: true },
    ])
    expect(fs.readFileSync(path.join(root, 'charts/demo/Chart.yaml'), 'utf-8')).toBe('name: demo\n')
    expect(fs.readFileSync(path.join(root, 'charts/demo/templates/cpu.yaml'), 'utf-8')).toBe('# made\n')
    expect(fs.existsSync(path.join(root, 'old'))).toBe(false)
  })

  it('{ makeFolder: true } where a link leads out of the copy: refused, nothing made outside', async () => {
    const outside = path.join(work, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, 'charts'))
    await expect(writeIntoCopy(root, [{ rel: 'charts/demo/templates', makeFolder: true }])).rejects.toMatchObject({ outsideCopy: true })
    expect(fs.readdirSync(outside)).toEqual([])
  })
})
