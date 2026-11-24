// The app's routers in a process of their own, mounted as server.js mounts
// them (MOUNTS, checked against server.js by the pin), with server.js's body
// parser and size limit (server/http/body.js) and its last error handler:
// an exception no route catches ends this process the way it ends the
// server, and the harness records that as the answer.
//
//   node app.mjs <repo root>    prints the port it listens on
import express from 'express'
import { MOUNTS } from './routes.mjs'
import { jsonBody } from '../../../server/http/body.js'
import { answerUncaught, answerUnknownApi } from '../../../server/http/route.js'

const dir = process.argv[2]
const routers = await Promise.all(MOUNTS.map(([, file]) => import(`../../../server/routes/${file}.js`)))
const app = express()
app.use(jsonBody())
const setGitopsDir = (req, res, next) => { req.gitopsDir = dir; next() }
MOUNTS.forEach(([at], i) => app.use(at, setGitopsDir, routers[i].default()))
// server.js answers this one itself; it reads no request value.
app.get('/api/v2/user', (req, res) => res.json({ user: process.env.JUPYTERHUB_USER || null, logoutUrl: null }))
// server.js answers any other /api path with a JSON 404, any other GET
// with the page (the SPA fallback).
app.use('/api', answerUnknownApi)
app.get('*', (req, res) => res.send('<!doctype html><title>page</title>'))
app.use(answerUncaught)
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`))
