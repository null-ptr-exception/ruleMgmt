import express from 'express'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { declaredRoutes } from '../http/route.js'

import { valuesRoutes } from './deployments/values.js'
import { routingRoutes } from './deployments/routing.js'
import { lifecycleRoutes } from './deployments/lifecycle.js'

export default function deploymentsRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)

  // Every route takes the chart, the deployment and its folder as
  // deployments/resolve.js's DEPLOYMENT_REQUEST declares them.
  valuesRoutes(router)
  routingRoutes(router)
  lifecycleRoutes(router)

  return declaredRoutes(router)
}
