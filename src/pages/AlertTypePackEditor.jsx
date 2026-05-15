import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, Input, Button, Select, Table, Typography, Tag, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import EditorLayout from '../components/EditorLayout'
import KVEditor from '../components/KVEditor'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { kvArrayToObject, bumpPatch, latestVersion } from '../utils/templateUtils'

const { Text } = Typography

const TYPE = 'alert-type-pack'
const VAR_TYPES = ['string', 'metrics', 'op', 'func', 'time', 'int']

let _uid = 0
const uid = () => String(++_uid)

const emptyPackRule = () => ({
  _id: uid(),
  ruleName: '',
  expr: '',
  labels: [{ key: 'severity', value: 'warning' }],
  for: '',
  description: '',
})

const emptyForm = () => ({
  name: '',
  description: '',
  vars: [],
  rules: [emptyPackRule()],
})

// ── YAML preview builder ──────────────────────────────────────────────────────

function buildPackPreview(form) {
  let y = ''
  y += `name: ${form.name || 'unnamed-pack'}\n`
  if (form.description) y += `description: ${JSON.stringify(form.description)}\n`

  const vars = form.vars.filter(v => v.name.trim())
  if (vars.length) {
    y += `vars:\n`
    for (const v of vars) {
      y += `  - name: ${v.name}\n`
      if (v.type && v.type !== 'string') y += `    type: ${v.type}\n`
      if (v.description) y += `    description: ${JSON.stringify(v.description)}\n`
    }
  }

  const rules = form.rules.filter(r => r.ruleName.trim() || r.expr.trim())
  y += `rules:\n`
  if (!rules.length) {
    y += `  []\n`
  } else {
    for (const r of rules) {
      y += `  - ruleName: ${JSON.stringify(r.ruleName || '')}\n`
      y += `    expr: ${JSON.stringify(r.expr || '')}\n`
      const lbls = (r.labels || []).filter(l => l.key.trim())
      if (lbls.length) {
        y += `    labels:\n`
        for (const { key, value } of lbls) y += `      ${key}: ${value}\n`
      }
      if (r.for) y += `    for: ${r.for}\n`
      if (r.description) y += `    description: ${JSON.stringify(r.description)}\n`
    }
  }
  return y.trimEnd()
}

function previewFill(str, vars) {
  if (!str) return ''
  const map = {}
  for (const v of vars) if (v.name.trim()) map[v.name.trim()] = `<${v.name.trim()}>`
  map['alertName'] = '<alertName>'
  return str.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k) => map[k] ?? `{{ .${k} }}`)
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlertTypePackEditor() {
  const [templates, setTemplates] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')
  const [showPreview, setShowPreview] = useState(false)

  const load = useCallback(async () => {
    setTemplates(await listTemplates(TYPE))
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const p = data.parsed || {}
    setForm({
      name:        p.name        || name,
      description: p.description || '',
      vars: (p.vars || []).map(v => ({
        name:        v.name        || '',
        type:        v.type        || 'string',
        description: v.description || '',
      })),
      rules: (p.rules || [emptyPackRule()]).map(r => ({
        _id:         uid(),
        ruleName:    r.ruleName    || '',
        expr:        r.expr        || '',
        labels: r.labels
          ? Object.entries(r.labels).map(([key, value]) => ({ key, value: String(value) }))
          : (r.severity ? [{ key: 'severity', value: r.severity }] : [{ key: 'severity', value: 'warning' }]),
        for:         r.for         || '',
        description: r.description || '',
      })),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() { setForm(emptyForm()); setSelected(null); setIsNew(true) }

  function addVar() {
    setForm(f => ({ ...f, vars: [...f.vars, { name: '', type: 'string', description: '' }] }))
  }
  function removeVar(i) {
    setForm(f => ({ ...f, vars: f.vars.filter((_, idx) => idx !== i) }))
  }
  function updateVar(i, field, val) {
    setForm(f => ({ ...f, vars: f.vars.map((v, idx) => idx === i ? { ...v, [field]: val } : v) }))
  }

  function addPackRule() {
    setForm(f => ({ ...f, rules: [...f.rules, emptyPackRule()] }))
  }
  function removePackRule(id) {
    setForm(f => ({ ...f, rules: f.rules.filter(r => r._id !== id) }))
  }
  function updatePackRule(id, field, val) {
    setForm(f => ({ ...f, rules: f.rules.map(r => r._id === id ? { ...r, [field]: val } : r) }))
  }

  function buildPayload() {
    return {
      name:        form.name,
      description: form.description || undefined,
      vars: form.vars.filter(v => v.name.trim()).map(v => ({
        name: v.name.trim(),
        type: v.type || 'string',
        ...(v.description ? { description: v.description } : {}),
      })),
      rules: form.rules.map(r => {
        const obj = { ruleName: r.ruleName, expr: r.expr }
        const lbls = kvArrayToObject((r.labels || []).filter(l => l.key.trim()))
        if (Object.keys(lbls).length) obj.labels = lbls
        if (r.for)         obj.for = r.for
        if (r.description) obj.description = r.description
        return obj
      }),
    }
  }

  async function handleSave(name, version) {
    setModal(null)
    if (!name) return
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved ${name} @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.name.trim()
    const existing = templates[n]
    const suggested = selected
      ? bumpPatch(selected.version)
      : (existing?.length ? bumpPatch(latestVersion(existing)) : 'v1.0.0')
    setModal({ name: n, version: suggested })
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  const preview = useMemo(() => buildPackPreview(form), [form])
  const showForm = isNew || selected

  const varColumns = [
    {
      title: 'Name', dataIndex: 'name', width: '28%',
      render: (_, v, i) => (
        <Input size="small" value={v.name} placeholder="varName"
          onChange={e => updateVar(i, 'name', e.target.value)} />
      ),
    },
    {
      title: 'Type', dataIndex: 'type', width: '16%',
      render: (_, v, i) => (
        <Select size="small" value={v.type} onChange={val => updateVar(i, 'type', val)}
          style={{ width: '100%' }}
          options={VAR_TYPES.map(t => ({ value: t, label: t }))} />
      ),
    },
    {
      title: 'Description', dataIndex: 'description',
      render: (_, v, i) => (
        <Input size="small" value={v.description} placeholder="what this var means"
          onChange={e => updateVar(i, 'description', e.target.value)} />
      ),
    },
    {
      title: '', key: 'actions', width: 40,
      render: (_, _v, i) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => removeVar(i)} />
      ),
    },
  ]

  return (
    <EditorLayout
      title="Alert Packs"
      templates={templates}
      selected={selected}
      onSelect={selectVersion}
      onNew={startNew}
      emptyIcon="📋"
      emptyText="Select a pack or click + New to create one."
    >
      {showForm && (
        <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 }}>
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong style={{ fontSize: 15 }}>
                  {isNew ? 'New Alert Pack' : `${selected.name} @ ${selected.version}`}
                </Text>
                {status && <Tag color="success">{status}</Tag>}
                <div style={{ marginLeft: 'auto' }}>
                  <Button size="small" type={showPreview ? 'primary' : 'default'}
                    onClick={() => setShowPreview(v => !v)}>
                    {showPreview ? 'Hide Preview' : 'Show Preview'}
                  </Button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Name *</Text>
                  <Input value={form.name} placeholder="e.g. threshold-pair"
                    readOnly={!isNew && !!selected}
                    style={!isNew && selected ? { background: '#fafafa', color: '#8c8c8c' } : {}}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Description</Text>
                  <Input value={form.description} placeholder="Optional"
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
            </Card>

            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Shared Variables</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={addVar}>Add Var</Button>
              </div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 10, fontSize: 12 }}>
                Variables declared here are shared across all rule templates in this pack.
                Use <code style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: '1px 5px', borderRadius: 3 }}>{'{{ .varName }}'}</code> in rule expressions, names, and descriptions.
                The special variable <code style={{ fontFamily: 'monospace', background: '#f9f0ff', color: '#722ed1', padding: '1px 5px', borderRadius: 3 }}>{'{{ .alertName }}'}</code> is
                set by the instance's alert name prefix.
              </Text>
              <Table
                columns={varColumns}
                dataSource={form.vars.map((v, i) => ({ ...v, key: `var-${i}` }))}
                pagination={false}
                size="small"
                bordered
                locale={{ emptyText: 'No shared vars declared.' }}
              />
            </Card>

            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text strong>Rule Templates</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={addPackRule}>Add Rule Template</Button>
              </div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
                Each rule template is instantiated once per pack instance, with shared variable values substituted in.
              </Text>
              {form.rules.map((rule, i) => {
                const exprPreview = previewFill(rule.expr, form.vars)
                const namePreview = previewFill(rule.ruleName, form.vars)
                return (
                  <Card key={rule._id} size="small" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span>
                        <Text strong style={{ fontSize: 13, color: '#6366f1' }}>
                          Rule template {i + 1}
                        </Text>
                        {namePreview && (
                          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12, fontFamily: 'monospace' }}>
                            → {namePreview}
                          </Text>
                        )}
                      </span>
                      {form.rules.length > 1 && (
                        <Button danger size="small" onClick={() => removePackRule(rule._id)}>Remove</Button>
                      )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Rule Name Template *</Text>
                        <Input size="small" value={rule.ruleName}
                          placeholder={'{{ .alertName }}-warning'}
                          onChange={e => updatePackRule(rule._id, 'ruleName', e.target.value)} />
                      </div>
                      <div>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>For (duration)</Text>
                        <Input size="small" value={rule.for} placeholder="e.g. 5m"
                          onChange={e => updatePackRule(rule._id, 'for', e.target.value)} />
                      </div>
                    </div>

                    <div style={{ marginBottom: 10 }}>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                        Labels <Text type="secondary" style={{ fontSize: 11 }}>
                          include <code style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: '0 3px', borderRadius: 2 }}>severity</code> here
                        </Text>
                      </Text>
                      <KVEditor
                        rows={rule.labels}
                        onChange={rows => updatePackRule(rule._id, 'labels', rows)}
                        keyPlaceholder="label key"
                        valuePlaceholder="value or {{ .varName }}"
                      />
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Expression Template (PromQL)</Text>
                      <Input.TextArea rows={2} value={rule.expr}
                        placeholder={'{{ .metric }} > {{ .threshold }}'}
                        onChange={e => updatePackRule(rule._id, 'expr', e.target.value)} />
                      {rule.expr && (
                        <div style={{
                          marginTop: 5, fontSize: 11.5, fontFamily: 'monospace',
                          background: '#f5f5f5', padding: '4px 8px', borderRadius: 4, color: '#595959',
                        }}>
                          {exprPreview}
                        </div>
                      )}
                    </div>

                    <div>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Description Template</Text>
                      <Input size="small" value={rule.description}
                        placeholder={'{{ .metric }} exceeded threshold on {{ $labels.instance }}'}
                        onChange={e => updatePackRule(rule._id, 'description', e.target.value)} />
                    </div>
                  </Card>
                )
              })}
            </Card>

            <Space>
              <Button type="primary" onClick={openSaveModal}
                disabled={!form.name.trim() || form.rules.every(r => !r.expr.trim())}>
                Save as Version...
              </Button>
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
              }}>
                YAML Preview
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
    </EditorLayout>
  )
}
