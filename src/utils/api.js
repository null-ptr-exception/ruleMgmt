import { apiFetch } from '../lib/apiFetch.js'

const BASE = '/api'

// ─── Templates ───────────────────────────────────────────────────────────────

export async function listTemplates(type) {
  const res = await apiFetch(`${BASE}/templates/${type}`)
  if (!res.ok) return {}
  return res.json()
}

export async function getTemplate(type, name, version) {
  const res = await apiFetch(`${BASE}/templates/${type}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`)
  if (!res.ok) return null
  return res.json()
}

export async function saveTemplate(type, name, version, data) {
  const res = await apiFetch(`${BASE}/templates/${type}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  })
  return res.json()
}

export async function deleteTemplate(type, name, version) {
  const res = await apiFetch(`${BASE}/templates/${type}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    method: 'DELETE'
  })
  return res.json()
}

// ─── Gitops ──────────────────────────────────────────────────────────────────

export async function getProduct() {
  const res = await apiFetch(`${BASE}/gitops/product`)
  return res.json()
}

export async function setProduct(oldName, newName) {
  const res = await apiFetch(`${BASE}/gitops/product`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName })
  })
  return res.json()
}

export async function listSites(product) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/sites`)
  return res.json()
}

export async function createSite(product, name) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  return res.json()
}

export async function deleteSite(product, site) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/${encodeURIComponent(site)}`, {
    method: 'DELETE'
  })
  return res.json()
}

export async function listRelunits(product, site) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/${encodeURIComponent(site)}/relunits`)
  return res.json()
}

export async function createRelunit(product, site, name) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/${encodeURIComponent(site)}/relunits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  return res.json()
}

export async function deleteRelunit(product, site, relunit) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/${encodeURIComponent(site)}/${encodeURIComponent(relunit)}`, {
    method: 'DELETE'
  })
  return res.json()
}

export async function getStage(product, site, relunit, stage) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/${encodeURIComponent(site)}/${encodeURIComponent(relunit)}/${stage}`)
  return res.json()
}

export async function saveStage(product, site, relunit, stage, data, chartData = null) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/${encodeURIComponent(site)}/${encodeURIComponent(relunit)}/${stage}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, chartData })
  })
  return res.json()
}

export async function deleteStage(product, site, relunit, stage) {
  const res = await apiFetch(`${BASE}/gitops/${encodeURIComponent(product)}/${encodeURIComponent(site)}/${encodeURIComponent(relunit)}/${stage}`, {
    method: 'DELETE'
  })
  return res.json()
}

// ─── Chart metadata (generic) ─────────────────────────────────────────────────

export async function getChartMeta(type, name, version) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(type)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/chartmeta`)
  if (!res.ok) return null
  return res.json()
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export async function getDefaults() {
  const res = await apiFetch(`${BASE}/defaults`)
  return res.json()
}

export async function saveDefaults(data) {
  const res = await apiFetch(`${BASE}/defaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  })
  return res.json()
}

// ─── Metrics dictionary ───────────────────────────────────────────────────────

export async function getMetricsDict() {
  const res = await apiFetch(`${BASE}/metrics-dict`)
  return res.json()
}

export async function saveMetricsDict(metrics) {
  const res = await apiFetch(`${BASE}/metrics-dict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metrics }),
  })
  return res.json()
}

// ─── Import ───────────────────────────────────────────────────────────────────

export async function importPrometheusRules(scanPath = '') {
  const qs = scanPath ? `?dir=${encodeURIComponent(scanPath)}` : ''
  const res = await apiFetch(`${BASE}/import/prometheus-rules${qs}`)
  if (!res.ok) return { groups: [] }
  return res.json()
}

// ─── Route pruning ───────────────────────────────────────────────────────────

export async function pruneRoutesAPI(routeRules, routeMatchers) {
  const res = await apiFetch(`${BASE}/prune-routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeRules, routeMatchers }),
  })
  if (!res.ok) return null
  return res.json()  // { routeRules: [...nested...], stats: { before, after } }
}

// ─── Helm render ──────────────────────────────────────────────────────────────

export async function runHelmRender(product, site, relunit, stage) {
  const res = await apiFetch(
    `${BASE}/helm/render/${encodeURIComponent(product)}/${encodeURIComponent(site)}/${encodeURIComponent(relunit)}/${stage}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  )
  return res.json()
}
