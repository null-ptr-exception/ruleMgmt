export const NUM_OPERATORS = ['>=', '<=', '>', '<', '=']
export const STR_OPERATORS = ['contains', '=']

/** Returns the operator list for a given var definition. Used by both FilterHeader and WorkspaceFilterBar. */
export function getFilterOperators(varDef) {
  if (!varDef) return STR_OPERATORS
  if (varDef.type === 'number' || varDef.type === 'integer') return NUM_OPERATORS
  if (varDef.type === 'enum') return typeof varDef.enum?.[0] === 'number' ? NUM_OPERATORS : ['=']
  return STR_OPERATORS
}

/**
 * Merge workspace-level and section-level filters.
 * Section filters take precedence over workspace filters for the same key.
 * Empty-value section entries are skipped (treated as cleared).
 */
export function mergeFilters(wsFilters, sectionFilters) {
  const merged = { ...wsFilters }
  Object.entries(sectionFilters).forEach(([k, v]) => {
    if (v && v.value !== '' && v.value != null) merged[k] = v
  })
  return merged
}

export function matchesFilter(row, filters, vars, commonValues = {}) {
  return Object.entries(filters).every(([varName, filter]) => {
    if (!filter || filter.value === '' || filter.value == null) return true
    const v = vars.find(v => v.name === varName)
    const cellVal = varName in commonValues ? commonValues[varName] : row[varName]
    if (v && (v.type === 'number' || v.type === 'integer' || (v.type === 'enum' && typeof v.enum?.[0] === 'number'))) {
      const num = parseFloat(cellVal)
      const fnum = parseFloat(filter.value)
      if (isNaN(num) || isNaN(fnum)) return false
      switch (filter.op) {
        case '>=': return num >= fnum
        case '<=': return num <= fnum
        case '>':  return num > fnum
        case '<':  return num < fnum
        case '=':  return num === fnum
        default:   return true
      }
    }
    const cell = String(cellVal ?? '').toLowerCase()
    const val = String(filter.value).toLowerCase()
    return filter.op === '=' ? cell === val : cell.includes(val)
  })
}
