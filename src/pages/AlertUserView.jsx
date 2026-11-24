import { useState, useEffect, useRef } from 'react'
import useSessionState from '../hooks/useSessionState'
import { Button, Modal, Typography, Empty, Input, Select, message, Segmented, Alert, Tooltip, Tag } from 'antd'
import { SaveOutlined, EyeOutlined, PlusOutlined, TableOutlined, AppstoreOutlined, CloseOutlined } from '@ant-design/icons'
import DeploymentTree from '../components/DeploymentTree'
import TemplateTree from '../components/TemplateTree'
import OverviewTemplateTree from '../components/OverviewTemplateTree'
import AlertTable, { RequiredMark } from '../components/AlertTable'
import { isMissingRequired, buildNewRow } from '../utils/valueUtils'
import { durationCellFault } from '../utils/duration'
import AlertOverviewWorkspace from '../components/AlertOverviewWorkspace'
import PreviewModal from '../components/PreviewModal'
import { schemaAlertNames, schemaToVars, getCommonVars } from '../utils/schemaUtils'
import { pruneAllValues } from '../utils/valueUtils'
import { parseRulesDir } from '../utils/rulesFile'
import { isReservedName, RESERVED_HINT, isCommonChartPath, COMMON_DIR } from '../utils/reservedNames'
import { renamedSelectorLabels } from '../utils/selectorContract'
import { syncFailedNotice } from '../utils/syncNotice'
import {
  getChartInfo,
  getDeployment, saveDeployment,
  renderDeployment,
  listCharts,
  initDeploymentFolder,
  getSyncSource,
  getCommonUsers
} from '../utils/chartApi'

const { Title, Text } = Typography

/** The defaults of a group's selector columns, _common's included (#60). */
function selectorDefaultsOf(model, group) {
  const entry = model?.groups?.[group]
  if (!entry?.selectors) return {}
  const cols = { ...(model.common?.columns || {}), ...(entry.columns || {}) }
  return Object.fromEntries(entry.selectors.filter(l => cols[l]?.default !== undefined).map(l => [l, cols[l].default]))
}

export default function AlertUserView() {
  const [selectedFolder, setSelectedFolder] = useSessionState('alerts:folder', null)
  const [selectedChart, setSelectedChart] = useSessionState('alerts:chart', null)
  const [activeAlert, setActiveAlert] = useSessionState('alerts:alert', null)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)
  const [mode, setMode] = useSessionState('alerts:mode', 'single')

  const [schema, setSchema] = useState(null)
  const [onceGroups, setOnceGroups] = useState([])
  // The chart's rules model — for once groups (#70) and selectors (#60).
  const [rulesModel, setRulesModel] = useState(null)
  const [alertNames, setAlertNames] = useState([])

  const [allValues, setAllValues] = useState({})
  const [commonValues, setCommonValues] = useState({})
  // What a deployment on a _common inherits (#102): `{ values, from }`, the
  // values its layers give and which _common gives each; null when none.
  const [inherited, setInherited] = useState(null)
  // What the page was loaded from: a save sends it, and one changed since
  // (a _common made or removed underneath, another save) is refused (#102).
  const [loadedVersion, setLoadedVersion] = useState(null)
  // What keeps Helm from rendering it as shown: a _common that cannot be read, a link gone.
  const [stackProblems, setStackProblems] = useState(null)
  // The _common it renders on, and its folder's (#103).
  const [stackInfo, setStackInfo] = useState(null)
  const [unusedValuesFile, setUnusedValuesFile] = useState(null)
  const [rows, setRows] = useState([])
  const [vars, setVars] = useState([])
  const [filters, setFilters] = useState({})
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [saveWarnings, setSaveWarnings] = useState([])
  // What Helm reads otherwise than the file looks (010 is 8): shown as Helm reads it, and said.
  const [readNotes, setReadNotes] = useState([])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')
  const [previewCheck, setPreviewCheck] = useState(null)
  const [previewSelfCheck, setPreviewSelfCheck] = useState(null)
  const [previewSummary, setPreviewSummary] = useState(null)
  const [previewValueWarnings, setPreviewValueWarnings] = useState(null)

  const [checkedAlerts, setCheckedAlerts] = useSessionState('alerts:overview:checked', [])
  // Deployments of the selected chart viewed together in Overview (#91), in
  // the order they were checked. The selected deployment is always one of
  // them; any other list (left from another selection) means just it.
  const [viewedPaths, setViewedPaths] = useSessionState('alerts:overview:deployments', [])
  const [viewedValues, setViewedValues] = useState({})
  const [viewedFailed, setViewedFailed] = useState([])
  const [viewedRetry, setViewedRetry] = useState(0)
  // Bumped to re-read the selected deployment after its edits are discarded.
  const [reloadKey, setReloadKey] = useState(0)

  const [frozenSource, setFrozenSource] = useState(null)
  // Why the deployment's values cannot be read, when they cannot: nothing is
  // shown to edit or save over.
  const [loadError, setLoadError] = useState(null)

  const [newDeployOpen, setNewDeployOpen] = useState(false)
  const [newDeployPath, setNewDeployPath] = useState('')
  const [newDeployChart, setNewDeployChart] = useState(null)
  const [availableCharts, setAvailableCharts] = useState([])

  const [mainScrollContainer, setMainScrollContainer] = useState(null)

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
      // A once group (#70) has no rows and so no entry in the schema; it is
      // listed from the chart's rules/ so the rule owner sees it exists.
      let once = []
      let parsed = null
      try {
        parsed = parseRulesDir(info.rulesFiles || {}).model
        once = Object.entries(parsed.groups).filter(([, g]) => g.once).map(([k]) => k)
      } catch { /* an unparseable rules/ is the template owner's to fix */ }
      setRulesModel(parsed)
      const names = [...schemaAlertNames(info.schema), ...once]
      setSchema(info.schema)
      setOnceGroups(once)
      setAlertNames(names)
      if (activeAlert && activeAlert !== '__common_vars__' && !names.includes(activeAlert)) {
        setActiveAlert(null)
      }
    })
  }, [selectedChart])

  const folderBasename = selectedFolder ? selectedFolder.split('/').pop() : null
  // A folder's _common (#101) opens in the same editor; its page says who
  // inherits from it, and how much.
  const onCommon = !!selectedFolder && isCommonChartPath(selectedFolder)
  const [commonUsers, setCommonUsers] = useState(null)
  const [usersKey, setUsersKey] = useState(0)
  useEffect(() => {
    setCommonUsers(null)
    if (!onCommon) return
    let stale = false
    getCommonUsers(selectedFolder).then(users => { if (!stale) setCommonUsers(users) })
    return () => { stale = true }
  }, [onCommon, selectedFolder, usersKey])

  useEffect(() => {
    if (!selectedChart || !selectedFolder) return
    // A slower answer for the folder just left must not land on this one.
    let stale = false
    setUnusedValuesFile(null)
    getDeployment(selectedChart, folderBasename, selectedFolder).then(data => {
      if (stale) return
      setLoadError(data.failed && data.status !== 404 ? data.error || 'The values cannot be read' : null)
      setUnusedValuesFile(data.unusedFile || null)
      setInherited(data.inherited || null)
      setStackInfo(data.stack || null)
      setStackProblems(data.stackProblems || null)
      setLoadedVersion(data.version || null)
      setReadNotes((data.findings || []).filter(f => f.code === 'yaml.read-differently').map(f => f.message))
      const parsed = data.parsed || {}
      const { _common, ...rest } = parsed
      setCommonValues(_common || {})
      setAllValues(rest)
      if (activeAlert && activeAlert !== '__common_vars__') {
        setRows(rest[activeAlert] || [])
      }
      setDirty(false)
    })
    return () => { stale = true }
  }, [selectedChart, selectedFolder, reloadKey])

  // The _common a group is inherited from, or null: a group no layer gives
  // (or a deployment with no _common) is the deployment's own, as before.
  const inheritedFrom = group => {
    const from = inherited?.from?.groups?.[group]?.from
    return from && from !== 'own' && from !== 'template' ? from : null
  }
  const inheritedCommon = inherited?.values?._common || {}
  const commonFrom = inherited?.from?.common || {}

  const viewed = selectedFolder && viewedPaths.includes(selectedFolder) ? viewedPaths : (selectedFolder ? [selectedFolder] : [])
  const multi = mode === 'overview' && viewed.length > 1
  const viewedKey = viewed.join('\n')

  // Several deployments are read from disk, the selected one included: they
  // are only viewed, and its unsaved edits were discarded to get here.
  useEffect(() => {
    if (!multi) {
      setViewedValues({})
      setViewedFailed([])
      return
    }
    let stale = false
    const missing = viewed.filter(p => !viewedValues[p])
    // A failed read is not cached: it would show as an empty deployment.
    Promise.all(missing.map(p => getDeployment(selectedChart, p.split('/').pop(), p)
      .then(data => {
        if (!data.parsed) return [p, null]
        const { _common, ...rest } = data.parsed
        return [p, { values: rest, commonValues: _common || {} }]
      })
      .catch(() => [p, null])))
      .then(entries => {
        if (stale) return
        const loaded = entries.filter(([, v]) => v)
        if (loaded.length) setViewedValues(v => ({ ...v, ...Object.fromEntries(loaded) }))
        setViewedFailed(entries.filter(([, v]) => !v).map(([p]) => p))
      })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, viewedKey, selectedChart, viewedRetry])

  const viewedDeployments = multi && viewed.every(p => viewedValues[p])
    ? viewed.map(p => ({ path: p, ...viewedValues[p] }))
    : null

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

  // After creating a deployment, if the chart has a required common variable
  // with no default, land on the Common Values page — Helm would otherwise
  // reject the deployment on save and the rule owner has no reason to look
  // under COMMON VARIABLES on their own.
  const pendingCommonCheckRef = useRef(false)
  useEffect(() => {
    if (!pendingCommonCheckRef.current || !schema) return
    pendingCommonCheckRef.current = false
    const unmet = getCommonVars(schema).some(
      v => v.required && v.default === undefined && !(v.name in commonValues) && !(v.name in inheritedCommon)
    )
    if (unmet) setActiveAlert('__common_vars__')
  }, [schema, commonValues])

  async function handleNewDeployOpen() {
    const charts = await listCharts()
    setAvailableCharts(charts)
    setNewDeployPath(selectedFolder ? selectedFolder + '/' : '')
    setNewDeployChart(charts.length > 0 ? charts[0].name : null)
    setNewDeployOpen(true)
  }

  // The deployment being created is the last segment; a reserved one is
  // refused (#99). An existing folder higher up is the server's to judge.
  const newDeployReserved = isReservedName(newDeployPath.split('/').filter(Boolean).pop())

  async function handleNewDeployCreate() {
    if (!newDeployPath || !newDeployChart) return
    // Creating a deployment jumps the workspace to it — same silent-discard
    // hazard as switching folders in the tree.
    if (dirty && !frozenSource && !(await confirmDiscardEdits())) return
    const result = await initDeploymentFolder(newDeployPath, newDeployChart)
    if (result.error) {
      message.error(result.error)
      return
    }
    setNewDeployOpen(false)
    if (result.status === 'created' || result.status === 'existing') {
      const chart = result.chart || newDeployChart
      setSelectedFolder(newDeployPath)
      setSelectedChart(chart)
      setActiveAlert(null)
      // A fresh deployment has no _common filled in; clear any left over from
      // the previous selection so the required-common check below sees the
      // real (empty) state and not stale values.
      setCommonValues({})
      pendingCommonCheckRef.current = true
      setTreeRefreshKey(k => k + 1)
      message.success(result.inheritsFrom
        ? `Deployment created at ${newDeployPath}, inheriting everything from ${result.inheritsFrom}`
        : `Deployment created at ${newDeployPath}`)
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

  // `keepGroups`: opening one of the viewed deployments keeps the groups the
  // Overview shows; picking one in the tree starts afresh, as it always has.
  async function handleFolderSelect(selection, { keepGroups = false, viewing } = {}) {
    // null = the selected deployment was deleted; reset instead of keeping
    // an editor open on content that no longer exists on disk.
    if (!selection) {
      frozenSourceFolderRef.current = null
      setSelectedFolder(null)
      setSelectedChart(null)
      setActiveAlert(null)
      setAllValues({})
      setCommonValues({})
      setInherited(null)
      setRows([])
      setFilters({})
      setCheckedAlerts([])
      setDirty(false)
      setFrozenSource(null)
      return
    }
    if (dirty && !frozenSource && !(await confirmDiscardEdits())) return
    const { path, chart } = selection
    setViewedPaths(viewing || [path])
    setSelectedFolder(path)
    setSelectedChart(chart)
    setActiveAlert(null)
    setAllValues({})
    setCommonValues({})
    setInherited(null)
    setRows([])
    setFilters({})
    if (!keepGroups) setCheckedAlerts([])
    setDirty(false)
    setFrozenSource(null)
    await refreshFrozenSource(path)
  }

  // Checking deployments in the tree. The last one cannot be unchecked; if
  // the selected one is, the first one left becomes the selected one.
  async function handleViewedChange(keys) {
    const next = [...viewed.filter(p => keys.includes(p)), ...keys.filter(k => !viewed.includes(k))]
    if (next.length === 0) return
    if (!multi && next.length > 1 && dirty && !frozenSource) {
      if (!(await confirmDiscardEdits())) return
      setDirty(false)
      setReloadKey(k => k + 1)
    }
    if (!next.includes(selectedFolder)) {
      await handleFolderSelect({ path: next[0], chart: selectedChart }, { keepGroups: true, viewing: next })
      return
    }
    setViewedPaths(next)
  }

  // A part's title in a card: back to that one deployment, editable.
  function openViewedDeployment(path) {
    if (path === selectedFolder) {
      setViewedPaths([path])
      return
    }
    handleFolderSelect({ path, chart: selectedChart }, { keepGroups: true })
  }

  // Returns true when the selected one was deleted and another checked one
  // takes its place, so the tree does not clear the selection.
  function handleViewedRemoved(paths, { deleted = false } = {}) {
    const gone = p => paths.some(d => p === d || p.startsWith(d + '/'))
    const left = viewed.filter(p => !gone(p))
    if (deleted && selectedFolder && gone(selectedFolder) && left.length > 0) {
      handleFolderSelect({ path: left[0], chart: selectedChart }, { keepGroups: true, viewing: left })
      return true
    }
    setViewedPaths(v => v.filter(p => !gone(p)))
    return false
  }

  // A proposed row (#60) goes into its group's table; Save is still the
  // owner's to press.
  // A group it inherits is copied here first, as Add instance does (#102):
  // a group is inherited whole, and one row alone would drop the rest.
  function addProposedRow(group, row) {
    const inheritedHere = !(group in allValues) && inheritedFrom(group)
    const current = inheritedHere ? (inherited.values?.[group] || []).map(r => ({ ...r })) : (group === activeAlert ? rows : (allValues[group] || []))
    const next = [...current, row]
    if (group === activeAlert) setRows(next)
    setAllValues(v => ({ ...v, [group]: next }))
    setDirty(true)
  }

  // A save refused as the deployment changed since it was opened: what is
  // there now is shown again, and the edits here are said to be lost.
  function reportChanged(result) {
    Modal.confirm({
      title: 'Changed since you opened it',
      content: `${result.error}. A _common may have been made or removed above it, or someone else saved it. Reload shows what is there now — your unsaved edits here are discarded.`,
      okText: 'Reload',
      cancelText: 'Keep my edits on screen',
      onOk: () => { setDirty(false); setReloadKey(k => k + 1) },
    })
  }

  // A save refused for specific cells lists them; anything else is still
  // just "Save failed". Rows that would fix a selector overlap (#60) each
  // come with a button that adds them.
  function reportSaveFailure(result) {
    if (result.changed) {
      reportChanged(result)
      return
    }
    if (!result.problems?.length) {
      message.error('Save failed')
      return
    }
    const dialog = Modal.error({
      title: result.error || 'Save failed',
      width: 560,
      content: (
        <>
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            {result.problems.map((p, i) => <li key={i}>{p.message}</li>)}
          </ul>
          {(result.proposals || []).map((p, i) => (
            <div key={i} data-testid="proposal" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <Button size="small" onClick={() => { addProposedRow(p.group, p.row); dialog.destroy() }}>Add this row</Button>
              <Text style={{ fontSize: 12 }}>
                {p.group}: {Object.entries(p.row).map(([k, v]) => `${k}=${v}`).join(', ')}
                <Text type="secondary" style={{ fontSize: 11 }}> — {p.reason}</Text>
              </Text>
            </div>
          ))}
        </>
      ),
    })
  }

  // The deployment was saved; a sync target that was not is named, and what
  // the save let through but is worth saying (rows the row identity label
  // cannot tell apart).
  function warnSyncFailed(result) {
    const notice = syncFailedNotice(result.syncFailed)
    if (notice) message.warning({ content: notice, duration: 10 })
    setSaveWarnings(result.warnings || [])
    // The editor wrote what Helm reads: the note on how it read the file is done.
    setReadNotes([])
  }

  async function handleSave() {
    if (!selectedChart || !selectedFolder) return
    const isCommon = activeAlert === '__common_vars__'
    // An inherited group is written only once it is overridden here (#102).
    const ownGroup = !isCommon && (activeAlert in allValues || !inheritedFrom(activeAlert))
    const merged = ownGroup ? { ...allValues, [activeAlert]: rows } : allValues
    const toSave = Object.keys(commonValues).length > 0
      ? { _common: commonValues, ...merged }
      : merged
    const result = await saveDeployment(selectedChart, folderBasename, pruneAllValues(toSave, schema), selectedFolder, loadedVersion)
    if (!result.ok) {
      reportSaveFailure(result)
      return false
    }
    if (!isCommon) setAllValues(merged)
    if (result.version) setLoadedVersion(result.version)
    setDirty(false)
    setUsersKey(k => k + 1)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    warnSyncFailed(result)
    return true
  }

  async function handleOverviewSave() {
    if (!selectedChart || !selectedFolder) return false
    const toSave = Object.keys(commonValues).length > 0
      ? { _common: commonValues, ...allValues }
      : allValues
    const result = await saveDeployment(selectedChart, folderBasename, pruneAllValues(toSave, schema), selectedFolder, loadedVersion)
    if (!result.ok) {
      reportSaveFailure(result)
      return false
    }
    if (result.version) setLoadedVersion(result.version)
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    warnSyncFailed(result)
    // The overview has no line of its own for them.
    if (result.warnings?.length) message.warning({ content: result.warnings.join('; '), duration: 10 })
    return true
  }

  async function handlePreview() {
    if (!selectedChart || !selectedFolder) return
    // A frozen (synced) deployment is read-only: its on-disk state is the
    // source of truth, so render that directly. Attempting the save-first
    // path would just bounce off the server's 409 read-only guard.
    if (dirty && !frozenSource) {
      // Overview edits allValues in place; single mode keeps the active alert's
      // rows separate and merges them back on save. Saving through the wrong
      // handler would write stale rows over the other mode's edits.
      const saved = mode === 'overview' ? await handleOverviewSave() : await handleSave()
      if (!saved) return
    }
    const result = await renderDeployment(selectedChart, folderBasename, selectedFolder)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewCheck(result.ok ? result.check : null)
    setPreviewSelfCheck(result.ok ? result.selfCheck : null)
    setPreviewSummary(result.ok ? result.summary : null)
    setPreviewValueWarnings(result.ok ? result.valueWarnings : null)
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

  // A group a _common gives: shown, dimmed; overridden, it is the
  // deployment's own; reset, the key goes and the inherited rows show again.
  const groupFrom = activeAlert && activeAlert !== '__common_vars__' ? inheritedFrom(activeAlert) : null
  const inheritedRows = groupFrom ? (inherited.values?.[activeAlert] || []) : []
  const showingInherited = !!groupFrom && !(activeAlert in allValues)
  const copyRows = list => list.map(r => ({ ...r }))
  function overrideGroup(then = rows => rows) {
    const copied = then(copyRows(inheritedRows))
    setAllValues(v => ({ ...v, [activeAlert]: copied }))
    setRows(copied)
    setDirty(true)
  }
  function addToInherited(newRow) {
    overrideGroup(list => [...list, newRow])
    message.info(`The ${inheritedRows.length} inherited row${inheritedRows.length === 1 ? ' was' : 's were'} copied here first: this deployment's ${activeAlert} replaces the one of ${groupFrom} whole`)
  }
  const rowText = r => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(', ') || '(empty row)'
  function resetGroup() {
    Modal.confirm({
      title: `Reset ${activeAlert} to what ${groupFrom} gives?`,
      width: 600,
      okText: 'Reset',
      content: (
        <div data-testid="reset-diff" style={{ fontSize: 12 }}>
          <div style={{ marginTop: 8 }}><b>This deployment's rows, removed ({rows.length}):</b></div>
          <ul style={{ paddingLeft: 18, margin: 0 }}>{rows.length ? rows.map((r, i) => <li key={i} style={{ color: '#cf1322' }}>{rowText(r)}</li>) : <li>none — it clears the group</li>}</ul>
          <div style={{ marginTop: 8 }}><b>Inherited from {groupFrom} ({inheritedRows.length}):</b></div>
          <ul style={{ paddingLeft: 18, margin: 0 }}>{inheritedRows.length ? inheritedRows.map((r, i) => <li key={i} style={{ color: '#389e0d' }}>{rowText(r)}</li>) : <li>none</li>}</ul>
          <div style={{ marginTop: 8 }}>Once saved, a later change to {groupFrom} reaches this deployment too.</div>
        </div>
      ),
      onOk: () => {
        setAllValues(v => { const { [activeAlert]: _, ...rest } = v; return rest })
        setRows([])
        setDirty(true)
      },
    })
  }

  const isCommonView = activeAlert === '__common_vars__'
  const commonVarDefs = schema ? getCommonVars(schema) : []
  const showMain = selectedFolder && selectedChart && activeAlert

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: sidebarCollapsed ? 0 : sidebarWidth, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflow: 'hidden', background: '#fff', position: 'relative', display: 'flex', flexDirection: 'column', transition: 'width 0.15s ease' }}>
        {/* Must stay shrinkable: the sidebar clips its overflow, so a tree taller
            than the pane has to scroll here rather than run past the bottom.
            Capped at half the pane so the template list below keeps its space. */}
        <div style={{ flex: '0 1 auto', minHeight: 0, maxHeight: selectedChart ? '50%' : '100%', overflowY: 'auto' }}>
          {sectionHeader('Deployments', <Button size="small" type="text" icon={<PlusOutlined />} onClick={handleNewDeployOpen} />)}
          <DeploymentTree
            selectedFolder={selectedFolder}
            onSelect={handleFolderSelect}
            refreshKey={treeRefreshKey}
            onSyncChange={() => {
              if (!selectedFolder) return
              refreshFrozenSource(selectedFolder)
            }}
            checkable={mode === 'overview' && !!selectedChart}
            checkedKeys={viewed}
            checkChart={selectedChart}
            onCheck={handleViewedChange}
            onRemoved={handleViewedRemoved}
            onCommonChange={() => { setDirty(false); setReloadKey(k => k + 1); setUsersKey(k => k + 1) }}
            // Making or removing a _common reloads the page open: asked first.
            confirmLeave={async () => !dirty || !!frozenSource || confirmDiscardEdits()}
          />
        </div>
        {selectedChart && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
                  templates={alertNames.filter(n => !onceGroups.includes(n))}
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
        {frozenSource && selectedFolder && !multi && (
          <div style={{ padding: '6px 20px', background: '#fff7e6', borderBottom: '1px solid #ffe7ba', fontSize: 12, color: '#ad6800' }}>
            Synced from <b>{frozenSource}</b> — read-only. Unlink from the sidebar to edit independently.
            {stackInfo?.inheritsFrom && (
              <span data-testid="target-stack"> What it inherits comes from its source&apos;s <b>{stackInfo.inheritsFrom}</b>{stackInfo.folderCommon && stackInfo.folderCommon !== stackInfo.inheritsFrom ? <>, not this folder&apos;s {stackInfo.folderCommon}</> : null}.</span>
            )}
            {!stackInfo?.inheritsFrom && stackInfo?.folderCommon && (
              <span data-testid="target-stack"> It does not inherit this folder&apos;s {stackInfo.folderCommon}: its source is on the Template directly.</span>
            )}
          </div>
        )}
        {loadError && selectedFolder && !multi && (
          <div data-testid="values-load-error" style={{ padding: '6px 20px', background: '#fff1f0', borderBottom: '1px solid #ffccc7', fontSize: 12, color: '#a8071a' }}>
            This deployment&apos;s values cannot be read: {loadError}
          </div>
        )}
        {stackProblems && selectedFolder && !multi && (
          <div data-testid="stack-problems" style={{ padding: '6px 20px', background: '#fff1f0', borderBottom: '1px solid #ffccc7', fontSize: 12, color: '#a8071a' }}>
            Helm cannot render this as shown: {stackProblems.join('; ')}
          </div>
        )}
        {onCommon && !multi && (
          <div data-testid="common-banner" style={{ padding: '6px 20px', background: '#f0f5ff', borderBottom: '1px solid #d6e4ff', fontSize: 12, color: '#1d39c4' }}>
            The <b>{COMMON_DIR}</b> of <b>{selectedFolder.split('/').slice(0, -2).join('/')}/</b>: what its deployments of {selectedChart} inherit, unless they set their own.{' '}
            {commonUsers === null ? 'Loading who inherits…' : commonUsers.length === 0 ? 'No deployment inherits from it yet.' : (
              <>
                {commonUsers.length} deployment{commonUsers.length > 1 ? 's' : ''} inherit from it:
                <ul data-testid="common-users" style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                  {commonUsers.map(u => {
                    const fromHere = Object.values(u.groups).filter(g => g.from === selectedFolder)
                    const active = activeAlert && activeAlert !== '__common_vars__' ? u.groups[activeAlert] : null
                    return (
                      <li key={u.path} data-testid={`common-user-${u.path}`}>
                        <b>{u.path}</b>{!u.direct && ' (through a lower _common)'}: inherits {fromHere.length} group{fromHere.length === 1 ? '' : 's'} ({fromHere.reduce((n, g) => n + (g.rows || 0), 0)} rows) from here
                        {active && <> — {activeAlert}: {active.from === 'own' ? `its own ${active.rows} row${active.rows === 1 ? '' : 's'}` : active.from === selectedFolder ? `${active.rows} row${active.rows === 1 ? '' : 's'} from here` : `${active.rows ?? 'the Template\'s'} rows from ${active.from}`}</>}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        )}
        {unusedValuesFile && selectedFolder && !multi && (
          <div data-testid="unused-values-file" style={{ padding: '6px 20px', background: '#fff7e6', borderBottom: '1px solid #ffe7ba', fontSize: 12, color: '#ad6800' }}>
            This folder also has <b>{unusedValuesFile}</b>, which nothing reads — this deployment uses <b>values.yaml</b>. You can delete it.
          </div>
        )}
        {multi && !viewedDeployments && viewedFailed.length > 0 ? (
          <Empty style={{ margin: 'auto' }} description={`Could not load ${viewedFailed.join(', ')}`}>
            <Button onClick={() => { setViewedFailed([]); setViewedRetry(k => k + 1) }}>Retry</Button>
          </Empty>
        ) : multi && !viewedDeployments ? (
          <Empty style={{ margin: 'auto' }} description="Loading..." />
        ) : mode === 'overview' && selectedFolder && selectedChart ? (
          <AlertOverviewWorkspace
            checkedAlerts={checkedAlerts}
            allValues={allValues}
            commonValues={commonValues}
            schema={schema}
            onAllValuesChange={updated => { setAllValues(updated); setDirty(true) }}
            onSave={handleOverviewSave}
            onPreview={onCommon ? undefined : handlePreview}
            dirty={dirty}
            saveStatus={saveStatus}
            getVars={getVars}
            readOnly={!!frozenSource || !!loadError}
            deployments={viewedDeployments}
            onOpenDeployment={openViewedDeployment}
            inheritedFrom={multi ? null : inheritedFrom}
            inheritedRows={group => inherited?.values?.[group] || []}
          />
        ) : showMain ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
              <Title level={4} style={{ margin: 0 }}>
                {selectedFolder} / {isCommonView ? 'Common Values' : activeAlert}
              </Title>
            </div>
            <div ref={setMainScrollContainer} style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              {isCommonView ? (
                <div style={{ maxWidth: 500 }}>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
                    {onCommon
                      ? 'Values set here apply to all alert groups of every deployment that inherits from this _common, unless the deployment sets its own.'
                      : 'Values set here apply to all alert groups in this deployment.'}
                  </Text>
                  {commonVarDefs.map(v => {
                    // A _common may leave a required value to its deployments;
                    // one a deployment inherits is given (#102).
                    const own = v.name in commonValues
                    const from = !own && v.name in inheritedCommon ? commonFrom[v.name] : null
                    const missing = !frozenSource && !onCommon && isMissingRequired(v, own ? commonValues[v.name] : inheritedCommon[v.name])
                    const badDuration = !missing && !frozenSource && v.type === 'duration' && commonValues[v.name]
                      ? durationCellFault(commonValues[v.name], null) : null
                    const field = v.enum ? (
                        <Select size="small" value={commonValues[v.name] ?? ''}
                          status={missing ? 'error' : undefined}
                          onChange={val => { setCommonValues({ ...commonValues, [v.name]: val }); setDirty(true) }}
                          style={{ flex: 1 }}
                          options={v.enum.map(opt => ({ value: opt, label: opt }))}
                          allowClear
                          disabled={!!frozenSource || !!loadError}
                          onClear={() => { const { [v.name]: _, ...rest } = commonValues; setCommonValues(rest); setDirty(true) }}
                        />
                      ) : (
                        <Input size="small" value={commonValues[v.name] ?? ''}
                          placeholder={from ? `${inheritedCommon[v.name]} (inherited)` : undefined}
                          disabled={!!frozenSource || !!loadError}
                          status={missing || badDuration ? 'error' : undefined}
                          onChange={e => {
                            if (e.target.value) {
                              setCommonValues({ ...commonValues, [v.name]: e.target.value }); setDirty(true)
                            } else {
                              const { [v.name]: _, ...rest } = commonValues; setCommonValues(rest); setDirty(true)
                            }
                          }}
                          style={{ flex: 1 }}
                        />
                      )
                    return (
                      <div key={v.name} data-testid={`common-value-${v.name}`} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                        <Text strong style={{ width: 120, fontSize: 13 }}>{v.name}{v.required && <RequiredMark />}</Text>
                        {missing ? <Tooltip title="Required">{field}</Tooltip> : badDuration ? <Tooltip title={badDuration}>{field}</Tooltip> : field}
                        {from && <Tag data-testid={`inherited-from-${v.name}`} style={{ margin: 0, opacity: 0.7 }}>from {from}</Tag>}
                        {own && v.name in inheritedCommon && !frozenSource && (
                          <Tooltip title={`Remove it here: ${inheritedCommon[v.name]} from ${commonFrom[v.name]} again`}>
                            <Button size="small" type="link" data-testid={`reset-${v.name}`} style={{ padding: 0 }}
                              onClick={() => { const { [v.name]: _, ...rest } = commonValues; setCommonValues(rest); setDirty(true) }}>Reset</Button>
                          </Tooltip>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : onceGroups.includes(activeAlert) ? (
                <Alert
                  data-testid="once-group-notice"
                  type="info"
                  showIcon
                  message="No values needed"
                  description="This group renders once per deployment — it has no rows to fill in. Preview shows what it produces."
                />
              ) : showingInherited ? (
                <>
                  <Alert data-testid="inherited-group" type="info" showIcon style={{ marginBottom: 12 }}
                    message={<>Inherited from <b>{groupFrom}</b>: {inheritedRows.length} row{inheritedRows.length === 1 ? '' : 's'}</>}
                    description={`A group is inherited whole. To change any of its rows here, override it: the ${inheritedRows.length} rows are copied into this deployment, and later changes to ${groupFrom}'s ${activeAlert} no longer reach it.`}
                    action={!frozenSource && <Button size="small" onClick={() => overrideGroup()}>Override here</Button>} />
                  <div style={{ opacity: 0.55 }}>
                    <AlertTable vars={vars} rows={inheritedRows} plain readOnly commonValues={{ ...inheritedCommon, ...commonValues }}
                      filters={filters} onFiltersChange={setFilters} onUpdate={() => {}} onDelete={() => {}} onAdd={() => {}}
                      scrollContainer={mainScrollContainer} />
                  </div>
                  {!frozenSource && (
                    <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }}
                      onClick={() => addToInherited(buildNewRow(vars, { ...inheritedCommon, ...commonValues }))}>
                      Add instance (copies the {inheritedRows.length} inherited rows here first)
                    </Button>
                  )}
                </>
              ) : (
                <>
                {groupFrom && (
                  <Alert data-testid="overrides-group" type="warning" showIcon style={{ marginBottom: 12 }}
                    message={rows.length === 0 && inheritedRows.length > 0
                      ? <>This deployment clears {activeAlert} (it writes no rows): <b>{groupFrom}</b> gives {inheritedRows.length}</>
                      : <>Overrides <b>{groupFrom}</b> ({inheritedRows.length} row{inheritedRows.length === 1 ? '' : 's'} there)</>}
                    action={!frozenSource && <Button size="small" onClick={resetGroup}>Reset to inherited</Button>} />
                )}
                <AlertTable
                  vars={vars}
                  rows={rows}
                  selectors={rulesModel?.groups?.[activeAlert]?.selectors || null}
                  selectorDefaults={selectorDefaultsOf(rulesModel, activeAlert)}
                  selectorLabels={renamedSelectorLabels(rulesModel?.groups?.[activeAlert])}
                  commonValues={{ ...inheritedCommon, ...commonValues }}
                  filters={filters}
                  onFiltersChange={setFilters}
                  onUpdate={updated => { setRows(updated); setDirty(true) }}
                  onDelete={realIndex => { setRows(rows.filter((_, i) => i !== realIndex)); setDirty(true) }}
                  onAdd={newRow => { setRows([...rows, newRow]); setDirty(true) }}
                  readOnly={!!frozenSource || !!loadError}
                  scrollContainer={mainScrollContainer}
                />
                </>
              )}
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty || !!frozenSource || !!loadError}>Save</Button>
              {!isCommonView && !onCommon && <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>}
              {!isCommonView && Object.values(filters).some(f => f && f.value !== '' && f.value != null) && (
                <Button icon={<CloseOutlined />} size="small" type="text" style={{ color: '#1677ff' }} onClick={() => setFilters({})}>Clear filters</Button>
              )}
              {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
              {saveWarnings.length > 0 && (
                <Text type="warning" data-testid="values-warnings" style={{ fontSize: 12 }}>{saveWarnings.join('; ')}</Text>
              )}
              {readNotes.length > 0 && !dirty && (
                <Text type="warning" data-testid="values-read-notes" style={{ fontSize: 12 }}>{readNotes.join('; ')}</Text>
              )}
            </div>
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

      {/* Mounted outside the mode branches: both single and overview open it. */}
      <PreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        yaml={previewYaml}
        check={previewCheck}
        selfCheck={previewSelfCheck}
        summary={previewSummary}
        valueWarnings={previewValueWarnings}
      />

      <Modal title="New Deployment" open={newDeployOpen} onCancel={() => setNewDeployOpen(false)}
        onOk={handleNewDeployCreate} okText="Create"
        okButtonProps={{ disabled: !newDeployPath || !newDeployChart || newDeployReserved }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div>
            <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Folder Path</Text>
            <Input placeholder="deployments/my-app/production" value={newDeployPath}
              status={newDeployReserved ? 'error' : undefined}
              onChange={e => setNewDeployPath(e.target.value)} />
            {newDeployReserved && <Text type="danger" style={{ fontSize: 12 }}>{RESERVED_HINT}</Text>}
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
