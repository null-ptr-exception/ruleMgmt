/**
 * A values file's text read as Helm reads it: its first YAML document,
 * whatever follows (Helm 3.15.4 and 3.19.0, measured). A `---` line at the
 * end, a second document, or a broken one after the first do not change
 * what Helm renders, so they are not a reason to call the file unreadable.
 *
 *   'a: 1\n---\n'        → { a: 1 }
 *   'a: 1\n---\nb: 2\n'  → { a: 1 }
 *   '---\n---\na: 1\n'   → null (an empty first document: no values)
 *
 * A syntax error in the first document still throws, as Helm fails there.
 */
import yaml from 'js-yaml'

export function loadValues(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  // The first document: from its own optional `---` to the next marker.
  let start = 0
  while (start < lines.length && (lines[start].trim() === '' || /^\s*#/.test(lines[start]))) start++
  if (start < lines.length && /^---(\s|$)/.test(lines[start])) start++
  let end = start
  while (end < lines.length && !/^(---|\.\.\.)(\s|$)/.test(lines[end])) end++
  return yaml.load([...lines.slice(0, start).filter(l => !/^---/.test(l)), ...lines.slice(start, end)].join('\n')) ?? null
}
