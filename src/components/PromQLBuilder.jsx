// PromQL Visual Builder — concrete values only (no template variable binding)
// Used in the rule group editor where you fill in real values, not templates.
import { useState, useMemo, useRef, useEffect } from 'react'
import { Button } from 'antd'

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

// ── Build functions ───────────────────────────────────────────────────────────

function dictLabels(dict, metricName) {
  return dict.find(m => m.name === metricName)?.labels || []
}
function dictValues(dict, metricName, labelName) {
  return dictLabels(dict, metricName).find(l => l.name === labelName)?.values || []
}
function buildSelector(metric, matchers) {
  const valid = matchers.filter(m => m.label.trim())
  const lbls  = valid.map(m => `${m.label}${m.op}"${m.value}"`).join(', ')
  return `${metric}${lbls ? `{${lbls}}` : ''}`
}
function buildSegmentExpr(seg) {
  if (seg.kind === 'scalar') return seg.scalar.trim()
  if (!seg.metric && !seg.matchers.some(m => m.label.trim())) return ''
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
export function buildFinalQuery(segments, outer, outerOffset) {
  const exprs = segments.map(seg => ({ op: seg.operator, expr: buildSegmentExpr(seg) })).filter(x => x.expr)
  if (!exprs.length) return ''
  let combined = exprs[0].expr
  for (let i = 1; i < exprs.length; i++) combined = `${combined} ${exprs[i].op || '+'} ${exprs[i].expr}`
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

let _uid = 0
const uid = () => ++_uid
export const emptySegment = (operator = '') => ({
  id: uid(), kind: 'metric', operator, scalar: '', metric: '', matchers: [],
  rangeFunc: '', rangeInterval: '5m', rangeOffset: '', rangeParam: '0.95',
  instantFunc: '', instantParam: '0.95', aggFunc: '', aggDim: 'by', aggLabels: '', aggParam: '',
})
export const emptyOuter = () => ({ func: '', dim: 'by', aggLabels: '', param: '' })

// ── Sub-components ────────────────────────────────────────────────────────────

function SuggestInput({ id, value, onChange, options = [], placeholder, style }) {
  const listId = `dlb-${id}`
  return (
    <>
      <input type="text" list={listId} value={value} placeholder={placeholder}
        style={style} onChange={e => onChange(e.target.value)} />
      <datalist id={listId}>{options.map(o => <option key={o} value={o} />)}</datalist>
    </>
  )
}

const BADGE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316']
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function SegmentCard({ seg, index, total, dict, onChange, onRemove }) {
  function set(field, val) { onChange({ ...seg, [field]: val }) }
  function updateMatcher(i, field, val) {
    onChange({ ...seg, matchers: seg.matchers.map((m, idx) => idx === i ? { ...m, [field]: val } : m) })
  }
  function addMatcher()    { onChange({ ...seg, matchers: [...seg.matchers, { id: uid(), label: '', op: '=', value: '' }] }) }
  function removeMatcher(i){ onChange({ ...seg, matchers: seg.matchers.filter((_, idx) => idx !== i) }) }

  const color    = BADGE_COLORS[index % BADGE_COLORS.length]
  const label    = LABELS[index] || String(index + 1)
  const isScalar = seg.kind === 'scalar'
  const metricOpts = dict.map(m => m.name)
  const labelOpts  = dictLabels(dict, seg.metric).map(l => l.name)

  const showRangeParam   = seg.rangeFunc === 'quantile_over_time'
  const showInstantParam = INSTANT_PARAM.has(seg.instantFunc)
  const showAggDim       = seg.aggFunc && !AGG_NO_DIM.has(seg.aggFunc) && seg.aggFunc !== 'count_values'
  const showAggParam     = AGG_PARAM_FUNCS.has(seg.aggFunc)

  return (
    <div style={{ border: `1.5px solid ${color}30`, borderRadius: 8, overflow: 'hidden', background: '#fff', marginBottom: 8 }}>
      <div style={{ background: `${color}12`, borderBottom: `1.5px solid ${color}30`, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ background: color, color: '#fff', fontWeight: 700, fontSize: 11, borderRadius: 4, padding: '2px 7px', fontFamily: 'monospace' }}>{label}</span>
        <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #d1d5db', fontSize: 11 }}>
          {['metric', 'scalar'].map(k => (
            <button key={k} style={{ padding: '2px 9px', border: 'none', cursor: 'pointer', fontWeight: 600,
              background: seg.kind === k ? color : '#fff', color: seg.kind === k ? '#fff' : '#6b7280' }}
              onClick={() => set('kind', k)}>{k}</button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: '#6b7280', flex: 1, fontFamily: 'monospace' }}>
          {isScalar ? (seg.scalar || <span style={{ color: '#9ca3af' }}>constant</span>)
                    : (seg.metric || <span style={{ color: '#9ca3af' }}>no metric</span>)}
        </span>
        {total > 1 && (
          <Button type="text" size="small" danger style={{ padding: '2px 8px' }} onClick={onRemove}>Remove</Button>
        )}
      </div>

      <div style={{ padding: 12 }}>
        {isScalar && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, maxWidth: 260 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Constant value</label>
            <input type="text" value={seg.scalar} placeholder="e.g. 100" onChange={e => set('scalar', e.target.value)} />
          </div>
        )}
        {!isScalar && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Metric name</label>
              <SuggestInput id={`m-${seg.id}`} value={seg.metric} options={metricOpts}
                placeholder="e.g. http_requests_total" onChange={v => set('metric', v)} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, display: 'block', marginBottom: 4 }}>Label matchers</label>
              {seg.matchers.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 6 }}>
                  <colgroup><col style={{ width: '34%' }} /><col style={{ width: '13%' }} /><col /><col style={{ width: 30 }} /></colgroup>
                  <tbody>
                    {seg.matchers.map((m, i) => (
                      <tr key={i}>
                        <td style={{ paddingRight: 4, paddingBottom: 4 }}>
                          <SuggestInput id={`lbl-${seg.id}-${i}`} value={m.label} options={labelOpts} placeholder="label" onChange={v => updateMatcher(i, 'label', v)} />
                        </td>
                        <td style={{ paddingRight: 4, paddingBottom: 4 }}>
                          <select value={m.op} onChange={e => updateMatcher(i, 'op', e.target.value)} style={{ fontFamily: 'monospace' }}>
                            {LABEL_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </td>
                        <td style={{ paddingRight: 4, paddingBottom: 4 }}>
                          <SuggestInput id={`val-${seg.id}-${i}`} value={m.value}
                            options={dictValues(dict, seg.metric, m.label)}
                            placeholder={m.op.includes('~') ? 'regex' : 'value'} onChange={v => updateMatcher(i, 'value', v)} />
                        </td>
                        <td style={{ paddingBottom: 4 }}>
                          <Button type="text" size="small" style={{ padding: '5px 8px', fontSize: 15 }} onClick={() => removeMatcher(i)}>×</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Button type="text" size="small" onClick={addMatcher}>+ Add matcher</Button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 5 }}>Range function</label>
                <select value={seg.rangeFunc} onChange={e => set('rangeFunc', e.target.value)} style={{ marginBottom: 5 }}>
                  <option value="">— none —</option>
                  {RANGE_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                {seg.rangeFunc && (
                  <>
                    <input type="text" value={seg.rangeInterval} placeholder="5m" onChange={e => set('rangeInterval', e.target.value)} style={{ marginBottom: 4 }} />
                    <input type="text" value={seg.rangeOffset} placeholder="offset (e.g. 1h)" onChange={e => set('rangeOffset', e.target.value)} />
                    {showRangeParam && (
                      <input type="number" step="0.05" min="0" max="1" value={seg.rangeParam}
                        onChange={e => set('rangeParam', e.target.value)} style={{ marginTop: 4 }} />
                    )}
                  </>
                )}
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 5 }}>Instant function</label>
                <select value={seg.instantFunc} onChange={e => set('instantFunc', e.target.value)}>
                  <option value="">— none —</option>
                  {INSTANT_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                {showInstantParam && (
                  <input type="number" step="0.05" min="0" max="1" value={seg.instantParam}
                    onChange={e => set('instantParam', e.target.value)} style={{ marginTop: 5 }} />
                )}
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 5 }}>Aggregation</label>
                <select value={seg.aggFunc} onChange={e => set('aggFunc', e.target.value)} style={{ marginBottom: seg.aggFunc ? 5 : 0 }}>
                  <option value="">— none —</option>
                  {AGG_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                {seg.aggFunc && showAggDim && (
                  <>
                    <select value={seg.aggDim} onChange={e => set('aggDim', e.target.value)} style={{ width: 80, marginBottom: 4 }}>
                      <option value="by">by</option>
                      <option value="without">without</option>
                    </select>
                    <SuggestInput id={`agg-${seg.id}`} value={seg.aggLabels} options={labelOpts} placeholder="job, instance" onChange={v => set('aggLabels', v)} />
                  </>
                )}
                {seg.aggFunc && showAggParam && (
                  <input type="text" style={{ marginTop: 4 }} value={seg.aggParam}
                    placeholder={seg.aggFunc === 'quantile' ? 'φ (0.95)' : seg.aggFunc === 'count_values' ? 'label name' : 'k (5)'}
                    onChange={e => set('aggParam', e.target.value)} />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function OperatorDivider({ value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
      <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, color: '#6366f1',
          border: '1.5px solid #a5b4fc', borderRadius: 6, padding: '3px 10px', background: '#eef2ff' }}>
        {BINARY_OPS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
    </div>
  )
}

// ── PromQLBuilder ─────────────────────────────────────────────────────────────
// Manages its own segments/outer/offset state.
// Calls onChange(builtQuery) whenever the expression changes.

export default function PromQLBuilder({ onChange, dict = [] }) {
  const [segments,    setSegments]    = useState([emptySegment()])
  const [outer,       setOuter]       = useState(emptyOuter())
  const [outerOffset, setOuterOffset] = useState('')

  const builtQuery  = useMemo(() => buildFinalQuery(segments, outer, outerOffset), [segments, outer, outerOffset])
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => { onChangeRef.current(builtQuery) }, [builtQuery])

  function updateSeg(id, updated) { setSegments(prev => prev.map(s => s.id === id ? updated : s)) }
  function removeSeg(id) {
    setSegments(prev => {
      const next = prev.filter(s => s.id !== id)
      if (next.length) next[0] = { ...next[0], operator: '' }
      return next
    })
  }
  function addSeg()            { setSegments(prev => [...prev, emptySegment('+')]) }
  function updateSegOp(id, op) { setSegments(prev => prev.map(s => s.id === id ? { ...s, operator: op } : s)) }

  const showOuterAggDim   = outer.func && !AGG_NO_DIM.has(outer.func) && outer.func !== 'count_values'
  const showOuterAggParam = AGG_PARAM_FUNCS.has(outer.func)
  const allLabelOpts      = [...new Set(dict.flatMap(m => (m.labels || []).map(l => l.name)))]

  return (
    <div>
      {segments.map((seg, i) => (
        <div key={seg.id}>
          {i > 0 && <OperatorDivider value={seg.operator || '+'} onChange={op => updateSegOp(seg.id, op)} />}
          <SegmentCard seg={seg} index={i} total={segments.length} dict={dict}
            onChange={updated => updateSeg(seg.id, updated)}
            onRemove={() => removeSeg(seg.id)} />
        </div>
      ))}

      <Button size="small" block style={{ marginBottom: 10 }} onClick={addSeg}>
        + Add metric / scalar
      </Button>

      {/* Outer aggregation */}
      <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 14px', marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b7280', marginBottom: 8 }}>
          Outer aggregation
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, minWidth: 140 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Function</label>
            <select value={outer.func} onChange={e => setOuter(o => ({ ...o, func: e.target.value }))}>
              <option value="">— none —</option>
              {AGG_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          {showOuterAggDim && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, width: 80 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Dim</label>
                <select value={outer.dim} onChange={e => setOuter(o => ({ ...o, dim: e.target.value }))}>
                  <option value="by">by</option>
                  <option value="without">without</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, flex: 1, minWidth: 140 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Labels</label>
                <SuggestInput id="b-outer-labels" value={outer.aggLabels} options={allLabelOpts}
                  placeholder="job, instance" onChange={v => setOuter(o => ({ ...o, aggLabels: v }))} />
              </div>
            </>
          )}
          {showOuterAggParam && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, width: 120 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{outer.func === 'quantile' ? 'φ' : outer.func === 'count_values' ? 'label' : 'k'}</label>
              <input type="text" value={outer.param}
                placeholder={outer.func === 'quantile' ? '0.95' : outer.func === 'count_values' ? 'value' : '5'}
                onChange={e => setOuter(o => ({ ...o, param: e.target.value }))} />
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 0, width: 120 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Offset</label>
            <input type="text" value={outerOffset} placeholder="e.g. 1h"
              onChange={e => setOuterOffset(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Live preview */}
      <div style={{ background: '#0f172a', borderRadius: 6, padding: '10px 14px' }}>
        <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
          Built expression
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#7dd3fc', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.7 }}>
          {builtQuery || <span style={{ color: '#334155' }}>Add a metric above…</span>}
        </div>
      </div>
    </div>
  )
}
