import { useState, useMemo, useEffect, useCallback } from 'react'
import { Button } from 'antd'
import { getMetricsDict, saveMetricsDict, saveTemplate, listTemplates } from '../utils/api'
import { latestVersion, bumpPatch } from '../utils/templateUtils'

// ── PromQL constants ──────────────────────────────────────────────────────────

const LABEL_OPS  = ['=', '!=', '=~', '!~']
const BINARY_OPS = ['+', '-', '*', '/', '%', '^', '==', '!=', '>', '<', '>=', '<=', 'and', 'or', 'unless']

const RANGE_FUNCS = [
  'rate', 'irate', 'increase', 'delta', 'idelta', 'deriv',
  'avg_over_time', 'max_over_time', 'min_over_time', 'sum_over_time',
  'count_over_time', 'last_over_time', 'present_over_time',
  'quantile_over_time', 'resets', 'changes',
]

const INSTANT_FUNCS = [
  'abs', 'absent', 'ceil', 'floor', 'round', 'exp', 'ln', 'log2', 'log10',
  'sqrt', 'sgn', 'sort', 'sort_desc', 'histogram_quantile',
  'label_join', 'label_replace', 'scalar', 'vector',
]

const AGG_FUNCS = [
  'sum', 'avg', 'min', 'max', 'count', 'group',
  'stddev', 'stdvar', 'topk', 'bottomk', 'count_values', 'quantile',
]

const AGG_PARAM_FUNCS = new Set(['topk', 'bottomk', 'count_values', 'quantile'])
const AGG_NO_DIM      = new Set(['topk', 'bottomk'])
const INSTANT_PARAM   = new Set(['histogram_quantile'])

// ── Dict helpers ──────────────────────────────────────────────────────────────

function dictLabels(dict, metricName) {
  return dict.find(m => m.name === metricName)?.labels || []
}

function dictValues(dict, metricName, labelName) {
  return dictLabels(dict, metricName).find(l => l.name === labelName)?.values || []
}

// ── Expression builders ───────────────────────────────────────────────────────

function buildSelector(metric, matchers) {
  const valid = matchers.filter(m => m.label.trim())
  const lbls  = valid.map(m => `${m.label}${m.op}"${m.value}"`).join(', ')
  return `${metric}${lbls ? `{${lbls}}` : ''}`
}

function buildSegmentExpr(seg) {
  if (seg.kind === 'scalar') return seg.scalar.trim()
  if (!seg.metric.trim() && !seg.matchers.some(m => m.label.trim())) return ''

  let expr = buildSelector(seg.metric, seg.matchers)

  if (seg.rangeFunc) {
    const iv     = seg.rangeInterval.trim() || '5m'
    const offset = seg.rangeOffset.trim() ? ` offset ${seg.rangeOffset}` : ''
    expr = seg.rangeFunc === 'quantile_over_time'
      ? `${seg.rangeFunc}(${seg.rangeParam || '0.95'}, ${expr}[${iv}]${offset})`
      : `${seg.rangeFunc}(${expr}[${iv}]${offset})`
  }

  if (seg.instantFunc) {
    expr = INSTANT_PARAM.has(seg.instantFunc)
      ? `${seg.instantFunc}(${seg.instantParam || '0.95'}, ${expr})`
      : `${seg.instantFunc}(${expr})`
  }

  if (seg.aggFunc) {
    const labels    = seg.aggLabels.split(',').map(l => l.trim()).filter(Boolean)
    const dimClause = (!AGG_NO_DIM.has(seg.aggFunc) && seg.aggFunc !== 'count_values' && labels.length && seg.aggDim)
      ? ` ${seg.aggDim} (${labels.join(', ')})` : ''
    if (seg.aggFunc === 'count_values')        expr = `${seg.aggFunc}${dimClause}("${seg.aggParam || 'value'}", ${expr})`
    else if (AGG_PARAM_FUNCS.has(seg.aggFunc)) expr = `${seg.aggFunc}(${seg.aggParam || (seg.aggFunc === 'quantile' ? '0.95' : '5')}, ${expr})`
    else                                       expr = `${seg.aggFunc}${dimClause}(${expr})`
  }

  return expr
}

function buildFinalQuery(segments, outer, outerOffset) {
  const exprs = segments
    .map(seg => ({ op: seg.operator, expr: buildSegmentExpr(seg) }))
    .filter(x => x.expr)
  if (!exprs.length) return ''

  let combined = exprs[0].expr
  for (let i = 1; i < exprs.length; i++) {
    combined = `${combined} ${exprs[i].op || '+'} ${exprs[i].expr}`
  }

  if (outer.func) {
    const labels    = outer.aggLabels.split(',').map(l => l.trim()).filter(Boolean)
    const dimClause = (!AGG_NO_DIM.has(outer.func) && outer.func !== 'count_values' && labels.length && outer.dim)
      ? ` ${outer.dim} (${labels.join(', ')})` : ''
    if (outer.func === 'count_values')        combined = `${outer.func}${dimClause}("${outer.param || 'value'}", ${combined})`
    else if (AGG_PARAM_FUNCS.has(outer.func)) combined = `${outer.func}(${outer.param || (outer.func === 'quantile' ? '0.95' : '5')}, ${combined})`
    else                                      combined = `${outer.func}${dimClause}(${combined})`
  }

  if (outerOffset.trim()) combined = `(${combined}) offset ${outerOffset.trim()}`
  return combined
}

// ── Segment factory ───────────────────────────────────────────────────────────

let _id = 0
const uid = () => ++_id

const emptySegment = (operator = '') => ({
  id:            uid(),
  kind:          'metric',
  operator,
  scalar:        '',
  metric:        '',
  matchers:      [],
  rangeFunc:     '',
  rangeInterval: '5m',
  rangeOffset:   '',
  rangeParam:    '0.95',
  instantFunc:   '',
  instantParam:  '0.95',
  aggFunc:       '',
  aggDim:        'by',
  aggLabels:     '',
  aggParam:      '',
})

const emptyOuter = () => ({ func: '', dim: 'by', aggLabels: '', param: '' })

// ── Suggestion input: free text + datalist ────────────────────────────────────

function SuggestInput({ id, value, onChange, options = [], placeholder, style }) {
  const listId = `dl-${id}`
  return (
    <>
      <input type="text" list={listId} value={value} placeholder={placeholder}
        style={style} onChange={e => onChange(e.target.value)} />
      <datalist id={listId}>
        {options.map(o => <option key={o} value={o} />)}
      </datalist>
    </>
  )
}

// ── Segment card ──────────────────────────────────────────────────────────────

const BADGE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316']
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function SegmentCard({ seg, index, total, dict, onChange, onRemove }) {
  function set(field, val) { onChange({ ...seg, [field]: val }) }

  function updateMatcher(i, field, val) {
    onChange({ ...seg, matchers: seg.matchers.map((m, idx) => idx === i ? { ...m, [field]: val } : m) })
  }
  function addMatcher() {
    onChange({ ...seg, matchers: [...seg.matchers, { label: '', op: '=', value: '' }] })
  }
  function removeMatcher(i) {
    onChange({ ...seg, matchers: seg.matchers.filter((_, idx) => idx !== i) })
  }

  const color    = BADGE_COLORS[index % BADGE_COLORS.length]
  const label    = LABELS[index] || String(index + 1)
  const isScalar = seg.kind === 'scalar'

  const metricOpts  = dict.map(m => m.name)
  const labelOpts   = dictLabels(dict, seg.metric).map(l => l.name)

  const showRangeParam   = seg.rangeFunc === 'quantile_over_time'
  const showInstantParam = INSTANT_PARAM.has(seg.instantFunc)
  const showAggDim       = seg.aggFunc && !AGG_NO_DIM.has(seg.aggFunc) && seg.aggFunc !== 'count_values'
  const showAggParam     = AGG_PARAM_FUNCS.has(seg.aggFunc)

  return (
    <div style={{ border: `1.5px solid ${color}30`, borderRadius: 8, overflow: 'hidden', background: '#fff' }}>

      {/* header */}
      <div style={{
        background: `${color}12`, borderBottom: `1.5px solid ${color}30`,
        padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{
          background: color, color: '#fff', fontWeight: 700, fontSize: 12,
          borderRadius: 4, padding: '2px 8px', fontFamily: 'monospace',
        }}>{label}</span>

        {/* kind toggle */}
        <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #d1d5db', fontSize: 11 }}>
          {['metric', 'scalar'].map(k => (
            <button key={k} style={{
              padding: '2px 10px', border: 'none', cursor: 'pointer', fontWeight: 600,
              background: seg.kind === k ? color : '#fff',
              color: seg.kind === k ? '#fff' : '#6b7280',
            }} onClick={() => set('kind', k)}>{k}</button>
          ))}
        </div>

        <span style={{ fontSize: 12, color: '#6b7280', flex: 1 }}>
          {isScalar
            ? (seg.scalar || <span style={{ color: '#9ca3af' }}>constant</span>)
            : (seg.metric || <span style={{ color: '#9ca3af' }}>no metric</span>)}
        </span>
        {total > 1 && (
          <Button type="text" size="small" danger style={{ padding: '2px 8px' }}
            onClick={onRemove}>Remove</Button>
        )}
      </div>

      <div style={{ padding: 14 }}>

        {/* Scalar */}
        {isScalar && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12, maxWidth: 240 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Constant value</label>
            <input type="text" value={seg.scalar} placeholder="e.g. 100  or  0.95"
              onChange={e => set('scalar', e.target.value)} />
          </div>
        )}

        {/* Metric + Labels */}
        {!isScalar && <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Metric name</label>
            <SuggestInput id={`metric-${seg.id}`} value={seg.metric}
              options={metricOpts} placeholder="e.g. http_requests_total"
              onChange={v => set('metric', v)} />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, display: 'block', marginBottom: 4 }}>
              Label matchers
            </label>
            {seg.matchers.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 6 }}>
                <colgroup>
                  <col style={{ width: '35%' }} />
                  <col style={{ width: '14%' }} />
                  <col />
                  <col style={{ width: 30 }} />
                </colgroup>
                <tbody>
                  {seg.matchers.map((m, i) => {
                    const valueOpts = dictValues(dict, seg.metric, m.label)
                    return (
                      <tr key={i}>
                        <td style={{ paddingRight: 4, paddingBottom: 4 }}>
                          <SuggestInput id={`lbl-${seg.id}-${i}`} value={m.label}
                            options={labelOpts} placeholder="label"
                            onChange={v => updateMatcher(i, 'label', v)} />
                        </td>
                        <td style={{ paddingRight: 4, paddingBottom: 4 }}>
                          <select value={m.op} onChange={e => updateMatcher(i, 'op', e.target.value)}
                            style={{ fontFamily: 'monospace' }}>
                            {LABEL_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </td>
                        <td style={{ paddingRight: 4, paddingBottom: 4 }}>
                          <SuggestInput id={`val-${seg.id}-${i}`} value={m.value}
                            options={valueOpts}
                            placeholder={m.op.includes('~') ? 'regex' : 'value'}
                            onChange={v => updateMatcher(i, 'value', v)} />
                        </td>
                        <td style={{ paddingBottom: 4 }}>
                          <Button type="text" size="small" style={{ padding: '5px 8px', fontSize: 15 }} onClick={() => removeMatcher(i)}>×</Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <Button type="text" size="small" onClick={addMatcher}>+ Add matcher</Button>
          </div>

          {/* Range / Instant / Agg */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 4 }}>
            {/* Range */}
            <div>
              <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: 6 }}>
                Range function
              </label>
              <select value={seg.rangeFunc} onChange={e => set('rangeFunc', e.target.value)} style={{ marginBottom: 6 }}>
                <option value="">— none —</option>
                {RANGE_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              {seg.rangeFunc && <>
                <input type="text" value={seg.rangeInterval} placeholder="5m"
                  style={{ marginBottom: 4 }} onChange={e => set('rangeInterval', e.target.value)} />
                <input type="text" value={seg.rangeOffset} placeholder="offset (e.g. 1h)"
                  onChange={e => set('rangeOffset', e.target.value)} />
                {showRangeParam && (
                  <input type="number" step="0.05" min="0" max="1"
                    value={seg.rangeParam} style={{ marginTop: 4 }} onChange={e => set('rangeParam', e.target.value)} />
                )}
              </>}
            </div>

            {/* Instant */}
            <div>
              <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: 6 }}>
                Instant function
              </label>
              <select value={seg.instantFunc} onChange={e => set('instantFunc', e.target.value)}>
                <option value="">— none —</option>
                {INSTANT_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              {showInstantParam && (
                <input type="number" step="0.05" min="0" max="1"
                  value={seg.instantParam} style={{ marginTop: 6 }} onChange={e => set('instantParam', e.target.value)} />
              )}
            </div>

            {/* Aggregation */}
            <div>
              <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: 6 }}>
                Aggregation
              </label>
              <select value={seg.aggFunc} onChange={e => set('aggFunc', e.target.value)}
                style={{ marginBottom: seg.aggFunc ? 6 : 0 }}>
                <option value="">— none —</option>
                {AGG_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              {seg.aggFunc && showAggDim && <>
                <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <select value={seg.aggDim} onChange={e => set('aggDim', e.target.value)} style={{ width: 80 }}>
                    <option value="by">by</option>
                    <option value="without">without</option>
                  </select>
                </div>
                <SuggestInput id={`agg-${seg.id}`} value={seg.aggLabels}
                  options={labelOpts} placeholder="job, instance"
                  onChange={v => set('aggLabels', v)} />
              </>}
              {seg.aggFunc && showAggParam && (
                <input type="text" style={{ marginTop: 4 }} value={seg.aggParam}
                  placeholder={seg.aggFunc === 'quantile' ? 'φ (0.95)' : seg.aggFunc === 'count_values' ? 'label name' : 'k (5)'}
                  onChange={e => set('aggParam', e.target.value)} />
              )}
            </div>
          </div>
        </>}
      </div>
    </div>
  )
}

// ── Operator divider ──────────────────────────────────────────────────────────

function OperatorDivider({ value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
      <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          fontFamily: 'monospace', fontWeight: 700, fontSize: 14,
          color: '#6366f1', border: '1.5px solid #a5b4fc',
          borderRadius: 6, padding: '3px 10px', background: '#eef2ff', cursor: 'pointer',
        }}>
        {BINARY_OPS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
    </div>
  )
}

// ── Metrics Dictionary Editor ─────────────────────────────────────────────────

function DictEditor({ savedDict, onSave }) {
  const [open, setOpen]         = useState(false)
  const [local, setLocal]       = useState(savedDict)
  const [saving, setSaving]     = useState(false)
  const [dirty, setDirty]       = useState(false)
  const [expanded, setExpanded] = useState({})   // { [mi]: bool }

  // sync when parent loads from server
  useEffect(() => { setLocal(savedDict); setDirty(false) }, [savedDict])

  function toggleMetric(mi) {
    setExpanded(e => ({ ...e, [mi]: !e[mi] }))
  }

  function mutate(fn) {
    setLocal(prev => { const next = fn(prev); setDirty(true); return next })
  }

  function addMetric() {
    mutate(d => [...d, { name: '', description: '', labels: [] }])
  }
  function removeMetric(i) {
    mutate(d => d.filter((_, idx) => idx !== i))
  }
  function setMetricField(i, field, val) {
    mutate(d => d.map((m, idx) => idx === i ? { ...m, [field]: val } : m))
  }
  function addLabel(mi) {
    mutate(d => d.map((m, i) => i === mi ? { ...m, labels: [...m.labels, { name: '', values: [] }] } : m))
  }
  function removeLabel(mi, li) {
    mutate(d => d.map((m, i) => i === mi ? { ...m, labels: m.labels.filter((_, j) => j !== li) } : m))
  }
  function setLabelField(mi, li, field, val) {
    mutate(d => d.map((m, i) => i !== mi ? m : {
      ...m,
      labels: m.labels.map((l, j) => j !== li ? l : {
        ...l,
        [field]: field === 'values' ? val.split(',').map(v => v.trim()).filter(Boolean) : val,
      }),
    }))
  }

  async function handleSave() {
    setSaving(true)
    await onSave(local)
    setSaving(false)
    setDirty(false)
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 16, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}
          onClick={() => setOpen(o => !o)}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: 0 }}>Metrics Dictionary</span>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {local.length} metric{local.length !== 1 ? 's' : ''} · config/metrics.yaml
          </span>
          {dirty && <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>unsaved</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {open && (
            <Button type="primary" size="small" disabled={!dirty || saving} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save to file'}
            </Button>
          )}
          <span style={{ fontSize: 12, color: '#6b7280', cursor: 'pointer' }}
            onClick={() => setOpen(o => !o)}>{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          {local.map((m, mi) => {
            const isExpanded = !!expanded[mi]
            return (
              <div key={mi} style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 8, overflow: 'hidden' }}>
                {/* metric header — click left side to expand/fold */}
                <div style={{
                  display: 'flex', alignItems: 'stretch',
                  background: isExpanded ? '#f8fafc' : '#fff',
                  borderBottom: isExpanded ? '1px solid #e5e7eb' : 'none',
                  cursor: 'pointer',
                }} onClick={() => toggleMetric(mi)}>
                  {/* left: name + description stacked */}
                  <div style={{ flex: 1, padding: '7px 12px' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', lineHeight: 1.3 }}>
                      {m.name || <span style={{ color: '#d1d5db' }}>unnamed metric</span>}
                    </div>
                    {m.description && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, lineHeight: 1.3 }}>
                        {m.description}
                      </div>
                    )}
                  </div>
                  {/* right: label count + toggle + remove */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}
                    onClick={e => e.stopPropagation()}>
                    <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                      {m.labels.length} label{m.labels.length !== 1 ? 's' : ''}
                    </span>
                    <span style={{ fontSize: 11, color: '#9ca3af', userSelect: 'none', cursor: 'pointer', width: 14, textAlign: 'center' }}
                      onClick={() => toggleMetric(mi)}>{isExpanded ? '▼' : '▶'}</span>
                    <Button type="text" size="small" style={{ padding: '5px 8px', fontSize: 15 }}
                      onClick={() => removeMetric(mi)}>×</Button>
                  </div>
                </div>

                {/* expanded: edit fields + labels */}
                {isExpanded && (
                  <div style={{ padding: '10px 12px 10px 16px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0 }}>
                        <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Metric name</label>
                        <input type="text" value={m.name} placeholder="metric_name_total"
                          onClick={e => e.stopPropagation()}
                          onChange={e => setMetricField(mi, 'name', e.target.value)} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0 }}>
                        <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Description</label>
                        <input type="text" value={m.description || ''} placeholder="optional"
                          onClick={e => e.stopPropagation()}
                          onChange={e => setMetricField(mi, 'description', e.target.value)} />
                      </div>
                    </div>
                  <div style={{ borderLeft: '3px solid #e0e7ff', paddingLeft: 12 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600,
                      textTransform: 'uppercase', marginBottom: 6 }}>
                      Labels &amp; known values
                    </div>
                    {m.labels.map((l, li) => (
                      <div key={li} style={{ display: 'grid', gridTemplateColumns: '180px 1fr 28px', gap: 6, marginBottom: 6 }}>
                        <input type="text" value={l.name} placeholder="label_name"
                          onChange={e => setLabelField(mi, li, 'name', e.target.value)} />
                        <input type="text" value={(l.values || []).join(', ')}
                          placeholder="value1, value2, … (optional)"
                          onChange={e => setLabelField(mi, li, 'values', e.target.value)} />
                        <Button type="text" size="small" style={{ padding: '5px 8px', fontSize: 15 }} onClick={() => removeLabel(mi, li)}>×</Button>
                      </div>
                    ))}
                    <Button type="text" size="small" onClick={() => addLabel(mi)}>+ Add label</Button>
                  </div>
                  </div>
                )}
              </div>
            )
          })}
          <Button size="small" onClick={addMetric}>+ Add metric</Button>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PromQLEditor({ onNavigate }) {
  const [segments, setSegments]     = useState([emptySegment()])
  const [outer, setOuter]           = useState(emptyOuter())
  const [outerOffset, setOuterOffset] = useState('')
  const [panels, setPanels]         = useState([])
  const [copied, setCopied]         = useState(false)
  const [dict, setDict]             = useState([])
  const [saveAs, setSaveAs]         = useState(false)   // show save-as form
  const [saveName, setSaveName]     = useState('')
  const [saveVer, setSaveVer]       = useState('v1.0.0')
  const [saveDesc, setSaveDesc]     = useState('')
  const [saveFor, setSaveFor]       = useState('')
  const [saveStatus, setSaveStatus] = useState('')      // 'ok' | 'err' | ''

  const query = useMemo(() => buildFinalQuery(segments, outer, outerOffset), [segments, outer, outerOffset])

  const loadDict = useCallback(async () => {
    const d = await getMetricsDict()
    setDict(d.metrics || [])
  }, [])

  useEffect(() => { loadDict() }, [loadDict])

  async function handleDictSave(newDict) {
    await saveMetricsDict(newDict)
    setDict(newDict)
  }

  async function openSaveAs() {
    // suggest next version based on existing alert-type templates
    const existing = await listTemplates('alert-type')
    const suggested = saveName && existing[saveName]
      ? bumpPatch(latestVersion(existing[saveName]))
      : 'v1.0.0'
    setSaveVer(suggested)
    setSaveAs(true)
    setSaveStatus('')
  }

  async function handleSaveAsAlertType() {
    const name = saveName.trim()
    if (!name || !query) return
    // auto-bump version if already exists
    const existing = await listTemplates('alert-type')
    let ver = saveVer.trim() || 'v1.0.0'
    if (existing[name] && existing[name].includes(ver)) {
      ver = bumpPatch(latestVersion(existing[name]))
      setSaveVer(ver)
    }
    const payload = {
      name,
      expr: query,
      vars: [],
      ...(saveDesc.trim() && { description: saveDesc.trim() }),
      ...(saveFor.trim()  && { for: saveFor.trim() }),
    }
    await saveTemplate('alert-type', name, ver, payload)
    setSaveStatus(`Saved "${name}" @ ${ver}`)
    setTimeout(() => { setSaveAs(false); setSaveStatus('') }, 2000)
  }

  function updateSeg(id, updated) {
    setSegments(prev => prev.map(s => s.id === id ? updated : s))
  }

  function removeSeg(id) {
    setSegments(prev => {
      const next = prev.filter(s => s.id !== id)
      if (next.length > 0) next[0] = { ...next[0], operator: '' }
      return next
    })
  }

  function addSeg() {
    setSegments(prev => [...prev, emptySegment('+')])
  }

  function updateSegOp(id, op) {
    setSegments(prev => prev.map(s => s.id === id ? { ...s, operator: op } : s))
  }

  function handleCopy() {
    if (!query) return
    navigator.clipboard.writeText(query)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleAddPanel() {
    if (!query) return
    const first = segments.find(s => s.metric.trim())
    setPanels(p => [...p, { title: first?.metric || `panel-${p.length + 1}`, query }])
  }

  const showOuterAggParam = AGG_PARAM_FUNCS.has(outer.func)
  const showOuterAggDim   = outer.func && !AGG_NO_DIM.has(outer.func) && outer.func !== 'count_values'
  const allLabelOpts      = [...new Set(dict.flatMap(m => m.labels.map(l => l.name)))]

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>

      {/* ── Live Preview ── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>PromQL Preview</div>
        <div style={{
          background: '#0f172a', color: '#7dd3fc', fontFamily: 'monospace',
          fontSize: 13, padding: '14px 16px', borderRadius: 6,
          minHeight: 52, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.8,
        }}>
          {query || <span style={{ color: '#475569' }}>Add a metric below…</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <Button type="primary" size="small" onClick={handleCopy} disabled={!query}>
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          <Button size="small" onClick={handleAddPanel} disabled={!query}>
            + Save panel
          </Button>
          <Button size="small" disabled={!query}
            onClick={openSaveAs}
            style={{ background: '#ede9fe', color: '#7c3aed', border: '1px solid #c4b5fd' }}>
            Save as Alert Type…
          </Button>
          <Button type="text" size="small" style={{ marginLeft: 'auto' }}
            onClick={() => { setSegments([emptySegment()]); setOuter(emptyOuter()); setOuterOffset('') }}>
            Clear all
          </Button>
        </div>

        {/* Save-as-Alert-Type inline form */}
        {saveAs && (
          <div style={{
            marginTop: 12, padding: 14, background: '#faf5ff',
            border: '1px solid #e9d5ff', borderRadius: 6,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', marginBottom: 10 }}>
              Save as Alert Type
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 160px 120px', gap: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Alert Type name *</label>
                <input type="text" value={saveName} placeholder="e.g. high-cpu"
                  onChange={e => setSaveName(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Version</label>
                <input type="text" value={saveVer} placeholder="v1.0.0"
                  onChange={e => setSaveVer(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Description</label>
                <input type="text" value={saveDesc} placeholder="optional"
                  onChange={e => setSaveDesc(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>For (default)</label>
                <input type="text" value={saveFor} placeholder="e.g. 5m"
                  onChange={e => setSaveFor(e.target.value)} />
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace',
              marginBottom: 10, wordBreak: 'break-all' }}>
              expr: {query}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button type="primary" size="small" disabled={!saveName.trim()}
                onClick={handleSaveAsAlertType}>Save</Button>
              <Button type="text" size="small" onClick={() => { setSaveAs(false); setSaveStatus('') }}>
                Cancel
              </Button>
              {saveStatus && (
                <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>
                  {saveStatus}
                  {onNavigate && (
                    <Button type="text" size="small" style={{ marginLeft: 8, color: '#7c3aed' }}
                      onClick={() => onNavigate('alert-type')}>
                      → Edit in Alert Type
                    </Button>
                  )}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Segments ── */}
      {segments.map((seg, i) => (
        <div key={seg.id}>
          {i > 0 && (
            <OperatorDivider value={seg.operator || '+'} onChange={op => updateSegOp(seg.id, op)} />
          )}
          <SegmentCard seg={seg} index={i} total={segments.length} dict={dict}
            onChange={updated => updateSeg(seg.id, updated)}
            onRemove={() => removeSeg(seg.id)} />
        </div>
      ))}

      <Button style={{ width: '100%', marginTop: 12 }} onClick={addSeg}>
        + Add metric
      </Button>

      {/* ── Outer aggregation ── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 16, marginTop: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.08em', color: '#6b7280', marginBottom: 10 }}>
          Outer aggregation (wraps entire expression)
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, minWidth: 150 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Function</label>
            <select value={outer.func} onChange={e => setOuter(o => ({ ...o, func: e.target.value }))}>
              <option value="">— none —</option>
              {AGG_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          {showOuterAggDim && <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, width: 80 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Dim</label>
              <select value={outer.dim} onChange={e => setOuter(o => ({ ...o, dim: e.target.value }))}>
                <option value="by">by</option>
                <option value="without">without</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Labels</label>
              <SuggestInput id="outer-agg-labels" value={outer.aggLabels}
                options={allLabelOpts} placeholder="job, instance"
                onChange={v => setOuter(o => ({ ...o, aggLabels: v }))} />
            </div>
          </>}
          {showOuterAggParam && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, width: 120 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{outer.func === 'quantile' ? 'φ' : outer.func === 'count_values' ? 'label' : 'k'}</label>
              <input type="text" value={outer.param}
                placeholder={outer.func === 'quantile' ? '0.95' : outer.func === 'count_values' ? 'value' : '5'}
                onChange={e => setOuter(o => ({ ...o, param: e.target.value }))} />
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, width: 140 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Offset</label>
            <input type="text" value={outerOffset} placeholder="e.g. 1h"
              onChange={e => setOuterOffset(e.target.value)} />
          </div>
        </div>
      </div>

      {/* ── Metrics Dictionary Editor ── */}
      <DictEditor savedDict={dict} onSave={handleDictSave} />

      {/* ── Saved Panels ── */}
      {panels.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 16, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>Saved Panels</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <colgroup><col style={{ width: '18%' }} /><col /><col style={{ width: 40 }} /></colgroup>
            <thead>
              <tr>{['panel', 'query', ''].map(h => (
                <th key={h} style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600,
                  textAlign: 'left', paddingBottom: 6, borderBottom: '1px solid #e5e7eb' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {panels.map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 0', fontSize: 13 }}>{p.title}</td>
                  <td style={{ padding: '8px 8px', fontFamily: 'monospace', fontSize: 12,
                    color: '#1e40af', wordBreak: 'break-all' }}>{p.query}</td>
                  <td>
                    <Button type="text" size="small" style={{ padding: '5px 8px', fontSize: 15 }}
                      onClick={() => setPanels(pp => pp.filter((_, idx) => idx !== i))}>×</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
