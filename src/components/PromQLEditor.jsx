import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view'
import { EditorState, StateEffect } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, HighlightStyle, ensureSyntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { forceLinting, linter } from '@codemirror/lint'
import { PromQLExtension } from '@prometheus-io/codemirror-promql'
import { withColumnRefs, parsed } from '../utils/promqlLint'

const MONO = "'Fira Code', 'Cascadia Code', 'Consolas', 'DejaVu Sans Mono', monospace"

// Minimal dark theme matching the rest of the UI
const promqlTheme = EditorView.theme({
  '&': {
    fontSize: '12.5px',
    background: '#0f172a',
    color: '#cbd5e1',
    borderRadius: '6px',
  },
  // On the scroller, not the editor: CodeMirror's base theme sets a plain
  // `monospace` there, which would override one set further out (#72).
  '.cm-scroller': { fontFamily: MONO },
  '.cm-content': { padding: '10px 0', caretColor: '#7dd3fc', minHeight: '56px' },
  '.cm-line': { padding: '0 14px' },
  '.cm-activeLine': { background: '#1e293b' },
  '.cm-gutters': { background: '#0f172a', border: 'none', color: '#475569' },
  '.cm-activeLineGutter': { background: '#1e293b' },
  '.cm-cursor': { borderLeftColor: '#7dd3fc' },
  '.cm-selectionBackground': { background: '#334155' },
  '&.cm-focused .cm-selectionBackground': { background: '#334155' },
  '&.cm-focused': { outline: '1.5px solid #6366f1' },
  '.cm-tooltip': { background: '#1e293b', border: '1px solid #334155', borderRadius: 6 },
  '.cm-tooltip-autocomplete > ul': { background: '#1e293b' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: '#334155' },
  // A ${column} — what varies per row — stands out from the PromQL around it,
  // token colours inside it included. PromQL does not know `${`, and would
  // otherwise show it as an error.
  '.cm-columnRef, .cm-columnRef span': { color: '#fdba74', fontWeight: 600 },
  '.cm-columnRef': { background: 'rgba(253, 186, 116, 0.14)', borderRadius: '3px' },
}, { dark: true })

// PromQL syntax colours, for a dark background. This has to be the
// highlighter itself: CodeMirror's defaultHighlightStyle is made for a light
// one, and put near-black navy on this background (#72).
const promqlHighlight = HighlightStyle.define([
  { tag: [tags.operatorKeyword, tags.modifier, tags.logicOperator], color: '#c084fc' },
  { tag: tags.function(tags.variableName), color: '#60a5fa' },
  { tag: tags.operator, color: '#f472b6' },
  { tag: tags.number, color: '#34d399' },
  { tag: tags.string, color: '#fbbf24' },
  { tag: tags.labelName, color: '#7dd3fc' },
  { tag: tags.variableName, color: '#93c5fd', fontWeight: '600' },
  { tag: tags.comment, color: '#94a3b8', fontStyle: 'italic' },
])

const columnRefMatcher = new MatchDecorator({
  regexp: /\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/g,
  decoration: Decoration.mark({ class: 'cm-columnRef' }),
})
const columnRefs = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = columnRefMatcher.createDeco(view) }
  update(update) { this.decorations = columnRefMatcher.updateDeco(update, this.decorations) }
}, { decorations: v => v.decorations })

// What each ${column} holds is read by the lint, and can change with no
// change to the text: a column's type is edited on the same page. CodeMirror
// lints again after a change to the text only, so the marks stayed those of
// the type before — a mistake not marked, or one marked that is none — until
// the next key in the editor. The editor is told with this effect, and the
// lint is asked to run for it.
const kindsChanged = StateEffect.define()
const lintAgain = update => update.docChanged || update.transactions.some(tr => tr.effects.some(e => e.is(kindsChanged)))
const lintOnKinds = linter(null, { needsRefresh: lintAgain })

// CodeMirror lints 750 ms after the last change and counts that wait on the
// computer's clock. When the clock is set back meanwhile (a time sync, a
// laptop waking up) it waits that much longer, and until then the marks are
// those of the text before the change: none on a new mistake, one on a
// mistake already corrected. This counts the same wait in elapsed time and
// then asks for the lint; where CodeMirror has run it already, asking does
// nothing.
const LINT_WAIT = 750
const lintOnTime = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view
    this.wait()
  }
  update(update) { if (lintAgain(update)) this.wait() }
  wait() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => forceLinting(this.view), LINT_WAIT)
  }
  destroy() { clearTimeout(this.timer) }
})

// `language` other than 'promql' (a vlogs group's LogsQL, #65) drops the PromQL
// highlighting, completion and linting — they would flag every line of it —
// and keeps the rest: the ${column} marks, and the selection API variables
// are marked with.
// It is read once, when the editor mounts: remount (a `key`) to change it.
export default function PromQLEditor({ value = '', onChange, metrics = [], minHeight = 56, apiRef, language = 'promql', columnKinds }) {
  // What each ${column} holds ('number' or not), read by the lint at each run.
  const kindsRef = useRef(columnKinds)
  kindsRef.current = columnKinds
  const containerRef = useRef(null)
  const viewRef      = useRef(null)
  const onChangeRef  = useRef(onChange)
  onChangeRef.current = onChange

  // Turning a literal into a variable needs the selection, so hand the caller
  // the two operations it takes: read what is selected, put something else
  // there.
  if (apiRef) {
    apiRef.current = {
      // Returns the range as well as the text: naming a variable happens in a
      // dialog, and by the time it is confirmed the editor has lost focus, so
      // the caller has to hold on to where the literal was.
      getSelection() {
        const view = viewRef.current
        if (!view) return null
        const { from, to } = view.state.selection.main
        return { from, to, text: view.state.sliceDoc(from, to) }
      },
      replaceRange(from, to, text) {
        const view = viewRef.current
        if (!view) return
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length }
        })
        view.focus()
      }
    }
  }

  useEffect(() => {
    if (!containerRef.current) return

    const promql = new PromQLExtension()
    // The PromQL lint, with each ${column} read as a value of its length
    // (promqlLint.js): as written, PromQL calls every reference outside a
    // string an error, and the whole query was underlined a moment after
    // the editor opened.
    const plain = promql.getLinter()
    promql.setLinter({
      promQL() {
        const lint = plain.promQL()
        return view => withColumnRefs(view.state.doc.toString(), text => {
          const state = text === view.state.doc.toString() ? view.state
            : view.state.update({ changes: { from: 0, to: view.state.doc.length, insert: text } }).state
          return lint({ state: parsed(state, ensureSyntaxTree) })
        }, name => kindsRef.current?.[name])
      },
    })

    // If we have a metrics dict, wire up a static completion provider
    if (metrics.length) {
      promql.setComplete({
        remote: {
          fetchFn: async (resource) => {
            const url = new URL(resource, 'http://localhost')
            if (url.pathname.endsWith('/api/v1/label/__name__/values')) {
              return new Response(JSON.stringify({
                status: 'success',
                data: metrics.map(m => m.name),
              }))
            }
            if (url.pathname.endsWith('/api/v1/labels')) {
              const allLabels = [...new Set(metrics.flatMap(m => (m.labels || []).map(l => l.name)))]
              return new Response(JSON.stringify({ status: 'success', data: allLabels }))
            }
            return new Response(JSON.stringify({ status: 'success', data: [] }))
          },
          url: 'http://localhost',
        },
      })
    }

    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString())
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        history(),
        syntaxHighlighting(promqlHighlight),
        columnRefs,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        ...(language === 'promql' ? [promql.asExtension(), lintOnKinds, lintOnTime] : []),
        promqlTheme,
        updateListener,
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [])

  // The lint runs again when what a ${column} holds changes.
  const kinds = Object.keys(columnKinds || {}).sort().map(n => `${n}:${columnKinds[n]}`).join(' ')
  const lintedKinds = useRef(kinds)
  useEffect(() => {
    if (lintedKinds.current === kinds) return
    lintedKinds.current = kinds
    viewRef.current?.dispatch({ effects: kindsChanged.of(null) })
  }, [kinds])

  // Sync external value changes (e.g. import replacing the expr)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value ?? '' },
      })
    }
  }, [value])

  return (
    <div
      ref={containerRef}
      style={{ borderRadius: 6, overflow: 'hidden', minHeight }}
    />
  )
}
