import { useState, useEffect, useCallback, useRef } from 'react'
import { Button, Modal, Typography, Empty } from 'antd'
import { SaveOutlined, EyeOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import DeploymentSelector from '../components/DeploymentSelector'
import TemplateTree from '../components/TemplateTree'
import AlertTable from '../components/AlertTable'
import { schemaAlertNames, schemaToVars } from '../utils/schemaUtils'
import {
  listCharts,
  getChartInfo,
  listDeployments, getDeployment, saveDeployment, cloneDeployment,
  renderDeployment
} from '../utils/chartApi'

const { Title, Text } = Typography

export default function AlertUserView() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [deployments, setDeployments] = useState([])
  const [activeDeployment, setActiveDeployment] = useState(null)
  const [activeAlert, setActiveAlert] = useState(null)
  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])
  const [allValues, setAllValues] = useState({})
  const [rows, setRows] = useState([])
  const [vars, setVars] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')
  const [chartDescription, setChartDescription] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const resizingRef = useRef(false)

  function handleResizeStart(e) {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX
    const startWidth = sidebarWidth
    function onMove(ev) {
      if (!resizingRef.current) return
      const clientX = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX
      const newWidth = Math.max(180, Math.min(450, startWidth + clientX - startX))
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

  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0) setActiveChart(c[0].name)
    })
  }, [])

  useEffect(() => {
    if (!activeChart) return
    setActiveDeployment(null)
    setActiveAlert(null)
    setAllValues({})
    setRows([])
    setDirty(false)
    Promise.all([
      getChartInfo(activeChart),
      listDeployments(activeChart)
    ]).then(([info, deps]) => {
      setSchema(info.schema)
      const names = schemaAlertNames(info.schema)
      setAlertNames(names)
      setChartDescription(info.chartMeta?.description || '')
      setDeployments(deps)
    })
  }, [activeChart])

  useEffect(() => {
    if (!activeChart || !activeDeployment) return
    getDeployment(activeChart, activeDeployment).then(data => {
      const parsed = data.parsed || {}
      setAllValues(parsed)
      if (activeAlert) {
        setRows(parsed[activeAlert] || [])
      }
      setDirty(false)
    })
  }, [activeChart, activeDeployment])

  useEffect(() => {
    if (!activeAlert || !schema) {
      setVars([])
      return
    }
    setVars(schemaToVars(schema, activeAlert))
    setRows(allValues[activeAlert] || [])
    setDirty(false)
  }, [activeAlert])

  async function handleSave() {
    if (!activeChart || !activeDeployment || !activeAlert) return
    const merged = { ...allValues, [activeAlert]: rows }
    await saveDeployment(activeChart, activeDeployment, merged)
    setAllValues(merged)
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
  }

  async function handlePreview() {
    if (!activeChart || !activeDeployment) return
    if (dirty) await handleSave()
    const result = await renderDeployment(activeChart, activeDeployment)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewOpen(true)
  }

  async function handleCreateDeployment(name) {
    if (!activeChart) return
    await saveDeployment(activeChart, name, {})
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
    setActiveDeployment(name)
  }

  async function handleClone(source, newName) {
    if (!activeChart) return
    await cloneDeployment(activeChart, source, newName)
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
    setActiveDeployment(newName)
  }

  const sectionHeader = (text) => (
    <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af', borderTop: '1px solid #f0f0f0' }}>
      {text}
    </div>
  )

  const showMain = activeChart && activeDeployment && activeAlert

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: sidebarWidth, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflow: 'auto', background: '#fff', position: 'relative' }}>
        <ChartSelector charts={charts} activeChart={activeChart} onSelect={setActiveChart} />
        {sectionHeader('Deployments')}
        <DeploymentSelector
          deployments={deployments}
          activeDeployment={activeDeployment}
          onSelect={setActiveDeployment}
          onCreate={handleCreateDeployment}
          onClone={handleClone}
        />
        {sectionHeader('Alert Templates')}
        <TemplateTree
          templates={alertNames}
          activeTemplate={activeAlert}
          onSelect={setActiveAlert}
        />
        {/* Resize handle */}
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
        {showMain ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
              <Title level={4} style={{ margin: 0 }}>{activeDeployment} / {activeAlert}</Title>
              {chartDescription && <Text type="secondary" style={{ fontSize: 13 }}>{chartDescription}</Text>}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              <AlertTable
                vars={vars}
                rows={rows}
                onUpdate={updated => { setRows(updated); setDirty(true) }}
                onDelete={idx => { setRows(rows.filter((_, i) => i !== idx)); setDirty(true) }}
                onAdd={newRow => { setRows([...rows, newRow]); setDirty(true) }}
              />
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>
              {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
            </div>
            <Modal title="Rendered PrometheusRule" open={previewOpen} onCancel={() => setPreviewOpen(false)}
              footer={null} width={800}>
              <pre style={{
                background: '#0f172a', color: '#7dd3fc', padding: 16, borderRadius: 8,
                fontSize: 12, fontFamily: 'monospace', maxHeight: 500, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all'
              }}>
                {previewYaml || 'No output'}
              </pre>
            </Modal>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }}
            description={
              !activeChart ? 'Select a chart to get started' :
              !activeDeployment ? 'Select a deployment from the sidebar' :
              'Select an alert template from the sidebar'
            } />
        )}
      </div>
    </div>
  )
}
