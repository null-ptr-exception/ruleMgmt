import { useState, useEffect, useCallback } from 'react'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { bumpPatch, latestVersion } from '../utils/templateUtils'

const TYPE = 'receivers'

// ── Per-entry factories ────────────────────────────────────────────────────────
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

// ── Config section component ───────────────────────────────────────────────────
function ConfigSection({ title, icon, rows, onAdd, onRemove, onUpdate, children }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 10 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 12px', background: '#f9fafb', borderRadius: open ? '6px 6px 0 0' : 6,
          cursor: 'pointer', borderBottom: open ? '1px solid #e5e7eb' : 'none' }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>{icon} {title}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
          <span className="text-muted">{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span>
          <button className="btn btn-secondary btn-sm" onClick={onAdd}>+ Add</button>
          <span style={{ color: '#9ca3af', fontSize: 16 }}>{open ? '▾' : '▸'}</span>
        </div>
      </div>
      {open && (
        <div style={{ padding: 12 }}>
          {rows.length === 0 && <p className="text-muted">No entries. Click + Add to add one.</p>}
          {rows.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10,
              padding: 10, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ flex: 1 }}>
                {children(row, i, (field, val) => onUpdate(i, field, val))}
              </div>
              <button className="btn btn-danger btn-sm" style={{ marginTop: 2 }}
                onClick={() => onRemove(i)}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
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

  // Generic updaters for a receiver's config section entries
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

  return (
    <div className="editor-layout">
      <div className="editor-list">
        <div className="editor-list-header">
          Receivers
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No receivers yet.</div>
          )}
          {Object.entries(templates).map(([name, versions]) => (
            <div key={name} className="template-group">
              <div className="template-group-name">{name}</div>
              {versions.map(v => (
                <div key={v}
                  className={`template-version${selected?.name === name && selected?.version === v ? ' active' : ''}`}
                  onClick={() => selectVersion(name, v)}>
                  <span className="version-badge">{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="editor-form">
        {!isNew && !selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">📣</div>
            <p>Select a receiver template or click + New.</p>
          </div>
        ) : (
          <>
            <div className="form-card">
              <div className="form-card-title">
                {selected ? `${selected.name} @ ${selected.version}` : 'New Receivers'}
                {status && <span className="tag">{status}</span>}
                <button className="btn btn-secondary btn-sm" onClick={addReceiver}>+ Add Receiver</button>
              </div>
              <div className="form-row" style={{ marginBottom: 10 }}>
                <label>Template Name *</label>
                <input type="text" value={form.templateName}
                  placeholder="e.g. mysql-receivers"
                  readOnly={!isNew && !!selected}
                  style={!isNew && selected ? { background: '#f9fafb', color: '#6b7280' } : {}}
                  onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))} />
              </div>
              <p className="text-muted">
                Follows Alertmanager receivers format. Receiver names will get product prefix when rendered.
              </p>
            </div>

            {form.receivers.map((r, ri) => (
              <div key={ri} className="form-card">
                <div className="form-card-title">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span>Receiver {ri + 1}</span>
                    {r.name && <span className="tag">{r.name}</span>}
                  </div>
                  {form.receivers.length > 1 && (
                    <button className="btn btn-danger btn-sm" onClick={() => removeReceiver(ri)}>Remove</button>
                  )}
                </div>

                <div className="form-row" style={{ marginBottom: 14 }}>
                  <label>Receiver Name *</label>
                  <input type="text" value={r.name} placeholder="e.g. platform-receiver"
                    onChange={e => updateReceiver(ri, 'name', e.target.value)} />
                </div>

                {/* webhook_configs */}
                <ConfigSection
                  title="webhook_configs" icon="🪝"
                  rows={r.webhook_configs}
                  onAdd={() => addConfigEntry(ri, 'webhook_configs', newWebhook)}
                  onRemove={ei => removeConfigEntry(ri, 'webhook_configs', ei)}
                  onUpdate={(ei, field, val) => updateConfigEntry(ri, 'webhook_configs', ei, field, val)}
                >
                  {(row, ei, set) => (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                      <div className="form-row">
                        <label>URL</label>
                        <input type="text" value={row.url} placeholder="https://..."
                          onChange={e => set('url', e.target.value)} />
                      </div>
                      <div className="form-row" style={{ minWidth: 130 }}>
                        <label style={{ whiteSpace: 'nowrap' }}>Send Resolved</label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4, cursor: 'pointer' }}>
                          <input type="checkbox" checked={row.send_resolved}
                            onChange={e => set('send_resolved', e.target.checked)} />
                          yes
                        </label>
                      </div>
                    </div>
                  )}
                </ConfigSection>

                {/* email_configs */}
                <ConfigSection
                  title="email_configs" icon="✉️"
                  rows={r.email_configs}
                  onAdd={() => addConfigEntry(ri, 'email_configs', newEmail)}
                  onRemove={ei => removeConfigEntry(ri, 'email_configs', ei)}
                  onUpdate={(ei, field, val) => updateConfigEntry(ri, 'email_configs', ei, field, val)}
                >
                  {(row, ei, set) => (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                      <div className="form-row">
                        <label>To</label>
                        <input type="text" value={row.to} placeholder="team@example.com"
                          onChange={e => set('to', e.target.value)} />
                      </div>
                      <div className="form-row">
                        <label>From</label>
                        <input type="text" value={row.from} placeholder="alertmanager@example.com"
                          onChange={e => set('from', e.target.value)} />
                      </div>
                      <div className="form-row">
                        <label>Smarthost</label>
                        <input type="text" value={row.smarthost} placeholder="smtp.example.com:587"
                          onChange={e => set('smarthost', e.target.value)} />
                      </div>
                    </div>
                  )}
                </ConfigSection>

                {/* slack_configs */}
                <ConfigSection
                  title="slack_configs" icon="💬"
                  rows={r.slack_configs}
                  onAdd={() => addConfigEntry(ri, 'slack_configs', newSlack)}
                  onRemove={ei => removeConfigEntry(ri, 'slack_configs', ei)}
                  onUpdate={(ei, field, val) => updateConfigEntry(ri, 'slack_configs', ei, field, val)}
                >
                  {(row, ei, set) => (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div className="form-row">
                        <label>API URL</label>
                        <input type="text" value={row.api_url} placeholder="https://hooks.slack.com/..."
                          onChange={e => set('api_url', e.target.value)} />
                      </div>
                      <div className="form-row">
                        <label>Channel</label>
                        <input type="text" value={row.channel} placeholder="#alerts-critical"
                          onChange={e => set('channel', e.target.value)} />
                      </div>
                    </div>
                  )}
                </ConfigSection>

                {/* pagerduty_configs */}
                <ConfigSection
                  title="pagerduty_configs" icon="🔔"
                  rows={r.pagerduty_configs}
                  onAdd={() => addConfigEntry(ri, 'pagerduty_configs', newPagerduty)}
                  onRemove={ei => removeConfigEntry(ri, 'pagerduty_configs', ei)}
                  onUpdate={(ei, field, val) => updateConfigEntry(ri, 'pagerduty_configs', ei, field, val)}
                >
                  {(row, ei, set) => (
                    <div className="form-row">
                      <label>Routing Key</label>
                      <input type="text" value={row.routing_key} placeholder="your-routing-key"
                        onChange={e => set('routing_key', e.target.value)} />
                    </div>
                  )}
                </ConfigSection>
              </div>
            ))}

            <div className="btn-row">
              <button className="btn btn-primary" onClick={openSaveModal}>Save as Version…</button>
              {selected && <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>}
            </div>
          </>
        )}
      </div>

      {modal && <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />}
    </div>
  )
}
