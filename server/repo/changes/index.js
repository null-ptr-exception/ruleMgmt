/**
 * Every kind of change the writer knows (write.js), defined on import, and
 * the writer's two calls. A writer imports planChange and applyChange from
 * here, so every kind is there when it plans.
 *
 * Adding a kind: a file beside this one calling defineChange (see
 * set-values.js), and its import below.
 */
import './set-values.js'
import './sync.js'
import './delete-deployment.js'
import './create-deployment.js'
import './common.js'
import './template-file.js'
import './chart.js'
import './rules.js'
import './routing.js'
import './shared.js'

export { planChange, applyChange, changeKinds } from '../write.js'
