import { useState, useEffect, useRef, useCallback } from 'react'
import { Layout, Button, Input, Empty, Typography } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import TemplateTree from '../components/TemplateTree'
import VariablesPanel from '../components/VariablesPanel'
import {
  listCharts, createChart, listChartTemplates,
  getChartTemplate, saveChartTemplate, deleteChartTemplate
} from '../utils/chartApi'

import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

const { Sider, Content } = Layout
const { Title, Text } = Typography

const yamlExtension = StreamLanguage.define(yaml)

const SCAFFOLD_YAML = `# New PrometheusRule template
groups:
  - name: example
    rules:
      - alert: ExampleAlert
        expr: up == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Instance {{ $labels.instance }} down"
`

export default function TemplateDevEditor() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState('')
  const [templates, setTemplates] = useState([])
  const [activeTemplate, setActiveTemplate] = useState('')
  const [yamlContent, setYamlContent] = useState('')
  const [meta, setMeta] = useState({ description: '', vars: [] })
  const [dirty, setDirty] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')

  const editorRef = useRef(null)
  const viewRef = useRef(null)
  const editorKeyRef = useRef('')

  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0 && !activeChart) setActiveChart(c[0].name)
    })
  }, [])

  useEffect(() => {
    if (!activeChart) return
    listChartTemplates(activeChart).then(t => {
      setTemplates(t)
      setActiveTemplate('')
      setYamlContent('')
      setMeta({ description: '', vars: [] })
      setDirty(false)
    })
  }, [activeChart])

  useEffect(() => {
    if (!activeChart || !activeTemplate) return
    getChartTemplate(activeChart, activeTemplate).then(data => {
      setYamlContent(data.content || '')
      setMeta({
        description: data.meta?.description || '',
        vars: data.meta?.vars || []
      })
      setDirty(false)
    })
  }, [activeChart, activeTemplate])

  useEffect(() => {
    if (!editorRef.current || !activeTemplate) {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
        editorKeyRef.current = ''
      }
      return
    }

    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    const extensions = [
      basicSetup,
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          const doc = update.state.doc.toString()
          setYamlContent(doc)
          setDirty(true)
        }
      })
    ]
    if (yamlExtension) extensions.push(yamlExtension)

    const state = EditorState.create({
      doc: yamlContent,
      extensions
    })

    viewRef.current = new EditorView({
      state,
      parent: editorRef.current
    })
    editorKeyRef.current = `${activeChart}::${activeTemplate}`

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [activeChart, activeTemplate])

  useEffect(() => {
    if (!viewRef.current) return
    const current = viewRef.current.state.doc.toString()
    if (current !== yamlContent) {
      viewRef.current.dispatch({
        changes: { from: 0, to: current.length, insert: yamlContent },
      })
    }
  }, [yamlContent])

  const handleSave = useCallback(async () => {
    if (!activeChart || !activeTemplate) return
    await saveChartTemplate(activeChart, activeTemplate, yamlContent, meta)
    const t = await listChartTemplates(activeChart)
    setTemplates(t)
    setDirty(false)
  }, [activeChart, activeTemplate, yamlContent, meta])

  const handleDelete = useCallback(async () => {
    if (!activeChart || !activeTemplate) return
    if (!confirm(`Delete template "${activeTemplate}"?`)) return
    await deleteChartTemplate(activeChart, activeTemplate)
    setActiveTemplate('')
    setYamlContent('')
    setMeta({ description: '', vars: [] })
    setDirty(false)
    const t = await listChartTemplates(activeChart)
    setTemplates(t)
  }, [activeChart, activeTemplate])

  const handleCreateTemplate = useCallback(async () => {
    const name = newTemplateName.trim()
    if (!name || !activeChart) return
    await saveChartTemplate(activeChart, name, SCAFFOLD_YAML, { description: '', vars: [] })
    const t = await listChartTemplates(activeChart)
    setTemplates(t)
    setActiveTemplate(name)
    setNewTemplateName('')
    setCreating(false)
  }, [activeChart, newTemplateName])

  const handleCreateChart = useCallback(async (name) => {
    await createChart(name)
    const c = await listCharts()
    setCharts(c)
    setActiveChart(name)
  }, [])

  const handleVarsChange = useCallback((vars) => {
    setMeta(prev => ({ ...prev, vars }))
    setDirty(true)
  }, [])

  const handleDescChange = useCallback((e) => {
    setMeta(prev => ({ ...prev, description: e.target.value }))
    setDirty(true)
  }, [])

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={260} theme="light" style={{ borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ChartSelector
          charts={charts}
          activeChart={activeChart}
          onSelect={setActiveChart}
          onCreate={handleCreateChart}
        />
        <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c', borderBottom: '1px solid #f0f0f0', borderTop: '1px solid #f0f0f0' }}>
          Templates
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <TemplateTree
            templates={templates}
            activeTemplate={activeTemplate}
            onSelect={setActiveTemplate}
          />
        </div>
        {creating ? (
          <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px 12px' }}>
            <Input
              size="small"
              value={newTemplateName}
              onChange={e => setNewTemplateName(e.target.value)}
              placeholder="template-name"
              autoFocus
              onPressEnter={handleCreateTemplate}
              style={{ marginBottom: 4 }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              <Button size="small" type="primary" onClick={handleCreateTemplate} disabled={!newTemplateName.trim()}>Create</Button>
              <Button size="small" onClick={() => { setCreating(false); setNewTemplateName('') }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div style={{ padding: '8px 12px', borderTop: '1px solid #f0f0f0' }}>
            <Button block size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              New Template
            </Button>
          </div>
        )}
      </Sider>

      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activeTemplate ? (
          <>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Title level={4} style={{ margin: 0 }}>{activeTemplate}</Title>
              <Input
                value={meta.description}
                onChange={handleDescChange}
                placeholder="Template description..."
                variant="borderless"
                style={{ flex: 1, color: '#8c8c8c' }}
              />
              <Button danger size="small" icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
            </div>

            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '8px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c', borderBottom: '1px solid #f0f0f0', fontWeight: 600, background: '#fafafa' }}>
                  PrometheusRule Template
                </div>
                <div ref={editorRef} style={{ flex: 1, overflow: 'auto' }} className="template-dev-codemirror" />
              </div>
              <VariablesPanel vars={meta.vars || []} onChange={handleVarsChange} />
            </div>

            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>Save</Button>
              {dirty && <Text type="warning" style={{ fontSize: 12 }}>Unsaved changes</Text>}
            </div>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }} description="Select a template from the sidebar or create a new one to start editing." />
        )}
      </Content>
    </Layout>
  )
}
