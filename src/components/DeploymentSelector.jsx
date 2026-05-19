import { useState } from 'react'
import { List, Button, Input, Select, Space, Badge, Typography } from 'antd'
import { FolderOutlined, FolderOpenOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons'

const { Text } = Typography

export default function DeploymentSelector({ deployments, activeDeployment, onSelect, onCreate, onClone, deploymentFolder }) {
  const [mode, setMode]         = useState(null)
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
    <div style={{ padding: '4px 0' }}>
      {deploymentFolder && (
        <div style={{ padding: '2px 16px 4px', fontSize: 11, color: '#8c8c8c' }}>
          <FolderOpenOutlined style={{ marginRight: 4 }} />
          {deploymentFolder}
        </div>
      )}
      <List
        size="small"
        dataSource={deployments}
        renderItem={d => (
          <List.Item
            onClick={() => onSelect(d.name)}
            style={{
              cursor: 'pointer',
              padding: '6px 16px',
              background: d.name === activeDeployment ? '#f6ffed' : undefined,
              fontWeight: d.name === activeDeployment ? 600 : undefined,
            }}
          >
            <FolderOutlined style={{ marginRight: 8, color: '#faad14' }} />
            <Text style={{ flex: 1 }}>{d.name}</Text>
            <Badge count={d.alertCount} showZero color="#d9d9d9" style={{ color: '#595959' }} />
          </List.Item>
        )}
      />

      <div style={{ padding: '4px 16px', display: 'flex', gap: 4 }}>
        {mode === null && (
          <>
            <Button size="small" icon={<PlusOutlined />} onClick={() => setMode('new')}>New</Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => { setMode('clone'); setCloneSource(deployments[0]?.name || '') }}>Clone</Button>
          </>
        )}
      </div>

      {mode === 'new' && (
        <div style={{ padding: '4px 16px' }}>
          <Input
            size="small"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New deployment name"
            autoFocus
            onPressEnter={handleCreate}
          />
          <Space style={{ marginTop: 4 }}>
            <Button size="small" type="primary" onClick={handleCreate} disabled={!newName.trim()}>OK</Button>
            <Button size="small" onClick={reset}>Cancel</Button>
          </Space>
        </div>
      )}

      {mode === 'clone' && (
        <div style={{ padding: '4px 16px' }}>
          <Select
            size="small"
            value={cloneSource}
            onChange={setCloneSource}
            style={{ width: '100%', marginBottom: 4 }}
            options={deployments.map(d => ({ value: d.name, label: d.name }))}
          />
          <Input
            size="small"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New deployment name"
            autoFocus
            onPressEnter={handleClone}
          />
          <Space style={{ marginTop: 4 }}>
            <Button size="small" type="primary" onClick={handleClone} disabled={!newName.trim() || !cloneSource}>OK</Button>
            <Button size="small" onClick={reset}>Cancel</Button>
          </Space>
        </div>
      )}
    </div>
  )
}
