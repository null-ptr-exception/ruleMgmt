import { useState, useEffect } from 'react'
import {
  Modal, Steps, Button, Card, Radio, Space, Input, Alert,
  Table, Typography, Tag, Spin, Descriptions, Divider
} from 'antd'
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import jsYaml from 'js-yaml'
import { buildTree } from '../utils/treeGrouping'
import TemplateTree from './TemplateTree'
import { listPresets, importPreview, saveImport } from '../utils/chartApi'

const { Text, Title } = Typography
const { TextArea } = Input

// ─── Simple CSV parser ────────────────────────────────────────────────────────

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { headers: [], rows: [] }
  const headers = lines[0].split(',').map(h => h.trim())
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim())
    const row = {}
    headers.forEach((h, i) => {
      const val = vals[i] ?? ''
      row[h] = isNaN(val) || val === '' ? val : Number(val)
    })
    return row
  }).filter(r => Object.values(r).some(v => v !== ''))
  return { headers, rows }
}

function parseYamlRows(text) {
  const parsed = jsYaml.load(text)
  if (!Array.isArray(parsed)) throw new Error('YAML must be a list of objects')
  return parsed
}

// ─── Step 1 — Preset selection ────────────────────────────────────────────────

function StepSelectPreset({ presets, selected, onSelect }) {
  if (!presets.length) return <Spin tip="Loading presets..." />
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {presets.map(p => (
        <Card
          key={p.id}
          size="small"
          hoverable
          style={{ border: selected === p.id ? '2px solid #1677ff' : '1px solid #d9d9d9', cursor: 'pointer' }}
          onClick={() => onSelect(p.id)}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <Radio checked={selected === p.id} onChange={() => onSelect(p.id)} />
            <div style={{ flex: 1 }}>
              <Text strong>{p.name}</Text>
              {p.fixedAlert && <Tag color="red" style={{ marginLeft: 8 }}>Fixed Alert</Tag>}
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>{p.description}</Text>
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(p.vars || []).filter(v => v.xVarType === 'threshold').map(v => (
                  <Tag key={v.name} color={
                    v.xSeverity === 'critical' ? 'red' : v.xSeverity === 'warning' ? 'orange' : 'blue'
                  }>{v.xSeverity}</Tag>
                ))}
                <Text style={{ fontSize: 11, color: '#8c8c8c' }}>for: {p.forDuration}</Text>
              </div>
            </div>
          </div>
        </Card>
      ))}
    </Space>
  )
}

// ─── Step 2 — Table import ────────────────────────────────────────────────────

function StepImportTable({ rows, onRows, errors }) {
  const [mode, setMode] = useState('csv')
  const [raw, setRaw] = useState('')
  const [parseError, setParseError] = useState(null)

  function handleParse() {
    setParseError(null)
    try {
      const parsed = mode === 'csv' ? parseCsv(raw).rows : parseYamlRows(raw)
      onRows(parsed)
    } catch (e) {
      setParseError(e.message)
    }
  }

  const leafNames = [...new Set((rows || []).map(r => r.name).filter(Boolean))]
  const treeData = leafNames.length > 0 ? buildTree(leafNames) : []

  const tableColumns = rows.length > 0
    ? Object.keys(rows[0]).map(k => ({ title: k, dataIndex: k, key: k, render: v => String(v ?? '') }))
    : []

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Radio.Group value={mode} onChange={e => setMode(e.target.value)} style={{ marginBottom: 8 }}>
        <Radio.Button value="csv">CSV</Radio.Button>
        <Radio.Button value="yaml">YAML</Radio.Button>
      </Radio.Group>

      <TextArea
        rows={8}
        placeholder={mode === 'csv'
          ? 'name,cluster,app,warnThreshold,critThreshold\nkpi_cpu_saturation,staging,api-gw,0.7,0.9'
          : '- name: kpi_cpu_saturation\n  cluster: staging\n  app: api-gw\n  warnThreshold: 0.7\n  critThreshold: 0.9'
        }
        value={raw}
        onChange={e => setRaw(e.target.value)}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />

      <Button onClick={handleParse} type="default" size="small">Parse</Button>

      {parseError && <Alert type="error" message={parseError} />}
      {errors && errors.length > 0 && (
        <Alert type="warning" message={
          <ul style={{ margin: 0, paddingLeft: 20 }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        } />
      )}

      {rows.length > 0 && (
        <>
          <Divider style={{ margin: '12px 0' }} />
          <Text strong style={{ fontSize: 12 }}>Preview — {rows.length} rows, {leafNames.length} unique names</Text>
          <Table
            size="small"
            dataSource={rows.map((r, i) => ({ ...r, _key: i }))}
            columns={tableColumns}
            rowKey="_key"
            pagination={{ pageSize: 5 }}
            scroll={{ x: true }}
          />
          <Text strong style={{ fontSize: 12, marginTop: 8, display: 'block' }}>Tree structure</Text>
          <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 4, padding: 8, maxHeight: 200, overflowY: 'auto' }}>
            <TemplateTree templates={leafNames} activeTemplate={null} onSelect={() => {}} />
          </div>
        </>
      )}
    </Space>
  )
}

// ─── Step 3 — Leaf configuration ──────────────────────────────────────────────

const SEVERITY_COLOR = { info: 'blue', warning: 'orange', critical: 'red' }

function StepConfigLeaves({ preset, leafNames, leaves, onChange }) {
  const thresholdVars = (preset?.vars || []).filter(v => v.xVarType === 'threshold')
  const hasThresholdBase = (preset?.vars || []).some(v => v.xVarType === 'threshold-base')
  const tiers = preset?.tiers || []

  function setLeaf(name, field, value) {
    const next = leaves.map(l => l.name === name ? { ...l, [field]: value } : l)
    onChange(next)
  }

  function toggleTier(name, severity) {
    const leaf = leaves.find(l => l.name === name)
    const current = leaf?.overrideTiers || thresholdVars.map(v => v.xSeverity)
    const next = current.includes(severity)
      ? current.filter(s => s !== severity)
      : [...current, severity]
    setLeaf(name, 'overrideTiers', next.length === thresholdVars.length ? null : next)
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        For each alert leaf, define the metric expression. <code>METRIC_EXPR</code> in the preset template will be replaced with this value at import time.
      </Text>

      {hasThresholdBase && tiers.length > 0 && (
        <Alert type="info" showIcon message={
          <span>
            Tiers auto-derived from single <code>threshold</code> column:&nbsp;
            {tiers.map(t => (
              <Tag key={t.severity} color={SEVERITY_COLOR[t.severity] || 'default'}>
                {t.severity} = {t.ratio * 100}%
              </Tag>
            ))}
          </span>
        } />
      )}

      {leaves.map(leaf => {
        const activeTiers = leaf.overrideTiers || thresholdVars.map(v => v.xSeverity)
        const hasMetricExpr = leaf.metricExpr && leaf.metricExpr.trim()
        const clusterInExpr = hasMetricExpr && (leaf.metricExpr.includes('{cluster=') || leaf.metricExpr.includes('{app='))
        return (
          <Card key={leaf.name} size="small" title={<Text code>{leaf.name}</Text>}>
            <div style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: 600 }}>Metric Expression</Text>
              <Input
                placeholder={`e.g. rate(node_cpu_seconds_total{mode="user"}[1m])`}
                value={leaf.metricExpr || ''}
                onChange={e => setLeaf(leaf.name, 'metricExpr', e.target.value)}
                style={{ fontFamily: 'monospace', marginTop: 4 }}
                status={!hasMetricExpr ? 'error' : ''}
              />
              {!hasMetricExpr && <Text type="danger" style={{ fontSize: 11 }}>Required</Text>}
              {clusterInExpr && (
                <Alert type="warning" showIcon style={{ marginTop: 4, fontSize: 11 }}
                  message="Expression contains {cluster= or {app= — these are typically handled by selector variables, not hardcoded in the expression." />
              )}
            </div>

            {/* Tier toggle — only for explicit threshold vars (not threshold-base) */}
            {thresholdVars.length > 0 && !preset.fixedAlert && !hasThresholdBase && (
              <div>
                <Text style={{ fontSize: 12, fontWeight: 600 }}>Active Tiers</Text>
                <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                  {thresholdVars.map(v => (
                    <Tag
                      key={v.xSeverity}
                      color={activeTiers.includes(v.xSeverity) ? (SEVERITY_COLOR[v.xSeverity] || 'default') : 'default'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => toggleTier(leaf.name, v.xSeverity)}
                    >
                      {v.xSeverity}
                    </Tag>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )
      })}
    </Space>
  )
}

// ─── Step 4 — Preview ─────────────────────────────────────────────────────────

function StepPreview({ previewData, loading, error }) {
  if (loading) return <Spin tip="Generating preview..." />
  if (error) return <Alert type="error" message={error} />
  if (!previewData) return null

  const { stats, templatePreview } = previewData
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Descriptions size="small" bordered column={2}>
        <Descriptions.Item label="Leaves">{stats?.leaves ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Alert rules">{stats?.rules ?? 0}</Descriptions.Item>
      </Descriptions>
      <Text strong style={{ fontSize: 12 }}>Generated PrometheusRule Template</Text>
      <pre style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 4, padding: 12, maxHeight: 340, overflow: 'auto', fontSize: 11, margin: 0 }}>
        {templatePreview}
      </pre>
    </Space>
  )
}

// ─── Step 5 — Confirm & save ──────────────────────────────────────────────────

function StepConfirm({ deployment, onDeployment, stats }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="success" showIcon icon={<CheckCircleOutlined />}
        message={`Ready to import: ${stats?.leaves ?? 0} leaves, ${stats?.rules ?? 0} alert rules`} />
      <div>
        <Text style={{ fontSize: 12, fontWeight: 600 }}>Deployment name</Text>
        <Input
          placeholder="staging"
          value={deployment}
          onChange={e => onDeployment(e.target.value)}
          style={{ marginTop: 4 }}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          Values will be saved as <code>{deployment || 'default'}-values.yaml</code>
        </Text>
      </div>
    </Space>
  )
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

const STEPS = ['Select Preset', 'Import Table', 'Configure Leaves', 'Preview', 'Confirm & Save']

export default function ImportWizard({ open, chart, onClose, onImported }) {
  const [step, setStep] = useState(0)
  const [presets, setPresets] = useState([])
  const [selectedPreset, setSelectedPreset] = useState(null)
  const [rows, setRows] = useState([])
  const [tableErrors, setTableErrors] = useState([])
  const [leaves, setLeaves] = useState([])
  const [previewData, setPreviewData] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(null)
  const [deployment, setDeployment] = useState('staging')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) listPresets().then(setPresets)
  }, [open])

  // Sync leaves when rows or preset change
  useEffect(() => {
    if (!rows.length) return
    const uniqueNames = [...new Set(rows.map(r => r.name).filter(Boolean))]
    setLeaves(prev => {
      const prevMap = Object.fromEntries(prev.map(l => [l.name, l]))
      return uniqueNames.map(name => prevMap[name] || { name, metricExpr: '', overrideTiers: null })
    })
  }, [rows, selectedPreset])

  function validateStep2() {
    const errs = []
    if (rows.length === 0) { errs.push('No rows imported'); return errs }
    const names = rows.map(r => r.name).filter(Boolean)
    if (names.length === 0) errs.push('No "name" column found')

    const preset = presets.find(p => p.id === selectedPreset)
    const hasThresholdBase = preset?.vars?.some(v => v.xVarType === 'threshold-base')

    rows.forEach((r, i) => {
      if (!r.cluster) errs.push(`Row ${i + 1}: missing cluster`)
      if (!r.app) errs.push(`Row ${i + 1}: missing app`)
      if (hasThresholdBase && (r.threshold === undefined || r.threshold === '')) {
        errs.push(`Row ${i + 1}: missing threshold`)
      }
    })
    return errs
  }

  function validateStep3() {
    return leaves.filter(l => !l.metricExpr?.trim()).map(l => `Leaf "${l.name}" is missing metricExpr`)
  }

  async function handlePreview() {
    setPreviewLoading(true)
    setPreviewError(null)
    setPreviewData(null)
    try {
      const data = await importPreview({
        chart,
        deployment,
        presetId: selectedPreset,
        leaves,
        rows,
      })
      setPreviewData(data)
    } catch (e) {
      setPreviewError(e.message)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await saveImport({
        chart,
        deployment,
        presetId: selectedPreset,
        leaves,
        rows,
      })
      onImported?.()
      handleClose()
    } catch (e) {
      setPreviewError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function handleClose() {
    setStep(0)
    setSelectedPreset(null)
    setRows([])
    setTableErrors([])
    setLeaves([])
    setPreviewData(null)
    setPreviewError(null)
    setDeployment('staging')
    onClose()
  }

  function tryNext() {
    if (step === 1) {
      const errs = validateStep2()
      setTableErrors(errs)
      if (errs.length > 0) return
    }
    if (step === 2) {
      const errs = validateStep3()
      if (errs.length > 0) { setTableErrors(errs); return }
      setTableErrors([])
      handlePreview()
    }
    if (step === 3 && !previewData) return
    setStep(s => s + 1)
  }

  const canNext = (() => {
    if (step === 0) return !!selectedPreset
    if (step === 1) return rows.length > 0
    if (step === 2) return leaves.every(l => l.metricExpr?.trim())
    if (step === 3) return !!previewData && !previewLoading
    return true
  })()

  const preset = presets.find(p => p.id === selectedPreset)

  return (
    <Modal
      title="Import Wizard"
      open={open}
      onCancel={handleClose}
      width={680}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={handleClose}>Cancel</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && <Button onClick={() => setStep(s => s - 1)}>Back</Button>}
            {step < STEPS.length - 1 ? (
              <Button type="primary" disabled={!canNext} onClick={tryNext}>Next</Button>
            ) : (
              <Button type="primary" loading={saving} onClick={handleSave}>
                Import
              </Button>
            )}
          </div>
        </div>
      }
    >
      <Steps
        size="small"
        current={step}
        items={STEPS.map(t => ({ title: t }))}
        style={{ marginBottom: 24 }}
      />

      <div style={{ minHeight: 200 }}>
        {step === 0 && (
          <StepSelectPreset presets={presets} selected={selectedPreset} onSelect={setSelectedPreset} />
        )}
        {step === 1 && (
          <StepImportTable rows={rows} onRows={r => { setRows(r); setTableErrors([]) }} errors={tableErrors} />
        )}
        {step === 2 && (
          <StepConfigLeaves preset={preset} leafNames={[...new Set(rows.map(r => r.name).filter(Boolean))]} leaves={leaves} onChange={setLeaves} />
        )}
        {step === 3 && (
          <StepPreview previewData={previewData} loading={previewLoading} error={previewError} />
        )}
        {step === 4 && (
          <StepConfirm deployment={deployment} onDeployment={setDeployment} stats={previewData?.stats} />
        )}
      </div>
    </Modal>
  )
}
