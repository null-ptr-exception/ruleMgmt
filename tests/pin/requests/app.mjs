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
import { answerUncaught } from '../../../server/http/route.js'
import { userRoute, unknownApiRoute } from '../../../server/routes/own.js'

const dir = process.argv[2]
const routers = await Promise.all(MOUNTS.map(([, file]) => import(`../../../server/routes/${file}.js`)))
const app = express()
app.use(jsonBody())
const setGitopsDir = (req, res, next) => { req.gitopsDir = dir; next() }
MOUNTS.forEach(([at], i) => app.use(at, setGitopsDir, routers[i].default()))
// server.js answers these itself (server/routes/own.js): who is signed in,
// a JSON 404 for any other /api path; any other GET is the page (the SPA
// fallback).
app.get('/api/v2/user', userRoute)
app.use('/api', unknownApiRoute)
app.get('*', (req, res) => res.send('<!doctype html><title>page</title>'))
app.use(answerUncaught)
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`))
