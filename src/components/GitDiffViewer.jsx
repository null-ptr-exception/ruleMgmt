import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../lib/apiFetch.js'
import { Typography, Spin, Empty } from 'antd'
import { MergeView } from '@codemirror/merge'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

const { Text } = Typography

export default function GitDiffViewer({ selectedFile }) {
  const [diff, setDiff] = useState(null)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef(null)
  const viewRef = useRef(null)

  useEffect(() => {
    if (!selectedFile) { setDiff(null); return }

    setLoading(true)
    const params = new URLSearchParams({ file: selectedFile.file })
    if (selectedFile.ref) params.set('ref', selectedFile.ref)

    apiFetch(`/api/v2/git/diff?${params}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { setDiff(data); setLoading(false) })
      .catch(() => { setDiff(null); setLoading(false) })
  }, [selectedFile?.file, selectedFile?.ref])

  useEffect(() => {
    if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null }
    if (!containerRef.current || !diff) return

    const yamlLang = StreamLanguage.define(yaml)
    const extensions = [yamlLang, EditorView.editable.of(false), EditorState.readOnly.of(true)]

    viewRef.current = new MergeView({
      parent: containerRef.current,
      a: { doc: diff.original, extensions },
      b: { doc: diff.modified, extensions },
    })

    return () => { if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null } }
  }, [diff])

  if (!selectedFile) {
    return <Empty style={{ margin: 'auto' }} description="Select a file to view diff" />
  }

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><Spin /></div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
        <Text code style={{ fontSize: 12 }}>{diff?.file}</Text>
        {selectedFile.ref && <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{selectedFile.ref.slice(0, 7)}</Text>}
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto' }} />
    </div>
  )
}
