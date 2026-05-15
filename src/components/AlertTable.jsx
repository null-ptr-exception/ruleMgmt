import { useCallback } from 'react'
import { Table, Button, Input, InputNumber, Select, Checkbox } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

export default function AlertTable({ vars = [], rows = [], onUpdate, onDelete, onAdd }) {
  const handleCellChange = useCallback((rowIdx, varName, value) => {
    const updated = rows.map((r, i) =>
      i === rowIdx ? { ...r, [varName]: value } : r
    )
    onUpdate(updated)
  }, [rows, onUpdate])

  const handleAdd = useCallback(() => {
    const newRow = {}
    vars.forEach(v => {
      newRow[v.name] = v.default ?? (v.type === 'boolean' ? false : v.type === 'number' ? 0 : '')
    })
    onAdd(newRow)
  }, [vars, onAdd])

  const renderInput = (v, row, rowIdx) => {
    const val = row[v.name]
    switch (v.type) {
      case 'boolean':
        return (
          <Checkbox
            checked={!!val}
            onChange={e => handleCellChange(rowIdx, v.name, e.target.checked)}
          />
        )
      case 'number':
        return (
          <InputNumber
            size="small"
            step="any"
            value={val ?? ''}
            onChange={value => handleCellChange(rowIdx, v.name, value)}
            style={{ width: '100%' }}
          />
        )
      case 'list':
        return (
          <Select
            size="small"
            value={val ?? ''}
            onChange={value => handleCellChange(rowIdx, v.name, value)}
            style={{ width: '100%' }}
            options={(v.options || []).map(opt => ({ value: opt, label: opt }))}
          />
        )
      default:
        return (
          <Input
            size="small"
            value={val ?? ''}
            onChange={e => handleCellChange(rowIdx, v.name, e.target.value)}
          />
        )
    }
  }

  const columns = [
    ...vars.map(v => ({
      title: v.name,
      dataIndex: v.name,
      key: v.name,
      render: (_, row, rowIdx) => renderInput(v, row, rowIdx),
    })),
    {
      title: 'Actions',
      key: 'actions',
      width: 70,
      render: (_, _row, rowIdx) => (
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={() => onDelete(rowIdx)}
        />
      ),
    },
  ]

  return (
    <div>
      <Table
        columns={columns}
        dataSource={rows.map((r, i) => ({ ...r, key: i }))}
        pagination={false}
        size="small"
        bordered
        locale={{ emptyText: 'No alert instances' }}
      />
      <div style={{ padding: '8px 0' }}>
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={handleAdd}>
          Add Row
        </Button>
      </div>
    </div>
  )
}
