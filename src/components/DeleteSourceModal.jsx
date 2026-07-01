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
    for (const targetPath of targets) {
      if (decisions[targetPath] === 'delete') {
        const name = targetPath.split('/').pop()
        await deleteDeployment(source.chart, name, targetPath)
      } else {
        await unlinkSync(targetPath)
      }
    }
    await deleteDeployment(source.chart, source.name, source.path)
    setSubmitting(false)
    message.success(`Deleted ${source.name}`)
    onSuccess?.()
    onClose()
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
