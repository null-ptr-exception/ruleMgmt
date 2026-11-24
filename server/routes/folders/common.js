/** A folder's _common (#101): its plan, making or removing it, and who uses it. */

import { withSyncRegistryLock } from '../../lib/sync.js'
import { planCreate, planDelete, applyPlan, commonUsers } from '../../lib/commonEdit.js'
import { z } from 'zod'
import { linkOnTheWay } from '../../repo/paths.js'
import { withoutPath } from '../../lib/answerPaths.js'
import { errorAnswer } from '../../lib/readIfThere.js'
import { route, repoPath, map } from '../../http/route.js'
import { COMMON_DIR } from '../../../src/utils/reservedNames.js'

// What making (`action: create`, `folder`, `chart`) or removing
// (`action: delete`, `path`) a _common asks; the folder, the Template and
// the path are decided by the plan (commonEdit.js), as it is asked them.
const PLAN_FIELDS = {
  folder: z.string().min(1).optional(),
  chart: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}
const PLAN_QUERY = z.object({ action: z.string().optional(), ...PLAN_FIELDS })
// `expected` is the plan's, as shown: a file changed since refuses it.
const APPLY_BODY = z.object({
  action: z.enum(['create', 'delete'], { error: 'action is create or delete' }),
  expected: map(z.unknown(), { error: 'expected is needed: the plan\'s expected, from GET /common/plan, as it was shown' }),
  ...PLAN_FIELDS,
})
const USERS_QUERY = z.object({
  path: z.preprocess(v => (v === '' ? undefined : v), repoPath('list', { what: 'path' }).optional()),
})

export function commonRoutes(router) {
  // A folder's _common (#101): what making or removing one changes, listed
  // before anything is written; then all of it, or nothing.
  const planFor = (gitopsDir, q) => (q.action === 'delete' ? planDelete(gitopsDir, q.path) : planCreate(gitopsDir, q.folder, q.chart))

  router.get('/common/plan', route('folders.common-plan', { query: PLAN_QUERY }, async ({ query }, { gitopsDir }) => {
    const out = await planFor(gitopsDir, query)
    return out.plan ? { status: 200, body: out.plan } : out
  }))

  // Under the commit lock, for the whole plan, write and check. A write
  // that fails says why.
  router.post('/common', route('folders.common', { body: APPLY_BODY }, async ({ body }, { gitopsDir }) => {
    try {
      return await withSyncRegistryLock(gitopsDir, async () => {
        const out = await planFor(gitopsDir, body)
        if (!out.plan) return out
        const same = JSON.stringify(Object.entries(body.expected).sort()) === JSON.stringify(Object.entries(out.plan.expected).sort())
        if (!same) return { status: 409, body: { error: 'The repo changed since the list was made: look at the changes again', plan: out.plan } }
        return applyPlan(gitopsDir, out)
      })
    } catch (err) {
      const answer = errorAnswer(err)
      return answer.status === 500 ? { status: 500, body: { error: await withoutPath(err.message, gitopsDir) } } : answer
    }
  }))

  router.get('/common/users', route('folders.common-users', { query: USERS_QUERY }, async ({ query }, { gitopsDir }) => {
    const rel = query.path?.rel ?? ''
    const link = rel ? await linkOnTheWay(gitopsDir, rel) : null
    if (link) return { status: 400, body: { error: `${rel}: ${link.why} — a ${COMMON_DIR} chart is looked at where it is, not through a link${link.use}` } }
    return { status: 200, body: await commonUsers(gitopsDir, rel) }
  }))
}
