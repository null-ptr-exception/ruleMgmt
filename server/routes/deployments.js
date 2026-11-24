import express from 'express'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { answerEveryRoute } from '../http/route.js'
import { parsePath } from '../repo/paths.js'

import { listRoutes } from './deployments/list.js'
import { valuesRoutes } from './deployments/values.js'
import { routingRoutes } from './deployments/routing.js'
import { lifecycleRoutes } from './deployments/lifecycle.js'

export default function deploymentsRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)

  router.use('/:chart', async (req, res, next) => {
    const chart = await parsePath(req.params.chart, 'name', { what: 'chart name' })
    if (!chart.ok) return res.status(400).json({ error: chart.error })
    next()
  })

  listRoutes(router)
  valuesRoutes(router)
  routingRoutes(router)
  lifecycleRoutes(router)

  return answerEveryRoute(router)
}
