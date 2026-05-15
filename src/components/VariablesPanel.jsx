import { Card, Input, Select, Button, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

const { Text } = Typography

function VarCard({ variable, index, onUpdate, onRemove }) {
  function update(field, val) {
    onUpdate(index, { ...variable, [field]: val })
  }

  return (
    <Card size="small" style={{ marginBottom: 10 }} styles={{ body: { padding: 12 } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Input
          value={variable.name}
          placeholder="variable_name"
          onChange={e => update('name', e.target.value)}
          variant="borderless"
          style={{ fontWeight: 600, fontSize: 14, flex: 1, padding: 0 }}
        />
        <Select
          value={variable.type}
          onChange={val => update('type', val)}
          size="small"
          style={{ width: 90 }}
          options={[
            { value: 'text', label: 'text' },
            { value: 'number', label: 'number' },
            { value: 'list', label: 'list' },
            { value: 'boolean', label: 'boolean' },
          ]}
        />
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => onRemove(index)} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>Description</Text>
        <Input
          size="small"
          value={variable.description}
          placeholder="What this variable controls"
          onChange={e => update('description', e.target.value)}
        />
      </div>
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>Default</Text>
        <Input
          size="small"
          value={variable.default}
          placeholder="Default value"
          onChange={e => update('default', e.target.value)}
        />
      </div>
      {variable.type === 'list' && (
        <div>
          <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>Options (comma-separated)</Text>
          <Input
            size="small"
            value={Array.isArray(variable.options) ? variable.options.join(', ') : variable.options || ''}
            placeholder="opt1, opt2, opt3"
            onChange={e => update('options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
      )}
    </Card>
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
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: '1px solid #f0f0f0', width: 340, flexShrink: 0 }}>
      <div style={{ padding: '10px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c', borderBottom: '1px solid #f0f0f0', fontWeight: 600 }}>
        Variables
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {vars.map((v, i) => (
          <VarCard
            key={i}
            variable={v}
            index={i}
            onUpdate={updateVar}
            onRemove={removeVar}
          />
        ))}
        <Button type="dashed" block icon={<PlusOutlined />} onClick={addVar}>
          Add Variable
        </Button>
      </div>
    </div>
  )
}
