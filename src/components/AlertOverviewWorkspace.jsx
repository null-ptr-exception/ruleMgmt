import { useState, useMemo } from 'react'
import { Button, Input, Select, Tag, Typography } from 'antd'
import { SaveOutlined, CloseOutlined, RightOutlined } from '@ant-design/icons'
import AlertTable from './AlertTable'

const { Text } = Typography
const OPERATORS = ['>=', '<=', '>', '<', '=']

function WorkspaceFilterBar({ wsFilters, onWsFiltersChange, vars }) {
  const [pendingCol, setPendingCol] = useState('')
  const [pendingOp, setPendingOp] = useState('=')
  const [pendingVal, setPendingVal] = useState('')

  const allVarNames = [...new Set(vars.flatMap(v => v.map(x => x.name)))]

  function addFilter() {
    if (!pendingCol || pendingVal === '') return
    onWsFiltersChange({ ...wsFilters, [pendingCol]: { op: pendingOp, value: pendingVal } })
    setPendingCol('')
    setPendingVal('')
  }

  function removeFilter(key) {
    const next = { ...wsFilters }
    delete next[key]
    onWsFiltersChange(next)
  }

  const activeCount = Object.keys(wsFilters).length

  return (
    <div style={{ padding: '7px 12px', borderBottom: '1px solid #f0f0f0', background: '#fff', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>Workspace filter:</Text>
      {Object.entries(wsFilters).map(([col, f]) => (
        <Tag
          key={col}
          closable
          onClose={() => removeFilter(col)}
          color="blue"
          style={{ fontSize: 11, margin: 0 }}
        >
          {col} {f.op} {f.value}
        </Tag>
      ))}
      <Select
        size="small"
        placeholder="column"
        value={pendingCol || undefined}
        onChange={setPendingCol}
        style={{ width: 120 }}
        options={allVarNames.map(n => ({ value: n, label: n }))}
      />
      <Select
        size="small"
        value={pendingOp}
        onChange={setPendingOp}
        style={{ width: 60 }}
        options={OPERATORS.map(o => ({ value: o, label: o }))}
      />
      <Input
        size="small"
        placeholder="value"
        value={pendingVal}
        onChange={e => setPendingVal(e.target.value)}
        onPressEnter={addFilter}
        style={{ width: 80 }}
      />
      <Button size="small" onClick={addFilter} disabled={!pendingCol || pendingVal === ''}>Add</Button>
      {activeCount > 0 && (
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => onWsFiltersChange({})}>
          Clear all
        </Button>
      )}
    </div>
  )
}

function SectionPanel({ alertName, vars, rows, commonValues, filters, onFiltersChange, onUpdate, onDelete, onAdd }) {
  const [collapsed, setCollapsed] = useState(false)

  const matchCount = useMemo(() => {
    const hasFilters = Object.values(filters).some(f => f && f.value !== '' && f.value !== undefined)
    if (!hasFilters) return rows.length
    return rows.filter(row => {
      return Object.entries(filters).every(([varName, filter]) => {
        if (!filter || filter.value === '') return true
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
    }).length
  }, [rows, filters, vars])

  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{ padding: '8px 12px', background: '#fafafa', borderBottom: collapsed ? 'none' : '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
      >
        <RightOutlined style={{ fontSize: 10, color: '#9ca3af', transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }} />
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{alertName}</span>
        <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', border: '0.5px solid #e5e7eb', borderRadius: 8, padding: '0 6px' }}>
          {matchCount} / {rows.length} rows
        </span>
      </div>
      {!collapsed && (
        <div style={{ padding: '10px 12px' }}>
          <AlertTable
            vars={vars}
            rows={rows}
            commonValues={commonValues}
            filters={filters}
            onFiltersChange={onFiltersChange}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onAdd={onAdd}
          />
        </div>
      )}
    </div>
  )
}

export default function AlertOverviewWorkspace({
  checkedAlerts,
  allValues,
  commonValues,
  schema,
  onAllValuesChange,
  onSave,
  dirty,
  saveStatus,
  getVars,
}) {
  const [wsFilters, setWsFilters] = useState({})
  const [sectionFilters, setSectionFilters] = useState({})

  const allVars = checkedAlerts.map(name => getVars(name))

  function handleSectionFiltersChange(alertName, filters) {
    setSectionFilters(prev => ({ ...prev, [alertName]: filters }))
  }

  function mergedFilters(alertName) {
    const section = sectionFilters[alertName] || {}
    const merged = { ...wsFilters }
    Object.entries(section).forEach(([k, v]) => {
      if (v && v.value !== '') merged[k] = v
    })
    return merged
  }

  function handleUpdate(alertName, updated) {
    onAllValuesChange({ ...allValues, [alertName]: updated })
  }

  function handleDelete(alertName, realIndex) {
    const updated = (allValues[alertName] || []).filter((_, i) => i !== realIndex)
    onAllValuesChange({ ...allValues, [alertName]: updated })
  }

  function handleAdd(alertName, newRow) {
    const updated = [...(allValues[alertName] || []), newRow]
    onAllValuesChange({ ...allValues, [alertName]: updated })
  }

  if (checkedAlerts.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>
        Select alert types from the sidebar to get started
      </div>
    )
  }

  const activeWsFilterCount = Object.keys(wsFilters).length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <WorkspaceFilterBar
        wsFilters={wsFilters}
        onWsFiltersChange={setWsFilters}
        vars={allVars}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {checkedAlerts.map(alertName => (
          <SectionPanel
            key={alertName}
            alertName={alertName}
            vars={getVars(alertName)}
            rows={allValues[alertName] || []}
            commonValues={commonValues}
            filters={mergedFilters(alertName)}
            onFiltersChange={f => handleSectionFiltersChange(alertName, f)}
            onUpdate={updated => handleUpdate(alertName, updated)}
            onDelete={realIndex => handleDelete(alertName, realIndex)}
            onAdd={newRow => handleAdd(alertName, newRow)}
          />
        ))}
      </div>
      <div style={{ padding: '10px 16px', borderTop: '1px solid #f0f0f0', background: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={onSave} disabled={!dirty}>Save all</Button>
        <Text style={{ fontSize: 11, color: '#9ca3af' }}>
          {checkedAlerts.length} section{checkedAlerts.length > 1 ? 's' : ''} loaded
          {activeWsFilterCount > 0 ? ` · ${activeWsFilterCount} workspace filter${activeWsFilterCount > 1 ? 's' : ''} active` : ''}
        </Text>
        {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
      </div>
    </div>
  )
}
