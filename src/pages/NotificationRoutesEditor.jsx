import { useState, useEffect, useMemo, useCallback } from 'react'
import { Card, Input, Button, Select, Typography, Tag, Space, Empty, Checkbox } from 'antd'
import { DeleteOutlined, PlusOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'

const { Text } = Typography

const MATCHER_OPS = ['=', '!=', '=~', '!~']

const emptyMatcher = () => ({ key: '', op: '=', value: '' })
const emptyRoute = () => ({ receiver: '', matchers: [emptyMatcher()] })
const emptyInhibitRule = () => ({ sourceMatchers: [emptyMatcher()], targetMatchers: [emptyMatcher()], equal: [] })
const newWebhook = () => ({ url: '', send_resolved: true })
const newEmail = () => ({ to: '', from: '', smarthost: '' })
const newSlack = () => ({ api_url: '', channel: '' })
const newPagerduty = () => ({ routing_key: '' })
const emptyReceiver = () => ({
  name: '',
  webhook_configs: [],
  email_configs: [],
  slack_configs: [],
  pagerduty_configs: [],
})

const emptyForm = () => ({
  configName: '',
  defaultReceiver: '',
  receivers: [emptyReceiver()],
  routeMatchers: [],
  routeRules: [emptyRoute()],
  inhibitRules: [],
})

function buildYAML(form) {
  const name = form.configName || 'alertmanager-config'
  let y = `apiVersion: monitoring.coreos.com/v1alpha1\nkind: AlertmanagerConfig\nmetadata:\n  name: ${name}\nspec:\n`
  y += `  route:\n    receiver: ${JSON.stringify(form.defaultReceiver || 'default')}\n`

  const topMatchers = (form.routeMatchers || []).filter(m => m.key.trim())
  if (topMatchers.length) {
    y += `    matchers:\n`
    for (const m of topMatchers)
      y += `      - name: ${m.key}\n        matchType: "${m.op || '='}"\n        value: ${JSON.stringify(m.value)}\n`
  }

  const routes = form.routeRules.filter(r => r.receiver && r.matchers.some(m => m.key.trim()))
  if (routes.length) {
    y += `    routes:\n`
    for (const r of routes) {
      y += `      - receiver: ${JSON.stringify(r.receiver)}\n`
      const ms = r.matchers.filter(m => m.key.trim())
      if (ms.length) {
        y += `        matchers:\n`
        for (const m of ms)
          y += `          - name: ${m.key}\n            matchType: "${m.op || '='}"\n            value: ${JSON.stringify(m.value)}\n`
      }
    }
  }

  y += `  receivers:\n`
  for (const rx of form.receivers) {
    if (!rx.name) continue
    y += `    - name: ${JSON.stringify(rx.name)}\n`
    if (rx.webhook_configs?.length) {
      y += `      webhookConfigs:\n`
      for (const c of rx.webhook_configs)
        y += `        - url: ${JSON.stringify(c.url || '')}\n          sendResolved: ${c.send_resolved ?? true}\n`
    }
    if (rx.slack_configs?.length) {
      y += `      slackConfigs:\n`
      for (const c of rx.slack_configs)
        y += `        - apiURL: ${JSON.stringify(c.api_url || '')}\n          channel: ${JSON.stringify(c.channel || '')}\n          sendResolved: true\n`
    }
    if (rx.pagerduty_configs?.length) {
      y += `      pagerdutyConfigs:\n`
      for (const c of rx.pagerduty_configs)
        y += `        - routingKey: ${JSON.stringify(c.routing_key || '')}\n          sendResolved: true\n`
    }
    if (rx.email_configs?.length) {
      y += `      emailConfigs:\n`
      for (const c of rx.email_configs)
        y += `        - to: ${JSON.stringify(c.to || '')}\n          from: ${JSON.stringify(c.from || '')}\n          smarthost: ${JSON.stringify(c.smarthost || '')}\n`
    }
  }
  const namedReceivers = new Set(form.receivers.filter(r => r.name).map(r => r.name))
  const routeReceivers = new Set([form.defaultReceiver, ...form.routeRules.map(r => r.receiver)].filter(Boolean))
  for (const rn of routeReceivers) {
    if (!namedReceivers.has(rn)) y += `    - name: ${JSON.stringify(rn)}\n`
  }

  const inhibits = (form.inhibitRules || []).filter(r =>
    r.sourceMatchers.some(m => m.key.trim()) || r.targetMatchers.some(m => m.key.trim())
  )
  if (inhibits.length) {
    y += `  inhibitRules:\n`
    for (const rule of inhibits) {
      const src = rule.sourceMatchers.filter(m => m.key.trim())
      const tgt = rule.targetMatchers.filter(m => m.key.trim())
      y += `    - sourceMatch:\n`
      for (const m of src)
        y += `        - name: ${m.key}\n          matchType: "${m.op || '='}"\n          value: ${JSON.stringify(m.value)}\n`
      y += `      targetMatch:\n`
      for (const m of tgt)
        y += `        - name: ${m.key}\n          matchType: "${m.op || '='}"\n          value: ${JSON.stringify(m.value)}\n`
      const eq = (rule.equal || []).filter(e => e.trim())
      if (eq.length) {
        y += `      equal:\n`
        for (const e of eq) y += `        - ${JSON.stringify(e)}\n`
      }
    }
  }

  return y.trimEnd()
}

function parseYAMLToForm(parsed) {
  if (!parsed?.spec) return null
  const spec = parsed.spec
  const route = spec.route || {}
  const form = {
    configName: parsed.metadata?.name || '',
    defaultReceiver: route.receiver || '',
    receivers: (spec.receivers || []).map(rx => ({
      name: rx.name || '',
      webhook_configs: (rx.webhookConfigs || []).map(c => ({ url: c.url || '', send_resolved: c.sendResolved !== false })),
      email_configs: (rx.emailConfigs || []).map(c => ({ to: c.to || '', from: c.from || '', smarthost: c.smarthost || '' })),
      slack_configs: (rx.slackConfigs || []).map(c => ({ api_url: c.apiURL || '', channel: c.channel || '' })),
      pagerduty_configs: (rx.pagerdutyConfigs || []).map(c => ({ routing_key: c.routingKey || '' })),
    })),
    routeMatchers: (route.matchers || []).map(m => ({ key: m.name || '', op: m.matchType || '=', value: m.value || '' })),
    routeRules: (route.routes || []).map(r => ({
      receiver: r.receiver || '',
      matchers: (r.matchers || []).map(m => ({ key: m.name || '', op: m.matchType || '=', value: m.value || '' })),
    })),
    inhibitRules: (spec.inhibitRules || []).map(r => ({
      sourceMatchers: (r.sourceMatch || []).map(m => ({ key: m.name || '', op: m.matchType || '=', value: m.value || '' })),
      targetMatchers: (r.targetMatch || []).map(m => ({ key: m.name || '', op: m.matchType || '=', value: m.value || '' })),
      equal: r.equal || [],
    })),
  }
  if (form.receivers.length === 0) form.receivers = [emptyReceiver()]
  if (form.routeRules.length === 0) form.routeRules = [emptyRoute()]
  return form
}

function MatcherRows({ matchers, onChange }) {
  function upM(i, f, v) { onChange(matchers.map((m, idx) => idx === i ? { ...m, [f]: v } : m)) }
  function addM() { onChange([...matchers, emptyMatcher()]) }
  function delM(i) { onChange(matchers.filter((_, idx) => idx !== i)) }

  return (
    <div>
      {matchers.map((m, mi) => (
        <div key={mi} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <Input size="small" value={m.key} placeholder="label name" style={{ flex: 1 }}
            onChange={e => upM(mi, 'key', e.target.value)} />
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

function ReceiverCard({ receiver, index, onUpdate, onRemove }) {
  function set(field, val) { onUpdate({ ...receiver, [field]: val }) }
  function updateEntry(section, ei, field, val) {
    onUpdate({ ...receiver, [section]: receiver[section].map((e, i) => i === ei ? { ...e, [field]: val } : e) })
  }
  function addEntry(section, factory) {
    onUpdate({ ...receiver, [section]: [...receiver[section], factory()] })
  }
  function removeEntry(section, ei) {
    onUpdate({ ...receiver, [section]: receiver[section].filter((_, i) => i !== ei) })
  }

  function ConfigSection({ title, section, rows, factory, children }) {
    const [open, setOpen] = useState(rows.length > 0)
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
            {open ? <DownOutlined /> : <RightOutlined />} {title} ({rows.length})
          </Text>
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => { addEntry(section, factory); setOpen(true) }} />
        </div>
        {open && rows.map((row, ei) => (
          <div key={ei} style={{ display: 'flex', gap: 6, marginBottom: 6, padding: 8, background: '#fafafa', borderRadius: 4 }}>
            <div style={{ flex: 1 }}>{children(row, ei)}</div>
            <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => removeEntry(section, ei)} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <Card size="small" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Space>
          <Text strong style={{ fontSize: 13 }}>Receiver {index + 1}</Text>
          {receiver.name && <Tag>{receiver.name}</Tag>}
        </Space>
        <Button danger size="small" onClick={onRemove}>Remove</Button>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Name *</Text>
        <Input size="small" value={receiver.name} placeholder="e.g. critical-pagerduty"
          onChange={e => set('name', e.target.value)} />
      </div>

      <ConfigSection title="Webhooks" section="webhook_configs" rows={receiver.webhook_configs} factory={newWebhook}>
        {(row, ei) => (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input size="small" value={row.url} placeholder="https://..." style={{ flex: 1 }}
              onChange={e => updateEntry('webhook_configs', ei, 'url', e.target.value)} />
            <Checkbox checked={row.send_resolved}
              onChange={e => updateEntry('webhook_configs', ei, 'send_resolved', e.target.checked)}>
              <Text style={{ fontSize: 11 }}>resolved</Text>
            </Checkbox>
          </div>
        )}
      </ConfigSection>

      <ConfigSection title="Slack" section="slack_configs" rows={receiver.slack_configs} factory={newSlack}>
        {(row, ei) => (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Input size="small" value={row.api_url} placeholder="https://hooks.slack.com/..."
              onChange={e => updateEntry('slack_configs', ei, 'api_url', e.target.value)} />
            <Input size="small" value={row.channel} placeholder="#channel"
              onChange={e => updateEntry('slack_configs', ei, 'channel', e.target.value)} />
          </div>
        )}
      </ConfigSection>

      <ConfigSection title="PagerDuty" section="pagerduty_configs" rows={receiver.pagerduty_configs} factory={newPagerduty}>
        {(row, ei) => (
          <Input size="small" value={row.routing_key} placeholder="routing key"
            onChange={e => updateEntry('pagerduty_configs', ei, 'routing_key', e.target.value)} />
        )}
      </ConfigSection>

      <ConfigSection title="Email" section="email_configs" rows={receiver.email_configs} factory={newEmail}>
        {(row, ei) => (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <Input size="small" value={row.to} placeholder="to@example.com"
              onChange={e => updateEntry('email_configs', ei, 'to', e.target.value)} />
            <Input size="small" value={row.from} placeholder="from@example.com"
              onChange={e => updateEntry('email_configs', ei, 'from', e.target.value)} />
            <Input size="small" value={row.smarthost} placeholder="smtp:587"
              onChange={e => updateEntry('email_configs', ei, 'smarthost', e.target.value)} />
          </div>
        )}
      </ConfigSection>
    </Card>
  )
}

function RouteCard({ route, index, onChange, onRemove }) {
  return (
    <Card size="small" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Text strong style={{ fontSize: 13 }}>Route {index + 1}</Text>
        <Button danger size="small" onClick={onRemove}>Remove</Button>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Receiver</Text>
        <Input size="small" value={route.receiver} placeholder="receiver name"
          onChange={e => onChange({ ...route, receiver: e.target.value })} />
      </div>
      <div>
        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Matchers</Text>
        <MatcherRows matchers={route.matchers} onChange={ms => onChange({ ...route, matchers: ms })} />
      </div>
    </Card>
  )
}

export default function NotificationRoutesEditor() {
  const [configs, setConfigs] = useState([])
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(emptyForm())
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [yamlExpanded, setYamlExpanded] = useState(false)

  const loadConfigs = useCallback(async () => {
    const res = await fetch('/api/v2/alertmanager-configs')
    if (res.ok) setConfigs(await res.json())
  }, [])

  useEffect(() => { loadConfigs() }, [loadConfigs])

  async function selectConfig(name) {
    const res = await fetch(`/api/v2/alertmanager-configs/${name}`)
    if (!res.ok) return
    const { parsed } = await res.json()
    const f = parseYAMLToForm(parsed)
    if (f) { setForm(f); setSelected(name); setDirty(false) }
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setDirty(false)
  }

  function updateForm(updater) {
    setForm(f => {
      const next = typeof updater === 'function' ? updater(f) : updater
      return next
    })
    setDirty(true)
  }

  async function handleSave() {
    const name = form.configName.trim()
    if (!name) return
    const content = buildYAML(form)
    const res = await fetch(`/api/v2/alertmanager-configs/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (res.ok) {
      setSelected(name)
      setDirty(false)
      setStatus('Saved')
      setTimeout(() => setStatus(''), 2500)
      await loadConfigs()
    }
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected}?`)) return
    await fetch(`/api/v2/alertmanager-configs/${selected}`, { method: 'DELETE' })
    setSelected(null)
    setForm(emptyForm())
    setDirty(false)
    await loadConfigs()
  }

  const preview = useMemo(() => buildYAML(form), [form])

  const showForm = selected !== null || form.configName.trim() !== ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ padding: '10px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa' }}>
        <Select
          value={selected || undefined}
          onChange={val => val ? selectConfig(val) : startNew()}
          placeholder="Select a config..."
          style={{ width: 260 }}
          allowClear
          onClear={startNew}
          options={configs.map(name => ({ value: name, label: name }))}
        />
        <Button icon={<PlusOutlined />} onClick={startNew}>New</Button>
        {status && <Tag color="success">{status}</Tag>}
        {dirty && <Tag color="warning">unsaved</Tag>}
      </div>

      {/* Main content */}
      {!showForm ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty description="Select a config or create a new one" />
        </div>
      ) : (
        <>
          <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
              {/* Identity */}
              <Card size="small" style={{ marginBottom: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Config Name *</Text>
                    <Input value={form.configName} placeholder="e.g. platform-routing"
                      onChange={e => updateForm(f => ({ ...f, configName: e.target.value }))} />
                  </div>
                  <div>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Default Receiver</Text>
                    <Input value={form.defaultReceiver} placeholder="catch-all receiver"
                      onChange={e => updateForm(f => ({ ...f, defaultReceiver: e.target.value }))} />
                  </div>
                </div>
              </Card>

              {/* Receivers */}
              <Card size="small" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Text strong>Receivers</Text>
                  <Button size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }}
                    onClick={() => updateForm(f => ({ ...f, receivers: [...f.receivers, emptyReceiver()] }))}>
                    Add Receiver
                  </Button>
                </div>
                {form.receivers.map((rx, i) => (
                  <ReceiverCard key={i} receiver={rx} index={i}
                    onUpdate={upd => updateForm(f => ({ ...f, receivers: f.receivers.map((r, idx) => idx === i ? upd : r) }))}
                    onRemove={() => updateForm(f => ({ ...f, receivers: f.receivers.filter((_, idx) => idx !== i) }))} />
                ))}
              </Card>

              {/* Route Matchers (top-level) */}
              <Card size="small" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Text strong>Top-Level Matchers</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>scope which alerts this config handles</Text>
                </div>
                {form.routeMatchers.length === 0 ? (
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>No top-level matchers — handles all alerts.</Text>
                    <Button size="small" icon={<PlusOutlined />} style={{ marginLeft: 8 }}
                      onClick={() => updateForm(f => ({ ...f, routeMatchers: [emptyMatcher()] }))}>Add</Button>
                  </div>
                ) : (
                  <MatcherRows matchers={form.routeMatchers}
                    onChange={ms => updateForm(f => ({ ...f, routeMatchers: ms }))} />
                )}
              </Card>

              {/* Routes */}
              <Card size="small" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Text strong>Routes</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>match alerts to receivers</Text>
                  <Button size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }}
                    onClick={() => updateForm(f => ({ ...f, routeRules: [...f.routeRules, emptyRoute()] }))}>Add Route</Button>
                </div>
                {form.routeRules.map((route, i) => (
                  <RouteCard key={i} route={route} index={i}
                    onChange={upd => updateForm(f => ({ ...f, routeRules: f.routeRules.map((r, idx) => idx === i ? upd : r) }))}
                    onRemove={() => updateForm(f => ({ ...f, routeRules: f.routeRules.filter((_, idx) => idx !== i) }))} />
                ))}
              </Card>

              {/* Inhibit Rules */}
              <Card size="small" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Text strong>Inhibit Rules</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>source alert suppresses target</Text>
                  <Button size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }}
                    onClick={() => updateForm(f => ({ ...f, inhibitRules: [...f.inhibitRules, emptyInhibitRule()] }))}>Add</Button>
                </div>
                {form.inhibitRules.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No inhibit rules.</Text>}
                {form.inhibitRules.map((rule, ri) => (
                  <Card key={ri} size="small" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <Text strong style={{ fontSize: 13 }}>Inhibit Rule {ri + 1}</Text>
                      <Button danger size="small"
                        onClick={() => updateForm(f => ({ ...f, inhibitRules: f.inhibitRules.filter((_, i) => i !== ri) }))}>Remove</Button>
                    </div>
                    {[['sourceMatchers', 'Source (firing)'], ['targetMatchers', 'Target (suppressed)']].map(([side, label]) => (
                      <div key={side} style={{ marginBottom: 10 }}>
                        <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4 }}>{label}</Text>
                        <MatcherRows matchers={rule[side]}
                          onChange={ms => updateForm(f => ({
                            ...f,
                            inhibitRules: f.inhibitRules.map((r, i) => i === ri ? { ...r, [side]: ms } : r)
                          }))} />
                      </div>
                    ))}
                    <div>
                      <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                        Equal Labels
                      </Text>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        {rule.equal.map((e, ei) => (
                          <Tag key={ei} closable
                            onClose={() => updateForm(f => ({
                              ...f, inhibitRules: f.inhibitRules.map((r, i) => i === ri ? { ...r, equal: r.equal.filter((_, j) => j !== ei) } : r)
                            }))}
                            color="green" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                            <input type="text" value={e} placeholder="label"
                              style={{ border: 'none', background: 'transparent', fontFamily: 'monospace', fontSize: 12, width: Math.max(50, e.length * 8 + 10), padding: 0 }}
                              onChange={ev => updateForm(f => ({
                                ...f, inhibitRules: f.inhibitRules.map((r, i) => i === ri ? { ...r, equal: r.equal.map((v, j) => j === ei ? ev.target.value : v) } : r)
                              }))} />
                          </Tag>
                        ))}
                        <Button size="small" icon={<PlusOutlined />}
                          onClick={() => updateForm(f => ({
                            ...f, inhibitRules: f.inhibitRules.map((r, i) => i === ri ? { ...r, equal: [...r.equal, ''] } : r)
                          }))}>Add</Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </Card>

              {/* Actions */}
              <Space>
                <Button type="primary" onClick={handleSave} disabled={!form.configName.trim()}>Save</Button>
                {selected && <Button danger onClick={handleDelete}>Delete</Button>}
              </Space>
            </div>

            {/* YAML Preview */}
            <div style={{ borderTop: '1px solid #f0f0f0' }}>
              <div
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, background: '#fafafa' }}
                onClick={() => setYamlExpanded(o => !o)}
              >
                {yamlExpanded ? <DownOutlined /> : <RightOutlined />}
                <Text style={{ fontSize: 12, fontWeight: 600, color: '#8c8c8c' }}>YAML Preview</Text>
              </div>
              {yamlExpanded && (
                <pre style={{
                  margin: 0, padding: '14px 16px', maxHeight: 300, overflowY: 'auto',
                  fontSize: 11.5, fontFamily: "'Fira Code', monospace",
                  background: '#0f172a', color: '#7dd3fc', lineHeight: 1.7,
                }}>
                  {preview}
                </pre>
              )}
            </div>
          </>
        )}
    </div>
  )
}
