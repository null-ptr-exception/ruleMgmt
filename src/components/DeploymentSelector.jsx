import { useState } from 'react'

export default function DeploymentSelector({ deployments, activeDeployment, onSelect, onCreate, onClone }) {
  const [mode, setMode]         = useState(null) // null | 'new' | 'clone'
  const [newName, setNewName]   = useState('')
  const [cloneSource, setCloneSource] = useState('')

  const reset = () => { setMode(null); setNewName(''); setCloneSource('') }

  const handleCreate = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    onCreate(trimmed)
    reset()
  }

  const handleClone = () => {
    const trimmed = newName.trim()
    if (!trimmed || !cloneSource) return
    onClone(cloneSource, trimmed)
    reset()
  }

  return (
    <div className="deploy-selector">
      {deployments.map(d => (
        <div
          key={d.name}
          className={`deploy-selector-item${d.name === activeDeployment ? ' active' : ''}`}
          onClick={() => onSelect(d.name)}
        >
          <span className="deploy-selector-icon">📁</span>
          <span className="deploy-selector-name">{d.name}</span>
          <span className="deploy-selector-badge">{d.alertCount}</span>
        </div>
      ))}

      <div className="deploy-selector-actions">
        {mode === null && (
          <>
            <button className="btn btn-sm btn-secondary" onClick={() => setMode('new')}>+ New</button>
            <button className="btn btn-sm btn-secondary" onClick={() => { setMode('clone'); setCloneSource(deployments[0]?.name || '') }}>Clone</button>
          </>
        )}
      </div>

      {mode === 'new' && (
        <div className="deploy-selector-form">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New deployment name"
            autoFocus
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button className="btn btn-sm btn-primary" onClick={handleCreate} disabled={!newName.trim()}>OK</button>
            <button className="btn btn-sm btn-ghost" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'clone' && (
        <div className="deploy-selector-form">
          <select
            value={cloneSource}
            onChange={e => setCloneSource(e.target.value)}
            style={{ marginBottom: 4 }}
          >
            {deployments.map(d => (
              <option key={d.name} value={d.name}>{d.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New deployment name"
            autoFocus
            onKeyDown={e => e.key === 'Enter' && handleClone()}
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button className="btn btn-sm btn-primary" onClick={handleClone} disabled={!newName.trim() || !cloneSource}>OK</button>
            <button className="btn btn-sm btn-ghost" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
