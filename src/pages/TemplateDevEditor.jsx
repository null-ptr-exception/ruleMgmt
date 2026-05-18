import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Input, Select, Empty, Typography, Switch, Collapse } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
import { schemaAlertNames } from '../utils/schemaUtils'
import TemplateTree from '../components/TemplateTree'
import { generatePrometheusRule } from '../utils/templateGenerator'
import {
  listCharts, createChart, deleteChart,
  getChartInfo, saveChartTemplateFile,
  saveChartSchema, saveChartMeta
} from '../utils/chartApi'

import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

const { Text } = Typography
const { TextArea } = Input

const yamlExtension = StreamLanguage.define(yaml)

const SEVERITY_OPTIONS = [
  { value: 'info', label: 'info' },
  { value: 'warning', label: 'warning' },
  { value: 'critical', label: 'critical' },
]

const TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'integer', label: 'integer' },
  { value: 'boolean', label: 'boolean' },
  { value: 'enum', label: 'enum' },
]

export default function TemplateDevEditor() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [chartMeta, setChartMeta] = useState({})
  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])
  const [activeAlert, setActiveAlert] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [yamlExpanded, setYamlExpanded] = useState(false)
  const [editorEditable, setEditorEditable] = useState(false)
  const [fileContent, setFileContent] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const resizingRef = useRef(false)
  const editorRef = useRef(null)
  const viewRef = useRef(null)

  function handleResizeStart(e) {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX
    const startWidth = sidebarWidth
    function onMove(ev) {
      if (!resizingRef.current) return
      const clientX = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX
      const newWidth = Math.max(140, Math.min(400, startWidth + clientX - startX))
      setSidebarWidth(newWidth)
    }
    function onUp() {
      resizingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
  }

  const loadCharts = useCallback(async () => {
    const c = await listCharts()
    setCharts(c)
  }, [])

  useEffect(() => { loadCharts() }, [loadCharts])

  const loadChart = useCallback(async (chart) => {
    const info = await getChartInfo(chart)
    setChartMeta(info.chartMeta || {})
    const s = info.schema || { $schema: 'https://json-schema.org/draft-07/schema#', type: 'object', properties: {} }
    setSchema(s)
    const names = schemaAlertNames(s)
    setAlertNames(names)
    setActiveAlert(names.length > 0 ? names[0] : null)
    setDirty(false)
    setEditorEditable(false)
  }, [])

  useEffect(() => {
    if (activeChart) loadChart(activeChart)
  }, [activeChart, loadChart])

  useEffect(() => {
    if (!editorEditable && schema) {
      setFileContent(generatePrometheusRule(schema, '{{ .Release.Name }}'))
    }
  }, [schema, editorEditable])

  useEffect(() => {
    if (!editorRef.current || !yamlExpanded) return
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    const extensions = [
      basicSetup,
      yamlExtension,
      EditorState.readOnly.of(!editorEditable),
      ...(editorEditable ? [EditorView.updateListener.of(update => {
        if (update.docChanged) {
          setFileContent(update.state.doc.toString())
          setDirty(true)
        }
      })] : []),
    ]

    const state = EditorState.create({ doc: fileContent, extensions })
    viewRef.current = new EditorView({ state, parent: editorRef.current })

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [yamlExpanded, editorEditable, activeChart])

  useEffect(() => {
    if (!viewRef.current) return
    const current = viewRef.current.state.doc.toString()
    if (current !== fileContent) {
      viewRef.current.dispatch({
        changes: { from: 0, to: current.length, insert: fileContent },
      })
    }
  }, [fileContent])

  async function handleSave() {
    if (!activeChart) return
    await saveChartSchema(activeChart, schema)
    await saveChartMeta(activeChart, chartMeta)
    const content = editorEditable ? fileContent : generatePrometheusRule(schema, '{{ .Release.Name }}')
    await saveChartTemplateFile(activeChart, 'prometheus-rule', content)
    setDirty(false)
  }

  async function handleCreateChart() {
    const name = prompt('New chart name:')
    if (!name?.trim()) return
    await createChart(name.trim())
    await loadCharts()
    setActiveChart(name.trim())
  }

  async function handleDelete() {
    if (!activeChart) return
    if (!confirm(`Delete chart "${activeChart}"?`)) return
    await deleteChart(activeChart)
    setActiveChart(null)
    await loadCharts()
  }

  function handleAddAlert() {
    const name = prompt('Alert group name (e.g. mariadb_saturation_disk):')
    if (!name || !schema) return
    const newSchema = {
      ...schema,
      properties: {
        ...schema.properties,
        [name]: {
          type: 'array',
          'x-promql': '',
          'x-for': '5m',
          items: { type: 'object', properties: {} }
        }
      }
    }
    setSchema(newSchema)
    setAlertNames(schemaAlertNames(newSchema))
    setActiveAlert(name)
    setDirty(true)
  }

  function handleRemoveAlert() {
    if (!activeAlert || !schema) return
    if (!confirm(`Remove alert group "${activeAlert}"?`)) return
    const { [activeAlert]: _, ...rest } = schema.properties
    const newSchema = { ...schema, properties: rest }
    setSchema(newSchema)
    const names = schemaAlertNames(newSchema)
    setAlertNames(names)
    setActiveAlert(names.length > 0 ? names[0] : null)
    setDirty(true)
  }

  function updateAlertDef(field, value) {
    if (!activeAlert || !schema) return
    const alertDef = schema.properties[activeAlert]
    const newSchema = {
      ...schema,
      properties: { ...schema.properties, [activeAlert]: { ...alertDef, [field]: value } }
    }
    setSchema(newSchema)
    setDirty(true)
  }

  function updateItems(newProps, newRequired) {
    if (!activeAlert || !schema) return
    const alertDef = schema.properties[activeAlert]
    const newSchema = {
      ...schema,
      properties: {
        ...schema.properties,
        [activeAlert]: {
          ...alertDef,
          items: {
            type: 'object',
            properties: newProps,
            ...(newRequired.length > 0 ? { required: newRequired } : {})
          }
        }
      }
    }
    setSchema(newSchema)
    setDirty(true)
  }

  const alertDef = activeAlert ? schema?.properties?.[activeAlert] : null
  const props = alertDef?.items?.properties || {}
  const required = new Set(alertDef?.items?.required || [])

  const selectors = Object.entries(props).filter(([, p]) => p['x-var-type'] !== 'threshold')
  const thresholds = Object.entries(props).filter(([, p]) => p['x-var-type'] === 'threshold')

  function addVariable(varType) {
    const newName = ''
    const newProp = { type: varType === 'threshold' ? 'number' : 'string', 'x-var-type': varType }
    if (varType === 'threshold') newProp['x-severity'] = 'warning'
    const newProps = { ...props, [newName]: newProp }
    const newRequired = [...required]
    updateItems(newProps, newRequired)
  }

  function removeVariable(name) {
    const { [name]: _, ...rest } = props
    const newRequired = [...required].filter(r => r !== name)
    updateItems(rest, newRequired)
  }

  function updateVariable(oldName, newName, updates) {
    const entries = Object.entries(props).map(([k, v]) => {
      if (k === oldName) return [newName, { ...v, ...updates }]
      return [k, v]
    })
    const newProps = Object.fromEntries(entries)
    let newRequired = [...required]
    if (required.has(oldName)) {
      newRequired = newRequired.filter(r => r !== oldName)
      if (updates.required !== false) newRequired.push(newName)
    } else if (updates.required) {
      newRequired.push(newName)
    }
    updateItems(newProps, newRequired)
  }


  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Select
          value={activeChart || undefined}
          onChange={setActiveChart}
          placeholder="Select chart"
          style={{ minWidth: 180 }}
          options={charts.map(c => ({ value: c.name, label: `${c.name} (${c.templateCount} templates)` }))}
        />
        <Button size="small" icon={<PlusOutlined />} onClick={handleCreateChart}>New</Button>
        {activeChart && (
          <>
            <Input size="small" placeholder="Description" value={chartMeta.description || ''}
              onChange={e => { setChartMeta({ ...chartMeta, description: e.target.value }); setDirty(true) }}
              style={{ flex: 1, maxWidth: 400 }} />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
            </div>
          </>
        )}
      </div>

      {activeChart ? (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left sidebar - alert groups */}
          <div style={{ width: sidebarWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#fafafa', position: 'relative' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Alert Groups</Text>
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={handleAddAlert} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <TemplateTree
                templates={alertNames}
                activeTemplate={activeAlert}
                onSelect={setActiveAlert}
              />
            </div>
            {/* Resize handle - full height line + visible grip */}
            <div
              onMouseDown={handleResizeStart}
              onTouchStart={handleResizeStart}
              style={{ position: 'absolute', top: 0, right: -2, width: 5, height: '100%', cursor: 'col-resize', zIndex: 10 }}
            >
              <div style={{
                position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
                width: 14, height: 28, borderRadius: 4, background: '#d9d9d9', border: '1px solid #bfbfbf',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, color: '#8c8c8c', letterSpacing: 1, touchAction: 'none'
              }}>⋮</div>
            </div>
          </div>

          {/* Main content - rule builder */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {alertDef ? (
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {/* Alert group header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                  <Text strong style={{ fontSize: 16 }}>{activeAlert}</Text>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={handleRemoveAlert}>Remove</Button>
                </div>

                {/* PromQL */}
                <div style={{ marginBottom: 20 }}>
                  <Text style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>PromQL Expression</Text>
                  <TextArea
                    rows={3}
                    placeholder='rate(metric{namespace="{{ .namespace }}"}[5m]) > {{ THRESHOLD }}'
                    value={alertDef['x-promql'] || ''}
                    onChange={e => updateAlertDef('x-promql', e.target.value)}
                    style={{ fontFamily: 'monospace', fontSize: 13 }}
                  />
                  <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                    Use {'{{ .var_name }}'} for selectors, {'{{ THRESHOLD }}'} for threshold placeholder
                  </Text>
                </div>

                {/* For duration */}
                <div style={{ marginBottom: 24, display: 'flex', gap: 16, alignItems: 'center' }}>
                  <div>
                    <Text style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>For Duration</Text>
                    <Input size="small" value={alertDef['x-for'] || '5m'} onChange={e => updateAlertDef('x-for', e.target.value)} style={{ width: 80 }} />
                  </div>
                  <div style={{ marginTop: 18 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={alertDef['x-custom-template'] || false}
                        onChange={e => updateAlertDef('x-custom-template', e.target.checked)} />
                      <Text style={{ fontSize: 12 }}>Custom template (skip generation)</Text>
                    </label>
                  </div>
                </div>

                {/* Selectors */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Selectors</Text>
                    <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                    <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addVariable('selector')}>Add</Button>
                  </div>
                  {selectors.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No selectors defined</Text>}
                  {selectors.map(([name, prop]) => (
                    <div key={name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                      <Input size="small" value={name} placeholder="name"
                        onChange={e => updateVariable(name, e.target.value, {})}
                        style={{ width: 140, fontWeight: 600 }} />
                      <Select size="small" value={prop.type || 'string'} options={TYPE_OPTIONS} style={{ width: 80 }}
                        onChange={val => updateVariable(name, name, { type: val })} />
                      <Input size="small" value={prop.description || ''} placeholder="description"
                        onChange={e => updateVariable(name, name, { description: e.target.value })}
                        style={{ flex: 1 }} />
                      <Input size="small" value={prop.default ?? ''} placeholder="default" style={{ width: 100 }}
                        onChange={e => updateVariable(name, name, { default: e.target.value || undefined })} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                        <input type="checkbox" checked={required.has(name)}
                          onChange={e => updateVariable(name, name, { required: e.target.checked })} />
                        <Text style={{ fontSize: 11 }}>Req</Text>
                      </label>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeVariable(name)} />
                    </div>
                  ))}
                </div>

                {/* Thresholds */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Thresholds</Text>
                    <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                    <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addVariable('threshold')}>Add</Button>
                  </div>
                  {thresholds.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No thresholds defined</Text>}
                  {thresholds.map(([name, prop]) => (
                    <div key={name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                      <Input size="small" value={name} placeholder="name"
                        onChange={e => updateVariable(name, e.target.value, {})}
                        style={{ width: 140, fontWeight: 600 }} />
                      <Select size="small" value={prop['x-severity'] || 'warning'} options={SEVERITY_OPTIONS} style={{ width: 90 }}
                        onChange={val => updateVariable(name, name, { 'x-severity': val })} />
                      <Input size="small" value={prop.description || ''} placeholder="description"
                        onChange={e => updateVariable(name, name, { description: e.target.value })}
                        style={{ flex: 1 }} />
                      <Input size="small" value={prop.default ?? ''} placeholder="default" style={{ width: 80 }}
                        onChange={e => {
                          const v = e.target.value
                          updateVariable(name, name, { default: v === '' ? undefined : (isNaN(Number(v)) ? v : Number(v)) })
                        }} />
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeVariable(name)} />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <Empty style={{ margin: 'auto' }} description="Select or create an alert group" />
            )}

            {/* Collapsible YAML preview */}
            <div style={{ borderTop: '1px solid #f0f0f0' }}>
              <div
                onClick={() => setYamlExpanded(!yamlExpanded)}
                style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: '#fafafa' }}
              >
                {yamlExpanded ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />}
                <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Generated YAML</Text>
                {yamlExpanded && (
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 11, color: '#8c8c8c' }}>Edit manually</Text>
                    <Switch size="small" checked={editorEditable} onChange={setEditorEditable} />
                  </div>
                )}
              </div>
              {yamlExpanded && (
                <div id="template-dev-cm" ref={editorRef} style={{ height: 300, overflow: 'auto', borderTop: '1px solid #f0f0f0' }}>
                  <style>{`#template-dev-cm .cm-editor { height: 100%; }`}</style>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <Empty style={{ margin: 'auto' }} description="Select a chart or create a new one." />
      )}

      {/* Bottom status bar */}
      {activeChart && dirty && (
        <div style={{ padding: '8px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fffbe6' }}>
          <Text type="warning" style={{ fontSize: 12 }}>Unsaved changes</Text>
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSave}>Save</Button>
        </div>
      )}
    </div>
  )
}
