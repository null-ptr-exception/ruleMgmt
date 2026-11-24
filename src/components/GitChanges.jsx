import { useState } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Button, Input, Tag, Modal, Typography, Space, message } from 'antd'
import {
  CheckOutlined,
  UndoOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'

const { Text } = Typography

// A chart still in the 1.x format does not stop a commit (#79), but the
// person committing should know it is there to convert.
function unconvertedNote(unconverted) {
  return (
    <>
      <div style={{ marginTop: 8 }}>
        {unconverted.length === 1 ? '1 chart still uses' : `${unconverted.length} charts still use`} the old format:
      </div>
      <ul style={{ paddingLeft: 18, margin: '4px 0 8px' }}>
        {unconverted.map(name => <li key={name}>{name}</li>)}
      </ul>
      <Text type="secondary">
        Editing, Preview and deploys work as before. Convert one chart at a time when ready: open it in
        Templates and save, or run <Text code>gen-rules</Text>.
      </Text>
    </>
  )
}

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
        const data = await res.json().catch(() => ({}))
        // A routing.yaml with errors does not stop a commit (#179), but it
        // is not what deploys: say which, to fix on their Routing page.
        if (data.routingProblems?.length || data.routingWarnings?.length || data.valueWarnings?.length || data.unconverted?.length || data.unreadable?.length) {
          Modal.warning({
            title: 'Changes committed',
            content: (
              <>
                {data.routingProblems?.length > 0 && (
                  <>
                    <div style={{ marginTop: 8 }}>
                      {data.routingProblems.length === 1 ? 'This routing.yaml has' : 'These routing.yaml files have'} problems — fix them on the Routing page:
                    </div>
                    <ul data-testid="commit-routing-problems" style={{ paddingLeft: 18, margin: '4px 0 8px' }}>
                      {data.routingProblems.map(p => <li key={p.deployment}>{p.deployment}: {p.errors.join('; ')}</li>)}
                    </ul>
                  </>
                )}
                {data.routingWarnings?.length > 0 && (
                  <>
                    <div style={{ marginTop: 8 }}>Worth knowing about their notification configs:</div>
                    <ul data-testid="commit-routing-warnings" style={{ paddingLeft: 18, margin: '4px 0 8px' }}>
                      {data.routingWarnings.map(w => <li key={w.deployment}>{w.deployment}: {w.warnings.join('; ')}</li>)}
                    </ul>
                  </>
                )}
                {data.valueWarnings?.length > 0 && (
                  <>
                    <div style={{ marginTop: 8 }}>Rows the row identity label cannot tell apart:</div>
                    <ul data-testid="commit-value-warnings" style={{ paddingLeft: 18, margin: '4px 0 8px' }}>
                      {data.valueWarnings.map(w => <li key={w.deployment}>{w.deployment}: {w.warnings.join('; ')}</li>)}
                    </ul>
                  </>
                )}
                {data.unreadable?.length > 0 && (
                  <>
                    <div style={{ marginTop: 8 }}>
                      {data.unreadable.length === 1 ? 'This folder cannot be read' : 'These folders cannot be read'}, so the deployments in it were not checked:
                    </div>
                    <ul data-testid="commit-unreadable" style={{ paddingLeft: 18, margin: '4px 0 8px' }}>
                      {data.unreadable.map(u => <li key={u.path}>{u.path} ({u.error})</li>)}
                    </ul>
                  </>
                )}
                {data.unconverted?.length > 0 && unconvertedNote(data.unconverted)}
              </>
            ),
          })
        } else {
          message.success('Changes committed')
        }
        setCommitMessage('')
        onRefresh()
      } else {
        const data = await res.json().catch(() => ({}))
        // A refused commit says which chart and why — "Rule checks failed"
        // alone leaves the person committing nothing to go and fix.
        if (data.findings?.length) {
          const list = (
            <ul data-testid="commit-findings" style={{ paddingLeft: 18, marginTop: 8 }}>
              {data.findings.map((f, i) => <li key={i}>{f.description || f.message}</li>)}
            </ul>
          )
          // Routing behind its routing.yaml is made again here, as files to
          // look at in the diff before committing (#179).
          if (data.regenerable > 0) {
            Modal.confirm({
              title: data.error || 'Commit refused',
              content: list,
              okText: `Regenerate ${data.regenerable}`,
              cancelText: 'Close',
              onOk: regenerateRouting,
            })
          } else {
            Modal.error({ title: data.error || 'Commit refused', content: list })
          }
        } else {
          message.error(data.error || 'Commit failed')
        }
      }
    } catch {
      message.error('Commit failed: network error')
    } finally {
      setLoading(null)
    }
  }

  async function regenerateRouting() {
    const res = await apiFetch('/api/v2/git/routing/regenerate', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      message.error(data.error || 'Could not regenerate the routing')
      return
    }
    const made = data.regenerated?.length || 0
    if (data.failed?.length) {
      Modal.error({
        title: `Regenerated ${made}; ${data.failed.length} could not be`,
        content: (
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            {data.failed.map(f => <li key={f.deployment}>{f.deployment}: {f.error}</li>)}
          </ul>
        ),
      })
    } else {
      message.success(`Regenerated ${made} — look at the changes, then commit`)
    }
    onRefresh()
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
