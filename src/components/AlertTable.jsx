import { useCallback } from 'react'

// Editable table for alert instances, columns driven by template variable declarations
export default function AlertTable({ vars = [], rows = [], onUpdate, onDelete, onAdd }) {
  const handleCellChange = useCallback((rowIdx, varName, value) => {
    const updated = rows.map((r, i) =>
      i === rowIdx ? { ...r, [varName]: value } : r
    )
    onUpdate(updated)
  }, [rows, onUpdate])

  const handleAdd = useCallback(() => {
    const newRow = {}
    vars.forEach(v => {
      newRow[v.name] = v.default ?? (v.type === 'boolean' ? false : v.type === 'number' ? 0 : '')
    })
    onAdd(newRow)
  }, [vars, onAdd])

  const colCount = vars.length + 1 // +1 for actions

  const typeClass = (type) => {
    if (type === 'number') return 'col-number'
    return 'col-text'
  }

  const renderInput = (v, row, rowIdx) => {
    const val = row[v.name]
    switch (v.type) {
      case 'boolean':
        return (
          <input
            type="checkbox"
            checked={!!val}
            onChange={e => handleCellChange(rowIdx, v.name, e.target.checked)}
          />
        )
      case 'number':
        return (
          <input
            type="number"
            step="any"
            className="input-number"
            value={val ?? ''}
            onChange={e => handleCellChange(rowIdx, v.name, e.target.value === '' ? '' : Number(e.target.value))}
          />
        )
      case 'list':
        return (
          <select
            value={val ?? ''}
            onChange={e => handleCellChange(rowIdx, v.name, e.target.value)}
          >
            {(v.options || []).map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        )
      default: // text
        return (
          <input
            type="text"
            className="input-text"
            value={val ?? ''}
            onChange={e => handleCellChange(rowIdx, v.name, e.target.value)}
          />
        )
    }
  }

  return (
    <div className="alert-table-container">
      <table className="alert-table">
        <thead>
          <tr>
            {vars.map(v => (
              <th key={v.name} className={typeClass(v.type)} title={v.description || ''}>
                {v.name}
              </th>
            ))}
            <th className="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="alert-table-empty">
                No alert instances
              </td>
            </tr>
          ) : (
            rows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                {vars.map(v => (
                  <td key={v.name}>{renderInput(v, row, rowIdx)}</td>
                ))}
                <td>
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => onDelete(rowIdx)}
                    title="Delete"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="alert-table-footer">
        <button className="btn btn-ghost btn-sm" onClick={handleAdd}>+ Add Row</button>
      </div>
    </div>
  )
}
