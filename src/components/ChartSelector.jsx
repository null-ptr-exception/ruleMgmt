import { useState } from 'react'
import { Select, Button, Input, Space } from 'antd'
import { PlusOutlined } from '@ant-design/icons'

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
    <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        Chart
      </div>
      <Space.Compact style={{ width: '100%' }}>
        <Select
          value={activeChart || undefined}
          onChange={onSelect}
          style={{ flex: 1 }}
          options={charts.map(c => ({ value: c.name, label: `${c.name} (${c.templateCount} templates)` }))}
        />
        {onCreate && !creating && (
          <Button icon={<PlusOutlined />} onClick={() => setCreating(true)}>New</Button>
        )}
      </Space.Compact>
      {creating && (
        <Space.Compact style={{ width: '100%', marginTop: 6 }}>
          <Input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New chart name"
            autoFocus
            onPressEnter={handleCreate}
          />
          <Button type="primary" onClick={handleCreate} disabled={!newName.trim()}>Create</Button>
          <Button onClick={() => { setCreating(false); setNewName('') }}>Cancel</Button>
        </Space.Compact>
      )}
    </div>
  )
}
