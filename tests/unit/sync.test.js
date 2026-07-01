import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import {
  readSyncRegistry,
  writeSyncRegistry,
  getTargetsForSource,
  getSourceForTarget,
  isSource,
  isTarget,
  isSafeSyncPath,
  applySync,
  applyUnlink,
} from '../../server/lib/sync.js'

describe('sync registry file I/O', () => {
  let tmpDir
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('returns an empty registry when sync.yaml does not exist', async () => {
    expect(await readSyncRegistry(tmpDir)).toEqual({ syncs: [] })
  })

  it('round-trips a registry through write then read', async () => {
    const registry = { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] }
    await writeSyncRegistry(tmpDir, registry)
    expect(await readSyncRegistry(tmpDir)).toEqual(registry)
  })

  it('tolerates a malformed sync.yaml (no syncs key)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'sync.yaml'), yaml.dump({ other: 'stuff' }))
    expect(await readSyncRegistry(tmpDir)).toEqual({ syncs: [] })
  })
})

describe('registry queries', () => {
  const registry = {
    syncs: [
      { source: 'cpu/prod', targets: ['cpu/staging', 'cpu/dev'] },
      { source: 'cpu/qa', targets: ['cpu/hotfix'] },
    ],
  }

  it('getTargetsForSource returns the targets array', () => {
    expect(getTargetsForSource(registry, 'cpu/prod')).toEqual(['cpu/staging', 'cpu/dev'])
  })

  it('getTargetsForSource returns [] for a non-source', () => {
    expect(getTargetsForSource(registry, 'cpu/dev')).toEqual([])
  })

  it('getSourceForTarget returns the source path', () => {
    expect(getSourceForTarget(registry, 'cpu/staging')).toBe('cpu/prod')
  })

  it('getSourceForTarget returns null when not synced', () => {
    expect(getSourceForTarget(registry, 'cpu/nope')).toBe(null)
  })

  it('isSource is true only for entries with 1+ targets', () => {
    expect(isSource(registry, 'cpu/prod')).toBe(true)
    expect(isSource(registry, 'cpu/staging')).toBe(false)
  })

  it('isTarget is true only for deployments listed as a target', () => {
    expect(isTarget(registry, 'cpu/staging')).toBe(true)
    expect(isTarget(registry, 'cpu/prod')).toBe(false)
  })
})

describe('isSafeSyncPath', () => {
  it('accepts a plain nested path', () => {
    expect(isSafeSyncPath('cpu/prod', 'charts')).toBe(true)
  })

  it('rejects paths containing ..', () => {
    expect(isSafeSyncPath('cpu/../../etc', 'charts')).toBe(false)
  })

  it('rejects absolute paths', () => {
    expect(isSafeSyncPath('/etc/passwd', 'charts')).toBe(false)
  })

  it('rejects a path rooted at the charts directory', () => {
    expect(isSafeSyncPath('charts/mychart', 'charts')).toBe(false)
  })

  it('respects a custom CHARTS_DIR name', () => {
    expect(isSafeSyncPath('templates/mychart', 'templates')).toBe(false)
    expect(isSafeSyncPath('templates/mychart', 'charts')).toBe(true)
  })

  it('rejects non-string input', () => {
    expect(isSafeSyncPath(null, 'charts')).toBe(false)
    expect(isSafeSyncPath(undefined, 'charts')).toBe(false)
  })
})

describe('applySync', () => {
  it('creates a new source entry and adds the target', () => {
    const registry = { syncs: [] }
    const result = applySync(registry, 'cpu/prod', 'cpu/staging')
    expect(result).toEqual({ ok: true })
    expect(registry.syncs).toEqual([{ source: 'cpu/prod', targets: ['cpu/staging'] }])
  })

  it('adds a second target to an existing source', () => {
    const registry = { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] }
    applySync(registry, 'cpu/prod', 'cpu/canary')
    expect(registry.syncs).toEqual([{ source: 'cpu/prod', targets: ['cpu/staging', 'cpu/canary'] }])
  })

  it('is a no-op when the target already syncs from this source', () => {
    const registry = { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] }
    const result = applySync(registry, 'cpu/prod', 'cpu/staging')
    expect(result).toEqual({ ok: true })
    expect(registry.syncs).toEqual([{ source: 'cpu/prod', targets: ['cpu/staging'] }])
  })

  it('rejects syncing a deployment to itself', () => {
    const registry = { syncs: [] }
    const result = applySync(registry, 'cpu/prod', 'cpu/prod')
    expect(result.ok).toBe(false)
  })

  it('rejects making an existing source into a target', () => {
    const registry = {
      syncs: [
        { source: 'cpu/prod', targets: ['cpu/staging'] },
        { source: 'cpu/qa', targets: ['cpu/hotfix'] },
      ],
    }
    // cpu/qa already has its own targets — it can't become a target of prod
    const result = applySync(registry, 'cpu/prod', 'cpu/qa')
    expect(result.ok).toBe(false)
    expect(registry.syncs).toEqual([
      { source: 'cpu/prod', targets: ['cpu/staging'] },
      { source: 'cpu/qa', targets: ['cpu/hotfix'] },
    ])
  })

  it('rejects making an existing target into a source', () => {
    const registry = { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] }
    // cpu/staging is already a target — it can't become a source for cpu/dev
    const result = applySync(registry, 'cpu/staging', 'cpu/dev')
    expect(result.ok).toBe(false)
  })

  it('switching source: removes the target from its old source and adds it to the new one', () => {
    const registry = {
      syncs: [
        { source: 'cpu/qa', targets: ['cpu/hotfix'] },
        { source: 'cpu/prod', targets: ['cpu/staging'] },
      ],
    }
    const result = applySync(registry, 'cpu/prod', 'cpu/hotfix')
    expect(result).toEqual({ ok: true })
    expect(getTargetsForSource(registry, 'cpu/qa')).toEqual([])
    expect(getTargetsForSource(registry, 'cpu/prod')).toEqual(['cpu/staging', 'cpu/hotfix'])
    // qa's entry should be pruned entirely since it has zero targets left
    expect(registry.syncs.find(s => s.source === 'cpu/qa')).toBeUndefined()
  })
})

describe('applyUnlink', () => {
  it('removes a target and prunes the source entry when it hits zero targets', () => {
    const registry = { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] }
    const result = applyUnlink(registry, 'cpu/staging')
    expect(result).toEqual({ ok: true })
    expect(registry.syncs).toEqual([])
  })

  it('keeps the source entry when other targets remain', () => {
    const registry = { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging', 'cpu/dev'] }] }
    applyUnlink(registry, 'cpu/staging')
    expect(registry.syncs).toEqual([{ source: 'cpu/prod', targets: ['cpu/dev'] }])
  })

  it('errors when the target is not currently synced', () => {
    const registry = { syncs: [] }
    const result = applyUnlink(registry, 'cpu/dev')
    expect(result.ok).toBe(false)
  })
})
