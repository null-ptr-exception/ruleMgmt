import { useState } from 'react'
import { Button, Popover, Select, Typography } from 'antd'
import { FormatPainterOutlined } from '@ant-design/icons'
import { fillConfig } from '../utils/routingModel'

const { Text } = Typography

/**
 * Add a config to — or take it from — every cell of a row or column (#93).
 * Only a shortcut: the table still holds one cell per combination.
 */
export default function FillButton({ routing, partial, describe, onChange, readOnly }) {
  const [config, setConfig] = useState(null)
  const [open, setOpen] = useState(false)
  const names = Object.keys(routing.configs || {})
  const apply = add => {
    onChange(fillConfig(routing, partial, config, { add }))
    setOpen(false)
  }
  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 240 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>Every cell where {describe}</Text>
      <Select size="small" aria-label={`Fill config for ${describe}`} placeholder="config" value={config}
        options={names.map(n => ({ value: n, label: n }))} onChange={setConfig} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="small" type="primary" disabled={!config} onClick={() => apply(true)}>Add to all</Button>
        <Button size="small" disabled={!config} onClick={() => apply(false)}>Remove from all</Button>
      </div>
    </div>
  )
  return (
    <Popover trigger="click" open={open} onOpenChange={setOpen} content={content} title="Fill">
      <Button type="text" size="small" icon={<FormatPainterOutlined />} aria-label={`Fill ${describe}`}
        disabled={readOnly || names.length === 0} />
    </Popover>
  )
}
