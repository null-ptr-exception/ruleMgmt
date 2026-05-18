import { useState, useEffect, useCallback } from 'react'
import { Layout, Card, Input, Button, Select, Typography, Tag, Space, Badge } from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined, FolderOutlined, FolderOpenOutlined } from '@ant-design/icons'
import KVEditor from '../components/KVEditor'
import {
  getProduct, setProduct,
  listSites, createSite, deleteSite,
  listRelunits, createRelunit, deleteRelunit,
  getStage, saveStage, deleteStage,
  listTemplates, getChartMeta, runHelmRender,
  getDefaults, saveDefaults,
} from '../utils/api'
import { objectToKvArray, kvArrayToObject } from '../utils/templateUtils'

const { Sider, Content } = Layout
const { Text, Title } = Typography

const STAGES = ['DEV', 'TEST', 'STG', 'PROD']

function buildStageChart(relunit, stage, chartName, chartVersion, amconfigName, amconfigVersion) {
  const semver = chartVersion.replace(/^v/, '')
  const repoPath = `../../../../../templates/amconfig/${amconfigName}/${amconfigVersion}`
  return {
    apiVersion: 'v2',
    name: `${relunit}-${stage}`.toLowerCase(),
    description: `Gitops deploy chart for ${relunit}/${stage}`,
    type: 'application',
    version: '0.1.0',
    dependencies: [{
      name: chartName,
      version: semver,
      repository: `file://${repoPath}`,
    }],
  }
}

function buildStageValues(chartName, overrides) {
  const obj = kvArrayToObject(overrides)
  return { [chartName]: Object.keys(obj).length ? obj : {} }
}

export default function GitopsEditor() {
  const [product, setProductName]      = useState('')
  const [editingProduct, setEditProduct] = useState(false)
  const [productInput, setProductInput]  = useState('')
  const [sites, setSites]              = useState([])
  const [relunits, setRelunits]        = useState({})
  const [selection, setSelection]      = useState(null)
  const [amconfigs, setAmconfigs]       = useState({})

  const [addSite, setAddSite]          = useState(false)
  const [addSiteVal, setAddSiteVal]    = useState('')
  const [addRelunit, setAddRelunit]    = useState(null)
  const [addRelVal, setAddRelVal]      = useState('')

  const [stageForm, setStageForm]      = useState({
    systemName: '', systemVersion: '',
    chartName: '', chartSemver: '',
    overrides: [],
  })
  const [stageStatus, setStageStatus]  = useState('')

  const [helmRunning, setHelmRunning]  = useState(false)
  const [helmOutput, setHelmOutput]    = useState('')
  const [helmOk, setHelmOk]           = useState(null)

  const [enabledStages, setEnabledStages] = useState({})

  const [defaults, setDefaults]           = useState({})
  const [productPfx, setProductPfx]       = useState('')
  const [productPfxInput, setProductPfxInput] = useState('')
  const [productPfxEditing, setProductPfxEditing] = useState(false)

  const loadAll = useCallback(async () => {
    const [p, sys] = await Promise.all([getProduct(), listTemplates('amconfig')])
    setAmconfigs(sys)
    const pname = p.name || ''
    setProductName(pname)
    setProductInput(pname)
    if (!pname) { setSites([]); setRelunits({}); return }
    const s = await listSites(pname)
    setSites(s)
    const rmap = {}
    for (const site of s) rmap[site] = await listRelunits(pname, site)
    setRelunits(rmap)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    getDefaults().then(d => {
      const p = d.parsed?.product || ''
      setDefaults(d.parsed || {})
      setProductPfx(p)
      setProductPfxInput(p)
    })
  }, [])

  useEffect(() => {
    async function checkStages() {
      if (!product) return
      const map = {}
      for (const site of sites) {
        for (const rel of (relunits[site] || [])) {
          for (const stage of STAGES) {
            const d = await getStage(product, site, rel, stage)
            map[`${site}/${rel}/${stage}`] = d.exists
          }
        }
      }
      setEnabledStages(map)
    }
    checkStages()
  }, [product, sites, relunits])

  useEffect(() => {
    async function fetchMeta() {
      const { systemName, systemVersion } = stageForm
      if (!systemName || !systemVersion) {
        setStageForm(f => ({ ...f, chartName: '', chartSemver: '' }))
        return
      }
      const meta = await getChartMeta('amconfig', systemName, systemVersion)
      if (meta) {
        setStageForm(f => ({
          ...f,
          chartName: meta.name,
          chartSemver: String(meta.version),
        }))
      }
    }
    fetchMeta()
  }, [stageForm.systemName, stageForm.systemVersion])

  async function handleSetProduct() {
    if (!productInput.trim()) return
    await setProduct(product, productInput.trim())
    setEditProduct(false)
    await loadAll()
  }

  async function handleAddSite() {
    if (!addSiteVal.trim() || !product) return
    await createSite(product, addSiteVal.trim())
    setAddSiteVal(''); setAddSite(false)
    await loadAll()
  }

  async function handleDeleteSite(site) {
    if (!confirm(`Delete site "${site}" and all its content?`)) return
    await deleteSite(product, site)
    if (selection?.site === site) setSelection(null)
    await loadAll()
  }

  async function handleAddRelunit(site) {
    if (!addRelVal.trim()) return
    await createRelunit(product, site, addRelVal.trim())
    setAddRelunit(null); setAddRelVal('')
    await loadAll()
  }

  async function handleDeleteRelunit(site, relunit) {
    if (!confirm(`Delete relunit "${relunit}"?`)) return
    await deleteRelunit(product, site, relunit)
    if (selection?.site === site && selection?.relunit === relunit) setSelection(null)
    await loadAll()
  }

  async function selectStage(site, relunit, stage) {
    setSelection({ site, relunit, stage })
    setHelmOutput(''); setHelmOk(null)
    const d = await getStage(product, site, relunit, stage)
    const p = d.parsed || {}

    let amconfigName = ''
    let amconfigVersion = ''
    let chartName = ''
    const dep = d.chart?.parsed?.dependencies?.[0]
    if (dep?.repository) {
      const m = dep.repository.match(/templates\/amconfig\/([^/]+)\/([^/]+)$/)
      if (m) { amconfigName = m[1]; amconfigVersion = m[2] }
      chartName = dep.name || ''
    }

    const overrideKey = chartName || Object.keys(p)[0] || ''
    const overrides = p[overrideKey]
      ? objectToKvArray(p[overrideKey])
      : []

    setStageForm(f => ({
      ...f,
      systemName: amconfigName,
      systemVersion: amconfigVersion,
      chartName,
      chartSemver: dep?.version ? String(dep.version) : '',
      overrides,
    }))
  }

  async function handleToggleStage(site, relunit, stage, currentlyEnabled) {
    if (currentlyEnabled) {
      if (!confirm(`Disable stage ${stage}?`)) return
      await deleteStage(product, site, relunit, stage)
      if (selection?.site === site && selection?.relunit === relunit && selection?.stage === stage) {
        setSelection(null); setHelmOutput(''); setHelmOk(null)
      }
    } else {
      await saveStage(product, site, relunit, stage, {}, null)
      await selectStage(site, relunit, stage)
    }
    setEnabledStages(prev => ({ ...prev, [`${site}/${relunit}/${stage}`]: !currentlyEnabled }))
  }

  async function handleSaveStage() {
    if (!selection) return
    const { site, relunit, stage } = selection
    const { systemName, systemVersion, chartName, chartSemver, overrides } = stageForm

    const valData = buildStageValues(chartName || 'system', overrides)

    let chartData = null
    if (systemName && systemVersion && chartName) {
      chartData = buildStageChart(relunit, stage, chartName, systemVersion, systemName, systemVersion)
    }

    await saveStage(product, site, relunit, stage, valData, chartData)
    setStageStatus('Saved')
    setTimeout(() => setStageStatus(''), 2000)
  }

  async function handleRunHelm() {
    if (!selection || !product) return
    setHelmRunning(true)
    setHelmOutput('Running...')
    setHelmOk(null)
    const { site, relunit, stage } = selection
    const result = await runHelmRender(product, site, relunit, stage)
    setHelmRunning(false)
    setHelmOk(result.ok)
    setHelmOutput(result.output || '')
  }

  async function handleSaveProductPfx() {
    const updated = { ...defaults, product: productPfxInput.trim() }
    await saveDefaults(updated)
    setDefaults(updated)
    setProductPfx(productPfxInput.trim())
    setProductPfxEditing(false)
  }

  const systemVersions = stageForm.systemName ? (amconfigs[stageForm.systemName] || []) : []

  const systemRef = stageForm.systemName && stageForm.systemVersion
    ? `amconfig/${stageForm.systemName}/${stageForm.systemVersion}`
    : null

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={280} theme="light" style={{ borderRight: '1px solid #f0f0f0', overflowY: 'auto' }}>
        {/* Product */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0' }}>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Product
          </Text>
          {editingProduct ? (
            <Space.Compact style={{ marginTop: 6, width: '100%' }}>
              <Input size="small" value={productInput} autoFocus
                onChange={e => setProductInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSetProduct(); if (e.key === 'Escape') setEditProduct(false) }} />
              <Button size="small" type="primary" onClick={handleSetProduct}>OK</Button>
            </Space.Compact>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Text strong style={{ fontSize: 14 }}>
                {product || <Text type="secondary">— not set —</Text>}
              </Text>
              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditProduct(true)} />
            </div>
          )}
        </div>

        {/* Sites tree */}
        {product && (
          <>
            {sites.map(site => (
              <div key={site}>
                <div style={{ padding: '6px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space size={4}>
                    <FolderOutlined style={{ color: '#faad14' }} />
                    <Text>{site}</Text>
                  </Space>
                  <Space size={2}>
                    <Button type="text" size="small" icon={<PlusOutlined />}
                      onClick={() => { setAddRelunit(site); setAddRelVal('') }} />
                    <Button type="text" danger size="small" icon={<DeleteOutlined />}
                      onClick={() => handleDeleteSite(site)} />
                  </Space>
                </div>

                {addRelunit === site && (
                  <Space.Compact style={{ padding: '2px 14px 2px 28px', width: '100%' }}>
                    <Input size="small" value={addRelVal} placeholder="relunit name" autoFocus
                      onChange={e => setAddRelVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddRelunit(site); if (e.key === 'Escape') setAddRelunit(null) }} />
                    <Button size="small" type="primary" onClick={() => handleAddRelunit(site)}>Add</Button>
                  </Space.Compact>
                )}

                {(relunits[site] || []).map(rel => (
                  <div key={rel}>
                    <div style={{ padding: '4px 14px 4px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space size={4}>
                        <FolderOpenOutlined style={{ color: '#1677ff' }} />
                        <Text>{rel}</Text>
                      </Space>
                      <Button type="text" danger size="small" icon={<DeleteOutlined />}
                        onClick={() => handleDeleteRelunit(site, rel)} />
                    </div>

                    {STAGES.map(stage => {
                      const key = `${site}/${rel}/${stage}`
                      const enabled = enabledStages[key]
                      const isSelected = selection?.site === site && selection?.relunit === rel && selection?.stage === stage
                      return (
                        <div key={stage} style={{
                          padding: '3px 14px 3px 48px',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          background: isSelected ? '#e6f4ff' : undefined,
                        }}>
                          <Space size={6}
                            style={{ cursor: enabled ? 'pointer' : 'default' }}
                            onClick={() => enabled && selectStage(site, rel, stage)}>
                            <Badge status={enabled ? 'success' : 'default'} />
                            <Text style={{ color: enabled ? undefined : '#8c8c8c' }}>{stage}</Text>
                          </Space>
                          <Button
                            type="text"
                            size="small"
                            style={{ fontSize: 11, color: enabled ? '#ff4d4f' : '#52c41a' }}
                            onClick={() => handleToggleStage(site, rel, stage, !!enabled)}
                          >
                            {enabled ? 'off' : 'on'}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            ))}

            {addSite ? (
              <Space.Compact style={{ padding: '8px 14px', width: '100%' }}>
                <Input size="small" value={addSiteVal} placeholder="site name" autoFocus
                  onChange={e => setAddSiteVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddSite(); if (e.key === 'Escape') setAddSite(false) }} />
                <Button size="small" type="primary" onClick={handleAddSite}>Add</Button>
              </Space.Compact>
            ) : (
              <div style={{ padding: '8px 14px' }}>
                <Button type="dashed" size="small" icon={<PlusOutlined />}
                  onClick={() => { setAddSite(true); setAddSiteVal('') }}>Add Site</Button>
              </div>
            )}
          </>
        )}
      </Sider>

      <Content style={{ overflowY: 'auto', padding: 24 }}>
        {/* Product prefix settings */}
        <Card size="small" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Text strong>Alert Product Prefix</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>
              prefixes rendered resource names ({'{product}-{name}'})
            </Text>
          </div>
          {productPfxEditing ? (
            <Space.Compact>
              <Input size="small" value={productPfxInput} autoFocus placeholder="e.g. mysql"
                onChange={e => setProductPfxInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveProductPfx(); if (e.key === 'Escape') setProductPfxEditing(false) }} />
              <Button size="small" type="primary" onClick={handleSaveProductPfx}>Save</Button>
              <Button size="small" onClick={() => setProductPfxEditing(false)}>Cancel</Button>
            </Space.Compact>
          ) : (
            <Space>
              <code style={{ background: '#f5f5f5', padding: '3px 10px', borderRadius: 4, fontSize: 13 }}>
                {productPfx || '(none)'}
              </code>
              <Button size="small" onClick={() => { setProductPfxInput(productPfx); setProductPfxEditing(true) }}>
                Edit
              </Button>
            </Space>
          )}
        </Card>

        {!selection ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#8c8c8c' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🚀</div>
            <Text type="secondary">
              {!product
                ? 'Set a product name on the left to get started.'
                : 'Toggle a stage "on" then click it to edit.'}
            </Text>
          </div>
        ) : (
          <>
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong style={{ fontSize: 15 }}>
                  {product} / {selection.site} / {selection.relunit} / {selection.stage}
                </Text>
                {stageStatus && <Tag color="success">{stageStatus}</Tag>}
              </div>

              {systemRef && (
                <div style={{ marginBottom: 12 }}>
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>ref: </Text>
                  <Tag color="purple">{systemRef}</Tag>
                </div>
              )}

              <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
                Output: <code>gitops-deploy/{product}/{selection.site}/{selection.relunit}/{selection.stage}/</code>
              </Text>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>AM Config Template</Text>
                  <Select
                    value={stageForm.systemName || undefined}
                    onChange={val => setStageForm(f => ({ ...f, systemName: val, systemVersion: '', chartName: '', chartSemver: '' }))}
                    placeholder="— select amconfig —"
                    style={{ width: '100%' }}
                    options={Object.keys(amconfigs).map(n => ({ value: n, label: n }))}
                    allowClear
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Version</Text>
                  <Select
                    value={stageForm.systemVersion || undefined}
                    onChange={val => setStageForm(f => ({ ...f, systemVersion: val, chartName: '', chartSemver: '' }))}
                    placeholder="— select version —"
                    style={{ width: '100%' }}
                    options={systemVersions.map(v => ({ value: v, label: v }))}
                    allowClear
                  />
                </div>
              </div>

              {stageForm.chartName && stageForm.systemVersion && (
                <div style={{ marginTop: 12 }}>
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>Auto-generated Chart.yaml</Text>
                  <pre style={{
                    background: '#0f172a', color: '#7dd3fc', padding: 12, borderRadius: 6,
                    fontSize: 12, lineHeight: 1.6, marginTop: 4, overflow: 'auto',
                  }}>
                    {[
                      `apiVersion: v2`,
                      `name: ${selection.relunit}-${selection.stage}`,
                      `version: 0.1.0`,
                      `dependencies:`,
                      `  - name: ${stageForm.chartName}`,
                      `    version: "${stageForm.chartSemver}"`,
                      `    repository: "file://../../../../../templates/amconfig/${stageForm.systemName}/${stageForm.systemVersion}"`,
                    ].join('\n')}
                  </pre>
                </div>
              )}
            </Card>

            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text strong>Deploy Override Values</Text>
                {stageForm.chartName && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    scoped under <code>{stageForm.chartName}:</code>
                  </Text>
                )}
              </div>
              <KVEditor
                rows={stageForm.overrides}
                onChange={rows => setStageForm(f => ({ ...f, overrides: rows }))}
                keyPlaceholder="key" valuePlaceholder="value"
              />
            </Card>

            <Space style={{ marginBottom: 16 }}>
              <Button type="primary" onClick={handleSaveStage}
                disabled={!stageForm.systemName || !stageForm.systemVersion}>
                Save values.yaml + Chart.yaml
              </Button>
              <Button onClick={handleRunHelm} disabled={helmRunning}>
                {helmRunning ? '⏳ Running…' : '▶ Run helm template'}
              </Button>
              <Button danger
                onClick={() => handleToggleStage(selection.site, selection.relunit, selection.stage, true)}>
                Disable Stage
              </Button>
            </Space>

            {helmOutput && (
              <Card size="small">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Text strong>Helm Output</Text>
                  {helmOk === true  && <Tag color="success">✓ success</Tag>}
                  {helmOk === false && <Tag color="error">✗ error</Tag>}
                </div>
                <pre style={{
                  maxHeight: 500, overflowY: 'auto', fontSize: 12,
                  background: '#0f172a', borderRadius: 6, padding: 12,
                  color: helmOk === false ? '#fca5a5' : '#a5f3fc',
                  whiteSpace: 'pre',
                }}>
                  {helmOutput}
                </pre>
              </Card>
            )}
          </>
        )}
      </Content>
    </Layout>
  )
}
