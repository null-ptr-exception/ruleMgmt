import { useState } from 'react'
import { Modal, Alert, Switch, Typography, Empty } from 'antd'

const { Text } = Typography

// The rule owner is looking at products, not authoring them. The default view
// is a summary: how many alerts each group produced, by name and severity, and
// — the cell that matters most — which of a group's alerts produced nothing,
// because the rendered YAML never contains an alert that wasn't produced. Raw
// YAML is one toggle away for when the summary isn't enough.
export default function PreviewModal({ open, onClose, yaml, check, selfCheck, summary }) {
  const [raw, setRaw] = useState(false)

  const failed = yaml && yaml.startsWith('Error:')

  return (
    <Modal title="Preview" open={open} onCancel={onClose} footer={null} width={800}>
      {check && (
        <Alert
          style={{ marginBottom: 12 }}
          type={check.skipped ? 'info' : check.passed ? 'success' : 'error'}
          showIcon
          message={check.skipped ? 'Promtool check skipped' : check.passed ? 'Promtool check passed' : 'Promtool check failed'}
          description={check.output
            ? <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflow: 'auto' }}>{check.output}</div>
            : null}
        />
      )}

      {selfCheck && !selfCheck.passed && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message="Rendered output has problems promtool can't see"
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{selfCheck.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        />
      )}

      {!failed && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Text strong style={{ fontSize: 15 }}>
            {summary ? `${summary.total} alert${summary.total === 1 ? '' : 's'} total` : 'Rendered rules'}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Raw YAML <Switch size="small" checked={raw} onChange={setRaw} style={{ marginLeft: 6 }} />
          </Text>
        </div>
      )}

      {failed
        ? <pre style={preStyle}>{yaml}</pre>
        : raw || !summary
          ? <pre style={preStyle}>{yaml || 'No output'}</pre>
          : <Summary summary={summary} />}
    </Modal>
  )
}

function Summary({ summary }) {
  if (!summary.groups.length) return <Empty description="This deployment rendered nothing" />

  return (
    <div>
      {summary.orphanFields.length > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`${summary.orphanFields.length} value field${summary.orphanFields.length === 1 ? '' : 's'} not in the template: ${summary.orphanFields.join(', ')}`}
        />
      )}
      {summary.groups.map(g => <GroupRow key={g.name} group={g} />)}
    </div>
  )
}

function GroupRow({ group }) {
  const total = group.alerts.reduce((n, a) => n + a.count, 0)
  return (
    <div style={{ borderTop: '1px solid #f0f0f0', padding: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text strong style={{ fontFamily: 'monospace' }}>{group.name}</Text>
        {group.state === 'empty'
          ? <Text type="secondary">not filled in</Text>
          : <Text type="secondary">{total} alert{total === 1 ? '' : 's'}</Text>}
      </div>

      {group.state === 'no-alerts' && (
        <div style={{ color: '#d46b08', fontSize: 13, marginTop: 4 }}>
          ⚠ has {group.rowCount} row{group.rowCount === 1 ? '' : 's'} but produced no alerts
        </div>
      )}

      {group.state !== 'empty' && (
        <table style={{ marginTop: 6, fontSize: 13, borderCollapse: 'collapse' }}>
          <tbody>
            {group.alerts.map((a, i) => (
              <tr key={`a${i}`}>
                <td style={cell}><Text style={{ fontFamily: 'monospace' }}>{a.alert}</Text></td>
                <td style={cell}><Text type="secondary">{a.severity || '—'}</Text></td>
                <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{a.count}</td>
              </tr>
            ))}
            {group.missing.map((m, i) => (
              <tr key={`m${i}`} style={{ opacity: 0.55 }}>
                <td style={cell}><Text style={{ fontFamily: 'monospace' }}>{m.alert}</Text></td>
                <td style={cell}><Text type="secondary">{m.severity || '—'}</Text></td>
                <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>0</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

const cell = { padding: '2px 16px 2px 0' }
const preStyle = {
  background: '#0f172a', color: '#7dd3fc', padding: 16, borderRadius: 8,
  fontSize: 12, fontFamily: 'monospace', maxHeight: 500, overflow: 'auto',
  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
}
