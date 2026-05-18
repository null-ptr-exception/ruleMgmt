import { useState, useEffect } from 'react'
import { Card, Input, Select, Button, Checkbox, Typography, Divider } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

const { Text, Title } = Typography
const { TextArea } = Input

const TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'integer', label: 'integer' },
  { value: 'boolean', label: 'boolean' },
  { value: 'enum', label: 'enum' },
]

const VAR_TYPE_OPTIONS = [
  { value: 'selector', label: 'selector' },
  { value: 'threshold', label: 'threshold' },
]

const SEVERITY_OPTIONS = [
  { value: 'warning', label: 'warning' },
  { value: 'critical', label: 'critical' },
  { value: 'info', label: 'info' },
]

export default function RuleBuilder({ alertDef, alertName, onChange }) {
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState('')

  useEffect(() => {
    if (rawMode && alertDef) {
      setRawText(JSON.stringify(alertDef, null, 2))
    }
  }, [rawMode, alertDef])

  if (!alertDef || !alertName) {
    return (
      <div style={{ padding: 20, textAlign: 'center' }}>
        <Text type="secondary">Select or create an alert group</Text>
      </div>
    )
  }

  const promql = alertDef['x-promql'] || ''
  const forDuration = alertDef['x-for'] || '5m'
  const isCustom = alertDef['x-custom-template'] || false
  const props = alertDef.items?.properties || {}
  const required = new Set(alertDef.items?.required || [])

  const vars = Object.entries(props).map(([name, prop]) => ({
    name,
    type: prop.enum ? 'enum' : (prop.type || 'string'),
    description: prop.description || '',
    default: prop.default,
    required: required.has(name),
    varType: prop['x-var-type'] || 'selector',
    severity: prop['x-severity'] || 'warning',
    enum: prop.enum,
  }))

  function emitChange(updates) {
    onChange({ ...alertDef, ...updates })
  }

  function updatePromql(val) {
    emitChange({ 'x-promql': val })
  }

  function updateFor(val) {
    emitChange({ 'x-for': val })
  }

  function updateCustomTemplate(val) {
    emitChange({ 'x-custom-template': val })
  }

  function rebuildItems(newVars) {
    const newProps = {}
    const newRequired = []
    for (const v of newVars) {
      const isEnum = v.type === 'enum'
      const prop = { type: isEnum ? 'string' : (v.type || 'string') }
      if (v.description) prop.description = v.description
      if (v.default !== undefined && v.default !== '') prop.default = v.type === 'number' || v.type === 'integer' ? Number(v.default) : v.default
      if (isEnum && v.enum) prop.enum = v.enum
      prop['x-var-type'] = v.varType || 'selector'
      if (v.varType === 'threshold') {
        prop['x-severity'] = v.severity || 'warning'
      }
      newProps[v.name] = prop
      if (v.required) newRequired.push(v.name)
    }
    emitChange({
      items: {
        type: 'object',
        properties: newProps,
        ...(newRequired.length > 0 ? { required: newRequired } : {})
      }
    })
  }

  function updateVar(index, field, value) {
    const updated = vars.map((v, i) => i === index ? { ...v, [field]: value } : v)
    rebuildItems(updated)
  }

  function addVar() {
    rebuildItems([...vars, { name: '', type: 'string', description: '', required: false, varType: 'selector', severity: 'warning' }])
  }

  function removeVar(index) {
    rebuildItems(vars.filter((_, i) => i !== index))
  }

  function handleRawSave() {
    try {
      const parsed = JSON.parse(rawText)
      onChange(parsed)
    } catch { /* invalid JSON */ }
  }

  if (rawMode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c' }}>
            Raw JSON
          </Text>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="small" type="primary" onClick={handleRawSave}>Apply</Button>
            <Button size="small" onClick={() => setRawMode(false)}>Visual</Button>
          </div>
        </div>
        <textarea
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 12, border: 'none', outline: 'none', resize: 'none', background: '#fafafa' }}
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c' }}>
          Rule Builder
        </Text>
        <Button size="small" onClick={() => setRawMode(true)}>Raw</Button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* PromQL */}
        <div style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>PromQL Expression</Text>
          <TextArea
            size="small"
            rows={3}
            placeholder="rate(metric{namespace=&quot;{{ .namespace }}&quot;}[5m]) > {{ THRESHOLD }}"
            value={promql}
            onChange={e => updatePromql(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <Text type="secondary" style={{ fontSize: 10 }}>Use {'{{ .var_name }}'} for selectors, {'{{ THRESHOLD }}'} for threshold placeholder</Text>
        </div>

        {/* For duration */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center' }}>
          <div>
            <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>For Duration</Text>
            <Input size="small" value={forDuration} onChange={e => updateFor(e.target.value)} style={{ width: 80 }} />
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <Checkbox checked={isCustom} onChange={e => updateCustomTemplate(e.target.checked)}>
              <Text style={{ fontSize: 11 }}>Custom template (skip generation)</Text>
            </Checkbox>
          </div>
        </div>

        <Divider style={{ margin: '12px 0' }} />

        {/* Variables */}
        <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', display: 'block', marginBottom: 8 }}>Variables</Text>

        {vars.map((v, i) => (
          <Card key={i} size="small" style={{ marginBottom: 10 }} styles={{ body: { padding: 10 } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Input size="small" placeholder="name" value={v.name}
                onChange={e => updateVar(i, 'name', e.target.value)} style={{ flex: 1, fontWeight: 600 }} />
              <Select size="small" value={v.type} options={TYPE_OPTIONS} style={{ width: 80 }}
                onChange={val => updateVar(i, 'type', val)} />
              <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeVar(i)} />
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <Select size="small" value={v.varType} options={VAR_TYPE_OPTIONS} style={{ width: 100 }}
                onChange={val => updateVar(i, 'varType', val)} />
              {v.varType === 'threshold' && (
                <Select size="small" value={v.severity} options={SEVERITY_OPTIONS} style={{ width: 90 }}
                  onChange={val => updateVar(i, 'severity', val)} />
              )}
              <Input size="small" placeholder="description" value={v.description}
                onChange={e => updateVar(i, 'description', e.target.value)} style={{ flex: 1 }} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input size="small" placeholder="default" value={v.default ?? ''}
                onChange={e => updateVar(i, 'default', e.target.value)} style={{ flex: 1 }} />
              <Checkbox checked={!!v.required} onChange={e => updateVar(i, 'required', e.target.checked)}>
                <Text style={{ fontSize: 11 }}>Req</Text>
              </Checkbox>
            </div>
            {v.type === 'enum' && (
              <Select size="small" mode="tags" placeholder="Type a value and press Enter"
                value={v.enum || []}
                onChange={vals => updateVar(i, 'enum', vals?.length ? vals : undefined)}
                style={{ width: '100%', marginTop: 6 }}
                open={false}
              />
            )}
          </Card>
        ))}
        <Button type="dashed" block icon={<PlusOutlined />} onClick={addVar}>Add variable</Button>
      </div>
    </div>
  )
}
