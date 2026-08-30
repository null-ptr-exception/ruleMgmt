import { useState, useEffect, useRef, useCallback } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Input, Select, Empty, Typography, Switch, Collapse, Modal } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
import { schemaAlertNames, getCommonVars, setCommonVars } from '../utils/schemaUtils'
import TemplateTree from '../components/TemplateTree'
import RuleEditor from '../components/RuleEditor'
import { generateGroupTemplate, normalizeRules } from '../utils/templateGenerator'
import { danglingRefs } from '../utils/ruleModel'
import {
  listCharts, createChart, deleteChart,
  getChartInfo, getChartTemplateFile, saveChartTemplateFile, deleteChartTemplate,
  saveChartSchema, saveChartMeta
} from '../utils/chartApi'

import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

const { Text } = Typography
const { TextArea } = Input

const yamlExtension = StreamLanguage.define(yaml)

function VariableRow({ name, prop, onRename, onUpdate, onRemove, showRequired, isRequired, variant }) {
  const uiType = prop.enum ? 'enum' : (prop.type || 'string')
  const isEnum = uiType === 'enum'
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input size="small" value={name} placeholder="name"
          onChange={e => onRename(e.target.value)}
          style={{ width: 140, fontWeight: 600 }} />
        {variant === 'threshold' ? (
          <Select size="small" value={prop['x-severity'] || 'warning'} options={SEVERITY_OPTIONS} style={{ width: 90 }}
            onChange={val => onUpdate({ 'x-severity': val })} />
        ) : (
          <Select size="small" value={uiType} options={TYPE_OPTIONS} style={{ width: 80 }}
            onChange={val => {
              const updates = val === 'enum'
                ? { type: 'string', enum: prop.enum || [] }
                : { type: val, enum: undefined }
              onUpdate(updates)
            }} />
        )}
        <Input size="small" value={prop.description || ''} placeholder="description"
          onChange={e => onUpdate({ description: e.target.value })}
          style={{ flex: 1 }} />
        <Input size="small" value={prop.default ?? ''} placeholder="default" style={{ width: variant === 'threshold' ? 80 : 100 }}
          onChange={e => {
            const v = e.target.value
            if (variant === 'threshold') {
              onUpdate({ default: v === '' ? undefined : (isNaN(Number(v)) ? v : Number(v)) })
            } else {
              onUpdate({ default: v || undefined })
            }
          }} />
        {showRequired && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={!!isRequired}
              onChange={e => onUpdate({ required: e.target.checked })} />
            <Text style={{ fontSize: 11 }}>Req</Text>
          </label>
        )}
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onRemove} />
      </div>
      {isEnum && (
        <Select size="small" mode="tags" placeholder="Type a value and press Enter"
          value={prop.enum || []}
          onChange={vals => onUpdate({ enum: vals?.length ? vals : undefined })}
          style={{ width: '100%', marginTop: 6 }}
          open={false}
        />
      )}
    </div>
  )
}

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
  const [collapsedRules, setCollapsedRules] = useState({})
  const [yamlExpanded, setYamlExpanded] = useSessionState('templates:yamlExpanded', false)
  const [editorEditable, setEditorEditable] = useSessionState('templates:editorEditable', false)
  const [fileContent, setFileContent] = useState('')
  const [savedTemplateFiles, setSavedTemplateFiles] = useState([])
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const resizingRef = useRef(false)
  const suppressDirtyRef = useRef(false)
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
    setSavedTemplateFiles(info.templateFiles || [])
    setDirty(false)
  }, [setActiveAlert])

  useEffect(() => {
    if (activeChart) loadChart(activeChart)
  }, [activeChart, loadChart])

  useEffect(() => {
    if (!schema || !activeAlert || activeAlert === '__common_vars__') return
    const alertDef = schema.properties?.[activeAlert]
    if (!alertDef) return

    if (alertDef['x-custom-template']) {
      setEditorEditable(true)
      const fileName = activeAlert.replace(/_/g, '-')
      suppressDirtyRef.current = true
      getChartTemplateFile(activeChart, fileName).then(data => {
        setFileContent(data.content || '')
        setTimeout(() => { suppressDirtyRef.current = false }, 0)
      })
    } else {
      setEditorEditable(false)
      suppressDirtyRef.current = true
      setFileContent(generateGroupTemplate(activeAlert, alertDef, '{{ .Release.Name }}', schema) || '')
      setTimeout(() => { suppressDirtyRef.current = false }, 0)
    }
  }, [schema, activeAlert, activeChart])

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
          if (!suppressDirtyRef.current) setDirty(true)
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

  /** Acceptance condition 3: every ${var} must name a column that exists. */
  function unresolvedReferences() {
    const commonNames = Object.keys(schema?.['x-common-vars']?.properties || {})
    return Object.entries(schema?.properties || {})
      .filter(([group]) => !group.startsWith('$'))
      .map(([group, def]) => ({
        group,
        missing: danglingRefs(
          normalizeRules(group, def),
          [...Object.keys(def?.items?.properties || {}), ...commonNames]
        )
      }))
      .filter(g => g.missing.length > 0)
  }

  async function handleSave(confirmBreaking = false) {
    if (!activeChart) return

    const unresolved = unresolvedReferences()
    if (unresolved.length > 0) {
      Modal.error({
        title: 'Some references have no column',
        content: (
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            {unresolved.map(g => (
              <li key={g.group}>{g.group}: {g.missing.join(', ')}</li>
            ))}
          </ul>
        )
      })
      return
    }
    const saved = await saveChartSchema(activeChart, schema, confirmBreaking)
    if (saved?.blocked) {
      Modal.confirm({
        title: 'This change breaks deployments that already exist',
        width: 620,
        content: (
          <div>
            <ul style={{ paddingLeft: 18, marginTop: 8 }}>
              {saved.breaking.map((c, i) => <li key={i}>{c.description}</li>)}
            </ul>
            <p style={{ marginTop: 12 }}>
              In use by {saved.deployments.length} deployment(s):{' '}
              {saved.deployments.map(d => d.path).join(', ')}
            </p>
            <p>
              Cloning the chart and changing the copy leaves these untouched and lets each
              owner move over when they are ready.
            </p>
          </div>
        ),
        okText: 'Save anyway',
        okButtonProps: { danger: true },
        cancelText: 'Cancel',
        onOk: () => handleSave(true)
      })
      return
    }
    await saveChartMeta(activeChart, chartMeta)

    const newTemplateFiles = []
    for (const [alertGroup, alertDef] of Object.entries(schema.properties || {})) {
      if (alertGroup.startsWith('$')) continue
      const fileName = alertGroup.replace(/_/g, '-')

      if (alertDef['x-custom-template']) {
        // Save custom template if currently editing it
        if (editorEditable && activeAlert === alertGroup && fileContent) {
          await saveChartTemplateFile(activeChart, fileName, fileContent)
        }
        newTemplateFiles.push(fileName)
        continue
      }

      const content = generateGroupTemplate(alertGroup, alertDef, '{{ .Release.Name }}', schema)
      if (!content) continue
      await saveChartTemplateFile(activeChart, fileName, content)
      newTemplateFiles.push(fileName)
    }

    // Delete template files for removed groups
    for (const oldFile of savedTemplateFiles) {
      if (!newTemplateFiles.includes(oldFile) && oldFile !== 'Chart') {
        await deleteChartTemplate(activeChart, oldFile)
      }
    }

    setSavedTemplateFiles(newTemplateFiles)
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
          // New groups start on x-rules. The legacy single-expression field is
          // only ever shown for charts that already have one.
          'x-rules': [{ alert: '', expr: '', for: '5m', labels: { severity: 'warning' }, annotations: {} }],
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

  const isCommonVars = activeAlert === '__common_vars__'
  const alertDef = (!isCommonVars && activeAlert) ? schema?.properties?.[activeAlert] : null
  const props = alertDef?.items?.properties || {}
  const required = new Set(alertDef?.items?.required || [])

  const commonVars = schema ? getCommonVars(schema) : []

  function addCommonVar() {
    const updated = [...commonVars, { name: '', type: 'string', description: '', required: false }]
    setSchema(setCommonVars(schema, updated))
    setDirty(true)
  }

  function removeCommonVar(index) {
    const updated = commonVars.filter((_, i) => i !== index)
    setSchema(setCommonVars(schema, updated))
    setDirty(true)
  }

  function updateCommonVar(index, field, value) {
    const updated = commonVars.map((v, i) => i === index ? { ...v, [field]: value } : v)
    setSchema(setCommonVars(schema, updated))
    setDirty(true)
  }

  // Only a column tagged as a selector is emitted as a label by the legacy
  // generator; an untagged one is a plain variable a rule refers to by name, so
  // showing it under Selectors was misleading.
  const selectors = Object.entries(props).filter(([, p]) => p['x-var-type'] === 'selector')
  const thresholds = Object.entries(props).filter(([, p]) => p['x-var-type'] === 'threshold')
  // Roles only exist for the legacy generator, so an x-rules group lists every
  // column here — otherwise a column left over from before the conversion,
  // still carrying x-var-type, would vanish from the editor entirely.
  const variables = alertDef?.['x-rules']
    ? Object.entries(props)
    : Object.entries(props).filter(([, p]) => !p['x-var-type'])

  function addVariable(varType) {
    const newName = ''
    const newProp = { type: varType === 'threshold' ? 'number' : 'string' }
    // An untagged column is a plain variable; only selectors and thresholds
    // carry a role, and only the legacy generator reads it.
    if (varType) newProp['x-var-type'] = varType
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


  const xRules = alertDef?.['x-rules']

  function setRules(rules) {
    updateAlertDef('x-rules', rules)
  }

  function addRule() {
    setRules([...(xRules || []), {
      alert: '', expr: '', for: alertDef['x-for'] || '5m', labels: { severity: 'warning' }, annotations: {}
    }])
  }

  // Marking a literal opens a column for it. A number stays a number so the
  // rule owner gets a numeric field rather than a text box.
  function addColumn(name, sample) {
    const numeric = sample !== undefined && sample.trim() !== '' && !Number.isNaN(Number(sample))
    updateItems({ ...props, [name]: { type: numeric ? 'number' : 'string' } }, [...required])
  }

  function convertToRules() {
    const promql = alertDef['x-promql'] || ''
    const selectors = Object.entries(props).filter(([, p]) => p['x-var-type'] === 'selector').map(([n]) => n)
    const thresholds = Object.entries(props).filter(([, p]) => p['x-var-type'] === 'threshold')
    const optional = [...commonVars.filter(v => !v.required).map(v => v.name), ...selectors.filter(s => !required.has(s))]
    const pascal = str => str.split(/[_\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
    const firstRequired = [...commonVars.filter(v => v.required).map(v => v.name), ...selectors.filter(s => required.has(s))][0]

    const asPlaceholders = text => text
      .replace(/\{\{\s*\.(\w+)\s*\}\}/g, (m, v) => `\${${v}}`)

    // A group with no thresholds still has an expression, and dropping it on
    // convert would silently discard what the owner typed.
    const build = () => thresholds.length === 0
      ? [{
        alert: pascal(activeAlert),
        expr: asPlaceholders(promql),
        for: alertDef['x-for'] || '5m',
        labels: { severity: 'warning' },
        annotations: {}
      }]
      : thresholds.map(([name, prop]) => {
      const alert = `${pascal(activeAlert)}_${pascal(name)}`
      return {
        alert,
        expr: promql
          .replace(/\{\{\s*THRESHOLD\s*\}\}/g, `\${${name}}`)
          .replace(/\{\{\s*\.(\w+)\s*\}\}/g, (m, v) => `\${${v}}`),
        for: alertDef['x-for'] || '5m',
        labels: {
          severity: prop['x-severity'] || 'warning',
          ...Object.fromEntries([...commonVars.map(v => v.name), ...selectors].map(sel => [sel, `\${${sel}}`]))
        },
        annotations: { summary: firstRequired ? `${alert} triggered on \${${firstRequired}}` : `${alert} triggered` }
      }
    })

    const apply = () => {
      const { 'x-promql': _p, 'x-for': _f, ...rest } = schema.properties[activeAlert]
      setSchema({
        ...schema,
        properties: { ...schema.properties, [activeAlert]: { ...rest, 'x-rules': build() } }
      })
      setDirty(true)
    }

    if (optional.length > 0) {
      Modal.confirm({
        title: 'Converting drops the optional-label guards',
        content: `${optional.join(', ')} are optional today, so their labels are only emitted when a row sets them. Converted rules emit every label unconditionally, which changes what this chart renders.`,
        okText: 'Convert anyway',
        onOk: apply
      })
    } else {
      apply()
    }
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
              <Button type="primary" icon={<SaveOutlined />} onClick={() => handleSave()} disabled={!dirty}>Save</Button>
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
                showCommonVars
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
            {isCommonVars ? (
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                  <Text strong style={{ fontSize: 16 }}>Common Variables</Text>
                </div>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
                  Variables defined here are shared across all alert groups. They appear as columns in every alert table and as labels in every generated PrometheusRule.
                </Text>

                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Selectors</Text>
                    <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                    <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addCommonVar}>Add</Button>
                  </div>
                  {commonVars.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No common variables defined</Text>}
                  {commonVars.map((v, i) => {
                    const prop = { type: v.type === 'enum' ? 'string' : (v.type || 'string'), description: v.description, default: v.default, enum: v.enum }
                    return (
                      <VariableRow key={i} name={v.name} prop={prop}
                        showRequired isRequired={v.required}
                        onRename={val => updateCommonVar(i, 'name', val)}
                        onUpdate={updates => {
                          const merged = { ...v }
                          if ('type' in updates) merged.type = updates.enum !== undefined ? 'enum' : updates.type
                          if ('description' in updates) merged.description = updates.description
                          if ('default' in updates) merged.default = updates.default
                          if ('enum' in updates) merged.enum = updates.enum
                          if ('required' in updates) merged.required = updates.required
                          const updated = commonVars.map((cv, j) => j === i ? merged : cv)
                          setSchema(setCommonVars(schema, updated))
                          setDirty(true)
                        }}
                        onRemove={() => removeCommonVar(i)}
                      />
                    )
                  })}
                </div>
              </div>
            ) : alertDef ? (
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {/* Alert group header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                  <Text strong style={{ fontSize: 16 }}>{activeAlert}</Text>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={handleRemoveAlert}>Remove</Button>
                </div>

                {xRules ? (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
                        Rules ({xRules.length}) — one table, one alert per rule
                      </Text>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {xRules.length > 1 && (
                          <Button
                            size="small"
                            onClick={() => setCollapsedRules(prev => {
                              const allCollapsed = xRules.every((_, i) => prev[`${activeAlert}:${i}`])
                              return Object.fromEntries(xRules.map((_, i) => [`${activeAlert}:${i}`, !allCollapsed]))
                            })}
                          >
                            {xRules.every((_, i) => collapsedRules[`${activeAlert}:${i}`]) ? 'Expand all' : 'Collapse all'}
                          </Button>
                        )}
                        <Button size="small" icon={<PlusOutlined />} onClick={addRule}>Add rule</Button>
                      </div>
                    </div>
                    {xRules.map((rule, i) => (
                      <RuleEditor
                        key={i}
                        rule={rule}
                        // A rule may refer to a chart-level common variable
                        // just as freely as to one of this table's own columns.
                        columns={[...Object.keys(props), ...commonVars.map(v => v.name)]}
                        collapsed={!!collapsedRules[`${activeAlert}:${i}`]}
                        onToggleCollapse={() => setCollapsedRules(prev => ({
                          ...prev,
                          [`${activeAlert}:${i}`]: !prev[`${activeAlert}:${i}`]
                        }))}
                        onChange={next => setRules(xRules.map((r, idx) => (idx === i ? next : r)))}
                        onRemove={() => setRules(xRules.filter((_, idx) => idx !== i))}
                        onAddColumn={addColumn}
                      />
                    ))}
                    {xRules.length === 0 && <Empty description="No rules yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                  </div>
                ) : (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>PromQL Expression</Text>
                      <Button size="small" onClick={convertToRules} disabled={!alertDef['x-promql']}>
                        Convert to rules
                      </Button>
                    </div>
                    <TextArea
                      rows={3}
                      placeholder='rate(metric{namespace="{{ .namespace }}"}[5m]) > {{ THRESHOLD }}'
                      value={alertDef['x-promql'] || ''}
                      onChange={e => updateAlertDef('x-promql', e.target.value)}
                      style={{ fontFamily: 'monospace', fontSize: 13 }}
                    />
                    <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                      Legacy single-expression group. Convert to rules to give this table more than one alert.
                    </Text>
                  </div>
                )}

                {/* For duration */}
                <div style={{ marginBottom: 24, display: 'flex', gap: 16, alignItems: 'center' }}>
                  {!xRules && (
                    <div>
                      <Text style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>For Duration</Text>
                      <Input size="small" value={alertDef['x-for'] || '5m'} onChange={e => updateAlertDef('x-for', e.target.value)} style={{ width: 80 }} />
                    </div>
                  )}
                  <div style={{ marginTop: 18 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={alertDef['x-custom-template'] || false}
                        onChange={e => updateAlertDef('x-custom-template', e.target.checked)} />
                      <Text style={{ fontSize: 12 }}>Custom template (skip generation)</Text>
                    </label>
                  </div>
                </div>

                {/* Selector and threshold roles only mean something to the
                    legacy generator: it derives the labels from selectors and
                    fans one alert out per threshold. An x-rules group writes
                    its own labels and its own rules, so there a column is just
                    a column and the two roles would have no effect. */}
                {!xRules && (
                  <>
                {/* Selectors */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Selectors</Text>
                    <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                    <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addVariable('selector')}>Add</Button>
                  </div>
                  {selectors.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No selectors defined</Text>}
                  {selectors.map(([name, prop]) => (
                    <VariableRow key={name} name={name} prop={prop}
                      showRequired isRequired={required.has(name)}
                      onRename={val => updateVariable(name, val, {})}
                      onUpdate={updates => updateVariable(name, name, updates)}
                      onRemove={() => removeVariable(name)}
                    />
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
                    <VariableRow key={name} name={name} prop={prop} variant="threshold"
                      onRename={val => updateVariable(name, val, {})}
                      onUpdate={updates => updateVariable(name, name, updates)}
                      onRemove={() => removeVariable(name)}
                    />
                  ))}
                </div>
                  </>
                )}

                {/* Variables — columns a rule refers to by name */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Variables</Text>
                    <div style={{ flex: 1, height: 1, background: '#e8e8e8' }} />
                    <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addVariable(undefined)}>Add</Button>
                  </div>
                  {variables.length === 0 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Columns a rule refers to as {'${name}'}. Marking a literal in an expression creates one here.
                    </Text>
                  )}
                  {variables.map(([name, prop]) => (
                    <VariableRow key={name} name={name} prop={prop}
                      showRequired isRequired={required.has(name)}
                      onRename={val => updateVariable(name, val, {})}
                      onUpdate={updates => updateVariable(name, name, updates)}
                      onRemove={() => removeVariable(name)}
                    />
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
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
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
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={() => handleSave()}>Save</Button>
        </div>
      )}
    </div>
  )
}
