import { useEffect, useState } from 'react'
import { Modal, Select, Table, Typography, Alert, Tag, message } from 'antd'
import { listCharts, getCommonPlan, applyCommon } from '../utils/chartApi'
import { AnswerCutOff, cutOffMessage } from '../lib/apiFetch'
import { COMMON_DIR } from '../utils/reservedNames'

const { Text } = Typography

const CHANGE_TEXT = {
  attached: 'inherits from it: its values wrapped under common:',
  rewrapped: 'one level more of common: in its values (it stacks on a _common that now inherits from it)',
  copied: 'copied again from its sync source',
  detached: 'gets what it inherited copied into its own values',
  through: 'nothing of its own changes: it inherits through a _common that does — checked like the rest',
}

/**
 * Make (`mode: 'create'`, in `folder`) or remove (`mode: 'delete'`, the
 * _common at `commonPath`) a folder's _common (#101). What it changes is
 * listed first — every deployment and every file — and written only on OK,
 * all of it or nothing.
 */
export default function CommonModal({ open, mode, folder, commonPath, onClose, onDone }) {
  const [charts, setCharts] = useState([])
  const [chart, setChart] = useState(null)
  const [plan, setPlan] = useState(null)
  const [refusal, setRefusal] = useState(null)
  const [loading, setLoading] = useState(false)
  const [writing, setWriting] = useState(false)

  const query = mode === 'delete' ? { action: 'delete', path: commonPath } : (chart ? { action: 'create', folder, chart } : null)
  const queryKey = JSON.stringify(query)

  useEffect(() => {
    if (!open) return
    setPlan(null)
    setRefusal(null)
    if (mode === 'create') {
      setChart(null)
      listCharts().then(list => {
        setCharts(list)
        if (list.length === 1) setChart(list[0].name)
      })
    }
  }, [open, mode, folder, commonPath])

  useEffect(() => {
    if (!open || !query) return
    let stale = false
    setLoading(true)
    setPlan(null)
    setRefusal(null)
    getCommonPlan(query).then(result => {
      if (stale) return
      setLoading(false)
      if (result.error) setRefusal(result)
      else setPlan(result)
    })
    return () => { stale = true }
  }, [open, queryKey])

  async function handleOk() {
    if (!plan) return
    setWriting(true)
    let result
    try {
      result = await applyCommon(query, plan.expected)
    } catch (err) {
      result = { error: err instanceof AnswerCutOff ? cutOffMessage(err) : (err.message || String(err)) }
    } finally {
      setWriting(false)
    }
    if (result.error || !result.ok) {
      if (result.plan) setPlan(result.plan)
      setRefusal(result)
      return
    }
    message.success(mode === 'delete' ? `Removed ${result.common}` : `Made ${result.common}`)
    onDone?.(result)
  }

  const title = mode === 'delete' ? `Remove ${commonPath}?` : `Add a ${COMMON_DIR} to ${folder}`
  const rows = plan ? plan.changes.map(c => ({ ...c, key: c.path })) : []

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText={mode === 'delete' ? 'Remove' : 'Create'}
      okButtonProps={{ disabled: !plan || loading, loading: writing, danger: mode === 'delete', 'data-testid': 'common-ok' }}
      width={720}
      destroyOnHidden
    >
      {mode === 'create' && (
        <div style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Template</Text>
          <Select aria-label="Template" style={{ width: '100%' }} value={chart} onChange={setChart} placeholder="Pick the Template"
            options={charts.map(c => ({ value: c.name, label: c.name }))} />
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            The deployments under {folder}/ of this Template inherit from it: what they deploy stays the same until the {COMMON_DIR} is changed.
          </Text>
        </div>
      )}
      {loading && <Text type="secondary">Working out what changes…</Text>}
      {refusal && (
        <Alert type="error" showIcon data-testid="common-refusal" message={refusal.error}
          description={refusal.problems?.length ? <ul style={{ paddingLeft: 18, margin: 0 }}>{refusal.problems.map((p, i) => <li key={i}>{p.path}: {p.message}</li>)}</ul> : null} />
      )}
      {plan && (
        <div data-testid="common-plan">
          <Text style={{ display: 'block', marginBottom: 8 }}>
            {mode === 'delete'
              ? <>{plan.common} is removed. {plan.changes.length ? 'Each deployment below gets what it inherited copied into its own values, as written there.' : 'No deployment inherits from it.'}</>
              : <>Makes <b>{plan.common}</b>{plan.inheritsFrom ? <>, which inherits from <b>{plan.inheritsFrom}</b></> : null}. {plan.changes.length ? 'Each deployment\'s values are moved as written, not rewritten.' : 'No deployment is under it yet.'}</>}
          </Text>
          <Text type="secondary" data-testid="common-checked" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            {plan.checkedWith === 'helm'
              ? 'Each deployment it changes was rendered with Helm as it is now and as it will be, before anything is written: one that would render anything else stops it, and nothing is written.'
              : 'Helm is not available here: only the values AlertForge works out for each deployment are compared before and after, not what Helm renders.'}
          </Text>
          {rows.length > 0 && (
            <Table size="small" pagination={false} dataSource={rows} data-testid="common-changes"
              columns={[
                { title: 'Changes', dataIndex: 'path', render: (p, c) => <><b>{p}</b>{c.kind === 'common' && <Tag style={{ marginLeft: 6 }}>{COMMON_DIR}</Tag>}</> },
                { title: 'What', dataIndex: 'change', render: (ch, c) => (
                  <span style={{ fontSize: 12 }}>
                    {ch === 'copied' ? <>copied again from its sync source <b>{c.syncedFrom}</b></> : CHANGE_TEXT[ch]}
                    {c.exampleRows?.length > 0 && <div style={{ color: '#ad6800' }}>The Template&apos;s example rows it deploys for {c.exampleRows.length} group{c.exampleRows.length > 1 ? 's' : ''} it does not write are written into it.</div>}
                  </span>
                ) },
                { title: 'Files', dataIndex: 'files', render: files => <span style={{ fontSize: 11, fontFamily: 'monospace' }}>{files.map(f => <div key={f}>{f}</div>)}</span> },
              ]} />
          )}
          {plan.untouched.length > 0 && (
            <div data-testid="common-untouched" style={{ marginTop: 10 }}>
              <Text strong style={{ fontSize: 12 }}>Left as they are</Text>
              <ul style={{ paddingLeft: 18, margin: '4px 0', fontSize: 12 }}>
                {plan.untouched.map(u => <li key={u.path}><b>{u.path}</b>: {u.why}</li>)}
              </ul>
            </div>
          )}
          {plan.unreadable?.length > 0 && (
            <div data-testid="common-unreadable" style={{ marginTop: 10 }}>
              <Text strong style={{ fontSize: 12 }}>Folders that cannot be read</Text>
              <ul style={{ paddingLeft: 18, margin: '4px 0', fontSize: 12 }}>
                {plan.unreadable.map(u => <li key={u}><b>{u}</b>: nothing in it is known, so nothing in it is changed</li>)}
              </ul>
            </div>
          )}
          <details style={{ marginTop: 10, fontSize: 12 }}>
            <summary>All {plan.files.length} files written{mode === 'delete' ? ' or removed' : ''}</summary>
            <div data-testid="common-files" style={{ fontFamily: 'monospace', fontSize: 11 }}>{plan.files.map(f => <div key={f}>{f}</div>)}</div>
          </details>
        </div>
      )}
    </Modal>
  )
}
