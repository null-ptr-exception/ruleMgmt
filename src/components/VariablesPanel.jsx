// Right-side panel for declaring template variables
// vars: [{ name, type, description, default, options }]
// onChange: (updatedVars) => void

function VarCard({ variable, index, onUpdate, onRemove }) {
  function update(field, val) {
    onUpdate(index, { ...variable, [field]: val })
  }

  return (
    <div className="var-card">
      <div className="var-card-header">
        <input
          className="var-card-name"
          value={variable.name}
          placeholder="variable_name"
          onChange={e => update('name', e.target.value)}
        />
        <select
          className={`var-type-badge type-${variable.type}`}
          value={variable.type}
          onChange={e => update('type', e.target.value)}
        >
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="list">list</option>
          <option value="boolean">boolean</option>
        </select>
        <button className="btn btn-ghost btn-icon var-card-remove" onClick={() => onRemove(index)} title="Remove">×</button>
      </div>
      <div className="var-card-field">
        <label>Description</label>
        <input
          type="text"
          value={variable.description}
          placeholder="What this variable controls"
          onChange={e => update('description', e.target.value)}
        />
      </div>
      <div className="var-card-field">
        <label>Default</label>
        <input
          type="text"
          value={variable.default}
          placeholder="Default value"
          onChange={e => update('default', e.target.value)}
        />
      </div>
      {variable.type === 'list' && (
        <div className="var-card-field">
          <label>Options (comma-separated)</label>
          <input
            type="text"
            value={Array.isArray(variable.options) ? variable.options.join(', ') : variable.options || ''}
            placeholder="opt1, opt2, opt3"
            onChange={e => update('options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
      )}
    </div>
  )
}

export default function VariablesPanel({ vars, onChange }) {
  function updateVar(index, updated) {
    const next = vars.map((v, i) => i === index ? updated : v)
    onChange(next)
  }

  function removeVar(index) {
    onChange(vars.filter((_, i) => i !== index))
  }

  function addVar() {
    onChange([...vars, { name: '', type: 'text', description: '', default: '' }])
  }

  return (
    <div className="vars-panel">
      <div className="vars-panel-header">Variables</div>
      <div className="vars-panel-list">
        {vars.map((v, i) => (
          <VarCard
            key={i}
            variable={v}
            index={i}
            onUpdate={updateVar}
            onRemove={removeVar}
          />
        ))}
        <button className="vars-panel-add" onClick={addVar}>+ Add Variable</button>
      </div>
    </div>
  )
}
