import { useState, useEffect, useCallback, useMemo } from 'react'
import KVEditor from '../components/KVEditor'
import VersionModal from '../components/VersionModal'
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, getMetricsDict } from '../utils/api'
import { kvArrayToObject, objectToKvArray, bumpPatch, latestVersion } from '../utils/templateUtils'

const TYPE = 'alert-type'
const VAR_TYPES = ['string', 'metrics', 'op', 'func', 'time', 'int']

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

// ── PromQL builder functions ──────────────────────────────────────────────────

function dictLabels(dict, metricName) {
  return dict.find(m => m.name === metricName)?.labels || []
}
function dictValues(dict, metricName, labelName) {
  return dictLabels(dict, metricName).find(l => l.name === labelName)?.values || []
}
function buildSelector(metric, matchers, vm = {}) {
  const valid = matchers.filter(m => m.label.trim())
  const lbls  = valid.map(m => {
    const val = vm[`labelVal_${m.id}`] ? `{{ .${vm[`labelVal_${m.id}`]} }}` : m.value
    return `${m.label}${m.op}"${val}"`
  }).join(', ')
  return `${metric}${lbls ? `{${lbls}}` : ''}`
}
function buildSegmentExpr(seg) {
  const vm  = seg.varMap || {}
  const tpl = (val, key) => vm[key] ? `{{ .${vm[key]} }}` : val

  if (seg.kind === 'scalar') return tpl(seg.scalar.trim(), 'scalar')
  const metricVal = tpl(seg.metric, 'metric')
  if (!metricVal && !seg.matchers.some(m => m.label.trim())) return ''
  let expr = buildSelector(metricVal, seg.matchers, vm)
  if (seg.rangeFunc) {
    const iv     = tpl(seg.rangeInterval.trim() || '5m', 'rangeInterval')
    const offset = vm.rangeOffset
      ? ` offset {{ .${vm.rangeOffset} }}`
      : (seg.rangeOffset.trim() ? ` offset ${seg.rangeOffset}` : '')
    expr = seg.rangeFunc === 'quantile_over_time'
      ? `${seg.rangeFunc}(${tpl(seg.rangeParam || '0.95', 'rangeParam')}, ${expr}[${iv}]${offset})`
      : `${seg.rangeFunc}(${expr}[${iv}]${offset})`
  }
  if (seg.instantFunc) {
    expr = INSTANT_PARAM.has(seg.instantFunc)
      ? `${seg.instantFunc}(${tpl(seg.instantParam || '0.95', 'instantParam')}, ${expr})`
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

let _id = 0
const uid = () => ++_id
const emptySegment = (operator = '') => ({
  id: uid(), kind: 'metric', operator, scalar: '', metric: '', matchers: [],
  rangeFunc: '', rangeInterval: '5m', rangeOffset: '', rangeParam: '0.95',
  instantFunc: '', instantParam: '0.95', aggFunc: '', aggDim: 'by', aggLabels: '', aggParam: '',
  varMap: {}, // field -> varName: fields with a varName output {{ .varName }} in the built expression
})
const emptyOuter = () => ({ func: '', dim: 'by', aggLabels: '', param: '' })

// ── PromQL UI components ──────────────────────────────────────────────────────

function SuggestInput({ id, value, onChange, options = [], placeholder, style }) {
  const listId = `dl-${id}`
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

function SegmentCard({ seg, index, total, dict, onChange, onRemove, onMakeVar, onClearVar, availableVars }) {
  function set(field, val) { onChange({ ...seg, [field]: val }) }
  function updateMatcher(i, field, val) {
    onChange({ ...seg, matchers: seg.matchers.map((m, idx) => idx === i ? { ...m, [field]: val } : m) })
  }
  function addMatcher() { onChange({ ...seg, matchers: [...seg.matchers, { id: uid(), label: '', op: '=', value: '' }] }) }
  function removeMatcher(i) { onChange({ ...seg, matchers: seg.matchers.filter((_, idx) => idx !== i) }) }

  const vm = seg.varMap || {}
  const color    = BADGE_COLORS[index % BADGE_COLORS.length]
  const label    = LABELS[index] || String(index + 1)
  const isScalar = seg.kind === 'scalar'
  const metricOpts = dict.map(m => m.name)
  const labelOpts  = dictLabels(dict, seg.metric).map(l => l.name)

  const showRangeParam   = seg.rangeFunc === 'quantile_over_time'
  const showInstantParam = INSTANT_PARAM.has(seg.instantFunc)
  const showAggDim       = seg.aggFunc && !AGG_NO_DIM.has(seg.aggFunc) && seg.aggFunc !== 'count_values'
  const showAggParam     = AGG_PARAM_FUNCS.has(seg.aggFunc)

  const varProps = (field, prefix, type) => ({ field, varMap: vm, onMakeVar, onClearVar, varPrefix: prefix, varType: type, availableVars })

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
        <span style={{ fontSize: 12, color: '#6b7280', flex: 1 }}>
          {isScalar ? (vm.scalar ? `{{ .${vm.scalar} }}` : seg.scalar || <span style={{ color: '#9ca3af' }}>constant</span>)
                    : (vm.metric ? `{{ .${vm.metric} }}` : seg.metric || <span style={{ color: '#9ca3af' }}>no metric</span>)}
        </span>
        {total > 1 && (
          <button className="btn btn-ghost btn-sm" style={{ color: '#ef4444', padding: '2px 8px' }} onClick={onRemove}>Remove</button>
        )}
      </div>
      <div style={{ padding: 12 }}>
        {isScalar && (
          <div className="form-row" style={{ maxWidth: 260, marginBottom: 0 }}>
            <label>Constant value</label>
            <VarField {...varProps('scalar', 'threshold', 'string')}>
              <input type="text" value={seg.scalar} placeholder="e.g. 100" onChange={e => set('scalar', e.target.value)} />
            </VarField>
          </div>
        )}
        {!isScalar && (
          <>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <label>Metric name</label>
              <VarField {...varProps('metric', 'metrics', 'metrics')}>
                <SuggestInput id={`metric-${seg.id}`} value={seg.metric} options={metricOpts}
                  placeholder="e.g. http_requests_total" onChange={v => set('metric', v)} />
              </VarField>
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
                          <VarField field={`labelVal_${m.id}`} varMap={vm}
                            onMakeVar={onMakeVar} onClearVar={onClearVar}
                            varPrefix="label" varType="string" availableVars={availableVars}>
                            <SuggestInput id={`val-${seg.id}-${i}`} value={m.value}
                              options={dictValues(dict, seg.metric, m.label)}
                              placeholder={m.op.includes('~') ? 'regex' : 'value'} onChange={v => updateMatcher(i, 'value', v)} />
                          </VarField>
                        </td>
                        <td style={{ paddingBottom: 4 }}>
                          <button className="btn btn-ghost btn-icon" onClick={() => removeMatcher(i)}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button className="btn btn-ghost btn-sm" onClick={addMatcher}>+ Add matcher</button>
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
                    <VarField {...varProps('rangeInterval', 'range', 'time')}>
                      <input type="text" value={seg.rangeInterval} placeholder="5m" onChange={e => set('rangeInterval', e.target.value)} />
                    </VarField>
                    <div style={{ marginTop: 4 }}>
                      <VarField {...varProps('rangeOffset', 'offset', 'time')}>
                        <input type="text" value={seg.rangeOffset} placeholder="offset (e.g. 1h)" onChange={e => set('rangeOffset', e.target.value)} />
                      </VarField>
                    </div>
                    {showRangeParam && (
                      <div style={{ marginTop: 4 }}>
                        <VarField {...varProps('rangeParam', 'quantile', 'string')}>
                          <input type="number" step="0.05" min="0" max="1" value={seg.rangeParam} onChange={e => set('rangeParam', e.target.value)} />
                        </VarField>
                      </div>
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
                  <div style={{ marginTop: 5 }}>
                    <VarField {...varProps('instantParam', 'param', 'string')}>
                      <input type="number" step="0.05" min="0" max="1" value={seg.instantParam} onChange={e => set('instantParam', e.target.value)} />
                    </VarField>
                  </div>
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

// ── Alert type helpers ────────────────────────────────────────────────────────

function previewExpr(expr, varDecls) {
  if (!expr) return ''
  const map = {}
  for (const v of varDecls) { if (v.name.trim()) map[v.name.trim()] = `<${v.name.trim()}>` }
  let result = expr.replace(
    /\{\{\s*\.(\w+)\s*([+\-*/])\s*(\d+(?:\.\d+)?)\s*\}\}/g,
    (match, key, op, rhs) => map[key] ? `<${key}${op}${rhs}>` : match
  )
  result = result.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (match, key) => map[key] ?? match)
  return result
}

const emptyForm = () => ({
  name: '', description: '', expr: '', vars: [], for: '', labels: [],
})

// ── VarField: wraps an input with a "make var" / "clear var" control ─────────
// availableVars: form.vars filtered to same type, for reuse

function VarField({ field, varMap, onMakeVar, onClearVar, varPrefix, varType, availableVars = [], children }) {
  const varName    = varMap?.[field]
  const sameType   = availableVars.filter(v => v.type === varType && v.name.trim())

  const selectStyle = {
    fontFamily: 'monospace', fontSize: 11.5, color: '#16a34a',
    background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4,
    padding: '2px 4px', cursor: 'pointer', maxWidth: 160,
  }

  // Field is already bound to a var — show select to switch, × to clear
  if (varName) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <select value={varName} style={selectStyle}
          onChange={e => onMakeVar(field, varPrefix, varType, e.target.value)}>
          {sameType.map(v => <option key={v.name} value={v.name}>{`{{ .${v.name} }}`}</option>)}
          {/* fallback if varName not in sameType (e.g. type mismatch edge case) */}
          {!sameType.find(v => v.name === varName) && <option value={varName}>{`{{ .${varName} }}`}</option>}
        </select>
        <button className="btn btn-ghost btn-icon" style={{ color: '#ef4444', fontSize: 13 }}
          title="Remove variable" onClick={() => onClearVar(field)}>×</button>
      </div>
    )
  }

  // Not yet bound — show input + a dropdown that offers existing vars or "New"
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <div style={{ flex: 1 }}>{children}</div>
      <select style={{
        padding: '2px 4px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
        color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe',
        borderRadius: 4, maxWidth: 110,
      }} value="" title={`Bind to a template variable`}
        onChange={e => {
          if (!e.target.value) return
          onMakeVar(field, varPrefix, varType, e.target.value === '__new__' ? null : e.target.value)
        }}>
        <option value="">{'{ }'}</option>
        {sameType.map(v => <option key={v.name} value={v.name}>↑ {v.name}</option>)}
        <option value="__new__">+ New var</option>
      </select>
    </div>
  )
}

// ── Mode toggle ───────────────────────────────────────────────────────────────

function ModeToggle({ mode, onChange }) {
  return (
    <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #d1d5db', fontSize: 11 }}>
      {[['visual', 'Visual Builder'], ['raw', 'Raw / Template']].map(([k, lbl]) => (
        <button key={k} style={{
          padding: '3px 13px', border: 'none', cursor: 'pointer', fontWeight: 600,
          background: mode === k ? '#6366f1' : '#fff',
          color: mode === k ? '#fff' : '#6b7280',
        }} onClick={() => onChange(k)}>{lbl}</button>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlertTypeEditor() {
  const [templates, setTemplates] = useState({})
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState(emptyForm())
  const [isNew, setIsNew]         = useState(false)
  const [modal, setModal]         = useState(null)
  const [status, setStatus]       = useState('')

  // Expr mode: 'visual' builds PromQL visually; 'raw' edits the template string directly
  const [exprMode, setExprMode]   = useState('visual')

  // PromQL builder state
  const [segments, setSegments]       = useState([emptySegment()])
  const [outer, setOuter]             = useState(emptyOuter())
  const [outerOffset, setOuterOffset] = useState('')
  const [dict, setDict]               = useState([])

  const builtQuery = useMemo(() => buildFinalQuery(segments, outer, outerOffset), [segments, outer, outerOffset])

  // In visual mode, form.expr tracks the built query live
  useEffect(() => {
    if (exprMode === 'visual') setForm(f => ({ ...f, expr: builtQuery }))
  }, [exprMode, builtQuery])

  const load = useCallback(async () => {
    const [ts, md] = await Promise.all([listTemplates(TYPE), getMetricsDict()])
    setTemplates(ts)
    setDict((md.metrics || []))
  }, [])
  useEffect(() => { load() }, [load])

  async function selectVersion(name, version) {
    const data = await getTemplate(TYPE, name, version)
    if (!data) return
    const p = data.parsed || {}
    setForm({
      name:        p.name        || name,
      description: p.description || '',
      expr:        p.expr        || '',
      vars: (p.vars || []).map(v => ({ name: v.name || '', description: v.description || '', type: v.type || 'string' })),
      for:    p.for    || '',
      labels: objectToKvArray(p.labels || {}),
    })
    setSelected({ name, version })
    setIsNew(false)
    // Reset builder and switch to raw — template vars can't be parsed back to segments
    setSegments([emptySegment()])
    setOuter(emptyOuter())
    setOuterOffset('')
    setExprMode('raw')
  }

  function startNew() {
    setForm(emptyForm())
    setSelected(null)
    setIsNew(true)
    setSegments([emptySegment()])
    setOuter(emptyOuter())
    setOuterOffset('')
    setExprMode('visual')
  }

  function handleModeChange(mode) {
    if (mode === 'visual' && form.expr && form.expr !== builtQuery) {
      // Raw textarea has content that differs from the builder output (user likely added template vars).
      // Switching to visual will overwrite form.expr with builtQuery — confirm first.
      if (!confirm('Switching to Visual will replace your raw expression with the builder output. Continue?')) return
    }
    setExprMode(mode)
  }

  // Segment handlers
  function updateSeg(id, updated) { setSegments(prev => prev.map(s => s.id === id ? updated : s)) }
  function removeSeg(id) {
    setSegments(prev => {
      const next = prev.filter(s => s.id !== id)
      if (next.length) next[0] = { ...next[0], operator: '' }
      return next
    })
  }
  function addSeg()             { setSegments(prev => [...prev, emptySegment('+')]) }
  function updateSegOp(id, op)  { setSegments(prev => prev.map(s => s.id === id ? { ...s, operator: op } : s)) }

  // Var-field handlers: convert a segment field to a template variable
  // existingVarName: reuse an existing var; null: create a new one
  function makeVar(segId, field, prefix, varType, existingVarName) {
    if (existingVarName) {
      // Reuse — just update the segment's varMap, no new entry in form.vars
      setSegments(prev => prev.map(s => s.id === segId
        ? { ...s, varMap: { ...s.varMap, [field]: existingVarName } } : s))
    } else {
      setForm(f => {
        const count = f.vars.filter(v => v.name.startsWith(`${prefix}_var`)).length
        const varName = `${prefix}_var${count + 1}`
        setSegments(prev => prev.map(s => s.id === segId
          ? { ...s, varMap: { ...s.varMap, [field]: varName } } : s))
        return { ...f, vars: [...f.vars, { name: varName, type: varType, description: '' }] }
      })
    }
  }
  function clearVar(segId, field) {
    setSegments(prev => prev.map(s => {
      if (s.id !== segId) return s
      const { [field]: _, ...rest } = s.varMap || {}
      return { ...s, varMap: rest }
    }))
  }

  function buildPayload() {
    const out = {
      name: form.name,
      expr: form.expr,
      vars: form.vars.filter(v => v.name.trim()).map(v => ({
        name: v.name.trim(), type: v.type || 'string',
        ...(v.description && { description: v.description }),
      })),
    }
    if (form.description) out.description = form.description
    if (form.for)         out.for = form.for
    const labels = kvArrayToObject(form.labels)
    if (Object.keys(labels).length) out.labels = labels
    return out
  }

  async function handleSave(name, version) {
    setModal(null)
    if (!name) return
    await saveTemplate(TYPE, name, version, buildPayload())
    await load()
    setSelected({ name, version })
    setIsNew(false)
    setStatus(`Saved ${name} @ ${version}`)
    setTimeout(() => setStatus(''), 2500)
  }

  function openSaveModal() {
    const n = form.name.trim()
    const existing = templates[n]
    const suggested = selected
      ? bumpPatch(selected.version)
      : (existing?.length ? bumpPatch(latestVersion(existing)) : 'v1.0.0')
    setModal({ name: n, version: suggested })
  }

  async function handleDelete() {
    if (!selected || !confirm(`Delete ${selected.name} @ ${selected.version}?`)) return
    await deleteTemplate(TYPE, selected.name, selected.version)
    setSelected(null); setForm(emptyForm()); setIsNew(false)
    await load()
  }

  function addVar()              { setForm(f => ({ ...f, vars: [...f.vars, { name: '', description: '', type: 'string' }] })) }
  function removeVar(i)          { setForm(f => ({ ...f, vars: f.vars.filter((_, idx) => idx !== i) })) }
  function updateVar(i, field, val) {
    setForm(f => ({ ...f, vars: f.vars.map((v, idx) => idx === i ? { ...v, [field]: val } : v) }))
  }

  const showOuterAggDim   = outer.func && !AGG_NO_DIM.has(outer.func) && outer.func !== 'count_values'
  const showOuterAggParam = AGG_PARAM_FUNCS.has(outer.func)
  const allLabelOpts      = [...new Set(dict.flatMap(m => m.labels.map(l => l.name)))]
  const exprPreview       = previewExpr(form.expr, form.vars)

  return (
    <div className="editor-layout">

      {/* ── Sidebar ── */}
      <div className="editor-list">
        <div className="editor-list-header">
          Alert Types
          <button className="btn btn-primary btn-sm" onClick={startNew}>+ New</button>
        </div>
        <div className="editor-list-body">
          {Object.keys(templates).length === 0 && (
            <div style={{ padding: '20px 14px', color: '#9ca3af', fontSize: 13 }}>No templates yet.</div>
          )}
          {Object.entries(templates).map(([name, versions]) => (
            <div key={name} className="template-group">
              <div className="template-group-name">{name}</div>
              {versions.map(v => (
                <div key={v}
                  className={`template-version${selected?.name === name && selected?.version === v ? ' active' : ''}`}
                  onClick={() => selectVersion(name, v)}>
                  <span className="version-badge">{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── Form ── */}
      <div className="editor-form">
        {!isNew && !selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚡</div>
            <p>Select a template or click + New to create one.</p>
          </div>
        ) : (
          <>
            {/* Identity */}
            <div className="form-card">
              <div className="form-card-title">
                {isNew ? 'New Alert Type' : `${selected.name} @ ${selected.version}`}
                {status && <span className="tag">{status}</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label>Name *</label>
                  <input type="text" value={form.name} placeholder="e.g. single-threshold"
                    readOnly={!isNew && !!selected}
                    style={!isNew && selected ? { background: '#f9fafb', color: '#6b7280' } : {}}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label>Description</label>
                  <input type="text" value={form.description} placeholder="Optional"
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label>For (duration, optional)</label>
                  <input type="text" value={form.for} placeholder="e.g. 5m"
                    onChange={e => setForm(f => ({ ...f, for: e.target.value }))} />
                </div>
              </div>
            </div>

            {/* Expression */}
            <div className="form-card">
              <div className="form-card-title">
                Expression
                <ModeToggle mode={exprMode} onChange={handleModeChange} />
              </div>

              {/* ── Visual Builder ── */}
              {exprMode === 'visual' && (
                <>
                  {segments.map((seg, i) => (
                    <div key={seg.id}>
                      {i > 0 && <OperatorDivider value={seg.operator || '+'} onChange={op => updateSegOp(seg.id, op)} />}
                      <SegmentCard seg={seg} index={i} total={segments.length} dict={dict}
                        onChange={updated => updateSeg(seg.id, updated)}
                        onRemove={() => removeSeg(seg.id)}
                        onMakeVar={(field, prefix, type, existing) => makeVar(seg.id, field, prefix, type, existing)}
                        onClearVar={field => clearVar(seg.id, field)}
                        availableVars={form.vars} />
                    </div>
                  ))}

                  <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 12 }} onClick={addSeg}>
                    + Add metric / scalar
                  </button>

                  {/* Outer aggregation */}
                  <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 14px', marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b7280', marginBottom: 8 }}>
                      Outer aggregation
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <div className="form-row" style={{ marginBottom: 0, minWidth: 140 }}>
                        <label>Function</label>
                        <select value={outer.func} onChange={e => setOuter(o => ({ ...o, func: e.target.value }))}>
                          <option value="">— none —</option>
                          {AGG_FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </div>
                      {showOuterAggDim && (
                        <>
                          <div className="form-row" style={{ marginBottom: 0, width: 80 }}>
                            <label>Dim</label>
                            <select value={outer.dim} onChange={e => setOuter(o => ({ ...o, dim: e.target.value }))}>
                              <option value="by">by</option>
                              <option value="without">without</option>
                            </select>
                          </div>
                          <div className="form-row" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
                            <label>Labels</label>
                            <SuggestInput id="outer-labels" value={outer.aggLabels} options={allLabelOpts}
                              placeholder="job, instance" onChange={v => setOuter(o => ({ ...o, aggLabels: v }))} />
                          </div>
                        </>
                      )}
                      {showOuterAggParam && (
                        <div className="form-row" style={{ marginBottom: 0, width: 120 }}>
                          <label>{outer.func === 'quantile' ? 'φ' : outer.func === 'count_values' ? 'label' : 'k'}</label>
                          <input type="text" value={outer.param}
                            placeholder={outer.func === 'quantile' ? '0.95' : outer.func === 'count_values' ? 'value' : '5'}
                            onChange={e => setOuter(o => ({ ...o, param: e.target.value }))} />
                        </div>
                      )}
                      <div className="form-row" style={{ marginBottom: 0, width: 120 }}>
                        <label>Offset</label>
                        <input type="text" value={outerOffset} placeholder="e.g. 1h"
                          onChange={e => setOuterOffset(e.target.value)} />
                      </div>
                    </div>
                  </div>

                  {/* Live preview */}
                  <div style={{ background: '#0f172a', borderRadius: 6, padding: '12px 14px', marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                      Built expression
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12.5, color: '#7dd3fc', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.8 }}>
                      {builtQuery || <span style={{ color: '#334155' }}>Add a metric above…</span>}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button className="btn btn-secondary btn-sm" disabled={!builtQuery}
                      onClick={() => handleModeChange('raw')}>
                      Switch to Raw → replace values with {'{{ .varName }}'}
                    </button>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>expression saved automatically</span>
                  </div>
                </>
              )}

              {/* ── Raw / Template mode ── */}
              {exprMode === 'raw' && (
                <>
                  <textarea rows={3} value={form.expr}
                    placeholder={'{{ .func }}({{ .metrics }}[{{ .time }}]) {{ .op }} {{ .threshold }}'}
                    onChange={e => setForm(f => ({ ...f, expr: e.target.value }))} />
                  <span className="text-muted" style={{ display: 'block', marginTop: 4 }}>
                    {'Replace any concrete value with {{ .varName }} · arithmetic: {{ .intVar + 10 }} · switch to Visual to rebuild from segments'}
                  </span>
                  {form.expr && (
                    <div className="preview-box" style={{ marginTop: 10 }}>
                      {exprPreview || <span style={{ color: '#475569' }}>Declare vars below to see substitution preview</span>}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Var Declarations */}
            <div className="form-card">
              <div className="form-card-title">
                Var Declarations
                <button className="btn btn-secondary btn-sm" onClick={addVar}>+ Add Var</button>
              </div>
              <p className="text-muted" style={{ marginBottom: 10 }}>
                Declare parameters with types. Rule Group fills in actual values.
              </p>
              {form.vars.length === 0 && <p className="text-muted">No vars declared yet.</p>}
              <table className="kv-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '26%' }} />
                  <col style={{ width: '16%' }} />
                  <col />
                  <col style={{ width: 32 }} />
                </colgroup>
                <thead>
                  <tr><th>name</th><th>type</th><th>description</th><th></th></tr>
                </thead>
                <tbody>
                  {form.vars.map((v, i) => (
                    <tr key={i}>
                      <td><input type="text" value={v.name} placeholder="varName" onChange={e => updateVar(i, 'name', e.target.value)} /></td>
                      <td>
                        <select value={v.type} onChange={e => updateVar(i, 'type', e.target.value)}>
                          {VAR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td><input type="text" value={v.description} placeholder="what this var means" onChange={e => updateVar(i, 'description', e.target.value)} /></td>
                      <td><button className="btn btn-ghost btn-icon" onClick={() => removeVar(i)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Labels */}
            <div className="form-card">
              <div className="form-card-title">Labels (optional)</div>
              <KVEditor rows={form.labels}
                onChange={rows => setForm(f => ({ ...f, labels: rows }))}
                keyPlaceholder="label key" valuePlaceholder="value" />
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={openSaveModal}
                disabled={!form.name.trim() || !form.expr.trim()}>
                Save as Version…
              </button>
              {selected && <button className="btn btn-danger" onClick={handleDelete}>Delete this version</button>}
            </div>
          </>
        )}
      </div>

      {modal && <VersionModal defaultName={modal.name} defaultVersion={modal.version} onSave={handleSave} onCancel={() => setModal(null)} />}
    </div>
  )
}
