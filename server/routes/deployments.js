import express from 'express'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { NAME_RE } from '../lib/safePath.js'

import { listRoutes } from './deployments/list.js'
import { valuesRoutes } from './deployments/values.js'
import { routingRoutes } from './deployments/routing.js'
import { lifecycleRoutes } from './deployments/lifecycle.js'

export default function deploymentsRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  listRoutes(router)
  valuesRoutes(router)
  routingRoutes(router)
  lifecycleRoutes(router)

  return router
}
