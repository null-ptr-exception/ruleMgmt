import { useState, useEffect, useRef } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Alert, Button, Empty, Modal, Typography, message } from 'antd'
import { SaveOutlined, EyeOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import DeploymentTree from '../components/DeploymentTree'
import NotificationConfigs from '../components/NotificationConfigs'
import RoutesMatrix from '../components/RoutesMatrix'
import RoutingLabelsModal from '../components/RoutingLabelsModal'
import PreviewModal from '../components/PreviewModal'
import { parseRouting, emptyRouting, setLabels, toSave } from '../utils/routingModel'
import { getRouting, saveRouting, removeRouting, renderDeployment, getSyncSource } from '../utils/chartApi'
import { ROUTING } from '../utils/outputs'

const { Title, Text } = Typography

const describeMatch = match => Object.entries(match).map(([k, v]) => `${k}=${v}`).join(', ')

// Of everything the deployment renders, the routing resource: the rules have
// their own Preview on Alerts.
const routingDocs = output => output.split(/^---$/m)
  .filter(doc => new RegExp(`^kind: ${ROUTING.kind}$`, 'm').test(doc))
  .map(doc => `---${doc}`).join('').trim()

/**
 * Routing (#93): who is notified, per folder deployment, as a table. Reads
 * and writes routing.yaml through #92's endpoints; the AlertmanagerConfig is
 * regenerated on every save. A synced target is read-only, as on Alerts.
 */
export default function RoutingView() {
  const [selectedFolder, setSelectedFolder] = useSessionState('routing:folder', null)
  const [selectedChart, setSelectedChart] = useSessionState('routing:chart', null)
  const [treeRefreshKey] = useState(0)

  // `loaded`: what the server has — null while reading, { none } when the
  // deployment has no routing.yaml, { error } when it cannot have one.
  const [loaded, setLoaded] = useState(null)
  const [routing, setRouting] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [saveStatus, setSaveStatus] = useState('')
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [frozenSource, setFrozenSource] = useState(null)
  const [preview, setPreview] = useState(null)

  const deployment = selectedFolder ? selectedFolder.split('/').pop() : null
  const readOnly = !!frozenSource

  useEffect(() => {
    if (!selectedFolder || !selectedChart) return
    let stale = false
    getRouting(selectedChart, deployment, selectedFolder).then(state => {
      if (stale) return
      if (state === null) {
        setLoaded({ none: true })
        setRouting(null)
        setDirty(false)
      } else if (state.error) {
        setLoaded({ error: state.error })
      } else {
        setLoaded(state)
        setDirty(false)
        try {
          setRouting(parseRouting(state.text))
        } catch (err) {
          setLoaded({ ...state, errors: [`routing.yaml is not valid YAML: ${err.reason || err.message}`] })
        }
      }
    })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChart, selectedFolder, reloadKey])

  // Only the latest folder's answer may freeze or unfreeze the page.
  const frozenFolderRef = useRef(null)
  async function refreshFrozenSource(path) {
    frozenFolderRef.current = path
    let source = null
    try {
      ;({ source } = await getSyncSource(path))
    } catch { /* the server refuses a save to a target regardless */ }
    if (frozenFolderRef.current === path) setFrozenSource(source)
  }
  useEffect(() => {
    if (selectedFolder) refreshFrozenSource(selectedFolder)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder])

  useEffect(() => {
    if (!dirty || readOnly) return
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, readOnly])

  function confirm({ title, content, okText, danger = true, cancelText }) {
    return new Promise(resolve => {
      Modal.confirm({
        title, content, okText, cancelText,
        okButtonProps: { danger },
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
  }

  const confirmDiscardEdits = () => confirm({
    title: 'Discard unsaved changes?',
    content: `${selectedFolder}'s routing has unsaved changes that will be lost if you leave without saving.`,
    okText: 'Discard',
    cancelText: 'Keep editing',
  })

  async function handleFolderSelect(selection) {
    if (!selection) {
      setSelectedFolder(null)
      setSelectedChart(null)
      setRouting(null)
      setLoaded(null)
      setDirty(false)
      return
    }
    if (dirty && !readOnly && !(await confirmDiscardEdits())) return
    if (selection.path !== selectedFolder) {
      setLoaded(null)
      setRouting(null)
      setSaveStatus('')
    }
    setDirty(false)
    setSelectedFolder(selection.path)
    setSelectedChart(selection.chart)
    setFrozenSource(null)
    await refreshFrozenSource(selection.path)
  }

  function edit(next) {
    setRouting(next)
    setDirty(true)
  }

  async function applyLabels(labels) {
    const { routing: next, dropped } = setLabels(routing || emptyRouting(), labels)
    if (dropped.length) {
      const ok = await confirm({
        title: `${dropped.length} filled cell${dropped.length > 1 ? 's are' : ' is'} no longer in the table`,
        content: (
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            {dropped.map((c, i) => <li key={i}>{describeMatch(c.match)} → {c.configs.join(', ')}</li>)}
          </ul>
        ),
        okText: 'Remove them',
      })
      if (!ok) return
    }
    setLabelsOpen(false)
    edit(next)
  }

  function reportSaveFailure(result) {
    Modal.error({
      title: result.error || 'Save failed',
      width: 560,
      content: result.problems?.length
        ? <ul style={{ paddingLeft: 18, marginTop: 8 }}>{result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        : null,
    })
  }

  async function handleSave() {
    // Nothing edited but the resource is out of date: send the file as it
    // is, so its comments stay.
    const body = dirty ? toSave(routing) : loaded.text
    const result = await saveRouting(selectedChart, deployment, selectedFolder, body)
    if (!result.ok) {
      reportSaveFailure(result)
      return false
    }
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    setReloadKey(k => k + 1)
    return true
  }

  async function handleRemove() {
    const ok = await confirm({
      title: 'Remove routing?',
      content: `Deletes ${selectedFolder}'s routing.yaml and its AlertmanagerConfig. Its alerts are then routed by whatever else the Alertmanager is configured with.`,
      okText: 'Remove',
    })
    if (!ok) return
    const result = await removeRouting(selectedChart, deployment, selectedFolder)
    if (!result.ok) {
      reportSaveFailure(result)
      return
    }
    message.success('Routing removed')
    setReloadKey(k => k + 1)
  }

  async function handlePreview() {
    if (dirty && !readOnly && !(await handleSave())) return
    const result = await renderDeployment(selectedChart, deployment, selectedFolder)
    setPreview({ output: result.ok ? routingDocs(result.output) || 'No AlertmanagerConfig rendered' : `Error: ${result.error || 'Unknown error'}` })
  }

  const isNew = loaded?.none && routing
  const hasTable = routing && Object.keys(routing.labels).length > 0
  const canSave = !readOnly && hasTable && (dirty || loaded?.stale)

  function main() {
    if (!selectedFolder) return <Empty style={{ margin: 'auto' }} description="Select a deployment from the folder tree" />
    if (!loaded) return <Empty style={{ margin: 'auto' }} description="Loading..." />
    if (loaded.error) return <Empty style={{ margin: 'auto' }} description={loaded.error} />
    if (loaded.none && !routing) {
      return (
        <Empty style={{ margin: 'auto' }} description={
          <>
            <div>No notification routing for this deployment.</div>
            <Text type="secondary" style={{ fontSize: 12 }}>Its alerts go wherever the Alertmanager sends them by default.</Text>
          </>
        }>
          <Button type="primary" disabled={readOnly} onClick={() => setLabelsOpen(true)}>Set up routing</Button>
        </Empty>
      )
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1100 }}>
        {loaded.errors?.length > 0 && (
          <Alert type="error" showIcon data-testid="routing-problems" message="routing.yaml has problems — fix them here, or by hand"
            description={<ul style={{ paddingLeft: 18, margin: 0 }}>{loaded.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>} />
        )}
        {loaded.stale && !dirty && (
          <Alert type="warning" showIcon data-testid="routing-stale"
            message="The AlertmanagerConfig is not what routing.yaml says — Save to generate it again." />
        )}
        <section>
          <Title level={5} style={{ marginTop: 0 }}>Notify</Title>
          <NotificationConfigs routing={routing} onChange={edit} readOnly={readOnly} describeMatch={describeMatch} />
        </section>
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Title level={5} style={{ margin: 0 }}>Routes</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>by {Object.keys(routing.labels).join(', ') || '—'}</Text>
            <Button size="small" type="text" icon={<EditOutlined />} disabled={readOnly} onClick={() => setLabelsOpen(true)}>Labels</Button>
          </div>
          {hasTable
            ? <RoutesMatrix routing={routing} onChange={edit} readOnly={readOnly} />
            : <Text type="secondary">Name the labels to route by first.</Text>}
        </section>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflowY: 'auto', background: '#fff' }}>
        <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af' }}>
          Deployments
        </div>
        <DeploymentTree
          selectedFolder={selectedFolder}
          onSelect={handleFolderSelect}
          refreshKey={treeRefreshKey}
          onSyncChange={() => selectedFolder && refreshFrozenSource(selectedFolder)}
        />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
        {frozenSource && selectedFolder && (
          <div style={{ padding: '6px 20px', background: '#fff7e6', borderBottom: '1px solid #ffe7ba', fontSize: 12, color: '#ad6800' }}>
            Synced from <b>{frozenSource}</b> — read-only. Unlink from the sidebar to edit independently.
          </div>
        )}
        {selectedFolder && (
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
            <Title level={4} style={{ margin: 0 }}>{selectedFolder} / Routing</Title>
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column' }}>
          {main()}
        </div>
        {routing && (
          <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!canSave}>Save</Button>
            {!isNew && <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>}
            {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
            <span style={{ flex: 1 }} />
            {isNew
              ? <Button onClick={() => { setRouting(null); setDirty(false) }}>Cancel</Button>
              : <Button danger icon={<DeleteOutlined />} disabled={readOnly} onClick={handleRemove}>Remove routing</Button>}
          </div>
        )}
      </div>

      {labelsOpen && (
        <RoutingLabelsModal open labels={routing?.labels} onCancel={() => setLabelsOpen(false)} onOk={applyLabels}
          title={routing ? 'Route by labels' : 'Set up routing'} />
      )}
      <PreviewModal
        open={!!preview}
        onClose={() => setPreview(null)}
        yaml={preview?.output || ''}
        heading={`${ROUTING.kind}, as Helm renders it`}
      />
    </div>
  )
}
