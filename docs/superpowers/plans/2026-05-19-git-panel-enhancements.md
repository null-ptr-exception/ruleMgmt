# Git Panel Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-file diff viewing, commit history, and pull to the Git panel with a two-column VSCode-style layout.

**Architecture:** Three new backend endpoints (log, diff, pull) on the existing git router. Frontend restructured: GitPanel becomes an orchestrator with GitChanges, GitHistory, and GitDiffViewer as child components. CodeMirror merge extension for side-by-side diffs.

**Tech Stack:** Express, git CLI, CodeMirror 6 (`@codemirror/merge`), React, Ant Design

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `server/routes/git.js` | Add GET /log, GET /diff, POST /pull endpoints |
| Modify | `tests/integration/git-api.test.js` | Tests for new endpoints + fix stale recoveredFromWip tests |
| Create | `src/components/GitChanges.jsx` | File list, commit input, commit/discard buttons |
| Create | `src/components/GitHistory.jsx` | Commit log list with expandable file lists |
| Create | `src/components/GitDiffViewer.jsx` | CodeMirror merge view for selected file |
| Modify | `src/components/GitPanel.jsx` | Restructure as two-column orchestrator |

---

### Task 1: Install @codemirror/merge dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
npm install @codemirror/merge
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('@codemirror/merge'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @codemirror/merge dependency"
```

---

### Task 2: Backend — GET /log endpoint

**Files:**
- Modify: `server/routes/git.js`
- Modify: `tests/integration/git-api.test.js`

- [ ] **Step 1: Write failing tests for GET /log**

Add to `tests/integration/git-api.test.js`, inside the existing `describe('Git API', ...)` block, after the last test:

```js
it('GET /log returns commit history', async () => {
  const { status, data } = await api('GET', '/api/v2/git/log')
  expect(status).toBe(200)
  expect(Array.isArray(data)).toBe(true)
  expect(data.length).toBeGreaterThan(0)
  const commit = data[0]
  expect(commit).toHaveProperty('sha')
  expect(commit).toHaveProperty('shortSha')
  expect(commit).toHaveProperty('message')
  expect(commit).toHaveProperty('author')
  expect(commit).toHaveProperty('date')
  expect(commit).toHaveProperty('files')
  expect(Array.isArray(commit.files)).toBe(true)
})

it('GET /log respects limit param', async () => {
  const { status, data } = await api('GET', '/api/v2/git/log?limit=1')
  expect(status).toBe(200)
  expect(data.length).toBe(1)
})

it('GET /log includes file changes per commit', async () => {
  const { data } = await api('GET', '/api/v2/git/log?limit=1')
  const latest = data[0]
  expect(latest.files.length).toBeGreaterThan(0)
  expect(latest.files[0]).toHaveProperty('file')
  expect(latest.files[0]).toHaveProperty('status')
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/integration/git-api.test.js 2>&1 | tee /tmp/test-output.log; grep -E 'PASS|FAIL|✓|×|❌' /tmp/test-output.log
```

Expected: new tests FAIL with 404.

- [ ] **Step 3: Implement GET /log**

In `server/routes/git.js`, add this route inside `gitRouter()` before `return router`:

```js
router.get('/log', async (req, res) => {
  const cwd = req.gitopsDir
  const limit = parseInt(req.query.limit, 10) || 20

  try {
    const SEP = '---GIT-LOG-SEP---'
    const format = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`
    const raw = await git(cwd, 'log', `--format=${format}`, `-n`, `${limit}`)
    const commits = []

    for (const line of raw.trim().split('\n')) {
      if (!line) continue
      const [sha, shortSha, message, author, date] = line.split(SEP)
      let files = []
      try {
        const diffTree = await git(cwd, 'diff-tree', '--no-commit-id', '-r', '--name-status', sha)
        files = diffTree.trim().split('\n').filter(Boolean).map(l => {
          const [statusCode, ...parts] = l.split('\t')
          const file = parts.join('\t')
          const status = statusCode.startsWith('A') ? 'A' : statusCode.startsWith('D') ? 'D' : 'M'
          return { file, status }
        })
      } catch { /* initial commit has no parent */ }
      commits.push({ sha, shortSha, message, author, date, files })
    }

    res.json(commits)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/integration/git-api.test.js 2>&1 | tee /tmp/test-output.log; grep -E 'PASS|FAIL|✓|×|❌' /tmp/test-output.log
```

Expected: new log tests PASS. (The stale `recoveredFromWip` tests will fail — that's fixed in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add server/routes/git.js tests/integration/git-api.test.js
git commit -m "feat: add GET /log endpoint for commit history"
```

---

### Task 3: Backend — GET /diff endpoint

**Files:**
- Modify: `server/routes/git.js`
- Modify: `tests/integration/git-api.test.js`

- [ ] **Step 1: Write failing tests for GET /diff**

Add to the test file inside the `describe` block:

```js
it('GET /diff returns working tree diff', async () => {
  await fs.writeFile(path.join(tmpDir, 'diff-test.txt'), 'modified content')
  await git(tmpDir, 'add', 'diff-test.txt')
  await git(tmpDir, 'commit', '-m', 'add diff-test')
  await fs.writeFile(path.join(tmpDir, 'diff-test.txt'), 'changed content')

  const { status, data } = await api('GET', '/api/v2/git/diff?file=diff-test.txt')
  expect(status).toBe(200)
  expect(data.file).toBe('diff-test.txt')
  expect(data.original).toBe('modified content')
  expect(data.modified).toBe('changed content')
})

it('GET /diff returns commit diff when ref provided', async () => {
  await fs.writeFile(path.join(tmpDir, 'ref-test.txt'), 'v1')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'add ref-test v1')

  await fs.writeFile(path.join(tmpDir, 'ref-test.txt'), 'v2')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'update ref-test v2')

  const sha = (await git(tmpDir, 'rev-parse', 'HEAD')).trim()
  const { status, data } = await api('GET', `/api/v2/git/diff?file=ref-test.txt&ref=${sha}`)
  expect(status).toBe(200)
  expect(data.original).toBe('v1')
  expect(data.modified).toBe('v2')
})

it('GET /diff returns 400 when file param missing', async () => {
  const { status } = await api('GET', '/api/v2/git/diff')
  expect(status).toBe(400)
})

it('GET /diff returns empty original for added files', async () => {
  await fs.writeFile(path.join(tmpDir, 'brand-new.txt'), 'new content')

  const { status, data } = await api('GET', '/api/v2/git/diff?file=brand-new.txt')
  expect(status).toBe(200)
  expect(data.original).toBe('')
  expect(data.modified).toBe('new content')
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/integration/git-api.test.js 2>&1 | tee /tmp/test-output.log; grep -E 'PASS|FAIL|✓|×|❌' /tmp/test-output.log
```

Expected: new diff tests FAIL with 404.

- [ ] **Step 3: Implement GET /diff**

In `server/routes/git.js`, add this route inside `gitRouter()`:

```js
router.get('/diff', async (req, res) => {
  const cwd = req.gitopsDir
  const file = req.query.file
  const ref = req.query.ref

  if (!file) return res.status(400).json({ error: 'file param required' })

  try {
    let original = ''
    let modified = ''

    if (ref) {
      try { original = await git(cwd, 'show', `${ref}~1:${file}`) } catch { original = '' }
      try { modified = await git(cwd, 'show', `${ref}:${file}`) } catch { modified = '' }
    } else {
      try { original = await git(cwd, 'show', `HEAD:${file}`) } catch { original = '' }
      try {
        const filePath = path.join(cwd, file)
        modified = await fs.readFile(filePath, 'utf8')
      } catch { modified = '' }
    }

    res.json({ file, original, modified })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Note: `fs` and `path` are already imported at the top of `server/routes/git.js`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/integration/git-api.test.js 2>&1 | tee /tmp/test-output.log; grep -E 'PASS|FAIL|✓|×|❌' /tmp/test-output.log
```

Expected: new diff tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/git.js tests/integration/git-api.test.js
git commit -m "feat: add GET /diff endpoint for file diff contents"
```

---

### Task 4: Backend — POST /pull endpoint + fix stale tests

**Files:**
- Modify: `server/routes/git.js`
- Modify: `tests/integration/git-api.test.js`

- [ ] **Step 1: Fix stale recoveredFromWip tests**

In `tests/integration/git-api.test.js`, replace the last two tests (`recoveredFromWip` tests at lines 100-118) with:

```js
it('POST /pull returns 404 when no remote', async () => {
  const { status, data } = await api('POST', '/api/v2/git/pull')
  expect(status).toBe(404)
  expect(data.error).toContain('no remote')
})
```

- [ ] **Step 2: Run tests to verify the pull test fails (404 expected but endpoint doesn't exist yet)**

```bash
npx vitest run tests/integration/git-api.test.js 2>&1 | tee /tmp/test-output.log; grep -E 'PASS|FAIL|✓|×|❌' /tmp/test-output.log
```

Expected: pull test FAILS (endpoint not found). All other tests should PASS now.

- [ ] **Step 3: Implement POST /pull**

In `server/routes/git.js`, add this route inside `gitRouter()`:

```js
router.post('/pull', async (req, res) => {
  const cwd = req.gitopsDir
  const remote = hasRemote()
  if (!remote) return res.status(404).json({ error: 'no remote configured' })

  try {
    const statusRaw = await git(cwd, 'status', '--porcelain')
    if (statusRaw.trim()) {
      return res.status(409).json({ error: 'commit or discard changes before pulling' })
    }

    const branch = await getBranch(cwd)
    await git(cwd, 'pull', '--rebase', 'origin', branch)
    const head = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
    res.json({ status: 'ok', head })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
npx vitest run tests/integration/git-api.test.js 2>&1 | tee /tmp/test-output.log; grep -E 'PASS|FAIL|✓|×|❌' /tmp/test-output.log
```

Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/git.js tests/integration/git-api.test.js
git commit -m "feat: add POST /pull endpoint, fix stale recoveredFromWip tests"
```

---

### Task 5: Frontend — GitChanges component

**Files:**
- Create: `src/components/GitChanges.jsx`

- [ ] **Step 1: Create GitChanges.jsx**

Extract the file list, commit input, and action buttons from the current GitPanel into a standalone component:

```jsx
import { useState } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Button, Input, Tag, Modal, Typography, Space } from 'antd'
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
        setCommitMessage('')
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
        await apiFetch('/api/v2/git/discard', { method: 'POST' })
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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/GitChanges.jsx
git commit -m "feat: extract GitChanges component from GitPanel"
```

---

### Task 6: Frontend — GitHistory component

**Files:**
- Create: `src/components/GitHistory.jsx`

- [ ] **Step 1: Create GitHistory.jsx**

```jsx
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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/GitHistory.jsx
git commit -m "feat: add GitHistory component for commit log"
```

---

### Task 7: Frontend — GitDiffViewer component

**Files:**
- Create: `src/components/GitDiffViewer.jsx`

- [ ] **Step 1: Create GitDiffViewer.jsx**

```jsx
import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Typography, Spin, Empty } from 'antd'
import { MergeView } from '@codemirror/merge'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

const { Text } = Typography

export default function GitDiffViewer({ selectedFile }) {
  const [diff, setDiff] = useState(null)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef(null)
  const viewRef = useRef(null)

  useEffect(() => {
    if (!selectedFile) { setDiff(null); return }

    setLoading(true)
    const params = new URLSearchParams({ file: selectedFile.file })
    if (selectedFile.ref) params.set('ref', selectedFile.ref)

    apiFetch(`/api/v2/git/diff?${params}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { setDiff(data); setLoading(false) })
      .catch(() => { setDiff(null); setLoading(false) })
  }, [selectedFile?.file, selectedFile?.ref])

  useEffect(() => {
    if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null }
    if (!containerRef.current || !diff) return

    const yamlLang = StreamLanguage.define(yaml)
    const extensions = [yamlLang, EditorView.editable.of(false), EditorState.readOnly.of(true)]

    viewRef.current = new MergeView({
      parent: containerRef.current,
      a: { doc: diff.original, extensions },
      b: { doc: diff.modified, extensions },
    })

    return () => { if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null } }
  }, [diff])

  if (!selectedFile) {
    return <Empty style={{ margin: 'auto' }} description="Select a file to view diff" />
  }

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><Spin /></div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
        <Text code style={{ fontSize: 12 }}>{diff?.file}</Text>
        {selectedFile.ref && <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{selectedFile.ref.slice(0, 7)}</Text>}
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto' }} />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/GitDiffViewer.jsx
git commit -m "feat: add GitDiffViewer with CodeMirror merge"
```

---

### Task 8: Frontend — Restructure GitPanel as orchestrator

**Files:**
- Modify: `src/components/GitPanel.jsx`

- [ ] **Step 1: Rewrite GitPanel.jsx**

Replace the entire contents of `src/components/GitPanel.jsx` with:

```jsx
import { useState } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Button, Typography, Space, Modal } from 'antd'
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

  const { branch, changeCount, behindMain, hasRemote } = gitStatus

  async function handlePush() {
    setLoading('push')
    try {
      const res = await apiFetch('/api/v2/git/push', { method: 'POST' })
      if (res.ok) onRefresh()
    } finally {
      setLoading(null)
    }
  }

  async function handlePull() {
    setLoading('pull')
    try {
      const res = await apiFetch('/api/v2/git/pull', { method: 'POST' })
      if (res.ok) onRefresh()
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
        await apiFetch('/api/v2/git/sync', { method: 'POST' })
        onRefresh()
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
          {hasRemote && (
            <>
              <Button
                icon={<CloudDownloadOutlined />}
                disabled={changeCount > 0}
                loading={loading === 'pull'}
                onClick={handlePull}
                size="small"
              >
                Pull
              </Button>
              <Button
                icon={<CloudUploadOutlined />}
                disabled={changeCount > 0}
                loading={loading === 'push'}
                onClick={handlePush}
                size="small"
              >
                Push
              </Button>
            </>
          )}
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
        <div style={{ width: 280, minWidth: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0' }}>
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
        </div>

        {/* Right column — diff viewer */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <GitDiffViewer selectedFile={selectedFile} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the app builds**

```bash
npx vite build 2>&1 | tee /tmp/build-output.log; grep -E 'error|warning|built' /tmp/build-output.log
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/GitPanel.jsx
git commit -m "feat: restructure GitPanel as two-column layout with tabs"
```

---

### Task 9: Deploy and verify

- [ ] **Step 1: Build and deploy to minikube**

```bash
skaffold delete --kube-context minikube && skaffold run --kube-context minikube
```

- [ ] **Step 2: Port-forward**

```bash
kubectl --context minikube port-forward --address 127.0.0.1 svc/proxy-public 12012:80
```

- [ ] **Step 3: Verify in browser**

Navigate to `https://jupyter-rulemgmt.rophyinc.com:8443`, log in as Alice via OIDC, and verify:

1. Git panel shows two-column layout with branch name, Pull/Push in header
2. Changes tab shows file list, clicking a file shows diff in right panel
3. History tab shows commit list, expanding a commit shows files, clicking a file shows commit diff
4. CodeMirror merge view renders side-by-side diff
5. Commit, Push, Discard still work as before

- [ ] **Step 4: Commit any fixes if needed**
