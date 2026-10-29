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
