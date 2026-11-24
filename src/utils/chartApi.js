import { apiFetch, AnswerCutOff, cutOffMessage } from '../lib/apiFetch.js'

const BASE = '/api/v2'

// ─── Sending a request, reading its answer ──────────────────────────────────

// Every function below asks `read` and gets one of three answers:
//   { kind: 'ok', status, body }               a 2xx and its body
//   { kind: 'refused', status, body, error }   a 4xx/5xx with a JSON body;
//                                              `error` is its reason, if it says one
//   { kind: 'unread', status, error, cutOff? } no answer that can be read: the
//                                              network failed (status 0), or the
//                                              body is not JSON (`cutOff` is the
//                                              AnswerCutOff, #147)
// Each function then says what that answer is to its callers.

// How a refusal's body says why. A refusal of another shape is one more
// line here (for instance `body => body.message`).
const REASONS = [
  body => body.error,
]
const reasonOf = body => REASONS.map(reason => reason(body)).find(r => typeof r === 'string')

async function read(path, init) {
  const res = await apiFetch(path, init)
  // apiFetch stands in for a request that never got an answer.
  if (res.status === 0) {
    return { kind: 'unread', status: 0, error: (await res.json()).error }
  }
  let body
  try {
    body = await res.json()
  } catch (err) {
    if (!(err instanceof AnswerCutOff)) throw err
    return { kind: 'unread', status: res.status, error: cutOffMessage(err), cutOff: err }
  }
  if (res.ok) return { kind: 'ok', status: res.status, body }
  const refusal = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  return { kind: 'refused', status: res.status, body: refusal, error: reasonOf(refusal) }
}

// A 2xx whose body cannot be read throws its AnswerCutOff, as res.json()
// does: main.jsx says it, for every caller that does not.
async function answer(path, init) {
  const a = await read(path, init)
  if (a.cutOff && a.status >= 200 && a.status < 300) throw a.cutOff
  return a
}

const sent = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

// What a failed answer carried: the refusal's body, or, when there was none
// to read, the network's error (a body that is not JSON carries nothing).
const carried = a => (a.kind === 'refused' ? a.body : a.status === 0 ? { error: a.error } : {})

// ─── User ───────────────────────────────────────────────────────────────────

export async function getUserInfo() {
  const a = await answer(`${BASE}/user`)
  return a.kind === 'ok' ? a.body : { user: null, logoutUrl: null }
}

// ─── Charts ──────────────────────────────────────────────────────────────────

export async function listCharts() {
  const a = await answer(`${BASE}/charts`)
  return a.kind === 'ok' ? a.body : []
}

export async function createChart(name) {
  const a = await answer(`${BASE}/charts`, sent('POST', { name }))
  return a.kind === 'ok' ? a.body : { failed: true, ...carried(a) }
}

export async function deleteChart(name) {
  const a = await answer(`${BASE}/charts/${encodeURIComponent(name)}`, { method: 'DELETE' })
  // A refusal comes back as it is: a chart still in use is a 409 that lists
  // the deployments (#177).
  return a.kind === 'ok' ? a.body : { failed: true, ...carried(a) }
}

// ─── Templates / Chart Info ──────────────────────────────────────────────────

// A chart that cannot be opened (a file of it that cannot be read) says
// why: `{ failed: true, error }`, never an empty chart to save over.
export async function getChartInfo(chart) {
  const a = await answer(`${BASE}/templates/${encodeURIComponent(chart)}`)
  if (a.kind === 'ok') return a.body
  return { failed: true, ...(a.cutOff ? { error: `the server answered ${a.status}` } : carried(a)) }
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
  const a = await answer(`${BASE}/templates/${encodeURIComponent(chart)}/rules`, sent('POST', { files, confirmBreaking, migration }))
  if (a.kind === 'ok') return a.body
  if (a.kind === 'refused' && a.status === 409) {
    // Only a 409 that lists the breaking changes is the breaking-change
    // dialog. A migration that would write values a save refuses (#176) is
    // a refusal of its own; any other 409 (rules/ gone, a Template that
    // would not render, a file that cannot be read) is a save that failed,
    // with its error and findings.
    if (Array.isArray(a.body.breaking)) return { blocked: true, ...a.body }
    if (a.body.migrationProblems) return { refused: true, ...a.body }
    return { failed: true, ...a.body }
  }
  if (a.kind === 'refused' && a.status === 400) return { invalid: true, ...a.body }
  // Anything else — "Generation failed", "Deployment migration failed" — keeps
  // its message, so the editor can say what went wrong instead of nothing.
  return { failed: true, ...carried(a) }
}

/** Preview what a breaking change + mapping does to each deployment. */
export async function migrationPreview(chart, files, migration) {
  const a = await answer(`${BASE}/templates/${encodeURIComponent(chart)}/migration-preview`, sent('POST', { files, migration }))
  return a.kind === 'ok' ? a.body : { deployments: [] }
}

export async function saveChartMeta(chart, chartMeta) {
  const a = await answer(`${BASE}/templates/${encodeURIComponent(chart)}/chart-meta`, sent('POST', { chartMeta }))
  if (a.kind === 'ok') return a.body
  // A refusal says why: `{ ok: false, error }`.
  return { ok: false, ...(a.cutOff ? { error: `the server answered ${a.status}` } : carried(a)) }
}

// ─── Deployments ─────────────────────────────────────────────────────────────

const deploymentUrl = (chart, deployment, folder) =>
  `${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`

// Not there (404) is a deployment with nothing yet; any other refusal — a
// values.yaml that cannot be read — says why: `{ failed, status, error }`,
// never an empty table to save over.
export async function getDeployment(chart, deployment, folder) {
  const a = await answer(deploymentUrl(chart, deployment, folder))
  if (a.kind === 'ok') return a.body
  return { failed: true, status: a.status, ...(a.cutOff ? { error: `the server answered ${a.status}` } : carried(a)) }
}

// `version` is what the page was loaded from: a deployment changed since is
// refused with { changed: true } (#102).
export async function saveDeployment(chart, deployment, values, folder, version) {
  const a = await read(deploymentUrl(chart, deployment, folder), sent('POST', { values, ...(version ? { version } : {}) }))
  if (a.kind === 'ok') return a.body
  // A refusal carries { error, problems } — which cells, and why. An answer
  // that cannot be read (a proxy's error page, a body cut off) may follow a
  // save that was made: `{ ok: false, unknown: true, error }` says that it
  // is not known.
  if (a.cutOff) return { ok: false, unknown: true, error: a.error }
  return { ok: false, ...carried(a) }
}

export async function deleteDeployment(chart, deployment, folder) {
  const a = await answer(deploymentUrl(chart, deployment, folder), { method: 'DELETE' })
  if (a.kind === 'ok') return a.body
  // A refusal says why, as the server put it.
  return { error: carried(a).error || `HTTP ${a.status}` }
}

// ─── Routing (#92, #93) ─────────────────────────────────────────────────────

const routingUrl = (chart, deployment, folder) =>
  `${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}/routing?folder=${encodeURIComponent(folder)}`

// { text, errors, stale }; null when the deployment has no routing.yaml;
// { error, file, unreadable } when it could not be read, or when its
// AlertmanagerConfig is there without a routing.yaml (`file` names it, and
// `unreadable` is left out).
export async function getRouting(chart, deployment, folder) {
  const a = await answer(routingUrl(chart, deployment, folder))
  if (a.kind === 'ok') return a.body
  if (a.status === 404) return null
  const body = carried(a)
  return { error: body.error || 'Could not read routing', ...(body.file ? { file: body.file } : {}), ...(body.unreadable ? { unreadable: true } : {}) }
}

// `routing` is routing.yaml's text or its table. A refusal carries
// { error, problems }, as saveDeployment's does.
export async function saveRouting(chart, deployment, folder, routing) {
  const a = await answer(routingUrl(chart, deployment, folder), sent('PUT', { routing }))
  return a.kind === 'ok' ? a.body : { ok: false, ...carried(a) }
}

export async function removeRouting(chart, deployment, folder) {
  const a = await answer(routingUrl(chart, deployment, folder), { method: 'DELETE' })
  return a.kind === 'ok' ? a.body : { ok: false, ...carried(a) }
}

// ─── Shared notification configs (#123) ──────────────────────────────────────

const SHARED_URL = `${BASE}/routing/shared`

// { file, exists, text, configs, errors, usage, stale, dirProblem }, or { error }.
export async function getSharedConfigs() {
  const a = await answer(SHARED_URL)
  return a.kind === 'ok' ? a.body : { error: carried(a).error || 'Could not read the shared configs' }
}

const sharedWrite = async (url, method, body) => {
  const a = await answer(url, sent(method, body))
  return a.kind === 'ok' ? { ok: true, ...a.body } : { ok: false, ...carried(a) }
}

// `shared` is { configs }. A refusal carries { error, problems | failed | usedBy }.
export const saveSharedConfigs = shared => sharedWrite(SHARED_URL, 'PUT', { shared })
export const renameSharedConfig = (from, to) => sharedWrite(`${SHARED_URL}/rename`, 'POST', { from, to })
// { regenerated, failed }
export const regenerateShared = () => sharedWrite(`${SHARED_URL}/regenerate`, 'POST')

// ─── Render ──────────────────────────────────────────────────────────────────

export async function renderDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const a = await answer(`${BASE}/render/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, sent('POST', {}))
  return a.kind === 'ok' ? a.body : {}
}

// ─── Folders ────────────────────────────────────────────────────────────────

export async function getFolderTree(parentPath = '') {
  const query = parentPath ? `?path=${encodeURIComponent(parentPath)}` : ''
  const a = await answer(`${BASE}/folders/tree${query}`)
  return a.kind === 'ok' ? a.body : []
}

// Recursive, on-demand scan of every deployment in the repo — used only to
// populate the Sync to/from modals' candidate lists (not the lazy tree).
// `chart`: each folder's _common is looked up for that Template (#103).
export async function listAllDeployments(chart) {
  const a = await answer(`${BASE}/folders/deployments${chart ? `?chart=${encodeURIComponent(chart)}` : ''}`)
  return a.kind === 'ok' ? a.body : []
}

export async function initDeploymentFolder(folder, chart) {
  const a = await answer(`${BASE}/folders/init`, sent('POST', { folder, chart }))
  if (a.kind === 'ok') return a.body
  return { error: carried(a).error || `Could not create the deployment (HTTP ${a.status})` }
}

// ─── A folder's _common (#101) ──────────────────────────────────────────────

// What making (`{ action: 'create', folder, chart }`) or removing
// (`{ action: 'delete', path }`) a _common changes: the plan, or `{ error }`.
export async function getCommonPlan(query) {
  const a = await read(`${BASE}/folders/common/plan?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`)
  if (a.kind === 'ok') return a.body
  if (a.cutOff && a.status >= 200 && a.status < 300) return {}
  const body = carried(a)
  return { error: body.error || `HTTP ${a.status}`, problems: body.problems || [] }
}

// Writes it: `expected` is the plan's files, as shown.
export async function applyCommon(query, expected) {
  // An answer that cannot be read throws (AnswerCutOff): whether it was
  // made is not known, and the dialog says so.
  const a = await answer(`${BASE}/folders/common`, sent('POST', { ...query, expected }))
  if (a.kind === 'ok') return a.body
  const body = carried(a)
  return { error: body.error || `HTTP ${a.status}`, problems: body.problems || [], plan: body.plan }
}

// The deployments that inherit from a _common, with where each group comes from.
export async function getCommonUsers(commonPath) {
  const a = await answer(`${BASE}/folders/common/users?path=${encodeURIComponent(commonPath)}`)
  return a.kind === 'ok' ? a.body : []
}

// ─── Sync ───────────────────────────────────────────────────────────────────

// What a read of sync.yaml that failed says: `{ failed, error, file? }`. A
// sync.yaml that cannot be read is not "no syncs" (the server says so too).
function syncReadFailure(a) {
  const body = carried(a)
  return { failed: true, error: body.error || `sync.yaml could not be read (the server answered ${a.status})`, ...(body.file ? { file: body.file } : {}) }
}

// Full registry in one call — used by the deployment tree to badge every row
// without a per-item request. `{ syncs }`, or `{ failed, error, file? }`.
export async function getSyncRegistry() {
  const a = await answer(`${BASE}/sync`)
  return a.kind === 'ok' ? a.body : syncReadFailure(a)
}

// `{ target, source }` (source null: not a sync target), or
// `{ target, failed, error, file? }`: whether it is one is not known.
export async function getSyncSource(target) {
  const a = await answer(`${BASE}/sync?target=${encodeURIComponent(target)}`)
  return a.kind === 'ok' ? a.body : { target, ...syncReadFailure(a) }
}

export async function createSync(source, target) {
  const a = await read(`${BASE}/sync`, sent('POST', { source, target }))
  if (a.kind === 'ok') return a.body
  if (a.cutOff && a.status >= 200 && a.status < 300) return {}
  const body = carried(a)
  // A source a values save would refuse is refused here too, with its cells.
  return { ok: false, error: body.error || 'Sync failed', problems: body.problems }
}

export async function unlinkSync(target) {
  const a = await read(`${BASE}/sync`, sent('DELETE', { target }))
  if (a.kind === 'ok') return a.body
  if (a.cutOff && a.status >= 200 && a.status < 300) return {}
  return { ok: false, error: carried(a).error || 'Unlink failed' }
}

export async function cloneChart(chart, newName, migration) {
  const a = await answer(`${BASE}/charts/${encodeURIComponent(chart)}/clone`, sent('POST', { newName, migration }))
  return a.kind === 'ok' ? a.body : { error: carried(a).error || 'Clone failed' }
}
