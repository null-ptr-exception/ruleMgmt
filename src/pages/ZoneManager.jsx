import {
  useState, useEffect, useCallback, useMemo,
  useRef, forwardRef, useImperativeHandle,
} from 'react'
import {
  Button, Select, Input, Switch, Empty, Typography,
  Modal, Table, Tag, Spin, Space,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined,
  EyeOutlined, GlobalOutlined, SearchOutlined,
} from '@ant-design/icons'
import { listZones, createZone, deleteZone, getZone, saveZoneBindings, renderZoneBinding } from '../utils/zoneApi'
import { listCharts, getChartInfo, listDeployments } from '../utils/chartApi'

const { Text, Title } = Typography

// ── GsEditor ──────────────────────────────────────────────────────────────────
// Fully self-contained KV row editor. Parent reads current rows via ref.
// seedKeys: string[] — pre-fills key names (from schema x-global-selectors)
const GsEditor = forwardRef(function GsEditor({ seedKeys = [] }, ref) {
  const [rows, setRows] = useState(() => seedKeys.map(k => ({ key: k, value: '' })))

  // Re-seed when seedKeys content changes (chart changed)
  const prevSeed = useRef(seedKeys.join('\x00'))
  useEffect(() => {
    const s = seedKeys.join('\x00')
    if (prevSeed.current !== s) {
      prevSeed.current = s
      setRows(seedKeys.map(k => ({ key: k, value: '' })))
    }
  }, [seedKeys])

  useImperativeHandle(ref, () => ({ getRows: () => rows }), [rows])

  const updateKey = (idx, key) =>
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, key } : r))

  const updateVal = (idx, val) =>
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, value: val } : r))

  const addRow = () =>
    setRows(prev => [...prev, { key: '', value: '' }])

  const removeRow = (idx) =>
    setRows(prev => prev.filter((_, i) => i !== idx))

  return (
    <div>
      {rows.length === 0 && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          No selectors. Click "Add" to scope this binding.
        </Text>
      )}
      {rows.map((r, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <Input
            size="small"
            placeholder="key"
            value={r.key}
            onChange={e => updateKey(idx, e.target.value)}
            style={{ width: 130, fontFamily: 'monospace' }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>=</Text>
          <Input
            size="small"
            placeholder="value"
            value={r.value}
            onChange={e => updateVal(idx, e.target.value)}
            style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeRow(idx)} />
        </div>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addRow} style={{ marginTop: 2 }}>
        Add
      </Button>
    </div>
  )
})

// ── main component ────────────────────────────────────────────────────────────

export default function ZoneManager() {
  const [zones, setZones]               = useState([])
  const [activeZone, setActiveZone]     = useState(null)
  const [zoneData, setZoneData]         = useState(null)
  const [bindings, setBindings]         = useState([])
  const [sidebarWidth]                  = useState(220)

  // Chart version cache: { chartName → version string }
  const [chartVersions, setChartVersions]   = useState({})
  const fetchedChartsRef                    = useRef(new Set())

  // Table filter state
  const [filterText, setFilterText]     = useState('')
  const [filterEnabled, setFilterEnabled] = useState(false)

  // Create zone modal
  const [createOpen, setCreateOpen]     = useState(false)
  const [newZoneName, setNewZoneName]   = useState('')
  const [creating, setCreating]         = useState(false)

  // Add-binding modal
  const [addBindOpen, setAddBindOpen]   = useState(false)
  const [charts, setCharts]             = useState([])
  const [bindChart, setBindChart]       = useState(null)
  const [bindChartGsKeys, setBindChartGsKeys] = useState([])
  const [deployments, setDeployments]   = useState([])
  const [bindDeployment, setBindDeployment] = useState(null)
  const [loadingChartGs, setLoadingChartGs] = useState(false)
  const gsEditorRef                     = useRef(null)

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
      setBindings(data.bindings || [])
      setFilterText('')
      setFilterEnabled(false)
    })
  }, [activeZone])

  // ── lazily fetch chart versions for every unique chart in bindings ─────────
  useEffect(() => {
    const unique = [...new Set(bindings.map(b => b.chart).filter(Boolean))]
    unique.forEach(chart => {
      if (fetchedChartsRef.current.has(chart)) return
      fetchedChartsRef.current.add(chart)
      getChartInfo(chart)
        .then(info => {
          const v = info?.chartMeta?.version
          if (v) setChartVersions(prev => ({ ...prev, [chart]: v }))
        })
        .catch(() => {})
    })
  }, [bindings])

  // ── zone actions ─────────────────────────────────────────────────────────

  function handleAddZone() {
    setNewZoneName('')
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
      await createZone(trimmed)
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

  // ── binding actions ───────────────────────────────────────────────────────

  async function openAddBinding() {
    const allCharts = await listCharts()
    setCharts(allCharts)
    setBindChart(null)
    setBindChartGsKeys([])
    setBindDeployment(null)
    setDeployments([])
    setAddBindOpen(true)
  }

  // When chart changes: load schema gs keys + deployments
  useEffect(() => {
    if (!bindChart) {
      setBindChartGsKeys([])
      setDeployments([])
      setBindDeployment(null)
      return
    }
    setLoadingChartGs(true)
    Promise.all([
      getChartInfo(bindChart).catch(() => null),
      listDeployments(bindChart).catch(() => []),
    ]).then(([chartInfo, deps]) => {
      const gsKeys = (chartInfo?.schema?.['x-global-selectors'] || []).filter(k => k.trim())
      setBindChartGsKeys(gsKeys)
      setDeployments(deps)
      setBindDeployment(deps[0]?.name || null)
    }).finally(() => setLoadingChartGs(false))
  }, [bindChart])

  async function confirmAddBinding() {
    if (!bindChart || !bindDeployment) return
    const gsRows = gsEditorRef.current?.getRows() || []
    const globalSelectors = Object.fromEntries(
      gsRows.filter(r => r.key.trim()).map(r => [r.key.trim(), r.value])
    )
    const next = [...bindings, { chart: bindChart, deployment: bindDeployment, globalSelectors, enabled: true }]
    setBindings(next)
    await saveZoneBindings(activeZone, next)
    setAddBindOpen(false)
  }

  async function toggleBinding(origIdx) {
    const next = bindings.map((b, i) => i === origIdx ? { ...b, enabled: !b.enabled } : b)
    setBindings(next)
    await saveZoneBindings(activeZone, next)
  }

  async function removeBinding(origIdx) {
    const next = bindings.filter((_, i) => i !== origIdx)
    setBindings(next)
    await saveZoneBindings(activeZone, next)
  }

  async function handlePreview(binding) {
    setPreviewLoading(true)
    setPreviewYaml('')
    setPreviewOpen(true)
    const result = await renderZoneBinding(
      activeZone,
      binding.chart,
      binding.deployment,
      binding.globalSelectors || {}
    )
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewLoading(false)
  }

  // ── filtering ─────────────────────────────────────────────────────────────

  // Each filtered row carries its original index so toggle/remove are correct
  const filteredRows = useMemo(() => {
    return bindings
      .map((b, origIdx) => ({ ...b, origIdx }))
      .filter(b => {
        if (filterEnabled && !b.enabled) return false
        if (!filterText.trim()) return true
        const q = filterText.trim().toLowerCase()
        if (b.chart?.toLowerCase().includes(q)) return true
        if (b.deployment?.toLowerCase().includes(q)) return true
        return Object.entries(b.globalSelectors || {}).some(
          ([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q)
        )
      })
  }, [bindings, filterText, filterEnabled])

  // ── binding table columns ─────────────────────────────────────────────────

  const bindingColumns = [
    {
      title: 'Template',
      dataIndex: 'chart',
      key: 'chart',
      render: v => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{v}</Text>
          {chartVersions[v] && (
            <Tag color="geekblue" style={{ fontSize: 10, padding: '0 4px', lineHeight: '16px' }}>
              v{chartVersions[v]}
            </Tag>
          )}
        </span>
      )
    },
    {
      title: 'Global Selectors',
      key: 'globalSelectors',
      render: (_, row) => {
        const gs = row.globalSelectors || {}
        const entries = Object.entries(gs).filter(([k]) => k)
        if (entries.length === 0)
          return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {entries.map(([k, v]) => (
              <Tag key={k} color="blue" style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {k}{v !== '' ? `=${v}` : ''}
              </Tag>
            ))}
          </div>
        )
      }
    },
    {
      title: 'Alert Config',
      dataIndex: 'deployment',
      key: 'deployment',
      render: v => <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{v}</Text>
    },
    {
      title: 'Enabled',
      key: 'enabled',
      width: 80,
      render: (_, row) => (
        <Switch size="small" checked={row.enabled}
          onChange={() => toggleBinding(row.origIdx)} />
      )
    },
    {
      title: '',
      key: 'actions',
      width: 130,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreview(row)}>Preview</Button>
          <Button size="small" type="text" danger icon={<DeleteOutlined />}
            onClick={() => removeBinding(row.origIdx)} />
        </div>
      )
    },
  ]

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>

      {/* Left sidebar */}
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
              <div style={{ marginLeft: 'auto' }}>
                <Button danger icon={<DeleteOutlined />} size="small" onClick={handleDeleteZone}>Delete Zone</Button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
              <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: '16px 20px' }}>

                {/* Title row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Text strong style={{ fontSize: 14 }}>Alert Bindings</Text>
                  {bindings.length > 0 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {filteredRows.length !== bindings.length
                        ? `${filteredRows.length} / ${bindings.length}`
                        : bindings.length}
                    </Text>
                  )}
                  <Button size="small" icon={<PlusOutlined />} onClick={openAddBinding} style={{ marginLeft: 'auto' }}>
                    Add Binding
                  </Button>
                </div>

                {/* Filter bar */}
                {bindings.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                    <Input
                      allowClear
                      size="small"
                      prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                      placeholder="Filter by template, selector, alert config…"
                      value={filterText}
                      onChange={e => setFilterText(e.target.value)}
                      style={{ maxWidth: 340 }}
                    />
                    <Space size={6}>
                      <Switch size="small" checked={filterEnabled} onChange={setFilterEnabled} />
                      <Text style={{ fontSize: 12 }}>Enabled only</Text>
                    </Space>
                  </div>
                )}

                {bindings.length === 0
                  ? <Text type="secondary" style={{ fontSize: 12 }}>No bindings yet. Add a template + alert config to this zone.</Text>
                  : filteredRows.length === 0
                    ? <Text type="secondary" style={{ fontSize: 12 }}>No bindings match the current filter.</Text>
                    : <Table
                        size="small"
                        dataSource={filteredRows.map(b => ({ ...b, key: b.origIdx }))}
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

      {/* ── Create Zone Modal ─────────────────────────────────────────────── */}
      <Modal
        title="Create New Zone"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={confirmCreateZone}
        okText="Create"
        okButtonProps={{ loading: creating, disabled: !newZoneName.trim() }}
      >
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
      </Modal>

      {/* ── Add Binding Modal ─────────────────────────────────────────────── */}
      <Modal
        title="Add Alert Binding"
        open={addBindOpen}
        onCancel={() => setAddBindOpen(false)}
        onOk={confirmAddBinding}
        okText="Add"
        okButtonProps={{ disabled: !bindChart || !bindDeployment }}
        width={520}
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 4 }}>

          {/* Template */}
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Template</Text>
            <Select
              placeholder="Select template"
              style={{ width: '100%' }}
              value={bindChart}
              onChange={v => { setBindChart(v); setBindDeployment(null) }}
              options={charts.map(c => ({ value: c.name, label: c.name }))}
            />
          </div>

          {/* Global Selectors — always shown once chart is picked */}
          {bindChart && (
            <div>
              <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>
                Global Selectors
                <Text type="secondary" style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}>
                  — scope this binding within the zone
                </Text>
              </Text>
              {loadingChartGs
                ? <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Spin size="small" />
                    <Text type="secondary" style={{ fontSize: 12 }}>Loading…</Text>
                  </div>
                : <GsEditor ref={gsEditorRef} seedKeys={bindChartGsKeys} />
              }
            </div>
          )}

          {/* Alert Config */}
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Alert Config</Text>
            <Select
              placeholder={bindChart ? 'Select alert config' : 'Select template first'}
              style={{ width: '100%' }}
              value={bindDeployment}
              onChange={setBindDeployment}
              disabled={!bindChart || deployments.length === 0}
              options={deployments.map(d => ({ value: d.name, label: `${d.name} (${d.alertCount} alerts)` }))}
            />
          </div>

        </div>
      </Modal>

      {/* ── Preview Modal ─────────────────────────────────────────────────── */}
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
