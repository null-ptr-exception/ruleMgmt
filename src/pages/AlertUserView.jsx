import { useState, useEffect, useRef } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Modal, Typography, Empty, Input, Select, message, Segmented } from 'antd'
import { SaveOutlined, EyeOutlined, PlusOutlined, TableOutlined, AppstoreOutlined, CloseOutlined } from '@ant-design/icons'
import DeploymentTree from '../components/DeploymentTree'
import TemplateTree from '../components/TemplateTree'
import OverviewTemplateTree from '../components/OverviewTemplateTree'
import AlertTable from '../components/AlertTable'
import AlertOverviewWorkspace from '../components/AlertOverviewWorkspace'
import { schemaAlertNames, schemaToVars, getCommonVars } from '../utils/schemaUtils'
import {
  getChartInfo,
  getDeployment, saveDeployment,
  renderDeployment,
  listCharts,
  initDeploymentFolder,
  getSyncSource
} from '../utils/chartApi'

const { Title, Text } = Typography

export default function AlertUserView() {
  const [selectedFolder, setSelectedFolder] = useSessionState('alerts:folder', null)
  const [selectedChart, setSelectedChart] = useSessionState('alerts:chart', null)
  const [activeAlert, setActiveAlert] = useSessionState('alerts:alert', null)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)
  const [mode, setMode] = useSessionState('alerts:mode', 'single')

  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])

  const [allValues, setAllValues] = useState({})
  const [commonValues, setCommonValues] = useState({})
  const [rows, setRows] = useState([])
  const [vars, setVars] = useState([])
  const [filters, setFilters] = useState({})
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')

  const [checkedAlerts, setCheckedAlerts] = useSessionState('alerts:overview:checked', [])

  const [frozenSource, setFrozenSource] = useState(null)

  const [newDeployOpen, setNewDeployOpen] = useState(false)
  const [newDeployPath, setNewDeployPath] = useState('')
  const [newDeployChart, setNewDeployChart] = useState(null)
  const [availableCharts, setAvailableCharts] = useState([])

  const [sidebarWidth, setSidebarWidth] = useState(300)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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

  // Reset UI state when the selected alert type or schema changes
  useEffect(() => {
    if (!activeAlert || !schema) {
      setVars([])
      return
    }
    setVars(schemaToVars(schema, activeAlert))
    setFilters({})
    setDirty(false)
  }, [activeAlert, schema])

  // Sync rows when allValues updates (e.g. after deployment fetch or overview save)
  useEffect(() => {
    if (!activeAlert) return
    setRows(allValues[activeAlert] || [])
  }, [activeAlert, allValues])

  async function handleNewDeployOpen() {
    const charts = await listCharts()
    setAvailableCharts(charts)
    setNewDeployPath(selectedFolder ? selectedFolder + '/' : '')
    setNewDeployChart(charts.length > 0 ? charts[0].name : null)
    setNewDeployOpen(true)
  }

  async function handleNewDeployCreate() {
    if (!newDeployPath || !newDeployChart) return
    // Creating a deployment jumps the workspace to it — same silent-discard
    // hazard as switching folders in the tree.
    if (dirty && !frozenSource && !(await confirmDiscardEdits())) return
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

  // Guards frozenSource against stale responses: rapid folder switches fire
  // overlapping getSyncSource calls, and a slower earlier response landing
  // last would freeze (or unfreeze) the wrong folder. Only the response for
  // the most recently requested folder is allowed to update state.
  const frozenSourceFolderRef = useRef(null)
  async function refreshFrozenSource(path) {
    frozenSourceFolderRef.current = path
    let source = null
    try {
      ;({ source } = await getSyncSource(path))
    } catch {
      // Transport failure — fall through to null. The server enforces
      // read-only on save regardless, so failing open here can't corrupt a
      // synced target; it just skips the banner until the next refresh.
    }
    if (frozenSourceFolderRef.current === path) setFrozenSource(source)
  }

  // Covers folders restored from session state, which never pass through
  // handleFolderSelect — without this a synced deployment restored on page
  // load would look editable until save time. handleFolderSelect keeps its
  // own call because reselecting the same folder doesn't re-fire this
  // effect (the ref check makes the duplicate fetch harmless).
  useEffect(() => {
    if (selectedFolder) refreshFrozenSource(selectedFolder)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder])

  // Unsaved edits live only in React state — switching folders resets them.
  // Gate the switch behind an explicit confirmation instead of discarding
  // silently. Frozen folders are skipped: their inputs are disabled, so a
  // lingering dirty flag there can't represent real unsaved work.
  function confirmDiscardEdits() {
    return new Promise(resolve => {
      Modal.confirm({
        title: 'Discard unsaved changes?',
        content: `${selectedFolder} has unsaved changes that will be lost if you leave without saving.`,
        okText: 'Discard',
        okButtonProps: { danger: true },
        cancelText: 'Keep editing',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
  }

  // Reload/close would silently drop unsaved edits the same way — warn via
  // the browser's native dialog (text is browser-controlled).
  useEffect(() => {
    if (!dirty || frozenSource) return
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, frozenSource])

  async function handleFolderSelect(selection) {
    // null = the selected deployment was deleted; reset instead of keeping
    // an editor open on content that no longer exists on disk.
    if (!selection) {
      frozenSourceFolderRef.current = null
      setSelectedFolder(null)
      setSelectedChart(null)
      setActiveAlert(null)
      setAllValues({})
      setCommonValues({})
      setRows([])
      setFilters({})
      setCheckedAlerts([])
      setDirty(false)
      setFrozenSource(null)
      return
    }
    if (dirty && !frozenSource && !(await confirmDiscardEdits())) return
    const { path, chart } = selection
    setSelectedFolder(path)
    setSelectedChart(chart)
    setActiveAlert(null)
    setAllValues({})
    setCommonValues({})
    setRows([])
    setFilters({})
    setCheckedAlerts([])
    setDirty(false)
    setFrozenSource(null)
    await refreshFrozenSource(path)
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

  async function handleOverviewSave() {
    if (!selectedChart || !selectedFolder) return
    const toSave = Object.keys(commonValues).length > 0
      ? { _common: commonValues, ...allValues }
      : allValues
    const result = await saveDeployment(selectedChart, folderBasename, toSave, selectedFolder)
    if (!result.ok) {
      message.error('Save failed')
      return
    }
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
  }

  async function handlePreview() {
    if (!selectedChart || !selectedFolder) return
    // A frozen (synced) deployment is read-only: its on-disk state is the
    // source of truth, so render that directly. Attempting the save-first
    // path would just bounce off the server's 409 read-only guard.
    if (dirty && !frozenSource) {
      const saved = await handleSave()
      if (!saved) return
    }
    const result = await renderDeployment(selectedChart, folderBasename, selectedFolder)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewOpen(true)
  }

  function getVars(alertName) {
    if (!schema) return []
    return schemaToVars(schema, alertName)
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
      <div style={{ width: sidebarCollapsed ? 0 : sidebarWidth, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflow: 'hidden', background: '#fff', position: 'relative', display: 'flex', flexDirection: 'column', transition: 'width 0.15s ease' }}>
        <div style={{ flexShrink: 0, overflowY: 'auto' }}>
          {sectionHeader('Deployments', <Button size="small" type="text" icon={<PlusOutlined />} onClick={handleNewDeployOpen} />)}
          <DeploymentTree
            selectedFolder={selectedFolder}
            onSelect={handleFolderSelect}
            refreshKey={treeRefreshKey}
            onSyncChange={() => {
              if (!selectedFolder) return
              refreshFrozenSource(selectedFolder)
            }}
          />
        </div>
        {selectedChart && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flexShrink: 0 }}>
              {sectionHeader('Alert Templates')}
              <div style={{ padding: '0 16px 4px', fontSize: 11, color: '#6b7280' }}>
                from <b>{selectedChart}</b>
              </div>
              <div style={{ padding: '4px 12px 8px' }}>
                <Segmented
                  size="small"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { label: 'Single', value: 'single', icon: <TableOutlined /> },
                    { label: 'Overview', value: 'overview', icon: <AppstoreOutlined /> },
                  ]}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {mode === 'single' ? (
                <div style={{ overflowY: 'auto', height: '100%' }}>
                  <TemplateTree
                    templates={alertNames}
                    activeTemplate={activeAlert}
                    onSelect={setActiveAlert}
                    showCommonVars={getCommonVars(schema).length > 0}
                    commonVarsLabel="Common Values"
                  />
                </div>
              ) : (
                <OverviewTemplateTree
                  templates={alertNames}
                  checked={checkedAlerts}
                  onCheckedChange={setCheckedAlerts}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Drag-to-resize track */}
      <div
        onMouseDown={e => { if (!sidebarCollapsed) handleResizeStart(e) }}
        onTouchStart={e => { if (!sidebarCollapsed) handleResizeStart(e) }}
        style={{ width: 5, flexShrink: 0, cursor: sidebarCollapsed ? 'default' : 'col-resize', zIndex: 10 }}
      />
      {/* Collapse / expand toggle — position:fixed so it stays in viewport regardless of scroll */}
      <div
        onClick={() => setSidebarCollapsed(c => !c)}
        style={{
          position: 'fixed', bottom: 20,
          left: sidebarCollapsed ? 0 : sidebarWidth,
          transition: 'left 0.15s ease',
          width: 16, height: 28, borderRadius: '0 4px 4px 0',
          background: '#d9d9d9', border: '1px solid #bfbfbf', borderLeft: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: '#8c8c8c', cursor: 'pointer',
          zIndex: 100, userSelect: 'none', touchAction: 'none',
        }}
      >{sidebarCollapsed ? '›' : '‹'}</div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
        {frozenSource && selectedFolder && (
          <div style={{ padding: '6px 20px', background: '#fff7e6', borderBottom: '1px solid #ffe7ba', fontSize: 12, color: '#ad6800' }}>
            Synced from <b>{frozenSource}</b> — read-only. Unlink from the sidebar to edit independently.
          </div>
        )}
        {mode === 'overview' && selectedFolder && selectedChart ? (
          <AlertOverviewWorkspace
            checkedAlerts={checkedAlerts}
            allValues={allValues}
            commonValues={commonValues}
            schema={schema}
            onAllValuesChange={updated => { setAllValues(updated); setDirty(true) }}
            onSave={handleOverviewSave}
            dirty={dirty}
            saveStatus={saveStatus}
            getVars={getVars}
            readOnly={!!frozenSource}
          />
        ) : showMain ? (
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
                          disabled={!!frozenSource}
                          onClear={() => { const { [v.name]: _, ...rest } = commonValues; setCommonValues(rest); setDirty(true) }}
                        />
                      ) : (
                        <Input size="small" value={commonValues[v.name] ?? ''}
                          disabled={!!frozenSource}
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
                  filters={filters}
                  onFiltersChange={setFilters}
                  onUpdate={updated => { setRows(updated); setDirty(true) }}
                  onDelete={realIndex => { setRows(rows.filter((_, i) => i !== realIndex)); setDirty(true) }}
                  onAdd={newRow => { setRows([...rows, newRow]); setDirty(true) }}
                  readOnly={!!frozenSource}
                />
              )}
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty || !!frozenSource}>Save</Button>
              {!isCommonView && <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>}
              {!isCommonView && Object.values(filters).some(f => f && f.value !== '' && f.value != null) && (
                <Button icon={<CloseOutlined />} size="small" type="text" style={{ color: '#1677ff' }} onClick={() => setFilters({})}>Clear filters</Button>
              )}
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
              mode === 'overview' ? 'Select alert types from the sidebar to get started' :
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
