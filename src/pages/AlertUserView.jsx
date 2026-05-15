import { useState, useEffect, useCallback } from 'react'
import { Layout, Button, Breadcrumb, Typography, Tag, Empty, Divider } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import DeploymentSelector from '../components/DeploymentSelector'
import TemplateTree from '../components/TemplateTree'
import AlertTable from '../components/AlertTable'
import {
  listCharts, createChart, listChartTemplates, getChartTemplate,
  listDeployments, getDeployment, saveDeployment, cloneDeployment, renderDeployment
} from '../utils/chartApi'

const { Sider, Content } = Layout
const { Title, Text } = Typography

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

  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0) setActiveChart(c[0].name)
    })
  }, [])

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

  useEffect(() => {
    if (!activeChart || !activeDeployment) return
    getDeployment(activeChart, activeDeployment).then(dep => {
      const vals = dep.parsed || {}
      setAllValues(vals)
      if (activeTemplate) {
        setRows(vals[activeTemplate] || [])
      }
      setDirty(false)
    })
  }, [activeChart, activeDeployment])

  useEffect(() => {
    if (!activeChart || !activeTemplate) {
      setTemplateMeta(null)
      return
    }
    getChartTemplate(activeChart, activeTemplate).then(data => {
      setTemplateMeta(data.meta || {})
    })
    setRows(allValues[activeTemplate] || [])
    setDirty(false)
  }, [activeChart, activeTemplate])

  const handleChartSelect = useCallback((name) => { setActiveChart(name) }, [])
  const handleChartCreate = useCallback(async (name) => {
    await createChart(name)
    const c = await listCharts()
    setCharts(c)
    setActiveChart(name)
  }, [])

  const handleDeploymentSelect = useCallback((name) => { setActiveDeployment(name) }, [])
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

  const handleTemplateSelect = useCallback((name) => { setActiveTemplate(name) }, [])

  const handleSave = useCallback(async () => {
    if (!activeChart || !activeDeployment || !activeTemplate) return
    const merged = { ...allValues, [activeTemplate]: rows }
    await saveDeployment(activeChart, activeDeployment, merged)
    setAllValues(merged)
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    renderDeployment(activeChart, activeDeployment)
    listDeployments(activeChart).then(d => setDeployments(d))
  }, [activeChart, activeDeployment, activeTemplate, allValues, rows])

  const showMain = activeChart && activeDeployment && activeTemplate

  const sectionHeader = (text) => (
    <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c', borderTop: '1px solid #f0f0f0' }}>
      {text}
    </div>
  )

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={260} theme="light" style={{ borderRight: '1px solid #f0f0f0', overflow: 'auto' }}>
        <ChartSelector
          charts={charts}
          activeChart={activeChart}
          onSelect={handleChartSelect}
          onCreate={handleChartCreate}
        />
        {sectionHeader('Deployments')}
        <DeploymentSelector
          deployments={deployments}
          activeDeployment={activeDeployment}
          onSelect={handleDeploymentSelect}
          onCreate={handleDeploymentCreate}
          onClone={handleDeploymentClone}
        />
        {sectionHeader('Alert Templates')}
        <TemplateTree
          templates={templates}
          activeTemplate={activeTemplate}
          onSelect={handleTemplateSelect}
        />
      </Sider>
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {showMain ? (
          <>
            <div style={{ padding: '8px 20px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
              <Breadcrumb items={[
                { title: activeDeployment },
                { title: activeTemplate },
              ]} />
            </div>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0' }}>
              <Title level={4} style={{ margin: 0 }}>{activeTemplate}</Title>
              {templateMeta?.description && (
                <Text type="secondary">{templateMeta.description}</Text>
              )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              <AlertTable
                vars={templateMeta?.vars || []}
                rows={rows}
                onUpdate={updated => { setRows(updated); setDirty(true) }}
                onDelete={idx => { setRows(r => r.filter((_, i) => i !== idx)); setDirty(true) }}
                onAdd={newRow => { setRows(r => [...r, newRow]); setDirty(true) }}
              />
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>
                Save
              </Button>
              {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
              {dirty && <Tag color="warning">Unsaved changes</Tag>}
            </div>
          </>
        ) : (
          <Empty
            style={{ margin: 'auto' }}
            description={
              !activeChart ? 'Select a chart to get started' :
              !activeDeployment ? 'Select a deployment from the sidebar' :
              'Select a template from the sidebar'
            }
          />
        )}
      </Content>
    </Layout>
  )
}
