import { Select, Table, Typography } from 'antd'
import { gridOf, gridMatch, cellAt, setCellConfigs } from '../utils/routingModel'

const { Text } = Typography

/**
 * The routing table as a grid (#93): the last label across, every
 * combination of the others down. A square is a cell of routing.yaml; an
 * empty one drops its alerts, and says so.
 */
export default function RoutesMatrix({ routing, onChange, readOnly }) {
  const grid = gridOf(routing)
  const options = Object.keys(routing.configs || {}).map(name => ({ value: name, label: name }))
  const rowKey = row => JSON.stringify(row)

  const columns = [
    ...grid.rowLabels.map(name => ({
      title: name,
      key: `row:${name}`,
      width: 120,
      render: (_, row) => <Text strong style={{ fontSize: 13 }}>{row[name]}</Text>,
    })),
    ...grid.columns.map(value => ({
      title: <span>{grid.columnLabel}=<b>{value}</b></span>,
      key: `col:${value}`,
      render: (_, row) => {
        const match = gridMatch(grid, row, value)
        const label = Object.entries(match).map(([k, v]) => `${k}=${v}`).join(', ')
        return (
          <div data-testid={`cell-${Object.values(match).join('-')}`}>
          <Select
            mode="multiple"
            size="small"
            aria-label={`Notify for ${label}`}
            placeholder={<Text type="secondary" style={{ fontSize: 12, opacity: 0.6 }}>drop</Text>}
            value={cellAt(routing, match)?.configs || []}
            options={options}
            disabled={readOnly}
            onChange={configs => onChange(setCellConfigs(routing, match, configs))}
            style={{ width: '100%', minWidth: 140 }}
          />
          </div>
        )
      },
    })),
  ]

  return (
    <div data-testid="routes-matrix">
      <Table
        size="small"
        bordered
        pagination={false}
        rowKey={rowKey}
        dataSource={grid.rows}
        columns={columns}
      />
      <div data-testid="routes-fallthrough" style={{ padding: '6px 8px', fontSize: 12, color: '#8c8c8c', borderBottom: '1px dashed #e5e7eb' }}>
        All other alerts: drop
      </div>
    </div>
  )
}
