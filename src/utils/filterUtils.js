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
