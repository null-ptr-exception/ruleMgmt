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

// ─── Templates ───────────────────────────────────────────────────────────────

export async function listChartTemplates(chart) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}`)
  if (!res.ok) return []
  return res.json()
}

export async function getChartTemplate(chart, template) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartTemplate(chart, template, content, meta) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, meta })
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
