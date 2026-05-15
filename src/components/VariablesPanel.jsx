import { useState, useEffect } from 'react'
import { Card, Input, Select, Button, Checkbox, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

const { Text } = Typography

const TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'integer', label: 'integer' },
  { value: 'boolean', label: 'boolean' },
]

export default function VariablesPanel({ vars, onChange, schema, onSchemaChange }) {
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState('')

  useEffect(() => {
    if (rawMode && schema) {
      setRawText(JSON.stringify(schema, null, 2))
    }
  }, [rawMode, schema])

  function handleRawSave() {
    try {
      const parsed = JSON.parse(rawText)
      onSchemaChange(parsed)
    } catch { /* invalid JSON, ignore */ }
  }

  function updateVar(index, field, value) {
    const updated = vars.map((v, i) => i === index ? { ...v, [field]: value } : v)
    onChange(updated)
  }

  function addVar() {
    onChange([...vars, { name: '', type: 'string', description: '', required: false }])
  }

  function removeVar(index) {
    onChange(vars.filter((_, i) => i !== index))
  }

  if (rawMode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid #f0f0f0' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c' }}>
            values.schema.json
          </Text>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="small" type="primary" onClick={handleRawSave}>Apply</Button>
            <Button size="small" onClick={() => setRawMode(false)}>Visual</Button>
          </div>
        </div>
        <textarea
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          style={{
            flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 12,
            border: 'none', outline: 'none', resize: 'none', background: '#fafafa'
          }}
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid #f0f0f0' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c' }}>
          Variables
        </Text>
        <Button size="small" onClick={() => setRawMode(true)}>Raw</Button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {vars.map((v, i) => (
          <Card key={i} size="small" style={{ marginBottom: 10 }} styles={{ body: { padding: 12 } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Input size="small" placeholder="name" value={v.name}
                onChange={e => updateVar(i, 'name', e.target.value)} style={{ flex: 1, fontWeight: 600 }} />
              <Select size="small" value={v.type} options={TYPE_OPTIONS} style={{ width: 90 }}
                onChange={val => updateVar(i, 'type', val)} />
              <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeVar(i)} />
            </div>
            <Input size="small" placeholder="description" value={v.description || ''}
              onChange={e => updateVar(i, 'description', e.target.value)} style={{ marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input size="small" placeholder="default" value={v.default ?? ''}
                onChange={e => updateVar(i, 'default', e.target.value)} style={{ flex: 1 }} />
              <Checkbox checked={!!v.required} onChange={e => updateVar(i, 'required', e.target.checked)}>
                <Text style={{ fontSize: 11 }}>Required</Text>
              </Checkbox>
            </div>
            {v.type === 'string' && (
              <Input size="small" placeholder="enum values (comma-separated)" value={(v.enum || []).join(', ')}
                onChange={e => {
                  const val = e.target.value
                  const enumVals = val ? val.split(',').map(s => s.trim()).filter(Boolean) : undefined
                  updateVar(i, 'enum', enumVals?.length ? enumVals : undefined)
                }}
                style={{ marginTop: 6 }} />
            )}
          </Card>
        ))}
        <Button type="dashed" block icon={<PlusOutlined />} onClick={addVar}>Add variable</Button>
      </div>
    </div>
  )
}
