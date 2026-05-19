import { apiFetch } from '../lib/apiFetch.js'

const BASE = '/api/v2'

// ─── Charts ──────────────────────────────────────────────────────────────────

export async function listCharts() {
  const res = await apiFetch(`${BASE}/charts`)
  if (!res.ok) return []
  return res.json()
}

export async function createChart(name) {
  const res = await apiFetch(`${BASE}/charts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function deleteChart(name) {
  const res = await apiFetch(`${BASE}/charts/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  })
  if (!res.ok) return {}
  return res.json()
}

// ─── Templates / Chart Info ──────────────────────────────────────────────────

export async function getChartInfo(chart) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function getChartTemplateFile(chart, template) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartTemplateFile(chart, template, content) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function deleteChartTemplate(chart, template) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`, {
    method: 'DELETE'
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartSchema(chart, schema) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartValues(chart, values) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/values`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartMeta(chart, chartMeta) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/chart-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chartMeta })
  })
  if (!res.ok) return {}
  return res.json()
}

// ─── Deployments ─────────────────────────────────────────────────────────────

export async function listDeployments(chart, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}${params}`)
  if (!res.ok) return []
  return res.json()
}

export async function getDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveDeployment(chart, deployment, values, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function cloneDeployment(chart, source, newName, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(source)}/clone${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function deleteDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, {
    method: 'DELETE'
  })
  if (!res.ok) return {}
  return res.json()
}

// ─── Render ──────────────────────────────────────────────────────────────────

export async function renderDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/render/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  if (!res.ok) return {}
  return res.json()
}

// ─── Folders ────────────────────────────────────────────────────────────────

export async function listFolders() {
  const res = await apiFetch(`${BASE}/folders`)
  if (!res.ok) return []
  return res.json()
}

export async function createFolder(folderPath) {
  const res = await apiFetch(`${BASE}/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function initDeploymentFolder(folder, chart) {
  const res = await apiFetch(`${BASE}/folders/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, chart })
  })
  if (!res.ok) return {}
  return res.json()
}
