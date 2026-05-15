import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import { Card, Input, Button, Select, Checkbox, Modal, Typography, Tag, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import EditorLayout from '../components/EditorLayout'
import KVEditor from '../components/KVEditor'
import VersionModal from '../components/VersionModal'
const PromQLEditor  = lazy(() => import('../components/PromQLEditor'))
const PromQLBuilder = lazy(() => import('../components/PromQLBuilder'))
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, importPrometheusRules, getMetricsDict } from '../utils/api'
import { kvArrayToObject, objectToKvArray, bumpPatch, latestVersion } from '../utils/templateUtils'

const { Text } = Typography

// ── YAML preview builder ──────────────────────────────────────────────────────

function buildRuleGroupPreview(form, product) {
  const pfx = product ? `${product}-` : ''
  const groupName = form.groupName || 'unnamed-group'

  let yaml = `apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n`
  yaml += `  name: ${pfx}${groupName}\n`
  yaml += `  labels:\n    app.kubernetes.io/managed-by: Helm\nspec:\n  groups:\n`
  yaml += `    - name: ${pfx}${groupName}\n`

  const glabels = (form.groupLabels || []).filter(l => l.key.trim())
  if (glabels.length) {
    yaml += `      labels:\n`
    for (const { key, value } of glabels) yaml += `        ${key}: ${JSON.stringify(value)}\n`
  }

  if (form.rules.length === 0) {
    yaml += `      rules: []\n`
    return yaml.trimEnd()
  }

  yaml += `      rules:\n`
  for (const rule of form.rules) {
    const rn = rule.ruleName || 'unnamed-alert'
    yaml += `        - alert: ${pfx}${rn}\n`
    const ruleExpr = rule.alertTypeName === DIRECT_EXPR_TYPE
      ? directExprValue(rule.vars)
      : (rule.expr || '')
    const displayExpr = wrapExpr(ruleExpr, form.subscription)
    if (rule.alertTypeName && rule.alertTypeName !== DIRECT_EXPR_TYPE) {
      yaml += `          # type: ${rule.alertTypeName}`
      if (rule.alertTypeVersion) yaml += `@${rule.alertTypeVersion}`
      yaml += `\n`
      const filledVars = (rule.vars || []).filter(v => v.key && v.value)
      if (filledVars.length && !displayExpr) {
        yaml += `          expr: |\n`
        yaml += `            # rendered by Helm from ${rule.alertTypeName}\n`
        for (const v of filledVars) yaml += `            # ${v.key}: ${v.value}\n`
      } else {
        yaml += `          expr: ${displayExpr ? JSON.stringify(displayExpr) : '"# enter a PromQL expression"'}\n`
      }
    } else {
      yaml += `          expr: ${displayExpr ? JSON.stringify(displayExpr) : '"# enter a PromQL expression"'}\n`
    }
    if (rule.for) yaml += `          for: ${rule.for}\n`
    yaml += `          labels:\n`
    yaml += `            severity: ${rule.severity || 'warning'}\n`
    for (const { key, value } of (rule.labels || []).filter(l => l.key.trim())) {
      yaml += `            ${key}: ${JSON.stringify(value)}\n`
    }
    if (rule.description) {
      yaml += `          annotations:\n`
      yaml += `            description: ${JSON.stringify(rule.description)}\n`
    }
  }

  return yaml.trimEnd()
}

const TYPE = 'alert-suite'
const SEVERITIES  = ['critical', 'warning', 'info', 'none']
const OP_OPTIONS  = ['>', '<', '>=', '<=', '==', '!=']
const FUNC_OPTIONS = ['rate', 'irate', 'increase', 'avg_over_time', 'max_over_time', 'min_over_time']

const DIRECT_EXPR_TYPE = 'direct-expr'
const DIRECT_EXPR_VARS = [{ name: 'expr', type: 'string' }]

function directExprValue(vars) {
  return (vars || []).find(v => v.key === 'expr')?.value || ''
}

// ── Metrics input: metric_name + label KV editor ─────────────────────────────

const LABEL_MATCHER_OPS = ['=', '!=', '=~', '!~']

function parseMetric(s) {
  const m = (s || '').match(/^([^{]*)(?:\{(.*)\})?$/)
  const name = m?.[1]?.trim() || ''
  const labelsStr = m?.[2]?.trim() || ''
  const labels = labelsStr
    ? labelsStr.split(',').map(pair => {
        const opMatch = pair.match(/(!~|=~|!=|=)/)
        if (!opMatch) return { key: pair.trim(), op: '=', value: '' }
        const op  = opMatch[0]
        const key = pair.slice(0, opMatch.index).trim()
        const val = pair.slice(opMatch.index + op.length).replace(/^["']|["']$/g, '').trim()
        return { key, op, value: val }
      }).filter(p => p.key)
    : []
  return { name, labels }
}

function buildMetric(name, labels) {
  const valid = labels.filter(l => (l.key || '').trim())
  return valid.length
    ? `${name}{${valid.map(l => `${l.key}${l.op || '='}"${l.value}"`).join(',')}}`
    : name
}

function MetricsInput({ value, onChange }) {
  const parsed = parseMetric(value)
  const [internalName, setInternalName] = useState(parsed.name)
  const [internalLabels, setInternalLabels] = useState(parsed.labels)
  const lastCommit = useRef(value)

  useEffect(() => {
    if (value !== lastCommit.current) {
      const p = parseMetric(value)
      setInternalName(p.name)
      setInternalLabels(p.labels)
      lastCommit.current = value
    }
  }, [value])

  function commit(n, lbls) {
    const newValue = buildMetric(n, lbls)
    lastCommit.current = newValue
    onChange(newValue)
  }

  function updateLabel(i, field, val) {
    const next = internalLabels.map((l, idx) => idx === i ? { ...l, [field]: val } : l)
    setInternalLabels(next)
    commit(internalName, next)
  }
  function addLabel() {
    const next = [...internalLabels, { key: '', op: '=', value: '' }]
    setInternalLabels(next)
    commit(internalName, next)
  }
  function removeLabel(i) {
    const next = internalLabels.filter((_, idx) => idx !== i)
    setInternalLabels(next)
    commit(internalName, next)
  }

  return (
    <div>
      <Input size="small" value={internalName} placeholder="metric_name"
        style={{ marginBottom: 4 }}
        onChange={e => { setInternalName(e.target.value); commit(e.target.value, internalLabels) }} />
      {internalLabels.length > 0 && internalLabels.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
          <Input size="small" value={l.key} placeholder="label" style={{ flex: 1 }}
            onChange={e => updateLabel(i, 'key', e.target.value)} />
          <Select size="small" value={l.op || '='} onChange={val => updateLabel(i, 'op', val)}
            style={{ width: 56, fontFamily: 'monospace', fontWeight: 700 }}
            options={LABEL_MATCHER_OPS.map(o => ({ value: o, label: o }))} />
          <Input size="small" value={l.value} style={{ flex: 1 }}
            placeholder={l.op?.includes('~') ? 'regex' : 'value'}
            onChange={e => updateLabel(i, 'value', e.target.value)} />
          <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => removeLabel(i)} />
        </div>
      ))}
      <Button size="small" icon={<PlusOutlined />} onClick={addLabel}>Add matcher</Button>
    </div>
  )
}

// ── Type-aware var value input ────────────────────────────────────────────────

function VarInput({ type, value, onChange }) {
  if (type === 'op') {
    return (
      <Select size="small" value={value || undefined} onChange={val => onChange(val || '')}
        placeholder="-- select --" style={{ width: '100%' }} allowClear
        options={OP_OPTIONS.map(o => ({ value: o, label: o }))} />
    )
  }
  if (type === 'func') {
    return (
      <Select size="small" value={value || undefined} onChange={val => onChange(val || '')}
        placeholder="-- select --" style={{ width: '100%' }} allowClear
        options={FUNC_OPTIONS.map(f => ({ value: f, label: f }))} />
    )
  }
  if (type === 'int') {
    return <Input size="small" type="number" value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%' }} />
  }
  if (type === 'metrics') {
    return <MetricsInput value={value} onChange={onChange} />
  }
  return (
    <Input.TextArea value={value} placeholder={type === 'time' ? 'e.g. 5m' : 'fill value'}
      autoSize={{ minRows: 1 }} size="small"
      onChange={e => onChange(e.target.value)} />
  )
}

// ── State factories ───────────────────────────────────────────────────────────

let _uid = 0
const uid = () => String(++_uid)

const emptyRule = () => ({
  alertTypeName: '',
  alertTypeVersion: '',
  ruleName: '',
  vars: [],
  expr: '',
  exprMode: 'raw',
  for: '',
  description: '',
  labels: [],
  severity: 'warning',
})

const emptyPackInstance = () => ({
  _id: uid(),
  packName: '',
  packVersion: '',
  alertNamePrefix: '',
  vars: {},
})

const emptyAlertTypeInstance = () => ({
  _id: uid(),
  alertTypeName:    '',
  alertTypeVersion: '',
  ruleName:         '',
  vars:             {},
  severity:         'warning',
  for:              '',
  description:      '',
  labels:           [],
})

const emptyForm = () => ({
  groupName:          '',
  groupLabels:        [],
  packInstances:      [],
  alertTypeInstances: [],
  rules:              [],
  subscription: {
    enabled:         false,
    onLabels:        '',
    groupLeftLabels: 'user',
    metric:          '',
  },
})

// ── Alert subscription wrapping ───────────────────────────────────────────────

function wrapExpr(expr, sub) {
  if (!sub?.enabled || !sub.metric || !expr) return expr
  const onPart = sub.onLabels?.trim() ? `on(${sub.onLabels.trim()}) ` : ''
  const glPart = sub.groupLeftLabels?.trim()
    ? `group_left(${sub.groupLeftLabels.trim()}) `
    : 'group_left() '
  return `(${expr}) * ${onPart}${glPart}${sub.metric}`
}

// ── Pack template expansion ───────────────────────────────────────────────────

function fillTpl(str, vars) {
  return (str || '').replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k) => vars[k] ?? `{{ .${k} }}`)
}

function expandPackInstance(packData, instance) {
  if (!packData?.rules?.length) return []
  const vars = { alertName: instance.alertNamePrefix, ...instance.vars }
  return packData.rules.map(r => {
    const ruleLabels = r.labels || {}
    const severity = ruleLabels.severity ? fillTpl(String(ruleLabels.severity), vars) : 'warning'
    const extraLabels = Object.entries(ruleLabels)
      .filter(([k]) => k !== 'severity')
      .map(([key, value]) => ({ key, value: fillTpl(String(value), vars) }))
    return {
      ...emptyRule(),
      alertTypeName:    DIRECT_EXPR_TYPE,
      alertTypeVersion: '',
      ruleName:         fillTpl(r.ruleName, vars),
      vars:             [{ key: 'expr', value: fillTpl(r.expr, vars), type: 'string' }],
      exprMode:         'raw',
      for:              r.for || '',
      description:      fillTpl(r.description || '', vars),
      severity,
      labels:           extraLabels,
    }
  })
}

export default function AlertSuiteEditor() {
  const [templates, setTemplates]     = useState({})
  const [alertTypes, setAlertTypes]   = useState({})
  const [packTemplates, setPackTemplates] = useState({})
  const [packDataCache, setPackDataCache] = useState({})
  const [selected, setSelected]       = useState(null)
  const [form, setForm]               = useState(emptyForm())
  const [isNew, setIsNew]             = useState(false)
  const [modal, setModal]             = useState(null)
  const [status, setStatus]           = useState('')
  const [product, setProduct]         = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [metricsDict, setMetricsDict] = useState([])

  const [importOpen, setImportOpen]       = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importGroups, setImportGroups]   = useState([])
  const [importSel, setImportSel]         = useState({})
  const [importPath, setImportPath]       = useState('')

  const [varDeclCache, setVarDeclCache] = useState({})

  const load = useCallback(async () => {
    const [suites, at, md, pt] = await Promise.all([
      listTemplates(TYPE),
      listTemplates('alert-type'),
      getMetricsDict(),
      listTemplates('alert-type-pack'),
    ])
    setTemplates(suites)
    setAlertTypes(at)
    setPackTemplates(pt)
    setMetricsDict(md.metrics || [])
    try {
      const r = await fetch('/api/defaults')
      const d = await r.json()
      setProduct(d.parsed?.product || '')
    } catch {}
  }, [])
  useEffect(() => { load() }, [load])

  async function loadVarDecls(atName, atVersion) {
    if (!atName || !atVersion) return []
    const cacheKey = `${atName}@${atVersion}`
    if (varDeclCache[cacheKey]) return varDeclCache[cacheKey]
    const data = await getTemplate('alert-type', atName, atVersion)
    const decls = data?.parsed?.vars || []
    setVarDeclCache(c => ({ ...c, [cacheKey]: decls }))
    return decls
  }

  async function loadPackData(packName, packVersion) {
    if (!packName || !packVersion) return null
    const key = `${packName}@${packVersion}`
    if (packDataCache[key]) return packDataCache[key]
    const data = await getTemplate('alert-type-pack', packName, packVersion)
    const parsed = data?.parsed || null
    setPackDataCache(c => ({ ...c, [key]: parsed }))
    return parsed
  }

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const s = data.parsed?.alertSuite || {}

    const rawRules = s.manualRules || s.rules || []
    const rules = await Promise.all(rawRules.map(async r => {
      const isBuiltin = r.alertTypeName === DIRECT_EXPR_TYPE
      const decls = isBuiltin ? DIRECT_EXPR_VARS : await loadVarDecls(r.alertTypeName, r.alertTypeVersion)
      const savedVars = r.vars || {}
      const vars = decls.length
        ? decls.map(d => ({ key: d.name, value: String(savedVars[d.name] ?? ''), type: d.type || 'string' }))
        : objectToKvArray(savedVars).map(v => ({ ...v, type: 'string' }))
      return {
        alertTypeName:    r.alertTypeName    || '',
        alertTypeVersion: r.alertTypeVersion || '',
        ruleName:         r.ruleName         || '',
        vars,
        expr:     r.expr     || '',
        exprMode: r.exprMode || 'raw',
        for:         r.for         || '',
        description: r.description || '',
        labels:      objectToKvArray(r.labels || {}),
        severity:    r.severity    || 'warning',
      }
    }))

    let groupLabels = []
    if (s.groupLabels && typeof s.groupLabels === 'object') {
      groupLabels = objectToKvArray(s.groupLabels)
    } else if (typeof s.groupLabel === 'string' && s.groupLabel.includes(':')) {
      const [k, ...rest] = s.groupLabel.split(':')
      groupLabels = [{ key: k.trim(), value: rest.join(':').trim() }]
    }

    const rawInstances = s.packInstances || []
    const packInstances = await Promise.all(rawInstances.map(async inst => {
      await loadPackData(inst.packName, inst.packVersion)
      return { _id: uid(), packName: inst.packName || '', packVersion: inst.packVersion || '', alertNamePrefix: inst.alertNamePrefix || '', vars: inst.vars || {} }
    }))

    const rawTypeInstances = s.alertTypeInstances || []
    const alertTypeInstances = await Promise.all(rawTypeInstances.map(async inst => {
      if (inst.alertTypeName && inst.alertTypeVersion) await loadVarDecls(inst.alertTypeName, inst.alertTypeVersion)
      return {
        _id: uid(), alertTypeName: inst.alertTypeName || '', alertTypeVersion: inst.alertTypeVersion || '',
        ruleName: inst.ruleName || '', vars: inst.vars || {}, severity: inst.severity || 'warning',
        for: inst.for || '', description: inst.description || '', labels: objectToKvArray(inst.labels || {}),
      }
    }))

    const savedSub = s.subscription || {}
    setForm({
      groupName: s.name || name, groupLabels, packInstances, alertTypeInstances, rules,
      subscription: { enabled: !!savedSub.enabled, onLabels: savedSub.onLabels || '', groupLeftLabels: savedSub.groupLeftLabels || 'user', metric: savedSub.metric || '' },
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() { setForm(emptyForm()); setSelected(null); setIsNew(true) }

  async function handleRuleTypeChange(i, field, val) {
    if (field === 'alertTypeName' && val === DIRECT_EXPR_TYPE) {
      setForm(f => ({
        ...f,
        rules: f.rules.map((r, idx) => {
          if (idx !== i) return r
          const prevExpr = directExprValue(r.vars)
          return { ...r, alertTypeName: DIRECT_EXPR_TYPE, alertTypeVersion: '', vars: [{ key: 'expr', value: prevExpr, type: 'string' }] }
        })
      }))
      return
    }
    setForm(f => ({ ...f, rules: f.rules.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
    const rule = { ...form.rules[i], [field]: val }
    if (rule.alertTypeName && rule.alertTypeVersion) {
      const decls = await loadVarDecls(rule.alertTypeName, rule.alertTypeVersion)
      setForm(f => ({
        ...f,
        rules: f.rules.map((r, idx) => {
          if (idx !== i) return r
          const existing = kvArrayToObject(r.vars)
          const vars = decls.map(d => ({ key: d.name, value: String(existing[d.name] ?? ''), type: d.type || 'string' }))
          return { ...r, [field]: val, vars }
        })
      }))
    }
  }

  function updateRule(i, field, val) {
    setForm(f => ({ ...f, rules: f.rules.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
  }
  function addRule()    { setForm(f => ({ ...f, rules: [...f.rules, emptyRule()] })) }
  function removeRule(i){ setForm(f => ({ ...f, rules: f.rules.filter((_, idx) => idx !== i) })) }

  async function openImport() {
    setImportOpen(true); setImportLoading(true); setImportSel({})
    try { const { groups } = await importPrometheusRules(importPath); setImportGroups(groups || []) }
    catch { setImportGroups([]) }
    setImportLoading(false)
  }

  async function rescanImport(path) {
    setImportPath(path); setImportLoading(true); setImportSel({})
    try { const { groups } = await importPrometheusRules(path); setImportGroups(groups || []) }
    catch { setImportGroups([]) }
    setImportLoading(false)
  }

  function toggleImportRule(gi, ri) {
    const key = `${gi}:${ri}`
    setImportSel(s => ({ ...s, [key]: !s[key] }))
  }

  function confirmImport() {
    const toAdd = []
    let mergedGroupLabels = null
    importGroups.forEach((g, gi) => {
      const anySelected = g.rules.some((_, ri) => importSel[`${gi}:${ri}`])
      if (anySelected && g.groupLabels && Object.keys(g.groupLabels).length) {
        mergedGroupLabels = mergedGroupLabels || g.groupLabels
      }
      g.rules.forEach((r, ri) => {
        if (!importSel[`${gi}:${ri}`]) return
        toAdd.push({
          ...emptyRule(),
          alertTypeName: DIRECT_EXPR_TYPE, alertTypeVersion: '',
          vars: [{ key: 'expr', value: r.expr || '', type: 'string' }],
          ruleName: r.alertName || '', for: r.for || '',
          description: r.annotations?.description || r.annotations?.summary || '',
          severity: r.labels?.severity || 'warning',
          labels: objectToKvArray(Object.fromEntries(Object.entries(r.labels || {}).filter(([k]) => k !== 'severity'))),
        })
      })
    })
    if (toAdd.length) {
      setForm(f => ({
        ...f, rules: [...f.rules, ...toAdd],
        groupLabels: f.groupLabels.length === 0 && mergedGroupLabels ? objectToKvArray(mergedGroupLabels) : f.groupLabels,
      }))
    }
    setImportOpen(false)
  }

  function serializeRule(r) {
    const isBuiltin = r.alertTypeName === DIRECT_EXPR_TYPE
    const exprVal = isBuiltin ? directExprValue(r.vars) : (r.expr || '')
    const obj = { alertTypeName: r.alertTypeName, alertTypeVersion: isBuiltin ? undefined : r.alertTypeVersion, ruleName: r.ruleName, vars: kvArrayToObject(r.vars), severity: r.severity }
    if (exprVal) obj.expr = exprVal
    if (r.exprMode && r.exprMode !== 'raw') obj.exprMode = r.exprMode
    if (r.for) obj.for = r.for
    if (r.description) obj.description = r.description
    const labels = kvArrayToObject(r.labels || [])
    if (Object.keys(labels).length) obj.labels = labels
    return obj
  }

  function buildPayload() {
    const packExpandedRules = form.packInstances.flatMap(inst => {
      const packData = packDataCache[`${inst.packName}@${inst.packVersion}`]
      if (!packData) return []
      return expandPackInstance(packData, inst).map(r => {
        const extraLabels = kvArrayToObject(r.labels || [])
        return {
          alertTypeName: DIRECT_EXPR_TYPE, ruleName: r.ruleName, expr: directExprValue(r.vars), vars: {}, severity: r.severity,
          ...(r.for ? { for: r.for } : {}), ...(r.description ? { description: r.description } : {}),
          ...(Object.keys(extraLabels).length ? { labels: extraLabels } : {}),
        }
      })
    })
    const typeInstanceRules = form.alertTypeInstances.filter(inst => inst.alertTypeName && inst.alertTypeVersion).map(inst => {
      const obj = { alertTypeName: inst.alertTypeName, alertTypeVersion: inst.alertTypeVersion, ruleName: inst.ruleName, vars: inst.vars, severity: inst.severity }
      if (inst.for) obj.for = inst.for
      if (inst.description) obj.description = inst.description
      const labels = kvArrayToObject(inst.labels || [])
      if (Object.keys(labels).length) obj.labels = labels
      return obj
    })
    const manualRules = form.rules.map(serializeRule)
    const alertSuite = { name: form.groupName, groupLabels: kvArrayToObject(form.groupLabels), rules: [...packExpandedRules, ...typeInstanceRules, ...manualRules] }
    if (form.subscription?.enabled) {
      alertSuite.subscription = { enabled: true, onLabels: form.subscription.onLabels.trim(), groupLeftLabels: form.subscription.groupLeftLabels.trim(), metric: form.subscription.metric.trim() }
    }
    if (form.packInstances.length > 0 || form.alertTypeInstances.length > 0) {
      alertSuite.packInstances = form.packInstances.map(({ _id, ...rest }) => rest)
      alertSuite.alertTypeInstances = form.alertTypeInstances.map(({ _id, labels, ...rest }) => ({
        ...rest, ...(kvArrayToObject(labels || []) && Object.keys(kvArrayToObject(labels || [])).length ? { labels: kvArrayToObject(labels) } : {}),
      }))
      alertSuite.manualRules = manualRules
    }
    return { alertSuite }
  }

  async function handleSave(name, version) {
    setModal(null)
    const instanceName = name || form.groupName || `group-${Date.now()}`
    await saveTemplate(TYPE, instanceName, version, buildPayload())
    await load()
    setSelected({ name: instanceName, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = selected?.name || form.groupName || ''
    const v = selected ? bumpPatch(selected.version) : (n && templates[n] ? bumpPatch(latestVersion(templates[n])) : 'v1.0.0')
    setModal({ name: n, version: v })
  }

  function addPackInstance() { setForm(f => ({ ...f, packInstances: [...f.packInstances, emptyPackInstance()] })) }
  function removePackInstance(id) { setForm(f => ({ ...f, packInstances: f.packInstances.filter(p => p._id !== id) })) }
  function updatePackInstance(id, changes) { setForm(f => ({ ...f, packInstances: f.packInstances.map(p => p._id === id ? { ...p, ...changes } : p) })) }
  async function handlePackChange(id, packName, packVersion) {
    const data = await loadPackData(packName, packVersion)
    const vars = {}
    if (data?.vars) for (const v of data.vars) vars[v.name] = ''
    updatePackInstance(id, { packName, packVersion, vars })
  }

  function addAlertTypeInstance() { setForm(f => ({ ...f, alertTypeInstances: [...f.alertTypeInstances, emptyAlertTypeInstance()] })) }
  function removeAlertTypeInstance(id) { setForm(f => ({ ...f, alertTypeInstances: f.alertTypeInstances.filter(p => p._id !== id) })) }
  function updateAlertTypeInstance(id, changes) { setForm(f => ({ ...f, alertTypeInstances: f.alertTypeInstances.map(p => p._id === id ? { ...p, ...changes } : p) })) }
  async function handleAlertTypeInstanceChange(id, field, val) {
    updateAlertTypeInstance(id, { [field]: val })
    const inst = form.alertTypeInstances.find(p => p._id === id)
    const atName = field === 'alertTypeName' ? val : inst?.alertTypeName
    const atVer  = field === 'alertTypeVersion' ? val : inst?.alertTypeVersion
    if (atName && atVer) {
      const decls = await loadVarDecls(atName, atVer)
      const existing = inst?.vars || {}
      const vars = {}
      for (const d of decls) vars[d.name] = existing[d.name] ?? ''
      updateAlertTypeInstance(id, { [field]: val, vars })
    } else {
      updateAlertTypeInstance(id, { [field]: val, vars: {} })
    }
  }

  const allPreviewRules = useMemo(() => {
    const packRules = form.packInstances.flatMap(inst => {
      const packData = packDataCache[`${inst.packName}@${inst.packVersion}`]
      if (!packData) return []
      return expandPackInstance(packData, inst)
    })
    const typeInstRules = form.alertTypeInstances.filter(inst => inst.alertTypeName && inst.alertTypeVersion).map(inst => {
      const decls = varDeclCache[`${inst.alertTypeName}@${inst.alertTypeVersion}`] || []
      return { ...emptyRule(), alertTypeName: inst.alertTypeName, alertTypeVersion: inst.alertTypeVersion, ruleName: inst.ruleName,
        vars: decls.map(d => ({ key: d.name, value: String(inst.vars[d.name] ?? ''), type: d.type || 'string' })),
        severity: inst.severity, for: inst.for, description: inst.description, labels: inst.labels || [] }
    })
    return [...packRules, ...typeInstRules, ...form.rules]
  }, [form.packInstances, form.alertTypeInstances, form.rules, packDataCache, varDeclCache])

  const preview = useMemo(
    () => buildRuleGroupPreview({ ...form, rules: allPreviewRules }, product),
    [form, product, allPreviewRules]
  )

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  const showForm = isNew || selected

  return (
    <EditorLayout
      title="Rule Groups"
      templates={templates}
      selected={selected}
      onSelect={selectVersion}
      onNew={startNew}
      emptyIcon="📦"
      emptyText="Select a rule group or click + New."
    >
      {showForm && (
        <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 }}>
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong style={{ fontSize: 15 }}>
                  {selected ? `${selected.name} @ ${selected.version}` : 'New Rule Group'}
                </Text>
                {status && <Tag color="success">{status}</Tag>}
                <div style={{ marginLeft: 'auto' }}>
                  <Button size="small" type={showPreview ? 'primary' : 'default'}
                    onClick={() => setShowPreview(v => !v)}>
                    {showPreview ? 'Hide Preview' : 'Show Preview'}
                  </Button>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Group Name *</Text>
                <Input value={form.groupName} placeholder="e.g. platform-group"
                  onChange={e => setForm(f => ({ ...f, groupName: e.target.value }))} />
              </div>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                  Group Labels <Text type="secondary" style={{ fontSize: 11 }}>added to every rule in this group on render</Text>
                </Text>
                <KVEditor rows={form.groupLabels} onChange={rows => setForm(f => ({ ...f, groupLabels: rows }))}
                  keyPlaceholder="label key" valuePlaceholder="value" />
              </div>
            </Card>

            {/* Pack Instances */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Alert Pack Instances</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={addPackInstance}>Add Pack</Button>
              </div>
              {form.packInstances.length === 0 ? (
                <Text type="secondary">No packs. Add a pack to bulk-generate multiple related alert rules at once.</Text>
              ) : form.packInstances.map(inst => {
                const packData = packDataCache[`${inst.packName}@${inst.packVersion}`]
                const packVersions = packTemplates[inst.packName] || []
                const expanded = packData ? expandPackInstance(packData, inst) : []
                return (
                  <Card key={inst._id} size="small" style={{ marginBottom: 10, background: '#faf5ff', borderColor: '#d3adf7' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span>
                        <Text strong style={{ fontSize: 13, color: '#722ed1' }}>
                          {inst.packName || 'New Pack Instance'}
                        </Text>
                        {inst.packVersion && <Text type="secondary" style={{ marginLeft: 6, fontSize: 11 }}>@ {inst.packVersion}</Text>}
                        {packData && <Tag color="purple" style={{ marginLeft: 8, fontSize: 11 }}>{packData.rules?.length || 0} rules</Tag>}
                      </span>
                      <Button danger size="small" onClick={() => removePackInstance(inst._id)}>Remove</Button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Pack Template</Text>
                        <Select size="small" value={inst.packName || undefined} onChange={val => handlePackChange(inst._id, val || '', '')}
                          placeholder="-- select --" style={{ width: '100%' }} allowClear
                          options={Object.keys(packTemplates).map(n => ({ value: n, label: n }))} />
                      </div>
                      {inst.packName && (
                        <div>
                          <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Version</Text>
                          <Select size="small" value={inst.packVersion || undefined} onChange={val => handlePackChange(inst._id, inst.packName, val || '')}
                            placeholder="-- select --" style={{ width: '100%' }}
                            options={packVersions.map(v => ({ value: v, label: v }))} />
                        </div>
                      )}
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                          Alert Name Prefix <Text type="secondary" style={{ fontSize: 10 }}>{'-> {{ .alertName }}'}</Text>
                        </Text>
                        <Input size="small" value={inst.alertNamePrefix} placeholder="e.g. high-cpu"
                          onChange={e => updatePackInstance(inst._id, { alertNamePrefix: e.target.value })} />
                      </div>
                    </div>

                    {packData?.vars?.length > 0 && (
                      <div style={{ marginBottom: expanded.length ? 10 : 0 }}>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Pack Variables</Text>
                        {packData.vars.map(v => (
                          <div key={v.name} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                            <Input size="small" value={v.name} readOnly style={{ width: '28%', background: '#fafafa', color: '#8c8c8c' }} />
                            <Tag color="purple" style={{ fontSize: 11 }}>{v.type || 'string'}</Tag>
                            <div style={{ flex: 1 }}>
                              <VarInput type={v.type || 'string'} value={inst.vars[v.name] || ''}
                                onChange={val => updatePackInstance(inst._id, { vars: { ...inst.vars, [v.name]: val } })} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {expanded.length > 0 && (
                      <div style={{ background: '#f9f0ff', borderRadius: 5, padding: '8px 12px', border: '1px solid #d3adf7' }}>
                        <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 5 }}>
                          Will generate {expanded.length} rule{expanded.length !== 1 ? 's' : ''}:
                        </Text>
                        {expanded.map((r, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
                            <Text strong style={{ fontSize: 11, fontFamily: 'monospace', color: '#722ed1' }}>{r.ruleName || '—'}</Text>
                            <Tag color={r.severity === 'critical' ? 'red' : r.severity === 'warning' ? 'gold' : 'blue'}
                              style={{ fontSize: 10 }}>{r.severity}</Tag>
                            <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {directExprValue(r.vars) || '—'}
                            </Text>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )
              })}
            </Card>

            {/* Alert Type Instances */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Alert Type Instances</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={addAlertTypeInstance}>Add Type</Button>
              </div>
              {form.alertTypeInstances.length === 0 ? (
                <Text type="secondary">No type instances. Add an alert type to create a single parameterised rule from a template.</Text>
              ) : form.alertTypeInstances.map(inst => {
                const decls = varDeclCache[`${inst.alertTypeName}@${inst.alertTypeVersion}`] || []
                const versionsForType = inst.alertTypeName ? (alertTypes[inst.alertTypeName] || []) : []
                return (
                  <Card key={inst._id} size="small" style={{ marginBottom: 10, background: '#f0f5ff', borderColor: '#91caff' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span>
                        <Text strong style={{ fontSize: 13, color: '#1d4ed8' }}>
                          {inst.alertTypeName || 'New Type Instance'}
                        </Text>
                        {inst.alertTypeVersion && <Text type="secondary" style={{ marginLeft: 6, fontSize: 11 }}>@ {inst.alertTypeVersion}</Text>}
                        {decls.length > 0 && <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>{decls.length} var{decls.length !== 1 ? 's' : ''}</Tag>}
                      </span>
                      <Button danger size="small" onClick={() => removeAlertTypeInstance(inst._id)}>Remove</Button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Alert Type</Text>
                        <Select size="small" value={inst.alertTypeName || undefined}
                          onChange={val => handleAlertTypeInstanceChange(inst._id, 'alertTypeName', val || '')}
                          placeholder="-- select --" style={{ width: '100%' }} allowClear
                          options={Object.keys(alertTypes).map(n => ({ value: n, label: n }))} />
                      </div>
                      {inst.alertTypeName && (
                        <div>
                          <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Version</Text>
                          <Select size="small" value={inst.alertTypeVersion || undefined}
                            onChange={val => handleAlertTypeInstanceChange(inst._id, 'alertTypeVersion', val || '')}
                            placeholder="-- select --" style={{ width: '100%' }}
                            options={versionsForType.map(v => ({ value: v, label: v }))} />
                        </div>
                      )}
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Rule Name *</Text>
                        <Input size="small" value={inst.ruleName} placeholder="e.g. high-cpu"
                          onChange={e => updateAlertTypeInstance(inst._id, { ruleName: e.target.value })} />
                      </div>
                    </div>

                    {decls.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Var Values</Text>
                        {decls.map(v => (
                          <div key={v.name} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                            <Input size="small" value={v.name} readOnly style={{ width: '28%', background: '#fafafa', color: '#8c8c8c' }} />
                            <Tag color="blue" style={{ fontSize: 11 }}>{v.type || 'string'}</Tag>
                            <div style={{ flex: 1 }}>
                              <VarInput type={v.type || 'string'} value={inst.vars[v.name] || ''}
                                onChange={val => updateAlertTypeInstance(inst._id, { vars: { ...inst.vars, [v.name]: val } })} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Severity</Text>
                        <Select size="small" value={inst.severity} onChange={val => updateAlertTypeInstance(inst._id, { severity: val })}
                          style={{ width: '100%' }} options={SEVERITIES.map(s => ({ value: s, label: s }))} />
                      </div>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>For</Text>
                        <Input size="small" value={inst.for} placeholder="e.g. 5m"
                          onChange={e => updateAlertTypeInstance(inst._id, { for: e.target.value })} />
                      </div>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Description</Text>
                        <Input size="small" value={inst.description} placeholder="Optional"
                          onChange={e => updateAlertTypeInstance(inst._id, { description: e.target.value })} />
                      </div>
                    </div>
                  </Card>
                )
              })}
            </Card>

            {/* Alert Subscription */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Alert Subscription</Text>
                <Checkbox checked={!!form.subscription?.enabled}
                  onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, enabled: e.target.checked } }))}>
                  <Text style={{ fontSize: 12 }}>Enable wrapping</Text>
                </Checkbox>
              </div>
              {!form.subscription?.enabled ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  When enabled, every rule expr is wrapped:
                  <code style={{ fontFamily: 'monospace', marginLeft: 4 }}>{'(expr) * on(...) group_left(user) <metric>'}</code>
                </Text>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Subscription Metric *</Text>
                      <Input size="small" value={form.subscription.metric} placeholder="e.g. alert_subscriptions"
                        onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, metric: e.target.value } }))} />
                    </div>
                    <div>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Join Labels <Text type="secondary" style={{ fontSize: 10 }}>on(...)</Text></Text>
                      <Input size="small" value={form.subscription.onLabels} placeholder="e.g. namespace, pod"
                        onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, onLabels: e.target.value } }))} />
                    </div>
                    <div>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Carry-over Labels <Text type="secondary" style={{ fontSize: 10 }}>group_left(...)</Text></Text>
                      <Input size="small" value={form.subscription.groupLeftLabels} placeholder="e.g. user"
                        onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, groupLeftLabels: e.target.value } }))} />
                    </div>
                  </div>
                  {form.subscription.metric && (
                    <div style={{ padding: '6px 10px', borderRadius: 4, background: '#f6ffed', border: '1px solid #b7eb8f', fontSize: 12, fontFamily: 'monospace', color: '#389e0d', wordBreak: 'break-all' }}>
                      {`(expr) * `}
                      {form.subscription.onLabels?.trim() ? `on(${form.subscription.onLabels.trim()}) ` : ''}
                      {`group_left(${form.subscription.groupLeftLabels?.trim() || ''}) `}
                      {form.subscription.metric}
                    </div>
                  )}
                </>
              )}
            </Card>

            {/* Rules */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Rules</Text>
                <Button size="small" onClick={openImport}>Import Rules...</Button>
                <Button size="small" icon={<PlusOutlined />} onClick={addRule}>Add Rule</Button>
              </div>
              {form.rules.length === 0 && <Text type="secondary">No rules yet.</Text>}
              {form.rules.map((rule, i) => {
                const isBuiltin = rule.alertTypeName === DIRECT_EXPR_TYPE
                const versionsForType = rule.alertTypeName && !isBuiltin ? (alertTypes[rule.alertTypeName] || []) : []
                return (
                  <Card key={i} size="small" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span>
                        <Text strong style={{ fontSize: 13 }}>
                          Rule {i + 1}{rule.ruleName ? `: ${rule.ruleName}` : ''}
                        </Text>
                        {isBuiltin && <Tag color="blue" style={{ marginLeft: 8, fontSize: 10 }}>direct-expr</Tag>}
                      </span>
                      <Button danger size="small" onClick={() => removeRule(i)}>Remove</Button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: isBuiltin ? '1fr 1fr' : '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Alert Type *</Text>
                        <Select size="small" value={rule.alertTypeName || undefined}
                          onChange={val => handleRuleTypeChange(i, 'alertTypeName', val || '')}
                          placeholder="-- select --" style={{ width: '100%' }}
                          options={[
                            { value: DIRECT_EXPR_TYPE, label: 'direct-expr (built-in)' },
                            ...Object.keys(alertTypes).map(n => ({ value: n, label: n })),
                          ]} />
                      </div>
                      {!isBuiltin && (
                        <div>
                          <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Version *</Text>
                          <Select size="small" value={rule.alertTypeVersion || undefined}
                            onChange={val => handleRuleTypeChange(i, 'alertTypeVersion', val || '')}
                            placeholder="-- select --" style={{ width: '100%' }}
                            options={versionsForType.map(v => ({ value: v, label: v }))} />
                        </div>
                      )}
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Rule Name *</Text>
                        <Input size="small" value={rule.ruleName} placeholder="e.g. high-cpu"
                          onChange={e => updateRule(i, 'ruleName', e.target.value)} />
                      </div>
                    </div>

                    {!isBuiltin && rule.vars.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Var Values</Text>
                        {rule.vars.map((v, vi) => (
                          <div key={vi} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                            <Input size="small" value={v.key} readOnly style={{ width: '28%', background: '#fafafa', color: '#8c8c8c' }} />
                            <Tag color="blue" style={{ fontSize: 11 }}>{v.type || 'string'}</Tag>
                            <div style={{ flex: 1 }}>
                              <VarInput type={v.type || 'string'} value={v.value}
                                onChange={val => {
                                  const vars = rule.vars.map((vv, vvi) => vvi === vi ? { ...vv, value: val } : vv)
                                  updateRule(i, 'vars', vars)
                                }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {!isBuiltin && rule.vars.length === 0 && rule.alertTypeName && rule.alertTypeVersion && (
                      <Text type="secondary" style={{ display: 'block', marginBottom: 10 }}>This alert type declares no vars.</Text>
                    )}

                    {/* Expression editor */}
                    {(() => {
                      const exprVal = isBuiltin ? directExprValue(rule.vars) : rule.expr
                      const setExpr = val => isBuiltin
                        ? updateRule(i, 'vars', [{ key: 'expr', value: val, type: 'string' }])
                        : updateRule(i, 'expr', val)
                      return (
                        <div style={{ marginTop: 10, marginBottom: 10 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              Expression (PromQL)
                              {!isBuiltin && <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>overrides template rendering</Text>}
                            </Text>
                            <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #d9d9d9', fontSize: 11 }}>
                              {[['visual', 'Visual Builder'], ['raw', 'Raw / PromQL']].map(([k, lbl]) => (
                                <button key={k} style={{
                                  padding: '2px 10px', border: 'none', cursor: 'pointer', fontWeight: 600,
                                  background: rule.exprMode === k ? '#6366f1' : '#fff',
                                  color: rule.exprMode === k ? '#fff' : '#8c8c8c',
                                }} onClick={() => updateRule(i, 'exprMode', k)}>{lbl}</button>
                              ))}
                            </div>
                          </div>
                          <Suspense fallback={
                            <div style={{ height: 56, background: '#0f172a', borderRadius: 6,
                              display: 'flex', alignItems: 'center', paddingLeft: 14,
                              color: '#475569', fontSize: 12 }}>Loading...</div>
                          }>
                            {rule.exprMode === 'visual'
                              ? <PromQLBuilder dict={metricsDict} onChange={setExpr} />
                              : <PromQLEditor value={exprVal} metrics={metricsDict} onChange={setExpr} />
                            }
                          </Suspense>
                        </div>
                      )
                    })()}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Severity</Text>
                        <Select size="small" value={rule.severity} onChange={val => updateRule(i, 'severity', val)}
                          style={{ width: '100%' }} options={SEVERITIES.map(s => ({ value: s, label: s }))} />
                      </div>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>For (override)</Text>
                        <Input size="small" value={rule.for} placeholder="e.g. 10m"
                          onChange={e => updateRule(i, 'for', e.target.value)} />
                      </div>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Description</Text>
                        <Input size="small" value={rule.description} placeholder="Optional"
                          onChange={e => updateRule(i, 'description', e.target.value)} />
                      </div>
                    </div>

                    <div>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Labels</Text>
                      <KVEditor rows={rule.labels} onChange={rows => updateRule(i, 'labels', rows)}
                        keyPlaceholder="label key" valuePlaceholder="value" />
                    </div>
                  </Card>
                )
              })}
            </Card>

            <Space>
              <Button type="primary" onClick={openSaveModal}>Save as Version...</Button>
              {selected && <Button danger onClick={handleDelete}>Delete this version</Button>}
            </Space>
          </div>

          {showPreview && (
            <div style={{
              width: 400, minWidth: 320, borderLeft: '1px solid #f0f0f0',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{
                padding: '10px 16px', borderBottom: '1px solid #f0f0f0',
                fontSize: 12, fontWeight: 600, color: '#8c8c8c',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                YAML Preview
                {product && <Text type="secondary" style={{ fontSize: 11 }}>product: {product}</Text>}
              </div>
              <pre style={{
                flex: 1, overflowY: 'auto', margin: 0,
                padding: '14px 16px', fontSize: 11.5,
                fontFamily: "'Fira Code', 'Cascadia Code', monospace",
                background: '#0f172a', color: '#7dd3fc', lineHeight: 1.7,
                whiteSpace: 'pre', overflowX: 'auto',
              }}>
                {preview}
              </pre>
            </div>
          )}
        </div>
      )}

      {modal && <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />}

      <Modal title="Import Prometheus Rules" open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={confirmImport}
        okText="Import Selected"
        okButtonProps={{ disabled: !Object.values(importSel).some(Boolean) }}
        width={720}>
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <Input value={importPath} onChange={e => setImportPath(e.target.value)}
            placeholder="Path to scan (default: gitops-deploy/)"
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            onPressEnter={() => rescanImport(importPath)} />
          <Button onClick={() => rescanImport(importPath)}>Scan</Button>
        </Space.Compact>
        {importLoading && <Text type="secondary">Scanning for PrometheusRule YAML files...</Text>}
        {!importLoading && importGroups.length === 0 && (
          <Text type="secondary">No PrometheusRule YAML files found. Try a different path.</Text>
        )}
        {!importLoading && importGroups.length > 0 && (
          <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            {importGroups.map((g, gi) => (
              <div key={gi} style={{ marginBottom: 14 }}>
                <div style={{ marginBottom: 6 }}>
                  <Text strong style={{ fontSize: 12, color: '#8c8c8c' }}>
                    {g.groupName}
                    <Text type="secondary" style={{ fontWeight: 400, marginLeft: 8 }}>{g.sourceFile}</Text>
                  </Text>
                  {g.groupLabels && Object.keys(g.groupLabels).length > 0 && (
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>group labels:</Text>
                      {Object.entries(g.groupLabels).map(([k, v]) => (
                        <Tag key={k} color="green" style={{ fontSize: 11, fontFamily: 'monospace' }}>{k}: {v}</Tag>
                      ))}
                    </div>
                  )}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <th style={{ width: 28, padding: '4px 8px' }}></th>
                      <th style={{ width: '28%', textAlign: 'left', padding: '4px 8px', color: '#8c8c8c', fontWeight: 600 }}>alert</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', color: '#8c8c8c', fontWeight: 600 }}>expr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rules.map((r, ri) => {
                      const key = `${gi}:${ri}`
                      return (
                        <tr key={ri} style={{ borderBottom: '1px solid #fafafa' }}>
                          <td style={{ padding: '4px 8px' }}>
                            <Checkbox checked={!!importSel[key]} onChange={() => toggleImportRule(gi, ri)} />
                          </td>
                          <td style={{ padding: '4px 8px', fontWeight: 500 }}>{r.alertName || '—'}</td>
                          <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, color: '#595959', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={r.expr}>{r.expr}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </EditorLayout>
  )
}
