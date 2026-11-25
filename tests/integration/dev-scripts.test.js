// The scripts a developer of this repo runs, each in a folder of its own.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs/promises'
import net from 'net'
import os from 'os'
import path from 'path'
import { appFolder } from '../helpers/startServer.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
let tmp
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-scripts-')) })
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

// The committed schemas are what doc/rules-format.md points an editor at: a
// developer who runs the script on an unchanged checkout changes nothing.
describe('the schema writers', () => {
  it.each([
    ['gen-rules-schema', ['common-file.schema.json', 'outputs.schema.json', 'rules-file.schema.json']],
    ['gen-routing-schema', ['routing.schema.json']],
  ])('%s writes its files of schema/ as they are committed, and says which', async (name, files) => {
    await fs.mkdir(path.join(tmp, 'schema'))
    await fs.cp(path.join(ROOT, 'scripts'), path.join(tmp, 'scripts'), { recursive: true })
    for (const n of ['src', 'config', 'node_modules', 'package.json']) await fs.symlink(path.join(ROOT, n), path.join(tmp, n))
    const r = spawnSync('node', [path.join(tmp, 'scripts', `${name}.mjs`)], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    expect((await fs.readdir(path.join(tmp, 'schema'))).sort()).toEqual(files)
    for (const f of files) {
      expect(r.stdout).toContain(`wrote ${path.join(tmp, 'schema', f)}\n`)
      expect(await fs.readFile(path.join(tmp, 'schema', f), 'utf-8')).toBe(await fs.readFile(path.join(ROOT, 'schema', f), 'utf-8'))
    }
  })
})

// PORT is the web port for dev harnesses: were the API to take it, Vite and
// the API would want the same one.
describe('dev-api', () => {
  it('listens on API_PORT, whatever PORT is', async () => {
    const app = await appFolder(tmp)
    const [port, api] = [await freePort(), await freePort()]
    const child = spawn(process.execPath, ['--import', path.join(ROOT, 'tests/coverage/on-sigterm.mjs'), '--preserve-symlinks', '--preserve-symlinks-main', path.join(app, 'scripts/dev-api.mjs')], {
      env: { ...process.env, PORT: String(port), API_PORT: String(api), GITOPS_DIR: path.join(tmp, 'repo'), JUPYTERHUB_SERVICE_PREFIX: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', d => { output += d })
    child.stderr.on('data', d => { output += d })
    const ended = new Promise(r => child.once('exit', r))
    try {
      await expect.poll(() => output, { timeout: 20_000 }).toMatch(/API server listening on port (\d+)/)
      expect(output).toContain(`API server listening on port ${api}`)
      expect((await fetch(`http://127.0.0.1:${api}/api/v2/user`)).status).toBe(200)
      await expect(fetch(`http://127.0.0.1:${port}/api/v2/user`)).rejects.toThrow()
    } finally {
      child.kill()
      await ended
    }
  })
})
