import { groupMarkLabel } from '../utils/commonMarks'

// A group's mark in the group list of a deployment under a `_common`: what
// groupMark (utils/commonMarks) says of it, as one small word.
const STYLES = {
  inherited: { color: '#8c8c8c', background: '#fafafa', border: '1px solid #e5e7eb' },
  own: { color: '#8c8c8c', background: '#fafafa', border: '1px solid #e5e7eb' },
  overrides: { color: '#ad4e00', background: '#fff7e6', border: '1px solid #ffd591' },
  clears: { color: '#a8071a', background: '#fff1f0', border: '1px solid #ffa39e' },
}

export default function GroupMark({ mark, name }) {
  const text = groupMarkLabel(mark)
  if (!text) return null
  return (
    <span data-testid={`group-mark-${name}`} title={text.title}
      style={{ ...STYLES[text.word], fontSize: 10, fontWeight: 400, lineHeight: '14px', padding: '0 5px', borderRadius: 8, flexShrink: 0, whiteSpace: 'nowrap' }}>
      {text.word}
    </span>
  )
}
