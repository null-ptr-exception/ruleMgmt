// A target on another Template is moved onto the source's (#180): its own
// alert rows go. Said on the row and in the overwrite confirmation. The
// count is of rows (what the tree badge counts); null when its values.yaml
// could not be read.
export function templateChange(sourceChart, candidate) {
  if (!sourceChart || !candidate?.chart || candidate.chart === sourceChart) return null
  const n = candidate.alertCount
  const rows = typeof n !== 'number' ? 'its alert rows go' : n === 1 ? 'its 1 alert row goes' : `its ${n} alert rows go`
  return `moves from ${candidate.chart} to ${sourceChart}: ${rows}`
}
