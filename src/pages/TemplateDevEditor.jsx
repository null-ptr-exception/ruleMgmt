import { useState, useEffect, useRef, useCallback } from 'react'
import { Layout, Button, Input, Select, Empty, Typography } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import VariablesPanel from '../components/VariablesPanel'
import { schemaToVars, varsToSchema } from '../utils/schemaUtils'
import {
  listCharts, createChart, deleteChart,
  getChartInfo, getChartTemplateFile, saveChartTemplateFile,
  saveChartSchema, saveChartMeta, deleteChartTemplate
} from '../utils/chartApi'

import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

const { Sider, Content } = Layout
const { Title, Text } = Typography

const yamlExtension = StreamLanguage.define(yaml)

function generateHelmTemplate(alertName, description, expr, vars) {
  const varNames = vars.map(v => v.name)
  const hasVars = varNames.length > 0

  let rulesBlock = ''
  if (hasVars) {
    const labelLines = varNames
      .filter(v => !['severity', 'for'].includes(v))
      .map(v => `            ${v}: {{ $inst.${v} | quote }}`)
      .join('\n')

    rulesBlock = `        {{- range .Values.instances }}
        {{- $inst := . }}
        - alert: ${alertName || '{{ $inst.name }}'}
          expr: ${expr || 'up == 0'}
          for: {{ $inst.for | default "5m" }}
          labels:
            severity: {{ $inst.severity | default "warning" }}
${labelLines ? labelLines + '\n' : ''}          annotations:
            description: ${description || '{{ $inst.name }} alert fired'}
            summary: ${alertName || '{{ $inst.name }}'}
        {{- end }}`
  } else {
    rulesBlock = `        - alert: ${alertName || 'ExampleAlert'}
          expr: ${expr || 'up == 0'}
          for: 5m
          labels:
            severity: warning
          annotations:
            description: ${description || 'Alert fired'}
            summary: ${alertName || 'ExampleAlert'}`
  }

  return `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Release.Name }}-rules
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  groups:
    - name: {{ .Release.Name }}
      rules:
${rulesBlock}
`
}

export default function TemplateDevEditor() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [chartMeta, setChartMeta] = useState({})
  const [templateFiles, setTemplateFiles] = useState([])
  const [activeFile, setActiveFile] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [schema, setSchema] = useState(null)
  const [vars, setVars] = useState([])
  const [dirty, setDirty] = useState(false)
  const [alertName, setAlertName] = useState('')
  const [description, setDescription] = useState('')
  const [expr, setExpr] = useState('')
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
    setSchema(info.schema)
    setVars(schemaToVars(info.schema))
    setDirty(false)
    setAlertName('')
    setDescription('')
    setExpr('')
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

  useEffect(() => {
    if (!editorRef.current) return
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }
    if (!activeFile) return

    const extensions = [
      basicSetup,
      yamlExtension,
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          setFileContent(update.state.doc.toString())
          setDirty(true)
        }
      }),
    ]

    const state = EditorState.create({ doc: fileContent, extensions })
    viewRef.current = new EditorView({ state, parent: editorRef.current })

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [activeChart, activeFile])

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
    const newSchema = varsToSchema(vars)
    await saveChartSchema(activeChart, newSchema)
    await saveChartMeta(activeChart, chartMeta)
    if (activeFile) {
      await saveChartTemplateFile(activeChart, activeFile, fileContent)
    }
    setSchema(newSchema)
    setDirty(false)
  }

  async function handleCreateChart(name) {
    await createChart(name)
    await loadCharts()
    setActiveChart(name)
  }

  async function handleDelete() {
    if (!activeChart) return
    if (!confirm(`Delete chart "${activeChart}"?`)) return
    await deleteChart(activeChart)
    setActiveChart(null)
    await loadCharts()
  }

  async function handleAddFile() {
    const name = prompt('Template file name (without .yaml):')
    if (!name || !activeChart) return
    const content = generateHelmTemplate(alertName, description, expr, vars)
    await saveChartTemplateFile(activeChart, name, content)
    setTemplateFiles([...templateFiles, name])
    setActiveFile(name)
  }

  function handleGenerateTemplate() {
    const content = generateHelmTemplate(alertName, description, expr, vars)
    setFileContent(content)
    setDirty(true)
  }

  function handleVarsChange(newVars) {
    setVars(newVars)
    setDirty(true)
  }

  function handleSchemaChange(newSchema) {
    setSchema(newSchema)
    setVars(schemaToVars(newSchema))
    setDirty(true)
  }

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={260} theme="light" style={{ borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ChartSelector charts={charts} activeChart={activeChart} onSelect={setActiveChart} onCreate={handleCreateChart} />
      </Sider>
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activeChart ? (
          <>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Title level={5} style={{ margin: 0 }}>{chartMeta.name || activeChart}</Title>
              <Input size="small" placeholder="Description" value={chartMeta.description || ''}
                onChange={e => { setChartMeta({ ...chartMeta, description: e.target.value }); setDirty(true) }}
                style={{ flex: 1, maxWidth: 400 }} />
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
                <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
              </div>
            </div>

            <div style={{ padding: '10px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', gap: 12, alignItems: 'flex-end', background: '#fafafa' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Alert name pattern</Text>
                <Input size="small" placeholder='e.g. tablespace-{{ $severity }}-{{ $inst.db_name }}' value={alertName}
                  onChange={e => setAlertName(e.target.value)} style={{ width: 300, fontFamily: 'monospace', fontSize: 12 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Expr template</Text>
                <Input size="small" placeholder='e.g. tablespace_usage{db="{{ $inst.db_name }}"} > {{ $inst.threshold }}' value={expr}
                  onChange={e => setExpr(e.target.value)} style={{ width: 400, fontFamily: 'monospace', fontSize: 12 }} />
              </div>
              <Button size="small" onClick={handleGenerateTemplate}>Generate template</Button>
            </div>

            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8, background: '#fafafa' }}>
                  <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Template file:</Text>
                  {templateFiles.length > 0 ? (
                    <Select size="small" value={activeFile} onChange={setActiveFile} style={{ width: 200 }}
                      options={templateFiles.map(f => ({ value: f, label: `${f}.yaml` }))} />
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>No template files</Text>
                  )}
                  <Button size="small" icon={<PlusOutlined />} onClick={handleAddFile}>Add file</Button>
                </div>
                <div id="template-dev-cm" ref={editorRef} style={{ flex: 1, overflow: 'auto' }}>
                  <style>{`#template-dev-cm .cm-editor { height: 100%; }`}</style>
                </div>
              </div>
              <div style={{ width: 320, flexShrink: 0 }}>
                <VariablesPanel vars={vars} onChange={handleVarsChange} schema={schema} onSchemaChange={handleSchemaChange} />
              </div>
            </div>

            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              {dirty && <Text type="warning" style={{ fontSize: 12 }}>Unsaved changes</Text>}
            </div>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }} description="Select a chart from the sidebar or create a new one." />
        )}
      </Content>
    </Layout>
  )
}
