/**
 * What is said of content a write moved aside and left ("parked",
 * repo/write.js parkedItems): what it is, and what to do so that the repo
 * is whole again — once, for the server's log at start-up and for Commit.
 *
 *   parkedSaid(parked, charts) → [sentence], one per item, in their order
 *     parked  [{ rel, original, free }]
 *     charts  the Templates folder in the repo ('charts'), or null
 *
 * A file or folder of a deployment, and a Template's folder moved aside
 * whole (the delete was all but done): rename it back to keep it, or
 * remove it. A file or folder INSIDE a Template is only part of a delete
 * or a save that was stopped halfway: removing it would leave the rest —
 * a folder without its Chart.yaml (not listed as a Template), a generated
 * file with no rules. It is renamed back, and the delete or the save done
 * again. A delete moves aside more than rules files and generated
 * templates; a save only those — so one parked alone may be either's.
 *
 * Example:
 *   parkedSaid([{ rel: 'charts/lone/_Chart.yaml.2110137b.parked', original: 'charts/lone/Chart.yaml', free: true }], 'charts')
 *   → ['charts/lone/_Chart.yaml.2110137b.parked is charts/lone/Chart.yaml as it was, moved aside by a write that did not
 *       finish: rename it back to charts/lone/Chart.yaml, then delete the Template lone again if it is to go — removing
 *       it alone would leave the rest of the Template behind']
 */
export function parkedSaid(parked, charts) {
  // { name, inside } of an item inside a Template's folder, or null.
  const templateOf = p => {
    if (!charts || !p.original.startsWith(`${charts}/`)) return null
    const [name, ...inside] = p.original.slice(charts.length + 1).split('/')
    return inside.length ? { name, inside } : null
  }
  // What a save of rules removes too: a rules file, a generated template.
  const savedToo = inside => inside.length === 2 && (inside[0] === 'rules' || inside[0] === 'templates')
  const deleting = new Set(parked.map(templateOf).filter(t => t && !savedToo(t.inside)).map(t => t.name))
  return parked.map(p => {
    const was = `${p.rel} is ${p.original} as it was, moved aside by a write that did not finish`
    const back = p.free ? `rename it back to ${p.original}` : `${p.original} is there again: keep one of the two and remove the other`
    const t = templateOf(p)
    if (!t) return `${was}: ${p.free ? `${back} to keep it` : `${p.original} is there again: keep one of the two`}, or remove it`
    return deleting.has(t.name)
      ? `${was}: ${back}, then delete the Template ${t.name} again if it is to go — removing it alone would leave the rest of the Template behind`
      : `${was}: ${back}, then save the Template ${t.name} again (or delete it again, if it was being deleted) — removing it alone would leave what was made from it behind`
  })
}
