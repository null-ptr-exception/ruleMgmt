// Why POST /sync refused a source (#180): the cells a values save would
// refuse. Fix them in the source, then sync again.
export default function SyncProblems({ problems }) {
  if (!problems?.length) return null
  return (
    <ul data-testid="sync-problems" style={{ paddingLeft: 18, margin: '4px 0 0' }}>
      {problems.map((p, i) => <li key={i}>{p.message}</li>)}
    </ul>
  )
}
