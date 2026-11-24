// The template file routes (save, rename, delete) write where the Template
// really is: a chart folder or a templates/ folder that is a link leading
// out of the repo is refused before anything is written, as the Template's
// other routes refuse it; a link to a folder of the repo is written through.
// A rename onto a name a file already has is refused, as a chart's and a
// shared config's are.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import templatesRouter from '../../server/routes/templates.js'

const SENTINEL = 'sentinel: outside\n'
const HAND = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notes\n'

let root, repo, outside, server, baseURL

// Every entry under `dir`, as it is: a file's text, a link's target, a folder.
async function tree(dir) {
  const out = {}
  async function walk(rel) {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, r)
      if (e.isSymbolicLink()) out[r] = `-> ${await fs.readlink(abs)}`
      else if (e.isDirectory()) { out[r] = 'dir'; await walk(r) } else out[r] = await fs.readFile(abs, 'utf-8')
    }
  }
  await walk('')
  return out
}

async function api(method, url, body) {
  const res = await fetch(`${baseURL}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, text, data: JSON.parse(text) }
}

async function chart(dir) {
  await fs.mkdir(path.join(dir, 'templates'), { recursive: true })
  await fs.writeFile(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
  await fs.writeFile(path.join(dir, 'values.yaml'), 'replicas: 1\n')
  await fs.writeFile(path.join(dir, 'templates', 'notes.yaml'), HAND)
  await fs.writeFile(path.join(dir, 'templates', 'other.yaml'), '# other\n')
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tmpl-file-links-')))
  repo = path.join(root, 'repo')
  outside = path.join(root, 'outside')
  await fs.mkdir(path.join(repo, 'charts'), { recursive: true })
  await fs.writeFile(path.join(repo, 'README.md'), '# repo\n')
  await chart(path.join(outside, 'chart'))
  await fs.writeFile(path.join(outside, 'sentinel.yaml'), SENTINEL)
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = repo; next() })
  app.use('/api/v2/templates', templatesRouter())
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; resolve() }) })
})

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await fs.rm(root, { recursive: true, force: true })
})

const routes = [
  ['save', 'POST', '/api/v2/templates/demo/notes', { content: `${HAND}# saved\n` }],
  ['rename', 'POST', '/api/v2/templates/demo/notes/rename', { newName: 'notes2' }],
  ['delete', 'DELETE', '/api/v2/templates/demo/notes'],
]

describe.each([
  ['the chart folder', async () => fs.symlink(path.join(outside, 'chart'), path.join(repo, 'charts/demo')), 'charts/demo/templates/notes.yaml'],
  ['its templates folder', async () => {
    await chart(path.join(repo, 'charts/demo'))
    await fs.rm(path.join(repo, 'charts/demo/templates'), { recursive: true })
    await fs.symlink(path.join(outside, 'chart', 'templates'), path.join(repo, 'charts/demo/templates'))
  }, 'charts/demo/templates/notes.yaml'],
])('%s is a link leading out of the repo', (_, link, named) => {
  it.each(routes)('%s is refused (409, naming the file in the repo); nothing changes in or out of the repo', async (__, method, url, body) => {
    await link()
    const inBefore = await tree(repo)
    const outBefore = await tree(outside)
    const { status, data, text } = await api(method, url, body)
    expect(status, text).toBe(409)
    expect(data.file).toBe(named)
    expect(data.error).toBe(`${named} cannot be written: a folder on the way to it is a link that leads outside the repo`)
    expect(text).not.toContain(root)
    expect(await tree(repo)).toEqual(inBefore)
    expect(await tree(outside)).toEqual(outBefore)
  })

  it('the GET of the same file is refused too (409)', async () => {
    await link()
    const { status, text } = await api('GET', '/api/v2/templates/demo/notes')
    expect(status, text).toBe(409)
    expect(text).not.toContain(root)
  })
})

describe('the chart folder is a link to a folder of the repo', () => {
  beforeEach(async () => {
    await chart(path.join(repo, 'charts/real'))
    await fs.symlink('real', path.join(repo, 'charts/demo'))
  })

  it('save writes through it', async () => {
    expect((await api(...routes[0].slice(1))).status).toBe(200)
    expect(await fs.readFile(path.join(repo, 'charts/real/templates/notes.yaml'), 'utf-8')).toBe(`${HAND}# saved\n`)
  })

  it('rename renames through it', async () => {
    expect((await api(...routes[1].slice(1))).status).toBe(200)
    expect((await fs.readdir(path.join(repo, 'charts/real/templates'))).sort()).toEqual(['notes2.yaml', 'other.yaml'])
  })

  it('delete deletes through it', async () => {
    expect((await api(...routes[2].slice(1))).status).toBe(200)
    expect(await fs.readdir(path.join(repo, 'charts/real/templates'))).toEqual(['other.yaml'])
  })
})

describe('rename onto a name a file already has', () => {
  it('is refused (409); both files stay as they are', async () => {
    await chart(path.join(repo, 'charts/demo'))
    const before = await tree(repo)
    const { status, data, text } = await api('POST', '/api/v2/templates/demo/notes/rename', { newName: 'other' })
    expect(status, text).toBe(409)
    expect(data.error).toMatch(/other\.yaml already exists/)
    expect(text).not.toContain(root)
    expect(await tree(repo)).toEqual(before)
  })

  it('a rename onto its own name changes nothing', async () => {
    await chart(path.join(repo, 'charts/demo'))
    const before = await tree(repo)
    const { status, text } = await api('POST', '/api/v2/templates/demo/notes/rename', { newName: 'notes' })
    expect(status, text).toBe(409)
    expect(await tree(repo)).toEqual(before)
  })
})
