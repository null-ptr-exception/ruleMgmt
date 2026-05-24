import { useState, useEffect, useRef, useCallback } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Input, Select, Empty, Typography, Switch, Modal, Tag } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined, DownOutlined, RightOutlined, CopyOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { schemaAlertNames } from '../utils/schemaUtils'
import TemplateTree from '../components/TemplateTree'
import { generatePrometheusRule } from '../utils/templateGenerator'
import {
  listCharts, createChart, deleteChart, cloneChart,
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
  const [activeChart, setActiveChart] = useSessionState('templates:chart', null)
  const [chartMeta, setChartMeta] = useState({})
  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])
  const [activeAlert, setActiveAlert] = useSessionState('templates:alert', null)
  const [dirty, setDirty] = useState(false)
  const [yamlExpanded, setYamlExpanded] = useState(false)
  const [gsExpanded, setGsExpanded] = useState(false)
  const [editorEditable, setEditorEditable] = useState(false)
  const [fileContent, setFileContent] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const [saveWarning, setSaveWarning] = useState(null)
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
    if (activeChart && !c.some(ch => ch.name === activeChart)) {
      setActiveChart(null)
    }
  }, [activeChart, setActiveChart])

  useEffect(() => { loadCharts() }, [loadCharts])

  const loadChart = useCallback(async (chart) => {
    const info = await getChartInfo(chart)
    setChartMeta(info.chartMeta || {})
    const s = info.schema || { $schema: 'https://json-schema.org/draft-07/schema#', type: 'object', properties: {} }
    setSchema(s)
    const names = schemaAlertNames(s)
    setAlertNames(names)
    setActiveAlert(prev => names.includes(prev) ? prev : (names.length > 0 ? names[0] : null))
    setDirty(false)
    setEditorEditable(false)
  }, [setActiveAlert])

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

  // ── Global selector helpers ───────────────────────────────────────────────

  function ruleHasGlobalSelector(promql, gsKeys) {
    if (!gsKeys || gsKeys.length === 0) return true
    return gsKeys.some(k => promql && (promql.includes(`{{ .${k} }}`) || promql.includes(`{{.${k}}}`)))
  }

  function injectGlobalSelectorsIntoPromql(promql, gsKeys) {
    if (!gsKeys || gsKeys.length === 0 || !promql) return promql
    const suffix = gsKeys.map(k => `${k}="{{ .${k} }}"`).join(', ')
    if (/\{[^}]*\}/.test(promql)) {
      return promql.replace(/\{([^}]*)\}/g, (_, content) => {
        const trimmed = content.trim()
        return trimmed ? `{${trimmed}, ${suffix}}` : `{${suffix}}`
      })
    }
    return promql.replace(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/, `$1{${suffix}}`)
  }

  // ── Save with validation ──────────────────────────────────────────────────

  async function doSave(overrideSchema) {
    const s = overrideSchema ?? schema
    await saveChartSchema(activeChart, s)
    await saveChartMeta(activeChart, chartMeta)
    const content = editorEditable ? fileContent : generatePrometheusRule(s, '{{ .Release.Name }}')
    await saveChartTemplateFile(activeChart, 'prometheus-rule', content)
    setDirty(false)
  }

  async function handleSave() {
    if (!activeChart) return
    const gsKeys = (schema?.['x-global-selectors'] || []).filter(k => k.trim())
    if (gsKeys.length > 0) {
      const names = schemaAlertNames(schema)
      const missing = names.filter(name => {
        const promql = schema.properties[name]?.['x-promql'] || ''
        return !ruleHasGlobalSelector(promql, gsKeys)
      })
      if (missing.length > 0) {
        setSaveWarning({ type: missing.length === names.length ? 'all-missing' : 'some-missing', missing, gsKeys })
        return
      }
    }
    await doSave()
  }

  function handleAutoFix() {
    const { missing, gsKeys } = saveWarning
    const newProperties = { ...schema.properties }
    for (const name of missing) {
      const alertDef = newProperties[name]
      if (!alertDef) continue
      newProperties[name] = { ...alertDef, 'x-promql': injectGlobalSelectorsIntoPromql(alertDef['x-promql'] || '', gsKeys) }
    }
    const newSchema = { ...schema, properties: newProperties }
    setSchema(newSchema)
    setSaveWarning(null)
    doSave(newSchema)
  }

  // ── Chart management ──────────────────────────────────────────────────────

  async function handleCreateChart() {
    const name = prompt('New chart name:')
    if (!name?.trim()) return
    await createChart(name.trim())
    await loadCharts()
    setActiveChart(name.trim())
  }

  async function handleCloneChart() {
    if (!activeChart) return
    const newName = prompt(`Clone "${activeChart}" as (lowercase, a-z0-9_-):`)
    if (!newName?.trim()) return
    const trimmed = newName.trim()
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
      alert('Chart name must match: ^[a-z0-9][a-z0-9_-]*$')
      return
    }
    try {
      await cloneChart(activeChart, trimmed)
      await loadCharts()
      setActiveChart(trimmed)
    } catch (err) {
      alert(err.message)
    }
  }

  async function handleDelete() {
    if (!activeChart) return
    if (!confirm(`Delete chart "${activeChart}" and all its alert groups?`)) return
    await deleteChart(activeChart)
    setActiveChart(null)
    await loadCharts()
  }

  // ── Global selector key management ───────────────────────────────────────

  function handleAddGsKey() {
    const newKeys = [...(schema?.['x-global-selectors'] || []), '']
    setSchema({ ...schema, 'x-global-selectors': newKeys })
    setGsExpanded(true)
    setDirty(true)
  }

  function updateGsKey(idx, value) {
    const newKeys = (schema?.['x-global-selectors'] || []).map((k, i) => i === idx ? value : k)
    setSchema({ ...schema, 'x-global-selectors': newKeys })
    setDirty(true)
  }

  function removeGsKey(idx) {
    const newKeys = (schema?.['x-global-selectors'] || []).filter((_, i) => i !== idx)
    setSchema({ ...schema, 'x-global-selectors': newKeys })
    setDirty(true)
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

  const gsKeys = (schema?.['x-global-selectors'] || []).filter(k => k.trim())
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
              <Button icon={<CopyOutlined />} onClick={handleCloneChart}>Clone</Button>
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

            {/* Global Selectors panel (chart-level) */}
            <div style={{ borderBottom: '1px solid #f0f0f0', background: '#fafafa', flexShrink: 0 }}>
              <div
                onClick={() => setGsExpanded(v => !v)}
                style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
              >
                {gsExpanded ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />}
                <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Global Selectors</Text>
                {!gsExpanded && (
                  (schema?.['x-global-selectors'] || []).length > 0
                    ? (schema['x-global-selectors']).map(k => k && <Tag key={k} style={{ margin: '0 2px', fontSize: 11 }}>{`{{ .${k} }}`}</Tag>)
                    : <Text type="secondary" style={{ fontSize: 11 }}>none defined</Text>
                )}
                <div style={{ marginLeft: 'auto' }} onClick={e => e.stopPropagation()}>
                  <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={handleAddGsKey} disabled={!activeChart}>Add</Button>
                </div>
              </div>
              {gsExpanded && (
                <div style={{ padding: '4px 16px 12px' }}>
                  {(schema?.['x-global-selectors'] || []).length === 0 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      No global selectors defined. Add keys that must appear in every rule's PromQL (e.g. cluster, group).
                    </Text>
                  )}
                  {(schema?.['x-global-selectors'] || []).map((key, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <Input
                        size="small"
                        value={key}
                        placeholder="key name (e.g. cluster)"
                        onChange={e => updateGsKey(idx, e.target.value)}
                        style={{ width: 180, fontFamily: 'monospace' }}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>→</Text>
                      <Tag style={{ fontSize: 11, fontFamily: 'monospace' }}>{`{{ .${key || '?'} }}`}</Tag>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeGsKey(idx)} />
                    </div>
                  ))}
                </div>
              )}
            </div>

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

      {/* Save validation modal */}
      <Modal
        open={!!saveWarning}
        title={saveWarning?.type === 'all-missing' ? 'No Global Selectors Embedded' : 'Some Rules Missing Global Selectors'}
        onCancel={() => setSaveWarning(null)}
        footer={[
          <Button key="cancel" onClick={() => setSaveWarning(null)}>Cancel</Button>,
          <Button key="fix" type="primary" icon={<ThunderboltOutlined />} onClick={handleAutoFix}>
            Auto-fix & Save
          </Button>,
          <Button key="anyway" onClick={() => { setSaveWarning(null); doSave() }}>
            {saveWarning?.type === 'all-missing' ? 'I understand, save anyway' : 'Save without fix'}
          </Button>,
        ]}
      >
        {saveWarning?.type === 'all-missing'
          ? <Text type="warning" style={{ display: 'block', marginBottom: 8 }}>
              No rules embed any global selector. This template cannot be scoped to specific targets.
            </Text>
          : <Text style={{ display: 'block', marginBottom: 8 }}>
              The following rules don&apos;t embed any global selector placeholder:
            </Text>
        }
        <ul style={{ margin: '0 0 12px 16px', padding: 0 }}>
          {saveWarning?.missing.map(r => (
            <li key={r} style={{ fontFamily: 'monospace', fontSize: 13 }}>{r}</li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Global selectors:</Text>
          {(saveWarning?.gsKeys || []).map(k => (
            <Tag key={k} style={{ fontSize: 11, fontFamily: 'monospace' }}>{`{{ .${k} }}`}</Tag>
          ))}
        </div>
      </Modal>
    </div>
  )
}
