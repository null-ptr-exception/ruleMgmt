import { useEffect, useMemo, useState } from 'react'
import { Modal, Steps, Typography, Select, Table, Tag, Input, Button, Alert, Space, message } from 'antd'
import { migrationPreview } from '../utils/chartApi'

const { Text, Paragraph } = Typography

const DELETE = '__delete__'
const NEEDS_DECISION = new Set(['column-removed', 'group-removed'])

/**
 * The breaking-change flow (issue #57, 收斂四 §六): a change that would orphan
 * a rule owner's rows is made in place, with the template owner declaring how
 * each disappearing column maps; the server then rewrites every deployment's
 * values.yaml. Cloning is the escape hatch.
 */
export default function BreakingChangeDialog({ open, payload, chart, files, onCancel, onApplyInPlace, onClone }) {
  const { breaking = [], notices = [], added = { groups: [], columns: {} }, deployments = [] } = payload || {}

  const decisions = breaking.filter(c => NEEDS_DECISION.has(c.kind))
  const fyi = [...breaking.filter(c => !NEEDS_DECISION.has(c.kind)), ...notices]

  const [step, setStep] = useState(0)
  const [colMap, setColMap] = useState({})     // "group␟ col" -> DELETE | newCol
  const [groupMap, setGroupMap] = useState({}) // group -> DELETE | newGroup
  const [preview, setPreview] = useState(null)
  const [cloneName, setCloneName] = useState('')

  useEffect(() => {
    if (!open) { setStep(0); setColMap({}); setGroupMap({}); setPreview(null); setCloneName('') }
  }, [open])

  const migration = useMemo(() => {
    // Per group: the same column name in another group is another column.
    const m = { columns: {}, groups: {}, dropped: {} }
    for (const c of decisions) {
      if (c.kind === 'column-removed') {
        const target = colMap[`${c.group}␟${c.column}`]
        if (!target || target === DELETE) (m.dropped[c.group] ||= []).push(c.column)
        else (m.columns[c.group] ||= {})[c.column] = target
      } else if (c.kind === 'group-removed') {
        const target = groupMap[c.group]
        if (target && target !== DELETE) m.groups[c.group] = target
      }
    }
    return m
  }, [decisions, colMap, groupMap])

  // A preview that cannot be worked out (an answer cut off) goes back a step
  // and says so: it used to stay on "Working it out…", Change in place off.
  async function goToPreview() {
    setPreview(null)
    setStep(2)
    try {
      setPreview(await migrationPreview(chart, files, migration))
    } catch (err) {
      setStep(hasDecisions ? 1 : 0)
      message.error(`The preview could not be worked out (${err.message}). Try Continue again.`)
    }
  }

  const hasDecisions = decisions.length > 0

  const readonlyCount = deployments.filter(d => d.readonly).length

  const summary = (
    <div>
      {hasDecisions ? (
        <>
          <Text strong>Needs a decision</Text>
          <ul style={{ marginTop: 4 }}>
            {decisions.map((c, i) => <li key={i}>{c.description}</li>)}
          </ul>
        </>
      ) : (
        <Alert type="info" showIcon message="Nothing disappears — nothing to map. The changes below only need your acknowledgement." />
      )}

      {fyi.length > 0 && (
        <>
          <Text strong style={{ display: 'block', marginTop: 12 }}>Just so you know</Text>
          <ul style={{ marginTop: 4 }}>
            {fyi.map((c, i) => <li key={i}>{c.description}</li>)}
          </ul>
        </>
      )}

      <Text strong style={{ display: 'block', marginTop: 12 }}>
        Affects {deployments.length} deployment{deployments.length === 1 ? '' : 's'}
        {readonlyCount > 0 && ` (${readonlyCount} synced from another deployment)`}
      </Text>
      <ul style={{ marginTop: 4 }}>
        {deployments.map(d => (
          <li key={d.path}>
            {d.path}{d.readonly && <Tag color="default" style={{ marginLeft: 6 }}>synced</Tag>}
          </li>
        ))}
      </ul>
    </div>
  )

  const mappingRows = [
    ...decisions.filter(c => c.kind === 'column-removed').map(c => ({
      key: `${c.group}␟${c.column}`, kind: 'column', group: c.group, name: c.column,
      options: added.columns[c.group] || [],
      value: colMap[`${c.group}␟${c.column}`] || DELETE,
      set: v => setColMap(m => ({ ...m, [`${c.group}␟${c.column}`]: v })),
    })),
    ...decisions.filter(c => c.kind === 'group-removed').map(c => ({
      key: `group␟${c.group}`, kind: 'group', group: c.group, name: c.group,
      options: added.groups || [],
      value: groupMap[c.group] || DELETE,
      set: v => setGroupMap(m => ({ ...m, [c.group]: v })),
    })),
  ]

  const mapping = (
    <Table
      size="small" pagination={false} rowKey="key" dataSource={mappingRows}
      columns={[
        { title: 'Gone', dataIndex: 'name', render: (n, r) => <><Tag>{r.kind}</Tag> {r.group !== n && <Text type="secondary">{r.group} / </Text>}<b>{n}</b></> },
        {
          title: 'Becomes', render: (_, r) => (
            <Select size="small" style={{ width: 220 }} value={r.value} onChange={r.set}
              options={[{ value: DELETE, label: 'Delete (value not kept)' }, ...r.options.map(o => ({ value: o, label: o }))]} />
          ),
        },
      ]}
    />
  )

  const previewView = preview == null
    ? <Text type="secondary">Working it out…</Text>
    : (
      <Table
        size="small" pagination={false} rowKey="path" dataSource={preview.deployments || []}
        columns={[
          { title: 'Deployment', dataIndex: 'path', render: (p, d) => <>{p}{d.readonly && <Tag style={{ marginLeft: 6 }}>{d.copiedFrom ? `copied from ${d.copiedFrom}` : 'synced — migrated on its own'}</Tag>}</> },
          { title: 'Rows changed', dataIndex: 'rowsChanged', width: 110 },
          {
            title: 'Values lost', render: (_, d) => (d.losses || []).length
              ? (d.losses.map(l => `${l.group}: ${l.columns.join(', ')}`).join('; '))
              : <Text type="secondary">none</Text>,
          },
          // What a values save would refuse in the migrated file (#176).
          {
            title: 'Problems', render: (_, d) => (d.problems || []).length
              ? (
                <ul data-testid="migration-problems" style={{ paddingLeft: 18, margin: 0 }}>
                  {d.problems.map((p, i) => (
                    <li key={i}>{p.message}{p.before && <Tag color="orange" style={{ marginLeft: 6 }}>already there before</Tag>}</li>
                  ))}
                </ul>
              )
              : <Text type="secondary">none</Text>,
          },
        ]}
      />
    )
  // Problems this change would cause stop it; ones a deployment already had
  // are shown, but are no reason to hold the change up.
  const refused = (preview?.deployments || []).filter(d => d.problems?.some(p => !p.before))
  // One on a _common reached through a link made by hand is held by the
  // link, which its row says in full: no mapping changes that, so it is
  // not named among those that "would get values a save refuses".
  const valuesRefused = refused.filter(d => !d.linked)

  // No deployment moves to the clone by itself (#57, #178): it is said here,
  // where the choice is made.
  const cloneControl = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Space.Compact>
        <Input size="small" placeholder="new-chart-name" value={cloneName} onChange={e => setCloneName(e.target.value)} style={{ width: 200 }} />
        <Button size="small" disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(cloneName)} onClick={() => onClone(cloneName, migration)}>
          Clone to a new chart
        </Button>
      </Space.Compact>
      <Text type="secondary" data-testid="clone-by-hand" style={{ fontSize: 12 }}>
        This chart and its deployments stay as they are. A deployment moves to the clone by hand: its Chart.yaml and values.yaml (see the how-to, “Move a deployment to a cloned chart”).
      </Text>
    </div>
  )

  return (
    <Modal
      open={open} width={720} title="This change breaks existing deployments"
      onCancel={onCancel} maskClosable={false} footer={null}
    >
      <Steps size="small" current={step} style={{ margin: '8px 0 16px' }}
        items={[{ title: 'Summary' }, { title: 'Map', disabled: !hasDecisions }, { title: 'Preview' }]} />

      {step === 0 && summary}
      {step === 1 && (
        <>
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            For each thing that goes away: keep its value under a new column, or drop it. Default is drop.
          </Paragraph>
          {mapping}
        </>
      )}
      {step === 2 && previewView}
      {step === 2 && valuesRefused.length > 0 && (
        <Alert style={{ marginTop: 12 }} type="error" data-testid="migration-refused"
          message={`${valuesRefused.map(d => d.path).join(', ')} would get values a save refuses. Change the mapping, or fix ${valuesRefused.length === 1 ? 'that deployment' : 'those deployments'} first${valuesRefused.some(d => d.readonly) ? ' (one synced from another deployment is read-only: unlink it first)' : ''}.`} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', marginTop: 20 }}>
        <div>{cloneControl}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button onClick={onCancel}>Cancel</Button>
          {step > 0 && <Button onClick={() => setStep(hasDecisions ? step - 1 : 0)}>Back</Button>}
          {step === 0 && (
            <Button type="primary" onClick={() => (hasDecisions ? setStep(1) : goToPreview())}>Continue</Button>
          )}
          {step === 1 && <Button type="primary" onClick={goToPreview}>Continue</Button>}
          {step === 2 && (
            <Button type="primary" danger disabled={preview == null || refused.length > 0} onClick={() => onApplyInPlace(migration)}>Change in place</Button>
          )}
        </div>
      </div>

      <Paragraph type="secondary" style={{ fontSize: 11, marginTop: 12, marginBottom: 0 }}>
        Cloning leaves the current chart untouched; its deployments must be moved by hand.
      </Paragraph>
    </Modal>
  )
}
