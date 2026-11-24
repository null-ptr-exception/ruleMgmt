// A file deleted and written again while it is read (a git checkout or
// pull) is either there or not — never "a link to a file that is not there",
// which only a link to nothing is.
import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { readTextIfThere } from '../../server/lib/readIfThere.js'

const WRITER = `
const fs = require('fs'); const f = process.argv[1]; const end = Date.now() + 3000
while (Date.now() < end) { try { fs.unlinkSync(f) } catch {} fs.writeFileSync(f, 'a: 1\\n') }
`

describe('readTextIfThere on a file being written again', () => {
  it('reads it or finds it absent, and never calls it a link to nothing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-race-'))
    const file = path.join(dir, 'values.yaml')
    const writer = spawn(process.execPath, ['-e', WRITER, file], { stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 200))
      const tally = { text: 0, absent: 0, thrown: [] }
      for (let i = 0; i < 3000; i++) {
        try {
          const text = await readTextIfThere(file)
          if (text === null) tally.absent++
          else tally.text++
        } catch (err) {
          tally.thrown.push(err.message)
        }
      }
      expect(tally.thrown.slice(0, 3)).toEqual([])
      expect(tally.text).toBeGreaterThan(0)
    } finally {
      writer.kill()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a link to nothing is still named', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-race-'))
    await fs.symlink(path.join(dir, 'nowhere.yaml'), path.join(dir, 'values.yaml'))
    await expect(readTextIfThere(path.join(dir, 'values.yaml'))).rejects.toThrow('a link to a file that is not there')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
