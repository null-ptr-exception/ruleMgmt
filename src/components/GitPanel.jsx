import { useState, useRef } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Button, Typography, Space, Modal, Tooltip, message, notification } from 'antd'
import {
  BranchesOutlined,
  CloudUploadOutlined,
  CloudDownloadOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import GitChanges from './GitChanges.jsx'
import GitHistory from './GitHistory.jsx'
import GitDiffViewer from './GitDiffViewer.jsx'

const { Title } = Typography

export default function GitPanel({ gitStatus, onRefresh }) {
  const [activeTab, setActiveTab] = useState('changes')
  const [selectedFile, setSelectedFile] = useState(null)
  const [loading, setLoading] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const resizingRef = useRef(false)

  function handleResizeStart(e) {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX
    const startWidth = sidebarWidth
    function onMove(ev) {
      if (!resizingRef.current) return
      const clientX = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX
      const newWidth = Math.max(200, Math.min(500, startWidth + clientX - startX))
      setSidebarWidth(newWidth)
    }
    function onUp() {
      resizingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
  }

  const { branch, changeCount, behindMain, hasRemote } = gitStatus

  function showTokenExpired() {
    notification.error({
      message: 'Session Expired',
      description: (
        <>
          Your authentication token has expired.{' '}
          <a href="/hub/home" target="_blank" rel="noreferrer">
            Restart your server
          </a>{' '}
          to re-authenticate.
        </>
      ),
      duration: 0,
    })
  }

  async function handlePush() {
    setLoading('push')
    try {
      const res = await apiFetch('/api/v2/git/push', { method: 'POST' })
      if (res.ok) {
        message.success('Pushed successfully')
        onRefresh()
      } else {
        const data = await res.json().catch(() => ({}))
        if (data.code === 'TOKEN_EXPIRED') {
          showTokenExpired()
        } else {
          message.error(data.error || 'Push failed')
        }
      }
    } catch {
      message.error('Push failed: network error')
    } finally {
      setLoading(null)
    }
  }

  async function handlePull() {
    setLoading('pull')
    try {
      const res = await apiFetch('/api/v2/git/pull', { method: 'POST' })
      if (res.ok) {
        message.success('Pulled successfully')
        onRefresh()
      } else {
        const data = await res.json().catch(() => ({}))
        if (data.code === 'TOKEN_EXPIRED') {
          showTokenExpired()
        } else {
          message.error(data.error || 'Pull failed')
        }
      }
    } catch {
      message.error('Pull failed: network error')
    } finally {
      setLoading(null)
    }
  }

  async function handleSync() {
    Modal.confirm({
      title: 'Sync to latest main?',
      icon: <SyncOutlined />,
      content: 'This will reset your workspace to the latest main branch.',
      onOk: async () => {
        try {
          const res = await apiFetch('/api/v2/git/sync', { method: 'POST' })
          if (res.ok) {
            message.success('Synced to latest main')
            onRefresh()
          } else {
            const data = await res.json().catch(() => ({}))
            message.error(data.error || 'Sync failed')
          }
        } catch {
          message.error('Sync failed: network error')
        }
      },
    })
  }

  const tabStyle = (tab) => ({
    padding: '6px 16px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: activeTab === tab ? 600 : 400,
    borderBottom: activeTab === tab ? '2px solid #1677ff' : '2px solid transparent',
    color: activeTab === tab ? '#1677ff' : '#595959',
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Title level={5} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <BranchesOutlined /> {branch || '...'}
        </Title>
        <Space size="small">
          <Tooltip title={!hasRemote ? 'No remote configured' : undefined}>
            <Button
              icon={<CloudDownloadOutlined />}
              disabled={!hasRemote || changeCount > 0}
              loading={loading === 'pull'}
              onClick={handlePull}
              size="small"
            >
              Pull
            </Button>
          </Tooltip>
          <Tooltip title={!hasRemote ? 'No remote configured' : undefined}>
            <Button
              icon={<CloudUploadOutlined />}
              disabled={!hasRemote || changeCount > 0}
              loading={loading === 'push'}
              onClick={handlePush}
              size="small"
            >
              Push
            </Button>
          </Tooltip>
        </Space>
      </div>

      {/* Behind main banner */}
      {behindMain > 0 && (
        <div style={{
          padding: '6px 16px',
          background: '#fffbe6',
          borderBottom: '1px solid #ffe58f',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
        }}>
          <ExclamationCircleOutlined style={{ color: '#faad14' }} />
          Main has {behindMain} new commit{behindMain !== 1 ? 's' : ''}
          {hasRemote && (
            <Button size="small" type="link" icon={<SyncOutlined />} onClick={handleSync} style={{ fontSize: 12 }}>
              Sync
            </Button>
          )}
        </div>
      )}

      {/* Two-column body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left column */}
        <div style={{ width: sidebarWidth, minWidth: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', position: 'relative' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={tabStyle('changes')} onClick={() => setActiveTab('changes')}>Changes</div>
            <div style={tabStyle('history')} onClick={() => setActiveTab('history')}>History</div>
          </div>
          {/* Tab content */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {activeTab === 'changes' && (
              <GitChanges gitStatus={gitStatus} onRefresh={onRefresh} onSelectFile={setSelectedFile} />
            )}
            {activeTab === 'history' && (
              <GitHistory onSelectFile={setSelectedFile} />
            )}
          </div>
          <div
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
            style={{ position: 'absolute', top: 0, right: -2, width: 5, height: '100%', cursor: 'col-resize', zIndex: 10 }}
          >
            <div style={{
              position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
              width: 14, height: 28, borderRadius: 4, background: '#d9d9d9', border: '1px solid #bfbfbf',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, color: '#8c8c8c', letterSpacing: 1, touchAction: 'none'
            }}>⋮</div>
          </div>
        </div>

        {/* Right column — diff viewer */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <GitDiffViewer selectedFile={selectedFile} />
        </div>
      </div>
    </div>
  )
}
