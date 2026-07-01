import { useState, useEffect, useMemo } from 'react'
import { Modal, Checkbox, Tag, Input, List, message, Alert } from 'antd'
import { listAllDeployments, getSyncRegistry, createSync } from '../utils/chartApi'

const STATUS_COLOR = { 'green-locked': 'green', new: 'green', red: 'red', orange: 'orange', disabled: 'default' }

function classify(registry, sourcePath, candidatePath) {
  const sourceEntry = registry.syncs.find(s => s.source === sourcePath)
  if (sourceEntry?.targets.includes(candidatePath)) {
    return { status: 'green-locked', reason: 'already in sync, no change' }
  }

  const isSourceItself = registry.syncs.some(s => s.source === candidatePath && s.targets.length > 0)
  if (isSourceItself) {
    return { status: 'disabled', reason: 'is itself a sync source — cannot also be a target' }
  }

  const targetEntry = registry.syncs.find(s => s.targets.includes(candidatePath))
  if (targetEntry) {
    return { status: 'orange', reason: `synced from ${targetEntry.source} — switching will unlink it there` }
  }

  return { status: 'red', reason: 'will overwrite its content' }
}

export default function SyncToModal({ open, source, onClose, onSuccess }) {
  const [candidates, setCandidates] = useState([])
  const [registry, setRegistry] = useState({ syncs: [] })
  const [selected, setSelected] = useState(new Set())
  const [acked, setAcked] = useState(new Set())
  const [newPath, setNewPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)

  useEffect(() => {
    if (!open || !source) return
    setSelected(new Set())
    setAcked(new Set())
    setNewPath('')
    setResults(null)
    ;(async () => {
      const [all, reg] = await Promise.all([listAllDeployments(), getSyncRegistry()])
      setCandidates(all.filter(d => d.path !== source.path))
      setRegistry(reg)
      const sourceEntry = reg.syncs.find(s => s.source === source.path)
      setSelected(new Set(sourceEntry?.targets || []))
    })()
  }, [open, source])

  const rows = useMemo(
    () => candidates.map(c => ({ ...c, ...classify(registry, source?.path, c.path) })),
    [candidates, registry, source]
  )

  function toggle(row) {
    if (row.status === 'disabled' || row.status === 'green-locked') return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(row.path)) next.delete(row.path)
      else next.add(row.path)
      return next
    })
  }

  const needsAck = rows.filter(r => selected.has(r.path) && (r.status === 'red' || r.status === 'orange'))
  const allAcked = needsAck.every(r => acked.has(r.path))
  const newPathTrimmed = newPath.trim()
  const canConfirm = (selected.size > 0 || newPathTrimmed.length > 0) && allAcked && !submitting

  async function handleConfirm() {
    setSubmitting(true)
    const alreadySynced = registry.syncs.find(s => s.source === source.path)?.targets || []
    const targets = [...selected].filter(t => !alreadySynced.includes(t))
    if (newPathTrimmed) targets.push(newPathTrimmed)

    const outcomes = []
    for (const target of targets) {
      const result = await createSync(source.path, target)
      outcomes.push({ target, ok: result.ok, error: result.error })
    }
    setSubmitting(false)
    setResults(outcomes)

    const failed = outcomes.filter(o => !o.ok)
    if (outcomes.length === 0) {
      onClose()
      return
    }
    if (failed.length === 0) {
      message.success(`Synced ${outcomes.length} target${outcomes.length === 1 ? '' : 's'}`)
      onSuccess?.()
      onClose()
    } else {
      message.warning(`${outcomes.length - failed.length} of ${outcomes.length} succeeded`)
      onSuccess?.()
    }
  }

  return (
    <Modal
      title={`Sync to... (source: ${source?.path || ''})`}
      open={open}
      onCancel={onClose}
      onOk={handleConfirm}
      okText="Confirm sync"
      okButtonProps={{ disabled: !canConfirm, loading: submitting }}
      destroyOnClose
    >
      <List
        size="small"
        dataSource={rows}
        locale={{ emptyText: 'No other deployments found' }}
        renderItem={r => (
          <List.Item>
            <Checkbox
              checked={selected.has(r.path)}
              disabled={r.status === 'disabled' || r.status === 'green-locked'}
              onChange={() => toggle(r)}
              style={{ flex: 1 }}
            >
              {r.path}
            </Checkbox>
            <Tag color={STATUS_COLOR[r.status]}>{r.reason}</Tag>
          </List.Item>
        )}
      />

      <div style={{ marginTop: 12 }}>
        <Input
          placeholder="Add new path (e.g. cpu/canary)"
          value={newPath}
          onChange={e => setNewPath(e.target.value)}
        />
      </div>

      {needsAck.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {needsAck.map(r => (
            <div key={r.path}>
              <Checkbox
                checked={acked.has(r.path)}
                onChange={e => setAcked(prev => {
                  const next = new Set(prev)
                  if (e.target.checked) next.add(r.path)
                  else next.delete(r.path)
                  return next
                })}
              >
                I understand, overwrite {r.path}
              </Checkbox>
            </div>
          ))}
        </div>
      )}

      {results && (
        <Alert
          style={{ marginTop: 12 }}
          type={results.every(r => r.ok) ? 'success' : 'warning'}
          message={results.map(r => `${r.target}: ${r.ok ? 'OK' : r.error}`).join('; ')}
        />
      )}
    </Modal>
  )
}
