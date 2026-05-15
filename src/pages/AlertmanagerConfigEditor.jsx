import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, Input, Button, Select, Checkbox, Typography, Tag, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import EditorLayout from '../components/EditorLayout'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { bumpPatch, latestVersion } from '../utils/templateUtils'

const { Text } = Typography

const TYPE = 'amconfig'

// ── YAML preview builder ──────────────────────────────────────────────────────

function buildPreview(form, product) {
  const pfx = product ? `${product}-` : ''
  const name = form.configName || 'my-alertmanager-config'

  let yaml = `apiVersion: monitoring.coreos.com/v1alpha1\nkind: AlertmanagerConfig\nmetadata:\n  name: ${pfx}${name}\n  labels:\n    app.kubernetes.io/managed-by: Helm\nspec:\n`

  yaml += `  route:\n`
  yaml += `    receiver: ${JSON.stringify(form.defaultReceiver || 'default')}\n`
  const topMatchers = (form.routeMatchers || []).filter(m => m.key.trim())
  if (topMatchers.length) {
    yaml += `    matchers:\n`
    for (const m of topMatchers) {
      yaml += `      - name: ${m.key}\n        matchType: "${m.op || '='}"\n        value: ${JSON.stringify(m.value)}\n`
    }
  }
  if (form.groupBy.length) {
    yaml += `    groupBy:\n` + form.groupBy.map(l => `      - ${l}`).join('\n') + '\n'
  }
  yaml += `    groupWait: ${form.groupWait || '30s'}\n`
  yaml += `    groupInterval: ${form.groupInterval || '5m'}\n`
  yaml += `    repeatInterval: ${form.repeatInterval || '12h'}\n`

  if (form.routes.length) {
    yaml += `    routes:\n`
    for (const r of form.routes) {
      yaml += `      - receiver: ${JSON.stringify(r.receiver || 'default')}\n`
      if (r.matchers.filter(m => m.key.trim()).length) {
        yaml += `        matchers:\n`
        for (const m of r.matchers.filter(m => m.key.trim())) {
          yaml += `          - name: ${m.key}\n            matchType: "${m.op || '='}"\n            value: ${JSON.stringify(m.value)}\n`
        }
      }
      if (r.continue) yaml += `        continue: true\n`
    }
  }

  const receiverSet = new Set([form.defaultReceiver, ...form.routes.map(r => r.receiver)].filter(Boolean))
  if (receiverSet.size) {
    yaml += `\n  receivers:\n`
    for (const rn of receiverSet) {
      yaml += `    - name: ${JSON.stringify(rn)}\n`
    }
  }

  if (form.inhibitRules.filter(r => r.sourceMatch.trim() || r.targetMatch.trim()).length) {
    yaml += `\n  inhibitRules:\n`
    for (const r of form.inhibitRules) {
      if (!r.sourceMatch.trim() && !r.targetMatch.trim()) continue
      yaml += `    - sourceMatch:\n        - name: alertname\n          value: ${JSON.stringify(r.sourceMatch)}\n`
      yaml += `      targetMatch:\n        - name: alertname\n          value: ${JSON.stringify(r.targetMatch)}\n`
      if (r.equal) yaml += `      equal:\n` + r.equal.split(',').map(e => `        - ${e.trim()}`).join('\n') + '\n'
    }
  }

  return yaml.trimEnd()
}

// ── State ─────────────────────────────────────────────────────────────────────

const MATCHER_OPS = ['=', '!=', '=~', '!~']
const emptyMatcher = () => ({ key: '', op: '=', value: '' })
const emptyRoute   = () => ({ receiver: '', matchers: [], continue: false })
const emptyInhibit = () => ({ sourceMatch: '', targetMatch: '', equal: 'namespace' })

const emptyForm = () => ({
  configName:      '',
  groupBy:         [],
  groupWait:       '30s',
  groupInterval:   '5m',
  repeatInterval:  '12h',
  defaultReceiver: '',
  routeMatchers:   [],
  routes:          [],
  inhibitRules:    [],
})

// ── GroupBy tag editor ────────────────────────────────────────────────────────

function TagListEditor({ tags, onChange, placeholder }) {
  const [input, setInput] = useState('')
  function add() {
    const v = input.trim()
    if (v && !tags.includes(v)) { onChange([...tags, v]); setInput('') }
  }
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {tags.map(t => (
          <Tag key={t} closable onClose={() => onChange(tags.filter(x => x !== t))}
            style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {t}
          </Tag>
        ))}
      </div>
      <Space.Compact style={{ width: '100%' }}>
        <Input size="small" value={input} placeholder={placeholder || 'label name'}
          onChange={e => setInput(e.target.value)}
          onPressEnter={add} />
        <Button size="small" icon={<PlusOutlined />} onClick={add}>Add</Button>
      </Space.Compact>
    </div>
  )
}

// ── Matchers editor (key / op / value rows) ───────────────────────────────────

function MatchersEditor({ matchers, onChange }) {
  function update(i, field, val) {
    onChange(matchers.map((m, idx) => idx === i ? { ...m, [field]: val } : m))
  }
  return (
    <div>
      {matchers.map((m, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <Input size="small" value={m.key} placeholder="label name"
            style={{ flex: 1 }}
            onChange={e => update(i, 'key', e.target.value)} />
          <Select size="small" value={m.op || '='} onChange={val => update(i, 'op', val)}
            style={{ width: 64, fontFamily: 'monospace', fontWeight: 700 }}
            options={MATCHER_OPS.map(o => ({ value: o, label: o }))} />
          <Input size="small" value={m.value}
            placeholder={m.op?.includes('~') ? 'regex' : 'value'}
            style={{ flex: 1 }}
            onChange={e => update(i, 'value', e.target.value)} />
          <Button type="text" danger size="small" icon={<DeleteOutlined />}
            onClick={() => onChange(matchers.filter((_, idx) => idx !== i))} />
        </div>
      ))}
      <Button size="small" icon={<PlusOutlined />}
        onClick={() => onChange([...matchers, emptyMatcher()])}>Add matcher</Button>
    </div>
  )
}

// ── Route card ────────────────────────────────────────────────────────────────

function RouteCard({ route, index, receiverNames, onChange, onRemove }) {
  function set(field, val) { onChange({ ...route, [field]: val }) }
  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text strong style={{ fontSize: 13 }}>Route {index + 1}</Text>
        <Button danger size="small" onClick={onRemove}>Remove</Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 8 }}>
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Receiver *</Text>
          <Input size="small" value={route.receiver} placeholder="receiver name"
            onChange={e => set('receiver', e.target.value)} />
        </div>
        <div style={{ paddingTop: 20 }}>
          <Checkbox checked={!!route.continue}
            onChange={e => set('continue', e.target.checked)}>
            <Text style={{ fontSize: 12 }}>continue</Text>
          </Checkbox>
        </div>
      </div>

      <div>
        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Matchers</Text>
        <MatchersEditor matchers={route.matchers} onChange={rows => set('matchers', rows)} />
      </div>
    </Card>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlertmanagerConfigEditor() {
  const [templates, setTemplates] = useState({})
  const [receivers, setReceivers] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')
  const [product, setProduct]     = useState('')

  const load = useCallback(async () => {
    const [cfgs, recvs] = await Promise.all([
      listTemplates(TYPE),
      listTemplates('receivers'),
    ])
    setTemplates(cfgs)
    setReceivers(recvs)
    try {
      const r = await fetch('/api/defaults')
      const d = await r.json()
      setProduct(d.parsed?.product || '')
    } catch {}
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const c = data.parsed || {}
    setForm({
      configName:      c.configName      || name,
      groupBy:         c.groupBy         || [],
      groupWait:       c.groupWait       || '30s',
      groupInterval:   c.groupInterval   || '5m',
      repeatInterval:  c.repeatInterval  || '12h',
      defaultReceiver: c.defaultReceiver || '',
      routeMatchers: (c.routeMatchers || []).map(m => ({
        key: m.name || m.key || '', op: m.matchType || m.op || '=', value: m.value || '',
      })),
      routes: (c.routes || []).map(r => ({
        receiver: r.receiver || '',
        matchers: (r.matchers || []).map(m => ({
          key: m.name || m.key || '', op: m.matchType || m.op || '=', value: m.value || '',
        })),
        continue: !!r.continue,
      })),
      inhibitRules: (c.inhibitRules || []).map(r => ({
        sourceMatch: r.sourceMatch || '',
        targetMatch: r.targetMatch || '',
        equal:       Array.isArray(r.equal) ? r.equal.join(', ') : (r.equal || 'namespace'),
      })),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() { setForm(emptyForm()); setSelected(null); setIsNew(true) }

  const receiverNames = Object.keys(receivers)

  function addRoute()     { setForm(f => ({ ...f, routes: [...f.routes, emptyRoute()] })) }
  function removeRoute(i) { setForm(f => ({ ...f, routes: f.routes.filter((_, idx) => idx !== i) })) }
  function updateRoute(i, updated) {
    setForm(f => ({ ...f, routes: f.routes.map((r, idx) => idx === i ? updated : r) }))
  }

  function addInhibit()     { setForm(f => ({ ...f, inhibitRules: [...f.inhibitRules, emptyInhibit()] })) }
  function removeInhibit(i) { setForm(f => ({ ...f, inhibitRules: f.inhibitRules.filter((_, idx) => idx !== i) })) }
  function updateInhibit(i, field, val) {
    setForm(f => ({ ...f, inhibitRules: f.inhibitRules.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
  }

  function buildPayload() {
    return {
      configName:      form.configName,
      groupBy:         form.groupBy,
      groupWait:       form.groupWait,
      groupInterval:   form.groupInterval,
      repeatInterval:  form.repeatInterval,
      defaultReceiver: form.defaultReceiver,
      routeMatchers: form.routeMatchers.filter(m => m.key.trim())
        .map(m => ({ name: m.key, matchType: m.op || '=', value: m.value })),
      routes: form.routes.map(r => ({
        receiver: r.receiver,
        matchers: r.matchers.filter(m => m.key.trim())
          .map(m => ({ name: m.key, matchType: m.op || '=', value: m.value })),
        ...(r.continue && { continue: true }),
      })),
      inhibitRules: form.inhibitRules
        .filter(r => r.sourceMatch.trim() || r.targetMatch.trim())
        .map(r => ({
          sourceMatch: r.sourceMatch,
          targetMatch: r.targetMatch,
          equal: r.equal.split(',').map(e => e.trim()).filter(Boolean),
        })),
    }
  }

  async function handleSave(name, version) {
    setModal(null)
    const instanceName = name || `amconfig-${Date.now()}`
    await saveTemplate(TYPE, instanceName, version, buildPayload())
    await load()
    setSelected({ name: instanceName, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.configName?.trim() || selected?.name || ''
    const v = selected
      ? bumpPatch(selected.version)
      : (n && templates[n] ? bumpPatch(latestVersion(templates[n])) : 'v1.0.0')
    setModal({ name: n, version: v })
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  const preview = useMemo(() => buildPreview(form, product), [form, product])
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
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong style={{ fontSize: 15 }}>
                  {selected ? `${selected.name} @ ${selected.version}` : 'New Alertmanager Config'}
                </Text>
                {status && <Tag color="success">{status}</Tag>}
              </div>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Config Name *</Text>
                <Input value={form.configName} placeholder="e.g. platform-config"
                  onChange={e => setForm(f => ({ ...f, configName: e.target.value }))} />
              </div>
            </Card>

            <Card size="small" style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 12 }}>Route Settings</Text>
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Receiver *</Text>
                <Input value={form.defaultReceiver} placeholder="receiver name"
                  onChange={e => setForm(f => ({ ...f, defaultReceiver: e.target.value }))} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                  Matchers <Text type="secondary" style={{ fontSize: 11 }}>top-level route matchers (spec.route.matchers)</Text>
                </Text>
                <MatchersEditor matchers={form.routeMatchers}
                  onChange={rows => setForm(f => ({ ...f, routeMatchers: rows }))} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                  Group By <Text type="secondary" style={{ fontSize: 11 }}>press Enter or click + Add</Text>
                </Text>
                <TagListEditor tags={form.groupBy}
                  onChange={tags => setForm(f => ({ ...f, groupBy: tags }))}
                  placeholder="label name (e.g. alertname)" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Group Wait</Text>
                  <Input size="small" value={form.groupWait} placeholder="30s"
                    onChange={e => setForm(f => ({ ...f, groupWait: e.target.value }))} />
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Group Interval</Text>
                  <Input size="small" value={form.groupInterval} placeholder="5m"
                    onChange={e => setForm(f => ({ ...f, groupInterval: e.target.value }))} />
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Repeat Interval</Text>
                  <Input size="small" value={form.repeatInterval} placeholder="12h"
                    onChange={e => setForm(f => ({ ...f, repeatInterval: e.target.value }))} />
                </div>
              </div>
            </Card>

            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong>Sub-Routes</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={addRoute}>Add Route</Button>
              </div>
              {form.routes.length === 0 && <Text type="secondary">No sub-routes.</Text>}
              {form.routes.map((r, i) => (
                <RouteCard key={i} route={r} index={i} receiverNames={receiverNames}
                  onChange={updated => updateRoute(i, updated)}
                  onRemove={() => removeRoute(i)} />
              ))}
            </Card>

            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Inhibit Rules</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={addInhibit}>Add</Button>
              </div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
                Source suppresses target.
              </Text>
              {form.inhibitRules.length === 0 && <Text type="secondary">No inhibit rules.</Text>}
              {form.inhibitRules.map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 32px', gap: 8, marginBottom: 8 }}>
                  <div>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Source alertname</Text>
                    <Input size="small" value={r.sourceMatch} placeholder="HighCPU"
                      onChange={e => updateInhibit(i, 'sourceMatch', e.target.value)} />
                  </div>
                  <div>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Target alertname</Text>
                    <Input size="small" value={r.targetMatch} placeholder="HighMemory"
                      onChange={e => updateInhibit(i, 'targetMatch', e.target.value)} />
                  </div>
                  <div>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Equal labels</Text>
                    <Input size="small" value={r.equal} placeholder="namespace, pod"
                      onChange={e => updateInhibit(i, 'equal', e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                    <Button type="text" danger size="small" icon={<DeleteOutlined />}
                      onClick={() => removeInhibit(i)} />
                  </div>
                </div>
              ))}
            </Card>

            <Space>
              <Button type="primary" onClick={openSaveModal}>Save as Version...</Button>
              {selected && <Button danger onClick={handleDelete}>Delete this version</Button>}
            </Space>
          </div>

          <div style={{
            width: 380, minWidth: 320, borderLeft: '1px solid #f0f0f0',
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
        </div>
      )}

      {modal && <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />}
    </EditorLayout>
  )
}
