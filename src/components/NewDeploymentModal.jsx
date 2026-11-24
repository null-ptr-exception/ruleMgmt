import { useEffect, useState } from 'react'
import { Modal, Input, Select, Typography, Segmented } from 'antd'
import { listCharts, commonsAbove } from '../utils/chartApi'
import { isReservedName, RESERVED_HINT, COMMON_DIR } from '../utils/reservedNames'
import { useCommonChange, CommonPlan } from './CommonModal'

const { Text } = Typography

const LABEL = { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }
const NOTE = { fontSize: 12, display: 'block', marginTop: 6 }
// How long after the last key the typed path is asked about.
const TYPING_MS = 250

// Nothing looked up yet (no path is null).
const NOT_LOOKED = { folder: null, commons: [] }

const folderOf = typed => typed.split('/').filter(Boolean).join('/')

/**
 * The New Deployment dialog: makes a deployment, or a folder's _common.
 *
 * A deployment: the folder path and its Template. While the path is typed
 * the `_common`s above it are looked up: under one Template's, the Template
 * is filled in and the dialog says where the deployment will inherit from;
 * under several Templates', none is filled and those are listed first. A
 * Template picked by hand is kept.
 *
 * A _common: the folder (made with it when it is not there yet) and its
 * Template. Its plan is shown before anything is written, and Create
 * writes that plan — the tree menu's "Add _common..." with a path typed.
 *
 *   onCreateDeployment(path, chart) asked to make the deployment; the page closes the dialog once it is made
 *   onCommonDone(result)            the _common was made
 *   confirmLeave()                  → false to stay: asked before a _common is written
 */
export default function NewDeploymentModal({ open, initialPath, onClose, onCreateDeployment, onCommonDone, confirmLeave }) {
  // The fields are this opening's: until they are set again after the
  // dialog opens, nothing is asked for what the last opening left in them.
  const [fresh, setFresh] = useState(false)
  const [kind, setKind] = useState('deployment')
  const [typed, setTyped] = useState('')
  const [charts, setCharts] = useState([])
  // The Template picked by hand, or null: what the folder gives then fills it.
  const [picked, setPicked] = useState(null)
  // The path the lookups are made for: `typed`, once typing pauses.
  const [settled, setSettled] = useState('')
  // The _commons above a path, and the path they were answered for.
  const [looked, setLooked] = useState(NOT_LOOKED)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) { setFresh(false); return }
    setKind('deployment')
    setTyped(initialPath)
    setSettled(initialPath)
    setPicked(null)
    setLooked(NOT_LOOKED)
    setFresh(true)
    listCharts().then(setCharts)
  }, [open])

  useEffect(() => {
    const timer = setTimeout(() => setSettled(typed), TYPING_MS)
    return () => clearTimeout(timer)
  }, [typed])

  const folder = folderOf(settled)
  const live = open && fresh

  useEffect(() => {
    // A _common's Template is not the folder's to give: nothing is kept
    // of what was looked up for a deployment.
    if (!live || kind !== 'deployment') { setLooked(NOT_LOOKED); return }
    let stale = false
    // An answer that cannot be read is no _common known: nothing is filled in.
    commonsAbove(folder).then(found => { if (!stale) setLooked({ folder, commons: found }) }, () => { if (!stale) setLooked({ folder, commons: [] }) })
    return () => { stale = true }
  }, [live, kind, folder])

  const commons = looked.commons
  // The lookup has answered for the path as it is typed now: until then
  // what is known is another path's, and no deployment is made on it.
  const answered = kind === 'deployment' && looked.folder === folderOf(typed)

  // What fills the Template: for a deployment, the one Template whose
  // _common the path is under; with none above (and for a _common), the
  // repo's only Template; else nothing. A Template picked by hand stays.
  const only = charts.length === 1 ? charts[0].name : null
  const given = kind === 'common' ? only : commons.length === 1 ? commons[0].chart : commons.length === 0 ? only : null
  const chart = picked ?? given

  // Typing has paused and the plan is for what is in the field.
  const upToDate = folderOf(typed) === folder
  const query = live && kind === 'common' && folder && chart && upToDate ? { action: 'create', folder, chart } : null
  const common = useCommonChange(open, query)

  // The deployment being made is the last segment; a reserved one is
  // refused. A _common's folder is the server's to judge, as in the tree.
  const reserved = kind === 'deployment' && isReservedName(typed.split('/').filter(Boolean).pop())
  const inherits = answered ? commons.find(c => c.chart === chart) : null
  const first = new Set(commons.map(c => c.chart))
  // Those the folders above have a _common for come first, the nearest first.
  const known = new Set(charts.map(c => c.name))
  const options = [...commons.map(c => c.chart).filter(name => known.has(name)), ...charts.map(c => c.name).filter(name => !first.has(name))]
    .map(name => ({ value: name, label: name }))

  async function handleOk() {
    if (kind === 'deployment') {
      if (!answered) return
      setCreating(true)
      try {
        await onCreateDeployment(typed, chart)
      } finally {
        setCreating(false)
      }
      return
    }
    if (confirmLeave && !(await confirmLeave())) return
    const result = await common.apply()
    if (result) onCommonDone?.(result)
  }

  const okDisabled = kind === 'deployment' ? (!typed || !chart || reserved || !answered) : (!common.plan || common.loading)

  return (
    <Modal title="New Deployment" open={open} onCancel={onClose} onOk={handleOk} okText="Create"
      width={kind === 'common' ? 720 : undefined}
      okButtonProps={{ disabled: okDisabled, loading: creating || common.writing }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
        <Segmented aria-label="What to make" data-testid="new-kind" value={kind} onChange={setKind}
          options={[{ value: 'deployment', label: 'Deployment' }, { value: 'common', label: `${COMMON_DIR} for a folder` }]} />
        <div>
          <Text style={LABEL}>{kind === 'common' ? 'Folder' : 'Folder Path'}</Text>
          <Input placeholder={kind === 'common' ? 'deployments/my-app' : 'deployments/my-app/production'} value={typed}
            status={reserved ? 'error' : undefined}
            onChange={e => setTyped(e.target.value)} />
          {reserved && <Text type="danger" style={{ fontSize: 12 }}>{RESERVED_HINT}</Text>}
          {kind === 'common' && (
            <Text type="secondary" style={NOTE}>
              The folder whose deployments share settings. One that is not there yet is made with its {COMMON_DIR}.
            </Text>
          )}
        </div>
        <div>
          <Text style={LABEL}>Template</Text>
          <Select aria-label="Template" style={{ width: '100%' }} value={chart} onChange={setPicked} placeholder="Pick the Template" options={options} />
          {kind === 'deployment' && inherits && (
            <Text type="secondary" style={NOTE} data-testid="new-deploy-inherits">
              Inherits from <b>{inherits.path}</b>: it writes nothing of its own until you override something.
            </Text>
          )}
          {kind === 'deployment' && answered && !inherits && commons.length > 0 && (
            <Text type="secondary" style={NOTE} data-testid="new-deploy-commons">
              {chart
                ? <>No {COMMON_DIR} of <b>{chart}</b> above this folder: it is made on the Template itself. </>
                : null}
              The folders above have a {COMMON_DIR} for {commons.map((c, i) => <span key={c.chart}>{i > 0 ? ', ' : ''}<b>{c.chart}</b> ({c.path})</span>)}{chart ? '.' : ': pick one of them to inherit from it, or another Template.'}
            </Text>
          )}
          {kind === 'common' && (
            <Text type="secondary" style={NOTE}>
              The deployments under the folder of this Template inherit from it: what they deploy stays the same until the {COMMON_DIR} is changed.
            </Text>
          )}
        </div>
        {kind === 'common' && (
          <div>
            <CommonPlan mode="create" plan={common.plan} refusal={common.refusal} loading={common.loading} />
          </div>
        )}
      </div>
    </Modal>
  )
}
