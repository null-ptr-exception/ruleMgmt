import { useState, useEffect, useCallback } from 'react'
import { Card, Input, Button, Select, Table, Typography, Tag, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import EditorLayout from '../components/EditorLayout'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from '../utils/api'
import { bumpPatch } from '../utils/templateUtils'

const { Text } = Typography

const TYPE = 'system'

const emptyRuleGroup = () => ({ name: '', version: '' })
const emptyRoute     = () => ({ severity: 'critical', receiver: '' })
const SEVERITIES     = ['critical', 'warning', 'info', 'none']

const emptyForm = () => ({
  templateName: '',
  systemName:   '',
  ruleGroups:   [],
  routes:       [],
})

export default function SystemEditor() {
  const [templates, setTemplates] = useState({})
  const [suites, setSuites]       = useState({})
  const [receivers, setReceivers] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')

  const load = useCallback(async () => {
    const [sys, s, r] = await Promise.all([
      listTemplates(TYPE),
      listTemplates('alert-suite'),
      listTemplates('receivers'),
    ])
    setTemplates(sys)
    setSuites(s)
    setReceivers(r)
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const s = data.parsed?.system || {}
    let ruleGroups = []
    if (Array.isArray(s.ruleGroups)) {
      ruleGroups = s.ruleGroups.map(rg => ({ name: rg.name || '', version: rg.version || '' }))
    } else if (s.alertSuite) {
      ruleGroups = [{ name: s.alertSuite, version: s.alertSuiteVersion || '' }]
    }
    setForm({
      templateName: name,
      systemName:   s.name   || '',
      ruleGroups,
      routes: (s.routes || []).map(r => ({ severity: r.severity || 'critical', receiver: r.receiver || '' })),
    })
    setSelected({ name, version })
    setIsNew(false)
  }

  function startNew() { setForm(emptyForm()); setSelected(null); setIsNew(true) }

  const receiverNames = Object.keys(receivers)

  function addRuleGroup()     { setForm(f => ({ ...f, ruleGroups: [...f.ruleGroups, emptyRuleGroup()] })) }
  function removeRuleGroup(i) { setForm(f => ({ ...f, ruleGroups: f.ruleGroups.filter((_, idx) => idx !== i) })) }
  function updateRuleGroup(i, field, val) {
    setForm(f => ({ ...f, ruleGroups: f.ruleGroups.map((rg, idx) => idx === i ? { ...rg, [field]: val } : rg) }))
  }

  function addRoute()     { setForm(f => ({ ...f, routes: [...f.routes, emptyRoute()] })) }
  function removeRoute(i) { setForm(f => ({ ...f, routes: f.routes.filter((_, idx) => idx !== i) })) }
  function updateRoute(i, field, val) {
    setForm(f => ({ ...f, routes: f.routes.map((r, idx) => idx === i ? { ...r, [field]: val } : r) }))
  }

  function buildPayload() {
    return {
      system: {
        name:       form.systemName,
        ruleGroups: form.ruleGroups.filter(rg => rg.name).map(rg => ({ name: rg.name, version: rg.version })),
        routes:     form.routes.map(r => ({ severity: r.severity, receiver: r.receiver })),
      }
    }
  }

  async function handleSave(version) {
    setModal(null)
    const name = form.templateName.trim() || selected?.name || `system-${Date.now()}`
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() { setModal(selected ? bumpPatch(selected.version) : 'v1.0.0') }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  const showForm = isNew || selected

  const ruleGroupColumns = [
    {
      title: 'Rule Group',
      dataIndex: 'name',
      render: (_, rg, i) => (
        <Select
          size="small"
          value={rg.name || undefined}
          onChange={val => updateRuleGroup(i, 'name', val)}
          placeholder="— select rule group —"
          style={{ width: '100%' }}
          options={Object.keys(suites).map(n => ({ value: n, label: n }))}
        />
      ),
    },
    {
      title: 'Version',
      dataIndex: 'version',
      width: 160,
      render: (_, rg, i) => (
        <Select
          size="small"
          value={rg.version || undefined}
          onChange={val => updateRuleGroup(i, 'version', val)}
          placeholder="— version —"
          style={{ width: '100%' }}
          options={(suites[rg.name] || []).map(v => ({ value: v, label: v }))}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 40,
      render: (_, _rg, i) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => removeRuleGroup(i)} />
      ),
    },
  ]

  const routeColumns = [
    {
      title: 'Severity',
      dataIndex: 'severity',
      width: 140,
      render: (_, route, i) => (
        <Select
          size="small"
          value={route.severity}
          onChange={val => updateRoute(i, 'severity', val)}
          style={{ width: '100%' }}
          options={SEVERITIES.map(s => ({ value: s, label: s }))}
        />
      ),
    },
    {
      title: 'Receiver',
      dataIndex: 'receiver',
      render: (_, route, i) => (
        <Input
          size="small"
          value={route.receiver}
          placeholder="receiver name"
          onChange={e => updateRoute(i, 'receiver', e.target.value)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 40,
      render: (_, _route, i) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => removeRoute(i)} />
      ),
    },
  ]

  return (
    <EditorLayout
      title="System"
      templates={templates}
      selected={selected}
      onSelect={selectVersion}
      onNew={startNew}
      emptyIcon="🔧"
      emptyText="Select a system template or click + New."
    >
      {showForm && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Text strong style={{ fontSize: 15 }}>
                {selected ? `${selected.name} @ ${selected.version}` : 'New System'}
              </Text>
              {status && <Tag color="success">{status}</Tag>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Template Name *</Text>
                <Input
                  value={form.templateName}
                  placeholder="e.g. mysql-system"
                  readOnly={!isNew && !!selected}
                  style={!isNew && selected ? { background: '#fafafa', color: '#8c8c8c' } : {}}
                  onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))}
                />
              </div>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Config Name</Text>
                <Input
                  value={form.systemName}
                  placeholder="AlertmanagerConfig metadata.name"
                  onChange={e => setForm(f => ({ ...f, systemName: e.target.value }))}
                />
              </div>
            </div>
          </Card>

          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Text strong>Rule Groups</Text>
              <Button size="small" icon={<PlusOutlined />} onClick={addRuleGroup}>Add</Button>
            </div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 10, fontSize: 12 }}>
              Each rule group becomes a Helm subchart dependency → generates a PrometheusRule.
            </Text>
            <Table
              columns={ruleGroupColumns}
              dataSource={form.ruleGroups.map((rg, i) => ({ ...rg, key: i }))}
              pagination={false}
              size="small"
              bordered
              locale={{ emptyText: 'No rule groups added.' }}
            />
          </Card>

          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Text strong>Severity → Receiver Routes</Text>
              <Button size="small" icon={<PlusOutlined />} onClick={addRoute}>Add</Button>
            </div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 10, fontSize: 12 }}>
              Routes in the AlertmanagerConfig. Receiver names get the product prefix on render.
            </Text>
            <Table
              columns={routeColumns}
              dataSource={form.routes.map((r, i) => ({ ...r, key: i }))}
              pagination={false}
              size="small"
              bordered
              locale={{ emptyText: 'No routes configured.' }}
            />
          </Card>

          <Space>
            <Button type="primary" onClick={openSaveModal}>Save as Version…</Button>
            {selected && <Button danger onClick={handleDelete}>Delete this version</Button>}
          </Space>
        </div>
      )}

      {modal && <VersionModal defaultVersion={modal} onSave={handleSave} onCancel={() => setModal(null)} />}
    </EditorLayout>
  )
}
