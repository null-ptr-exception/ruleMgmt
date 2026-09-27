import { useCallback, useMemo, useState } from 'react'
import { Table, Button, Input, InputNumber, Select, Checkbox, Tooltip, Modal, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined, FilterOutlined, BranchesOutlined } from '@ant-design/icons'
import { selectorCells, directChildren, parentOf, ANY } from '../utils/selectorContract'
import { matchesFilter, getFilterOperators } from '../utils/filterUtils'
import { buildNewRow } from '../utils/valueUtils'

function FilterHeader({ varName, varDef, filter, onChange }) {
  const ops = getFilterOperators(varDef)
  const isNumeric = varDef && (varDef.type === 'number' || varDef.type === 'integer')
  const isNumericEnum = varDef?.type === 'enum' && typeof varDef.enum?.[0] === 'number'
  const active = filter && filter.value !== '' && filter.value != null
  const defaultOp = ops[0]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{varName}</span>
        {active && <FilterOutlined style={{ fontSize: 10, color: '#1677ff' }} />}
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        <Select
          size="small"
          value={filter?.op ?? defaultOp}
          onChange={op => onChange({ ...filter, op })}
          style={{ width: (isNumeric || isNumericEnum) ? 52 : ops.length === 1 ? 44 : 76 }}
          options={ops.map(o => ({ value: o, label: o }))}
        />
        <Input
          size="small"
          value={filter?.value ?? ''}
          placeholder="value"
          onChange={e => onChange({ op: filter?.op ?? defaultOp, value: e.target.value })}
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
  effectiveFilters,
  onFiltersChange,
  readOnly = false,
  scrollContainer = null,
  stickyOffsetHeader = 0,
  // The group's selector hierarchy (#60) and its levels' defaults: adds the
  // derived Scope column and "Add exception".
  selectors = null,
  selectorDefaults = {},
}) {
  const [exception, setException] = useState(null)
  const activeFilters = effectiveFilters ?? filters
  const filteredRows = useMemo(() => {
    const hasFilters = Object.values(activeFilters).some(f => f && f.value !== '' && f.value !== undefined)
    if (!hasFilters) return rows.map((r, i) => ({ ...r, __realIndex: i }))
    return rows
      .map((r, i) => ({ ...r, __realIndex: i }))
      .filter(r => matchesFilter(r, activeFilters, vars, commonValues))
  }, [rows, activeFilters, vars, commonValues])

  const handleCellChange = useCallback((realIndex, varName, value) => {
    const updated = rows.map((r, i) => i === realIndex ? { ...r, [varName]: value } : r)
    onUpdate(updated)
  }, [rows, onUpdate])

  const handleAdd = useCallback(() => {
    onAdd(buildNewRow(vars, commonValues))
  }, [vars, onAdd, commonValues])

  const renderInput = (v, row, realIndex) => {
    const val = row[v.name]
    if (v.type === 'boolean') {
      return (
        <Checkbox
          checked={!!val}
          disabled={readOnly}
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
          disabled={readOnly}
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
          disabled={readOnly}
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
        disabled={readOnly}
        onChange={e => handleCellChange(realIndex, v.name, e.target.value)}
      />
    )
  }

  // Which rows each row gives up, and which row it is an exception to —
  // derived from every row, never stored. Exclusion does not change how
  // many alerts there are, so without this column the dependency between
  // rows would be invisible.
  const scope = useMemo(() => {
    if (!selectors?.length) return null
    const sels = rows.map(r => selectorCells(r, commonValues, selectorDefaults, selectors))
    return { sels, children: directChildren(sels, selectors), parent: parentOf(sels, selectors) }
  }, [rows, commonValues, selectorDefaults, selectors])
  const path = sel => selectors.map(l => sel[l]).join(' / ')

  // An exception is one step more specific than its row, in one level the
  // row leaves at .* — the only way to add one here, so a crossing or a
  // skipped level cannot be made from it.
  function addException() {
    const { index, level, value } = exception
    const next = { ...rows[index], [level]: value.trim() }
    const updated = [...rows.slice(0, index + 1), next, ...rows.slice(index + 1)]
    onUpdate(updated)
    setException(null)
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
    ...(scope ? [{
      title: 'Scope',
      key: 'scope',
      width: 180,
      render: (_, row) => {
        const i = row.__realIndex
        const kids = scope.children[i]
        const parent = scope.parent[i]
        return (
          <span data-testid={`scope-${i}`} style={{ fontSize: 12, color: '#595959' }}>
            {parent >= 0 && <div>exception to ↑ {path(scope.sels[parent])}</div>}
            {kids.length > 0 && (
              <Tooltip title={kids.map(k => path(scope.sels[k])).join(', ')}>
                <div style={{ cursor: 'help' }}>excludes {kids.length}</div>
              </Tooltip>
            )}
          </span>
        )
      },
    }] : []),
    {
      title: '',
      key: 'actions',
      width: scope ? 80 : 50,
      render: (_, row) => {
        const i = row.__realIndex
        const open = scope ? selectors.filter(l => scope.sels[i][l] === ANY) : []
        return (
          <span style={{ whiteSpace: 'nowrap' }}>
            {scope && (
              <Tooltip title="Add exception: a row one step more specific, in one level">
                <Button type="text" size="small" icon={<BranchesOutlined />} aria-label={`Add exception to row ${i + 1}`}
                  disabled={readOnly || open.length === 0}
                  onClick={() => setException({ index: i, level: open[0], value: '' })} />
              </Tooltip>
            )}
            <Button type="text" danger size="small" icon={<DeleteOutlined />} disabled={readOnly}
              onClick={() => onDelete(i)} />
          </span>
        )
      },
    }
  ]

  const hasActiveFilter = Object.values(activeFilters).some(f => f && f.value !== '' && f.value != null)
  const emptyText = hasActiveFilter ? 'No rows match current filter' : 'No data'

  return (
    <div>
      <Table
        dataSource={filteredRows.map(r => ({ ...r, key: r.__realIndex }))}
        columns={columns}
        pagination={false}
        size="small"
        bordered
        locale={{ emptyText }}
        sticky={scrollContainer ? { getContainer: () => scrollContainer, offsetHeader: stickyOffsetHeader } : false}
      />
      <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }}
        onClick={handleAdd} disabled={readOnly}>
        Add instance
      </Button>
      {exception && (
        <Modal open title={`Exception to ${path(scope.sels[exception.index])}`} okText="Add"
          okButtonProps={{ disabled: !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(exception.value.trim()) }}
          onOk={addException} onCancel={() => setException(null)}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            A copy of this row, more specific in one level. It takes over that part from this row,
            with values of its own.
          </Typography.Text>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Select size="small" aria-label="Exception level" style={{ width: 140 }} value={exception.level}
              options={selectors.filter(l => scope.sels[exception.index][l] === ANY).map(l => ({ value: l, label: l }))}
              onChange={level => setException(e => ({ ...e, level }))} />
            <Input size="small" aria-label="Exception value" placeholder="a name, e.g. api" autoFocus
              value={exception.value} onChange={e => setException(x => ({ ...x, value: e.target.value }))}
              onPressEnter={() => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(exception.value.trim()) && addException()} />
          </div>
        </Modal>
      )}
    </div>
  )
}
