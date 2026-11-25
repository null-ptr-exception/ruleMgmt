// The app's routes in a process of their own, as the server runs them, for
// the template-files pin: an exception no route catches ends this process
// the way it ends the server (Node's default for an unhandled rejection),
// and the harness records that as the answer.
//
//   node app.mjs <repo root>    prints the port it listens on
import express from 'express'

const dir = process.argv[2]
const names = ['templates', 'charts', 'deployments', 'folders', 'render', 'git']
const routes = await Promise.all(names.map(n => import(`../../../server/routes/${n}.js`)))
const app = express()
app.use(express.json({ limit: '5mb' }))
app.use((req, res, next) => { req.gitopsDir = dir; next() })
names.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`))
