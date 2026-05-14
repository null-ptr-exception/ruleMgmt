import { useState } from 'react'

export default function ChartSelector({ charts, activeChart, onSelect, onCreate }) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName]   = useState('')

  const handleCreate = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    onCreate(trimmed)
    setNewName('')
    setCreating(false)
  }

  return (
    <div className="chart-selector">
      <span className="chart-selector-label">Chart</span>
      <div className="chart-selector-row">
        <select
          value={activeChart || ''}
          onChange={e => onSelect(e.target.value)}
          style={{ flex: 1 }}
        >
          {charts.map(c => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.templateCount} templates)
            </option>
          ))}
        </select>
        {!creating && (
          <button className="btn btn-sm btn-secondary" onClick={() => setCreating(true)}>
            + New
          </button>
        )}
      </div>
      {creating && (
        <div className="chart-selector-row" style={{ marginTop: 6 }}>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New chart name"
            autoFocus
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            style={{ flex: 1 }}
          />
          <button className="btn btn-sm btn-primary" onClick={handleCreate} disabled={!newName.trim()}>
            Create
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setCreating(false); setNewName('') }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
