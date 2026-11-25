import express from 'express'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { declaredRoutes } from '../http/route.js'

import { treeRoutes } from './folders/tree.js'
import { initRoutes } from './folders/create.js'
import { commonRoutes } from './folders/common.js'

export default function foldersRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)
  // No request holds the commit lock: a new deployment and a _common's
  // make or remove are written through the writer, which takes it for the
  // write alone.

  treeRoutes(router)
  commonRoutes(router)
  initRoutes(router)

  return declaredRoutes(router)
}
