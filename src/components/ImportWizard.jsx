import { useState, useRef } from 'react'
import {
  Modal, Steps, Button, Space, Input, Alert,
  Table, Typography, Tag, Spin, Descriptions, Divider, Upload
} from 'antd'
import { UploadOutlined, CheckCircleOutlined } from '@ant-design/icons'
import jsYaml from 'js-yaml'
import { parseTemplate, importPreview, saveImport } from '../utils/chartApi'

const { Text } = Typography
const { TextArea } = Input

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim())
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim())
    const row = {}
    headers.forEach((h, i) => {
      const v = vals[i] ?? ''
      row[h] = v === '' ? undefined : (isNaN(v) ? v : Number(v))
    })
    return row
  }).filter(r => Object.values(r).some(v => v !== undefined))
}

function parseDataFile(text, ext) {
  if (ext === 'yaml' || ext === 'yml') {
    const parsed = jsYaml.load(text)
    if (!Array.isArray(parsed)) throw new Error('YAML must be a list of objects')
    return parsed
  }
  return parseCsv(text)
}

// ─── File upload helper ───────────────────────────────────────────────────────

function FileOrPaste({ value, onChange, placeholder, accept = '.yaml,.yml,.csv' }) {
  const fileRef = useRef(null)

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => onChange(ev.target.result, file.name.split('.').pop().toLowerCase())
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <Button size="small" icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>
          Upload file
        </Button>
        <Text type="secondary" style={{ fontSize: 11, lineHeight: '24px' }}>or paste below</Text>
        <input ref={fileRef} type="file" accept={accept} style={{ display: 'none' }} onChange={handleFile} />
      </div>
      <TextArea
        rows={10}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value, null)}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
    </div>
  )
}

// ─── Step 1 — Template YAML ───────────────────────────────────────────────────

const TEMPLATE_PLACEHOLDER = `preset: single-threshold-3tier
threshold: 0.9          # global default

tree:
  kpi:
    threshold: 0.85     # overrides for kpi subtree
    children:
      cpu_saturation:
        metricExpr: rate(node_cpu_seconds_total{mode="user"}[1m])
      mem_saturation:
        metricExpr: node_memory_MemUsed_bytes / node_memory_MemTotal_bytes
        threshold: 0.95 # leaf-level override
  svc:
    preset: absence-check
    children:
      isalive:
        metricExpr: up`

const SEVERITY_COLOR = { info: 'blue', warning: 'orange', critical: 'red' }

function StepTemplate({ raw, onChange, leafDefs, errors, loading, onParse }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <FileOrPaste
        value={raw}
        onChange={(text) => onChange(text)}
        placeholder={TEMPLATE_PLACEHOLDER}
        accept=".yaml,.yml"
      />
      <Button onClick={onParse} type="primary" size="small" loading={loading} disabled={!raw.trim()}>
        Parse template
      </Button>

      {errors?.length > 0 && (
        <Alert type="error" message={
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        } />
      )}

      {leafDefs && Object.keys(leafDefs).length > 0 && (
        <>
          <Divider style={{ margin: '10px 0' }} />
          <Text strong style={{ fontSize: 12 }}>
            {Object.keys(leafDefs).length} leaf nodes found
          </Text>
          <Table
            size="small"
            dataSource={Object.entries(leafDefs).map(([name, def]) => ({ key: name, name, ...def }))}
            columns={[
              { title: 'Leaf', dataIndex: 'name', key: 'name', render: v => <Text code style={{ fontSize: 11 }}>{v}</Text> },
              { title: 'Preset', dataIndex: 'preset', key: 'preset', render: v => <Tag>{v}</Tag> },
              { title: 'Threshold', dataIndex: 'threshold', key: 'threshold', render: v => v ?? <Text type="secondary">—</Text> },
              { title: 'metricExpr', dataIndex: 'metricExpr', key: 'metricExpr',
                render: v => <Text style={{ fontFamily: 'monospace', fontSize: 11 }}>{v}</Text> },
            ]}
            pagination={false}
          />
        </>
      )}
    </Space>
  )
}

// ─── Step 2 — Alert data ──────────────────────────────────────────────────────

const DATA_PLACEHOLDER_CSV = `name,cluster,app,threshold
kpi_cpu_saturation,staging,api-gateway,
kpi_cpu_saturation,staging,worker,0.75
kpi_mem_saturation,staging,api-gateway,
svc_isalive,staging,api-gateway,`

const DATA_PLACEHOLDER_YAML = `- name: kpi_cpu_saturation
  cluster: staging
  app: api-gateway
- name: kpi_cpu_saturation
  cluster: staging
  app: worker
  threshold: 0.75
- name: svc_isalive
  cluster: staging
  app: api-gateway`

function StepData({ raw, onChange, rows, errors, leafDefs, onParse }) {
  const [ext, setExt] = useState('csv')

  function handleChange(text, fileExt) {
    if (fileExt) setExt(fileExt)
    onChange(text)
  }

  const leafNames = leafDefs ? new Set(Object.keys(leafDefs)) : null
  const unknownLeaves = leafNames
    ? [...new Set((rows || []).map(r => r.name).filter(n => n && !leafNames.has(n)))]
    : []

  const tableColumns = (rows || []).length > 0
    ? Object.keys(rows[0]).map(k => ({
        title: k, dataIndex: k, key: k,
        render: v => v === undefined ? <Text type="secondary">—</Text> : String(v)
      }))
    : []

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <FileOrPaste
        value={raw}
        onChange={handleChange}
        placeholder={ext === 'yaml' || ext === 'yml' ? DATA_PLACEHOLDER_YAML : DATA_PLACEHOLDER_CSV}
        accept=".yaml,.yml,.csv"
      />
      <Button onClick={() => { try { onParse(raw, ext) } catch(e) { onParse(raw, 'csv') } }}
        type="primary" size="small" disabled={!raw.trim()}>
        Parse data
      </Button>

      {errors?.length > 0 && (
        <Alert type="error" message={
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        } />
      )}

      {unknownLeaves.length > 0 && (
        <Alert type="warning" message={
          <span>Unknown leaf names (not in template): {unknownLeaves.map(n => <Tag key={n}>{n}</Tag>)}</span>
        } />
      )}

      {(rows || []).length > 0 && (
        <>
          <Divider style={{ margin: '10px 0' }} />
          <Text strong style={{ fontSize: 12 }}>{rows.length} rows</Text>
          <Table
            size="small"
            dataSource={(rows || []).map((r, i) => ({ ...r, _key: i }))}
            columns={tableColumns}
            rowKey="_key"
            pagination={{ pageSize: 6 }}
            scroll={{ x: true }}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            Empty threshold = inherit from template default
          </Text>
        </>
      )}
    </Space>
  )
}

// ─── Step 3 — Preview ─────────────────────────────────────────────────────────

function StepPreview({ previewData, loading, error }) {
  if (loading) return <Spin tip="Generating preview..." style={{ display: 'block', margin: '40px auto' }} />
  if (error) return <Alert type="error" message={error} />
  if (!previewData) return null

  const { stats, templatePreview, valuesPreview } = previewData
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Descriptions size="small" bordered column={3}>
        <Descriptions.Item label="Leaves">{stats?.leaves ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Alert rules">{stats?.rules ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Instances">{stats?.instances ?? 0}</Descriptions.Item>
      </Descriptions>

      <Text strong style={{ fontSize: 12 }}>PrometheusRule template</Text>
      <pre style={{
        background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 4,
        padding: 12, maxHeight: 260, overflow: 'auto', fontSize: 11, margin: 0
      }}>
        {templatePreview}
      </pre>

      {valuesPreview && Object.keys(valuesPreview).length > 0 && (
        <>
          <Text strong style={{ fontSize: 12 }}>Resolved values (first instance per leaf)</Text>
          <pre style={{
            background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 4,
            padding: 12, maxHeight: 180, overflow: 'auto', fontSize: 11, margin: 0
          }}>
            {Object.entries(valuesPreview).map(([name, rows]) =>
              `${name}:\n` + rows.slice(0, 1).map(r =>
                Object.entries(r).map(([k, v]) => `  ${k}: ${v}`).join('\n')
              ).join('\n')
            ).join('\n\n')}
          </pre>
        </>
      )}
    </Space>
  )
}

// ─── Step 4 — Confirm ─────────────────────────────────────────────────────────

function StepConfirm({ deployment, onDeployment, stats }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="success" showIcon icon={<CheckCircleOutlined />}
        message={`Ready: ${stats?.leaves ?? 0} leaves, ${stats?.rules ?? 0} rules, ${stats?.instances ?? 0} instances`} />
      <div>
        <Text style={{ fontSize: 12, fontWeight: 600 }}>Deployment name</Text>
        <Input
          placeholder="staging"
          value={deployment}
          onChange={e => onDeployment(e.target.value)}
          style={{ marginTop: 4 }}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          Values saved as <Text code>{deployment || 'default'}-values.yaml</Text>
        </Text>
      </div>
    </Space>
  )
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

const STEPS = ['Template 定義', 'Alert 資料', 'Preview', '確認儲存']

export default function ImportWizard({ open, chart, onClose, onImported }) {
  const [step, setStep] = useState(0)

  // Step 1
  const [templateRaw, setTemplateRaw] = useState('')
  const [leafDefs, setLeafDefs] = useState(null)
  const [templateErrors, setTemplateErrors] = useState([])
  const [templateLoading, setTemplateLoading] = useState(false)

  // Step 2
  const [dataRaw, setDataRaw] = useState('')
  const [dataRows, setDataRows] = useState([])
  const [dataErrors, setDataErrors] = useState([])

  // Step 3
  const [previewData, setPreviewData] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(null)

  // Step 4
  const [deployment, setDeployment] = useState('staging')
  const [saving, setSaving] = useState(false)

  async function handleParseTemplate() {
    setTemplateLoading(true)
    setTemplateErrors([])
    setLeafDefs(null)
    try {
      const result = await parseTemplate(templateRaw)
      setLeafDefs(result.leafDefs)
      setTemplateErrors(result.errors || [])
    } catch (e) {
      setTemplateErrors([e.message])
    } finally {
      setTemplateLoading(false)
    }
  }

  function handleParseData(raw, ext) {
    setDataErrors([])
    try {
      const rows = parseDataFile(raw, ext || 'csv')
      const errs = []
      rows.forEach((r, i) => {
        if (!r.name) errs.push(`Row ${i + 1}: missing name`)
        if (!r.cluster) errs.push(`Row ${i + 1}: missing cluster`)
        if (!r.app) errs.push(`Row ${i + 1}: missing app`)
      })
      setDataRows(rows)
      setDataErrors(errs)
    } catch (e) {
      setDataErrors([e.message])
    }
  }

  async function handlePreview() {
    setPreviewLoading(true)
    setPreviewError(null)
    setPreviewData(null)
    try {
      const data = await importPreview({ chart, deployment, templateYaml: templateRaw, dataRows })
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
      await saveImport({ chart, deployment, templateYaml: templateRaw, dataRows })
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
    setTemplateRaw('')
    setLeafDefs(null)
    setTemplateErrors([])
    setDataRaw('')
    setDataRows([])
    setDataErrors([])
    setPreviewData(null)
    setPreviewError(null)
    setDeployment('staging')
    onClose()
  }

  function tryNext() {
    if (step === 0) {
      if (!leafDefs || Object.keys(leafDefs).length === 0 || templateErrors.length > 0) return
    }
    if (step === 1) {
      if (dataErrors.length > 0) return
    }
    if (step === 2) {
      handlePreview()
    }
    setStep(s => s + 1)
  }

  const canNext = (() => {
    if (step === 0) return !!leafDefs && Object.keys(leafDefs).length > 0 && templateErrors.length === 0
    if (step === 1) return dataRows.length > 0 && dataErrors.length === 0
    if (step === 2) return !!previewData && !previewLoading
    return true
  })()

  return (
    <Modal
      title="Import Wizard"
      open={open}
      onCancel={handleClose}
      width={720}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={handleClose}>Cancel</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && <Button onClick={() => setStep(s => s - 1)}>Back</Button>}
            {step < STEPS.length - 1 ? (
              <Button type="primary" disabled={!canNext} onClick={tryNext}>Next</Button>
            ) : (
              <Button type="primary" loading={saving} onClick={handleSave}>Import</Button>
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

      <div style={{ minHeight: 240 }}>
        {step === 0 && (
          <StepTemplate
            raw={templateRaw}
            onChange={setTemplateRaw}
            leafDefs={leafDefs}
            errors={templateErrors}
            loading={templateLoading}
            onParse={handleParseTemplate}
          />
        )}
        {step === 1 && (
          <StepData
            raw={dataRaw}
            onChange={setDataRaw}
            rows={dataRows}
            errors={dataErrors}
            leafDefs={leafDefs}
            onParse={handleParseData}
          />
        )}
        {step === 2 && (
          <StepPreview previewData={previewData} loading={previewLoading} error={previewError} />
        )}
        {step === 3 && (
          <StepConfirm deployment={deployment} onDeployment={setDeployment} stats={previewData?.stats} />
        )}
      </div>
    </Modal>
  )
}
