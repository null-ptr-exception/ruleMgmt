import { useRef, useState } from 'react'
import { Input, Button, Select, Typography, Modal, Switch, Tooltip } from 'antd'
import { DeleteOutlined, TagOutlined } from '@ant-design/icons'
import PromQLEditor from './PromQLEditor'
import KVEditor from './KVEditor'
import { ruleVars } from '../utils/ruleModel'

const { Text } = Typography
const { TextArea } = Input

const label = text => (
  <Text style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>{text}</Text>
)

/**
 * Edit one x-rules entry.
 *
 * Marking a literal as a variable is the gesture that connects the two layers:
 * it replaces the literal with ${name} here and opens a column for it in the
 * rule owner's table. Anything left un-marked stays fixed and they never see it.
 */
export default function RuleEditor({ rule, columns = [], onChange, onRemove, onAddColumn }) {
  const exprApi = useRef(null)
  const [naming, setNaming] = useState(null)
  const [varName, setVarName] = useState('')

  const isRaw = rule.raw !== undefined
  const update = patch => onChange({ ...rule, ...patch })

  function markSelectionAsVariable() {
    const selection = exprApi.current?.getSelection()
    if (!selection?.text.trim()) return
    setNaming(selection)
    setVarName('')
  }

  function confirmVariable() {
    const name = varName.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return
    exprApi.current.replaceRange(naming.from, naming.to, `\${${name}}`)
    if (!columns.includes(name)) onAddColumn?.(name, naming.text)
    setNaming(null)
  }

  function insertVariable(name) {
    const at = exprApi.current?.getSelection()
    if (at) exprApi.current.replaceRange(at.from, at.to, `\${${name}}`)
  }

  const used = [...ruleVars(rule)]

  return (
    <div style={{ border: '1px solid #e8e8e8', borderRadius: 6, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Input
          size="small"
          placeholder="alert name"
          value={rule.alert || ''}
          disabled={isRaw}
          onChange={e => update({ alert: e.target.value })}
          style={{ fontWeight: 600 }}
        />
        <Tooltip title="Hand-write this one rule as YAML. The resource around it stays generated.">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Text style={{ fontSize: 12, color: '#555' }}>raw</Text>
            <Switch
              size="small"
              checked={isRaw}
              onChange={on => onChange(on
                ? { raw: `alert: ${rule.alert || 'NewAlert'}\nexpr: ${rule.expr || ''}` }
                : { alert: rule.alert || 'NewAlert', expr: '', for: '5m', labels: {}, annotations: {} })}
            />
          </span>
        </Tooltip>
        <Button size="small" danger icon={<DeleteOutlined />} onClick={onRemove} />
      </div>

      {isRaw ? (
        <div>
          {label('Raw rule entry')}
          <TextArea
            rows={8}
            value={rule.raw}
            onChange={e => update({ raw: e.target.value })}
            style={{ fontFamily: 'monospace', fontSize: 12.5 }}
          />
          <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
            One rules[] entry. {'${var}'} still reads the row and {'{{ ... }}'} is still Prometheus.
          </Text>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              {label('Expression')}
              <div style={{ display: 'flex', gap: 6 }}>
                <Button size="small" icon={<TagOutlined />} onClick={markSelectionAsVariable}>
                  Set as variable
                </Button>
                <Select
                  size="small"
                  placeholder="Insert variable"
                  value={null}
                  style={{ width: 150 }}
                  options={columns.map(c => ({ value: c, label: c }))}
                  onChange={insertVariable}
                />
              </div>
            </div>
            <PromQLEditor
              apiRef={exprApi}
              value={rule.expr || ''}
              onChange={expr => update({ expr })}
              minHeight={64}
            />
            <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
              Select a literal and press Set as variable to turn it into a column.
            </Text>
          </div>

          <div style={{ marginBottom: 12, maxWidth: 220 }}>
            {label('For')}
            <Input
              size="small"
              placeholder="5m"
              value={rule.for || ''}
              onChange={e => update({ for: e.target.value })}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            {label('Labels')}
            <KVEditor
              rows={Object.entries(rule.labels || {}).map(([key, value]) => ({ key, value }))}
              onChange={rows => update({ labels: Object.fromEntries(rows.filter(r => r.key).map(r => [r.key, r.value])) })}
            />
          </div>

          <div>
            {label('Annotations')}
            <KVEditor
              rows={Object.entries(rule.annotations || {}).map(([key, value]) => ({ key, value }))}
              onChange={rows => update({ annotations: Object.fromEntries(rows.filter(r => r.key).map(r => [r.key, r.value])) })}
            />
          </div>
        </>
      )}

      {used.length > 0 && (
        <Text type="secondary" style={{ fontSize: 11, marginTop: 10, display: 'block' }}>
          Columns used: {used.join(', ')}
        </Text>
      )}

      <Modal
        open={naming !== null}
        title="Name this variable"
        okText="Create"
        onCancel={() => setNaming(null)}
        onOk={confirmVariable}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          Replacing <code>{naming?.text}</code> with a placeholder, and opening a column of that name in the
          deployment table.
        </Text>
        <Input
          autoFocus
          style={{ marginTop: 12 }}
          placeholder="recv_warn"
          value={varName}
          onChange={e => setVarName(e.target.value)}
          onPressEnter={confirmVariable}
        />
      </Modal>
    </div>
  )
}
