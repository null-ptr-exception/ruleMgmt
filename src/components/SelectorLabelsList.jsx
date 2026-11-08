import { Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'

/**
 * The label a selector column matches in each rule (#133), for a tooltip —
 * shown only for a column some rule matches under another name (#121).
 */
export default function SelectorLabelsList({ column, pairs }) {
  return (
    <div data-testid={`selector-labels-list-${column}`}>
      <div>{column} matches the label</div>
      {pairs.map(([rule, label], i) => (
        <div key={i} style={{ paddingLeft: 12, whiteSpace: 'nowrap' }}>{rule}: {label}</div>
      ))}
    </div>
  )
}

/** An info icon beside a column's name that shows the list on hover or keyboard focus. */
export function SelectorLabelsHint({ column, pairs }) {
  return (
    <Tooltip title={<SelectorLabelsList column={column} pairs={pairs} />} trigger={['hover', 'focus']} styles={{ root: { maxWidth: 480 } }}>
      <InfoCircleOutlined tabIndex={0} aria-label={`Labels ${column} matches`} data-testid={`selector-labels-${column}`}
        style={{ fontSize: 12, color: '#8c8c8c' }} />
    </Tooltip>
  )
}
