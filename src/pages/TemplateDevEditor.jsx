import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Input, Select, Empty, Typography, Switch } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import RuleBuilder from '../components/RuleBuilder'
import { schemaAlertNames } from '../utils/schemaUtils'
import { generatePrometheusRule } from '../utils/templateGenerator'
import {
  listCharts, createChart, deleteChart,
  getChartInfo, getChartTemplateFile, saveChartTemplateFile,
  saveChartSchema, saveChartMeta
} from '../utils/chartApi'

import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

const { Text } = Typography

const yamlExtension = StreamLanguage.define(yaml)

export default function TemplateDevEditor() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [chartMeta, setChartMeta] = useState({})
  const [templateFiles, setTemplateFiles] = useState([])
  const [activeFile, setActiveFile] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])
  const [activeAlert, setActiveAlert] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [editorEditable, setEditorEditable] = useState(false)
  const editorRef = useRef(null)
  const viewRef = useRef(null)

  const loadCharts = useCallback(async () => {
    const c = await listCharts()
    setCharts(c)
  }, [])

  useEffect(() => { loadCharts() }, [loadCharts])

  const loadChart = useCallback(async (chart) => {
    const info = await getChartInfo(chart)
    setChartMeta(info.chartMeta || {})
    setTemplateFiles(info.templateFiles || [])
    const s = info.schema || { $schema: 'https://json-schema.org/draft-07/schema#', type: 'object', properties: {} }
    setSchema(s)
    const names = schemaAlertNames(s)
    setAlertNames(names)
    setActiveAlert(names.length > 0 ? names[0] : null)
    setDirty(false)
    setEditorEditable(false)
    if (info.templateFiles?.length > 0) {
      setActiveFile(info.templateFiles[0])
    } else {
      setActiveFile(null)
      setFileContent('')
    }
  }, [])

  useEffect(() => {
    if (activeChart) loadChart(activeChart)
  }, [activeChart, loadChart])

  useEffect(() => {
    if (!activeChart || !activeFile) return
    getChartTemplateFile(activeChart, activeFile).then(data => {
      setFileContent(data.content || '')
    })
  }, [activeChart, activeFile])

  // Regenerate YAML when schema changes and editor is not in manual mode
  useEffect(() => {
    if (!editorEditable && schema && activeChart) {
      const generated = generatePrometheusRule(schema, `{{ .Release.Name }}`)
      setFileContent(generated)
    }
  }, [schema, editorEditable])

  // CodeMirror setup
  useEffect(() => {
    if (!editorRef.current) return
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }
    if (!activeFile && !schema) return

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
  }, [activeChart, activeFile, editorEditable])

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
    if (activeFile) {
      const content = editorEditable ? fileContent : generatePrometheusRule(schema, `{{ .Release.Name }}`)
      await saveChartTemplateFile(activeChart, activeFile, content)
    }
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
    const name = prompt('Alert group name (use underscores, e.g. mariadb_saturation_disk):')
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
    const { [activeAlert]: _, ...rest } = schema.properties
    const newSchema = { ...schema, properties: rest }
    setSchema(newSchema)
    const names = schemaAlertNames(newSchema)
    setAlertNames(names)
    setActiveAlert(names.length > 0 ? names[0] : null)
    setDirty(true)
  }

  function handleAlertDefChange(newDef) {
    if (!activeAlert || !schema) return
    const newSchema = {
      ...schema,
      properties: { ...schema.properties, [activeAlert]: newDef }
    }
    setSchema(newSchema)
    setDirty(true)
  }

  const activeAlertDef = activeAlert ? schema?.properties?.[activeAlert] : null

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
          {/* YAML Preview */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8, background: '#fafafa' }}>
              <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Generated YAML</Text>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 11, color: '#8c8c8c' }}>Edit manually</Text>
                <Switch size="small" checked={editorEditable} onChange={setEditorEditable} />
              </div>
            </div>
            <div id="template-dev-cm" ref={editorRef} style={{ flex: 1, overflow: 'auto' }}>
              <style>{`#template-dev-cm .cm-editor { height: 100%; }`}</style>
            </div>
          </div>

          {/* Rule Builder Panel */}
          <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #f0f0f0' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8, background: '#fafafa' }}>
              <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Alert Group:</Text>
              {alertNames.length > 0 ? (
                <Select size="small" value={activeAlert} onChange={setActiveAlert} style={{ flex: 1 }}
                  options={alertNames.map(n => ({ value: n, label: n }))} />
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>No alert groups</Text>
              )}
              <Button size="small" icon={<PlusOutlined />} onClick={handleAddAlert} />
              {activeAlert && (
                <Button size="small" danger icon={<DeleteOutlined />} onClick={handleRemoveAlert} />
              )}
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <RuleBuilder alertDef={activeAlertDef} alertName={activeAlert} onChange={handleAlertDefChange} />
            </div>
          </div>
        </div>
      ) : (
        <Empty style={{ margin: 'auto' }} description="Select a chart or create a new one." />
      )}

      {activeChart && (
        <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa' }}>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
          {dirty && <Text type="warning" style={{ fontSize: 12 }}>Unsaved changes</Text>}
        </div>
      )}
    </div>
  )
}
