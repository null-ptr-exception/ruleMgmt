import { useState } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Button, Input, Tag, Modal, Typography, Space, message } from 'antd'
import {
  CheckOutlined,
  UndoOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'

const { Text } = Typography

export default function GitChanges({ gitStatus, onRefresh, onSelectFile }) {
  const [commitMessage, setCommitMessage] = useState('')
  const [loading, setLoading] = useState(null)

  const { changes, changeCount } = gitStatus

  async function handleCommit() {
    if (!commitMessage.trim()) return
    setLoading('commit')
    try {
      const res = await apiFetch('/api/v2/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage }),
      })
      if (res.ok) {
        message.success('Changes committed')
        setCommitMessage('')
        onRefresh()
      } else {
        const data = await res.json().catch(() => ({}))
        message.error(data.error || 'Commit failed')
      }
    } catch {
      message.error('Commit failed: network error')
    } finally {
      setLoading(null)
    }
  }

  async function handleDiscard() {
    Modal.confirm({
      title: 'Discard all changes?',
      icon: <ExclamationCircleOutlined />,
      content: 'This will revert all uncommitted changes. This cannot be undone.',
      okText: 'Discard',
      okType: 'danger',
      onOk: async () => {
        try {
          const res = await apiFetch('/api/v2/git/discard', { method: 'POST' })
          if (res.ok) {
            message.success('Changes discarded')
            onRefresh()
          } else {
            const data = await res.json().catch(() => ({}))
            message.error(data.error || 'Discard failed')
          }
        } catch {
          message.error('Discard failed: network error')
        }
      },
    })
  }

  const fileList = [
    ...(changes?.modified || []).map(f => ({ file: f, status: 'M', color: 'blue' })),
    ...(changes?.added || []).map(f => ({ file: f, status: 'A', color: 'green' })),
    ...(changes?.deleted || []).map(f => ({ file: f, status: 'D', color: 'red' })),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 12px' }}>
        <Text strong style={{ fontSize: 12, color: '#8c8c8c', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Changes ({changeCount})
        </Text>
        <div style={{ marginTop: 8 }}>
          {fileList.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 13 }}>No pending changes</Text>
          ) : (
            fileList.map(({ file, status, color }) => (
              <div
                key={file}
                onClick={() => onSelectFile({ file, ref: null })}
                style={{ padding: '4px 4px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderRadius: 4 }}
                onMouseEnter={e => e.currentTarget.style.background = '#f5f5f5'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Tag color={color} style={{ fontSize: 11, margin: 0, minWidth: 24, textAlign: 'center' }}>{status}</Tag>
                <Text style={{ fontSize: 12 }}>{file}</Text>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid #f0f0f0' }}>
        <Input.TextArea
          rows={2}
          placeholder="Commit message..."
          value={commitMessage}
          onChange={e => setCommitMessage(e.target.value)}
          onPressEnter={e => { if (e.ctrlKey) handleCommit() }}
          style={{ marginBottom: 8 }}
        />
        <Space>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            disabled={changeCount === 0 || !commitMessage.trim()}
            loading={loading === 'commit'}
            onClick={handleCommit}
            size="small"
          >
            Commit
          </Button>
          <Button
            danger
            icon={<UndoOutlined />}
            disabled={changeCount === 0}
            onClick={handleDiscard}
            size="small"
          >
            Discard
          </Button>
        </Space>
      </div>
    </div>
  )
}
