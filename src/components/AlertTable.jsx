import { useCallback, useMemo } from 'react'
import { Table, Button, Input, InputNumber, Select, Checkbox } from 'antd'
import { DeleteOutlined, PlusOutlined, FilterOutlined } from '@ant-design/icons'

const OPERATORS = ['>=', '<=', '>', '<', '=']

function matchesFilter(row, filters, vars) {
  return Object.entries(filters).every(([varName, filter]) => {
    if (!filter || (filter.value === '' && filter.value !== 0)) return true
    const v = vars.find(v => v.name === varName)
    const cellVal = row[varName]
    if (v && (v.type === 'number' || v.type === 'integer')) {
      const num = parseFloat(cellVal)
      const fnum = parseFloat(filter.value)
      if (isNaN(num) || isNaN(fnum)) return false
      switch (filter.op) {
        case '>=': return num >= fnum
        case '<=': return num <= fnum
        case '>':  return num > fnum
        case '<':  return num < fnum
        case '=':  return num === fnum
        default:   return true
      }
    }
    return String(cellVal ?? '').includes(String(filter.value))
  })
}

function FilterHeader({ varName, varDef, filter, onChange }) {
  const isNumeric = varDef && (varDef.type === 'number' || varDef.type === 'integer')
  const active = filter && filter.value !== '' && filter.value !== undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{varName}</span>
        {active && <FilterOutlined style={{ fontSize: 10, color: '#1677ff' }} />}
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        {isNumeric && (
          <Select
            size="small"
            value={filter?.op ?? '>='}
            onChange={op => onChange({ ...filter, op })}
            style={{ width: 52 }}
            options={OPERATORS.map(o => ({ value: o, label: o }))}
          />
        )}
        <Input
          size="small"
          value={filter?.value ?? ''}
          placeholder="filter"
          onChange={e => onChange({ op: filter?.op ?? '>=', value: e.target.value })}
          style={{ width: isNumeric ? 60 : '100%' }}
        />
      </div>
    </div>
  )
}

export default function AlertTable({
  vars = [],
  rows = [],
  onUpdate,
  onDelete,
  onAdd,
  commonValues = {},
  filters = {},
  onFiltersChange,
}) {
  const filteredRows = useMemo(() => {
    const hasFilters = Object.values(filters).some(f => f && f.value !== '' && f.value !== undefined)
    if (!hasFilters) return rows.map((r, i) => ({ ...r, __realIndex: i }))
    return rows
      .map((r, i) => ({ ...r, __realIndex: i }))
      .filter(r => matchesFilter(r, filters, vars))
  }, [rows, filters, vars])

  const handleCellChange = useCallback((realIndex, varName, value) => {
    const updated = rows.map((r, i) => i === realIndex ? { ...r, [varName]: value } : r)
    onUpdate(updated)
  }, [rows, onUpdate])

  const handleAdd = useCallback(() => {
    const newRow = {}
    vars.forEach(v => {
      if (v.name in commonValues) return
      if (v.default !== undefined) newRow[v.name] = v.default
      else if (v.type === 'boolean') newRow[v.name] = false
      else if (v.type === 'number' || v.type === 'integer') newRow[v.name] = 0
      else newRow[v.name] = ''
    })
    onAdd(newRow)
  }, [vars, onAdd, commonValues])

  const renderInput = (v, row, realIndex) => {
    const val = row[v.name]
    if (v.type === 'boolean') {
      return (
        <Checkbox
          checked={!!val}
          onChange={e => handleCellChange(realIndex, v.name, e.target.checked)}
        />
      )
    }
    if (v.type === 'number' || v.type === 'integer') {
      return (
        <InputNumber
          size="small"
          step={v.type === 'integer' ? 1 : 'any'}
          value={val ?? ''}
          onChange={value => handleCellChange(realIndex, v.name, value)}
          style={{ width: '100%' }}
        />
      )
    }
    if (v.enum) {
      return (
        <Select
          size="small"
          value={val ?? ''}
          onChange={value => handleCellChange(realIndex, v.name, value)}
          style={{ width: '100%' }}
          options={v.enum.map(opt => ({ value: opt, label: opt }))}
        />
      )
    }
    return (
      <Input
        size="small"
        value={val ?? ''}
        onChange={e => handleCellChange(realIndex, v.name, e.target.value)}
      />
    )
  }

  const columns = [
    ...vars.map(v => {
      const isCommon = v.name in commonValues
      return {
        title: onFiltersChange
          ? <FilterHeader
              varName={v.name}
              varDef={v}
              filter={filters[v.name]}
              onChange={f => onFiltersChange({ ...filters, [v.name]: f })}
            />
          : v.name,
        dataIndex: v.name,
        key: v.name,
        render: (_, row) => isCommon
          ? <span style={{ fontSize: 13, color: '#8c8c8c', padding: '0 7px' }}>{commonValues[v.name]}</span>
          : renderInput(v, row, row.__realIndex),
      }
    }),
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_, row) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />}
          onClick={() => onDelete(row.__realIndex)} />
      )
    }
  ]

  const isEmpty = filteredRows.length === 0 && rows.length > 0

  return (
    <div>
      {isEmpty && (
        <div style={{ padding: '12px 0', textAlign: 'center', color: '#8c8c8c', fontSize: 13, fontStyle: 'italic' }}>
          No rows match current filter
        </div>
      )}
      <Table
        dataSource={filteredRows.map(r => ({ ...r, key: r.__realIndex }))}
        columns={columns}
        pagination={false}
        size="small"
        bordered
        style={{ display: isEmpty ? 'none' : undefined }}
      />
      <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }}
        onClick={handleAdd}>
        Add instance
      </Button>
    </div>
  )
}
