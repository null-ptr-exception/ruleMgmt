import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import KVEditor from '../components/KVEditor'
import VersionModal from '../components/VersionModal'
const PromQLEditor  = lazy(() => import('../components/PromQLEditor'))
const PromQLBuilder = lazy(() => import('../components/PromQLBuilder'))
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, importPrometheusRules, getMetricsDict } from '../utils/api'
import { kvArrayToObject, objectToKvArray, bumpPatch, latestVersion } from '../utils/templateUtils'

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
    // expr: for direct-expr use the vars field; for all others use rule.expr directly
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

// ── Built-in "direct-expr" rule type ─────────────────────────────────────────
// The expression IS the variable value: edit the full PromQL string directly.
// alertTypeName='direct-expr', no version, single var { expr }.

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
      <input type="text" value={internalName} placeholder="metric_name"
        style={{ marginBottom: 4 }}
        onChange={e => { setInternalName(e.target.value); commit(e.target.value, internalLabels) }} />
      {internalLabels.length > 0 && (
        <table className="kv-table" style={{ marginBottom: 4 }}>
          <colgroup>
            <col /><col style={{ width: 52 }} /><col /><col style={{ width: 28 }} />
          </colgroup>
          <thead><tr><th>label</th><th>op</th><th>value</th><th></th></tr></thead>
          <tbody>
            {internalLabels.map((l, i) => (
              <tr key={i}>
                <td><input type="text" value={l.key} placeholder="label"
                  onChange={e => updateLabel(i, 'key', e.target.value)} /></td>
                <td>
                  <select value={l.op || '='} onChange={e => updateLabel(i, 'op', e.target.value)}
                    style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    {LABEL_MATCHER_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </td>
                <td><input type="text" value={l.value}
                  placeholder={l.op?.includes('~') ? 'regex' : 'value'}
                  onChange={e => updateLabel(i, 'value', e.target.value)} /></td>
                <td><button className="btn btn-ghost btn-icon" onClick={() => removeLabel(i)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="btn btn-ghost btn-sm" onClick={addLabel}>+ Add matcher</button>
    </div>
  )
}

// ── Type-aware var value input ────────────────────────────────────────────────

function VarInput({ type, value, onChange }) {
  if (type === 'op') {
    return (
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">— select —</option>
        {OP_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (type === 'func') {
    return (
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">— select —</option>
        {FUNC_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
    )
  }
  if (type === 'int') {
    return (
      <input type="number" value={value} onChange={e => onChange(e.target.value)}
        style={{ width: '100%' }} />
    )
  }
  if (type === 'metrics') {
    return <MetricsInput value={value} onChange={onChange} />
  }
  // string, time, default: auto-expanding textarea
  return (
    <textarea value={value} placeholder={type === 'time' ? 'e.g. 5m' : 'fill value'}
      rows={1}
      style={{ resize: 'none', overflowY: 'hidden', width: '100%', minHeight: 'unset', fontFamily: 'inherit' }}
      onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
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
  vars: [],        // [{ key, value, type }]
  expr: '',        // direct PromQL expression (used for direct-expr type and as explicit override)
  exprMode: 'raw', // 'visual' | 'raw'
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
  vars: {},         // { varName: value }
})

const emptyAlertTypeInstance = () => ({
  _id: uid(),
  alertTypeName:    '',
  alertTypeVersion: '',
  ruleName:         '',
  vars:             {},   // { varName: value }
  severity:         'warning',
  for:              '',
  description:      '',
  labels:           [],
})

const emptyForm = () => ({
  groupName:          '',
  groupLabels:        [],   // [{key, value}]
  packInstances:      [],   // [{ _id, packName, packVersion, alertNamePrefix, vars }]
  alertTypeInstances: [],   // [{ _id, alertTypeName, alertTypeVersion, ruleName, vars, severity, for, description, labels }]
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
    // r.labels is an object {severity: 'warning', team: 'platform', ...}
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

  // Import state
  const [importOpen, setImportOpen]       = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importGroups, setImportGroups]   = useState([])
  const [importSel, setImportSel]         = useState({})  // key: `${gi}:${ri}` → bool
  const [importPath, setImportPath]       = useState('')  // relative path to scan; empty = gitops-deploy/

  // Cache of alert type var declarations: { "name@version": [{name, description, type}] }
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

    // Use manualRules (UI-only rules) if saved, otherwise fall back to all rules
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

    // migrate old string groupLabel → [{key,value}]
    let groupLabels = []
    if (s.groupLabels && typeof s.groupLabels === 'object') {
      groupLabels = objectToKvArray(s.groupLabels)
    } else if (typeof s.groupLabel === 'string' && s.groupLabel.includes(':')) {
      const [k, ...rest] = s.groupLabel.split(':')
      groupLabels = [{ key: k.trim(), value: rest.join(':').trim() }]
    }

    // Restore pack instances (load their data into cache eagerly)
    const rawInstances = s.packInstances || []
    const packInstances = await Promise.all(rawInstances.map(async inst => {
      await loadPackData(inst.packName, inst.packVersion)
      return {
        _id:             uid(),
        packName:        inst.packName        || '',
        packVersion:     inst.packVersion     || '',
        alertNamePrefix: inst.alertNamePrefix || '',
        vars:            inst.vars            || {},
      }
    }))

    // Restore alert type instances (eagerly prime varDeclCache)
    const rawTypeInstances = s.alertTypeInstances || []
    const alertTypeInstances = await Promise.all(rawTypeInstances.map(async inst => {
      if (inst.alertTypeName && inst.alertTypeVersion) {
        await loadVarDecls(inst.alertTypeName, inst.alertTypeVersion)
      }
      return {
        _id:              uid(),
        alertTypeName:    inst.alertTypeName    || '',
        alertTypeVersion: inst.alertTypeVersion || '',
        ruleName:         inst.ruleName         || '',
        vars:             inst.vars             || {},
        severity:         inst.severity         || 'warning',
        for:              inst.for              || '',
        description:      inst.description      || '',
        labels:           objectToKvArray(inst.labels || {}),
      }
    }))

    const savedSub = s.subscription || {}
    setForm({
      groupName:          s.name || name,
      groupLabels,
      packInstances,
      alertTypeInstances,
      rules,
      subscription: {
        enabled:         !!savedSub.enabled,
        onLabels:        savedSub.onLabels        || '',
        groupLeftLabels: savedSub.groupLeftLabels || 'user',
        metric:          savedSub.metric          || '',
      },
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
  }

  async function handleRuleTypeChange(i, field, val) {
    // Built-in direct-expr: single expr var, no version needed
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
          const vars = decls.map(d => ({
            key:   d.name,
            value: String(existing[d.name] ?? ''),
            type:  d.type || 'string',
          }))
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
    setImportOpen(true)
    setImportLoading(true)
    setImportSel({})
    try {
      const { groups } = await importPrometheusRules(importPath)
      setImportGroups(groups || [])
    } catch {
      setImportGroups([])
    }
    setImportLoading(false)
  }

  async function rescanImport(path) {
    setImportPath(path)
    setImportLoading(true)
    setImportSel({})
    try {
      const { groups } = await importPrometheusRules(path)
      setImportGroups(groups || [])
    } catch {
      setImportGroups([])
    }
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
          alertTypeName:    DIRECT_EXPR_TYPE,
          alertTypeVersion: '',
          vars:             [{ key: 'expr', value: r.expr || '', type: 'string' }],
          ruleName:         r.alertName || '',
          for:              r.for       || '',
          description:      r.annotations?.description || r.annotations?.summary || '',
          severity:         r.labels?.severity || 'warning',
          labels:           objectToKvArray(Object.fromEntries(
            Object.entries(r.labels || {}).filter(([k]) => k !== 'severity')
          )),
        })
      })
    })
    if (toAdd.length) {
      setForm(f => ({
        ...f,
        rules: [...f.rules, ...toAdd],
        groupLabels: f.groupLabels.length === 0 && mergedGroupLabels
          ? objectToKvArray(mergedGroupLabels)
          : f.groupLabels,
      }))
    }
    setImportOpen(false)
  }

  function serializeRule(r) {
    const isBuiltin = r.alertTypeName === DIRECT_EXPR_TYPE
    const exprVal = isBuiltin ? directExprValue(r.vars) : (r.expr || '')
    const obj = {
      alertTypeName:    r.alertTypeName,
      alertTypeVersion: isBuiltin ? undefined : r.alertTypeVersion,
      ruleName:         r.ruleName,
      vars:             kvArrayToObject(r.vars),
      severity:         r.severity,
    }
    if (exprVal) obj.expr = exprVal
    if (r.exprMode && r.exprMode !== 'raw') obj.exprMode = r.exprMode
    if (r.for)         obj.for = r.for
    if (r.description) obj.description = r.description
    const labels = kvArrayToObject(r.labels || [])
    if (Object.keys(labels).length) obj.labels = labels
    return obj
  }

  function buildPayload() {
    // Expand all pack instances into rules (Helm-renderable)
    const packExpandedRules = form.packInstances.flatMap(inst => {
      const packData = packDataCache[`${inst.packName}@${inst.packVersion}`]
      if (!packData) return []
      return expandPackInstance(packData, inst).map(r => {
        const extraLabels = kvArrayToObject(r.labels || [])
        return {
          alertTypeName: DIRECT_EXPR_TYPE,
          ruleName:      r.ruleName,
          expr:          directExprValue(r.vars),
          vars:          {},
          severity:      r.severity,
          ...(r.for         ? { for: r.for }               : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(Object.keys(extraLabels).length ? { labels: extraLabels } : {}),
        }
      })
    })

    // Serialize alert type instances as rules
    const typeInstanceRules = form.alertTypeInstances
      .filter(inst => inst.alertTypeName && inst.alertTypeVersion)
      .map(inst => {
        const obj = {
          alertTypeName:    inst.alertTypeName,
          alertTypeVersion: inst.alertTypeVersion,
          ruleName:         inst.ruleName,
          vars:             inst.vars,
          severity:         inst.severity,
        }
        if (inst.for) obj.for = inst.for
        if (inst.description) obj.description = inst.description
        const labels = kvArrayToObject(inst.labels || [])
        if (Object.keys(labels).length) obj.labels = labels
        return obj
      })

    const manualRules = form.rules.map(serializeRule)

    const alertSuite = {
      name:        form.groupName,
      groupLabels: kvArrayToObject(form.groupLabels),
      rules:       [...packExpandedRules, ...typeInstanceRules, ...manualRules],
    }

    if (form.subscription?.enabled) {
      alertSuite.subscription = {
        enabled:         true,
        onLabels:        form.subscription.onLabels.trim(),
        groupLeftLabels: form.subscription.groupLeftLabels.trim(),
        metric:          form.subscription.metric.trim(),
      }
    }

    // Store instances and manual rules separately for UI state restoration
    if (form.packInstances.length > 0 || form.alertTypeInstances.length > 0) {
      alertSuite.packInstances = form.packInstances.map(({ _id, ...rest }) => rest)
      alertSuite.alertTypeInstances = form.alertTypeInstances.map(({ _id, labels, ...rest }) => ({
        ...rest,
        ...(kvArrayToObject(labels || []) && Object.keys(kvArrayToObject(labels || [])).length
          ? { labels: kvArrayToObject(labels) }
          : {}),
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
    const v = selected
      ? bumpPatch(selected.version)
      : (n && templates[n] ? bumpPatch(latestVersion(templates[n])) : 'v1.0.0')
    setModal({ name: n, version: v })
  }

  // ── Pack instance CRUD ─────────────────────────────────────────────────────

  function addPackInstance() {
    setForm(f => ({ ...f, packInstances: [...f.packInstances, emptyPackInstance()] }))
  }
  function removePackInstance(id) {
    setForm(f => ({ ...f, packInstances: f.packInstances.filter(p => p._id !== id) }))
  }
  function updatePackInstance(id, changes) {
    setForm(f => ({ ...f, packInstances: f.packInstances.map(p => p._id === id ? { ...p, ...changes } : p) }))
  }
  async function handlePackChange(id, packName, packVersion) {
    const data = await loadPackData(packName, packVersion)
    const vars = {}
    if (data?.vars) for (const v of data.vars) vars[v.name] = ''
    updatePackInstance(id, { packName, packVersion, vars })
  }

  // ── Alert type instance CRUD ───────────────────────────────────────────────

  function addAlertTypeInstance() {
    setForm(f => ({ ...f, alertTypeInstances: [...f.alertTypeInstances, emptyAlertTypeInstance()] }))
  }
  function removeAlertTypeInstance(id) {
    setForm(f => ({ ...f, alertTypeInstances: f.alertTypeInstances.filter(p => p._id !== id) }))
  }
  function updateAlertTypeInstance(id, changes) {
    setForm(f => ({ ...f, alertTypeInstances: f.alertTypeInstances.map(p => p._id === id ? { ...p, ...changes } : p) }))
  }
  async function handleAlertTypeInstanceChange(id, field, val) {
    updateAlertTypeInstance(id, { [field]: val })
    const inst = form.alertTypeInstances.find(p => p._id === id)
    const atName = field === 'alertTypeName'    ? val : inst?.alertTypeName
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

  // ── Preview (includes pack-expanded rules) ─────────────────────────────────

  const allPreviewRules = useMemo(() => {
    const packRules = form.packInstances.flatMap(inst => {
      const packData = packDataCache[`${inst.packName}@${inst.packVersion}`]
      if (!packData) return []
      return expandPackInstance(packData, inst)
    })
    const typeInstRules = form.alertTypeInstances
      .filter(inst => inst.alertTypeName && inst.alertTypeVersion)
      .map(inst => {
        const decls = varDeclCache[`${inst.alertTypeName}@${inst.alertTypeVersion}`] || []
        return {
          ...emptyRule(),
          alertTypeName:    inst.alertTypeName,
          alertTypeVersion: inst.alertTypeVersion,
          ruleName:         inst.ruleName,
          vars:             decls.map(d => ({ key: d.name, value: String(inst.vars[d.name] ?? ''), type: d.type || 'string' })),
          severity:         inst.severity,
          for:              inst.for,
          description:      inst.description,
          labels:           inst.labels || [],
        }
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

  return (
    <div className="editor-layout">
      <div className="editor-list">
        <div className="editor-list-header">
          Rule Groups
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No groups yet.</div>
          )}
          {Object.entries(templates).map(([name, versions]) => (
            <div key={name} className="template-group">
              <div className="template-group-name">{name}</div>
              {versions.map(v => (
                <div key={v}
                  className={`template-version${selected?.name === name && selected?.version === v ? ' active' : ''}`}
                  onClick={() => selectVersion(name, v)}
                >
                  <span className="version-badge">{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="editor-form" style={showPreview && (isNew || selected) ? { display: 'flex', gap: 0, padding: 0, overflow: 'hidden' } : {}}>
        {!isNew && !selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">📦</div>
            <p>Select a rule group or click + New.</p>
          </div>
        ) : (
          <div style={showPreview ? { display: 'flex', width: '100%', height: '100%', overflow: 'hidden' } : {}}>
          <div style={showPreview ? { flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 } : {}}>
            <div className="form-card">
              <div className="form-card-title">
                <span>
                  {selected ? `${selected.name} @ ${selected.version}` : 'New Rule Group'}
                  {status && <span className="tag">{status}</span>}
                </span>
                <button
                  className={`btn btn-sm ${showPreview ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowPreview(v => !v)}
                >
                  {showPreview ? 'Hide Preview' : 'Show Preview'}
                </button>
              </div>
              <div className="form-row" style={{ marginBottom: 10 }}>
                <label>Group Name *</label>
                <input type="text" value={form.groupName} placeholder="e.g. platform-group"
                  onChange={e => setForm(f => ({ ...f, groupName: e.target.value }))} />
              </div>
              <div className="form-row">
                <label>Group Labels
                  <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
                    added to every rule in this group on render
                  </span>
                </label>
                <KVEditor
                  rows={form.groupLabels}
                  onChange={rows => setForm(f => ({ ...f, groupLabels: rows }))}
                  keyPlaceholder="label key" valuePlaceholder="value"
                />
              </div>
            </div>

            {/* Pack Instances */}
            <div className="form-card">
              <div className="form-card-title">
                Alert Pack Instances
                <button className="btn btn-secondary btn-sm" onClick={addPackInstance}>+ Add Pack</button>
              </div>
              {form.packInstances.length === 0 ? (
                <p className="text-muted">No packs. Add a pack to bulk-generate multiple related alert rules at once.</p>
              ) : form.packInstances.map(inst => {
                const packData = packDataCache[`${inst.packName}@${inst.packVersion}`]
                const packVersions = packTemplates[inst.packName] || []
                const expanded = packData ? expandPackInstance(packData, inst) : []
                return (
                  <div key={inst._id} style={{
                    border: '1px solid #ddd6fe', borderRadius: 6, padding: 14, marginBottom: 10,
                    background: '#faf5ff',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#6d28d9' }}>
                        {inst.packName || 'New Pack Instance'}
                        {inst.packVersion && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: '#7c3aed' }}>@ {inst.packVersion}</span>
                        )}
                        {packData && (
                          <span style={{
                            marginLeft: 8, fontSize: 11, background: '#ede9fe', color: '#5b21b6',
                            padding: '1px 7px', borderRadius: 4,
                          }}>
                            {packData.rules?.length || 0} rules
                          </span>
                        )}
                      </span>
                      <button className="btn btn-danger btn-sm" onClick={() => removePackInstance(inst._id)}>Remove</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Pack Template</label>
                        <select value={inst.packName}
                          onChange={e => handlePackChange(inst._id, e.target.value, '')}>
                          <option value="">— select —</option>
                          {Object.keys(packTemplates).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      {inst.packName && (
                        <div className="form-row" style={{ marginBottom: 0 }}>
                          <label>Version</label>
                          <select value={inst.packVersion}
                            onChange={e => handlePackChange(inst._id, inst.packName, e.target.value)}>
                            <option value="">— select —</option>
                            {packVersions.map(v => <option key={v} value={v}>{v}</option>)}
                          </select>
                        </div>
                      )}
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>
                          Alert Name Prefix
                          <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 5, fontWeight: 400 }}>
                            {'→ {{ .alertName }}'}
                          </span>
                        </label>
                        <input type="text" value={inst.alertNamePrefix} placeholder="e.g. high-cpu"
                          onChange={e => updatePackInstance(inst._id, { alertNamePrefix: e.target.value })} />
                      </div>
                    </div>

                    {/* Var inputs */}
                    {packData?.vars?.length > 0 && (
                      <div className="form-row" style={{ marginBottom: expanded.length ? 10 : 0 }}>
                        <label>Pack Variables</label>
                        <table className="kv-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                          <colgroup>
                            <col style={{ width: '28%' }} />
                            <col style={{ width: '14%' }} />
                            <col />
                          </colgroup>
                          <thead><tr><th>var name</th><th>type</th><th>value</th></tr></thead>
                          <tbody>
                            {packData.vars.map(v => (
                              <tr key={v.name}>
                                <td>
                                  <input type="text" value={v.name} readOnly
                                    style={{ background: '#f9fafb', color: '#6b7280' }} />
                                </td>
                                <td>
                                  <span style={{
                                    fontSize: 11, background: '#ede9fe', color: '#5b21b6',
                                    padding: '2px 6px', borderRadius: 4, display: 'inline-block',
                                  }}>{v.type || 'string'}</span>
                                </td>
                                <td>
                                  <VarInput
                                    type={v.type || 'string'}
                                    value={inst.vars[v.name] || ''}
                                    onChange={val => updatePackInstance(inst._id, {
                                      vars: { ...inst.vars, [v.name]: val },
                                    })}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Expanded rules preview */}
                    {expanded.length > 0 && (
                      <div style={{
                        background: '#f1f0ff', borderRadius: 5, padding: '8px 12px',
                        border: '1px solid #ddd6fe',
                      }}>
                        <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 5 }}>
                          Will generate {expanded.length} rule{expanded.length !== 1 ? 's' : ''}:
                        </div>
                        {expanded.map((r, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#5b21b6', fontWeight: 600 }}>
                              {r.ruleName || '—'}
                            </span>
                            <span style={{
                              fontSize: 10, background: r.severity === 'critical' ? '#fee2e2' : r.severity === 'warning' ? '#fef3c7' : '#e0e7ff',
                              color: r.severity === 'critical' ? '#b91c1c' : r.severity === 'warning' ? '#92400e' : '#3730a3',
                              padding: '0 5px', borderRadius: 3, fontWeight: 600,
                            }}>{r.severity}</span>
                            <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {directExprValue(r.vars) || '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Alert Type Instances */}
            <div className="form-card">
              <div className="form-card-title">
                Alert Type Instances
                <button className="btn btn-secondary btn-sm" onClick={addAlertTypeInstance}>+ Add Type</button>
              </div>
              {form.alertTypeInstances.length === 0 ? (
                <p className="text-muted">No type instances. Add an alert type to create a single parameterised rule from a template.</p>
              ) : form.alertTypeInstances.map(inst => {
                const decls = varDeclCache[`${inst.alertTypeName}@${inst.alertTypeVersion}`] || []
                const versionsForType = inst.alertTypeName ? (alertTypes[inst.alertTypeName] || []) : []
                return (
                  <div key={inst._id} style={{
                    border: '1px solid #bfdbfe', borderRadius: 6, padding: 14, marginBottom: 10,
                    background: '#eff6ff',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#1d4ed8' }}>
                        {inst.alertTypeName || 'New Type Instance'}
                        {inst.alertTypeVersion && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: '#2563eb' }}>@ {inst.alertTypeVersion}</span>
                        )}
                        {decls.length > 0 && (
                          <span style={{
                            marginLeft: 8, fontSize: 11, background: '#dbeafe', color: '#1e40af',
                            padding: '1px 7px', borderRadius: 4,
                          }}>
                            {decls.length} var{decls.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </span>
                      <button className="btn btn-danger btn-sm" onClick={() => removeAlertTypeInstance(inst._id)}>Remove</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Alert Type</label>
                        <select value={inst.alertTypeName}
                          onChange={e => handleAlertTypeInstanceChange(inst._id, 'alertTypeName', e.target.value)}>
                          <option value="">— select —</option>
                          {Object.keys(alertTypes).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      {inst.alertTypeName && (
                        <div className="form-row" style={{ marginBottom: 0 }}>
                          <label>Version</label>
                          <select value={inst.alertTypeVersion}
                            onChange={e => handleAlertTypeInstanceChange(inst._id, 'alertTypeVersion', e.target.value)}>
                            <option value="">— select —</option>
                            {versionsForType.map(v => <option key={v} value={v}>{v}</option>)}
                          </select>
                        </div>
                      )}
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Rule Name *</label>
                        <input type="text" value={inst.ruleName} placeholder="e.g. high-cpu"
                          onChange={e => updateAlertTypeInstance(inst._id, { ruleName: e.target.value })} />
                      </div>
                    </div>

                    {decls.length > 0 && (
                      <div className="form-row" style={{ marginBottom: 10 }}>
                        <label>Var Values</label>
                        <table className="kv-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                          <colgroup>
                            <col style={{ width: '28%' }} />
                            <col style={{ width: '14%' }} />
                            <col />
                          </colgroup>
                          <thead><tr><th>var name</th><th>type</th><th>value</th></tr></thead>
                          <tbody>
                            {decls.map(v => (
                              <tr key={v.name}>
                                <td>
                                  <input type="text" value={v.name} readOnly
                                    style={{ background: '#f9fafb', color: '#6b7280' }} />
                                </td>
                                <td>
                                  <span style={{
                                    fontSize: 11, background: '#dbeafe', color: '#1d4ed8',
                                    padding: '2px 6px', borderRadius: 4, display: 'inline-block',
                                  }}>{v.type || 'string'}</span>
                                </td>
                                <td>
                                  <VarInput
                                    type={v.type || 'string'}
                                    value={inst.vars[v.name] || ''}
                                    onChange={val => updateAlertTypeInstance(inst._id, {
                                      vars: { ...inst.vars, [v.name]: val },
                                    })}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Severity</label>
                        <select value={inst.severity}
                          onChange={e => updateAlertTypeInstance(inst._id, { severity: e.target.value })}>
                          {SEVERITIES.map(s => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>For</label>
                        <input type="text" value={inst.for} placeholder="e.g. 5m"
                          onChange={e => updateAlertTypeInstance(inst._id, { for: e.target.value })} />
                      </div>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Description</label>
                        <input type="text" value={inst.description} placeholder="Optional"
                          onChange={e => updateAlertTypeInstance(inst._id, { description: e.target.value })} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Alert Subscription Wrapping */}
            <div className="form-card">
              <div className="form-card-title">
                Alert Subscription
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontWeight: 400, fontSize: 12 }}>
                  <input type="checkbox" checked={!!form.subscription?.enabled}
                    onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, enabled: e.target.checked } }))} />
                  Enable wrapping
                </label>
              </div>
              {!form.subscription?.enabled ? (
                <p className="text-muted">
                  When enabled, every rule expr is wrapped:
                  <span style={{ fontFamily: 'monospace', marginLeft: 4 }}>
                    {'(expr) * on(…) group_left(user) <metric>'}
                  </span>
                  — adds a subscription label to each alert firing for per-user routing.
                </p>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>Subscription Metric *</label>
                      <input type="text" value={form.subscription.metric}
                        placeholder="e.g. alert_subscriptions"
                        onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, metric: e.target.value } }))} />
                    </div>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>Join Labels <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>on(…)</span></label>
                      <input type="text" value={form.subscription.onLabels}
                        placeholder="e.g. namespace, pod"
                        onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, onLabels: e.target.value } }))} />
                    </div>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>Carry-over Labels <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>group_left(…)</span></label>
                      <input type="text" value={form.subscription.groupLeftLabels}
                        placeholder="e.g. user"
                        onChange={e => setForm(f => ({ ...f, subscription: { ...f.subscription, groupLeftLabels: e.target.value } }))} />
                    </div>
                  </div>
                  {form.subscription.metric && (
                    <div style={{
                      padding: '6px 10px', borderRadius: 4, background: '#f0fdf4',
                      border: '1px solid #bbf7d0', fontSize: 12, fontFamily: 'monospace',
                      color: '#166534', wordBreak: 'break-all',
                    }}>
                      {`(expr) * `}
                      {form.subscription.onLabels?.trim() ? `on(${form.subscription.onLabels.trim()}) ` : ''}
                      {`group_left(${form.subscription.groupLeftLabels?.trim() || ''}) `}
                      {form.subscription.metric}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="form-card">
              <div className="form-card-title">
                Rules
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={openImport}>Import Rules…</button>
                  <button className="btn btn-secondary btn-sm" onClick={addRule}>+ Add Rule</button>
                </div>
              </div>
              {form.rules.length === 0 && <p className="text-muted">No rules yet.</p>}
              {form.rules.map((rule, i) => {
                const isBuiltin = rule.alertTypeName === DIRECT_EXPR_TYPE
                const versionsForType = rule.alertTypeName && !isBuiltin ? (alertTypes[rule.alertTypeName] || []) : []
                return (
                  <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>
                        Rule {i + 1}{rule.ruleName ? `: ${rule.ruleName}` : ''}
                        {isBuiltin && (
                          <span style={{ marginLeft: 8, fontSize: 10, background: '#dbeafe', color: '#1d4ed8',
                            padding: '1px 6px', borderRadius: 4, fontWeight: 600 }}>
                            direct-expr
                          </span>
                        )}
                      </span>
                      <button className="btn btn-danger btn-sm" onClick={() => removeRule(i)}>Remove</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: isBuiltin ? '1fr 1fr' : '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div className="form-row">
                        <label>Alert Type *</label>
                        <select value={rule.alertTypeName}
                          onChange={e => handleRuleTypeChange(i, 'alertTypeName', e.target.value)}>
                          <option value="">— select —</option>
                          <option value={DIRECT_EXPR_TYPE}>✏ direct-expr (built-in)</option>
                          {Object.keys(alertTypes).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      {!isBuiltin && (
                        <div className="form-row">
                          <label>Version *</label>
                          <select value={rule.alertTypeVersion}
                            onChange={e => handleRuleTypeChange(i, 'alertTypeVersion', e.target.value)}>
                            <option value="">— select —</option>
                            {versionsForType.map(v => <option key={v} value={v}>{v}</option>)}
                          </select>
                        </div>
                      )}
                      <div className="form-row">
                        <label>Rule Name *</label>
                        <input type="text" value={rule.ruleName} placeholder="e.g. high-cpu"
                          onChange={e => updateRule(i, 'ruleName', e.target.value)} />
                      </div>
                    </div>

                    {/* Var Values — only for template-based types */}
                    {!isBuiltin && rule.vars.length > 0 && (
                      <div className="form-row">
                        <label>Var Values</label>
                        <table className="kv-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                          <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '15%' }} />
                            <col />
                          </colgroup>
                          <thead>
                            <tr><th>var name</th><th>type</th><th>value</th></tr>
                          </thead>
                          <tbody>
                            {rule.vars.map((v, vi) => (
                              <tr key={vi}>
                                <td>
                                  <input type="text" value={v.key} readOnly
                                    style={{ background: '#f9fafb', color: '#6b7280' }} />
                                </td>
                                <td>
                                  <span style={{
                                    fontSize: 11, background: '#e0e7ff', color: '#4338ca',
                                    padding: '2px 6px', borderRadius: 4, display: 'inline-block'
                                  }}>
                                    {v.type || 'string'}
                                  </span>
                                </td>
                                <td>
                                  <VarInput
                                    type={v.type || 'string'}
                                    value={v.value}
                                    onChange={val => {
                                      const vars = rule.vars.map((vv, vvi) =>
                                        vvi === vi ? { ...vv, value: val } : vv)
                                      updateRule(i, 'vars', vars)
                                    }}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {!isBuiltin && rule.vars.length === 0 && rule.alertTypeName && rule.alertTypeVersion && (
                      <p className="text-muted">This alert type declares no vars.</p>
                    )}

                    {/* Expression editor — always shown for ALL rules */}
                    {(() => {
                      const exprVal = isBuiltin ? directExprValue(rule.vars) : rule.expr
                      const setExpr = val => isBuiltin
                        ? updateRule(i, 'vars', [{ key: 'expr', value: val, type: 'string' }])
                        : updateRule(i, 'expr', val)
                      return (
                        <div className="form-row" style={{ marginTop: 10 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <label style={{ marginBottom: 0 }}>
                              Expression (PromQL)
                              {!isBuiltin && <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>overrides template rendering</span>}
                            </label>
                            <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #d1d5db', fontSize: 11 }}>
                              {[['visual', 'Visual Builder'], ['raw', 'Raw / PromQL']].map(([k, lbl]) => (
                                <button key={k} style={{
                                  padding: '2px 10px', border: 'none', cursor: 'pointer', fontWeight: 600,
                                  background: rule.exprMode === k ? '#6366f1' : '#fff',
                                  color: rule.exprMode === k ? '#fff' : '#6b7280',
                                }} onClick={() => updateRule(i, 'exprMode', k)}>{lbl}</button>
                              ))}
                            </div>
                          </div>
                          <Suspense fallback={
                            <div style={{ height: 56, background: '#0f172a', borderRadius: 6,
                              display: 'flex', alignItems: 'center', paddingLeft: 14,
                              color: '#475569', fontSize: 12 }}>Loading…</div>
                          }>
                            {rule.exprMode === 'visual'
                              ? <PromQLBuilder dict={metricsDict} onChange={setExpr} />
                              : <PromQLEditor value={exprVal} metrics={metricsDict} onChange={setExpr} />
                            }
                          </Suspense>
                        </div>
                      )
                    })()}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10 }}>
                      <div className="form-row">
                        <label>Severity</label>
                        <select value={rule.severity} onChange={e => updateRule(i, 'severity', e.target.value)}>
                          {SEVERITIES.map(s => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                      <div className="form-row">
                        <label>For (override)</label>
                        <input type="text" value={rule.for} placeholder="e.g. 10m"
                          onChange={e => updateRule(i, 'for', e.target.value)} />
                      </div>
                      <div className="form-row">
                        <label>Description</label>
                        <input type="text" value={rule.description} placeholder="Optional"
                          onChange={e => updateRule(i, 'description', e.target.value)} />
                      </div>
                    </div>

                    <div className="form-row" style={{ marginTop: 8 }}>
                      <label>Labels</label>
                      <KVEditor rows={rule.labels}
                        onChange={rows => updateRule(i, 'labels', rows)}
                        keyPlaceholder="label key" valuePlaceholder="value" />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={openSaveModal}>Save as Version…</button>
              {selected && (
                <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>
              )}
            </div>
          </div>
          {showPreview && (
            <div style={{
              width: 400, minWidth: 320, borderLeft: '1px solid #e5e7eb',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{
                padding: '10px 16px', borderBottom: '1px solid #e5e7eb',
                fontSize: 12, fontWeight: 600, color: '#6b7280',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                YAML Preview
                {product && <span style={{ fontSize: 11, color: '#9ca3af' }}>product: {product}</span>}
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
      </div>

      {modal && (
        <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />
      )}

      {importOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#fff', borderRadius: 10, padding: 24, minWidth: 560, maxWidth: 760,
            maxHeight: '82vh', display: 'flex', flexDirection: 'column', gap: 14,
            boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Import Prometheus Rules</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={importPath}
                onChange={e => setImportPath(e.target.value)}
                placeholder="Path to scan (default: gitops-deploy/)"
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                onKeyDown={e => e.key === 'Enter' && rescanImport(importPath)}
              />
              <button className="btn btn-secondary btn-sm" onClick={() => rescanImport(importPath)}>
                Scan
              </button>
            </div>
            {importLoading && <p className="text-muted">Scanning for PrometheusRule YAML files…</p>}
            {!importLoading && importGroups.length === 0 && (
              <p className="text-muted">No PrometheusRule YAML files found. Try a different path.</p>
            )}
            {!importLoading && importGroups.length > 0 && (
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {importGroups.map((g, gi) => (
                  <div key={gi} style={{ marginBottom: 14 }}>
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontWeight: 600, fontSize: 12, color: '#6b7280' }}>
                        {g.groupName}
                        <span style={{ fontWeight: 400, marginLeft: 8, color: '#9ca3af' }}>{g.sourceFile}</span>
                      </div>
                      {g.groupLabels && Object.keys(g.groupLabels).length > 0 && (
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>group labels:</span>
                          {Object.entries(g.groupLabels).map(([k, v]) => (
                            <span key={k} style={{
                              fontSize: 11, fontFamily: 'monospace',
                              background: '#f0fdf4', color: '#166534',
                              padding: '1px 6px', borderRadius: 3,
                            }}>{k}: {v}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <table className="kv-table" style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ width: 28 }}></th>
                          <th style={{ width: '28%' }}>alert</th>
                          <th>expr</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.rules.map((r, ri) => {
                          const key = `${gi}:${ri}`
                          return (
                            <tr key={ri}>
                              <td>
                                <input type="checkbox" checked={!!importSel[key]}
                                  onChange={() => toggleImportRule(gi, ri)} />
                              </td>
                              <td style={{ fontWeight: 500 }}>{r.alertName || '—'}</td>
                              <td style={{ fontFamily: 'monospace', fontSize: 11, color: '#374151', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
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
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setImportOpen(false)}>Cancel</button>
              <button className="btn btn-primary"
                disabled={!Object.values(importSel).some(Boolean)}
                onClick={confirmImport}>
                Import Selected
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
