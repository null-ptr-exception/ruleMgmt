import { useState, useEffect, useRef, useCallback } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Input, InputNumber, Select, Empty, Typography, Modal, Dropdown, Alert, Tooltip, Tag, Switch, message } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined, ImportOutlined, EditOutlined } from '@ant-design/icons'
import TemplateTree from '../components/TemplateTree'
import RuleEditor from '../components/RuleEditor'
import KVEditor from '../components/KVEditor'
import ImportRulesModal from '../components/ImportRulesModal'
import BreakingChangeDialog from '../components/BreakingChangeDialog'
import { syncFailedNotice } from '../utils/syncNotice'
import { parseRulesDir, schemaToModel, groupFileText, commonFileText, hasCommonFile, GROUP_KEY_RE, RESERVED_NAMES } from '../utils/rulesFile'
import { importRules, modelGroupFromImport } from '../utils/ruleImport'
import { columnUsage, commonColumnUsage, ruleVars, varsIn } from '../utils/ruleModel'
import { renamedSelectorLabels } from '../utils/selectorContract'
import SelectorLabelsList, { SelectorLabelsHint } from '../components/SelectorLabelsList'
import { profileNames, profileFor, isPromQLType, canonicalType, DEFAULT_TYPE } from '../utils/outputs'
import { GROUP_FIELDS, GROUP_FIELD_NAMES, BASE_GROUP_FIELDS } from '../utils/groupFields'
import yaml from 'js-yaml'
import { renameSelectorColumn } from '../utils/selectorContract'
import { repeatsText, REPEATS_FIX } from '../utils/drift'
import { DERIVED_UNITS, parseDerived, derivedColumns, renameInDerived } from '../utils/derived'
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
  { value: 'duration', label: 'duration' },
  { value: 'enum', label: 'enum' },
]

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

const emptyGroup = key => ({
  group: key,
  columns: {},
  rules: [{ alert: '', expr: '', for: '5m', labels: { severity: 'warning' }, annotations: {} }],
})

/** One column definition row — shared by group columns and _common columns. */
// The name is the row's key, so it is renamed once — on blur or Enter —
// not on every keystroke: each keystroke would remount the row and drop
// focus, and a half-typed name could land on another column's.
// The rule-group fields, the template owner's per group (#65): which output
// profile wraps the group, how often it is evaluated, how many series it may
// produce. Left blank, a field is left out of the rules file — the type is
// then the default profile, the interval the evaluator's own.
// The group's selector hierarchy (#60), coarsest first: picked from the
// group's and _common's string columns, and put in order. Empty is off.
function SelectorsEditor({ group, commonColumns, onChange }) {
  const levels = group.selectors || []
  const candidates = Object.entries({ ...commonColumns, ...(group.columns || {}) })
    .filter(([name, col]) => (col.type || 'string') === 'string' && !levels.includes(name))
    .map(([name]) => name)
  // selectorLabels (#121) is not edited here, so a level taken out is taken
  // out of it too — or the save would refuse a rename nothing here can undo.
  const keep = (map, next) => {
    const kept = Object.fromEntries(Object.entries(map || {}).filter(([l]) => next.includes(l)))
    return Object.keys(kept).length ? kept : undefined
  }
  const withLabels = (obj, next) => {
    const { selectorLabels, ...rest } = obj
    const kept = keep(selectorLabels, next)
    return kept ? { ...rest, selectorLabels: kept } : rest
  }
  const set = next => onChange(g => {
    const out = withLabels({ ...g, ...(g.rules ? { rules: g.rules.map(r => (r.selectorLabels ? withLabels(r, next) : r)) } : {}) }, next)
    if (next.length) out.selectors = next
    else delete out.selectors
    return out
  })
  const move = (i, d) => {
    const next = [...levels]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    set(next)
  }
  return (
    <span data-testid="selectors-editor" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Tooltip title="Coarsest first. A row that is .* in a level gives up the rows one step more specific in it — nobody maintains an exclusion list.">
        <Text type="secondary" style={{ fontSize: 12 }}>Selectors</Text>
      </Tooltip>
      {levels.map((name, i) => (
        <span key={name} data-testid={`selector-level-${name}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid #d9d9d9', borderRadius: 4, padding: '0 4px' }}>
          <Text style={{ fontSize: 12 }}>{i + 1}. {name}</Text>
          <Button size="small" type="text" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
          <Button size="small" type="text" aria-label={`Move ${name} down`} disabled={i === levels.length - 1} onClick={() => move(i, 1)}>↓</Button>
          <Button size="small" type="text" aria-label={`Remove selector ${name}`} onClick={() => set(levels.filter(l => l !== name))}>×</Button>
        </span>
      ))}
      {candidates.length > 0 && (
        <Select size="small" aria-label="Add selector" placeholder="add level" style={{ width: 120 }} value={null}
          options={candidates.map(c => ({ value: c, label: c }))}
          onChange={name => set([...levels, name])} />
      )}
    </span>
  )
}

// A map or a list is typed as flow YAML: {team: shop}, ["X-Scope-OrgID: 1"].
const asFieldText = v => (v === undefined ? '' : (typeof v === 'object' ? yaml.dump(v, { flowLevel: 0, lineWidth: -1 }).trim() : String(v)))
const FIELD_PLACEHOLDER = { labels: '{team: shop}', list: '["X-Scope-OrgID: 1"]', params: '{nocache: ["1"]}', duration: 'default', integer: 'default' }

// One input per group field the group's type has (#182), by what its value
// is. What a value may be is the save's to say. A duration takes effect as
// it is typed; a map or a list once it is YAML.
function GroupFieldInput({ name, value, onSet, onUnreadable }) {
  const { kind, label: shown = name, placeholder, width = 80 } = GROUP_FIELDS[name]
  const [draft, setDraft] = useState(asFieldText(value))
  const [unreadable, setUnreadable] = useState(false)
  useEffect(() => { setDraft(asFieldText(value)); setUnreadable(false) }, [value])
  // Text that is not YAML never reaches the group, so Save would save the
  // value from before: the editor is told, and Save waits for it. Gone with
  // the field (another type, another group), it shows the group's value again.
  useEffect(() => { onUnreadable?.(unreadable ? draft : null) }, [unreadable])
  useEffect(() => () => onUnreadable?.(null), [])
  const label = <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>{shown}</Text>
  if (kind === 'integer') {
    return <span>{label}<InputNumber size="small" aria-label={`Group ${name}`} style={{ width }} placeholder={placeholder ?? 'default'} min={0} precision={0}
      value={value ?? null} onChange={v => onSet(v)} /></span>
  }
  if (kind === 'duration') {
    return <span>{label}<Input size="small" aria-label={`Group ${name}`} style={{ width }} placeholder={placeholder ?? FIELD_PLACEHOLDER[kind]}
      value={value ?? ''} onChange={e => onSet(e.target.value.trim() || undefined)} /></span>
  }
  if (kind === 'boolean') {
    return <span>{label}<Select size="small" aria-label={`Group ${name}`} style={{ width: 90 }} allowClear placeholder="default"
      value={value === undefined ? undefined : String(value)} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
      onChange={v => onSet(v === undefined ? undefined : v === 'true')} /></span>
  }
  const commit = () => {
    const text = draft.trim()
    if (text === '') { setUnreadable(false); onSet(undefined); return }
    try { onSet(yaml.load(text)); setUnreadable(false) } catch { setUnreadable(true) }
  }
  return <span>{label}<Input size="small" aria-label={`Group ${name}`} style={{ width: 200 }} status={unreadable ? 'error' : undefined}
    title={unreadable ? 'Not YAML — e.g. {team: shop}' : undefined}
    placeholder={FIELD_PLACEHOLDER[kind]} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onPressEnter={commit} /></span>
}

// Display names for a non-PromQL group's checker and language.
const CHECKER_NAMES = { promtool: 'promtool', promtool3: 'promtool 3', vmalert: 'vmalert' }
const QUERY_NAMES = { promql: 'PromQL', metricsql: 'MetricsQL', logsql: 'LogsQL' }

function GroupSettings({ group, commonColumns = {}, onChange, onUnreadable }) {
  // once (#70): the group renders once per deployment and has no rows, so it
  // cannot have columns — turned on only once they are gone.
  const hasColumns = Object.keys(group.columns || {}).length > 0
  // The type's fields; a type that is none has the ones every group has.
  const fieldsOfType = profileFor(group.type)?.groupKeys || BASE_GROUP_FIELDS
  const set = (field, value) => onChange(g => {
    const next = { ...g }
    if (value === undefined || value === null || value === '') delete next[field]
    else next[field] = value
    return next
  })
  return (
    <div data-testid="group-settings" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
      <span>
        <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>Type</Text>
        <Select size="small" aria-label="Group type" style={{ width: 130 }}
          // `type: prometheus` is prometheus2's alias: shown as what it is.
          value={canonicalType(group.type) ?? group.type}
          options={profileNames().map(name => ({ value: name, label: name }))}
          onChange={v => set('type', v === DEFAULT_TYPE ? undefined : v)} />
      </span>
      <Tooltip title={hasColumns && !group.once ? 'A once group has no rows and so no columns — remove them first' : 'Render these rules once per deployment instead of once per row'}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" aria-label="Once per deployment" checked={!!group.once}
            disabled={hasColumns && !group.once}
            onChange={e => set('once', e.target.checked || undefined)} />
          <Text type="secondary" style={{ fontSize: 12 }}>Once per deployment</Text>
        </label>
      </Tooltip>
      {fieldsOfType.map(key => (
        <GroupFieldInput key={key} name={key} value={group[key]} onSet={v => set(key, v)} onUnreadable={text => onUnreadable?.(key, text)} />
      ))}
      {/* Left from another type: shown, never dropped unseen — the save refuses it until it is taken off. */}
      {GROUP_FIELD_NAMES.filter(k => group[k] !== undefined && !fieldsOfType.includes(k)).map(key => (
        <Tag key={key} color="red" closable data-testid={`group-field-not-of-type-${key}`} closeIcon={<span aria-label={`Remove ${key}`}>×</span>}
          onClose={e => { e.preventDefault(); set(key, undefined) }}>
          {key}: not a {profileFor(group.type)?.name} field — Save refuses it
        </Tag>
      ))}
      {!group.once && isPromQLType(group.type) && (
        <SelectorsEditor group={group} commonColumns={commonColumns} onChange={onChange} />
      )}
      {!isPromQLType(group.type) && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          expr is not PromQL here — {CHECKER_NAMES[profileFor(group.type)?.validate]
            ? `Preview checks it as ${QUERY_NAMES[profileFor(group.type).query]} with ${CHECKER_NAMES[profileFor(group.type).validate]}`
            : 'Preview cannot syntax-check it'}
        </Text>
      )}
    </div>
  )
}

function ColumnRow({ name, col, usage, onRename, onPatch, onRemove, selectorLevel, selectorLabels }) {
  const uiType = col.enum ? 'enum' : (col.type || 'string')
  const [draft, setDraft] = useState(name)
  useEffect(() => { setDraft(name) }, [name])
  const commit = () => {
    const next = draft.trim()
    if (next === name) { setDraft(name); return }
    if (!onRename(next)) setDraft(name)
  }
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input size="small" value={draft} placeholder="name"
          onChange={e => setDraft(e.target.value)}
          onBlur={commit} onPressEnter={commit}
          style={{ width: 150, fontWeight: 600 }} />
        {selectorLevel !== undefined && (
          <Tooltip title={<>
            <div>A selector: its cells are .* or a value matched exactly, never a regex</div>
            {selectorLabels && <SelectorLabelsList column={name} pairs={selectorLabels} />}
          </>} trigger={['hover', 'focus']} styles={{ root: { maxWidth: 480 } }}>
            <Tag color="blue" tabIndex={0} data-testid={`selector-tag-${name}`} style={{ marginInlineEnd: 0 }}>selector {selectorLevel + 1}</Tag>
          </Tooltip>
        )}
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

// A group's derived values (#118): a value computed per row from its integer
// columns, with a unit, used as ${name} in a range or a `for`. Rows are kept
// here, so a half-typed name or expression stays as typed; the model gets
// the named ones. `taken` says whether a name is another's (a column, a
// common column, a vars entry, another derived value).
function DerivedEditor({ derived, usage, taken, onChange }) {
  const [rows, setRows] = useState(() => Object.entries(derived || {}).map(([name, d]) => ({ name, expr: d.expr ?? '', unit: d.unit })))
  // Which row each name was sent from, and the expression sent: a row two
  // share a name with (half-typed, or a clash) is never the one sent, and
  // never takes the other's expression.
  const sent = useRef(null)
  if (sent.current === null) sent.current = Object.fromEntries(Object.entries(derived || {}).map(([name, d], row) => [name, { row, expr: d.expr ?? '' }]))
  // A column renamed elsewhere rewrites an expression (renameColumn): the
  // row it was sent from follows, the others are left as typed.
  useEffect(() => {
    setRows(prev => {
      let next = prev
      for (const [name, d] of Object.entries(derived || {})) {
        const at = sent.current[name]
        if (!at || d.expr === at.expr || prev[at.row]?.name !== name) continue
        next = next === prev ? [...prev] : next
        next[at.row] = { ...next[at.row], expr: d.expr }
        sent.current[name] = { row: at.row, expr: d.expr }
      }
      return next
    })
  }, [derived])
  const send = next => {
    setRows(next)
    const out = {}
    const from = {}
    next.forEach((r, i) => {
      // A clash or a reserved name is marked on the row and not sent.
      if (!r.name || Object.hasOwn(out, r.name) || taken(r.name)) return
      let columns = []
      try { columns = derivedColumns(parseDerived(r.expr)) } catch { /* the save says what is wrong */ }
      Object.defineProperty(out, r.name, { value: { expr: r.expr, ...(r.unit ? { unit: r.unit } : {}), columns }, enumerable: true, writable: true, configurable: true })
      from[r.name] = { row: i, expr: r.expr }
    })
    sent.current = from
    onChange(Object.keys(out).length ? out : undefined)
  }
  const set = (i, patch) => send(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div data-testid="derived-editor">
      {rows.map((r, i) => {
        const clash = r.name && (taken(r.name) || (rows.some((o, j) => j !== i && o.name === r.name) && `another derived value`))
        let exprError = null
        if (r.expr) { try { parseDerived(r.expr) } catch (e) { exprError = e.message } }
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input size="small" aria-label={`Derived ${i + 1} name`} value={r.name} placeholder="name"
                status={clash ? 'error' : undefined}
                onChange={e => set(i, { name: e.target.value.trim() })} style={{ width: 150, fontWeight: 600 }} />
              <Input size="small" aria-label={`Derived ${i + 1} expression`} value={r.expr} placeholder="freq_num * (spc_point + 2)"
                status={exprError ? 'error' : undefined}
                onChange={e => set(i, { expr: e.target.value })} style={{ flex: 1, fontFamily: 'monospace' }} />
              <Select size="small" aria-label={`Derived ${i + 1} unit`} value={r.unit} placeholder="unit" style={{ width: 80 }}
                options={DERIVED_UNITS.map(u => ({ value: u, label: u }))}
                onChange={unit => set(i, { unit })} />
              <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Remove derived ${i + 1}`}
                onClick={() => send(rows.filter((_, j) => j !== i))} />
            </div>
            {clash && <Text type="danger" style={{ fontSize: 11, marginLeft: 158, display: 'block' }}>{clash === 'reserved' ? `"${r.name}" is a reserved name` : `"${r.name}" is already ${clash}'s name in this group`}</Text>}
            {exprError && <Text type="danger" style={{ fontSize: 11, marginLeft: 158, display: 'block' }}>{exprError}</Text>}
            {!r.unit && <Text type="warning" style={{ fontSize: 11, marginLeft: 158, display: 'block' }}>⚠ a unit is needed: the value is a duration</Text>}
            {r.name && !clash && (
              <Text type={usage[r.name] ? 'secondary' : 'warning'} style={{ fontSize: 11, marginLeft: 158, display: 'block' }}>
                {usage[r.name] ? `Used by ${usage[r.name].join(', ')}` : '⚠ Not used by any rule'}
              </Text>
            )}
          </div>
        )
      })}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setRows([...rows, { name: '', expr: '', unit: 'm' }])}>Add derived</Button>
    </div>
  )
}

export default function TemplateDevEditor() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useSessionState('templates:chart', null)
  const [chartMeta, setChartMeta] = useState({})
  // The description as loaded: a Save sends it only when it was edited here,
  // so a tab left open does not write back an old one over a newer (pulled).
  const loadedDescription = useRef(undefined)
  const saveDescriptionIfChanged = () => ((chartMeta.description || '') === (loadedDescription.current || '')
    ? Promise.resolve()
    : saveChartMeta(activeChart, { description: chartMeta.description || '' }))
  // The chart as { common: { columns }, groups: { <key>: { group, columns, rules, vars?, custom? } } }
  const [model, setModel] = useState({ common: { columns: {} }, groups: {} })
  const [order, setOrder] = useState([])
  const [activeGroup, setActiveGroup] = useSessionState('templates:alert', null)
  const [dirty, setDirty] = useState(false)
  // Group fields whose text is not YAML, by group.field (GroupFieldInput).
  const unreadableFields = useRef({})
  const [dirtyFiles, setDirtyFiles] = useState(() => new Set())
  const [parseErrors, setParseErrors] = useState([])
  const [drift, setDrift] = useState(null)
  // Why the chart cannot be opened, when it cannot: nothing of it is shown to edit.
  const [loadError, setLoadError] = useState(null)
  // The chart and the time the model was loaded from disk: the Derived and
  // Vars sections start again from the model each time.
  const [loadedAs, setLoadedAs] = useState('')
  const [collapsedRules, setCollapsedRules] = useState({})
  const [importTarget, setImportTarget] = useState(null)
  const [breaking, setBreaking] = useState(null)   // the 409 payload while the dialog is open
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
    setLoadError(info.failed ? info.error || 'The chart cannot be opened' : null)
    if (info.failed) {
      setModel({ common: { columns: {} }, groups: {} })
      setOrder([])
      setDrift(null)
      originalRef.current = {}
      return
    }
    setChartMeta(info.chartMeta || {})
    loadedDescription.current = info.chartMeta?.description
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
    setLoadedAs(`${chart}@${Date.now()}`)
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
    setModel(m => ({ ...m, common: { ...m.common, columns: fn(m.common.columns) } }))
    touch('_common.yaml')
  }

  function addGroup() {
    const name = prompt('Alert group name (e.g. mariadb_saturation_disk):')?.trim()
    if (!name) return
    if (!GROUP_KEY_RE.test(name) || model.groups[name]) {
      Modal.error({ title: 'Invalid or taken name', content: 'Lower-case letters, digits and _, starting with a letter.' })
      return
    }
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
    if (!GROUP_KEY_RE.test(newKey) || model.groups[newKey]) {
      Modal.error({ title: 'Invalid or taken name', content: 'Lower-case letters, digits and _, starting with a letter.' })
      return
    }
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
  // The banner for a legacy or stale chart says Save fixes it, so Save has to
  // be available before anything has been edited.
  // rules/ that cannot be read has nothing a save would regenerate, and a
  // template repeating generated alerts has to be removed by hand (#190).
  const needsSave = (drift?.state === 'legacy' || drift?.state === 'stale') && !drift?.errors?.length && (!drift?.repeats?.length || !!drift?.outOfDate)

  function buildFiles() {
    const files = {}
    if (hasCommonFile(model.common)) {
      files['_common.yaml'] = dirtyFiles.has('_common.yaml') || !originalRef.current['_common.yaml']
        ? commonFileText(model.common.columns, model.common) : originalRef.current['_common.yaml']
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

  // `overwrite` is the answer to "the files changed on disk": it lets the
  // save go ahead over them and nothing more. A breaking change still gets
  // its own dialog — the server is never told it was confirmed here (#185).
  async function handleSave(overwrite = false) {
    if (!activeChart) return

    // A group field whose text could not be read: saving now would save the
    // value from before it, silently.
    const unread = Object.entries(unreadableFields.current)
    if (unread.length) {
      Modal.error({
        title: 'Save was refused',
        content: unread.map(([at, text]) => `${at}: ${JSON.stringify(text)} is not YAML — correct it, or empty the field`).join('\n'),
      })
      return
    }

    if (!overwrite && Object.keys(originalRef.current).length) {
      const fresh = await getChartInfo(activeChart)
      if (fresh.failed) {
        Modal.error({ title: 'The chart cannot be read now', content: fresh.error })
        return
      }
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

    const result = await saveChartRules(activeChart, buildFiles(), false)

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
      setBreaking(result)
      return
    }
    if (!result?.ok) {
      reportFailedSave(result)
      return
    }
    reportNotices(result.notices)

    await saveDescriptionIfChanged()
    await loadChart(activeChart)
  }

  // Changes that break nothing but are worth knowing — a group changing type
  // replaces its objects (#65). With a breaking change they are listed in the
  // dialog; a save with none says them here.
  function reportNotices(notices) {
    if (!notices?.length) return
    Modal.info({
      title: 'Saved — worth knowing',
      content: (
        <ul style={{ paddingLeft: 18, marginTop: 8 }}>
          {notices.map((n, i) => <li key={i}>{n.description || n.kind}</li>)}
        </ul>
      ),
    })
  }

  // A save that did not happen says why, and leaves the editor as it is —
  // reloading the chart after a failure would throw the edits away.
  function reportFailedSave(result, title = 'Save failed') {
    const lines = result?.errors ||
      result?.migrationProblems?.flatMap(d => d.problems.map(p =>
        `${d.path}${d.source ? ` (synced from ${d.source} and read-only: unlink it to change it)` : ''}: ${p.message}`)) ||
      (result?.findings || []).map(f => f.description || f.message)
    Modal.error({
      title: result?.error || title,
      content: lines?.length ? lines.join('; ') : 'The server did not save the chart.',
    })
  }

  async function applyInPlace(migration) {
    const result = await saveChartRules(activeChart, buildFiles(), true, migration)
    if (!result?.ok) {
      reportFailedSave(result)
      return
    }
    setBreaking(null)
    const notice = syncFailedNotice(result.syncFailed, 'Changed')
    if (notice) message.warning(notice, 10)
    await saveDescriptionIfChanged()
    await loadChart(activeChart)
  }

  async function cloneWithEdits(newName, migration) {
    const res = await cloneChart(activeChart, newName, migration)
    if (res?.error) { Modal.error({ title: 'Clone failed', content: res.error }); return }
    const saved = await saveChartRules(newName, buildFiles(), true)   // the clone gets the edited rules
    if (!saved?.ok) {
      // The clone exists but holds the old rules; the edits are still here.
      reportFailedSave(saved, `Created ${newName}, but saving the edits into it failed`)
      await loadCharts()
      return
    }
    setBreaking(null)
    await loadCharts()
    setActiveChart(newName)
  }

  // ── chart-level actions ───────────────────────────────────────────────────
  async function handleCreateChart() {
    const name = prompt('New chart name:')?.trim()
    if (!name) return
    const created = await createChart(name)
    if (created.failed) {
      message.error(created.error || 'The chart was not created')
      return
    }
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
    const res = await deleteChart(activeChart)
    if (res?.failed) {
      Modal.error({
        title: 'Chart not deleted',
        content: (
          <div data-testid="chart-delete-refused">
            <div>{res.error || 'The chart could not be deleted.'}</div>
            {res.deployments?.length > 0 && (
              <>
                <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                  {res.deployments.map(d => <li key={d.path}>{d.path}</li>)}
                </ul>
                <div>Delete these deployments first.</div>
              </>
            )}
          </div>
        ),
      })
      return
    }
    setActiveChart(null)
    await loadCharts()
  }

  /** Merge imported groups into the model in memory; Save writes them. */
  function applyImport({ groups }) {
    setModel(m => {
      const next = { ...m, groups: { ...m.groups } }
      const commonNames = Object.keys(m.common.columns)
      for (const g of groups) next.groups[g.key] = modelGroupFromImport(g, commonNames)
      return next
    })
    setOrder(o => [...o, ...groups.map(g => g.key).filter(k => !o.includes(k))])
    for (const g of groups) touch(`${g.key}.yaml`)
    setActiveGroup(groups[0]?.key || activeGroup)
  }

  // The dialog stays open on a refusal, so the name or the rules can be fixed
  // and tried again.
  async function createChartFromRules({ groups }, name) {
    if (charts.some(c => c.name === name)) {
      message.error(`A chart named "${name}" already exists`)
      return
    }
    const created = await createChart(name)
    if (created.failed) {
      message.error(created.error || 'The chart was not created')
      return
    }
    const files = {}
    for (const g of groups) files[`${g.key}.yaml`] = groupFileText(modelGroupFromImport(g))
    const saved = await saveChartRules(name, files, true)
    if (!saved?.ok) {
      // No empty chart left behind for the next try to collide with.
      await deleteChart(name)
      reportFailedSave(saved)
      return
    }
    await loadCharts()
    setActiveChart(name)
    setImportTarget(null)
  }

  // ── derived ───────────────────────────────────────────────────────────────
  const isCommon = activeGroup === COMMON
  const group = (!isCommon && activeGroup) ? model.groups[activeGroup] : null
  const commonNames = Object.keys(model.common.columns)
  // A column some rule matches under another label (#133) — common ones too.
  const renamedLabels = renamedSelectorLabels(group)
  const groupColumns = group && !group.custom
    // ${selector} is the group's selector matchers when it has selectors (#60);
    // a vars entry and a derived value (#118) are referenced as ${name} too.
    ? [...Object.keys(group.columns), ...commonNames, ...Object.keys(group.derived || {}), ...Object.keys(group.vars || {}), ...(group.selectors?.length ? ['selector'] : [])]
    : []
  // Merged column definitions the rule cards need to say "blank leaves this rule out".
  const columnDefs = group && !group.custom
    ? { ...model.common.columns, ...group.columns }
    : {}

  // Which rules reference each column — the "Used by" annotation, and the flag
  // for a column no rule uses.
  const usedByColumn = columnUsage(group && !group.custom ? group : {})
  // Which rules use each derived value (#118), by its own name.
  const derivedUsage = Object.create(null)
  for (const r of (group && !group.custom ? group.rules : [])) {
    // Through a vars entry too, as the generator reads it.
    const names = [...ruleVars(r)].flatMap(n => (Object.hasOwn(group.vars || {}, n) ? varsIn(String(group.vars[n])) : [n]))
    for (const n of new Set(names)) if (Object.hasOwn(group.derived || {}, n)) (derivedUsage[n] ||= []).push(r.alert || r.record || '(unnamed)')
  }
  // A common column's usage spans every group.
  const commonUsage = commonColumnUsage(model.groups, model.common.columns)

  const missingDescriptions = cols => Object.values(cols).filter(c => !c.description).length

  // What a name is already in `target`'s namespace (a group, or COMMON for
  // every group's), or false: ${name} could not tell them apart. `derived`
  // false leaves the group's derived values out (their own editor asks).
  function nameTaken(target, name, { derived = true } = {}) {
    if (RESERVED_NAMES.includes(name)) return 'reserved'
    const groups = target === COMMON ? Object.values(model.groups) : [model.groups[target]].filter(Boolean)
    if (target !== COMMON && Object.hasOwn(model.groups[target]?.columns || {}, name)) return 'a column'
    if (Object.hasOwn(model.common.columns || {}, name)) return 'a common column'
    if (target === COMMON && groups.some(g => Object.hasOwn(g.columns || {}, name))) return 'a column'
    if (groups.some(g => Object.hasOwn(g.vars || {}, name))) return 'a vars entry'
    if (derived && groups.some(g => Object.hasOwn(g.derived || {}, name))) return 'a derived value'
    return false
  }

  // Returns whether it renamed. A name has to be valid and free — among this
  // group's columns, _common's, its vars and its derived values, which share
  // one namespace.
  function renameColumn(target, oldName, newName) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      message.warning(`"${newName}" is not a valid column name`)
      return false
    }
    const taken = nameTaken(target, newName)
    if (taken) {
      message.warning(taken === 'reserved' ? `"${newName}" is a reserved name` : `"${newName}" is already ${taken}'s name`)
      return false
    }
    patchColumn(target, oldName, newName, {})
    return true
  }

  function patchColumn(target, oldName, newName, patch) {
    const apply = cols => {
      const out = {}
      for (const [k, v] of Object.entries(cols)) out[k === oldName ? newName : k] = k === oldName ? { ...v, ...patch } : v
      return out
    }
    if (target === COMMON) updateCommonColumns(apply)
    else updateGroup(target, g => ({ ...g, columns: apply(g.columns) }))
    if (newName === oldName) return
    // A selector keeps its place, and the label it matches (#121).
    for (const key of target === COMMON ? Object.keys(model.groups) : [target]) {
      if (model.groups[key].selectors?.includes(oldName)) updateGroup(key, g => renameSelectorColumn(g, oldName, newName))
      // A derived expression reading it reads it by its new name (#118).
      if (Object.values(model.groups[key].derived || {}).some(d => d.columns?.includes(oldName))) {
        updateGroup(key, g => ({ ...g, derived: Object.fromEntries(Object.entries(g.derived).map(([n, d]) => {
          const expr = renameInDerived(d.expr, oldName, newName)
          return [n, { ...d, expr, columns: (d.columns || []).map(c => (c === oldName ? newName : c)) }]
        })) }))
      }
    }
  }
  function removeColumn(target, name) {
    const apply = cols => { const { [name]: _, ...rest } = cols; return rest }
    if (target === COMMON) updateCommonColumns(apply)
    else updateGroup(target, g => ({ ...g, columns: apply(g.columns) }))
  }
  function addColumnTo(target, name = '', sample) {
    // A once group has no columns (#70): a value it reads is chart-wide.
    if (target !== COMMON && model.groups[target]?.once) {
      target = COMMON
      if (name) message.info(`"${name}" added to common variables — a once group has no columns of its own`)
    }
    const literal = sample === undefined ? '' : String(sample).trim()
    const numeric = literal !== '' && !Number.isNaN(Number(literal))
    const col = { type: numeric ? 'number' : 'string' }
    // The literal a marked column replaced is its default, so marking alone
    // changes nothing that renders (doc/rules-format.md).
    if (literal !== '') col.default = numeric ? Number(literal) : literal
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
      <BreakingChangeDialog
        open={!!breaking}
        payload={breaking}
        chart={activeChart}
        files={breaking ? buildFiles() : {}}
        onCancel={() => setBreaking(null)}
        onApplyInPlace={applyInPlace}
        onClone={cloneWithEdits}
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
              <Button type="primary" icon={<SaveOutlined />} onClick={() => handleSave()} disabled={!dirty && !needsSave}>Save</Button>
              <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
            </div>
          </>
        )}
      </div>

      {/* rules/ that cannot be read is listed below; saving regenerates nothing. */}
      {activeChart && drift?.repeats?.length > 0 && !drift.errors?.length && (
        <Alert
          type="error" banner showIcon data-testid="repeats-banner"
          message={`${drift.repeats.map(repeatsText).join('; ')}: each alert would fire twice. To fix it, ${REPEATS_FIX}; saving does not.`}
        />
      )}
      {activeChart && drift && (drift.state === 'legacy' || drift.state === 'stale') && !drift.errors?.length && (!drift.repeats?.length || drift.outOfDate) && (
        <Alert
          type="warning" banner showIcon
          message={drift.state === 'legacy'
            ? 'This chart still uses the old schema-only format. Saving migrates it to rules/*.yaml.'
            : `Generated files are behind the source (${(drift.outOfDate || drift.files || []).join(', ')}). Saving regenerates them.`}
        />
      )}
      {parseErrors.length > 0 && (
        <Alert type="error" banner showIcon
          message={<span>rules/*.yaml has problems: {parseErrors.join('; ')}</span>} />
      )}

      {activeChart && loadError && (
        <Alert type="error" showIcon data-testid="chart-load-error" style={{ margin: '8px 20px 0' }}
          message="This chart cannot be opened" description={loadError} />
      )}

      {activeChart && !loadError ? (
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
                <div data-testid="row-identity" style={{ marginBottom: 20, padding: 12, border: '1px solid #f0f0f0', borderRadius: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Switch size="small" aria-label="Row identity label" checked={model.common.rowIdentity === true}
                      onChange={on => {
                        setModel(m => {
                          const { rowIdentity: _was, ...rest } = m.common
                          return { ...m, common: on ? { ...rest, rowIdentity: true } : rest }
                        })
                        touch('_common.yaml')
                      }} />
                    <Text strong style={{ fontSize: 13 }}>Row identity label</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{model.common.rowIdentity === true ? 'on' : 'off'}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                    Gives every alerting rule of a group with text, true/false or selector columns a label <Text code>alertforge_row</Text>,
                    a hash of those cells. Prometheus then keeps each alert&apos;s state when rows are inserted, removed or reordered;
                    without it, every alert after the change in the same object starts its <Text code>for</Text> again.
                    Not on recording rules, raw rules or once groups.
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }} data-testid="row-identity-once">
                    Turning it on or off, once: Alertmanager sees every alert as a new one — one or two more notifications per group,
                    the same alert listed twice for about 4 minutes until the old one resolves, and each alert starts its <Text code>for</Text> again.
                    Existing silences and inhibit rules keep working.
                  </Text>
                  <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 6 }} data-testid="row-identity-silences">
                    Do not match a silence, or an inhibit rule&apos;s equal, on alertforge_row: its value changes whenever a row&apos;s identifying cells change.
                  </Text>
                </div>
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
                    onRename={val => renameColumn(COMMON, name, val)}
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

                {!group.custom && <GroupSettings group={group} commonColumns={model.common.columns} onChange={fn => updateGroup(activeGroup, fn)}
                  onUnreadable={(key, text) => { const at = `${activeGroup}.${key}`; if (text === null) delete unreadableFields.current[at]; else unreadableFields.current[at] = text }} />}

                {group.custom ? (
                  <Alert type="info" showIcon
                    message="Hand-written template"
                    description="This group is an x-custom-template — its templates/*.yaml is edited by hand and is not managed here. It keeps working; convert it to a rules file to bring it into the editor." />
                ) : (
                  <>
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
                          {group.once
                            ? `Rules (${group.rules.length}) — each renders once per deployment`
                            : `Rules (${group.rules.length}) — one table, one alert per rule`}
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
                          derived={group.derived}
                          collapsed={!!collapsedRules[`${activeGroup}:${i}`]}
                          onToggleCollapse={() => setCollapsedRules(p => ({ ...p, [`${activeGroup}:${i}`]: !p[`${activeGroup}:${i}`] }))}
                          onChange={next => setRules(group.rules.map((r, idx) => idx === i ? next : r))}
                          onRemove={() => setRules(group.rules.filter((_, idx) => idx !== i))}
                          onAddColumn={(name, sample) => addColumnTo(activeGroup, name, sample)}
                          // PromQL editing help only where expr is PromQL (#65)
                          exprLanguage={isPromQLType(group.type) ? 'promql' : 'text'}
                        />
                      ))}
                      {group.rules.length === 0 && <Empty description="No rules yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                    </div>

                    {group.once ? (
                      <div data-testid="once-no-columns" style={{ marginBottom: 20 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          Once per deployment: no rows, so no columns. A rule here can read the common
                          variables{commonNames.length > 0 ? ` (${commonNames.join(', ')})` : ''}.
                        </Text>
                      </div>
                    ) : (
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
                          selectorLevel={group.selectors?.includes(name) ? group.selectors.indexOf(name) : undefined}
                          selectorLabels={renamedLabels[name]}
                          usage={(usedByColumn[name] || []).join(', ')}
                          onRename={val => renameColumn(activeGroup, name, val)}
                          onPatch={patch => patchColumn(activeGroup, name, name, patch)}
                          onRemove={() => removeColumn(activeGroup, name)} />
                      ))}
                      {commonNames.length > 0 && (
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
                          Also available: {commonNames.map((n, i) => (
                            <span key={n}>
                              {i > 0 && ', '}{n}
                              {renamedLabels[n] && <> <SelectorLabelsHint column={n} pairs={renamedLabels[n]} /></>}
                            </span>
                          ))} (common)
                        </Text>
                      )}
                    </div>
                    )}

                    {!group.once && (
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                          <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Derived</Text>
                          <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                        </div>
                        <DerivedEditor
                          key={`${loadedAs}:${activeGroup}`}
                          derived={group.derived}
                          usage={derivedUsage}
                          taken={name => nameTaken(activeGroup, name, { derived: false })}
                          onChange={d => updateGroup(activeGroup, g => {
                            const { derived: _, ...rest } = g
                            return d ? { ...rest, derived: d } : rest
                          })}
                        />
                        <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                          A value computed for each row from its integer columns (+ - * and brackets), with a unit:
                          {' ${name}'} in a range or a for. Preview shows each row&apos;s value.
                        </Text>
                      </div>
                    )}

                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Vars</Text>
                        <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                      </div>
                      <VarsEditor
                        key={`${loadedAs}:${activeGroup}`}
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
