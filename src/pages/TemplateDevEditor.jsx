import { useState, useEffect, useRef, useCallback } from 'react'
import { Layout, Button, Input, Select, Empty, Typography } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import VariablesPanel from '../components/VariablesPanel'
import { schemaAlertNames, schemaToVars, updateSchemaAlert } from '../utils/schemaUtils'
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
  const [vars, setVars] = useState([])
  const [dirty, setDirty] = useState(false)
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
    setVars(names.length > 0 ? schemaToVars(s, names[0]) : [])
    setDirty(false)
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
    if (activeAlert && schema) {
      setVars(schemaToVars(schema, activeAlert))
    } else {
      setVars([])
    }
  }, [activeAlert])

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
    await saveChartSchema(activeChart, schema)
    await saveChartMeta(activeChart, chartMeta)
    if (activeFile) {
      await saveChartTemplateFile(activeChart, activeFile, fileContent)
    }
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
    await saveChartTemplateFile(activeChart, name, '')
    setTemplateFiles([...templateFiles, name])
    setActiveFile(name)
  }

  function handleAddAlert() {
    const name = prompt('Alert name (use underscores for grouping, e.g. mariadb_latency):')
    if (!name) return
    const newSchema = updateSchemaAlert(schema, name, [])
    setSchema(newSchema)
    setAlertNames(schemaAlertNames(newSchema))
    setActiveAlert(name)
    setVars([])
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

  function handleVarsChange(newVars) {
    if (!activeAlert) return
    const newSchema = updateSchemaAlert(schema, activeAlert, newVars)
    setSchema(newSchema)
    setVars(newVars)
    setDirty(true)
  }

  function handleSchemaChange(newSchema) {
    setSchema(newSchema)
    const names = schemaAlertNames(newSchema)
    setAlertNames(names)
    if (activeAlert && names.includes(activeAlert)) {
      setVars(schemaToVars(newSchema, activeAlert))
    } else if (names.length > 0) {
      setActiveAlert(names[0])
      setVars(schemaToVars(newSchema, names[0]))
    } else {
      setActiveAlert(null)
      setVars([])
    }
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
              <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #f0f0f0' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8, background: '#fafafa' }}>
                  <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Alert:</Text>
                  {alertNames.length > 0 ? (
                    <Select size="small" value={activeAlert} onChange={a => setActiveAlert(a)} style={{ flex: 1 }}
                      options={alertNames.map(n => ({ value: n, label: n }))} />
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>No alerts</Text>
                  )}
                  <Button size="small" icon={<PlusOutlined />} onClick={handleAddAlert} />
                  {activeAlert && (
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={handleRemoveAlert} />
                  )}
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <VariablesPanel vars={vars} onChange={handleVarsChange} schema={schema} onSchemaChange={handleSchemaChange} />
                </div>
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
