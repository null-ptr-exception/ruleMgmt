import { useEffect, useMemo, useState } from 'react'
import { Modal, Steps, Typography, Select, Table, Tag, Input, Button, Alert, Space } from 'antd'
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
    const m = { columns: {}, groups: {}, dropped: [] }
    for (const c of decisions) {
      if (c.kind === 'column-removed') {
        const target = colMap[`${c.group}␟${c.column}`]
        if (!target || target === DELETE) m.dropped.push(c.column)
        else m.columns[c.column] = target
      } else if (c.kind === 'group-removed') {
        const target = groupMap[c.group]
        if (target && target !== DELETE) m.groups[c.group] = target
      }
    }
    return m
  }, [decisions, colMap, groupMap])

  async function goToPreview() {
    setPreview(null)
    setStep(2)
    setPreview(await migrationPreview(chart, files, migration))
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
        {readonlyCount > 0 && ` (${readonlyCount} follow a source automatically)`}
      </Text>
      <ul style={{ marginTop: 4 }}>
        {deployments.map(d => (
          <li key={d.path}>
            {d.path}{d.readonly && <Tag color="default" style={{ marginLeft: 6 }}>follows automatically</Tag>}
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
          { title: 'Deployment', dataIndex: 'path', render: (p, d) => <>{p}{d.readonly && <Tag style={{ marginLeft: 6 }}>follows automatically</Tag>}</> },
          { title: 'Rows changed', dataIndex: 'rowsChanged', width: 110 },
          {
            title: 'Values lost', render: (_, d) => (d.losses || []).length
              ? (d.losses.map(l => `${l.group}: ${l.columns.join(', ')}`).join('; '))
              : <Text type="secondary">none</Text>,
          },
        ]}
      />
    )

  const cloneControl = (
    <Space.Compact>
      <Input size="small" placeholder="new-chart-name" value={cloneName} onChange={e => setCloneName(e.target.value)} style={{ width: 200 }} />
      <Button size="small" disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(cloneName)} onClick={() => onClone(cloneName, migration)}>
        Clone to a new chart
      </Button>
    </Space.Compact>
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
            <Button type="primary" danger onClick={() => onApplyInPlace(migration)}>Change in place</Button>
          )}
        </div>
      </div>

      <Paragraph type="secondary" style={{ fontSize: 11, marginTop: 12, marginBottom: 0 }}>
        Cloning leaves the current chart untouched; its deployments must be moved by hand.
      </Paragraph>
    </Modal>
  )
}
