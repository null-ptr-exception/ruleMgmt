import { apiFetch } from '../lib/apiFetch.js'

const BASE = '/api/v2/zones'

export async function listZones() {
  const res = await apiFetch(BASE)
  if (!res.ok) return []
  return res.json()
}

export async function createZone(name) {
  const res = await apiFetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Create zone failed')
  return data
}

export async function deleteZone(name) {
  const res = await apiFetch(`${BASE}/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) return {}
  return res.json()
}

export async function getZone(name) {
  const res = await apiFetch(`${BASE}/${encodeURIComponent(name)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveZoneValues(name, values) {
  const res = await apiFetch(`${BASE}/${encodeURIComponent(name)}/values`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveZoneBindings(name, bindings) {
  const res = await apiFetch(`${BASE}/${encodeURIComponent(name)}/bindings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bindings })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function renderZoneBinding(zoneName, chart, deployment) {
  const res = await apiFetch(
    `/api/v2/render/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}?zone=${encodeURIComponent(zoneName)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  )
  if (!res.ok) return { ok: false, error: 'Request failed' }
  return res.json()
}
