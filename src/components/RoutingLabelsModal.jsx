import { useState } from 'react'
import { Alert, Button, Input, Modal, Select, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { checkRouting } from '../utils/routingGenerator'

const { Text } = Typography

/**
 * The table's dimensions (#93): the alert labels it routes by, and each one's
 * values. Opening routing sets them for the first time. Changing them later
 * keeps the cells (#94): a label added copies them, one taken away merges
 * them, a renamed one keeps them; a value taken away drops its cells, which
 * the page confirms first.
 */
export default function RoutingLabelsModal({ open, labels, onOk, onCancel, title = 'Route by labels' }) {
  // `was`: the name a row had when the dialog opened, so a renamed label
  // keeps its cells (#94). A row added here has none.
  const initial = Object.keys(labels || {}).length
    ? Object.entries(labels).map(([name, values]) => ({ name, values: [...values], was: name }))
    : [{ name: 'severity', values: [] }]
  const [rows, setRows] = useState(initial)
  const set = (i, patch) => setRows(r => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  // A value with a tab or a line break was refused (#222): Enter ends a
  // value, so it could only be pasted. Such a value is written by hand.
  const [refused, setRefused] = useState(false)
  const breaks = v => /[\t\r\n]/.test(v)
  function setValues(i, row, values) {
    const typed = values.filter(v => !row.values.includes(v)).map(v => v.trim())
    setRefused(typed.some(breaks))
    if (typed.some(breaks)) return
    set(i, { values: [...new Set(values.map(v => (row.values.includes(v) ? v : v.trim())).filter(v => v !== ''))] })
  }
  function paste(e) {
    if (!breaks(e.clipboardData.getData('text').trim())) return
    e.preventDefault()
    setRefused(true)
  }
  // A value added here that holds ", " may be meant as several: said, not refused.
  const several = rows.flatMap(r => r.values.filter(v => v.includes(', ') && !(labels?.[r.was] || []).includes(v)))

  const next = Object.fromEntries(rows.filter(r => r.name.trim()).map(r => [r.name.trim(), r.values]))
  const names = rows.map(r => r.name.trim()).filter(Boolean)
  const problems = [
    ...(new Set(names).size !== names.length ? ['a label is listed twice'] : []),
    ...checkRouting({ labels: next, configs: {}, cells: [] }),
  ]

  return (
    <Modal open={open} title={title} okText="Apply" onCancel={onCancel}
      onOk={() => onOk(rows.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), values: r.values, was: r.was })))}
      okButtonProps={{ disabled: problems.length > 0 }} width={560}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        The alert labels the table routes by, and the values each one takes. Every combination is a cell.
      </Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <Input aria-label={`Label ${i + 1} name`} placeholder="label, e.g. team" value={row.name} style={{ width: 150 }}
              onChange={e => set(i, { name: e.target.value })} />
            {/* Only Enter ends a value: spaces, commas and other symbols are
                part of it, as routing.yaml and Alertmanager take them. A value
                typed here loses its outer blanks; one with a tab or a line
                break is not added (it is written in routing.yaml by hand); one
                already in the file is kept as written. */}
            <div style={{ flex: 1, display: 'flex' }} onPasteCapture={paste}>
              <Select mode="tags" aria-label={`Label ${i + 1} values`} placeholder="type a value, press Enter"
                value={row.values} open={false} style={{ flex: 1 }} onChange={values => setValues(i, row, values)} />
            </div>
            <Button type="text" icon={<DeleteOutlined />} aria-label={`Remove label ${i + 1}`} disabled={rows.length === 1}
              onClick={() => setRows(r => r.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }}
          onClick={() => setRows(r => [...r, { name: '', values: [] }])}>
          Add label
        </Button>
        {refused && (
          <Alert type="error" showIcon message="A tab or a line break cannot be typed here: to use one, write it in routing.yaml by hand." />
        )}
        {several.map(v => <Alert key={v} type="info" showIcon message={`"${v}" looks like several values — add them one by one?`} />)}
        {problems.length > 0 && (names.length > 0 ? rows.some(r => r.values.length) : rows.some(r => r.was !== undefined)) && (
          <Alert type="warning" showIcon message={problems.map((p, i) => <div key={i}>{p}</div>)} />
        )}
      </div>
    </Modal>
  )
}
