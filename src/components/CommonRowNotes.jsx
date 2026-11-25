import { markCounts } from '../utils/commonMarks'

const rowText = r => (r && typeof r === 'object' ? Object.entries(r).map(([k, v]) => `${k}=${v}`).join(', ') || '(empty row)' : String(r))
const n = (count, one, many) => `${count} ${count === 1 ? one : many}`

/**
 * How an overridden group stands against its `_common`, in words: how many
 * rows differ, are added and are not taken, or that every row is the same;
 * for a group whose rows cannot be told apart, the whole and why.
 */
export function marksSummary(mark, group) {
  if (!mark || mark.state !== 'overrides') return null
  const counts = markCounts(mark)
  if (!counts || !mark.aligned) {
    return `${mark.same ? 'The same rows as there' : 'Differs from the rows there'}. Its rows are not marked one by one: ${group} has no text, true/false or selector column to tell them apart, so the two lists are compared as a whole.`
  }
  if (mark.same) return 'Every row is the same as there.'
  const parts = [
    counts.differs && n(counts.differs, 'row differs', 'rows differ'),
    counts.added && `${counts.added} added here`,
    counts.notTaken && `${counts.notTaken} not taken`,
  ].filter(Boolean)
  return `${parts.join(', ')}.`
}

/** "differs" or "same rows", for a group's heading. */
export const sameWord = mark => (mark.same ? 'same rows' : 'differs')

/** The `_common`'s rows an overridden group has none for, read-only, under its table. */
export default function CommonRowNotes({ mark, group }) {
  if (!mark || mark.state !== 'overrides' || !mark.notTaken?.length) return null
  return (
    <div data-testid={`not-taken-${group}`} style={{ marginTop: 8, padding: '6px 10px', fontSize: 12, color: '#595959', background: '#fafafa', border: '1px dashed #d9d9d9', borderRadius: 6 }}>
      Not taken from <b>{mark.from}</b> ({mark.notTaken.length}):
      <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
        {mark.notTaken.map((r, i) => <li key={i}>{rowText(r)}</li>)}
      </ul>
    </div>
  )
}

/**
 * One line over a group's rows in Overview, for a group the deployment
 * writes where a `_common` gives it: "Overrides … · differs" (or "· same
 * rows") with the counts, or "Clears …". Nothing for any other group.
 */
export function OverrideNote({ mark, group, testid }) {
  if (!mark || mark.state === 'inherited') return null
  const there = `${mark.given} row${mark.given === 1 ? '' : 's'} there`
  if (mark.state === 'clears') {
    return (
      <div data-testid={`${testid}-clears-${group}`} style={{ padding: '2px 0 6px', fontSize: 12, color: '#a8071a' }}>
        Clears <b>{mark.from}</b> (it writes no rows; {there})
      </div>
    )
  }
  return (
    <div data-testid={`${testid}-overrides-${group}`} style={{ padding: '2px 0 6px', fontSize: 12, color: '#ad4e00' }}>
      Overrides <b>{mark.from}</b> ({there}) · {sameWord(mark)}
      <span style={{ color: '#8c8c8c' }}> — {marksSummary(mark, group)}</span>
    </div>
  )
}
