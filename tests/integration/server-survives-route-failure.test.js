// One request must never end the server: a route that fails where its own
// try does not reach is still answered, and the server goes on answering.
// This starts the real server.js in a process of its own, as the E2E web
// server does, so an unhandled rejection would end that process the way it
// ends the deployed one (Node's default).
//
// server.js reads dist/index.html at start, which only a build makes: it is
// run from a folder of links to this checkout's files, with a stub page.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { spawn, execFileSync } from 'child_process'
import fs from 'fs/promises'
import net from 'net'
import os from 'os'
import path from 'path'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
if (IS_ROOT) console.log('server-survives-route-failure: skipped, chmod does not stop root from reading')

const ROOT = path.resolve(import.meta.dirname, '../..')
let tmp, gitops, child, base, exited, output

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

async function startServer() {
  const app = path.join(tmp, 'app')
  if (!(await fs.stat(app).catch(() => null))) {
    await fs.mkdir(path.join(app, 'dist'), { recursive: true })
    for (const name of await fs.readdir(ROOT)) {
      if (name !== 'dist' && name !== '.git') await fs.symlink(path.join(ROOT, name), path.join(app, name))
    }
    await fs.writeFile(path.join(app, 'dist', 'index.html'), '<html><head></head><body></body></html>')
  }
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  output = ''
  child = spawn(process.execPath, ['--import', path.join(ROOT, 'tests/coverage/on-sigterm.mjs'), '--preserve-symlinks', '--preserve-symlinks-main', path.join(app, 'server.js')], {
    env: { ...process.env, PORT: String(port), GITOPS_DIR: gitops, LOG_LEVEL: 'warn', JUPYTERHUB_SERVICE_PREFIX: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })))
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  for (let i = 0; i < 200; i++) {
    const up = await fetch(`${base}/api/v2/user`).then(() => true, () => false)
    if (up) return
    if (child.exitCode !== null) throw new Error(`server.js ended at start:\n${output}`)
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`server.js did not start:\n${output}`)
}

async function ask(method, p, body) {
  try {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return { status: res.status, data: await res.json().catch(() => null) }
  } catch (err) {
    // A dropped connection: give the process a moment to be seen ending.
    await Promise.race([exited, new Promise(r => setTimeout(r, 2000))])
    return { status: 'no answer', error: err.cause?.code || err.name }
  }
}

describe.skipIf(IS_ROOT)('the server, after a route fails outside its own error handling', () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'survives-'))
    gitops = path.join(tmp, 'gitops')
    const chart = path.join(gitops, 'charts', 'demo')
    await fs.mkdir(path.join(chart, 'templates'), { recursive: true })
    await fs.writeFile(path.join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
    await fs.writeFile(path.join(chart, 'templates', 'x.yaml'), 'a: b\n')
    await fs.mkdir(path.join(gitops, 'deployments', 'w', 'd'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: gitops })
    await startServer()
    await fs.chmod(path.join(chart, 'templates'), 0o000)
    await fs.chmod(path.join(gitops, 'deployments', 'w'), 0o000)
  })
  // Each case on a server that is up, so one that ends it does not fail the rest.
  beforeEach(async () => { if (child.exitCode !== null || child.signalCode !== null) await startServer() })

  afterAll(async () => {
    if (child && child.exitCode === null) { child.kill(); await exited }
    if (gitops) {
      await fs.chmod(path.join(gitops, 'charts', 'demo', 'templates'), 0o755).catch(() => {})
      await fs.chmod(path.join(gitops, 'deployments', 'w'), 0o755).catch(() => {})
    }
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  // Each fails where its own try does not reach: the folder on the way to
  // the file cannot be read, and the path is resolved before the try. The
  // routes that ended the process this way are gone; these are answered by
  // the wrapper round every route (server/http/route.js).
  it.each([
    ['open a Template whose templates folder cannot be read', 'GET', '/api/v2/templates/demo', undefined, 'charts/demo/templates'],
    ['save a deployment whose parent cannot be read', 'POST', '/api/v2/deployments/demo/d?folder=deployments/w/d', { values: {} }, 'deployments/w'],
    ['delete a deployment whose parent cannot be read', 'DELETE', '/api/v2/deployments/demo/d?folder=deployments/w/d', undefined, 'deployments/w'],
    ['make a deployment in a folder whose parent cannot be read', 'POST', '/api/v2/folders/init', { folder: 'deployments/w/d/n', chart: 'demo' }, 'deployments/w'],
  ])('%s: answered, naming the folder, and the server answers the next request', async (_, method, p, body, named) => {
    const r = await ask(method, p, body)
    expect(r.status, child.exitCode === null ? '' : `the server process ended:\n${output}`).toBe(409)
    expect(r.data).toEqual({ error: `${named} cannot be read: permission denied`, unreadable: true })
    expect(child.exitCode).toBe(null)
    expect((await ask('GET', '/api/v2/user')).status).toBe(200)
    // A write right after it is not kept waiting on the commit lock.
    const started = performance.now()
    expect((await ask('POST', '/api/v2/charts', { name: 'NOT A NAME' })).status).toBe(400)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  // A path no route has — a route no page calls was taken out, or there
  // never was one — is a JSON 404 whatever its method: not the page, not
  // Express's HTML, no stack or path of the machine.
  it.each([
    ['GET', '/api/v2/templates/demo/x'], ['POST', '/api/v2/templates/demo/x'], ['DELETE', '/api/v2/templates/demo/x'],
    ['POST', '/api/v2/templates/demo/x/rename'], ['POST', '/api/v2/templates/demo/values'], ['GET', '/api/v2/templates/demo/deployments'],
    ['GET', '/api/v2/deployments/demo'], ['POST', '/api/v2/deployments/demo/d/clone'], ['GET', '/api/v2/folders'], ['POST', '/api/v2/folders'],
    ['GET', '/api/nothing'], ['PUT', '/api/v2/nothing/here'],
  ])('%s %s: a JSON 404', async (method, p) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}', signal: AbortSignal.timeout(10_000) })
    const text = await res.text()
    expect(res.status, text).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(JSON.parse(text)).toEqual({ error: 'No such API route' })
    expect(text).not.toContain(tmp)
  })
})
