/**
 * The expr editor's PromQL lint, for an expression holding ${column}
 * references. PromQL does not know `${`, so linted as written every
 * reference outside a string is "unexpected expression" — the whole query
 * underlined in red a moment after the editor opens. Each reference is read
 * as a placeholder of the same length instead, twice: digits (`0000`, a
 * number or a duration where one goes) and letters (`xxxx`, a name where one
 * goes). A problem in both readings is one the query has whatever a row
 * fills in; one in only one reading is the placeholder's, and is dropped.
 *
 *   rate(x[5m]) > ${warn}    → no problem
 *   rate(x[5m]) >> ${warn}   → the problem with `>>`, still shown
 *
 * `diagnose(text)` is the PromQL linter run on a text (PromQLEditor.jsx).
 */
export const COLUMN_REF = /\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/g

export function withColumnRefs(doc, diagnose) {
  if (!doc.match(COLUMN_REF)) return diagnose(doc)
  const as = ch => doc.replace(COLUMN_REF, ref => ch.repeat(ref.length))
  const key = d => `${d.from}:${d.to}:${d.message}`
  const withLetters = new Set(diagnose(as('x')).map(key))
  return diagnose(as('0')).filter(d => withLetters.has(key(d)))
}
