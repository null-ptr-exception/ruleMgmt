import { useState, useEffect } from 'react'
import { Modal, Radio, Space, Typography, message } from 'antd'
import { unlinkSync, deleteDeployment } from '../utils/chartApi'

const { Text } = Typography

export default function DeleteSourceModal({ open, source, targets, onClose, onSuccess }) {
  const [decisions, setDecisions] = useState({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    const initial = {}
    for (const t of targets) initial[t] = 'keep'
    setDecisions(initial)
  }, [open, targets])

  async function handleConfirm() {
    setSubmitting(true)
    // Stop on the first failure rather than pressing on to delete the
    // source — if a target's unlink/delete didn't actually happen, deleting
    // the source out from under it leaves that target's sync.yaml entry
    // pointing at a deployment that no longer exists.
    let anyChange = false
    let succeeded = false
    try {
      for (const targetPath of targets) {
        const action = decisions[targetPath] === 'delete' ? 'delete' : 'unlink'
        const result = action === 'delete'
          ? await deleteDeployment(source.chart, targetPath.split('/').pop(), targetPath)
          : await unlinkSync(targetPath)
        if (!result.ok) {
          message.error(`Failed to ${action} ${targetPath}${result.error ? `: ${result.error}` : ''}`)
          return
        }
        anyChange = true
      }

      const result = await deleteDeployment(source.chart, source.name, source.path)
      if (!result.ok) {
        message.error(`Failed to delete ${source.name}${result.error ? `: ${result.error}` : ''}`)
        return
      }
      message.success(`Deleted ${source.name}`)
      succeeded = true
      onSuccess?.()
      onClose()
    } finally {
      setSubmitting(false)
      // Refresh the tree even on a partial failure — some targets may have
      // already been unlinked/deleted before the step that failed.
      if (anyChange && !succeeded) onSuccess?.()
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
