import { Table, Input, Button } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

// A row keeps one identity from creation to removal. Its index would not:
// removing a row renumbers every row after it, and React would then hand one
// row's focused input to another. A row that arrives without one is given one
// on first sight, and it is carried into every edited copy.
const rowIds = new WeakMap()
let lastRowId = 0
function rowId(row) {
  if (row._id != null) return row._id
  if (!rowIds.has(row)) rowIds.set(row, ++lastRowId)
  return rowIds.get(row)
}

export default function KVEditor({ rows, onChange, keyPlaceholder = 'key', valuePlaceholder = 'value' }) {
  function update(i, field, val) {
    const next = rows.map((r, idx) => idx === i ? { ...r, _id: rowId(r), [field]: val } : r)
    onChange(next)
  }

  function add() {
    onChange([...rows, { key: '', value: '', _id: ++lastRowId }])
  }

  function remove(i) {
    onChange(rows.filter((_, idx) => idx !== i))
  }

  const columns = [
    {
      title: keyPlaceholder,
      dataIndex: 'key',
      render: (_, row, i) => (
        <Input
          size="small"
          value={row.key}
          placeholder={keyPlaceholder}
          onChange={e => update(i, 'key', e.target.value)}
        />
      ),
    },
    {
      title: valuePlaceholder,
      dataIndex: 'value',
      render: (_, row, i) => (
        <Input
          size="small"
          value={row.value}
          placeholder={valuePlaceholder}
          onChange={e => update(i, 'value', e.target.value)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 40,
      render: (_, _row, i) => (
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={() => remove(i)}
        />
      ),
    },
  ]

  return (
    <div>
      <Table
        columns={columns}
        // `key` is a column here, so row identity goes in a separate field —
        // writing to `key` would overwrite what the user typed.
        dataSource={rows.map(r => ({ ...r, _rowId: rowId(r) }))}
        rowKey="_rowId"
        pagination={false}
        size="small"
        bordered
        locale={{ emptyText: 'No rows' }}
      />
      <div style={{ padding: '8px 0' }}>
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={add}>
          Add row
        </Button>
      </div>
    </div>
  )
}
