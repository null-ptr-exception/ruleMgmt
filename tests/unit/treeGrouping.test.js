import { describe, it, expect } from 'vitest'
import { buildTree } from '../../src/utils/treeGrouping.js'

describe('buildTree', () => {
  it('returns empty array for no names', () => {
    expect(buildTree([])).toEqual([])
  })

  it('returns single leaf for one name', () => {
    expect(buildTree(['foo'])).toEqual([
      { label: 'foo', fullName: 'foo' },
    ])
  })

  it('returns flat leaves when no shared prefix', () => {
    const result = buildTree(['alpha', 'beta', 'gamma'])
    expect(result).toEqual([
      { label: 'alpha', fullName: 'alpha' },
      { label: 'beta', fullName: 'beta' },
      { label: 'gamma', fullName: 'gamma' },
    ])
  })

  it('groups items with shared underscore prefix', () => {
    const result = buildTree(['kpi_cpu', 'kpi_mem'])
    expect(result).toEqual([
      {
        label: 'kpi',
        children: [
          { label: 'cpu', fullName: 'kpi_cpu' },
          { label: 'mem', fullName: 'kpi_mem' },
        ],
      },
    ])
  })

  it('does not group single-item prefixes', () => {
    const result = buildTree(['kpi_cpu', 'kpi_mem', 'flip_isalive'])
    const flip = result.find(n => n.label === 'flip_isalive')
    expect(flip).toEqual({ label: 'flip_isalive', fullName: 'flip_isalive' })
  })

  it('matches demo-app template structure', () => {
    const result = buildTree([
      'flip_isalive',
      'kpi_cpu_saturation',
      'kpi_mem_saturation',
    ])
    expect(result).toHaveLength(2)

    const flip = result.find(n => n.label === 'flip_isalive')
    expect(flip.fullName).toBe('flip_isalive')

    const kpi = result.find(n => n.label === 'kpi')
    expect(kpi.children).toHaveLength(2)
    expect(kpi.children.map(c => c.fullName).sort()).toEqual([
      'kpi_cpu_saturation',
      'kpi_mem_saturation',
    ])
  })

  it('preserves fullName through nested grouping', () => {
    const result = buildTree(['a_b_c', 'a_b_d'])
    const group = result[0]
    expect(group.label).toBe('a')
    const leaves = group.children[0].children || [group.children[0]]
    for (const leaf of leaves) {
      expect(leaf.fullName).toMatch(/^a_b_/)
    }
  })
})
