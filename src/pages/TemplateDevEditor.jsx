import { useState, useEffect, useRef, useCallback } from 'react'
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

  // Load charts on mount
  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0 && !activeChart) setActiveChart(c[0].name)
    })
  }, [])

  // Load templates when chart changes
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

  // Load template content when selection changes
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

  // CodeMirror: destroy and recreate when template changes
  useEffect(() => {
    const key = `${activeChart}::${activeTemplate}`
    if (!editorRef.current || !activeTemplate) {
      // Destroy any existing view if no template selected
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
        editorKeyRef.current = ''
      }
      return
    }

    // Destroy old view
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
    editorKeyRef.current = key

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [activeChart, activeTemplate, /* re-init when content loads */])

  // Sync yamlContent into editor when it changes externally (template load)
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
    <div className="template-dev-layout">
      {/* Sidebar */}
      <div className="template-dev-sidebar">
        <ChartSelector
          charts={charts}
          activeChart={activeChart}
          onSelect={setActiveChart}
          onCreate={handleCreateChart}
        />
        <div className="template-dev-sidebar-section-header">Templates</div>
        <div className="template-dev-sidebar-tree">
          <TemplateTree
            templates={templates}
            activeTemplate={activeTemplate}
            onSelect={setActiveTemplate}
          />
        </div>
        {/* New template form */}
        {creating ? (
          <div className="inline-add" style={{ borderTop: '1px solid #e5e7eb', padding: '8px 12px' }}>
            <input
              type="text"
              value={newTemplateName}
              onChange={e => setNewTemplateName(e.target.value)}
              placeholder="template-name"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreateTemplate()}
            />
            <button className="btn btn-sm btn-primary" onClick={handleCreateTemplate} disabled={!newTemplateName.trim()}>
              Create
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => { setCreating(false); setNewTemplateName('') }}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ padding: '8px 12px', borderTop: '1px solid #e5e7eb' }}>
            <button className="btn btn-sm btn-secondary" style={{ width: '100%' }} onClick={() => setCreating(true)}>
              + New Template
            </button>
          </div>
        )}
      </div>

      {/* Main area */}
      <div className="template-dev-main">
        {activeTemplate ? (
          <>
            {/* Top bar */}
            <div className="template-dev-topbar">
              <span className="template-dev-title">{activeTemplate}</span>
              <input
                className="template-dev-desc"
                type="text"
                value={meta.description}
                onChange={handleDescChange}
                placeholder="Template description..."
              />
              <div className="template-dev-topbar-actions">
                <button className="btn btn-sm btn-danger" onClick={handleDelete}>Delete</button>
              </div>
            </div>

            {/* Split pane: editor + variables */}
            <div className="template-dev-split">
              <div className="template-dev-editor">
                <div className="template-dev-editor-header">PrometheusRule Template</div>
                <div className="template-dev-codemirror" ref={editorRef} />
              </div>
              <VariablesPanel vars={meta.vars || []} onChange={handleVarsChange} />
            </div>

            {/* Bottom bar */}
            <div className="template-dev-bottombar">
              <button className="btn btn-primary" onClick={handleSave}>Save</button>
              {dirty && <span className="text-muted">Unsaved changes</span>}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">&#128196;</div>
            <p>Select a template from the sidebar or create a new one to start editing.</p>
          </div>
        )}
      </div>
    </div>
  )
}
