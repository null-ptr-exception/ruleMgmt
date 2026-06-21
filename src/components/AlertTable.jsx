import { useCallback, useState } from 'react'
import { Table, Button, Input, InputNumber, Select, Checkbox, Space, Tooltip } from 'antd'
import { DeleteOutlined, PlusOutlined, FilterOutlined, CloseCircleOutlined } from '@ant-design/icons'

const NUMBER_OPS = [
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '=', label: '=' },
]

function matchesFilter(row, varName, filter) {
  if (!filter || filter.value === '' || filter.value === null || filter.value === undefined) return true
  const cellVal = row[varName]
  if (filter.isNumber) {
    const num = Number(cellVal)
    const fnum = Number(filter.value)
    if (isNaN(num) || isNaN(fnum)) return true
    switch (filter.op) {
      case '>=': return num >= fnum
      case '<=': return num <= fnum
      case '>':  return num > fnum
      case '<':  return num < fnum
      case '=':  return num === fnum
      default:   return true
    }
  }
  return String(cellVal ?? '').toLowerCase().includes(String(filter.value).toLowerCase())
}

function applyFilters(rows, filters, matchMode) {
  const activeFilters = Object.entries(filters).filter(([, f]) => f && f.value !== '' && f.value !== null && f.value !== undefined)
  if (activeFilters.length === 0) return rows.map((r, i) => ({ ...r, __realIndex: i }))

  return rows
    .map((r, i) => ({ ...r, __realIndex: i }))
    .filter(r => {
      const results = activeFilters.map(([varName, filter]) => matchesFilter(r, varName, filter))
      return matchMode === 'any' ? results.some(Boolean) : results.every(Boolean)
    })
}

function FilterPopover({ varName, filter, isNumber, onChange }) {
  return (
    <div style={{ padding: 8, minWidth: 180 }}>
      {isNumber ? (
        <Space.Compact style={{ width: '100%' }}>
          <Select
            size="small"
            value={filter?.op ?? '>='}
            onChange={op => onChange(varName, { ...filter, op, isNumber: true })}
            options={NUMBER_OPS}
            style={{ width: 70 }}
          />
          <InputNumber
            size="small"
            value={filter?.value ?? ''}
            onChange={val => onChange(varName, { op: filter?.op ?? '>=', value: val, isNumber: true })}
            style={{ width: '100%' }}
            placeholder="value"
          />
        </Space.Compact>
      ) : (
        <Input
          size="small"
          value={filter?.value ?? ''}
          onChange={e => onChange(varName, { value: e.target.value, isNumber: false })}
          placeholder="search..."
          allowClear
        />
      )}
    </div>
  )
}

export default function AlertTable({ vars = [], rows = [], onUpdate, onDelete, onAdd, commonValues = {} }) {
  const [filters, setFilters] = useState({})
  const [matchMode, setMatchMode] = useState('all')
  const [openFilter, setOpenFilter] = useState(null)

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

  const handleFilterChange = useCallback((varName, filter) => {
    setFilters(prev => ({ ...prev, [varName]: filter }))
  }, [])

  const handleReset = useCallback(() => {
    setFilters({})
    setMatchMode('all')
    setOpenFilter(null)
  }, [])

  const activeFilterCount = Object.values(filters).filter(f => f && f.value !== '' && f.value !== null && f.value !== undefined).length

  const filteredRows = applyFilters(rows, filters, matchMode)

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
      const isNumber = v.type === 'number' || v.type === 'integer'
      const hasFilter = !isCommon && filters[v.name]?.value !== '' && filters[v.name]?.value !== null && filters[v.name]?.value !== undefined && filters[v.name] !== undefined

      return {
        title: (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
            <span>{v.name}</span>
            {!isCommon && (
              <Tooltip
                title={
                  <FilterPopover
                    varName={v.name}
                    filter={filters[v.name]}
                    isNumber={isNumber}
                    onChange={handleFilterChange}
                  />
                }
                trigger="click"
                open={openFilter === v.name}
                onOpenChange={open => setOpenFilter(open ? v.name : null)}
                color="#fff"
                overlayInnerStyle={{ padding: 0 }}
              >
                <FilterOutlined
                  style={{
                    fontSize: 11,
                    cursor: 'pointer',
                    color: hasFilter ? '#1677ff' : '#bfbfbf',
                    background: hasFilter ? '#e6f4ff' : 'transparent',
                    borderRadius: 3,
                    padding: 2,
                  }}
                />
              </Tooltip>
            )}
          </div>
        ),
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

  return (
    <div>
      {/* Filter toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Select
          size="small"
          value={matchMode}
          onChange={setMatchMode}
          style={{ width: 120 }}
          options={[
            { value: 'all', label: 'Match: ALL' },
            { value: 'any', label: 'Match: ANY' },
          ]}
        />
        {activeFilterCount > 0 && (
          <Button
            size="small"
            icon={<CloseCircleOutlined />}
            onClick={handleReset}
          >
            Reset ({activeFilterCount})
          </Button>
        )}
      </div>

      <Table
        dataSource={filteredRows.map(r => ({ ...r, key: r.__realIndex }))}
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
