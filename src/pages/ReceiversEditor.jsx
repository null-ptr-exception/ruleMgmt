import { useState, useEffect, useCallback } from 'react'
import { Card, Input, Button, Checkbox, Select, Typography, Tag, Space } from 'antd'
import { PlusOutlined, DeleteOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
import EditorLayout from '../components/EditorLayout'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { bumpPatch, latestVersion } from '../utils/templateUtils'

const { Text } = Typography

const TYPE = 'receivers'

const newWebhook    = () => ({ url: '', send_resolved: true })
const newEmail      = () => ({ to: '', from: '', smarthost: '' })
const newSlack      = () => ({ api_url: '', channel: '' })
const newPagerduty  = () => ({ routing_key: '' })
const emptyReceiver = () => ({
  name: '',
  webhook_configs:   [],
  email_configs:     [],
  slack_configs:     [],
  pagerduty_configs: [],
})
const emptyForm = () => ({ templateName: '', receivers: [emptyReceiver()] })

function ConfigSection({ title, icon, rows, onAdd, onRemove, onUpdate, children }) {
  const [open, setOpen] = useState(true)
  return (
    <Card size="small" style={{ marginBottom: 10 }} styles={{ body: { padding: 0 } }}>
      <div
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 12px', cursor: 'pointer',
        }}
        onClick={() => setOpen(o => !o)}
      >
        <Text strong style={{ fontSize: 13 }}>{icon} {title}</Text>
        <Space size={8} onClick={e => e.stopPropagation()}>
          <Text type="secondary" style={{ fontSize: 12 }}>{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</Text>
          <Button size="small" onClick={onAdd} icon={<PlusOutlined />}>Add</Button>
          {open ? <DownOutlined style={{ color: '#8c8c8c' }} /> : <RightOutlined style={{ color: '#8c8c8c' }} />}
        </Space>
      </div>
      {open && (
        <div style={{ padding: 12, borderTop: '1px solid #f0f0f0' }}>
          {rows.length === 0 && <Text type="secondary">No entries. Click + Add to add one.</Text>}
          {rows.map((row, i) => (
            <div key={i} style={{
              display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10,
              padding: 10, background: '#fafafa', borderRadius: 6,
            }}>
              <div style={{ flex: 1 }}>
                {children(row, i, (field, val) => onUpdate(i, field, val))}
              </div>
              <Button danger size="small" onClick={() => onRemove(i)}>Remove</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export default function ReceiversEditor() {
  const [templates, setTemplates] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')

  const load = useCallback(async () => {
    setTemplates(await listTemplates(TYPE))
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const parsed = data.parsed?.receivers || []
    setForm({
      templateName: name,
      receivers: parsed.map(r => ({
        name:              r.name              || '',
        webhook_configs:   (r.webhook_configs   || []).map(c => ({ url: c.url || '', send_resolved: c.send_resolved !== false })),
        email_configs:     (r.email_configs     || []).map(c => ({ to: c.to || '', from: c.from || '', smarthost: c.smarthost || '' })),
        slack_configs:     (r.slack_configs     || []).map(c => ({ api_url: c.api_url || '', channel: c.channel || '' })),
        pagerduty_configs: (r.pagerduty_configs || []).map(c => ({ routing_key: c.routing_key || '' })),
      }))
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
  }

  function updateConfigEntry(ri, section, ei, field, val) {
    setForm(f => ({
      ...f,
      receivers: f.receivers.map((r, idx) => {
        if (idx !== ri) return r
        return {
          ...r,
          [section]: r[section].map((e, eidx) => eidx === ei ? { ...e, [field]: val } : e)
        }
      })
    }))
  }
  function addConfigEntry(ri, section, factory) {
    setForm(f => ({
      ...f,
      receivers: f.receivers.map((r, idx) =>
        idx === ri ? { ...r, [section]: [...r[section], factory()] } : r)
    }))
  }
  function removeConfigEntry(ri, section, ei) {
    setForm(f => ({
      ...f,
      receivers: f.receivers.map((r, idx) =>
        idx === ri ? { ...r, [section]: r[section].filter((_, eidx) => eidx !== ei) } : r)
    }))
  }
  function updateReceiver(ri, field, val) {
    setForm(f => ({ ...f, receivers: f.receivers.map((r, idx) => idx === ri ? { ...r, [field]: val } : r) }))
  }
  function addReceiver() { setForm(f => ({ ...f, receivers: [...f.receivers, emptyReceiver()] })) }
  function removeReceiver(ri) { setForm(f => ({ ...f, receivers: f.receivers.filter((_, idx) => idx !== ri) })) }

  function buildPayload() {
    return {
      receivers: form.receivers.map(r => {
        const out = { name: r.name }
        if (r.webhook_configs.length)
          out.webhook_configs = r.webhook_configs.map(c => ({ url: c.url, send_resolved: c.send_resolved }))
        if (r.email_configs.length)
          out.email_configs = r.email_configs.map(c => ({ to: c.to, from: c.from, smarthost: c.smarthost }))
        if (r.slack_configs.length)
          out.slack_configs = r.slack_configs.map(c => ({ api_url: c.api_url, channel: c.channel }))
        if (r.pagerduty_configs.length)
          out.pagerduty_configs = r.pagerduty_configs.map(c => ({ routing_key: c.routing_key }))
        return out
      })
    }
  }

  async function handleSave(name, version) {
    setModal(null)
    const instanceName = name || `receivers-${Date.now()}`
    await saveTemplate(TYPE, instanceName, version, buildPayload())
    await load()
    setSelected({ name: instanceName, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.templateName?.trim() || selected?.name || ''
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

  const showForm = isNew || selected

  return (
    <EditorLayout
      title="Receivers"
      templates={templates}
      selected={selected}
      onSelect={selectVersion}
      onNew={startNew}
      emptyIcon="📣"
      emptyText="Select a receiver template or click + New."
    >
      {showForm && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Text strong style={{ fontSize: 15 }}>
                {selected ? `${selected.name} @ ${selected.version}` : 'New Receivers'}
              </Text>
              {status && <Tag color="success">{status}</Tag>}
              <div style={{ marginLeft: 'auto' }}>
                <Button size="small" icon={<PlusOutlined />} onClick={addReceiver}>Add Receiver</Button>
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Template Name *</Text>
              <Input
                value={form.templateName}
                placeholder="e.g. mysql-receivers"
                readOnly={!isNew && !!selected}
                style={!isNew && selected ? { background: '#fafafa', color: '#8c8c8c' } : {}}
                onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))}
              />
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Follows Alertmanager receivers format. Receiver names will get product prefix when rendered.
            </Text>
          </Card>

          {form.receivers.map((r, ri) => (
            <Card key={ri} size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <Text strong>Receiver {ri + 1}</Text>
                {r.name && <Tag>{r.name}</Tag>}
                {form.receivers.length > 1 && (
                  <Button danger size="small" onClick={() => removeReceiver(ri)} style={{ marginLeft: 'auto' }}>Remove</Button>
                )}
              </div>

              <div style={{ marginBottom: 14 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Receiver Name *</Text>
                <Input
                  value={r.name}
                  placeholder="e.g. platform-receiver"
                  onChange={e => updateReceiver(ri, 'name', e.target.value)}
                />
              </div>

              <ConfigSection
                title="webhook_configs" icon="🪝"
                rows={r.webhook_configs}
                onAdd={() => addConfigEntry(ri, 'webhook_configs', newWebhook)}
                onRemove={ei => removeConfigEntry(ri, 'webhook_configs', ei)}
                onUpdate={(ei, field, val) => updateConfigEntry(ri, 'webhook_configs', ei, field, val)}
              >
                {(row, ei, set) => (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>URL</Text>
                      <Input size="small" value={row.url} placeholder="https://..."
                        onChange={e => set('url', e.target.value)} />
                    </div>
                    <div style={{ minWidth: 130 }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>Send Resolved</Text>
                      <div style={{ paddingTop: 4 }}>
                        <Checkbox checked={row.send_resolved}
                          onChange={e => set('send_resolved', e.target.checked)}>yes</Checkbox>
                      </div>
                    </div>
                  </div>
                )}
              </ConfigSection>

              <ConfigSection
                title="email_configs" icon="✉️"
                rows={r.email_configs}
                onAdd={() => addConfigEntry(ri, 'email_configs', newEmail)}
                onRemove={ei => removeConfigEntry(ri, 'email_configs', ei)}
                onUpdate={(ei, field, val) => updateConfigEntry(ri, 'email_configs', ei, field, val)}
              >
                {(row, ei, set) => (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>To</Text>
                      <Input size="small" value={row.to} placeholder="team@example.com"
                        onChange={e => set('to', e.target.value)} />
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>From</Text>
                      <Input size="small" value={row.from} placeholder="alertmanager@example.com"
                        onChange={e => set('from', e.target.value)} />
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>Smarthost</Text>
                      <Input size="small" value={row.smarthost} placeholder="smtp.example.com:587"
                        onChange={e => set('smarthost', e.target.value)} />
                    </div>
                  </div>
                )}
              </ConfigSection>

              <ConfigSection
                title="slack_configs" icon="💬"
                rows={r.slack_configs}
                onAdd={() => addConfigEntry(ri, 'slack_configs', newSlack)}
                onRemove={ei => removeConfigEntry(ri, 'slack_configs', ei)}
                onUpdate={(ei, field, val) => updateConfigEntry(ri, 'slack_configs', ei, field, val)}
              >
                {(row, ei, set) => (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>API URL</Text>
                      <Input size="small" value={row.api_url} placeholder="https://hooks.slack.com/..."
                        onChange={e => set('api_url', e.target.value)} />
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>Channel</Text>
                      <Input size="small" value={row.channel} placeholder="#alerts-critical"
                        onChange={e => set('channel', e.target.value)} />
                    </div>
                  </div>
                )}
              </ConfigSection>

              <ConfigSection
                title="pagerduty_configs" icon="🔔"
                rows={r.pagerduty_configs}
                onAdd={() => addConfigEntry(ri, 'pagerduty_configs', newPagerduty)}
                onRemove={ei => removeConfigEntry(ri, 'pagerduty_configs', ei)}
                onUpdate={(ei, field, val) => updateConfigEntry(ri, 'pagerduty_configs', ei, field, val)}
              >
                {(row, ei, set) => (
                  <div>
                    <Text type="secondary" style={{ fontSize: 11 }}>Routing Key</Text>
                    <Input size="small" value={row.routing_key} placeholder="your-routing-key"
                      onChange={e => set('routing_key', e.target.value)} />
                  </div>
                )}
              </ConfigSection>
            </Card>
          ))}

          <Space>
            <Button type="primary" onClick={openSaveModal}>Save as Version…</Button>
            {selected && <Button danger onClick={handleDelete}>Delete this version</Button>}
          </Space>
        </div>
      )}

      {modal && <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />}
    </EditorLayout>
  )
}
