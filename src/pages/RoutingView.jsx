import { useState, useEffect, useRef } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Alert, Button, Empty, Modal, Segmented, Space, Typography, message } from 'antd'
import { SaveOutlined, EyeOutlined, DeleteOutlined, EditOutlined, AppstoreOutlined, UnorderedListOutlined, ShareAltOutlined } from '@ant-design/icons'
import DeploymentTree from '../components/DeploymentTree'
import NotificationConfigs from '../components/NotificationConfigs'
import SharedConfigs from '../components/SharedConfigs'
import RoutesMatrix, { describeMatch } from '../components/RoutesMatrix'
import RoutesList from '../components/RoutesList'
import { TimingFields, GroupByField, PendingNames, usePendingNames } from '../components/RoutingTiming'
import RoutingLabelsModal from '../components/RoutingLabelsModal'
import RoutingMergeConflicts from '../components/RoutingMergeConflicts'
import PreviewModal from '../components/PreviewModal'
import { parseRouting, emptyRouting, reshapeLabels, setDefaultTiming, toSave, GROUP_BY } from '../utils/routingModel'
import { getRouting, saveRouting, removeRouting, renderDeployment, getSyncSource, getSharedConfigs } from '../utils/chartApi'
import { ROUTING } from '../utils/outputs'
import { syncFailedNotice } from '../utils/syncNotice'

const { Title, Text } = Typography

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
  // Taking a label away where cells differ: the dialog's rows, and what to
  // ask (#94).
  const [merge, setMerge] = useState(null)
  // Labels added since the last save: alerts without them now match no cell.
  const [addedLabels, setAddedLabels] = useState([])
  const [frozenSource, setFrozenSource] = useState(null)
  // Why sync.yaml cannot be read: whether this is a sync target is not
  // known, so nothing is offered to edit.
  const [syncUnknown, setSyncUnknown] = useState(null)
  const [preview, setPreview] = useState(null)
  // Grid or list; unset follows the labels — a list from three on.
  const [view, setView] = useState(null)
  // groupBy names typed and not entered yet: Save takes them.
  const pending = usePendingNames()
  // What is on screen is the file again: no edit, no name left typed.
  function forgetEdits() {
    setDirty(false)
    pending.clear()
  }
  // The repo's shared notification configs (#123): their own page, and what
  // a deployment's `{ shared: true }` stands for.
  const [showShared, setShowShared] = useSessionState('routing:shared', false)
  const [shared, setShared] = useState(null)

  useEffect(() => {
    if (showShared) return
    let stale = false
    // A failed read is said, not left looking like one still loading.
    getSharedConfigs().then(s => { if (!stale) setShared(s) })
    return () => { stale = true }
  }, [showShared, selectedFolder, reloadKey])

  const deployment = selectedFolder ? selectedFolder.split('/').pop() : null
  const readOnly = !!frozenSource || !!syncUnknown

  // Reads routing.yaml and puts it on the page. Only the latest read lands:
  // one for a folder left since, or started before another, is dropped.
  const loadSeq = useRef(0)
  // The folder on screen now: a save's answer for one left since is not put
  // on the page, nor its "Saved at".
  const shownFolder = useRef(selectedFolder)
  shownFolder.current = selectedFolder
  async function loadRouting() {
    const seq = ++loadSeq.current
    const state = await getRouting(selectedChart, deployment, selectedFolder)
    if (seq !== loadSeq.current) return
    if (state === null) {
      setLoaded({ none: true })
      setRouting(null)
      forgetEdits()
      setAddedLabels([])
    } else if (state.error) {
      setLoaded({ error: state.error, file: state.file, unreadable: state.unreadable })
    } else {
      setLoaded(state)
      forgetEdits()
      setAddedLabels([])
      // Only a file that passes the server's checks is edited here (#158):
      // the page never writes one that fails, so a failing file came from
      // elsewhere (a hand edit, a merge, a sync) and is fixed by hand.
      if (state.errors?.length) {
        setRouting(null)
      } else {
        try {
          setRouting(parseRouting(state.text))
        } catch (err) {
          setRouting(null)
          setLoaded({ ...state, errors: [`routing.yaml is not valid YAML: ${err.reason || err.message}`] })
        }
      }
    }
  }

  useEffect(() => {
    if (!selectedFolder || !selectedChart) return
    loadRouting()
    return () => { loadSeq.current++ }
  }, [selectedChart, selectedFolder])

  // Only the latest folder's answer may freeze or unfreeze the page.
  const frozenFolderRef = useRef(null)
  async function refreshFrozenSource(path) {
    frozenFolderRef.current = path
    let source = null
    let unknown = null
    try {
      const read = await getSyncSource(path)
      if (read.failed) unknown = read.error
      else source = read.source
    } catch { /* the server refuses a save to a target regardless */ }
    if (frozenFolderRef.current === path) {
      setFrozenSource(source)
      setSyncUnknown(unknown)
    }
  }
  useEffect(() => {
    if (selectedFolder) refreshFrozenSource(selectedFolder)
  }, [selectedFolder])

  // An edit not saved yet: a change to the table, or a groupBy name typed
  // and not entered (which Save would add).
  const unsaved = dirty || pending.any()
  useEffect(() => {
    if (!unsaved || readOnly) return
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved, readOnly])

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

  async function openShared() {
    const waited = await afterSaveInFlight()
    if (waited === false) return
    if (!waited && unsaved && !readOnly && !(await confirmDiscardEdits())) return
    forgetEdits()
    setShowShared(true)
  }

  async function handleFolderSelect(selection) {
    setShowShared(false)
    if (!selection) {
      setSelectedFolder(null)
      setSelectedChart(null)
      setRouting(null)
      setLoaded(null)
      forgetEdits()
      return
    }
    const waited = await afterSaveInFlight()
    if (waited === false) return
    if (!waited && unsaved && !readOnly && !(await confirmDiscardEdits())) return
    setAddedLabels([])
    if (selection.path !== selectedFolder) {
      setLoaded(null)
      setRouting(null)
      setSaveStatus('')
      setView(null)
    }
    forgetEdits()
    setSelectedFolder(selection.path)
    setSelectedChart(selection.chart)
    setFrozenSource(null)
    await refreshFrozenSource(selection.path)
  }

  function edit(next) {
    setRouting(next)
    setDirty(true)
  }

  async function applyLabels(rows, keep = {}) {
    const current = routing || emptyRouting()
    const result = reshapeLabels(current, rows, { keep })
    if (result.conflicts) {
      const names = Object.keys(current.labels).filter(n => !rows.some(r => r.was === n))
      setMerge({ rows, conflicts: result.conflicts, labels: names })
      return
    }
    const { routing: next, dropped, added, renamed, removed } = result
    // The merge dialog stays open behind this question: Cancel goes back to
    // it with the choices still made.
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
    setMerge(null)
    setLabelsOpen(false)
    // The labels added since the last save, as they are named now: one taken
    // away again is no longer added, one renamed is under its new name. A
    // routing never saved, or a table with no cell filled, has routed
    // nothing yet.
    if (!loaded?.none) {
      setAddedLabels(a => [...new Set([...a.filter(n => !removed.includes(n)).map(n => renamed[n] ?? n),
        ...(current.cells.length ? added : [])])])
    }
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

  // The source was written; a sync target that was not is named. True when
  // there was one.
  function warnSyncFailed(result, done) {
    const notice = syncFailedNotice(result.syncFailed, done)
    if (notice) message.warning({ content: notice, duration: 10 })
    return !!notice
  }

  // From Save (or Remove) until routing.yaml has been read again, the page
  // takes no edits and no second save: the file read after the save is put
  // on the page, and would throw away an edit made meanwhile — also one made
  // after "Saved at" while that read is still on its way. A ref, so a double
  // click sees the first.
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(null)
  async function oneSaveAtATime(save) {
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    const sent = save()
    saveInFlight.current = sent
    try {
      return await sent
    } finally {
      savingRef.current = false
      saveInFlight.current = null
      setSaving(false)
    }
  }
  // Leaving while a save is on its way waits for it: the edits are being
  // saved, not discarded, so there is nothing to ask. null when no save was
  // on its way; else whether it went through (a failed one keeps the page).
  async function afterSaveInFlight() {
    const sent = saveInFlight.current
    if (!sent) return null
    try {
      return !!(await sent)
    } catch {
      return false
    }
  }

  const handleSave = () => oneSaveAtATime(saveNow)
  async function saveNow() {
    // A groupBy name typed and not entered is saved too, or stops the save.
    let current = routing
    let typed = false
    if (pending.any()) {
      const taken = pending.take(routing)
      if (taken.problems.length) {
        reportSaveFailure({ error: 'A groupBy name typed cannot be saved', problems: taken.problems })
        return false
      }
      typed = taken.routing !== routing
      if (typed) { current = taken.routing; edit(current) }
    }
    // Nothing edited but the resource is out of date: send the file as it
    // is, so its comments stay.
    const body = dirty || typed ? toSave(current) : loaded.text
    const folder = selectedFolder
    const result = await saveRouting(selectedChart, deployment, folder, body)
    if (!result.ok) {
      reportSaveFailure(result)
      return false
    }
    if (shownFolder.current !== folder) {
      // Another deployment is open now: it was not this save's.
      message.success(`${folder}'s routing saved`)
      warnSyncFailed(result)
      return true
    }
    setAddedLabels([])
    warnSyncFailed(result)
    if (result.warnings?.length) message.warning({ content: `Saved. ${result.warnings.join(' ')}`, duration: 10 })
    setReloadKey(k => k + 1)
    await loadRouting()
    if (shownFolder.current === folder) setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    return true
  }

  async function handleRemove() {
    const ok = await confirm({
      title: 'Remove routing?',
      content: `Deletes ${selectedFolder}'s routing.yaml and its AlertmanagerConfig. Its alerts are then routed by whatever else the Alertmanager is configured with.`,
      okText: 'Remove',
    })
    if (!ok) return
    await oneSaveAtATime(async () => {
      const folder = selectedFolder
      const result = await removeRouting(selectedChart, deployment, folder)
      if (!result.ok) {
        reportSaveFailure(result)
        return false
      }
      if (!warnSyncFailed(result, 'Routing removed')) message.success('Routing removed')
      if (shownFolder.current !== folder) return true
      setReloadKey(k => k + 1)
      await loadRouting()
      return true
    })
  }

  async function handlePreview() {
    const folder = selectedFolder
    if (unsaved && !readOnly && !(await handleSave())) return
    if (shownFolder.current !== folder) return
    const result = await renderDeployment(selectedChart, deployment, selectedFolder)
    setPreview({ output: result.ok ? routingDocs(result.output) || 'No AlertmanagerConfig rendered' : `Error: ${result.error || 'Unknown error'}` })
  }

  const isNew = loaded?.none && routing
  // A routing.yaml on disk that fails the checks: only Remove is offered.
  const broken = !routing && !!loaded?.errors?.length
  const hasTable = routing && Object.keys(routing.labels).length > 0
  const canSave = !readOnly && !saving && hasTable && (unsaved || loaded?.stale)
  // Nothing is edited while a save is on its way (oneSaveAtATime).
  const locked = readOnly || saving
  const shownView = view || (routing && Object.keys(routing.labels).length >= 3 ? 'list' : 'grid')
  // A sync target's Save is off: it is made again from its source (#179).
  const staleAlert = frozenSource
    ? (
      <Alert type="warning" showIcon data-testid="routing-stale"
        message={<>This routing is not its source's ({' '}
          <a data-testid="routing-stale-source" onClick={() => handleFolderSelect({ path: frozenSource, chart: selectedChart })}>{frozenSource}</a>
          {' '}) — commit from the Git panel and use Regenerate there, which copies the source's again.</>} />
    )
    : (
      <Alert type="warning" showIcon data-testid="routing-stale"
        message="The AlertmanagerConfig is not what routing.yaml says — Save to generate it again." />
    )

  function main() {
    if (showShared) return <SharedConfigs />
    if (!selectedFolder) return <Empty style={{ margin: 'auto' }} description="Select a deployment from the folder tree" />
    if (!loaded) return <Empty style={{ margin: 'auto' }} description="Loading..." />
    // A resource left without its routing.yaml is still deployed: it can
    // be removed here, as routing is.
    if (loaded.error) {
      return (
        <Empty style={{ margin: 'auto' }} description={<span data-testid="routing-error">{loaded.error}</span>}>
          {loaded.file && !loaded.unreadable && !readOnly && (
            <Button danger icon={<DeleteOutlined />} data-testid="routing-orphan-remove" disabled={saving} onClick={handleRemove}>Remove routing</Button>
          )}
        </Empty>
      )
    }
    if (loaded.none && !routing) {
      return (
        <Empty style={{ margin: 'auto' }} description={
          <>
            <div>No notification routing for this deployment.</div>
            <Text type="secondary" style={{ fontSize: 12 }}>Its alerts go wherever the Alertmanager sends them by default.</Text>
          </>
        }>
          <Button type="primary" disabled={locked} onClick={() => setLabelsOpen(true)}>Set up routing</Button>
        </Empty>
      )
    }
    // routing.yaml fails the checks: no table to show, or to save over the
    // file. Remove routing stays, in the footer.
    if (!routing) {
      return (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="error" showIcon data-testid="routing-problems" message="routing.yaml has problems — fix it by hand"
            description={<ul style={{ paddingLeft: 18, margin: 0 }}>{(loaded.errors || []).map((e, i) => <li key={i}>{e}</li>)}</ul>} />
          {loaded.stale && staleAlert}
        </Space>
      )
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1100 }}>
        {loaded.stale && !dirty && staleAlert}
        {loaded.warnings?.length > 0 && (
          <Alert type="warning" showIcon data-testid="routing-warnings" message="Saved — worth knowing about these configs"
            description={<ul style={{ paddingLeft: 18, margin: 0 }}>{loaded.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>} />
        )}
        <section>
          <Title level={5} style={{ marginTop: 0 }}>Notify</Title>
          <NotificationConfigs routing={routing} onChange={edit} readOnly={locked} describeMatch={describeMatch} shared={shared} />
        </section>
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Title level={5} style={{ margin: 0 }}>Routes</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>by {Object.keys(routing.labels).join(', ') || '—'}</Text>
            <Button size="small" type="text" icon={<EditOutlined />} disabled={locked} onClick={() => setLabelsOpen(true)}>Labels</Button>
            <span style={{ flex: 1 }} />
            {hasTable && (
              <Segmented size="small" value={shownView} onChange={setView} aria-label="Routes view"
                options={[
                  { label: 'Grid', value: 'grid', icon: <AppstoreOutlined /> },
                  { label: 'List', value: 'list', icon: <UnorderedListOutlined /> },
                ]} />
            )}
          </div>
          {addedLabels.length > 0 && (
            <Alert type="warning" showIcon closable data-testid="routing-labels-added" style={{ marginBottom: 8 }}
              onClose={() => setAddedLabels([])}
              message={`Alerts without ${addedLabels.join(' or ')} — or with a value not listed — now match no cell, and nobody here is notified of them.`}
              description="Every cell was copied to each new value, so alerts that carry one of them still go where they did." />
          )}
          {!hasTable
            ? <Text type="secondary">Name the labels to route by first.</Text>
            : shownView === 'list'
              ? <RoutesList routing={routing} onChange={edit} readOnly={locked} />
              : <RoutesMatrix routing={routing} onChange={edit} readOnly={locked} />}
        </section>
        <section data-testid="routing-defaults">
          <Title level={5} style={{ marginTop: 0 }}>Timing</Title>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            For every cell, unless the cell overrides it (the clock in a cell; a filled clock overrides). An empty one is the platform Alertmanager's.
          </Text>
          <TimingFields values={routing.defaults || {}} readOnly={locked} prefix="default "
            onChange={(key, value) => edit(setDefaultTiming(routing, key, value))} />
          <div style={{ marginTop: 6, maxWidth: 520 }}>
            <GroupByField value={routing.defaults?.[GROUP_BY]} readOnly={locked} label={`default ${GROUP_BY}`}
              onChange={list => edit(setDefaultTiming(routing, GROUP_BY, list))}
              current={r => r.defaults?.[GROUP_BY]} put={(r, list) => setDefaultTiming(r, GROUP_BY, list)} />
          </div>
        </section>
      </div>
    )
  }

  return (
    <PendingNames.Provider value={pending}>
      <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
        <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflowY: 'auto', background: '#fff' }}>
          <div style={{ padding: '10px 16px 0' }}>
            <Button block type={showShared ? 'primary' : 'default'} icon={<ShareAltOutlined />} onClick={openShared}>Shared configs</Button>
          </div>
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
          {!showShared && syncUnknown && selectedFolder && (
            <Alert data-testid="sync-unknown" type="error" banner showIcon style={{ fontSize: 12 }}
              message={`${syncUnknown}: whether this deployment is synced from another is not known, so it cannot be edited here.`} />
          )}
          {!showShared && frozenSource && selectedFolder && (
            <div style={{ padding: '6px 20px', background: '#fff7e6', borderBottom: '1px solid #ffe7ba', fontSize: 12, color: '#ad6800' }}>
              Synced from <b>{frozenSource}</b> — read-only. Unlink from the sidebar to edit independently.
            </div>
          )}
          {!showShared && selectedFolder && (
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
              <Title level={4} style={{ margin: 0 }}>{selectedFolder} / Routing</Title>
            </div>
          )}
          <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column' }}>
            {main()}
          </div>
          {!showShared && routing && (
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!canSave}>Save</Button>
              {!isNew && <Button icon={<EyeOutlined />} onClick={handlePreview} disabled={saving}>Preview</Button>}
              {(saving || saveStatus) && <Text type="secondary" style={{ fontSize: 12 }}>{saving ? 'Saving…' : saveStatus}</Text>}
              <span style={{ flex: 1 }} />
              {isNew
                ? <Button disabled={saving} onClick={() => { setRouting(null); forgetEdits() }}>Cancel</Button>
                : <Button danger icon={<DeleteOutlined />} disabled={locked} onClick={handleRemove}>Remove routing</Button>}
            </div>
          )}
          {!showShared && broken && (
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <span style={{ flex: 1 }} />
              <Button danger icon={<DeleteOutlined />} disabled={locked} onClick={handleRemove}>Remove routing</Button>
            </div>
          )}
        </div>

        {labelsOpen && (
          <RoutingLabelsModal open labels={routing?.labels} onCancel={() => setLabelsOpen(false)} onOk={applyLabels}
            title={routing ? 'Route by labels' : 'Set up routing'} />
        )}
        {merge && (
          <RoutingMergeConflicts conflicts={merge.conflicts} labels={merge.labels}
            onCancel={() => setMerge(null)} onOk={keep => applyLabels(merge.rows, keep)} />
        )}
        <PreviewModal
          open={!!preview}
          onClose={() => setPreview(null)}
          yaml={preview?.output || ''}
          heading={`${ROUTING.kind}, as Helm renders it`}
        />
      </div>
    </PendingNames.Provider>
  )
}
