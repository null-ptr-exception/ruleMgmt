import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'

let server, baseURL

async function buildApp(opts = {}) {
  const { default: authRouter } = await import('../../server/routes/auth.js')
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter({
    gitlabUrl: opts.gitlabUrl || null,
    gitlabAppId: opts.gitlabAppId || null,
    gitlabAppSecret: opts.gitlabAppSecret || null,
  }))
  return app
}

describe('Auth API — local mode', () => {
  beforeAll(async () => {
    const app = await buildApp()
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseURL = `http://127.0.0.1:${server.address().port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
  })

  it('GET /user returns local:true when no GitLab configured', async () => {
    const res = await fetch(`${baseURL}/api/auth/user`)
    const data = await res.json()
    expect(data).toEqual({ local: true })
  })

  it('GET /login returns 404 when no GitLab configured', async () => {
    const res = await fetch(`${baseURL}/api/auth/login`, { redirect: 'manual' })
    expect(res.status).toBe(404)
  })
})

describe('Auth API — production mode', () => {
  let prodServer, prodBaseURL

  beforeAll(async () => {
    const app = await buildApp({
      gitlabUrl: 'https://gitlab.example.com',
      gitlabAppId: 'test-app-id',
      gitlabAppSecret: 'test-secret',
    })
    await new Promise(resolve => {
      prodServer = app.listen(0, '127.0.0.1', () => {
        prodBaseURL = `http://127.0.0.1:${prodServer.address().port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    if (prodServer) await new Promise(resolve => prodServer.close(resolve))
  })

  it('GET /user returns authenticated:false when not logged in', async () => {
    const res = await fetch(`${prodBaseURL}/api/auth/user`)
    const data = await res.json()
    expect(data).toEqual({ authenticated: false })
  })

  it('GET /login redirects to GitLab', async () => {
    const res = await fetch(`${prodBaseURL}/api/auth/login`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')
    expect(location).toContain('gitlab.example.com')
    expect(location).toContain('oauth')
  })
})
