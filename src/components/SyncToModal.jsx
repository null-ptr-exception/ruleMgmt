import { useState, useEffect, useMemo } from 'react'
import { Modal, Checkbox, Tag, Input, List, message, Alert } from 'antd'
import { listAllDeployments, getSyncRegistry, createSync } from '../utils/chartApi'
import SyncProblems from './SyncProblems'
import { isReservedName, RESERVED_HINT } from '../utils/reservedNames'
import { templateChange } from '../utils/templateChange'
import { stackNote } from '../utils/stackNote'
import { syncResultLine } from '../utils/syncNotice'

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
  const [sourceChart, setSourceChart] = useState(null)
  // The _common the source renders on: a target inherits it (#103).
  const [sourceInherits, setSourceInherits] = useState(null)
  const [registry, setRegistry] = useState({ syncs: [] })
  const [selected, setSelected] = useState(new Set())
  const [acked, setAcked] = useState(new Set())
  const [newPath, setNewPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)
  // Why sync.yaml cannot be read: nothing is offered to overwrite.
  const [readError, setReadError] = useState(null)

  useEffect(() => {
    if (!open || !source) return
    setSelected(new Set())
    setAcked(new Set())
    setNewPath('')
    setResults(null)
    setReadError(null)
    ;(async () => {
      // Each folder's _common for the source's Template, which a target renders.
      const [all, reg] = await Promise.all([listAllDeployments(source.chart), getSyncRegistry()])
      if (reg.failed) {
        setReadError(reg.error)
        setCandidates([])
        setRegistry({ syncs: [] })
        return
      }
      setCandidates(all.filter(d => d.path !== source.path))
      setSourceChart(all.find(d => d.path === source.path)?.chart || null)
      setSourceInherits(all.find(d => d.path === source.path)?.inheritsFrom || null)
      setRegistry(reg)
      const sourceEntry = reg.syncs.find(s => s.source === source.path)
      setSelected(new Set(sourceEntry?.targets || []))
    })()
  }, [open, source])

  const rows = useMemo(
    () => candidates.map(c => ({ ...c, ...classify(registry, source?.path, c.path), change: templateChange(sourceChart, c) })),
    [candidates, registry, source, sourceChart]
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

  const newPathTrimmed = newPath.trim()
  // A manually-typed path must go through the same red/orange/disabled
  // classification as a picked-from-list row — otherwise typing an existing
  // deployment's path bypasses the overwrite-confirmation gate entirely.
  // Only classify it against the registry if it's an already-known
  // deployment; an unrecognized path is presumed genuinely new (created as
  // a copy of source, nothing to overwrite).
  const newPathStatus = useMemo(() => {
    if (!newPathTrimmed) return null
    if (newPathTrimmed === source?.path) {
      return { status: 'disabled', reason: 'cannot sync a deployment to itself' }
    }
    if (!candidates.some(c => c.path === newPathTrimmed)) {
      if (isReservedName(newPathTrimmed.split('/').filter(Boolean).pop())) {
        return { status: 'disabled', reason: RESERVED_HINT }
      }
      return { status: 'new', reason: 'will be created as a new deployment' }
    }
    return { ...classify(registry, source?.path, newPathTrimmed), change: templateChange(sourceChart, candidates.find(c => c.path === newPathTrimmed)) }
  }, [newPathTrimmed, candidates, registry, source, sourceChart])

  const needsAck = [
    ...rows.filter(r => selected.has(r.path) && (r.status === 'red' || r.status === 'orange')),
    ...(newPathStatus && (newPathStatus.status === 'red' || newPathStatus.status === 'orange')
      ? [{ path: newPathTrimmed, ...newPathStatus }]
      : []),
  ]
  const allAcked = needsAck.every(r => acked.has(r.path))
  const newPathBlocked = newPathStatus?.status === 'disabled'
  const canConfirm = !readError && (selected.size > 0 || newPathTrimmed.length > 0) && allAcked && !newPathBlocked && !submitting

  async function handleConfirm() {
    setSubmitting(true)
    const alreadySynced = registry.syncs.find(s => s.source === source.path)?.targets || []
    const targets = [...selected].filter(t => !alreadySynced.includes(t))
    if (newPathTrimmed) targets.push(newPathTrimmed)

    const outcomes = []
    for (const target of targets) {
      const result = await createSync(source.path, target)
      outcomes.push({ target, ok: result.ok, error: result.error, problems: result.problems })
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
      {readError ? (
        <Alert type="error" showIcon data-testid="sync-read-error" message={readError}
          description="Which deployments are synced is not known, so none is offered to sync to until it can be read." />
      ) : (<>
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
              style={{ flex: 1, minWidth: 120 }}
            >
              {r.path}
            </Checkbox>
            <Tag color={STATUS_COLOR[r.status]}>{r.reason}</Tag>
            {/* Also on a link already made: the next save of the source moves it. */}
            {r.change && r.status !== 'disabled' && <Tag color="red">{r.change}</Tag>}
            {r.status !== 'disabled' && stackNote(sourceInherits, r.folderCommon, 'will') && (
              // Long: it wraps, or it squeezes the checkbox out of the row.
              <Tag data-testid={`stack-note-${r.path}`} color="geekblue" style={{ whiteSpace: 'normal', maxWidth: '50%' }}>{stackNote(sourceInherits, r.folderCommon, 'will')}</Tag>
            )}
          </List.Item>
        )}
      />

      <div style={{ marginTop: 12 }}>
        <Input
          placeholder="Add new path (e.g. cpu/canary)"
          value={newPath}
          onChange={e => setNewPath(e.target.value)}
        />
        {newPathStatus && (
          <Tag style={{ marginTop: 6 }} color={STATUS_COLOR[newPathStatus.status]}>{newPathStatus.reason}</Tag>
        )}
        {newPathStatus?.status === 'new' && sourceInherits && (
          <Tag data-testid="stack-note-new" style={{ marginTop: 6 }} color="geekblue">will inherit {sourceInherits}, its source&apos;s</Tag>
        )}
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
                I understand, overwrite {r.path}{r.change ? ` — it ${r.change}` : ''}
              </Checkbox>
            </div>
          ))}
        </div>
      )}

      {results && (
        <Alert
          style={{ marginTop: 12 }}
          type={results.every(r => r.ok) ? 'success' : 'warning'}
          message={results.map(syncResultLine).join('; ')}
          // Every target is refused for the same source, so its problems once.
          description={results.some(r => r.problems?.length)
            ? <SyncProblems problems={results.find(r => r.problems?.length).problems} />
            : undefined}
        />
      )}
      </>)}
    </Modal>
  )
}
