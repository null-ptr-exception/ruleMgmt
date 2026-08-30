import { useEffect, useRef, useState } from 'react'
import { Input, Button, Select, Typography, Modal, Switch, Tooltip, Tag } from 'antd'
import { DeleteOutlined, TagOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
import PromQLEditor from './PromQLEditor'
import KVEditor from './KVEditor'
import { ruleVars } from '../utils/ruleModel'

const { Text } = Typography
const { TextArea } = Input

const toRows = map => Object.entries(map || {}).map(([key, value]) => ({ key, value }))

/**
 * Keep the blank rows the user is still typing into, while picking up any
 * change that came from outside the editor.
 */
function reconcile(rows, map) {
  const incoming = toRows(map)
  const blanks = rows.filter(r => !r.key)
  const sameNamed = rows.filter(r => r.key)
  const unchanged =
    sameNamed.length === incoming.length &&
    sameNamed.every((r, i) => r.key === incoming[i].key && r.value === incoming[i].value)
  return unchanged ? rows : [...incoming, ...blanks]
}

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
export default function RuleEditor({ rule, columns = [], collapsed = false, onToggleCollapse, onChange, onRemove, onAddColumn }) {
  const exprApi = useRef(null)
  const [naming, setNaming] = useState(null)
  const [varName, setVarName] = useState('')

  const isRaw = rule.raw !== undefined
  const update = patch => onChange({ ...rule, ...patch })

  // Labels and annotations are a map in the schema, which cannot hold the blank
  // row you get right after pressing Add row — the key is its identity. The
  // rows are kept here as a list so a new one survives long enough to be typed
  // into, and only the named ones are written back.
  const [labelRows, setLabelRows] = useState(() => toRows(rule.labels))
  const [annotationRows, setAnnotationRows] = useState(() => toRows(rule.annotations))

  useEffect(() => { setLabelRows(rows => reconcile(rows, rule.labels)) }, [rule.labels])
  useEffect(() => { setAnnotationRows(rows => reconcile(rows, rule.annotations)) }, [rule.annotations])

  function writeBack(rows, field) {
    update({ [field]: Object.fromEntries(rows.filter(r => r.key).map(r => [r.key, r.value])) })
  }

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
  // A reference with no column renders as an empty value at deploy time, so it
  // is called out here rather than discovered in the rendered resource. A
  // collapsed rule still says how many it has, so folding one away cannot hide
  // a problem.
  const missing = used.filter(name => !columns.includes(name))

  const severity = (rule.labels || {}).severity
  const summary = (rule.raw || rule.expr || '').split('\n')[0]

  if (collapsed) {
    return (
      <div
        onClick={onToggleCollapse}
        style={{
          border: '1px solid #e8e8e8', borderRadius: 6, padding: '8px 12px', marginBottom: 8,
          display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer'
        }}
      >
        <RightOutlined style={{ fontSize: 11, color: '#999' }} />
        <Text style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{rule.alert || '(unnamed)'}</Text>
        {severity && <Tag style={{ marginInlineEnd: 0 }}>{severity}</Tag>}
        {isRaw && <Tag style={{ marginInlineEnd: 0 }}>raw</Tag>}
        {missing.length > 0 && <Tag color="error" style={{ marginInlineEnd: 0 }}>{missing.length} unresolved</Tag>}
        <Text type="secondary" ellipsis style={{ fontSize: 11, fontFamily: 'monospace', flex: 1, minWidth: 0 }}>
          {summary}
        </Text>
        <Button size="small" danger icon={<DeleteOutlined />} onClick={e => { e.stopPropagation(); onRemove() }} />
      </div>
    )
  }

  return (
    <div style={{ border: '1px solid #e8e8e8', borderRadius: 6, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Button
          size="small"
          type="text"
          icon={<DownOutlined style={{ fontSize: 11, color: '#999' }} />}
          onClick={onToggleCollapse}
        />
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
            <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
              A duration, or a column: <code>{'${window}'}</code>.
            </Text>
          </div>

          <div style={{ marginBottom: 12 }}>
            {label('Labels')}
            <KVEditor
              rows={labelRows}
              onChange={rows => { setLabelRows(rows); writeBack(rows, 'labels') }}
            />
            <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
              A value may be literal (<code>warning</code>), a column (<code>{'${namespace}'}</code>),
              or a Prometheus template (<code>{'{{ $labels.pod }}'}</code>).
            </Text>
          </div>

          <div>
            {label('Annotations')}
            <KVEditor
              rows={annotationRows}
              onChange={rows => { setAnnotationRows(rows); writeBack(rows, 'annotations') }}
            />
            <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
              Same as labels — <code>{'{{ $value }}'}</code> is evaluated by Prometheus when the
              alert fires, not here.
            </Text>
          </div>
        </>
      )}

      {used.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Columns used:{' '}
            {used.map((name, i) => (
              <span key={name}>
                {i > 0 && ', '}
                <span style={missing.includes(name) ? { color: '#cf1322', fontWeight: 600 } : undefined}>{name}</span>
              </span>
            ))}
          </Text>
          {missing.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Text type="danger" style={{ fontSize: 11 }}>
                No column named {missing.join(', ')}. Create {missing.length > 1 ? 'them' : 'it'}, or fix the reference.
              </Text>
              {missing.map(name => (
                <Button key={name} size="small" onClick={() => onAddColumn?.(name, '')}>
                  Create {name}
                </Button>
              ))}
            </div>
          )}
        </div>
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
