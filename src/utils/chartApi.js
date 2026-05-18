const BASE = '/api/v2'

// ─── Charts ──────────────────────────────────────────────────────────────────

export async function listCharts() {
  const res = await fetch(`${BASE}/charts`)
  if (!res.ok) return []
  return res.json()
}

export async function createChart(name) {
  const res = await fetch(`${BASE}/charts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function deleteChart(name) {
  const res = await fetch(`${BASE}/charts/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  })
  if (!res.ok) return {}
  return res.json()
}

// ─── Templates / Chart Info ──────────────────────────────────────────────────

export async function getChartInfo(chart) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function getChartTemplateFile(chart, template) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartTemplateFile(chart, template, content) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function deleteChartTemplate(chart, template) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`, {
    method: 'DELETE'
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartSchema(chart, schema) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartValues(chart, values) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/values`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartMeta(chart, chartMeta) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/chart-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chartMeta })
  })
  if (!res.ok) return {}
  return res.json()
}

// ─── Deployments ─────────────────────────────────────────────────────────────

export async function listDeployments(chart) {
  const res = await fetch(`${BASE}/deployments/${encodeURIComponent(chart)}`)
  if (!res.ok) return []
  return res.json()
}

export async function getDeployment(chart, deployment) {
  const res = await fetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveDeployment(chart, deployment, values) {
  const res = await fetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function cloneDeployment(chart, source, newName) {
  const res = await fetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(source)}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function deleteDeployment(chart, deployment) {
  const res = await fetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}`, {
    method: 'DELETE'
  })
  if (!res.ok) return {}
  return res.json()
}

// ─── Presets ─────────────────────────────────────────────────────────────────

export async function listPresets() {
  const res = await fetch(`${BASE}/presets`)
  if (!res.ok) return []
  return res.json()
}

// ─── Import ──────────────────────────────────────────────────────────────────

export async function parseTemplate(templateYaml) {
  const res = await fetch(`${BASE}/import/parse-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateYaml }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Parse failed')
  return data
}

export async function importPreview(payload) {
  const res = await fetch(`${BASE}/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Preview failed')
  return data
}

export async function saveImport(payload) {
  const res = await fetch(`${BASE}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Import failed')
  return data
}

// ─── Render ──────────────────────────────────────────────────────────────────

export async function renderDeployment(chart, deployment) {
  const res = await fetch(`${BASE}/render/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  if (!res.ok) return {}
  return res.json()
}
