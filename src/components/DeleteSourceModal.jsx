import { useState, useEffect } from 'react'
import { Modal, Radio, Space, Typography, message } from 'antd'
import { deleteDeployment } from '../utils/chartApi'

const { Text } = Typography

// What a failure leaves said: the targets marked Delete that are gone already.
const alreadyGone = paths => (paths.length ? `; ${paths.join(', ')} ${paths.length === 1 ? 'was' : 'were'} deleted already` : '')

export default function DeleteSourceModal({ open, source, targets, onClose, onSuccess }) {
  const [decisions, setDecisions] = useState({})
  const [submitting, setSubmitting] = useState(false)

  // Keyed on target *content*, not the array reference — a re-render that
  // hands down a fresh-but-equal array (e.g. a future live-refresh of
  // deleteSourceInfo while the modal stays open) shouldn't wipe out
  // Keep/Delete choices the user already made.
  const targetsKey = targets.join('|')
  useEffect(() => {
    if (!open) return
    const initial = {}
    for (const t of targets) initial[t] = 'keep'
    setDecisions(initial)
  }, [open, targetsKey])

  async function handleConfirm() {
    setSubmitting(true)
    // Stop on the first failure rather than pressing on to delete the
    // source, so a target marked Delete is not left behind unlinked.
    let anyChange = false
    let succeeded = false
    // Paths actually removed from disk (deleted targets + the source) —
    // reported to onSuccess so the tree can drop a now-dangling selection.
    // Unlinked targets keep their content, so they don't belong here.
    const deletedPaths = []
    try {
      // Only the targets marked Delete need a call: deleting the source lets
      // go of the rest, which keep their content (#180).
      for (const targetPath of targets) {
        if (decisions[targetPath] !== 'delete') continue
        const result = await deleteDeployment(source.chart, targetPath.split('/').pop(), targetPath)
        if (!result.ok) {
          message.error(`Failed to delete ${targetPath}: ${result.error}${alreadyGone(deletedPaths)}`)
          return
        }
        anyChange = true
        deletedPaths.push(targetPath)
      }

      const result = await deleteDeployment(source.chart, source.name, source.path)
      if (!result.ok) {
        // The targets marked Delete are gone already: said, so the tree
        // without them is no surprise. The source keeps its other targets.
        message.error(`Failed to delete ${source.name}: ${result.error}${alreadyGone(deletedPaths)}`)
        return
      }
      const kept = result.unlinked?.length || 0
      message.success(`Deleted ${source.name}${kept ? `; ${kept} kept, no longer synced` : ''}`)
      succeeded = true
      deletedPaths.push(source.path)
      onSuccess?.(deletedPaths)
      onClose()
    } catch (err) {
      // deleteDeployment can reject outright (e.g. a network
      // failure), not just resolve with { ok: false } — without this the
      // rejection would escape as an unhandled promise rejection with no
      // feedback shown to the user. Optional chaining because a rejection
      // value isn't guaranteed to be an Error (or even non-null).
      message.error(err?.message || 'Delete failed')
    } finally {
      setSubmitting(false)
      // Refresh the tree even on a partial failure — the targets marked
      // Delete before the step that failed are gone.
      if (anyChange && !succeeded) onSuccess?.(deletedPaths)
    }
  }

  return (
    <Modal
      title={`Delete ${source?.name}`}
      open={open}
      onCancel={onClose}
      onOk={handleConfirm}
      okText={`Delete ${source?.name}`}
      okButtonProps={{ danger: true, loading: submitting }}
      destroyOnClose
    >
      <p>
        {targets.length} deployment{targets.length === 1 ? '' : 's'} synced to <Text strong>{source?.name}</Text>.
        Choose what to do with each.
      </p>
      <Space direction="vertical" style={{ width: '100%' }}>
        {targets.map(t => (
          <div key={t} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text>{t}</Text>
            <Radio.Group
              size="small"
              value={decisions[t]}
              onChange={e => setDecisions(prev => ({ ...prev, [t]: e.target.value }))}
            >
              <Radio.Button value="keep">Keep</Radio.Button>
              <Radio.Button value="delete">Delete</Radio.Button>
            </Radio.Group>
          </div>
        ))}
      </Space>
      <p style={{ marginTop: 8, fontSize: 12, color: '#888' }}>Keep = unlink and retain content</p>
    </Modal>
  )
}
