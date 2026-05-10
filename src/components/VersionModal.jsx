import { useState } from 'react'
import { isValidVersion } from '../utils/templateUtils'

export default function VersionModal({ defaultName, defaultVersion, onSave, onCancel }) {
  const hasName = defaultName !== undefined
  const [name, setName]       = useState(defaultName || '')
  const [version, setVersion] = useState(defaultVersion || 'v1.0.0')
  const valid = isValidVersion(version) && (!hasName || name.trim())

  const doSave = () => hasName ? onSave(name.trim(), version) : onSave(version)

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Save as Version</h3>
        {hasName && (
          <div className="form-row">
            <label>Instance Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. platform-infra"
              autoFocus
            />
            {!name.trim() && <span style={{ color: '#dc2626', fontSize: 12 }}>Name is required</span>}
          </div>
        )}
        <div className="form-row">
          <label>Version (e.g. v1.0.0)</label>
          <input
            type="text"
            value={version}
            onChange={e => setVersion(e.target.value)}
            placeholder="v1.0.0"
            autoFocus={!hasName}
          />
          {!valid && version && !isValidVersion(version) && (
            <span style={{ color: '#dc2626', fontSize: 12 }}>Must be in format v{'{major}'}.{'{minor}'}.{'{patch}'}</span>
          )}
        </div>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!valid} onClick={doSave}>Save</button>
        </div>
      </div>
    </div>
  )
}
