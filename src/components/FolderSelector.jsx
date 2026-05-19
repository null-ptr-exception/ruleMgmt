import { useState, useEffect, useRef } from 'react'
import { Tree, Input, Button, Space, Spin } from 'antd'
import { FolderOutlined, FolderAddOutlined } from '@ant-design/icons'

function buildTreeData(folders, parentPath = '') {
  return folders.map(f => {
    const fullPath = parentPath ? `${parentPath}/${f.name}` : f.name
    return {
      title: f.name,
      key: fullPath,
      icon: <FolderOutlined />,
      children: f.children?.length ? buildTreeData(f.children, fullPath) : undefined,
    }
  })
}

export default function FolderSelector({ open, onClose, onSelect, folders, loading, onCreateFolder }) {
  const [creating, setCreating] = useState(false)
  const [newFolderPath, setNewFolderPath] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onClose])

  if (!open) return null

  const treeData = buildTreeData(folders)

  const handleSelect = (selectedKeys) => {
    if (selectedKeys.length > 0) {
      onSelect(selectedKeys[0])
      onClose()
    }
  }

  const handleCreate = async () => {
    const trimmed = newFolderPath.trim()
    if (!trimmed) return
    await onCreateFolder(trimmed)
    setNewFolderPath('')
    setCreating(false)
    onSelect(trimmed)
    onClose()
  }

  return (
    <div ref={ref} style={{
      position: 'absolute',
      top: '100%',
      left: 0,
      right: 0,
      zIndex: 100,
      background: '#fff',
      border: '1px solid #d9d9d9',
      borderRadius: 6,
      boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
      maxHeight: 320,
      overflow: 'auto',
      padding: 8,
    }}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 16 }}><Spin size="small" /></div>
      ) : (
        <>
          <Tree
            showIcon
            treeData={treeData}
            onSelect={handleSelect}
            defaultExpandAll
            style={{ fontSize: 13 }}
          />
          <div style={{ borderTop: '1px solid #f0f0f0', marginTop: 4, paddingTop: 4 }}>
            {!creating ? (
              <Button
                type="link"
                size="small"
                icon={<FolderAddOutlined />}
                onClick={() => setCreating(true)}
                style={{ padding: '2px 4px' }}
              >
                Create new folder...
              </Button>
            ) : (
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  size="small"
                  value={newFolderPath}
                  onChange={e => setNewFolderPath(e.target.value)}
                  placeholder="path/to/folder"
                  autoFocus
                  onPressEnter={handleCreate}
                />
                <Button size="small" type="primary" onClick={handleCreate} disabled={!newFolderPath.trim()}>OK</Button>
                <Button size="small" onClick={() => { setCreating(false); setNewFolderPath('') }}>Cancel</Button>
              </Space.Compact>
            )}
          </div>
        </>
      )}
    </div>
  )
}
