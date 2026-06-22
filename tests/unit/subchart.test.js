import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { getDepName, wrapValues, unwrapValues, countAlerts } from '../../server/lib/subchart.js'

const BARE = {
  _common: { owner: 'app-a', namespace: 'prod' },
  latency: [{ warn: 1, crit: 5 }, { warn: 2, crit: 10 }],
  traffic: [{ qps: 50 }],
}

describe('subchart helper', () => {
  describe('getDepName', () => {
    let tmpDir
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subchart-')) })
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

    it('returns the first dependency name', async () => {
      fs.writeFileSync(path.join(tmpDir, 'Chart.yaml'), yaml.dump({
        apiVersion: 'v2', name: 'd', version: '1.0.0',
        dependencies: [{ name: 'mariadb-alerts', version: '2.0.0' }],
      }))
      expect(await getDepName(tmpDir)).toBe('mariadb-alerts')
    })

    it('returns null when there is no Chart.yaml', async () => {
      expect(await getDepName(tmpDir)).toBe(null)
    })

    it('returns null when Chart.yaml has no dependencies', async () => {
      fs.writeFileSync(path.join(tmpDir, 'Chart.yaml'), yaml.dump({ apiVersion: 'v2', name: 'd', version: '1.0.0' }))
      expect(await getDepName(tmpDir)).toBe(null)
    })
  })

  describe('wrapValues / unwrapValues', () => {
    it('wraps bare values under the dependency name', () => {
      expect(wrapValues(BARE, 'mariadb-alerts')).toEqual({ 'mariadb-alerts': BARE })
    })

    it('leaves values bare when there is no dependency name', () => {
      expect(wrapValues(BARE, null)).toEqual(BARE)
    })

    it('unwraps the subchart key back to bare values', () => {
      expect(unwrapValues({ 'mariadb-alerts': BARE }, 'mariadb-alerts')).toEqual(BARE)
    })

    it('returns legacy bare values untouched when the dep key is absent', () => {
      expect(unwrapValues(BARE, 'mariadb-alerts')).toEqual(BARE)
    })

    it('round-trips: unwrap(wrap(x)) === x', () => {
      expect(unwrapValues(wrapValues(BARE, 'mariadb-alerts'), 'mariadb-alerts')).toEqual(BARE)
    })
  })

  describe('countAlerts', () => {
    it('counts top-level arrays after unwrapping wrapped values', () => {
      expect(countAlerts({ 'mariadb-alerts': BARE }, 'mariadb-alerts')).toBe(3)
    })

    it('counts legacy bare values (dep key absent)', () => {
      expect(countAlerts(BARE, 'mariadb-alerts')).toBe(3)
    })

    it('ignores non-array keys such as _common', () => {
      expect(countAlerts({ 'mariadb-alerts': { _common: { x: 1 }, a: [{}, {}] } }, 'mariadb-alerts')).toBe(2)
    })

    it('returns 0 for empty values', () => {
      expect(countAlerts({}, 'mariadb-alerts')).toBe(0)
      expect(countAlerts(null, null)).toBe(0)
    })
  })
})
