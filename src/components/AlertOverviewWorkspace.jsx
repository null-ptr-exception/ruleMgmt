import { useState, useMemo, useCallback } from 'react'
import { Button, Input, Select, Tag, Typography } from 'antd'
import { SaveOutlined, EyeOutlined, CloseOutlined, RightOutlined } from '@ant-design/icons'
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

// One part of a group's card per deployment, when several are viewed (#91):
// each is that deployment's own rows, as its own Overview shows them.
function DeploymentPart({ deployment, alertName, vars, sectionFilters, effectiveFilters, onFiltersChange, onOpen, scrollContainer, stickyOffsetHeader }) {
  return (
    <div data-testid="deployment-part" style={{ marginBottom: 12 }}>
      <Button type="link" size="small" onClick={() => onOpen(deployment.path)} style={{ padding: 0, fontSize: 12, fontWeight: 500 }}>
        {deployment.path}
      </Button>
      <AlertTable
        vars={vars}
        rows={deployment.values[alertName] || []}
        commonValues={deployment.commonValues}
        filters={sectionFilters}
        effectiveFilters={effectiveFilters}
        onFiltersChange={onFiltersChange}
        readOnly
        plain
        scrollContainer={scrollContainer}
        stickyOffsetHeader={stickyOffsetHeader}
      />
    </div>
  )
}

function SectionPanel({ alertName, vars, rows, commonValues, sectionFilters, onFiltersChange, effectiveFilters, onUpdate, onDelete, onAdd, wsFilters, onWsFiltersClear, readOnly, scrollContainer, deployments, onOpenDeployment }) {
  const [collapsed, setCollapsed] = useState(false)
  const [headerHeight, setHeaderHeight] = useState(0)

  // The table header sticks directly below this section's own sticky header, so
  // its offset has to track the real rendered height rather than a guess.
  const measureHeader = useCallback(el => {
    if (!el) return
    const h = Math.round(el.getBoundingClientRect().height)
    setHeaderHeight(prev => (prev === h ? prev : h))
  }, [])

  // Counted over every viewed deployment, each against its own common values.
  const parts = deployments || [{ values: { [alertName]: rows }, commonValues }]
  const totalRows = parts.reduce((n, d) => n + (d.values[alertName] || []).length, 0)
  const matchCount = useMemo(() => {
    const hasFilters = Object.values(effectiveFilters).some(f => f && f.value !== '' && f.value != null)
    if (!hasFilters) return totalRows
    return parts.reduce((n, d) => n + (d.values[alertName] || []).filter(row => matchesFilter(row, effectiveFilters, vars, d.commonValues)).length, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, deployments, effectiveFilters, vars, commonValues])

  const activeSectionFilters = Object.values(sectionFilters).filter(f => f && f.value !== '' && f.value != null)
  const hasSectionFilter = activeSectionFilters.length > 0
  const hasWsFilter = Object.keys(wsFilters || {}).length > 0
  const hasAnyFilter = hasSectionFilter || hasWsFilter

  // No overflow:hidden on the card — it would trap the sticky header inside a
  // non-scrolling box and stop it from sticking to the scroll container.
  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, background: '#fff' }}>
      <div
        ref={measureHeader}
        style={{ padding: '8px 12px', background: '#fafafa', borderBottom: collapsed ? 'none' : '1px solid #f0f0f0', borderRadius: collapsed ? 8 : '8px 8px 0 0', display: 'flex', alignItems: 'center', gap: 8, position: 'sticky', top: 0, zIndex: 3 }}
      >
        <div onClick={() => setCollapsed(c => !c)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', minWidth: 0 }}>
          <RightOutlined style={{ fontSize: 10, color: '#9ca3af', flexShrink: 0, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }} />
          <span style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alertName}</span>
          <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', border: '0.5px solid #e5e7eb', borderRadius: 8, padding: '0 6px', flexShrink: 0 }}>
            {matchCount} / {totalRows} rows
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
      {!collapsed && deployments && (
        <div style={{ padding: '10px 12px' }}>
          {deployments.map(d => (
            <DeploymentPart
              key={d.path}
              deployment={d}
              alertName={alertName}
              vars={vars}
              sectionFilters={sectionFilters}
              effectiveFilters={effectiveFilters}
              onFiltersChange={onFiltersChange}
              onOpen={onOpenDeployment}
              scrollContainer={scrollContainer}
              stickyOffsetHeader={headerHeight}
            />
          ))}
        </div>
      )}
      {!collapsed && !deployments && (
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
            readOnly={readOnly}
            scrollContainer={scrollContainer}
            stickyOffsetHeader={headerHeight}
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
  onPreview,
  dirty,
  saveStatus,
  getVars,
  readOnly = false,
  // Two or more deployments of the chart, viewed read-only (#91):
  // [{ path, values, commonValues }] in the order they were checked.
  deployments = null,
  onOpenDeployment,
}) {
  const multi = deployments && deployments.length > 1
  const [wsFilters, setWsFilters] = useState({})
  const [sectionFilters, setSectionFilters] = useState({})
  // Held in state, not a ref: the sections re-render once the element exists so
  // the sticky table headers can attach to it.
  const [scrollContainer, setScrollContainer] = useState(null)

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
      {multi && (
        <div data-testid="multi-deployment-banner" style={{ padding: '6px 16px', background: '#e6f4ff', borderBottom: '1px solid #bae0ff', fontSize: 12, color: '#0958d9' }}>
          Viewing {deployments.length} deployments · read-only. Click a deployment&apos;s name to edit it.
        </div>
      )}
      <WorkspaceFilterBar
        wsFilters={wsFilters}
        onWsFiltersChange={setWsFilters}
        vars={allVars}
      />
      <div ref={setScrollContainer} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
            readOnly={readOnly || multi}
            scrollContainer={scrollContainer}
            deployments={multi ? deployments : null}
            onOpenDeployment={onOpenDeployment}
          />
        ))}
      </div>
      <div style={{ padding: '10px 16px', borderTop: '1px solid #f0f0f0', background: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={onSave} disabled={!dirty || readOnly || multi}>Save all</Button>
        {onPreview && !multi && <Button icon={<EyeOutlined />} onClick={onPreview}>Preview</Button>}
        <Text style={{ fontSize: 11, color: '#9ca3af' }}>
          {checkedAlerts.length} section{checkedAlerts.length > 1 ? 's' : ''} loaded
          {activeWsFilterCount > 0 ? ` · ${activeWsFilterCount} workspace filter${activeWsFilterCount > 1 ? 's' : ''} active` : ''}
        </Text>
        {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
      </div>
    </div>
  )
}
