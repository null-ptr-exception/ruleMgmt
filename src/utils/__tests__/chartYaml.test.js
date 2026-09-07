import { describe, it, expect } from 'vitest'
import { ensureChartYaml } from '../chartYaml.js'

describe('ensureChartYaml', () => {
  it('creates a minimal Chart.yaml when there is none', () => {
    const { text, created } = ensureChartYaml(null, 'mariadb-alerts')
    expect(created).toBe(true)
    expect(text).toContain('name: mariadb-alerts')
    expect(text).toContain('apiVersion: v2')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('leaves an existing file untouched', () => {
    const existing = 'apiVersion: v2\nname: keep-me\nversion: 9.9.9\n'
    const { text, created } = ensureChartYaml(existing, 'other')
    expect(created).toBe(false)
    expect(text).toBe(existing)
  })

  it('treats a whitespace-only file as empty', () => {
    expect(ensureChartYaml('   \n', 'x').created).toBe(true)
  })
})
