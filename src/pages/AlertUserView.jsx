import { useState, useEffect, useCallback } from 'react'
import ChartSelector from '../components/ChartSelector'
import DeploymentSelector from '../components/DeploymentSelector'
import TemplateTree from '../components/TemplateTree'
import AlertTable from '../components/AlertTable'
import {
  listCharts, createChart, listChartTemplates, getChartTemplate,
  listDeployments, getDeployment, saveDeployment, cloneDeployment, renderDeployment
} from '../utils/chartApi'

export default function AlertUserView() {
  const [charts, setCharts]               = useState([])
  const [activeChart, setActiveChart]       = useState(null)
  const [templates, setTemplates]           = useState([])
  const [deployments, setDeployments]       = useState([])
  const [activeDeployment, setActiveDeployment] = useState(null)
  const [activeTemplate, setActiveTemplate] = useState(null)
  const [templateMeta, setTemplateMeta]     = useState(null)
  const [allValues, setAllValues]           = useState({})
  const [rows, setRows]                     = useState([])
  const [dirty, setDirty]                   = useState(false)
  const [saveStatus, setSaveStatus]         = useState('')

  // Load charts on mount
  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0) setActiveChart(c[0].name)
    })
  }, [])

  // When chart changes: load templates + deployments, clear selections
  useEffect(() => {
    if (!activeChart) return
    setActiveDeployment(null)
    setActiveTemplate(null)
    setTemplateMeta(null)
    setAllValues({})
    setRows([])
    setDirty(false)
    Promise.all([
      listChartTemplates(activeChart),
      listDeployments(activeChart)
    ]).then(([t, d]) => {
      setTemplates(t)
      setDeployments(d)
    })
  }, [activeChart])

  // When deployment changes: load values
  useEffect(() => {
    if (!activeChart || !activeDeployment) return
    getDeployment(activeChart, activeDeployment).then(dep => {
      const vals = dep.values || {}
      setAllValues(vals)
      if (activeTemplate) {
        setRows(vals[activeTemplate] || [])
      }
      setDirty(false)
    })
  }, [activeChart, activeDeployment])

  // When template changes: load meta, extract rows from allValues
  useEffect(() => {
    if (!activeChart || !activeTemplate) {
      setTemplateMeta(null)
      return
    }
    getChartTemplate(activeChart, activeTemplate).then(meta => {
      setTemplateMeta(meta)
    })
    setRows(allValues[activeTemplate] || [])
    setDirty(false)
  }, [activeChart, activeTemplate])

  const handleChartSelect = useCallback((name) => {
    setActiveChart(name)
  }, [])

  const handleChartCreate = useCallback(async (name) => {
    await createChart(name)
    const c = await listCharts()
    setCharts(c)
    setActiveChart(name)
  }, [])

  const handleDeploymentSelect = useCallback((name) => {
    setActiveDeployment(name)
  }, [])

  const handleDeploymentCreate = useCallback(async (name) => {
    await saveDeployment(activeChart, name, {})
    const d = await listDeployments(activeChart)
    setDeployments(d)
    setActiveDeployment(name)
  }, [activeChart])

  const handleDeploymentClone = useCallback(async (source, newName) => {
    await cloneDeployment(activeChart, source, newName)
    const d = await listDeployments(activeChart)
    setDeployments(d)
    setActiveDeployment(newName)
  }, [activeChart])

  const handleTemplateSelect = useCallback((name) => {
    setActiveTemplate(name)
  }, [])

  const handleSave = useCallback(async () => {
    if (!activeChart || !activeDeployment || !activeTemplate) return
    const merged = { ...allValues, [activeTemplate]: rows }
    await saveDeployment(activeChart, activeDeployment, merged)
    setAllValues(merged)
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    // fire and forget render
    renderDeployment(activeChart, activeDeployment)
    // refresh deployment list for counts
    listDeployments(activeChart).then(d => setDeployments(d))
  }, [activeChart, activeDeployment, activeTemplate, allValues, rows])

  // Empty state message
  const renderEmptyState = () => {
    if (!activeChart) return <div className="empty-state"><div className="empty-state-icon">📦</div><p>Select a chart to get started</p></div>
    if (!activeDeployment) return <div className="empty-state"><div className="empty-state-icon">📁</div><p>Select a deployment from the sidebar</p></div>
    if (!activeTemplate) return <div className="empty-state"><div className="empty-state-icon">📄</div><p>Select a template from the sidebar</p></div>
    return null
  }

  const showMain = activeChart && activeDeployment && activeTemplate

  return (
    <div className="alert-user-layout">
      <div className="alert-user-sidebar">
        <ChartSelector
          charts={charts}
          activeChart={activeChart}
          onSelect={handleChartSelect}
          onCreate={handleChartCreate}
        />

        <div className="alert-user-sidebar-section">
          <div className="alert-user-sidebar-section-header">Deployments</div>
          <DeploymentSelector
            deployments={deployments}
            activeDeployment={activeDeployment}
            onSelect={handleDeploymentSelect}
            onCreate={handleDeploymentCreate}
            onClone={handleDeploymentClone}
          />
        </div>

        <div className="alert-user-sidebar-section" style={{ flex: 1, overflow: 'auto' }}>
          <div className="alert-user-sidebar-section-header">Alert Templates</div>
          <TemplateTree
            templates={templates}
            activeTemplate={activeTemplate}
            onSelect={handleTemplateSelect}
          />
        </div>
      </div>

      <div className="alert-user-main">
        {showMain ? (
          <>
            <div className="alert-user-breadcrumb">
              <span className="alert-user-bc-deploy">{activeDeployment}</span>
              <span className="alert-user-bc-sep">/</span>
              <span className="alert-user-bc-template">{activeTemplate}</span>
            </div>
            <div className="alert-user-header">
              <h2>{activeTemplate}</h2>
              {templateMeta?.description && (
                <p className="text-muted">{templateMeta.description}</p>
              )}
            </div>
            <div className="alert-user-table-area">
              <AlertTable
                vars={templateMeta?.vars || []}
                rows={rows}
                onUpdate={updated => { setRows(updated); setDirty(true) }}
                onDelete={idx => { setRows(r => r.filter((_, i) => i !== idx)); setDirty(true) }}
                onAdd={newRow => { setRows(r => [...r, newRow]); setDirty(true) }}
              />
            </div>
            <div className="alert-user-bottombar">
              <button className="btn btn-primary" onClick={handleSave} disabled={!dirty}>
                Save
              </button>
              {saveStatus && <span className="text-muted">{saveStatus}</span>}
              {dirty && <span className="tag">Unsaved changes</span>}
            </div>
          </>
        ) : (
          renderEmptyState()
        )}
      </div>
    </div>
  )
}
