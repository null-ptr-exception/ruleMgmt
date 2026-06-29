import { useState, useMemo } from 'react'
import { Button, Input, Select, Tag, Typography } from 'antd'
import { SaveOutlined, CloseOutlined, RightOutlined } from '@ant-design/icons'
import AlertTable from './AlertTable'
import { matchesFilter, getFilterOperators, mergeFilters } from '../utils/filterUtils'

const { Text } = Typography

function WorkspaceFilterBar({ wsFilters, onWsFiltersChange, vars }) {
  const [pendingKey, setPendingKey] = useState('')  // "name::type"
  const [pendingOp, setPendingOp] = useState('contains')
  const [pendingVal, setPendingVal] = useState('')

  // Dedupe by name+type — keeps separate entries for same-named columns with different types
  const colOptions = useMemo(() => {
    const seen = new Set()
    const result = []
    for (const v of vars.flatMap(v => v)) {
      const key = `${v.name}::${v.type}`
      if (!seen.has(key)) { seen.add(key); result.push(v) }
    }
    return result
  }, [vars])

  // Names that appear with more than one type need a "(type)" suffix to disambiguate
  const ambiguous = useMemo(() => {
    const counts = new Map()
    for (const v of colOptions) counts.set(v.name, (counts.get(v.name) || 0) + 1)
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n))
  }, [colOptions])

  const selectOptions = colOptions.map(v => ({
    value: `${v.name}::${v.type}`,
    label: ambiguous.has(v.name) ? `${v.name} (${v.type})` : v.name,
  }))

  const pendingVarDef = colOptions.find(v => `${v.name}::${v.type}` === pendingKey)
  const pendingColName = pendingKey.split('::')[0]
  const ops = getFilterOperators(pendingVarDef)

  function handleColChange(key) {
    setPendingKey(key)
    const varDef = colOptions.find(v => `${v.name}::${v.type}` === key)
    setPendingOp(getFilterOperators(varDef)[0])
  }

  function addFilter() {
    if (!pendingColName || pendingVal === '') return
    onWsFiltersChange({ ...wsFilters, [pendingColName]: { op: pendingOp, value: pendingVal } })
    setPendingKey('')
    setPendingVal('')
    setPendingOp('contains')
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
        value={pendingKey || undefined}
        onChange={handleColChange}
        style={{ width: 140 }}
        options={selectOptions}
      />
      <Select
        size="small"
        value={pendingOp}
        onChange={setPendingOp}
        style={{ width: 80 }}
        options={ops.map(o => ({ value: o, label: o }))}
      />
      <Input
        size="small"
        placeholder="value"
        value={pendingVal}
        onChange={e => setPendingVal(e.target.value)}
        onPressEnter={addFilter}
        style={{ width: 80 }}
      />
      <Button size="small" onClick={addFilter} disabled={!pendingColName || pendingVal === ''}>Add</Button>
      {activeCount > 0 && (
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => onWsFiltersChange({})}>
          Clear all
        </Button>
      )}
    </div>
  )
}

function SectionPanel({ alertName, vars, rows, commonValues, sectionFilters, onFiltersChange, effectiveFilters, onUpdate, onDelete, onAdd, wsFilters, onWsFiltersClear }) {
  const [collapsed, setCollapsed] = useState(false)

  const matchCount = useMemo(() => {
    const hasFilters = Object.values(effectiveFilters).some(f => f && f.value !== '' && f.value != null)
    if (!hasFilters) return rows.length
    return rows.filter(row => matchesFilter(row, effectiveFilters, vars, commonValues)).length
  }, [rows, effectiveFilters, vars, commonValues])

  const activeSectionFilters = Object.values(sectionFilters).filter(f => f && f.value !== '' && f.value != null)
  const hasSectionFilter = activeSectionFilters.length > 0
  const hasWsFilter = Object.keys(wsFilters || {}).length > 0
  const hasAnyFilter = hasSectionFilter || hasWsFilter

  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      <div
        style={{ padding: '8px 12px', background: '#fafafa', borderBottom: collapsed ? 'none' : '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8 }}
      >
        <div onClick={() => setCollapsed(c => !c)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', minWidth: 0 }}>
          <RightOutlined style={{ fontSize: 10, color: '#9ca3af', flexShrink: 0, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }} />
          <span style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alertName}</span>
          <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', border: '0.5px solid #e5e7eb', borderRadius: 8, padding: '0 6px', flexShrink: 0 }}>
            {matchCount} / {rows.length} rows
          </span>
        </div>
        {hasAnyFilter && (
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            style={{ fontSize: 11, color: '#1677ff', flexShrink: 0 }}
            onClick={e => {
              e.stopPropagation()
              if (hasSectionFilter) onFiltersChange({})
              if (hasWsFilter) onWsFiltersClear()
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      {!collapsed && (
        <div style={{ padding: '10px 12px' }}>
          <AlertTable
            vars={vars}
            rows={rows}
            commonValues={commonValues}
            filters={sectionFilters}
            effectiveFilters={effectiveFilters}
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
    return mergeFilters(wsFilters, sectionFilters[alertName] || {})
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
            sectionFilters={sectionFilters[alertName] || {}}
            effectiveFilters={mergedFilters(alertName)}
            onFiltersChange={f => handleSectionFiltersChange(alertName, f)}
            wsFilters={wsFilters}
            onWsFiltersClear={() => setWsFilters({})}
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
