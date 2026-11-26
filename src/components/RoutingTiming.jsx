import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, Input, Popover, Tag, Tooltip, Typography } from 'antd'
import { ClockCircleOutlined, ClockCircleFilled, CloseOutlined } from '@ant-design/icons'
import { TIMING_KEYS, GROUP_BY, cellAt, cellTiming, cellGroupBy, setCellTiming } from '../utils/routingModel'
import { timingProblem } from '../utils/routingGenerator'
import { groupByProblem, GROUP_BY_ALL } from '../utils/routingSchema'

const { Text } = Typography

const HINTS = {
  groupWait: 'wait before the first notification of a new group',
  groupInterval: 'wait before notifying about new alerts in a group',
  repeatInterval: 'wait before notifying again about the same alerts',
}

/**
 * The three timing keys as inputs. An empty input means "not set here":
 * the placeholder says what applies instead.
 */
export function TimingFields({ values, placeholders = {}, onChange, readOnly, prefix = '', firstRef }) {
  const id = useId()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 120px', gap: '6px 10px', alignItems: 'center' }}>
      {TIMING_KEYS.map((key, i) => {
        const value = values[key] ?? ''
        const problem = value !== '' ? timingProblem(key, value) : null
        // The red mark and the tooltip are visual; the reason is also the
        // field's description, for a screen reader.
        const errorId = `${id}-${key}-error`
        return [
          <Tooltip key={`l-${key}`} title={HINTS[key]}><Text style={{ fontSize: 12 }}>{key}</Text></Tooltip>,
          // On a wrapper: the tooltip sets its own aria-describedby on its child.
          <Tooltip key={key} title={problem}><span>
            <Input size="small" aria-label={`${prefix}${key}`} value={value} disabled={readOnly}
              aria-invalid={problem ? true : undefined} aria-describedby={problem ? errorId : undefined}
              ref={i === 0 ? firstRef : undefined}
              placeholder={placeholders[key] || 'Alertmanager default'} status={problem ? 'error' : undefined}
              onChange={e => onChange(key, e.target.value.trim() || undefined)} />
          </span></Tooltip>,
          problem && <span key={`e-${key}`} id={errorId} hidden>{problem}</span>,
        ]
      })}
    </div>
  )
}

/**
 * The names typed into the page's groupBy fields and not entered yet, so a
 * save does not lose them while the field still shows them: the page makes
 * one (usePendingNames) and hands it down (PendingNames); each field
 * registers what it holds and where its list is in the routing.
 */
export const PendingNames = createContext(null)

export function usePendingNames() {
  const [, setTick] = useState(0)
  return useMemo(() => {
    const entries = new Map()
    return {
      entries,
      // A field's typing: the page asks again whether anything is pending.
      touch: () => setTick(t => t + 1),
      any: () => [...entries.values()].some(e => e.current.draft.trim() !== ''),
      /**
       * Each pending name added to its list in `routing`, as Enter adds it;
       * one already listed is no change. One the save would refuse is
       * shown in its field and returned in `problems`, naming the field.
       */
      take(routing) {
        let next = routing
        const problems = []
        const taken = []
        for (const entry of entries.values()) {
          const { label, draft, current, put } = entry.current
          const name = draft.trim()
          if (!name) continue
          const list = current(next) || []
          if (list.includes(name)) { taken.push(entry); continue }
          const why = groupByProblem([...list, name])
          if (why) {
            problems.push(`${label}: ${why}`)
            entry.current.refuse(why)
          } else {
            next = put(next, [...list, name])
            taken.push(entry)
          }
        }
        if (!problems.length) for (const entry of taken) entry.current.clear()
        return { routing: next, problems }
      },
    }
  }, [])
}

/**
 * groupBy as a list of label names: one is added per Enter, or when the
 * field is left, its ends trimmed and as typed otherwise — a space or a
 * comma is part of what was typed, never a separator. A name already
 * listed, or one the save would refuse, is not added: it stays in the
 * input, with why. Backspace in the empty input takes the last name off,
 * and each name has its own remove button. An empty list means "not set
 * here": the placeholder says what applies instead.
 *
 * `current(routing)` is the list as the routing has it and `put(routing,
 * list)` the routing with another: what Save uses for a name not entered.
 */
export function GroupByField({ value, placeholder, onChange, readOnly, label, current, put }) {
  const id = useId()
  const input = useRef(null)
  const [draft, setDraft] = useState('')
  const [why, setWhy] = useState(null)
  const names = value || []
  const pending = useContext(PendingNames)
  const entry = useRef(null)
  entry.current = { label, draft, current, put, clear: () => { setDraft(''); setWhy(null) }, refuse: setWhy }
  useEffect(() => {
    if (!pending || !current || !put) return
    const key = {}
    pending.entries.set(key, entry)
    return () => { pending.entries.delete(key); pending.touch() }
  }, [pending, Boolean(current && put)])
  function type(text) {
    setDraft(text)
    setWhy(null)
    // The page renders before this field does: it reads the text from here.
    entry.current = { ...entry.current, draft: text }
    pending?.touch()
  }
  function add() {
    const name = draft.trim()
    if (!name) return
    const problem = names.includes(name) ? `${name} is already listed` : groupByProblem([...names, name])
    if (problem) {
      setWhy(problem)
      return
    }
    type('')
    onChange([...names, name])
  }
  function remove(name) {
    onChange(names.filter(n => n !== name))
    // The button goes with its name: the keyboard stays in the field.
    input.current?.focus()
  }
  const errorId = `${id}-error`
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 10px', alignItems: 'start' }}>
      <Tooltip title={`labels whose values put alerts in one notification; ${GROUP_BY_ALL} for every label`}>
        <Text style={{ fontSize: 12, lineHeight: '24px' }}>{GROUP_BY}</Text>
      </Tooltip>
      <div>
        {names.length > 0 && (
          <div role="group" aria-label={`${label} names`} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
            {names.map(name => (
              <Tag key={name} style={{ marginInlineEnd: 0 }}>
                {name}
                {!readOnly && (
                  <button type="button" aria-label={`Remove ${name} from ${label}`} onClick={() => remove(name)}
                    style={{ border: 'none', background: 'none', padding: 0, marginInlineStart: 4, cursor: 'pointer', color: 'inherit', fontSize: 10 }}>
                    <CloseOutlined aria-hidden />
                  </button>
                )}
              </Tag>
            ))}
          </div>
        )}
        <Input size="small" ref={input} aria-label={label} value={draft} disabled={readOnly}
          placeholder={names.length ? 'add a label name, press Enter' : placeholder?.length ? placeholder.join(', ') : 'the platform\'s grouping'}
          status={why ? 'error' : undefined} aria-invalid={why ? true : undefined} aria-describedby={why ? errorId : undefined}
          onChange={e => type(e.target.value)}
          onBlur={add}
          onKeyDown={e => {
            if (e.key === 'Backspace' && draft === '' && names.length) onChange(names.slice(0, -1))
          }}
          onPressEnter={e => { e.preventDefault(); add() }} />
        {why && <Text id={errorId} type="danger" style={{ fontSize: 12, display: 'block' }}>{why}</Text>}
      </div>
    </div>
  )
}

/**
 * A cell's timing (#93): the defaults unless the cell overrides a key. An
 * overriding cell's clock is filled, so it stands out in the table.
 */
export function CellTiming({ routing, match, describe, onChange, readOnly }) {
  const first = useRef(null)
  const timing = cellTiming(routing, match)
  const groupBy = cellGroupBy(routing, match)
  const overridden = [...(groupBy.overridden ? [GROUP_BY] : []), ...TIMING_KEYS.filter(key => timing[key].overridden)]
  const own = Object.fromEntries(TIMING_KEYS.filter(key => timing[key].overridden).map(key => [key, timing[key].value]))
  // A closed popover hides a bad value until Save: mark it on the clock.
  const problem = TIMING_KEYS.filter(key => timing[key].overridden).map(key => timingProblem(key, timing[key].value)).find(Boolean)
  const invalid = Boolean(problem)
  const content = (
    <div style={{ width: 260 }}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        Overrides the defaults for {describe} only. Leave empty to use the default.
      </Text>
      <TimingFields values={own} placeholders={routing.defaults} readOnly={readOnly} prefix={`${describe} `} firstRef={first}
        onChange={(key, value) => onChange(setCellTiming(routing, match, key, value))} />
      <div style={{ marginTop: 6 }}>
        <GroupByField value={groupBy.overridden ? groupBy.value : []} placeholder={routing.defaults?.[GROUP_BY]} readOnly={readOnly}
          label={`${describe} ${GROUP_BY}`} onChange={list => onChange(setCellTiming(routing, match, GROUP_BY, list))}
          current={r => cellAt(r, match)?.[GROUP_BY]} put={(r, list) => setCellTiming(r, match, GROUP_BY, list)} />
      </div>
    </div>
  )
  return (
    <Popover trigger="click" content={content} title="Timing" afterOpenChange={open => open && first.current?.focus()}>
      <Tooltip title={invalid ? problem
        : overridden.length ? `Overrides ${overridden.join(', ')}` : 'Timing: the defaults'}>
        <Button type="text" size="small" aria-label={`Timing for ${describe}`}
          data-overridden={overridden.length > 0 || undefined} data-invalid={invalid || undefined}
          icon={overridden.length
            ? <ClockCircleFilled style={{ color: invalid ? '#ff4d4f' : '#1677ff' }} />
            : <ClockCircleOutlined style={{ color: '#bfbfbf' }} />} />
      </Tooltip>
    </Popover>
  )
}
