import { useState, useEffect, useMemo } from 'react'
import { Modal, Select, Checkbox, Alert, message } from 'antd'
import { listAllDeployments, getSyncRegistry, createSync } from '../utils/chartApi'

function classifySource(registry, candidatePath) {
  const isTargetOfOther = registry.syncs.some(s => s.targets.includes(candidatePath))
  if (isTargetOfOther) {
    return { status: 'disabled', reason: "already synced from another source — can't also become a source" }
  }
  return { status: 'valid' }
}

export default function SyncFromModal({ open, target, onClose, onSuccess }) {
  const [candidates, setCandidates] = useState([])
  const [registry, setRegistry] = useState({ syncs: [] })
  const [selectedSource, setSelectedSource] = useState(null)
  const [acked, setAcked] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || !target) return
    setSelectedSource(null)
    setAcked(false)
    ;(async () => {
      const [all, reg] = await Promise.all([listAllDeployments(), getSyncRegistry()])
      setCandidates(all.filter(d => d.path !== target.path))
      setRegistry(reg)
    })()
  }, [open, target])

  const rows = useMemo(
    () => candidates.map(c => ({ ...c, ...classifySource(registry, c.path) })),
    [candidates, registry]
  )

  // The target itself: is it currently synced elsewhere (switching, 🟠) or
  // independent with its own content (🔴)? Either way overwriting it needs
  // an explicit ack.
  const targetState = useMemo(() => {
    const entry = registry.syncs.find(s => s.targets.includes(target?.path))
    if (entry) return { status: 'orange', currentSource: entry.source }
    return { status: 'red' }
  }, [registry, target])

  const needsAck = targetState.status === 'red' || targetState.status === 'orange'
  const canConfirm = !!selectedSource && (!needsAck || acked) && !submitting

  async function handleConfirm() {
    setSubmitting(true)
    const result = await createSync(selectedSource, target.path)
    setSubmitting(false)
    if (result.ok) {
      message.success(`${target.name} now syncs from ${selectedSource}`)
      onSuccess?.()
      onClose()
    } else {
      message.error(result.error || 'Sync failed')
    }
  }

  return (
    <Modal
      title={`Sync from... (target: ${target?.path || ''})`}
      open={open}
      onCancel={onClose}
      onOk={handleConfirm}
      okText="Confirm sync"
      okButtonProps={{ disabled: !canConfirm, loading: submitting }}
      destroyOnClose
    >
      <Select
        style={{ width: '100%' }}
        placeholder="Follow source"
        value={selectedSource}
        onChange={setSelectedSource}
        options={rows.map(r => ({
          value: r.path,
          label: r.status === 'disabled' ? `${r.path} (${r.reason})` : r.path,
          disabled: r.status === 'disabled',
        }))}
      />

      {targetState.status === 'orange' && (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          message={`${target?.name} is currently synced from ${targetState.currentSource} — switching will unlink it there and overwrite its content.`}
        />
      )}
      {targetState.status === 'red' && (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          message={`${target?.name} has its own content — syncing will permanently overwrite it.`}
        />
      )}

      {needsAck && (
        <Checkbox style={{ marginTop: 12 }} checked={acked} onChange={e => setAcked(e.target.checked)}>
          I understand, overwrite {target?.name}
        </Checkbox>
      )}
    </Modal>
  )
}
