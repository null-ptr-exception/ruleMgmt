import { Select, Table, Typography } from 'antd'
import { gridOf, gridMatch, cellAt, setCellConfigs } from '../utils/routingModel'
import FillButton from './FillButton'
import { CellTiming } from './RoutingTiming'

const { Text } = Typography

export const describeMatch = match => Object.entries(match).map(([k, v]) => `${k}=${v}`).join(', ')

/**
 * One cell: who it notifies, and — when it notifies anyone — its timing.
 * Shared by the grid and the list.
 */
export function CellEditor({ routing, match, onChange, readOnly }) {
  const cell = cellAt(routing, match)
  const describe = describeMatch(match)
  return (
    <div data-testid={`cell-${Object.values(match).join('-')}`} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Select
        mode="multiple"
        size="small"
        aria-label={`Notify for ${describe}`}
        placeholder={<Text type="secondary" style={{ fontSize: 12, opacity: 0.6 }}>drop</Text>}
        value={cell?.configs || []}
        options={Object.keys(routing.configs || {}).map(name => ({ value: name, label: name }))}
        disabled={readOnly}
        onChange={configs => onChange(setCellConfigs(routing, match, configs))}
        style={{ flex: 1, minWidth: 140 }}
      />
      {cell && <CellTiming routing={routing} match={match} describe={describe} onChange={onChange} readOnly={readOnly} />}
    </div>
  )
}

/**
 * The routing table as a grid (#93): the last label across, every
 * combination of the others down. A square is a cell of routing.yaml; an
 * empty one drops its alerts, and says so. A row or column header fills
 * every cell in it.
 */
export default function RoutesMatrix({ routing, onChange, readOnly }) {
  const grid = gridOf(routing)
  const fill = (partial, describe) => (
    <FillButton routing={routing} partial={partial} describe={describe} onChange={onChange} readOnly={readOnly} />
  )

  const columns = [
    ...grid.rowLabels.map((name, i) => ({
      title: name,
      key: `row:${name}`,
      width: 120,
      render: (_, row) => (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <Text strong style={{ fontSize: 13 }}>{row[name]}</Text>
          {i === grid.rowLabels.length - 1 && fill(row, describeMatch(row))}
        </span>
      ),
    })),
    ...grid.columns.map(value => ({
      title: (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <span>{grid.columnLabel}=<b>{value}</b></span>
          {fill({ [grid.columnLabel]: value }, `${grid.columnLabel}=${value}`)}
        </span>
      ),
      key: `col:${value}`,
      render: (_, row) => <CellEditor routing={routing} match={gridMatch(grid, row, value)} onChange={onChange} readOnly={readOnly} />,
    })),
  ]

  return (
    <div data-testid="routes-matrix">
      <Table
        size="small"
        bordered
        pagination={false}
        rowKey={row => JSON.stringify(row)}
        dataSource={grid.rows}
        columns={columns}
      />
      <div data-testid="routes-fallthrough" style={{ padding: '6px 8px', fontSize: 12, color: '#8c8c8c', borderBottom: '1px dashed #e5e7eb' }}>
        All other alerts: drop
      </div>
    </div>
  )
}
