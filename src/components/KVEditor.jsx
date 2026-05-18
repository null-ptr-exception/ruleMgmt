import { Table, Input, Button } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

export default function KVEditor({ rows, onChange, keyPlaceholder = 'key', valuePlaceholder = 'value' }) {
  function update(i, field, val) {
    const next = rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r)
    onChange(next)
  }

  function add() {
    onChange([...rows, { key: '', value: '' }])
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
        dataSource={rows.map((r, i) => ({ ...r, key: `row-${i}` }))}
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
