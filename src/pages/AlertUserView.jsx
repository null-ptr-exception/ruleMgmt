import { useState, useEffect, useCallback, useRef } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Modal, Typography, Empty, message } from 'antd'
import { SaveOutlined, EyeOutlined } from '@ant-design/icons'
import DeploymentTree from '../components/DeploymentTree'
import TemplateTree from '../components/TemplateTree'
import AlertTable from '../components/AlertTable'
import { schemaAlertNames, schemaToVars } from '../utils/schemaUtils'
import {
  getChartInfo,
  getDeployment, saveDeployment,
  renderDeployment,
  getFolderTree
} from '../utils/chartApi'

const { Title, Text } = Typography

export default function AlertUserView() {
  const [folderTree, setFolderTree] = useState([])
  const [selectedFolder, setSelectedFolder] = useSessionState('alerts:folder', null)
  const [activeAlert, setActiveAlert] = useSessionState('alerts:alert', null)

  const [selectedChart, setSelectedChart] = useState(null)
  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])
  const [chartDescription, setChartDescription] = useState('')

  const [allValues, setAllValues] = useState({})
  const [rows, setRows] = useState([])
  const [vars, setVars] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')

  const [sidebarWidth, setSidebarWidth] = useState(300)
  const resizingRef = useRef(false)

  function handleResizeStart(e) {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX
    const startWidth = sidebarWidth
    function onMove(ev) {
      if (!resizingRef.current) return
      const clientX = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX
      const newWidth = Math.max(200, Math.min(500, startWidth + clientX - startX))
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
    getFolderTree().then(tree => {
      setFolderTree(tree)
      if (selectedFolder) {
        const chart = findChartInTree(tree, selectedFolder)
        if (chart) {
          setSelectedChart(chart)
        } else {
          setSelectedFolder(null)
        }
      }
    })
  }, [])

  useEffect(() => {
    if (!selectedChart) {
      setSchema(null)
      setAlertNames([])
      setChartDescription('')
      return
    }
    getChartInfo(selectedChart).then(info => {
      setSchema(info.schema)
      setAlertNames(schemaAlertNames(info.schema))
      setChartDescription(info.chartMeta?.description || '')
      if (activeAlert && !schemaAlertNames(info.schema).includes(activeAlert)) {
        setActiveAlert(null)
      }
    })
  }, [selectedChart])

  const folderBasename = selectedFolder ? selectedFolder.split('/').pop() : null

  useEffect(() => {
    if (!selectedChart || !selectedFolder) return
    getDeployment(selectedChart, folderBasename, selectedFolder).then(data => {
      const parsed = data.parsed || {}
      setAllValues(parsed)
      if (activeAlert) {
        setRows(parsed[activeAlert] || [])
      }
      setDirty(false)
    })
  }, [selectedChart, selectedFolder])

  useEffect(() => {
    if (!activeAlert || !schema) {
      setVars([])
      return
    }
    setVars(schemaToVars(schema, activeAlert))
    setRows(allValues[activeAlert] || [])
    setDirty(false)
  }, [activeAlert])

  function handleFolderSelect({ path, chart }) {
    setSelectedFolder(path)
    setSelectedChart(chart)
    setActiveAlert(null)
    setAllValues({})
    setRows([])
    setDirty(false)
  }

  async function handleSave() {
    if (!selectedChart || !selectedFolder || !activeAlert) return
    const merged = { ...allValues, [activeAlert]: rows }
    await saveDeployment(selectedChart, folderBasename, merged, selectedFolder)
    setAllValues(merged)
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
  }

  async function handlePreview() {
    if (!selectedChart || !selectedFolder) return
    if (dirty) await handleSave()
    const result = await renderDeployment(selectedChart, folderBasename, selectedFolder)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewOpen(true)
  }

  const sectionHeader = (text) => (
    <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af', borderTop: '1px solid #f0f0f0' }}>
      {text}
    </div>
  )

  const showMain = selectedFolder && selectedChart && activeAlert

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: sidebarWidth, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflow: 'auto', background: '#fff', position: 'relative' }}>
        {sectionHeader('Deployments')}
        <DeploymentTree
          folderTree={folderTree}
          selectedFolder={selectedFolder}
          onSelect={handleFolderSelect}
        />
        {selectedChart && (
          <>
            {sectionHeader(`Alert Templates`)}
            <div style={{ padding: '0 16px 4px', fontSize: 11, color: '#6b7280' }}>
              from <b>{selectedChart}</b>
            </div>
            <TemplateTree
              templates={alertNames}
              activeTemplate={activeAlert}
              onSelect={setActiveAlert}
            />
          </>
        )}
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
              <Title level={4} style={{ margin: 0 }}>{selectedFolder} / {activeAlert}</Title>
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
              !selectedFolder ? 'Select a deployment from the folder tree' :
              !activeAlert ? 'Select an alert template from the sidebar' :
              'Loading...'
            } />
        )}
      </div>
    </div>
  )
}

function findChartInTree(nodes, targetPath) {
  for (const node of nodes) {
    if (node.path === targetPath && node.isDeployment) return node.chart
    if (node.children) {
      const found = findChartInTree(node.children, targetPath)
      if (found) return found
    }
  }
  return null
}
