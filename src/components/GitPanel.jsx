import { useState } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Button, Input, Tag, Modal, Typography, Space } from 'antd'
import {
  BranchesOutlined,
  CloudUploadOutlined,
  UndoOutlined,
  CheckOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'

const { Text, Title } = Typography

export default function GitPanel({ gitStatus, onRefresh }) {
  const [commitMessage, setCommitMessage] = useState('')
  const [loading, setLoading] = useState(null)

  const { branch, changes, changeCount, behindMain, hasRemote } = gitStatus

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
        setCommitMessage('')
        onRefresh()
      }
    } finally {
      setLoading(null)
    }
  }

  async function handlePush() {
    setLoading('push')
    try {
      const res = await apiFetch('/api/v2/git/push', { method: 'POST' })
      if (res.ok) onRefresh()
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
        await apiFetch('/api/v2/git/discard', { method: 'POST' })
        onRefresh()
      },
    })
  }

  async function handleSync() {
    Modal.confirm({
      title: 'Sync to latest main?',
      icon: <SyncOutlined />,
      content: 'This will reset your workspace to the latest main branch.',
      onOk: async () => {
        await apiFetch('/api/v2/git/sync', { method: 'POST' })
        onRefresh()
      },
    })
  }

  const fileList = [
    ...(changes?.modified || []).map(f => ({ file: f, status: 'M', color: 'blue' })),
    ...(changes?.added || []).map(f => ({ file: f, status: 'A', color: 'green' })),
    ...(changes?.deleted || []).map(f => ({ file: f, status: 'D', color: 'red' })),
  ]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0' }}>
        <Title level={4} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <BranchesOutlined /> {branch || '...'}
        </Title>
      </div>

      {behindMain > 0 && (
        <div style={{
          padding: '8px 20px',
          background: '#fffbe6',
          borderBottom: '1px solid #ffe58f',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
        }}>
          <ExclamationCircleOutlined style={{ color: '#faad14' }} />
          Main branch has {behindMain} new commit{behindMain !== 1 ? 's' : ''}
          {hasRemote && (
            <Button size="small" type="link" icon={<SyncOutlined />} onClick={handleSync}>
              Sync
            </Button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
        <Text strong style={{ fontSize: 13, color: '#8c8c8c', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Changes ({changeCount})
        </Text>
        <div style={{ marginTop: 8 }}>
          {fileList.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 13 }}>No pending changes</Text>
          ) : (
            fileList.map(({ file, status, color }) => (
              <div key={file} style={{ padding: '3px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Tag color={color} style={{ fontSize: 11, margin: 0, minWidth: 24, textAlign: 'center' }}>{status}</Tag>
                <Text code style={{ fontSize: 12 }}>{file}</Text>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ padding: '12px 20px', borderTop: '1px solid #f0f0f0' }}>
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
          >
            Commit
          </Button>
          {hasRemote && (
            <Button
              icon={<CloudUploadOutlined />}
              disabled={changeCount > 0}
              loading={loading === 'push'}
              onClick={handlePush}
            >
              Push
            </Button>
          )}
          <Button
            danger
            icon={<UndoOutlined />}
            disabled={changeCount === 0}
            onClick={handleDiscard}
          >
            Discard
          </Button>
        </Space>
      </div>

    </div>
  )
}
