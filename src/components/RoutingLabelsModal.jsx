import { useState } from 'react'
import { Alert, Button, Input, Modal, Select, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { checkRouting } from '../utils/routingGenerator'

const { Text } = Typography

/**
 * The table's dimensions (#93): the alert labels it routes by, and each one's
 * values. Opening routing sets them for the first time; changing them later
 * may leave cells outside the table, which the page confirms before
 * dropping.
 */
export default function RoutingLabelsModal({ open, labels, onOk, onCancel, title = 'Route by labels' }) {
  const initial = Object.keys(labels || {}).length
    ? Object.entries(labels).map(([name, values]) => ({ name, values: [...values] }))
    : [{ name: 'severity', values: [] }]
  const [rows, setRows] = useState(initial)
  const set = (i, patch) => setRows(r => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))

  const next = Object.fromEntries(rows.filter(r => r.name.trim()).map(r => [r.name.trim(), r.values]))
  const names = rows.map(r => r.name.trim()).filter(Boolean)
  const problems = [
    ...(new Set(names).size !== names.length ? ['a label is listed twice'] : []),
    ...checkRouting({ labels: next, configs: {}, cells: [] }),
  ]

  return (
    <Modal open={open} title={title} okText="Apply" onOk={() => onOk(next)} onCancel={onCancel}
      okButtonProps={{ disabled: problems.length > 0 }} width={560}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        The alert labels the table routes by, and the values each one takes. Every combination is a cell.
      </Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <Input aria-label={`Label ${i + 1} name`} placeholder="label, e.g. team" value={row.name} style={{ width: 150 }}
              onChange={e => set(i, { name: e.target.value })} />
            <Select mode="tags" aria-label={`Label ${i + 1} values`} placeholder="values — type one, press Enter"
              value={row.values} onChange={values => set(i, { values })} open={false} tokenSeparators={[',', ' ']}
              style={{ flex: 1 }} />
            <Button type="text" icon={<DeleteOutlined />} aria-label={`Remove label ${i + 1}`} disabled={rows.length === 1}
              onClick={() => setRows(r => r.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }}
          onClick={() => setRows(r => [...r, { name: '', values: [] }])}>
          Add label
        </Button>
        {problems.length > 0 && names.length > 0 && rows.some(r => r.values.length) && (
          <Alert type="warning" showIcon message={problems.map((p, i) => <div key={i}>{p}</div>)} />
        )}
      </div>
    </Modal>
  )
}
