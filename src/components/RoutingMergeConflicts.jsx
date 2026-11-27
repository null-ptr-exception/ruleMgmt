import { useId, useState } from 'react'
import { Modal, Radio, Typography } from 'antd'
import { TIMING_KEYS, GROUP_BY, describeMatch } from '../utils/routingModel'

const { Text } = Typography

const say = match => describeMatch(match, ' · ')

function content(cell) {
  if (!cell) return <Text type="secondary">nobody (empty: its alerts are dropped)</Text>
  const timing = [
    ...(cell[GROUP_BY] !== undefined ? [`${GROUP_BY} [${cell[GROUP_BY].join(', ')}]`] : []),
    ...TIMING_KEYS.filter(k => cell[k] !== undefined).map(k => `${k} ${cell[k]}`),
  ]
  return <>{cell.configs.join(', ')}{timing.length > 0 && <Text type="secondary"> ({timing.join(', ')})</Text>}</>
}

/**
 * Taking a label away merges the cells that differ only in it (#94). Where
 * they do not say the same, which one to keep is asked here, once for each
 * merged cell: nothing is lost without a choice.
 */
export default function RoutingMergeConflicts({ conflicts, labels, onOk, onCancel }) {
  const [keep, setKeep] = useState({})
  const id = useId()
  const all = conflicts.every(c => Object.hasOwn(keep, c.key))
  return (
    <Modal open title={`Taking away ${labels.join(', ')}: which cell to keep`} okText="Keep these" width={620}
      okButtonProps={{ disabled: !all }} onOk={() => onOk(keep)} onCancel={onCancel}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        These cells differ only in {labels.join(', ')} and do not say the same. Each becomes one cell: pick what it keeps.
      </Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
        {conflicts.map((c, ci) => (
          <div key={c.key} data-testid="merge-conflict">
            <Text strong>{say(c.match) || 'every alert'}</Text>
            <Radio.Group value={keep[c.key]} onChange={e => setKeep(k => ({ ...k, [c.key]: e.target.value }))}
              style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
              {c.options.map((o, oi) => (
                // The name says which option; its description what it
                // keeps, the part that differs (who, groupBy, timing).
                <Radio key={o.key} value={o.key} aria-label={`${say(c.match)}: keep ${say(o.part)}`} aria-describedby={`${id}-${ci}-${oi}`}>
                  <Text code>{say(o.part)}</Text> → <span id={`${id}-${ci}-${oi}`}>{content(o.cell)}</span>
                </Radio>
              ))}
            </Radio.Group>
          </div>
        ))}
      </div>
    </Modal>
  )
}
