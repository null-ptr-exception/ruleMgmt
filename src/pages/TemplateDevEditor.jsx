import { useState, useEffect, useRef, useCallback } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Input, Select, Empty, Typography, Modal, Dropdown, Alert } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined, ImportOutlined, EditOutlined } from '@ant-design/icons'
import TemplateTree from '../components/TemplateTree'
import RuleEditor from '../components/RuleEditor'
import KVEditor from '../components/KVEditor'
import ImportRulesModal from '../components/ImportRulesModal'
import { parseRulesDir, schemaToModel, groupFileText, commonFileText } from '../utils/rulesFile'
import { importRules } from '../utils/ruleImport'
import { ruleVars } from '../utils/ruleModel'
import {
  listCharts, createChart, deleteChart, cloneChart,
  getChartInfo, saveChartRules, saveChartMeta,
} from '../utils/chartApi'

const { Text } = Typography

const COMMON = '__common_vars__'

const TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'integer', label: 'integer' },
  { value: 'boolean', label: 'boolean' },
  { value: 'enum', label: 'enum' },
]

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

const emptyGroup = key => ({
  group: key,
  columns: {},
  rules: [{ alert: '', expr: '', for: '5m', labels: { severity: 'warning' }, annotations: {} }],
})

/** One column definition row — shared by group columns and _common columns. */
function ColumnRow({ name, col, usage, onRename, onPatch, onRemove }) {
  const uiType = col.enum ? 'enum' : (col.type || 'string')
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input size="small" value={name} placeholder="name"
          onChange={e => onRename(e.target.value)}
          style={{ width: 150, fontWeight: 600 }} />
        <Select size="small" value={uiType} options={TYPE_OPTIONS} style={{ width: 90 }}
          onChange={val => onPatch(val === 'enum'
            ? { type: 'string', enum: col.enum || [] }
            : { type: val, enum: undefined })} />
        <div style={{ flex: 1, position: 'relative' }}>
          <Input size="small" value={col.description || ''}
            placeholder={col.description ? '' : '⚠ description not filled in'}
            status={col.description ? undefined : 'warning'}
            onChange={e => onPatch({ description: e.target.value || undefined })} />
        </div>
        <Input size="small" value={col.default ?? ''} placeholder="default" style={{ width: 100 }}
          onChange={e => {
            const v = e.target.value
            const numeric = col.type === 'number' || col.type === 'integer'
            onPatch({ default: v === '' ? undefined : (numeric && !Number.isNaN(Number(v)) ? Number(v) : v) })
          }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={!!col.required}
            onChange={e => onPatch({ required: e.target.checked || undefined })} />
          <Text style={{ fontSize: 11 }}>Req</Text>
        </label>
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onRemove} />
      </div>
      {usage !== undefined && (
        <Text type={usage ? 'secondary' : 'warning'} style={{ fontSize: 11, marginLeft: 158, display: 'block' }}>
          {usage ? `Used by ${usage}` : '⚠ Not used by any rule'}
        </Text>
      )}
      {uiType === 'enum' && (
        <Select size="small" mode="tags" placeholder="Type an option and press Enter"
          value={col.enum || []}
          onChange={vals => onPatch({ enum: vals?.length ? vals : undefined })}
          style={{ width: '100%', marginTop: 6 }} open={false} />
      )}
    </div>
  )
}

/** KVEditor for a group's edit-time `vars`, keeping the blank row you type into.
 *  Mount with key={groupKey} so switching groups reloads it. */
function VarsEditor({ vars, onChange }) {
  const [rows, setRows] = useState(() => Object.entries(vars || {}).map(([key, value]) => ({ key, value })))
  return (
    <KVEditor
      keyPlaceholder="name" valuePlaceholder="text"
      rows={rows}
      onChange={next => {
        setRows(next)
        onChange(Object.fromEntries(next.filter(r => r.key).map(r => [r.key, r.value])))
      }}
    />
  )
}

export default function TemplateDevEditor() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useSessionState('templates:chart', null)
  const [chartMeta, setChartMeta] = useState({})
  // The chart as { common: { columns }, groups: { <key>: { group, columns, rules, vars?, custom? } } }
  const [model, setModel] = useState({ common: { columns: {} }, groups: {} })
  const [order, setOrder] = useState([])
  const [activeGroup, setActiveGroup] = useSessionState('templates:alert', null)
  const [dirty, setDirty] = useState(false)
  const [dirtyFiles, setDirtyFiles] = useState(() => new Set())
  const [parseErrors, setParseErrors] = useState([])
  const [drift, setDrift] = useState(null)
  const [collapsedRules, setCollapsedRules] = useState({})
  const [importTarget, setImportTarget] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const resizingRef = useRef(false)
  // The rules/*.yaml texts as loaded — for conflict detection, and to pass
  // untouched files through verbatim so hand-added comments survive.
  const originalRef = useRef({})

  function touch(file) {
    setDirtyFiles(s => { const n = new Set(s); n.add(file); return n })
    setDirty(true)
  }

  function handleResizeStart(e) {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX
    const startWidth = sidebarWidth
    function onMove(ev) {
      if (!resizingRef.current) return
      const clientX = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX
      setSidebarWidth(Math.max(140, Math.min(400, startWidth + clientX - startX)))
    }
    function onUp() {
      resizingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
  }

  const loadCharts = useCallback(async () => {
    const c = await listCharts()
    setCharts(c)
    if (activeChart && !c.some(ch => ch.name === activeChart)) setActiveChart(null)
  }, [activeChart, setActiveChart])

  useEffect(() => { loadCharts() }, [loadCharts])

  const loadChart = useCallback(async (chart) => {
    const info = await getChartInfo(chart)
    setChartMeta(info.chartMeta || {})
    setDrift(info.drift || null)

    let m, ord, errors = []
    if (info.rulesFiles && Object.keys(info.rulesFiles).length) {
      ;({ model: m, errors } = parseRulesDir(info.rulesFiles))
      ord = Object.keys(m.groups).sort()
      originalRef.current = info.rulesFiles
    } else {
      // Not migrated yet: read the schema through the upgrade adapter and show
      // it as a normal model. The first Save writes rules/*.yaml.
      m = schemaToModel(info.schema || { properties: {} }).model
      ord = Object.keys(m.groups)
      originalRef.current = {}
    }
    setModel(m)
    setOrder(ord)
    setParseErrors(errors)
    setDirtyFiles(new Set())
    setDirty(false)
    setActiveGroup(prev => (prev === COMMON || ord.includes(prev)) ? prev : (ord[0] || null))
  }, [setActiveGroup])

  useEffect(() => {
    if (activeChart) loadChart(activeChart)
  }, [activeChart, loadChart])

  // ── model mutation ────────────────────────────────────────────────────────
  const updateGroup = (key, fn) => {
    setModel(m => ({ ...m, groups: { ...m.groups, [key]: fn(m.groups[key]) } }))
    touch(`${key}.yaml`)
  }
  const updateCommonColumns = fn => {
    setModel(m => ({ ...m, common: { columns: fn(m.common.columns) } }))
    touch('_common.yaml')
  }

  function addGroup() {
    const name = prompt('Alert group name (e.g. mariadb_saturation_disk):')?.trim()
    if (!name) return
    if (!NAME_RE.test(name) || model.groups[name]) return
    setModel(m => ({ ...m, groups: { ...m.groups, [name]: emptyGroup(name) } }))
    setOrder(o => [...o, name])
    touch(`${name}.yaml`)
    setActiveGroup(name)
  }

  function removeGroup(key) {
    if (!confirm(`Remove alert group "${key}"?`)) return
    setModel(m => { const { [key]: _, ...groups } = m.groups; return { ...m, groups } })
    setOrder(o => o.filter(k => k !== key))
    setActiveGroup(prev => prev === key ? (order.filter(k => k !== key)[0] || null) : prev)
    setDirty(true)
  }

  function renameGroup(oldKey) {
    const newKey = prompt(`Rename "${oldKey}" to:`, oldKey)?.trim()
    if (!newKey || newKey === oldKey) return
    if (!NAME_RE.test(newKey) || model.groups[newKey]) { Modal.error({ title: 'Invalid or taken name' }); return }
    // Renaming a group is a group-removed + group-added — the server sends it
    // through the breaking-change dialog when deployments are on the old name.
    setModel(m => {
      const { [oldKey]: g, ...rest } = m.groups
      return { ...m, groups: { ...rest, [newKey]: { ...g, group: newKey } } }
    })
    setOrder(o => o.map(k => k === oldKey ? newKey : k))
    touch(`${newKey}.yaml`)
    setActiveGroup(newKey)
  }

  // ── save ──────────────────────────────────────────────────────────────────
  function buildFiles() {
    const files = {}
    const common = model.common.columns
    if (Object.keys(common).length) {
      files['_common.yaml'] = dirtyFiles.has('_common.yaml') || !originalRef.current['_common.yaml']
        ? commonFileText(common) : originalRef.current['_common.yaml']
    }
    for (const key of order) {
      const g = model.groups[key]
      if (!g || g.custom) continue        // a hand-written x-custom-template keeps its own file
      const file = `${key}.yaml`
      files[file] = dirtyFiles.has(file) || !originalRef.current[file]
        ? groupFileText({ ...g, group: key }) : originalRef.current[file]
    }
    return files
  }

  async function handleSave(confirmBreaking = false) {
    if (!activeChart) return

    if (!confirmBreaking && Object.keys(originalRef.current).length) {
      const fresh = await getChartInfo(activeChart)
      if (JSON.stringify(fresh.rulesFiles || {}) !== JSON.stringify(originalRef.current)) {
        Modal.confirm({
          title: 'The rules files changed on disk since you opened this chart',
          content: 'Saving now overwrites those changes.',
          okText: 'Save anyway', okButtonProps: { danger: true },
          onOk: () => handleSave(true),
        })
        return
      }
    }

    const result = await saveChartRules(activeChart, buildFiles(), confirmBreaking)

    if (result?.invalid) {
      const findings = result.findings || []
      const modal = Modal.error({
        title: result.error || 'Save was refused',
        content: findings.length ? (
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            {findings.map((f, i) => (
              <li key={i}>
                {f.group && f.group !== activeGroup ? (
                  <a onClick={() => { setActiveGroup(f.group); modal.destroy() }}>{f.description || f.message}</a>
                ) : (f.description || f.message)}
              </li>
            ))}
          </ul>
        ) : (
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>{(result.errors || []).map((l, i) => <li key={i}>{l}</li>)}</ul>
        ),
      })
      return
    }
    if (result?.blocked) {
      Modal.confirm({
        title: 'This change breaks deployments that already exist',
        width: 620,
        content: (
          <div>
            <ul style={{ paddingLeft: 18, marginTop: 8 }}>
              {result.breaking.map((c, i) => <li key={i}>{c.description}</li>)}
            </ul>
            <p style={{ marginTop: 12 }}>
              In use by {result.deployments.length} deployment(s):{' '}
              {result.deployments.map(d => d.path).join(', ')}
            </p>
            <p>Cloning the chart and changing the copy leaves these untouched.</p>
          </div>
        ),
        okText: 'Save anyway', okButtonProps: { danger: true },
        onOk: () => handleSave(true),
      })
      return
    }
    if (!result?.ok) return

    await saveChartMeta(activeChart, chartMeta)
    await loadChart(activeChart)
  }

  // ── chart-level actions ───────────────────────────────────────────────────
  async function handleCreateChart() {
    const name = prompt('New chart name:')?.trim()
    if (!name) return
    await createChart(name)
    await loadCharts()
    setActiveChart(name)
  }

  async function handleCloneChart() {
    if (!activeChart) return
    const name = prompt(`Copy "${activeChart}" to a new chart named:`)?.trim()
    if (!name || !NAME_RE.test(name)) return
    const res = await cloneChart(activeChart, name)
    if (res?.error) { Modal.error({ title: 'Clone failed', content: res.error }); return }
    await loadCharts()
    setActiveChart(name)
  }

  async function handleDelete() {
    if (!activeChart || !confirm(`Delete chart "${activeChart}"?`)) return
    await deleteChart(activeChart)
    setActiveChart(null)
    await loadCharts()
  }

  /** Merge imported groups into the model in memory; Save writes them. */
  function applyImport({ groups }) {
    setModel(m => {
      const next = { ...m, groups: { ...m.groups } }
      for (const g of groups) {
        next.groups[g.key] = {
          group: g.key,
          columns: Object.fromEntries(g.columns.map(name => [name, { type: columnType(name, g.rules) }])),
          rules: g.rules,
        }
      }
      return next
    })
    setOrder(o => [...o, ...groups.map(g => g.key).filter(k => !o.includes(k))])
    for (const g of groups) touch(`${g.key}.yaml`)
    setActiveGroup(groups[0]?.key || activeGroup)
  }

  async function createChartFromRules({ groups }, name) {
    await createChart(name)
    const files = {}
    for (const g of groups) {
      files[`${g.key}.yaml`] = groupFileText({
        group: g.key,
        columns: Object.fromEntries(g.columns.map(n => [n, { type: columnType(n, g.rules) }])),
        rules: g.rules,
      })
    }
    await saveChartRules(name, files, true)
    await loadCharts()
    setActiveChart(name)
    setImportTarget(null)
  }

  // ── derived ───────────────────────────────────────────────────────────────
  const isCommon = activeGroup === COMMON
  const group = (!isCommon && activeGroup) ? model.groups[activeGroup] : null
  const commonNames = Object.keys(model.common.columns)
  const groupColumns = group && !group.custom
    ? [...Object.keys(group.columns), ...commonNames]
    : []
  // Merged column definitions the rule cards need to say "blank leaves this rule out".
  const columnDefs = group && !group.custom
    ? { ...model.common.columns, ...group.columns }
    : {}

  // Which rules reference each column — the "Used by" annotation, and the flag
  // for a column no rule uses.
  const usedByColumn = {}
  if (group && !group.custom) {
    for (const r of group.rules) {
      for (const n of ruleVars(r)) (usedByColumn[n] ||= []).push(r.alert || '(unnamed)')
    }
  }
  // A common column's usage spans every group.
  const commonUsage = {}
  for (const g of Object.values(model.groups)) {
    if (g.custom) continue
    for (const r of (g.rules || [])) {
      for (const n of ruleVars(r)) if (n in model.common.columns) (commonUsage[n] ||= new Set()).add(g.group)
    }
  }

  const missingDescriptions = cols => Object.values(cols).filter(c => !c.description).length

  function patchColumn(target, oldName, newName, patch) {
    const apply = cols => {
      const out = {}
      for (const [k, v] of Object.entries(cols)) out[k === oldName ? newName : k] = k === oldName ? { ...v, ...patch } : v
      return out
    }
    if (target === COMMON) updateCommonColumns(apply)
    else updateGroup(target, g => ({ ...g, columns: apply(g.columns) }))
  }
  function removeColumn(target, name) {
    const apply = cols => { const { [name]: _, ...rest } = cols; return rest }
    if (target === COMMON) updateCommonColumns(apply)
    else updateGroup(target, g => ({ ...g, columns: apply(g.columns) }))
  }
  function addColumnTo(target, name = '', sample) {
    const numeric = sample !== undefined && String(sample).trim() !== '' && !Number.isNaN(Number(sample))
    const col = { type: numeric ? 'number' : 'string' }
    const apply = cols => ({ ...cols, [name]: col })
    if (target === COMMON) updateCommonColumns(apply)
    else updateGroup(target, g => ({ ...g, columns: apply(g.columns) }))
  }

  const setRules = rules => updateGroup(activeGroup, g => ({ ...g, rules }))

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ImportRulesModal
        open={importTarget !== null}
        needsName={importTarget === 'new'}
        existingGroups={order}
        onCancel={() => setImportTarget(null)}
        onApply={(result, name) => {
          if (importTarget === 'new') return createChartFromRules(result, name)
          applyImport(result)
          setImportTarget(null)
        }}
      />

      <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Select
          value={activeChart || undefined}
          onChange={setActiveChart}
          placeholder="Select chart"
          style={{ minWidth: 180 }}
          options={charts.map(c => ({ value: c.name, label: `${c.name} (${c.templateCount} templates)` }))}
        />
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'blank', label: 'Blank chart' },
              { key: 'rules', label: 'From rules…' },
              { key: 'clone', label: 'From existing chart…', disabled: !activeChart },
            ],
            onClick: ({ key }) => {
              if (key === 'blank') handleCreateChart()
              else if (key === 'rules') setImportTarget('new')
              else handleCloneChart()
            },
          }}
        >
          <Button size="small" icon={<PlusOutlined />}>New</Button>
        </Dropdown>
        {activeChart && (
          <>
            <Input size="small" placeholder="Description" value={chartMeta.description || ''}
              onChange={e => { setChartMeta({ ...chartMeta, description: e.target.value }); setDirty(true) }}
              style={{ flex: 1, maxWidth: 400 }} />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Button icon={<ImportOutlined />} onClick={() => setImportTarget('existing')}>Import</Button>
              <Button type="primary" icon={<SaveOutlined />} onClick={() => handleSave()} disabled={!dirty}>Save</Button>
              <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
            </div>
          </>
        )}
      </div>

      {activeChart && drift && (drift.state === 'legacy' || drift.state === 'stale') && (
        <Alert
          type="warning" banner showIcon
          message={drift.state === 'legacy'
            ? 'This chart still uses the old schema-only format. Saving migrates it to rules/*.yaml.'
            : `Generated files are behind the source (${(drift.files || []).join(', ')}). Saving regenerates them.`}
        />
      )}
      {parseErrors.length > 0 && (
        <Alert type="error" banner showIcon
          message={<span>rules/*.yaml has problems: {parseErrors.join('; ')}</span>} />
      )}

      {activeChart ? (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <div style={{ width: sidebarWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#fafafa', position: 'relative' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Alert Groups</Text>
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={addGroup} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <TemplateTree templates={order} activeTemplate={activeGroup} onSelect={setActiveGroup} showCommonVars />
            </div>
            <div onMouseDown={handleResizeStart} onTouchStart={handleResizeStart}
              style={{ position: 'absolute', top: 0, right: -2, width: 5, height: '100%', cursor: 'col-resize', zIndex: 10 }}>
              <div style={{
                position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
                width: 14, height: 28, borderRadius: 4, background: '#d9d9d9', border: '1px solid #bfbfbf',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, color: '#8c8c8c', letterSpacing: 1, touchAction: 'none',
              }}>⋮</div>
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {isCommon ? (
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                <Text strong style={{ fontSize: 16 }}>Common Variables</Text>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '12px 0 16px' }}>
                  Filled in once per deployment, read by every row of every group.
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
                    Columns{missingDescriptions(model.common.columns) > 0 && (
                      <Text type="warning" style={{ fontSize: 11, fontWeight: 400 }}> · {missingDescriptions(model.common.columns)} without a description</Text>
                    )}
                  </Text>
                  <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                  <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addColumnTo(COMMON)}>Add</Button>
                </div>
                {commonNames.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No common variables</Text>}
                {Object.entries(model.common.columns).map(([name, col]) => (
                  <ColumnRow key={name} name={name} col={col}
                    usage={commonUsage[name] ? `${commonUsage[name].size} group(s)` : ''}
                    onRename={val => patchColumn(COMMON, name, val, {})}
                    onPatch={patch => patchColumn(COMMON, name, name, patch)}
                    onRemove={() => removeColumn(COMMON, name)} />
                ))}
              </div>
            ) : group ? (
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                  <Text strong style={{ fontSize: 16 }}>{activeGroup}</Text>
                  <Button size="small" icon={<EditOutlined />} onClick={() => renameGroup(activeGroup)}>Rename</Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeGroup(activeGroup)}>Remove</Button>
                </div>

                {group.custom ? (
                  <Alert type="info" showIcon
                    message="Hand-written template"
                    description="This group is an x-custom-template — its templates/*.yaml is edited by hand and is not managed here. It keeps working; convert it to a rules file to bring it into the editor." />
                ) : (
                  <>
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
                          Rules ({group.rules.length}) — one table, one alert per rule
                        </Text>
                        <Button size="small" icon={<PlusOutlined />}
                          onClick={() => setRules([...group.rules, { alert: '', expr: '', for: '5m', labels: { severity: 'warning' }, annotations: {} }])}>
                          Add rule
                        </Button>
                      </div>
                      {group.rules.map((rule, i) => (
                        <RuleEditor
                          key={i}
                          rule={rule}
                          columns={groupColumns}
                          columnDefs={columnDefs}
                          collapsed={!!collapsedRules[`${activeGroup}:${i}`]}
                          onToggleCollapse={() => setCollapsedRules(p => ({ ...p, [`${activeGroup}:${i}`]: !p[`${activeGroup}:${i}`] }))}
                          onChange={next => setRules(group.rules.map((r, idx) => idx === i ? next : r))}
                          onRemove={() => setRules(group.rules.filter((_, idx) => idx !== i))}
                          onAddColumn={(name, sample) => addColumnTo(activeGroup, name, sample)}
                        />
                      ))}
                      {group.rules.length === 0 && <Empty description="No rules yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                    </div>

                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
                          Columns{missingDescriptions(group.columns) > 0 && (
                            <Text type="warning" style={{ fontSize: 11, fontWeight: 400 }}> · {missingDescriptions(group.columns)} without a description</Text>
                          )}
                        </Text>
                        <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addColumnTo(activeGroup)}>Add</Button>
                      </div>
                      {Object.keys(group.columns).length === 0 && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          Columns a rule refers to as {'${name}'}. Set as variable in a rule creates one here.
                        </Text>
                      )}
                      {Object.entries(group.columns).map(([name, col]) => (
                        <ColumnRow key={name} name={name} col={col}
                          usage={(usedByColumn[name] || []).join(', ')}
                          onRename={val => patchColumn(activeGroup, name, val, {})}
                          onPatch={patch => patchColumn(activeGroup, name, name, patch)}
                          onRemove={() => removeColumn(activeGroup, name)} />
                      ))}
                      {commonNames.length > 0 && (
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
                          Also available: {commonNames.join(', ')} (common)
                        </Text>
                      )}
                    </div>

                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Vars</Text>
                        <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                      </div>
                      <VarsEditor
                        key={activeGroup}
                        vars={group.vars}
                        onChange={v => updateGroup(activeGroup, g => ({ ...g, vars: v }))}
                      />
                      <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                        Edit-time text, substituted before generation — a query shared by two rules,
                        kept once. Not a column; the rule owner never sees it.
                      </Text>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <Empty style={{ margin: 'auto' }} description="Select or create an alert group" />
            )}
          </div>
        </div>
      ) : (
        <Empty style={{ margin: 'auto' }} description="Select a chart or create a new one." />
      )}

      {activeChart && dirty && (
        <div style={{ padding: '8px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fffbe6' }}>
          <Text type="warning" style={{ fontSize: 12 }}>Unsaved changes</Text>
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={() => handleSave()}>Save</Button>
        </div>
      )}
    </div>
  )
}

/** A placeholder on the right of a comparison is compared to a number. */
function columnType(name, rules) {
  const re = new RegExp(`(==|!=|>=|<=|>|<)\\s*\\$\\{\\s*${name}\\s*\\}`)
  return rules.some(r => re.test([r.raw || '', r.expr || ''].join('\n'))) ? 'number' : 'string'
}
