import { useState, useEffect, useCallback, useRef } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Modal, Typography, Empty, Input, Select, message } from 'antd'
import { SaveOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons'
import DeploymentTree from '../components/DeploymentTree'
import TemplateTree from '../components/TemplateTree'
import AlertTable from '../components/AlertTable'
import { schemaAlertNames, schemaToVars, getCommonVars } from '../utils/schemaUtils'
import {
  getChartInfo,
  getDeployment, saveDeployment,
  renderDeployment,
  listCharts,
  initDeploymentFolder
} from '../utils/chartApi'

const { Title, Text } = Typography

export default function AlertUserView() {
  const [selectedFolder, setSelectedFolder] = useSessionState('alerts:folder', null)
  const [selectedChart, setSelectedChart] = useSessionState('alerts:chart', null)
  const [activeAlert, setActiveAlert] = useSessionState('alerts:alert', null)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)

  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])

  const [allValues, setAllValues] = useState({})
  const [commonValues, setCommonValues] = useState({})
  const [rows, setRows] = useState([])
  const [vars, setVars] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')

  const [newDeployOpen, setNewDeployOpen] = useState(false)
  const [newDeployPath, setNewDeployPath] = useState('')
  const [newDeployChart, setNewDeployChart] = useState(null)
  const [availableCharts, setAvailableCharts] = useState([])

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
    if (!selectedChart) {
      setSchema(null)
      setAlertNames([])
      return
    }
    getChartInfo(selectedChart).then(info => {
      setSchema(info.schema)
      setAlertNames(schemaAlertNames(info.schema))
      if (activeAlert && activeAlert !== '__common_vars__' && !schemaAlertNames(info.schema).includes(activeAlert)) {
        setActiveAlert(null)
      }
    })
  }, [selectedChart])

  const folderBasename = selectedFolder ? selectedFolder.split('/').pop() : null

  useEffect(() => {
    if (!selectedChart || !selectedFolder) return
    getDeployment(selectedChart, folderBasename, selectedFolder).then(data => {
      const parsed = data.parsed || {}
      const { _common, ...rest } = parsed
      setCommonValues(_common || {})
      setAllValues(rest)
      if (activeAlert && activeAlert !== '__common_vars__') {
        setRows(rest[activeAlert] || [])
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
  }, [activeAlert, schema])

  async function handleNewDeployOpen() {
    const charts = await listCharts()
    setAvailableCharts(charts)
    setNewDeployPath(selectedFolder ? selectedFolder + '/' : '')
    setNewDeployChart(charts.length > 0 ? charts[0].name : null)
    setNewDeployOpen(true)
  }

  async function handleNewDeployCreate() {
    if (!newDeployPath || !newDeployChart) return
    const result = await initDeploymentFolder(newDeployPath, newDeployChart)
    setNewDeployOpen(false)
    if (result.status === 'created' || result.status === 'existing') {
      const chart = result.chart || newDeployChart
      setSelectedFolder(newDeployPath)
      setSelectedChart(chart)
      setActiveAlert(null)
      setTreeRefreshKey(k => k + 1)
      message.success(`Deployment created at ${newDeployPath}`)
    }
  }

  function handleFolderSelect({ path, chart }) {
    setSelectedFolder(path)
    setSelectedChart(chart)
    setActiveAlert(null)
    setAllValues({})
    setCommonValues({})
    setRows([])
    setDirty(false)
  }

  async function handleSave() {
    if (!selectedChart || !selectedFolder) return
    const isCommon = activeAlert === '__common_vars__'
    const merged = isCommon ? allValues : { ...allValues, [activeAlert]: rows }
    const toSave = Object.keys(commonValues).length > 0
      ? { _common: commonValues, ...merged }
      : merged
    const result = await saveDeployment(selectedChart, folderBasename, toSave, selectedFolder)
    if (!result.ok) {
      message.error('Save failed')
      return false
    }
    if (!isCommon) setAllValues(merged)
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    return true
  }

  async function handlePreview() {
    if (!selectedChart || !selectedFolder) return
    if (dirty) {
      const saved = await handleSave()
      if (!saved) return
    }
    const result = await renderDeployment(selectedChart, folderBasename, selectedFolder)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewOpen(true)
  }

  const sectionHeader = (text, action) => (
    <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af', borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      {text}
      {action}
    </div>
  )

  const isCommonView = activeAlert === '__common_vars__'
  const commonVarDefs = schema ? getCommonVars(schema) : []
  const showMain = selectedFolder && selectedChart && activeAlert

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: sidebarWidth, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflow: 'auto', background: '#fff', position: 'relative' }}>
        {sectionHeader('Deployments', <Button size="small" type="text" icon={<PlusOutlined />} onClick={handleNewDeployOpen} />)}
        <DeploymentTree
          selectedFolder={selectedFolder}
          onSelect={handleFolderSelect}
          refreshKey={treeRefreshKey}
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
              showCommonVars={getCommonVars(schema).length > 0}
              commonVarsLabel="Common Values"
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
              <Title level={4} style={{ margin: 0 }}>
                {selectedFolder} / {isCommonView ? 'Common Values' : activeAlert}
              </Title>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              {isCommonView ? (
                <div style={{ maxWidth: 500 }}>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
                    Values set here apply to all alert groups in this deployment.
                  </Text>
                  {commonVarDefs.map(v => (
                    <div key={v.name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                      <Text strong style={{ width: 120, fontSize: 13 }}>{v.name}</Text>
                      {v.enum ? (
                        <Select size="small" value={commonValues[v.name] ?? ''}
                          onChange={val => { setCommonValues({ ...commonValues, [v.name]: val }); setDirty(true) }}
                          style={{ flex: 1 }}
                          options={v.enum.map(opt => ({ value: opt, label: opt }))}
                          allowClear
                          onClear={() => { const { [v.name]: _, ...rest } = commonValues; setCommonValues(rest); setDirty(true) }}
                        />
                      ) : (
                        <Input size="small" value={commonValues[v.name] ?? ''}
                          onChange={e => {
                            if (e.target.value) {
                              setCommonValues({ ...commonValues, [v.name]: e.target.value }); setDirty(true)
                            } else {
                              const { [v.name]: _, ...rest } = commonValues; setCommonValues(rest); setDirty(true)
                            }
                          }}
                          style={{ flex: 1 }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <AlertTable
                  vars={vars}
                  rows={rows}
                  commonValues={commonValues}
                  onUpdate={updated => { setRows(updated); setDirty(true) }}
                  onDelete={idx => { setRows(rows.filter((_, i) => i !== idx)); setDirty(true) }}
                  onAdd={newRow => { setRows([...rows, newRow]); setDirty(true) }}
                />
              )}
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              {!isCommonView && <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>}
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
      <Modal title="New Deployment" open={newDeployOpen} onCancel={() => setNewDeployOpen(false)}
        onOk={handleNewDeployCreate} okText="Create"
        okButtonProps={{ disabled: !newDeployPath || !newDeployChart }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Folder Path</Text>
            <Input placeholder="deployments/my-app/production" value={newDeployPath}
              onChange={e => setNewDeployPath(e.target.value)} />
          </div>
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Chart</Text>
            <Select style={{ width: '100%' }} value={newDeployChart} onChange={setNewDeployChart}
              options={availableCharts.map(c => ({ value: c.name, label: c.name }))} />
          </div>
        </div>
      </Modal>
    </div>
  )
}
