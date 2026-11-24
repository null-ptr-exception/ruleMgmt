// What every function of src/utils/chartApi.js gives its caller for each kind
// of answer a server (or what stands between it and the browser) can give.
// The table is written to chartApiAnswers.md beside this file and compared
// with it: a cell that changes fails the test, and the diff of that file is
// the change. After a change that is meant, run
//   npx vitest run tests/unit/chartApiAnswers.test.js -u
// and read the diff of chartApiAnswers.md line by line.
/* global Response */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as api from '../../src/utils/chartApi.js'

afterEach(() => vi.unstubAllGlobals())

const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// The kinds of answer. Each is a function so that every call gets a fresh Response.
const ANSWERS = [
  ['200 with its body', null], // filled per function: its usual body
  ['400 with field problems', json(400, { error: 'The values have 1 problem', problems: [{ path: 'cpu[0].warn', message: 'must be a number' }] })],
  ['409 naming a file', json(409, { error: 'deployments/a/values.yaml cannot be read (permission denied)', file: 'deployments/a/values.yaml', unreadable: true })],
  ['500 with a reason', json(500, { error: 'Generation failed: boom' })],
  ['504 HTML from a proxy', () => new Response('<html><body>504 Gateway Time-out</body></html>', { status: 504, headers: { 'Content-Type': 'text/html' } })],
  ['409 null', json(409, null)],
  ['409 HTML', () => new Response('<html><body>409 Conflict</body></html>', { status: 409, headers: { 'Content-Type': 'text/html' } })],
  ['network failure', 'reject'],
  ['200 with no body', () => new Response('', { status: 200 })],
  ['200 null', json(200, null)],
  ['200 a string', json(200, 'ok')],
  ['200 an array', json(200, [1])],
  ['204', () => new Response(null, { status: 204 })],
]

const OBJ = { from: 'server' }
const LIST = [{ from: 'server' }]

// [name, call, usual 2xx body, extra answers this function treats on its own]
const FUNCTIONS = [
  ['getUserInfo', () => api.getUserInfo(), OBJ],
  ['listCharts', () => api.listCharts(), LIST],
  ['createChart', () => api.createChart('c'), OBJ],
  ['deleteChart', () => api.deleteChart('c'), OBJ],
  ['getChartInfo', () => api.getChartInfo('c'), OBJ],
  ['saveChartRules', () => api.saveChartRules('c', { 'a.yaml': 'groups: []' }), OBJ],
  ['migrationPreview', () => api.migrationPreview('c', { 'a.yaml': '' }, { groups: {} }), OBJ],
  ['saveChartMeta', () => api.saveChartMeta('c', { description: 'd' }), OBJ],
  ['getDeployment', () => api.getDeployment('c', 'd', 'team/d'), OBJ, [['404', json(404, { error: 'No values for d' })]]],
  ['saveDeployment', () => api.saveDeployment('c', 'd', { cpu: [] }, 'team/d', 'v1'), OBJ],
  ['deleteDeployment', () => api.deleteDeployment('c', 'd', 'team/d'), OBJ],
  ['getRouting', () => api.getRouting('c', 'd', 'team/d'), OBJ, [['404', json(404, { error: 'No routing.yaml' })]]],
  ['saveRouting', () => api.saveRouting('c', 'd', 'team/d', 'labels: {}'), OBJ],
  ['removeRouting', () => api.removeRouting('c', 'd', 'team/d'), OBJ],
  ['getSharedConfigs', () => api.getSharedConfigs(), OBJ],
  ['saveSharedConfigs', () => api.saveSharedConfigs({ configs: [] }), OBJ],
  ['renameSharedConfig', () => api.renameSharedConfig('a', 'b'), OBJ],
  ['regenerateShared', () => api.regenerateShared(), OBJ],
  ['renderDeployment', () => api.renderDeployment('c', 'd', 'team/d'), OBJ],
  ['getFolderTree', () => api.getFolderTree('team'), LIST],
  ['listAllDeployments', () => api.listAllDeployments('c'), LIST],
  ['initDeploymentFolder', () => api.initDeploymentFolder('team/d', 'c'), OBJ],
  ['getCommonPlan', () => api.getCommonPlan({ action: 'create', folder: 'team', chart: 'c' }), OBJ],
  ['applyCommon', () => api.applyCommon({ action: 'create', folder: 'team', chart: 'c' }, ['team/_common/c-values.yaml']), OBJ],
  ['getCommonUsers', () => api.getCommonUsers('team/_common'), LIST],
  ['commonsAbove', () => api.commonsAbove('team/d'), [{ name: 'c', path: 'team/_common/c', isCommon: true }]],
  ['getSyncRegistry', () => api.getSyncRegistry(), OBJ],
  ['getSyncSource', () => api.getSyncSource('team/d'), OBJ],
  ['createSync', () => api.createSync('team/a', 'team/b'), OBJ],
  ['unlinkSync', () => api.unlinkSync('team/b'), OBJ],
  ['cloneChart', () => api.cloneChart('c', 'c2', { groups: {} }), OBJ],
]

const cell = s => s.replace(/\|/g, '\\|')

// What the caller gets: the value returned, or what is thrown. An
// AnswerCutOff's message ends with the parser's own words, which are the
// JavaScript engine's: they are left out.
async function outcome(call) {
  try {
    return `returns ${JSON.stringify(await call())}`
  } catch (err) {
    if (err?.name === 'AnswerCutOff') return `throws AnswerCutOff (uncertain: ${err.uncertain})`
    return `throws ${err?.name}: ${err?.message}`
  }
}

async function run(answer) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    const type = opts?.headers?.['Content-Type']
    calls.push(`${opts?.method || 'GET'} ${url}${type ? ` (${type})` : ''}${opts?.body ? ` ${opts.body}` : ''}`)
    if (answer === 'reject') throw new TypeError('Failed to fetch')
    return answer()
  }))
  return calls
}

async function table() {
  const lines = [
    '# What chartApi.js gives its caller, for each kind of answer',
    '',
    'Written by `tests/unit/chartApiAnswers.test.js`; do not edit by hand. Each',
    'answer\'s body is in that test (`ANSWERS`). "200 with its body" answers',
    `${JSON.stringify(OBJ)}, or ${JSON.stringify(LIST)} for a list.`,
    '',
  ]
  const exported = Object.keys(api).filter(k => typeof api[k] === 'function').sort()
  const listed = FUNCTIONS.map(([name]) => name).sort()
  expect(listed).toEqual(exported)
  for (const [name, call, okBody, extra = []] of FUNCTIONS) {
    lines.push(`## ${name}`, '')
    let request
    lines.push('| answer | the caller gets |', '|---|---|')
    for (const [label, make] of [...ANSWERS, ...extra]) {
      const calls = await run(make ?? json(200, okBody))
      lines.push(`| ${label} | ${cell(await outcome(call))} |`)
      request ??= calls.join(' ; ')
    }
    lines.push('', `Request: \`${request}\``, '')
  }
  return lines.join('\n')
}

describe('chartApi: what each function gives for each kind of answer', () => {
  it('is the table in chartApiAnswers.md', async () => {
    await expect(await table()).toMatchFileSnapshot('./chartApiAnswers.md')
  })
})
