import { useState, useEffect, useCallback } from 'react'
import { Button, Select, Input, Switch, Empty, Typography, Modal, Tag, Table } from 'antd'
import {
  PlusOutlined, DeleteOutlined, SaveOutlined,
  EyeOutlined, GlobalOutlined
} from '@ant-design/icons'
import { listZones, createZone, deleteZone, getZone, saveZoneValues, saveZoneBindings, renderZoneBinding } from '../utils/zoneApi'
import { listCharts } from '../utils/chartApi'
import { listDeployments } from '../utils/chartApi'

const { Text, Title } = Typography

const ZONE_TYPES = [
  { value: 'prometheus',       label: 'Prometheus' },
  { value: 'victoriametrics',  label: 'VictoriaMetrics' },
]

// ── helpers ──────────────────────────────────────────────────────────────────

function KVEditor({ value = {}, onChange }) {
  const entries = Object.entries(value)
  function updateKey(oldKey, newKey) {
    const next = {}
    for (const [k, v] of Object.entries(value)) next[k === oldKey ? newKey : k] = v
    onChange(next)
  }
  function updateVal(key, val) { onChange({ ...value, [key]: val }) }
  function addRow()            { onChange({ ...value, '': '' }) }
  function removeRow(key)      { const next = { ...value }; delete next[key]; onChange(next) }

  return (
    <div>
      {entries.length === 0 && (
        <Text type="secondary" style={{ fontSize: 12 }}>No values defined. Add global selector values (e.g. cluster, group).</Text>
      )}
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <Input size="small" value={k} placeholder="key"
            onChange={e => updateKey(k, e.target.value)}
            style={{ width: 140, fontFamily: 'monospace' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>:</Text>
          <Input size="small" value={v} placeholder="value"
            onChange={e => updateVal(k, e.target.value)}
            style={{ flex: 1, fontFamily: 'monospace' }} />
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeRow(k)} />
        </div>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addRow} style={{ marginTop: 4 }}>
        Add key
      </Button>
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export default function ZoneManager() {
  const [zones, setZones]               = useState([])
  const [activeZone, setActiveZone]     = useState(null)
  const [zoneData, setZoneData]         = useState(null)   // { meta, values, bindings }
  const [zoneValues, setZoneValues]     = useState({})
  const [bindings, setBindings]         = useState([])
  const [valuesDirty, setValuesDirty]   = useState(false)
  const [sidebarWidth]                  = useState(220)

  // Create zone modal
  const [createOpen, setCreateOpen]     = useState(false)
  const [newZoneName, setNewZoneName]   = useState('')
  const [newZoneType, setNewZoneType]   = useState('prometheus')
  const [creating, setCreating]         = useState(false)

  // Add-binding modal
  const [addBindOpen, setAddBindOpen]   = useState(false)
  const [charts, setCharts]             = useState([])
  const [bindChart, setBindChart]       = useState(null)
  const [deployments, setDeployments]   = useState([])
  const [bindDeployment, setBindDeployment] = useState(null)

  // Preview modal
  const [previewOpen, setPreviewOpen]   = useState(false)
  const [previewYaml, setPreviewYaml]   = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)

  // ── load ────────────────────────────────────────────────────────────────

  const loadZones = useCallback(async () => {
    setZones(await listZones())
  }, [])

  useEffect(() => { loadZones() }, [loadZones])

  useEffect(() => {
    if (!activeZone) { setZoneData(null); return }
    getZone(activeZone).then(data => {
      setZoneData(data)
      setZoneValues(data.values || {})
      setBindings(data.bindings || [])
      setValuesDirty(false)
    })
  }, [activeZone])

  // ── zone actions ─────────────────────────────────────────────────────────

  function handleAddZone() {
    setNewZoneName('')
    setNewZoneType('prometheus')
    setCreateOpen(true)
  }

  async function confirmCreateZone() {
    const trimmed = newZoneName.trim()
    if (!trimmed) return
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
      alert('Name must match ^[a-z0-9][a-z0-9_-]*$')
      return
    }
    setCreating(true)
    try {
      await createZone(trimmed, newZoneType)
      await loadZones()
      setActiveZone(trimmed)
      setCreateOpen(false)
    } catch (err) {
      alert(err.message)
    } finally {
      setCreating(false)
    }
  }

  function handleDeleteZone() {
    if (!activeZone) return
    Modal.confirm({
      title: `Delete zone "${activeZone}"?`,
      content: 'This will remove the zone directory and all its bindings.',
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        await deleteZone(activeZone)
        setActiveZone(null)
        await loadZones()
      }
    })
  }

  // ── values actions ────────────────────────────────────────────────────────

  async function handleSaveValues() {
    if (!activeZone) return
    await saveZoneValues(activeZone, zoneValues)
    setValuesDirty(false)
  }

  // ── binding actions ───────────────────────────────────────────────────────

  async function openAddBinding() {
    const allCharts = await listCharts()
    setCharts(allCharts)
    setBindChart(null)
    setBindDeployment(null)
    setDeployments([])
    setAddBindOpen(true)
  }

  useEffect(() => {
    if (!bindChart) { setDeployments([]); setBindDeployment(null); return }
    listDeployments(bindChart).then(deps => {
      setDeployments(deps)
      setBindDeployment(deps[0]?.name || null)
    })
  }, [bindChart])

  async function confirmAddBinding() {
    if (!bindChart || !bindDeployment) return
    const already = bindings.some(b => b.chart === bindChart && b.deployment === bindDeployment)
    if (already) { alert('This chart+deployment is already bound to this zone.'); return }
    const next = [...bindings, { chart: bindChart, deployment: bindDeployment, enabled: true }]
    setBindings(next)
    await saveZoneBindings(activeZone, next)
    setAddBindOpen(false)
  }

  async function toggleBinding(idx) {
    const next = bindings.map((b, i) => i === idx ? { ...b, enabled: !b.enabled } : b)
    setBindings(next)
    await saveZoneBindings(activeZone, next)
  }

  async function removeBinding(idx) {
    const next = bindings.filter((_, i) => i !== idx)
    setBindings(next)
    await saveZoneBindings(activeZone, next)
  }

  async function handlePreview(binding) {
    setPreviewLoading(true)
    setPreviewYaml('')
    setPreviewOpen(true)
    const result = await renderZoneBinding(activeZone, binding.chart, binding.deployment)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewLoading(false)
  }

  // ── binding table columns ─────────────────────────────────────────────────

  const bindingColumns = [
    { title: 'Template (chart)', dataIndex: 'chart', key: 'chart',
      render: v => <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{v}</Text> },
    { title: 'Alert Config (deployment)', dataIndex: 'deployment', key: 'deployment',
      render: v => <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{v}</Text> },
    { title: 'Enabled', key: 'enabled', width: 80,
      render: (_, __, idx) => (
        <Switch size="small" checked={bindings[idx]?.enabled}
          onChange={() => toggleBinding(idx)} />
      ) },
    { title: '', key: 'actions', width: 120,
      render: (_, row, idx) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreview(row)}>Preview</Button>
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeBinding(idx)} />
        </div>
      ) },
  ]

  // ── render ────────────────────────────────────────────────────────────────

  const meta = zoneData?.meta

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>

      {/* Left sidebar — zone list */}
      <div style={{ width: sidebarWidth, flexShrink: 0, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', background: '#fff' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Zones</Text>
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={handleAddZone} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {zones.length === 0 && (
            <Text type="secondary" style={{ fontSize: 12, padding: '12px 16px', display: 'block' }}>
              No zones yet. Click + to create one.
            </Text>
          )}
          {zones.map(z => (
            <div
              key={z.name}
              onClick={() => setActiveZone(z.name)}
              style={{
                padding: '8px 14px', cursor: 'pointer', borderBottom: '1px solid #f5f5f5',
                background: activeZone === z.name ? '#e6f4ff' : 'transparent',
                borderLeft: activeZone === z.name ? '3px solid #1677ff' : '3px solid transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <GlobalOutlined style={{ fontSize: 12, color: '#8c8c8c' }} />
                <Text style={{ fontSize: 13, fontWeight: activeZone === z.name ? 600 : 400 }}>{z.name}</Text>
              </div>
              <Tag style={{ fontSize: 10, marginTop: 2 }}>{z.type}</Tag>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
        {activeZone && zoneData ? (
          <>
            {/* Zone header */}
            <div style={{ padding: '16px 24px', borderBottom: '1px solid #f0f0f0', background: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
              <Title level={4} style={{ margin: 0 }}>{activeZone}</Title>
              <Tag>{meta?.type || 'prometheus'}</Tag>
              <div style={{ marginLeft: 'auto' }}>
                <Button danger icon={<DeleteOutlined />} size="small" onClick={handleDeleteZone}>Delete Zone</Button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

              {/* Global Selector Values */}
              <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <Text strong style={{ fontSize: 14 }}>Global Selector Values</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>— 哪種運動（Zone scope）</Text>
                  {valuesDirty && (
                    <Button size="small" type="primary" icon={<SaveOutlined />}
                      onClick={handleSaveValues} style={{ marginLeft: 'auto' }}>
                      Save Values
                    </Button>
                  )}
                </div>
                <KVEditor
                  value={zoneValues}
                  onChange={v => { setZoneValues(v); setValuesDirty(true) }}
                />
                {Object.keys(zoneValues).length > 0 && (
                  <div style={{ marginTop: 12, padding: '8px 12px', background: '#f6ffed', borderRadius: 4, border: '1px solid #b7eb8f' }}>
                    <Text style={{ fontSize: 11, color: '#52c41a' }}>
                      Stored in <code>zones/{activeZone}/zone-values.yaml</code> — passed as <code>-f zone-values.yaml</code> during render
                    </Text>
                  </div>
                )}
              </div>

              {/* Bindings */}
              <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: '16px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <Text strong style={{ fontSize: 14 }}>Alert Bindings</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>— 骨架 + 肉 套用到此 Zone</Text>
                  <Button size="small" icon={<PlusOutlined />} onClick={openAddBinding} style={{ marginLeft: 'auto' }}>
                    Add Binding
                  </Button>
                </div>
                {bindings.length === 0
                  ? <Text type="secondary" style={{ fontSize: 12 }}>No bindings yet. Add a chart+deployment to this zone.</Text>
                  : <Table
                      size="small"
                      dataSource={bindings.map((b, i) => ({ ...b, key: i }))}
                      columns={bindingColumns}
                      pagination={false}
                    />
                }
              </div>
            </div>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }} description="Select a zone or create a new one" />
        )}
      </div>

      {/* Create Zone Modal */}
      <Modal
        title="Create New Zone"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={confirmCreateZone}
        okText="Create"
        okButtonProps={{ loading: creating, disabled: !newZoneName.trim() }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Zone Name</Text>
            <Input
              placeholder="e.g. prod-cluster, staging-vm"
              value={newZoneName}
              onChange={e => setNewZoneName(e.target.value)}
              onPressEnter={confirmCreateZone}
              autoFocus
            />
            <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
              Lowercase, a–z, 0–9, hyphens and underscores only
            </Text>
          </div>
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Type</Text>
            <Select
              value={newZoneType}
              onChange={setNewZoneType}
              style={{ width: '100%' }}
              options={ZONE_TYPES}
            />
          </div>
        </div>
      </Modal>

      {/* Add Binding Modal */}
      <Modal
        title="Add Alert Binding"
        open={addBindOpen}
        onCancel={() => setAddBindOpen(false)}
        onOk={confirmAddBinding}
        okText="Add"
        okButtonProps={{ disabled: !bindChart || !bindDeployment }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Template (chart — 骨架)</Text>
            <Select
              placeholder="Select chart"
              style={{ width: '100%' }}
              value={bindChart}
              onChange={v => { setBindChart(v); setBindDeployment(null) }}
              options={charts.map(c => ({ value: c.name, label: c.name }))}
            />
          </div>
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Alert Config (deployment — 肉)</Text>
            <Select
              placeholder={bindChart ? 'Select deployment' : 'Select chart first'}
              style={{ width: '100%' }}
              value={bindDeployment}
              onChange={setBindDeployment}
              disabled={!bindChart || deployments.length === 0}
              options={deployments.map(d => ({ value: d.name, label: `${d.name} (${d.alertCount} alerts)` }))}
            />
          </div>
        </div>
      </Modal>

      {/* Preview Modal */}
      <Modal
        title={`Rendered PrometheusRule — ${previewLoading ? 'rendering…' : activeZone}`}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width={860}
      >
        {previewLoading
          ? <div style={{ textAlign: 'center', padding: 40 }}><Text type="secondary">Running helm template…</Text></div>
          : <pre style={{
              background: '#0f172a', color: '#7dd3fc', padding: 16, borderRadius: 8,
              fontSize: 12, fontFamily: 'monospace', maxHeight: 520, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all'
            }}>
              {previewYaml || 'No output'}
            </pre>
        }
      </Modal>
    </div>
  )
}
