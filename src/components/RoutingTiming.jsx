import { Button, Input, Popover, Tooltip, Typography } from 'antd'
import { ClockCircleOutlined, ClockCircleFilled } from '@ant-design/icons'
import { TIMING_KEYS, cellTiming, setCellTiming } from '../utils/routingModel'
import { isDuration } from '../utils/routingGenerator'

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
export function TimingFields({ values, placeholders = {}, onChange, readOnly, prefix = '' }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 120px', gap: '6px 10px', alignItems: 'center' }}>
      {TIMING_KEYS.map(key => {
        const value = values[key] ?? ''
        const bad = value !== '' && !isDuration(value)
        return [
          <Tooltip key={`l-${key}`} title={HINTS[key]}><Text style={{ fontSize: 12 }}>{key}</Text></Tooltip>,
          <Input key={key} size="small" aria-label={`${prefix}${key}`} value={value} disabled={readOnly}
            placeholder={placeholders[key] || 'Alertmanager default'} status={bad ? 'error' : undefined}
            onChange={e => onChange(key, e.target.value.trim() || undefined)} />,
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
  const timing = cellTiming(routing, match)
  const overridden = TIMING_KEYS.filter(key => timing[key].overridden)
  const own = Object.fromEntries(overridden.map(key => [key, timing[key].value]))
  const content = (
    <div style={{ width: 260 }}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        Overrides the defaults for {describe} only. Leave empty to use the default.
      </Text>
      <TimingFields values={own} placeholders={routing.defaults} readOnly={readOnly} prefix={`${describe} `}
        onChange={(key, value) => onChange(setCellTiming(routing, match, key, value))} />
    </div>
  )
  return (
    <Popover trigger="click" content={content} title="Timing">
      <Tooltip title={overridden.length ? `Overrides ${overridden.join(', ')}` : 'Timing: the defaults'}>
        <Button type="text" size="small" aria-label={`Timing for ${describe}`}
          data-overridden={overridden.length > 0 || undefined}
          icon={overridden.length
            ? <ClockCircleFilled style={{ color: '#1677ff' }} />
            : <ClockCircleOutlined style={{ color: '#bfbfbf' }} />} />
      </Tooltip>
    </Popover>
  )
}
