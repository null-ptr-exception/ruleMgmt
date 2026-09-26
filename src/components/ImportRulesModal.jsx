import { useMemo, useState } from 'react'
import { Modal, Input, Typography, Checkbox, Alert, Tag } from 'antd'
import { importRules } from '../utils/ruleImport'

const { Text } = Typography
const { TextArea } = Input

/**
 * Bring existing Prometheus alerting rules in — see issue #57.
 *
 * This is a one-off conversion at the boundary, not an ongoing link: the
 * pasted YAML becomes a schema and then has no further role. The schema stays
 * the only source, and the templates stay its product.
 *
 * What comes out is not a template yet. Every literal stays a literal, because
 * only a person knows whether namespace="prod" varies per row or is part of
 * the query — marking those is the next step, in the editor.
 */
export default function ImportRulesModal({ open, needsName, existingGroups = [], onCancel, onApply }) {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [skipped, setSkipped] = useState({})

  const result = useMemo(() => (text.trim() ? importRules(text) : { groups: [], warnings: [] }), [text])
  const selected = result.groups.filter(g => !skipped[g.key])
  const nameValid = !needsName || /^[a-z0-9][a-z0-9_-]*$/.test(name.trim())

  function close() {
    setText('')
    setName('')
    setSkipped({})
    onCancel()
  }

  function apply() {
    onApply({ groups: selected }, needsName ? name.trim() : undefined)
    setText('')
    setName('')
    setSkipped({})
  }

  return (
    <Modal
      open={open}
      width={720}
      title={needsName ? 'New chart from rules' : 'Import rules into this chart'}
      okText={needsName ? 'Create' : 'Import'}
      okButtonProps={{ disabled: selected.length === 0 || !nameValid }}
      onCancel={close}
      onOk={apply}
    >
      {needsName && (
        <div style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
            Chart name
          </Text>
          <Input
            autoFocus
            placeholder="mariadb-alerts"
            value={name}
            onChange={e => setName(e.target.value)}
            status={name && !nameValid ? 'error' : undefined}
          />
        </div>
      )}

      <Text style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
        Rules
      </Text>
      <TextArea
        rows={10}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={'groups:\n  - name: mariadb-traffic\n    rules:\n      - alert: NetworkReceiveHigh\n        expr: rate(receive_bytes_total[5m]) > 10000000'}
        style={{ fontFamily: 'monospace', fontSize: 12.5 }}
      />
      <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
        A PrometheusRule resource, a rule file with a top-level <code>groups:</code>, or a bare list of
        rule entries.
      </Text>

      {text.trim() && result.groups.length === 0 && (
        <Alert
          type="error"
          style={{ marginTop: 12 }}
          message="Nothing to import"
          description={result.warnings.join('\n') || 'No alerting rules were found.'}
        />
      )}

      {result.groups.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {result.groups.map(group => {
            const replaces = existingGroups.includes(group.key)
            return (
              <div key={group.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
                <Checkbox
                  checked={!skipped[group.key]}
                  onChange={e => setSkipped(prev => ({ ...prev, [group.key]: !e.target.checked }))}
                />
                <Tag color={replaces ? 'error' : 'default'} style={{ marginInlineEnd: 0 }}>
                  {replaces ? 'replaces' : 'adds'}
                </Tag>
                <Text style={{ fontWeight: 600 }}>{group.key}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {group.rules.length} rule(s)
                  {group.columns.length > 0 ? ` — columns: ${group.columns.join(', ')}` : ' — no columns yet'}
                </Text>
              </div>
            )
          })}

          {result.warnings.length > 0 && (
            <Alert
              type="warning"
              style={{ marginTop: 10 }}
              message={<span style={{ fontSize: 12 }}>Not everything came across cleanly</span>}
              description={
                <ul style={{ paddingLeft: 18, margin: 0, fontSize: 12 }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              }
            />
          )}

          <Text type="secondary" style={{ fontSize: 11, marginTop: 10, display: 'block' }}>
            Every literal stays a literal. Use Set as variable afterwards to turn the ones that vary
            per row into columns.
          </Text>
        </div>
      )}
    </Modal>
  )
}
