import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Card, Input, Button, Select, Typography, Tag, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import EditorLayout from '../components/EditorLayout'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, pruneRoutesAPI } from '../utils/api'
import { latestVersion, bumpPatch } from '../utils/templateUtils'

const { Text } = Typography

const MATCHER_OPS = ['=', '!=', '=~', '!~']
const TYPE = 'amconfig'

// ── Label extraction ──────────────────────────────────────────────────────────

function collectLabels(suiteData, out) {
  if (!suiteData) return
  out.add('alertname')
  out.add('severity')
  for (const key of Object.keys(suiteData.groupLabels || {})) {
    if (key.trim()) out.add(key)
  }
  for (const rule of suiteData.rules || []) {
    for (const key of Object.keys(rule.labels || {})) {
      if (key.trim()) out.add(key)
    }
    const expr = rule.expr || rule.vars?.expr || ''
    for (const match of [...expr.matchAll(/\bby\s*\(([^)]+)\)/gi)]) {
      for (const lbl of match[1].split(',').map(s => s.trim()).filter(Boolean)) {
        out.add(lbl)
      }
    }
  }
}

// ── Route pruning ─────────────────────────────────────────────────────────────

function matcherKey(m) { return `${m.key}\x00${m.op}\x00${m.value}` }

function pruneRoutes(rules, topMatchers = []) {
  const topKeys = new Set(topMatchers.filter(m => m.key.trim()).map(matcherKey))
  const active = rules.filter(r => r.receiver && r.matchers.some(m => m.key.trim()))
    .map(r => ({
      ...r,
      matchers: r.matchers.filter(m => m.key.trim() && !topKeys.has(matcherKey(m))),
    }))
    .filter(r => r.matchers.length > 0 || r.receiver)

  function isSubset(small, large) {
    const largeKeys = new Set(large.map(matcherKey))
    return small.every(m => largeKeys.has(matcherKey(m)))
  }

  const isChild = new Set()
  const parentOf = new Map()
  for (let i = 0; i < active.length; i++) {
    for (let j = 0; j < active.length; j++) {
      if (i === j || parentOf.has(j)) continue
      const mi = active[i].matchers, mj = active[j].matchers
      if (mi.length < mj.length && isSubset(mi, mj)) {
        isChild.add(j)
        parentOf.set(j, i)
      }
    }
  }

  const result = []
  for (let i = 0; i < active.length; i++) {
    if (isChild.has(i)) continue
    const parentMs = active[i].matchers
    const parentMsKeys = new Set(parentMs.map(matcherKey))
    const children = [...parentOf.entries()]
      .filter(([, pi]) => pi === i)
      .map(([ci]) => ({
        receiver: active[ci].receiver,
        matchers: active[ci].matchers.filter(m => !parentMsKeys.has(matcherKey(m))),
      }))
    const route = { receiver: active[i].receiver, matchers: parentMs }
    if (children.length) route.routes = children
    result.push(route)
  }
  return result
}

function renderRouteBlock(routes, pad) {
  let s = ''
  for (const r of routes) {
    s += `${pad}- receiver: ${JSON.stringify(r.receiver)}\n`
    if (r.matchers?.length) {
      s += `${pad}  matchers:\n`
      for (const m of r.matchers)
        s += `${pad}    - name: ${m.key}\n${pad}      matchType: "${m.op || '='}"\n${pad}      value: ${JSON.stringify(m.value)}\n`
    }
    if (r.routes?.length) {
      s += `${pad}  routes:\n`
      s += renderRouteBlock(r.routes, pad + '    ')
    }
  }
  return s
}

// ── YAML builder ──────────────────────────────────────────────────────────────

function renderReceiverConfig(rx) {
  let s = `    - name: ${JSON.stringify(rx.name)}\n`
  if (rx.webhook_configs?.length) {
    s += `      webhookConfigs:\n`
    for (const wh of rx.webhook_configs)
      s += `        - url: ${JSON.stringify(wh.url || '')}\n          sendResolved: ${wh.send_resolved ?? true}\n`
  }
  if (rx.slack_configs?.length) {
    s += `      slackConfigs:\n`
    for (const sl of rx.slack_configs)
      s += `        - apiURL: ${JSON.stringify(sl.api_url || '')}\n          channel: ${JSON.stringify(sl.channel || '')}\n          sendResolved: ${sl.send_resolved ?? true}\n`
  }
  if (rx.pagerduty_configs?.length) {
    s += `      pagerdutyConfigs:\n`
    for (const pd of rx.pagerduty_configs)
      s += `        - routingKey: ${JSON.stringify(pd.routing_key || '')}\n          sendResolved: ${pd.send_resolved ?? true}\n`
  }
  if (rx.email_configs?.length) {
    s += `      emailConfigs:\n`
    for (const em of rx.email_configs)
      s += `        - to: ${JSON.stringify(em.to || '')}\n          from: ${JSON.stringify(em.from || '')}\n          smarthost: ${JSON.stringify(em.smarthost || '')}\n`
  }
  return s
}

function buildYAML(configName, defaultRecv, routeMatchers, routeRules, embeddedReceivers, inhibitRules, routeMode, product, precomputedRoutes = null) {
  const pfx   = product ? `${product}-` : ''
  const cname = configName || 'alertmanager-config'

  let yaml = `apiVersion: monitoring.coreos.com/v1alpha1\nkind: AlertmanagerConfig\n`
  yaml += `metadata:\n  name: ${pfx}${cname}\n`
  yaml += `  labels:\n    app.kubernetes.io/managed-by: Helm\nspec:\n`
  yaml += `  route:\n    receiver: ${JSON.stringify(defaultRecv || 'default')}\n`

  const activeTopMatchers = (routeMatchers || []).filter(m => m.key.trim())
  if (activeTopMatchers.length) {
    yaml += `    matchers:\n`
    for (const m of activeTopMatchers) {
      yaml += `      - name: ${m.key}\n`
      yaml += `        matchType: "${m.op || '='}"\n`
      yaml += `        value: ${JSON.stringify(m.value)}\n`
    }
  }

  const renderedRoutes = precomputedRoutes
    ?? (routeMode === 'pruned' ? pruneRoutes(routeRules, routeMatchers) : routeRules.filter(r => r.receiver && r.matchers.some(m => m.key.trim())))
  if (renderedRoutes.length) {
    yaml += `    routes:\n`
    yaml += renderRouteBlock(renderedRoutes, '      ')
  }

  yaml += `\n  receivers:\n`
  if (embeddedReceivers.length) {
    const embeddedNames = new Set(embeddedReceivers.map(r => r.name))
    for (const rx of embeddedReceivers) yaml += renderReceiverConfig(rx)
    const routeNames = new Set([defaultRecv, ...routeRules.map(r => r.receiver)].filter(Boolean))
    for (const rn of routeNames) {
      if (!embeddedNames.has(rn)) yaml += `    - name: ${JSON.stringify(rn)}\n`
    }
  } else {
    const recvSet = new Set([defaultRecv, ...routeRules.map(r => r.receiver)].filter(Boolean))
    for (const rn of recvSet) yaml += `    - name: ${JSON.stringify(rn)}\n`
  }

  const activeInhibits = (inhibitRules || []).filter(r =>
    r.sourceMatchers.some(m => m.key.trim()) || r.targetMatchers.some(m => m.key.trim())
  )
  if (activeInhibits.length) {
    yaml += `\n  inhibitRules:\n`
    for (const rule of activeInhibits) {
      const src = rule.sourceMatchers.filter(m => m.key.trim())
      const tgt = rule.targetMatchers.filter(m => m.key.trim())
      yaml += `    - sourceMatch:\n`
      for (const m of src)
        yaml += `        - name: ${m.key}\n          matchType: "${m.op || '='}"\n          value: ${JSON.stringify(m.value)}\n`
      yaml += `      targetMatch:\n`
      for (const m of tgt)
        yaml += `        - name: ${m.key}\n          matchType: "${m.op || '='}"\n          value: ${JSON.stringify(m.value)}\n`
      const eq = (rule.equal || []).filter(e => e.trim())
      if (eq.length) {
        yaml += `      equal:\n`
        for (const e of eq) yaml += `        - ${JSON.stringify(e)}\n`
      }
    }
  }

  return yaml.trimEnd()
}

// ── Sub-components ────────────────────────────────────────────────────────────

const emptyMatcher     = () => ({ key: '', op: '=', value: '' })
const emptyRoute       = () => ({ receiver: '', matchers: [emptyMatcher()] })
const emptyInhibitRule = () => ({ sourceMatchers: [emptyMatcher()], targetMatchers: [emptyMatcher()], equal: [] })

function MatcherRows({ matchers, onChange, viewableLabels = [], datalistPrefix = '' }) {
  function upM(i, f, v) { onChange(matchers.map((m, idx) => idx === i ? { ...m, [f]: v } : m)) }
  function addM()  { onChange([...matchers, emptyMatcher()]) }
  function delM(i) { onChange(matchers.filter((_, idx) => idx !== i)) }

  return (
    <div>
      {matchers.map((m, mi) => (
        <div key={mi} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <Input size="small" list={`${datalistPrefix}-lbl-${mi}`} value={m.key}
            placeholder="label name" style={{ flex: 1 }}
            onChange={e => upM(mi, 'key', e.target.value)} />
          {viewableLabels.length > 0 && (
            <datalist id={`${datalistPrefix}-lbl-${mi}`}>
              {viewableLabels.map(l => <option key={l} value={l} />)}
            </datalist>
          )}
          <Select size="small" value={m.op || '='} onChange={val => upM(mi, 'op', val)}
            style={{ width: 64, fontFamily: 'monospace', fontWeight: 700 }}
            options={MATCHER_OPS.map(o => ({ value: o, label: o }))} />
          <Input size="small" value={m.value}
            placeholder={m.op?.includes('~') ? 'regex' : 'value'} style={{ flex: 1 }}
            onChange={e => upM(mi, 'value', e.target.value)} />
          <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => delM(mi)} />
        </div>
      ))}
      <Button size="small" icon={<PlusOutlined />} onClick={addM}>Add matcher</Button>
    </div>
  )
}

function RouteCard({ route, index, receiverNames, viewableLabels, onChange, onRemove }) {
  function set(f, v) { onChange({ ...route, [f]: v }) }

  return (
    <Card size="small" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Text strong style={{ fontSize: 13 }}>Route {index + 1}</Text>
        <Button danger size="small" onClick={onRemove}>Remove</Button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Receiver</Text>
        <Input size="small" value={route.receiver} placeholder="receiver name"
          onChange={e => set('receiver', e.target.value)} />
      </div>

      <div>
        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
          Matchers
          {viewableLabels.length > 0 && (
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>keys from Alert Labels</Text>
          )}
        </Text>
        <MatcherRows matchers={route.matchers}
          onChange={ms => set('matchers', ms)}
          viewableLabels={viewableLabels}
          datalistPrefix={`route-${index}`} />
      </div>
    </Card>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const emptyForm = () => ({
  configName:      '',
  defaultReceiver: '',
  groups:          [],
  receivers:       [],
  routeMatchers:   [],
  routeRules:      [emptyRoute()],
  routeMode:       'original',
  inhibitRules:    [],
})

export default function AlertmanagerSmartEditor() {
  const [templates,      setTemplates]      = useState({})
  const [selected,       setSelected]       = useState(null)
  const [isNew,          setIsNew]          = useState(false)
  const [modal,          setModal]          = useState(null)
  const [status,         setStatus]         = useState('')

  const [alertSuites,    setAlertSuites]    = useState({})
  const [receivers,      setReceivers]      = useState({})
  const [product,        setProduct]        = useState('')

  const [form,           setForm]           = useState(emptyForm())
  const [groupDataMap,   setGroupDataMap]   = useState({})

  const [pickName,           setPickName]           = useState('')
  const [loadingGroup,       setLoadingGroup]       = useState(false)
  const [pickReceiverName,   setPickReceiverName]   = useState('')
  const [loadingReceiver,    setLoadingReceiver]    = useState(false)

  const [prunedRouteTree,    setPrunedRouteTree]    = useState(null)
  const [pruneLoading,       setPruneLoading]       = useState(false)
  const pruneTimer = useRef(null)

  const load = useCallback(async () => {
    const [tmpl, suites, recvs] = await Promise.all([
      listTemplates(TYPE),
      listTemplates('alert-suite'),
      listTemplates('receivers'),
    ])
    setTemplates(tmpl)
    setAlertSuites(suites)
    setReceivers(recvs)
    try {
      const r = await fetch('/api/defaults')
      const d = await r.json()
      setProduct(d.parsed?.product || '')
    } catch {}
  }, [])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (form.routeMode !== 'pruned') { setPrunedRouteTree(null); return }
    clearTimeout(pruneTimer.current)
    pruneTimer.current = setTimeout(async () => {
      setPruneLoading(true)
      const result = await pruneRoutesAPI(form.routeRules, form.routeMatchers)
      setPrunedRouteTree(result?.routeRules ?? null)
      setPruneLoading(false)
    }, 350)
    return () => clearTimeout(pruneTimer.current)
  }, [form.routeMode, form.routeRules, form.routeMatchers])

  async function loadGroupData(name, version) {
    const key = `${name}@${version}`
    if (groupDataMap[key] !== undefined) return
    const result = await getTemplate('alert-suite', name, version)
    const data = result?.parsed?.alertSuite || null
    setGroupDataMap(m => ({ ...m, [key]: data }))
  }

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const c = data.parsed || {}
    const groups = (c.groups || [])
    setForm({
      configName:      c.configName || name,
      defaultReceiver: c.defaultReceiver || '',
      groups,
      receivers:       c.receivers || [],
      routeMatchers:   c.routeMatchers || [],
      routeRules:      c.flatRouteRules || c.routeRules || [emptyRoute()],
      routeMode:       c.routeMode || 'original',
      inhibitRules:    c.inhibitRules || [],
    })
    setSelected({ name, version })
    setIsNew(false)
    for (const g of groups) loadGroupData(g.name, g.version)
  }

  function startNew() { setForm(emptyForm()); setSelected(null); setIsNew(true); setPickName('') }

  async function addGroup() {
    if (!pickName) return
    const vers = alertSuites[pickName] || []
    const ver  = latestVersion(vers) || ''
    if (!ver) return
    const key = `${pickName}@${ver}`
    if (form.groups.some(g => g.name === pickName && g.version === ver)) {
      setPickName(''); return
    }
    setLoadingGroup(true)
    try {
      const result = await getTemplate('alert-suite', pickName, ver)
      const data = result?.parsed?.alertSuite || null
      setGroupDataMap(m => ({ ...m, [key]: data }))
      setForm(f => ({ ...f, groups: [...f.groups, { name: pickName, version: ver }] }))
      setPickName('')
    } finally { setLoadingGroup(false) }
  }

  function removeGroup(i) { setForm(f => ({ ...f, groups: f.groups.filter((_, idx) => idx !== i) })) }

  async function addReceiver() {
    if (!pickReceiverName) return
    if (form.receivers.some(r => r.name === pickReceiverName)) { setPickReceiverName(''); return }
    const vers = receivers[pickReceiverName] || []
    const ver  = latestVersion(vers) || ''
    if (!ver) return
    setLoadingReceiver(true)
    try {
      const result = await getTemplate('receivers', pickReceiverName, ver)
      if (result?.parsed) setForm(f => ({ ...f, receivers: [...f.receivers, result.parsed] }))
      setPickReceiverName('')
    } finally { setLoadingReceiver(false) }
  }

  function removeReceiver(i) { setForm(f => ({ ...f, receivers: f.receivers.filter((_, idx) => idx !== i) })) }

  const viewableLabels = useMemo(() => {
    const set = new Set()
    for (const g of form.groups) {
      const data = groupDataMap[`${g.name}@${g.version}`]
      collectLabels(data, set)
    }
    return [...set].sort()
  }, [form.groups, groupDataMap])

  const receiverNames = form.receivers.map(r => r.name)

  const alertNames = useMemo(() => {
    const names = new Set()
    for (const g of form.groups) {
      const data = groupDataMap[`${g.name}@${g.version}`]
      for (const rule of data?.rules || []) {
        if (rule.ruleName) names.add(rule.ruleName)
      }
    }
    return [...names].sort()
  }, [form.groups, groupDataMap])

  const effectiveRoutes = form.routeMode === 'pruned' && prunedRouteTree ? prunedRouteTree : null

  const preview = useMemo(
    () => buildYAML(form.configName, form.defaultReceiver, form.routeMatchers, form.routeRules, form.receivers, form.inhibitRules, form.routeMode, product, effectiveRoutes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.configName, form.defaultReceiver, form.routeMatchers, form.routeRules, form.receivers, form.inhibitRules, form.routeMode, product, prunedRouteTree]
  )

  function addRoute()          { setForm(f => ({ ...f, routeRules: [...f.routeRules, emptyRoute()] })) }
  function removeRoute(i)      { setForm(f => ({ ...f, routeRules: f.routeRules.filter((_, idx) => idx !== i) })) }
  function updateRoute(i, upd) { setForm(f => ({ ...f, routeRules: f.routeRules.map((r, idx) => idx === i ? upd : r) })) }

  function addInhibit()          { setForm(f => ({ ...f, inhibitRules: [...f.inhibitRules, emptyInhibitRule()] })) }
  function removeInhibit(i)      { setForm(f => ({ ...f, inhibitRules: f.inhibitRules.filter((_, idx) => idx !== i) })) }

  function updInhibitMatcher(ruleIdx, side, mIdx, field, val) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) => {
        if (ri !== ruleIdx) return r
        const arr = [...r[side]]
        arr[mIdx] = { ...arr[mIdx], [field]: val }
        return { ...r, [side]: arr }
      }),
    }))
  }
  function addInhibitMatcher(ruleIdx, side) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, [side]: [...r[side], emptyMatcher()] } : r
      ),
    }))
  }
  function delInhibitMatcher(ruleIdx, side, mIdx) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, [side]: r[side].filter((_, i) => i !== mIdx) } : r
      ),
    }))
  }
  function addInhibitEqual(ruleIdx) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, equal: [...r.equal, ''] } : r
      ),
    }))
  }
  function updInhibitEqual(ruleIdx, eIdx, val) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, equal: r.equal.map((e, i) => i === eIdx ? val : e) } : r
      ),
    }))
  }
  function delInhibitEqual(ruleIdx, eIdx) {
    setForm(f => ({
      ...f,
      inhibitRules: f.inhibitRules.map((r, ri) =>
        ri === ruleIdx ? { ...r, equal: r.equal.filter((_, i) => i !== eIdx) } : r
      ),
    }))
  }

  function buildPayload() {
    return {
      configName:      form.configName,
      defaultReceiver: form.defaultReceiver,
      groups:          form.groups,
      receivers:       form.receivers,
      routeMatchers:   form.routeMatchers,
      routeMode:       form.routeMode,
      flatRouteRules:  form.routeRules,
      routeRules:      form.routeMode === 'pruned'
        ? (prunedRouteTree ?? pruneRoutes(form.routeRules, form.routeMatchers))
        : form.routeRules.filter(r => r.receiver && r.matchers.some(m => m.key.trim())),
      inhibitRules:    form.inhibitRules,
    }
  }

  async function handleSave(version) {
    setModal(null)
    const name = form.configName.trim() || selected?.name || `amconfig-${Date.now()}`
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.configName.trim() || selected?.name
    const v = selected
      ? bumpPatch(selected.version)
      : (n && templates[n] ? bumpPatch(latestVersion(templates[n])) : 'v1.0.0')
    setModal(v)
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  const showForm = isNew || selected

  return (
    <EditorLayout
      title="AM Configs"
      templates={templates}
      selected={selected}
      onSelect={selectVersion}
      onNew={startNew}
      emptyIcon="🔀"
      emptyText="Select a config or click + New."
    >
      {showForm && (
        <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 }}>

            {/* Identity */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong style={{ fontSize: 15 }}>
                  {selected ? `${selected.name} @ ${selected.version}` : 'New Alertmanager Config'}
                </Text>
                {status && <Tag color="success">{status}</Tag>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Config Name *</Text>
                  <Input value={form.configName} placeholder="e.g. platform-amconfig"
                    onChange={e => setForm(f => ({ ...f, configName: e.target.value }))} />
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                    Default Receiver <Text type="secondary" style={{ fontSize: 11 }}>catch-all</Text>
                  </Text>
                  <Input value={form.defaultReceiver} placeholder="receiver name"
                    onChange={e => setForm(f => ({ ...f, defaultReceiver: e.target.value }))} />
                </div>
              </div>
            </Card>

            {/* Rule Groups */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong>Rule Groups</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>select one or more alert suite rule groups</Text>
              </div>

              {form.groups.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {form.groups.map((g, i) => {
                    const data = groupDataMap[`${g.name}@${g.version}`]
                    return (
                      <Tag key={i} closable onClose={() => removeGroup(i)}
                        color="purple" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {g.name}@{g.version}
                        {data === null && <Text type="danger" style={{ fontSize: 11, marginLeft: 4 }}>(no data)</Text>}
                      </Tag>
                    )
                  })}
                </div>
              )}

              <Space.Compact style={{ width: '100%' }}>
                <Select value={pickName || undefined} onChange={val => setPickName(val || '')}
                  placeholder="-- select --" style={{ flex: 1 }} allowClear
                  options={Object.keys(alertSuites)
                    .filter(n => {
                      const ver = latestVersion(alertSuites[n] || []) || ''
                      return !form.groups.some(g => g.name === n && g.version === ver)
                    })
                    .map(n => {
                      const ver = latestVersion(alertSuites[n] || []) || ''
                      return { value: n, label: `${n}${ver ? ` (${ver})` : ''}` }
                    })} />
                <Button icon={<PlusOutlined />} disabled={!pickName || loadingGroup} onClick={addGroup}>
                  {loadingGroup ? 'Loading...' : 'Add'}
                </Button>
              </Space.Compact>
            </Card>

            {/* Receivers */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong>Receivers</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>configs will be embedded in the rendered output</Text>
              </div>

              {form.receivers.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {form.receivers.map((rx, i) => (
                    <Tag key={i} closable onClose={() => removeReceiver(i)}
                      color="gold" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {rx.name}
                    </Tag>
                  ))}
                </div>
              )}

              <Space.Compact style={{ width: '100%' }}>
                <Select value={pickReceiverName || undefined} onChange={val => setPickReceiverName(val || '')}
                  placeholder="-- select --" style={{ flex: 1 }} allowClear
                  options={Object.keys(receivers)
                    .filter(n => !form.receivers.some(r => r.name === n))
                    .map(n => {
                      const ver = latestVersion(receivers[n] || []) || ''
                      return { value: n, label: `${n}${ver ? ` (${ver})` : ''}` }
                    })} />
                <Button icon={<PlusOutlined />} disabled={!pickReceiverName || loadingReceiver} onClick={addReceiver}>
                  {loadingReceiver ? 'Loading...' : 'Add'}
                </Button>
              </Space.Compact>
            </Card>

            {/* Alert Labels */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Alert Labels</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>use these as route matcher keys</Text>
              </div>

              {form.groups.length === 0 ? (
                <Text type="secondary">Add at least one rule group above.</Text>
              ) : viewableLabels.length === 0 ? (
                <Text type="secondary">No labels detected.</Text>
              ) : (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {viewableLabels.map(lbl => (
                      <Tag key={lbl} color="blue" style={{ fontFamily: 'monospace', fontSize: 12 }}>{lbl}</Tag>
                    ))}
                  </div>

                  {form.groups.some(g => groupDataMap[`${g.name}@${g.version}`]) && (
                    <details>
                      <summary style={{ fontSize: 12, color: '#8c8c8c', cursor: 'pointer' }}>Per-group breakdown</summary>
                      {form.groups.map((g, gi) => {
                        const data = groupDataMap[`${g.name}@${g.version}`]
                        if (!data) return null
                        const groupLabelEntries = Object.entries(data.groupLabels || {})
                        return (
                          <div key={gi} style={{ marginTop: 8 }}>
                            <Text strong style={{ fontSize: 12, color: '#6366f1', display: 'block', marginBottom: 4 }}>
                              {g.name}@{g.version}
                            </Text>
                            {groupLabelEntries.length > 0 && (
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                                <Text type="secondary" style={{ fontSize: 11 }}>group labels:</Text>
                                {groupLabelEntries.map(([k, v]) => (
                                  <Tag key={k} color="green" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                                    {k}: {v}
                                  </Tag>
                                ))}
                              </div>
                            )}
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: '#8c8c8c', fontWeight: 600 }}>Rule</th>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: '#8c8c8c', fontWeight: 600 }}>Severity</th>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: '#8c8c8c', fontWeight: 600 }}>Rule Labels</th>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: '#8c8c8c', fontWeight: 600 }}>PromQL by()</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(data.rules || []).map((rule, ri) => {
                                  const expr = rule.expr || rule.vars?.expr || ''
                                  const byLabels = []
                                  for (const m of [...expr.matchAll(/\bby\s*\(([^)]+)\)/gi)]) {
                                    for (const l of m[1].split(',').map(s => s.trim()).filter(Boolean)) byLabels.push(l)
                                  }
                                  return (
                                    <tr key={ri} style={{ borderBottom: '1px solid #fafafa' }}>
                                      <td style={{ padding: '4px 8px' }}>{rule.ruleName || `rule-${ri + 1}`}</td>
                                      <td style={{ padding: '4px 8px' }}>{rule.severity || '—'}</td>
                                      <td style={{ padding: '4px 8px' }}>{Object.keys(rule.labels || {}).join(', ') || '—'}</td>
                                      <td style={{ padding: '4px 8px' }}>{byLabels.join(', ') || '—'}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        )
                      })}
                    </details>
                  )}
                </>
              )}
            </Card>

            {/* Route Matchers (top-level) */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Route Matchers</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>spec.route.matchers</Text>
                <Button size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }}
                  onClick={() => setForm(f => ({ ...f, routeMatchers: [...f.routeMatchers, emptyMatcher()] }))}>Add</Button>
              </div>
              {form.routeMatchers.length === 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>No top-level matchers — this config handles all alerts.</Text>
              ) : (
                <MatcherRows matchers={form.routeMatchers}
                  onChange={ms => setForm(f => ({ ...f, routeMatchers: ms }))}
                  viewableLabels={viewableLabels}
                  datalistPrefix="rm" />
              )}
            </Card>

            {/* Route Configuration */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong>Route Configuration</Text>
                <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #d9d9d9', fontSize: 11, marginLeft: 8 }}>
                  {[['original', 'Original'], ['pruned', 'Pruned']].map(([mode, label]) => (
                    <button key={mode} style={{
                      padding: '2px 10px', border: 'none', cursor: 'pointer', fontWeight: 600,
                      background: form.routeMode === mode ? '#6366f1' : '#fff',
                      color: form.routeMode === mode ? '#fff' : '#8c8c8c',
                    }} onClick={() => setForm(f => ({ ...f, routeMode: mode }))}>
                      {label}
                    </button>
                  ))}
                </div>
                {form.routeMode === 'pruned' && (
                  <Text type="secondary" style={{ fontSize: 11 }}>shared matchers merged into parent routes</Text>
                )}
                <Button size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }} onClick={addRoute}>Add Route</Button>
              </div>
              {form.routeRules.length === 0 && <Text type="secondary">No routes. Click + Add Route.</Text>}
              {form.routeRules.map((route, ri) => (
                <RouteCard key={ri} route={route} index={ri}
                  receiverNames={receiverNames}
                  viewableLabels={viewableLabels}
                  onChange={upd => updateRoute(ri, upd)}
                  onRemove={() => removeRoute(ri)} />
              ))}
            </Card>

            {/* Inhibit Rules */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Inhibit Rules</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>source alert suppresses target alert</Text>
                <Button size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }} onClick={addInhibit}>Add</Button>
              </div>
              {form.inhibitRules.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No inhibit rules.</Text>}
              {form.inhibitRules.map((rule, ri) => (
                <Card key={ri} size="small" style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <Text strong style={{ fontSize: 13 }}>Inhibit Rule {ri + 1}</Text>
                    <Button danger size="small" onClick={() => removeInhibit(ri)}>Remove</Button>
                  </div>

                  {[['sourceMatchers', 'Source (firing)'], ['targetMatchers', 'Target (suppressed)']].map(([side, label]) => (
                    <div key={side} style={{ marginBottom: 10 }}>
                      <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4 }}>{label}</Text>
                      {rule[side].map((m, mi) => (
                        <div key={mi} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                          <Input size="small" list={`inh-${ri}-${side}-lbl`} value={m.key}
                            placeholder="alertname / label" style={{ flex: 1 }}
                            onChange={e => updInhibitMatcher(ri, side, mi, 'key', e.target.value)} />
                          <datalist id={`inh-${ri}-${side}-lbl`}>
                            <option value="alertname" />
                            <option value="severity" />
                            {alertNames.map(n => <option key={n} value={n} />)}
                            {viewableLabels.filter(l => l !== 'alertname' && l !== 'severity').map(l => <option key={l} value={l} />)}
                          </datalist>
                          <Select size="small" value={m.op || '='} onChange={val => updInhibitMatcher(ri, side, mi, 'op', val)}
                            style={{ width: 64, fontFamily: 'monospace', fontWeight: 700 }}
                            options={MATCHER_OPS.map(o => ({ value: o, label: o }))} />
                          <Input size="small" list={`inh-${ri}-${side}-val-${mi}`} value={m.value}
                            placeholder={m.op?.includes('~') ? 'regex' : 'value'} style={{ flex: 1 }}
                            onChange={e => updInhibitMatcher(ri, side, mi, 'value', e.target.value)} />
                          {m.key === 'alertname' && (
                            <datalist id={`inh-${ri}-${side}-val-${mi}`}>
                              {alertNames.map(n => <option key={n} value={n} />)}
                            </datalist>
                          )}
                          {m.key === 'severity' && (
                            <datalist id={`inh-${ri}-${side}-val-${mi}`}>
                              {['critical', 'warning', 'info'].map(s => <option key={s} value={s} />)}
                            </datalist>
                          )}
                          <Button type="text" danger size="small" icon={<DeleteOutlined />}
                            onClick={() => delInhibitMatcher(ri, side, mi)} />
                        </div>
                      ))}
                      <Button size="small" icon={<PlusOutlined />}
                        onClick={() => addInhibitMatcher(ri, side)}>Add matcher</Button>
                    </div>
                  ))}

                  <div>
                    <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                      Equal Labels <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>must match between source and target</Text>
                    </Text>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      {rule.equal.map((e, ei) => (
                        <Tag key={ei} closable onClose={() => delInhibitEqual(ri, ei)}
                          color="green" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          <input type="text" list="inh-equal-lbl" value={e}
                            placeholder="label name"
                            style={{ border: 'none', background: 'transparent', fontFamily: 'monospace',
                              fontSize: 12, width: Math.max(60, e.length * 8 + 16), padding: 0 }}
                            onChange={ev => updInhibitEqual(ri, ei, ev.target.value)} />
                        </Tag>
                      ))}
                      <datalist id="inh-equal-lbl">
                        <option value="alertname" />
                        {viewableLabels.map(l => <option key={l} value={l} />)}
                      </datalist>
                      <Button size="small" icon={<PlusOutlined />} onClick={() => addInhibitEqual(ri)}>Add</Button>
                    </div>
                  </div>
                </Card>
              ))}
            </Card>

            <Space>
              <Button type="primary" onClick={openSaveModal}>Save as Version...</Button>
              {selected && <Button danger onClick={handleDelete}>Delete this version</Button>}
            </Space>
          </div>

          {/* YAML preview */}
          <div style={{
            width: 400, minWidth: 320, borderLeft: '1px solid #f0f0f0',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <div style={{
              padding: '10px 16px', borderBottom: '1px solid #f0f0f0',
              fontSize: 12, fontWeight: 600, color: '#8c8c8c',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>
                YAML Preview
                {form.routeMode === 'pruned' && (
                  pruneLoading
                    ? <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>pruning...</Text>
                    : prunedRouteTree
                      ? <Text type="secondary" style={{ fontSize: 11, color: '#52c41a', marginLeft: 8 }}>
                          pruned: {form.routeRules.filter(r=>r.receiver).length} {'→'} {prunedRouteTree.length} top-level
                        </Text>
                      : null
                )}
              </span>
              {product && <Text type="secondary" style={{ fontSize: 11 }}>product: {product}</Text>}
            </div>
            <pre style={{
              flex: 1, overflowY: 'auto', margin: 0, padding: '14px 16px',
              fontSize: 11.5, fontFamily: "'Fira Code', 'Cascadia Code', monospace",
              background: '#0f172a', color: '#7dd3fc', lineHeight: 1.7,
              whiteSpace: 'pre', overflowX: 'auto',
            }}>
              {preview}
            </pre>
          </div>
        </div>
      )}

      {modal && <VersionModal defaultVersion={modal} onSave={handleSave} onCancel={() => setModal(null)} />}
    </EditorLayout>
  )
}
