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
      if (v.default !== undefined) newRow[v.name] = v.default
      else if (v.type === 'boolean') newRow[v.name] = false
      else if (v.type === 'number' || v.type === 'integer') newRow[v.name] = 0
      else newRow[v.name] = ''
    })
    onAdd(newRow)
  }, [vars, onAdd])

  const renderInput = (v, row, rowIdx) => {
    const val = row[v.name]
    if (v.type === 'boolean') {
      return (
        <Checkbox
          checked={!!val}
          onChange={e => handleCellChange(rowIdx, v.name, e.target.checked)}
        />
      )
    }
    if (v.type === 'number' || v.type === 'integer') {
      return (
        <InputNumber
          size="small"
          step={v.type === 'integer' ? 1 : 'any'}
          value={val ?? ''}
          onChange={value => handleCellChange(rowIdx, v.name, value)}
          style={{ width: '100%' }}
        />
      )
    }
    if (v.enum) {
      return (
        <Select
          size="small"
          value={val ?? ''}
          onChange={value => handleCellChange(rowIdx, v.name, value)}
          style={{ width: '100%' }}
          options={v.enum.map(opt => ({ value: opt, label: opt }))}
        />
      )
    }
    return (
      <Input
        size="small"
        value={val ?? ''}
        onChange={e => handleCellChange(rowIdx, v.name, e.target.value)}
      />
    )
  }

  const columns = [
    ...vars.map(v => ({
      title: v.name,
      dataIndex: v.name,
      key: v.name,
      render: (_, row, rowIdx) => renderInput(v, row, rowIdx),
    })),
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_, __, rowIdx) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />}
          onClick={() => onDelete(rowIdx)} />
      )
    }
  ]

  return (
    <div>
      <Table
        dataSource={rows.map((r, i) => ({ ...r, key: i }))}
        columns={columns}
        pagination={false}
        size="small"
        bordered
      />
      <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }}
        onClick={handleAdd}>
        Add instance
      </Button>
    </div>
  )
}
