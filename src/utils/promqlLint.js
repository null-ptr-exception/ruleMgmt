/**
 * The expr editor's PromQL lint, for an expression holding ${column}
 * references. PromQL does not know `${`, so linted as written every
 * reference outside a string is "unexpected expression". Each reference is
 * read as a placeholder of its length instead, of the kind a row puts there:
 * digits (`0000`) for a number or a duration — a number column, an integer,
 * a duration, a derived value — and, for any other, digits unless they make
 * a problem at the reference itself (a label or metric name goes there),
 * then letters (`xxxx`). The expression is linted once so; a problem inside
 * a letters placeholder is the placeholder's and is dropped, any other is
 * shown.
 *
 *   rate(x[5m]) > ${warn}          → no problem
 *   sum(x) > ${thr} by (job)       → the problem with `by`, shown
 *   x{${label}="a"}                → no problem (letters)
 *
 * `diagnose(text)` is the PromQL linter run on a text (PromQLEditor.jsx);
 * `kindOf(name)` is 'number' for a reference known to hold one, else
 * anything.
 */
/**
 * A state whose syntax tree is the whole text's. A new state parses for a
 * few milliseconds only; on a busy machine that leaves a tree of the first
 * characters, and the linter, which reads the state's tree, then reports
 * mistakes that are not there. `ensureSyntaxTree` finishes the parse but
 * leaves the state's own tree as it was: the state after an empty
 * transaction takes the finished one. `ensure` is CodeMirror's
 * `ensureSyntaxTree`, of the same copy of CodeMirror as the state.
 */
export function parsed(state, ensure) {
  // The five seconds are counted on the computer's clock. One set forward
  // meanwhile (a time sync) ends them at once, the parse unfinished: asked
  // again, it goes on from where it stopped.
  for (let asked = 0; asked < 5 && !ensure(state, state.doc.length, 5000); asked++);
  return state.update({}).state
}

export const COLUMN_REF = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g

export function withColumnRefs(doc, diagnose, kindOf = () => undefined) {
  const refs = [...doc.matchAll(COLUMN_REF)].map(m => ({ from: m.index, to: m.index + m[0].length, name: m[1] }))
  if (!refs.length) return diagnose(doc)
  const fill = chars => refs.reduceRight((text, r, i) => text.slice(0, r.from) + chars[i].repeat(r.to - r.from) + text.slice(r.to), doc)
  const touches = (d, r) => d.from <= r.to && r.from <= d.to
  const asDigits = diagnose(fill(refs.map(() => '0')))
  const chosen = refs.map(r => (kindOf(r.name) !== 'number' && asDigits.some(d => touches(d, r)) ? 'x' : '0'))
  // Within a reference read as letters, a problem is the placeholder's; a
  // number where one cannot go (`> ${v} ${v}`) is the query's.
  const inLetters = d => refs.some((r, i) => chosen[i] === 'x' && d.from >= r.from && d.to <= r.to)
  return diagnose(fill(chosen)).filter(d => !inLetters(d))
}
