import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Tag, Typography, Spin } from 'antd'
import { RightOutlined, DownOutlined } from '@ant-design/icons'

const { Text } = Typography

function relativeTime(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function GitHistory({ onSelectFile }) {
  const [commits, setCommits] = useState(null)
  const [expandedSha, setExpandedSha] = useState(null)

  useEffect(() => {
    apiFetch('/api/v2/git/log?limit=20')
      .then(res => res.ok ? res.json() : [])
      .then(setCommits)
      .catch(() => setCommits([]))
  }, [])

  if (commits === null) {
    return <div style={{ padding: 20, textAlign: 'center' }}><Spin size="small" /></div>
  }

  if (commits.length === 0) {
    return <div style={{ padding: '12px 12px' }}><Text type="secondary">No commits found</Text></div>
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
      {commits.map(commit => (
        <div key={commit.sha}>
          <div
            onClick={() => setExpandedSha(prev => prev === commit.sha ? null : commit.sha)}
            style={{ padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 4 }}
            onMouseEnter={e => e.currentTarget.style.background = '#f5f5f5'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {expandedSha === commit.sha
              ? <DownOutlined style={{ fontSize: 10, marginTop: 4, flexShrink: 0 }} />
              : <RightOutlined style={{ fontSize: 10, marginTop: 4, flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Tag style={{ fontSize: 11, margin: 0, fontFamily: 'monospace' }}>{commit.shortSha}</Tag>
                <Text style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {commit.message}
                </Text>
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {commit.author} · {relativeTime(commit.date)}
              </Text>
            </div>
          </div>
          {expandedSha === commit.sha && commit.files.length > 0 && (
            <div style={{ paddingLeft: 32, paddingBottom: 4 }}>
              {commit.files.map(f => (
                <div
                  key={f.file}
                  onClick={e => { e.stopPropagation(); onSelectFile({ file: f.file, ref: commit.sha }) }}
                  style={{ padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderRadius: 4 }}
                  onMouseEnter={e => e.currentTarget.style.background = '#e6f7ff'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <Tag color={f.status === 'A' ? 'green' : f.status === 'D' ? 'red' : 'blue'}
                    style={{ fontSize: 10, margin: 0, minWidth: 20, textAlign: 'center' }}>{f.status}</Tag>
                  <Text style={{ fontSize: 11 }}>{f.file}</Text>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
