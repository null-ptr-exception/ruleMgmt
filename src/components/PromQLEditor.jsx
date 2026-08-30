import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { PromQLExtension } from '@prometheus-io/codemirror-promql'

// Minimal dark theme matching the rest of the UI
const promqlTheme = EditorView.theme({
  '&': {
    fontSize: '12.5px',
    fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
    background: '#0f172a',
    color: '#cbd5e1',
    borderRadius: '6px',
  },
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
  // PromQL syntax colours
  '.tok-keyword':  { color: '#c084fc' },
  '.tok-function': { color: '#60a5fa' },
  '.tok-operator': { color: '#f472b6' },
  '.tok-number':   { color: '#34d399' },
  '.tok-string':   { color: '#fbbf24' },
  '.tok-labelName': { color: '#7dd3fc' },
  '.tok-metricName': { color: '#93c5fd', fontWeight: 600 },
}, { dark: true })

export default function PromQLEditor({ value = '', onChange, metrics = [], minHeight = 56, apiRef }) {
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
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        promql.asExtension(),
        promqlTheme,
        updateListener,
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
