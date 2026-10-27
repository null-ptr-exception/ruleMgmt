import { Table, Typography } from 'antd'
import { combinations } from '../utils/routingModel'
import { CellEditor } from './RoutesMatrix'

const { Text } = Typography

/**
 * The routing table as a list (#93): one row per combination, the shape of
 * the Alerts page's table — what three or more labels need, since a grid of
 * them is too wide to read.
 */
export default function RoutesList({ routing, onChange, readOnly }) {
  const names = Object.keys(routing.labels)
  const rows = combinations(routing.labels)
  return (
    <div data-testid="routes-list">
      <Table
        size="small"
        bordered
        pagination={false}
        rowKey={row => JSON.stringify(row)}
        dataSource={rows}
        columns={[
          ...names.map(name => ({
            title: name,
            key: name,
            width: 120,
            render: (_, row) => <Text style={{ fontSize: 13 }}>{row[name]}</Text>,
          })),
          {
            title: 'Notify',
            key: 'notify',
            render: (_, row) => <CellEditor routing={routing} match={row} onChange={onChange} readOnly={readOnly} />,
          },
        ]}
      />
      <div data-testid="routes-fallthrough" style={{ padding: '6px 8px', fontSize: 12, color: '#8c8c8c', borderBottom: '1px dashed #e5e7eb' }}>
        All other alerts: drop
      </div>
    </div>
  )
}
