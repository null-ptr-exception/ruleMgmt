import { useRef } from 'react'
import { Button, Input, Popover, Tooltip, Typography } from 'antd'
import { ClockCircleOutlined, ClockCircleFilled } from '@ant-design/icons'
import { TIMING_KEYS, cellTiming, setCellTiming } from '../utils/routingModel'
import { timingProblem } from '../utils/routingGenerator'

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
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 120px', gap: '6px 10px', alignItems: 'center' }}>
      {TIMING_KEYS.map((key, i) => {
        const value = values[key] ?? ''
        const problem = value !== '' ? timingProblem(key, value) : null
        return [
          <Tooltip key={`l-${key}`} title={HINTS[key]}><Text style={{ fontSize: 12 }}>{key}</Text></Tooltip>,
          <Tooltip key={key} title={problem}>
            <Input size="small" aria-label={`${prefix}${key}`} value={value} disabled={readOnly}
              ref={i === 0 ? firstRef : undefined}
              placeholder={placeholders[key] || 'Alertmanager default'} status={problem ? 'error' : undefined}
              onChange={e => onChange(key, e.target.value.trim() || undefined)} />
          </Tooltip>,
        ]
      })}
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
  const overridden = TIMING_KEYS.filter(key => timing[key].overridden)
  const own = Object.fromEntries(overridden.map(key => [key, timing[key].value]))
  // A closed popover hides a bad value until Save: mark it on the clock.
  const problem = overridden.map(key => timingProblem(key, timing[key].value)).find(Boolean)
  const invalid = Boolean(problem)
  const content = (
    <div style={{ width: 260 }}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        Overrides the defaults for {describe} only. Leave empty to use the default.
      </Text>
      <TimingFields values={own} placeholders={routing.defaults} readOnly={readOnly} prefix={`${describe} `} firstRef={first}
        onChange={(key, value) => onChange(setCellTiming(routing, match, key, value))} />
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
