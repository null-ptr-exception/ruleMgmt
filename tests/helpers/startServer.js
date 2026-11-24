// server.js started in a process of its own, as the image starts it.
//
// server.js reads dist/index.html at start, which only a build makes: it is
// run from a folder of links to this checkout's files, with a stub page.
// Without GITOPS_DIR the server therefore works in `gitops` inside that
// folder, never in this checkout's own.
import { spawn } from 'child_process'
import fs from 'fs/promises'
import net from 'net'
import path from 'path'

const ROOT = path.resolve(import.meta.dirname, '../..')

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

/** The folder of links server.js runs from, made in `tmp` once. */
export async function appFolder(tmp) {
  const app = path.join(tmp, 'app')
  if (!(await fs.stat(app).catch(() => null))) {
    await fs.mkdir(path.join(app, 'dist'), { recursive: true })
    for (const name of await fs.readdir(ROOT)) {
      if (name !== 'dist' && name !== '.git' && name !== 'gitops') await fs.symlink(path.join(ROOT, name), path.join(app, name))
    }
    await fs.writeFile(path.join(app, 'dist', 'index.html'), '<html><head></head><body></body></html>')
  }
  return app
}

/** An environment in which git finds no identity: none in a variable, no config. */
export function withoutGitIdentity(env = process.env) {
  const out = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' }
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete out[k]
  return out
}

/**
 * Start server.js with `env` on top of this process's (a value of
 * undefined takes the variable out).
 * @returns { base, child, output(), ended, up, stop() } — `up` is true when
 *   it answered a request, false when the process ended first (`ended`
 *   then holds its exit code); `output()` is what it wrote so far.
 */
export async function startServer(tmp, env = {}, { baseEnv = process.env } = {}) {
  const app = await appFolder(tmp)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let output = ''
  const full = { ...baseEnv, PORT: String(port), JUPYTERHUB_SERVICE_PREFIX: '', ...env }
  for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k]
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(app, 'server.js')], {
    env: full, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ended = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })))
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await ended } }
  const handle = { base, app, child, output: () => output, ended, stop, up: false }
  for (let i = 0; i < 400; i++) {
    if (await fetch(`${base}/api/v2/user`).then(() => true, () => false)) return { ...handle, up: true }
    if (child.exitCode !== null || child.signalCode !== null) return handle
    await new Promise(r => setTimeout(r, 50))
  }
  await stop()
  throw new Error(`server.js did not start:\n${output}`)
}

/** Each line the server logged, as the object pino wrote. */
export const logLines = output => output.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
