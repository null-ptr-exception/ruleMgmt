import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { amtoolStatus } from '../blind/harness.js'

/**
 * The amtool the routing tests check the save against: 0.28 or later, the
 * first to read a webhook's timeout, from the Alertmanager release checked
 * against its checksum, as helm is — not copied out of an image.
 */

const read = rel => fs.readFileSync(path.resolve(rel), 'utf-8')

describe('the pinned amtool', () => {
  const script = read('scripts/install-checkers.sh')
  const version = /^ALERTMANAGER_VERSION=(\S+)$/m.exec(script)?.[1]

  it('install-checkers.sh pins 0.28 or later, with the release tarball\'s sha256', () => {
    expect(version).toMatch(/^0\.(2[89]|[3-9]\d)\.\d+$/)
    expect(script).toMatch(/^ALERTMANAGER_SHA256=[0-9a-f]{64}$/m)
    expect(script).toContain('https://github.com/prometheus/alertmanager/releases/download/v$ALERTMANAGER_VERSION/$AM.tar.gz')
    expect(script).toContain('echo "$ALERTMANAGER_SHA256  $DL_TMP/am.tar.gz" | sha256sum -c -')
    expect(script).not.toContain('prom/alertmanager')
  })

  it('CI checks the amtool it runs is that version', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain(`amtool --version 2>&1 | grep -q "version $(sed -n 's/^ALERTMANAGER_VERSION=//p' scripts/install-checkers.sh) "`)
  })
})

// The tests skip, saying why, under an amtool older than 0.28: it refuses
// every config with a webhook timeout, which would read as the save being
// wrong.
describe('the amtool the tests find', () => {
  const withAmtool = (script, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-amtool-'))
    const saved = process.env.PATH
    try {
      if (script) fs.writeFileSync(path.join(dir, 'amtool'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
      process.env.PATH = script ? `${dir}:${saved}` : dir
      return fn()
    } finally {
      process.env.PATH = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('is used from 0.28 on', () => {
    expect(withAmtool('echo "amtool, version 0.28.1 (branch: HEAD)"', amtoolStatus)).toEqual({ ok: true, version: '0.28.1' })
    expect(withAmtool('echo "amtool, version 1.0.0 (branch: HEAD)"', amtoolStatus).ok).toBe(true)
  })

  it('is not used when older, saying which version is needed', () => {
    // 0.27 prints its version on stderr.
    expect(withAmtool('echo "amtool, version 0.27.0 (branch: HEAD)" >&2', amtoolStatus))
      .toEqual({ ok: false, why: "amtool 0.27.0 is older than 0.28, which the tests need (it reads a webhook's timeout) — install the version in scripts/install-checkers.sh" })
  })

  it('is not used when missing', () => {
    expect(withAmtool(null, amtoolStatus)).toEqual({ ok: false, why: 'amtool not found' })
  })
})
