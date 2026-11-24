import express from 'express'
import { holdSyncRegistryLock } from '../lib/sync.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { declaredRoutes } from '../http/route.js'

import { treeRoutes } from './folders/tree.js'
import { initRoutes } from './folders/create.js'
import { commonRoutes } from './folders/common.js'

export { ANY_TEMPLATE_VERSION } from './folders/create.js'

export default function foldersRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)
  // A _common's make or remove holds the commit lock itself, for as long
  // as it takes: it renders every deployment it touches twice, which in a
  // large repo outlasts the time limit the other writes are held to.
  router.use((req, res, next) => (req.method === 'POST' && req.path === '/common' ? next() : holdSyncRegistryLock(req, res, next)))

  treeRoutes(router)
  commonRoutes(router)
  initRoutes(router)

  return declaredRoutes(router)
}
