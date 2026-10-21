import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { writeRouting, readRouting, ROUTING_FILE } from '../../server/lib/routingFiles.js'

describe('writeRouting', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('writes both files and leaves no temp file behind', async () => {
    await writeRouting(dir, { text: 'labels: {}\n', cr: 'kind: AlertmanagerConfig\n' })
    expect(await readRouting(dir)).toEqual({ text: 'labels: {}\n', cr: 'kind: AlertmanagerConfig\n' })
    expect(fs.readdirSync(dir).sort()).toEqual([ROUTING_FILE, 'templates'])
    expect(fs.readdirSync(path.join(dir, 'templates'))).toEqual(['alertmanagerconfig.yaml'])
  })

  it('puts both files back when the second write fails', async () => {
    await writeRouting(dir, { text: 'old\n', cr: 'old cr\n' })
    // routing.yaml is written first; the CR's temp file then cannot be made.
    fs.chmodSync(path.join(dir, 'templates'), 0o500)
    try {
      await expect(writeRouting(dir, { text: 'new\n', cr: 'new cr\n' })).rejects.toThrow()
    } finally {
      fs.chmodSync(path.join(dir, 'templates'), 0o700)
    }
    expect(await readRouting(dir)).toEqual({ text: 'old\n', cr: 'old cr\n' })
    expect(fs.readdirSync(dir).sort()).toEqual([ROUTING_FILE, 'templates'])
  })
})
