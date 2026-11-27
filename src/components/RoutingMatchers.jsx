import { useRef } from 'react'
import { Button, Input, Typography } from 'antd'
import { PlusOutlined, CloseOutlined } from '@ant-design/icons'
import { MATCHERS, setMatchers } from '../utils/routingModel'
import { MATCH_TYPES, matchersProblems } from '../utils/routingSchema'

const { Text } = Typography

const TYPE_NAMES = {
  '=': '= equals',
  '!=': '!= is not',
  '=~': '=~ matches regex',
  '!~': '!~ does not match regex',
}

// Alertmanager reads a label an alert lacks as "": an empty value takes the
// alerts without it for = and =~, those with it for != and !~.
const EMPTY_HINT = {
  '=': '(empty: no such label)',
  '=~': '(empty: no such label)',
  '!=': '(empty: has the label)',
  '!~': '(empty: has the label)',
}

// The fields of a row a problem of matchersProblems is about.
function fieldsOf(why) {
  if (!why) return new Set()
  if (/ is written twice /.test(why)) return new Set(['name', 'matchType'])
  if (why.startsWith('value ')) return new Set(['value'])
  return new Set(['name'])
}

/**
 * The table's own matchers (#225): only alerts that match every one reach
 * a cell; any other is left to the rest of the platform's routes. Each row
 * is a label name, how it is compared and the value, every control a
 * labelled field; a row the save would refuse says why under it, with the
 * same check.
 */
export default function RoutingMatchers({ routing, onChange, readOnly }) {
  const list = Array.isArray(routing[MATCHERS]) ? routing[MATCHERS] : []
  const problems = matchersProblems(list, Object.keys(routing.labels))
  const names = useRef([])
  const add = useRef(null)
  const put = next => onChange(setMatchers(routing, next))
  const change = (i, key, value) => put(list.map((m, j) => (j === i ? { ...m, [key]: value } : m)))
  function addRow() {
    put([...list, { name: '', matchType: '=', value: '' }])
    // The new row's name, once it is there.
    setTimeout(() => names.current[list.length]?.focus())
  }
  function remove(i) {
    put(list.filter((_, j) => j !== i))
    // The keyboard stays near: the row that takes its place, else Add.
    setTimeout(() => (names.current[Math.min(i, list.length - 2)] || add.current)?.focus())
  }
  return (
    <div data-testid="routing-matchers" style={{ marginBottom: 12 }}>
      <Text strong style={{ fontSize: 13 }}>Only these alerts</Text>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
        {list.length
          ? 'An alert must match every condition to reach a cell; any other goes on to the platform\'s other routes. An alert without a label has it as an empty value: region="" takes an alert without the label, region!="" one with it.'
          : 'Every alert reaches the table. Add a condition to take only some, e.g. region =~ eu|eu-.*'}
      </Text>
      {list.map((m, i) => {
        const n = i + 1
        const why = problems[i]
        const errorId = `routing-matcher-${i}-error`
        // Which of the row's fields the problem is about.
        const on = fieldsOf(why)
        const mark = field => (on.has(field) ? { 'aria-invalid': true, 'aria-describedby': errorId, status: 'error' } : {})
        return (
          <div key={i} data-testid={`routing-matcher-${i}`} style={{ marginBottom: 6 }}>
            <div role="group" aria-label={`Condition ${n}`} style={{ display: 'flex', gap: 6, alignItems: 'center', maxWidth: 640 }}>
              <Input size="small" style={{ width: 160 }} aria-label={`Condition ${n} label name`} placeholder="label name"
                value={m.name ?? ''} disabled={readOnly} {...mark('name')}
                ref={el => { names.current[i] = el }}
                onChange={e => change(i, 'name', e.target.value.trim())} />
              <select aria-label={`Condition ${n} match type`} value={m.matchType} disabled={readOnly}
                aria-invalid={on.has('matchType') ? true : undefined} aria-describedby={on.has('matchType') ? errorId : undefined}
                onChange={e => change(i, 'matchType', e.target.value)}
                style={{ height: 24, fontSize: 12, borderRadius: 4, border: `1px solid ${on.has('matchType') ? '#ff4d4f' : '#d9d9d9'}`, background: readOnly ? '#f5f5f5' : '#fff' }}>
                {MATCH_TYPES.map(t => <option key={t} value={t}>{TYPE_NAMES[t]}</option>)}
              </select>
              <Input size="small" style={{ flex: 1 }} aria-label={`Condition ${n} value`} placeholder={EMPTY_HINT[m.matchType] ?? EMPTY_HINT['=']}
                value={m.value ?? ''} disabled={readOnly} {...mark('value')}
                onChange={e => change(i, 'value', e.target.value)} />
              {!readOnly && (
                <Button size="small" type="text" icon={<CloseOutlined aria-hidden />} aria-label={`Remove condition ${n}`} onClick={() => remove(i)} />
              )}
            </div>
            {why && <Text id={errorId} type="danger" style={{ fontSize: 12, display: 'block' }}>{why}</Text>}
          </div>
        )
      })}
      {!readOnly && (
        <Button size="small" icon={<PlusOutlined aria-hidden />} ref={add} onClick={addRow}>Add condition</Button>
      )}
    </div>
  )
}
