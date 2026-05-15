import { useState, useEffect, useCallback } from 'react'
import { Layout, Button, Modal, Typography, Empty } from 'antd'
import { SaveOutlined, EyeOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import DeploymentSelector from '../components/DeploymentSelector'
import AlertTable from '../components/AlertTable'
import { schemaToVars } from '../utils/schemaUtils'
import {
  listCharts, createChart,
  getChartInfo,
  listDeployments, getDeployment, saveDeployment, cloneDeployment,
  renderDeployment
} from '../utils/chartApi'

const { Sider, Content } = Layout
const { Title, Text } = Typography

export default function AlertUserView() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [deployments, setDeployments] = useState([])
  const [activeDeployment, setActiveDeployment] = useState(null)
  const [vars, setVars] = useState([])
  const [rows, setRows] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')
  const [chartDescription, setChartDescription] = useState('')

  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0) setActiveChart(c[0].name)
    })
  }, [])

  useEffect(() => {
    if (!activeChart) return
    setActiveDeployment(null)
    setRows([])
    setDirty(false)
    Promise.all([
      getChartInfo(activeChart),
      listDeployments(activeChart)
    ]).then(([info, deps]) => {
      setVars(schemaToVars(info.schema))
      setChartDescription(info.chartMeta?.description || '')
      setDeployments(deps)
    })
  }, [activeChart])

  useEffect(() => {
    if (!activeChart || !activeDeployment) return
    getDeployment(activeChart, activeDeployment).then(data => {
      const parsed = data.parsed || {}
      setRows(parsed.instances || [])
      setDirty(false)
    })
  }, [activeChart, activeDeployment])

  async function handleSave() {
    if (!activeChart || !activeDeployment) return
    await saveDeployment(activeChart, activeDeployment, { instances: rows })
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
  }

  async function handlePreview() {
    if (!activeChart || !activeDeployment) return
    if (dirty) await handleSave()
    const result = await renderDeployment(activeChart, activeDeployment)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewOpen(true)
  }

  async function handleCreateDeployment(name) {
    if (!activeChart) return
    await saveDeployment(activeChart, name, { instances: [] })
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
    setActiveDeployment(name)
  }

  async function handleClone(source, newName) {
    if (!activeChart) return
    await cloneDeployment(activeChart, source, newName)
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
    setActiveDeployment(newName)
  }

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={280} theme="light" style={{ borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ChartSelector charts={charts} activeChart={activeChart} onSelect={setActiveChart} onCreate={createChart} />
        <div style={{ borderTop: '1px solid #f0f0f0' }}>
          <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af' }}>
            Deployments
          </div>
          <DeploymentSelector
            deployments={deployments}
            activeDeployment={activeDeployment}
            onSelect={setActiveDeployment}
            onCreate={handleCreateDeployment}
            onClone={handleClone}
          />
        </div>
      </Sider>
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
        {activeChart && activeDeployment ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
              <Title level={4} style={{ margin: 0 }}>{activeChart} / {activeDeployment}</Title>
              {chartDescription && <Text type="secondary" style={{ fontSize: 13 }}>{chartDescription}</Text>}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              <AlertTable
                vars={vars}
                rows={rows}
                onUpdate={updated => { setRows(updated); setDirty(true) }}
                onDelete={idx => { setRows(rows.filter((_, i) => i !== idx)); setDirty(true) }}
                onAdd={newRow => { setRows([...rows, newRow]); setDirty(true) }}
              />
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>
              {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
            </div>
            <Modal title="Rendered PrometheusRule" open={previewOpen} onCancel={() => setPreviewOpen(false)}
              footer={null} width={800}>
              <pre style={{
                background: '#0f172a', color: '#7dd3fc', padding: 16, borderRadius: 8,
                fontSize: 12, fontFamily: 'monospace', maxHeight: 500, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all'
              }}>
                {previewYaml || 'No output'}
              </pre>
            </Modal>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }}
            description={activeChart ? 'Select a deployment from the sidebar' : 'Select a chart to get started'} />
        )}
      </Content>
    </Layout>
  )
}
