import { expect } from '@playwright/test'

// Deleting a chart is refused while a deployment uses it (#177), so a spec
// that clears its chart clears the chart's deployments first. A delete that
// does not succeed fails here, not later as "chart already exists".
export async function removeChart(request, chart) {
  const url = `/api/v2/charts/${chart}`
  const res = await request.delete(url)
  if (res.status() !== 409) {
    expect(res.ok(), `deleting chart ${chart}: ${res.status()}`).toBeTruthy()
    return res
  }
  const { deployments = [] } = await res.json()
  for (const d of deployments) {
    // A folder deployment is addressed by its folder; a flat file by its name.
    const flat = d.path.endsWith('-values.yaml')
    const query = flat ? '' : `?folder=${encodeURIComponent(d.path)}`
    const gone = await request.delete(`/api/v2/deployments/${chart}/${encodeURIComponent(d.deployment)}${query}`)
    expect(gone.ok(), `deleting ${d.path} before chart ${chart}`).toBeTruthy()
  }
  const again = await request.delete(url)
  expect(again.ok(), `deleting chart ${chart} after its deployments: ${again.status()}`).toBeTruthy()
  return again
}
