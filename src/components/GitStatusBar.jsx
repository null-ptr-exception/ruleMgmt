import { useState } from 'react'
import { Button, Badge, Modal, Input, Tag, Tooltip, Space } from 'antd'
import {
  BranchesOutlined,
  CloudUploadOutlined,
  UndoOutlined,
  CheckOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'

export default function GitStatusBar({ gitStatus, onRefresh }) {
  const [commitModalOpen, setCommitModalOpen] = useState(false)
  const [pushModalOpen, setPushModalOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [pushBranch, setPushBranch] = useState('')
  const [loading, setLoading] = useState(null)

  const { branch, changeCount, behindMain, hasRemote } = gitStatus

  async function handleCommit() {
    if (!commitMessage.trim()) return
    setLoading('commit')
    try {
      const res = await fetch('/api/v2/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage }),
      })
      if (res.ok) {
        setCommitMessage('')
        setCommitModalOpen(false)
        onRefresh()
      }
    } finally {
      setLoading(null)
    }
  }

  async function handlePush() {
    setLoading('push')
    try {
      const res = await fetch('/api/v2/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: pushBranch || undefined }),
      })
      if (res.ok) {
        setPushModalOpen(false)
        onRefresh()
      }
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
        await fetch('/api/v2/git/discard', { method: 'POST' })
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
        await fetch('/api/v2/git/sync', { method: 'POST' })
        onRefresh()
      },
    })
  }

  return (
    <>
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        background: '#fafafa',
        flexWrap: 'wrap',
      }}>
        <Tag icon={<BranchesOutlined />} color="default">{branch || '...'}</Tag>

        {changeCount > 0 && (
          <Badge count={changeCount} size="small" offset={[0, 0]}>
            <Tag color="blue">{changeCount} change{changeCount !== 1 ? 's' : ''}</Tag>
          </Badge>
        )}

        <Space size={4} style={{ marginLeft: 'auto' }}>
          <Tooltip title="Commit changes">
            <Button
              size="small"
              type="text"
              icon={<CheckOutlined />}
              disabled={changeCount === 0}
              loading={loading === 'commit'}
              onClick={() => setCommitModalOpen(true)}
            >
              Commit
            </Button>
          </Tooltip>

          {hasRemote && (
            <Tooltip title="Push to branch">
              <Button
                size="small"
                type="text"
                icon={<CloudUploadOutlined />}
                disabled={changeCount > 0}
                loading={loading === 'push'}
                onClick={() => setPushModalOpen(true)}
              >
                Push
              </Button>
            </Tooltip>
          )}

          <Tooltip title="Discard all changes">
            <Button
              size="small"
              type="text"
              danger
              icon={<UndoOutlined />}
              disabled={changeCount === 0}
              onClick={handleDiscard}
            >
              Discard
            </Button>
          </Tooltip>
        </Space>
      </div>

      {behindMain > 0 && (
        <div style={{
          padding: '4px 16px',
          background: '#fffbe6',
          borderBottom: '1px solid #ffe58f',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
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

      <Modal
        title="Commit changes"
        open={commitModalOpen}
        onOk={handleCommit}
        onCancel={() => setCommitModalOpen(false)}
        okText="Commit"
        okButtonProps={{ disabled: !commitMessage.trim() }}
      >
        <Input.TextArea
          rows={3}
          placeholder="Describe your changes..."
          value={commitMessage}
          onChange={e => setCommitMessage(e.target.value)}
          onPressEnter={e => { if (e.ctrlKey) handleCommit() }}
        />
      </Modal>

      <Modal
        title="Push to branch"
        open={pushModalOpen}
        onOk={handlePush}
        onCancel={() => setPushModalOpen(false)}
        okText="Push"
      >
        <Input
          placeholder="Branch name (e.g. username/my-feature)"
          value={pushBranch}
          onChange={e => setPushBranch(e.target.value)}
        />
      </Modal>
    </>
  )
}
