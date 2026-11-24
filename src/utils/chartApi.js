import { apiFetch } from '../lib/apiFetch.js'

const BASE = '/api/v2'

// ─── User ───────────────────────────────────────────────────────────────────

export async function getUserInfo() {
  const res = await apiFetch(`${BASE}/user`)
  if (!res.ok) return { user: null, logoutUrl: null }
  return res.json()
}

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
  if (!res.ok) return { failed: true, ...(await res.json().catch(() => ({}))) }
  return res.json()
}

export async function deleteChart(name) {
  const res = await apiFetch(`${BASE}/charts/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  })
  // A refusal comes back as it is: a chart still in use is a 409 that lists
  // the deployments (#177).
  if (!res.ok) return { failed: true, ...(await res.json().catch(() => ({}))) }
  return res.json()
}

// ─── Templates / Chart Info ──────────────────────────────────────────────────

// A chart that cannot be opened (a file of it that cannot be read) says
// why: `{ failed: true, error }`, never an empty chart to save over.
export async function getChartInfo(chart) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}`)
  if (!res.ok) return { failed: true, ...(await res.json().catch(() => ({ error: `the server answered ${res.status}` }))) }
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


/**
 * Save a chart's whole rules/*.yaml source in one request; the server
 * regenerates values.schema.json and every templates/*.yaml from it and writes
 * the lot all-or-nothing. `files` is { '<name>.yaml': text }.
 *
 * A breaking change comes back as 409 with `breaking` / `notices` / `added` /
 * `deployments` (each `readonly`): `blocked`. Any other 409 is `failed`, with
 * the server's `error` and `findings`. Parse errors and failed rule checks come
 * back as 400 with `errors` / `findings`. A migration that would write values
 * a save refuses comes back `refused` with `migrationProblems` (#176). `migration` ({ groups?, columns?,
 * dropped? }) with confirmBreaking rewrites every affected deployment's values.
 */
export async function saveChartRules(chart, files, confirmBreaking = false, migration = undefined) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, confirmBreaking, migration })
  })
  if (res.status === 409) {
    const body = await res.json()
    // Only a 409 that lists the breaking changes is the breaking-change
    // dialog. A migration that would write values a save refuses (#176) is
    // a refusal of its own; any other 409 (rules/ gone, a Template that
    // would not render, a file that cannot be read) is a save that failed,
    // with its error and findings.
    if (Array.isArray(body.breaking)) return { blocked: true, ...body }
    if (body.migrationProblems) return { refused: true, ...body }
    return { failed: true, ...body }
  }
  if (res.status === 400) return { invalid: true, ...(await res.json()) }
  // Anything else — "Generation failed", "Deployment migration failed" — keeps
  // its message, so the editor can say what went wrong instead of nothing.
  if (!res.ok) return { failed: true, ...(await res.json().catch(() => ({}))) }
  return res.json()
}

/** Preview what a breaking change + mapping does to each deployment. */
export async function migrationPreview(chart, files, migration) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/migration-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, migration })
  })
  if (!res.ok) return { deployments: [] }
  return res.json()
}

export async function listChartDeployments(chart) {
  const res = await apiFetch(`${BASE}/templates/${encodeURIComponent(chart)}/deployments`)
  if (!res.ok) return { deployments: [] }
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
  // A refusal says why: `{ ok: false, error }`.
  if (!res.ok) return { ok: false, ...(await res.json().catch(() => ({ error: `the server answered ${res.status}` }))) }
  return res.json()
}

// ─── Deployments ─────────────────────────────────────────────────────────────

export async function listDeployments(chart, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}${params}`)
  if (!res.ok) return []
  return res.json()
}

// Not there (404) is a deployment with nothing yet; any other refusal — a
// values.yaml that cannot be read — says why: `{ failed, status, error }`,
// never an empty table to save over.
export async function getDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`)
  if (!res.ok) return { failed: true, status: res.status, ...(await res.json().catch(() => ({ error: `the server answered ${res.status}` }))) }
  return res.json()
}

// `version` is what the page was loaded from: a deployment changed since is
// refused with { changed: true } (#102).
export async function saveDeployment(chart, deployment, values, folder, version) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values, ...(version ? { version } : {}) })
  })
  // A refusal carries { error, problems } — which cells, and why.
  if (!res.ok) return { ok: false, ...(await res.json().catch(() => ({}))) }
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
  // A refusal says why, as the server put it.
  if (!res.ok) return { error: (await res.json().catch(() => ({}))).error || `HTTP ${res.status}` }
  return res.json()
}

// ─── Routing (#92, #93) ─────────────────────────────────────────────────────

const routingUrl = (chart, deployment, folder) =>
  `${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}/routing?folder=${encodeURIComponent(folder)}`

// { text, errors, stale }; null when the deployment has no routing.yaml;
// { error, file, unreadable } when it could not be read, or when its
// AlertmanagerConfig is there without a routing.yaml (`file` names it, and
// `unreadable` is left out).
export async function getRouting(chart, deployment, folder) {
  const res = await apiFetch(routingUrl(chart, deployment, folder))
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { error: body.error || 'Could not read routing', ...(body.file ? { file: body.file } : {}), ...(body.unreadable ? { unreadable: true } : {}) }
  }
  return res.json()
}

// `routing` is routing.yaml's text or its table. A refusal carries
// { error, problems }, as saveDeployment's does.
export async function saveRouting(chart, deployment, folder, routing) {
  const res = await apiFetch(routingUrl(chart, deployment, folder), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routing })
  })
  if (!res.ok) return { ok: false, ...(await res.json().catch(() => ({}))) }
  return res.json()
}

export async function removeRouting(chart, deployment, folder) {
  const res = await apiFetch(routingUrl(chart, deployment, folder), { method: 'DELETE' })
  if (!res.ok) return { ok: false, ...(await res.json().catch(() => ({}))) }
  return res.json()
}

// ─── Shared notification configs (#123) ──────────────────────────────────────

const SHARED_URL = `${BASE}/routing/shared`

// { file, exists, text, configs, errors, usage, stale, dirProblem }, or { error }.
export async function getSharedConfigs() {
  const res = await apiFetch(SHARED_URL)
  if (!res.ok) return { error: (await res.json().catch(() => ({}))).error || 'Could not read the shared configs' }
  return res.json()
}

const sharedWrite = async (url, method, body) => {
  const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  if (!res.ok) return { ok: false, ...(await res.json().catch(() => ({}))) }
  return { ok: true, ...(await res.json()) }
}

// `shared` is { configs }. A refusal carries { error, problems | failed | usedBy }.
export const saveSharedConfigs = shared => sharedWrite(SHARED_URL, 'PUT', { shared })
export const renameSharedConfig = (from, to) => sharedWrite(`${SHARED_URL}/rename`, 'POST', { from, to })
// { regenerated, failed }
export const regenerateShared = () => sharedWrite(`${SHARED_URL}/regenerate`, 'POST')

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

export async function getFolderTree(parentPath = '') {
  const query = parentPath ? `?path=${encodeURIComponent(parentPath)}` : ''
  const res = await apiFetch(`${BASE}/folders/tree${query}`)
  if (!res.ok) return []
  return res.json()
}

// Recursive, on-demand scan of every deployment in the repo — used only to
// populate the Sync to/from modals' candidate lists (not the lazy tree).
// `chart`: each folder's _common is looked up for that Template (#103).
export async function listAllDeployments(chart) {
  const res = await apiFetch(`${BASE}/folders/deployments${chart ? `?chart=${encodeURIComponent(chart)}` : ''}`)
  if (!res.ok) return []
  return res.json()
}

export async function initDeploymentFolder(folder, chart) {
  const res = await apiFetch(`${BASE}/folders/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, chart })
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { error: body.error || `Could not create the deployment (HTTP ${res.status})` }
  }
  return res.json()
}

// ─── A folder's _common (#101) ──────────────────────────────────────────────

// What making (`{ action: 'create', folder, chart }`) or removing
// (`{ action: 'delete', path }`) a _common changes: the plan, or `{ error }`.
export async function getCommonPlan(query) {
  const res = await apiFetch(`${BASE}/folders/common/plan?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`)
  const body = await res.json().catch(() => ({}))
  return res.ok ? body : { error: body.error || `HTTP ${res.status}`, problems: body.problems || [] }
}

// Writes it: `expected` is the plan's files, as shown.
export async function applyCommon(query, expected) {
  const res = await apiFetch(`${BASE}/folders/common`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...query, expected }),
  })
  // An answer that cannot be read throws (AnswerCutOff): whether it was
  // made is not known, and the dialog says so.
  if (res.ok) return res.json()
  const body = await res.json().catch(() => ({}))
  return { error: body.error || `HTTP ${res.status}`, problems: body.problems || [], plan: body.plan }
}

// The deployments that inherit from a _common, with where each group comes from.
export async function getCommonUsers(commonPath) {
  const res = await apiFetch(`${BASE}/folders/common/users?path=${encodeURIComponent(commonPath)}`)
  if (!res.ok) return []
  return res.json()
}

// ─── Sync ───────────────────────────────────────────────────────────────────

// What a read of sync.yaml that failed says: `{ failed, error, file? }`. A
// sync.yaml that cannot be read is not "no syncs" (the server says so too).
async function syncReadFailure(res) {
  const body = await res.json().catch(() => ({}))
  return { failed: true, error: body.error || `sync.yaml could not be read (the server answered ${res.status})`, ...(body.file ? { file: body.file } : {}) }
}

// Full registry in one call — used by the deployment tree to badge every row
// without a per-item request. `{ syncs }`, or `{ failed, error, file? }`.
export async function getSyncRegistry() {
  const res = await apiFetch(`${BASE}/sync`)
  if (!res.ok) return syncReadFailure(res)
  return res.json()
}

export async function getSyncTargets(source) {
  const res = await apiFetch(`${BASE}/sync?source=${encodeURIComponent(source)}`)
  if (!res.ok) return { source, targets: [] }
  return res.json()
}

// `{ target, source }` (source null: not a sync target), or
// `{ target, failed, error, file? }`: whether it is one is not known.
export async function getSyncSource(target) {
  const res = await apiFetch(`${BASE}/sync?target=${encodeURIComponent(target)}`)
  if (!res.ok) return { target, ...(await syncReadFailure(res)) }
  return res.json()
}

export async function createSync(source, target) {
  const res = await apiFetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target })
  })
  const body = await res.json().catch(() => ({}))
  // A source a values save would refuse is refused here too, with its cells.
  if (!res.ok) return { ok: false, error: body.error || 'Sync failed', problems: body.problems }
  return body
}

export async function unlinkSync(target) {
  const res = await apiFetch(`${BASE}/sync`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: body.error || 'Unlink failed' }
  return body
}

export async function cloneChart(chart, newName, migration) {
  const res = await apiFetch(`${BASE}/charts/${encodeURIComponent(chart)}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName, migration })
  })
  if (!res.ok) return { error: (await res.json().catch(() => ({}))).error || 'Clone failed' }
  return res.json()
}
