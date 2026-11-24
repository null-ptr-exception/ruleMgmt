/** A folder's _common (#101): its plan, making or removing it, and who uses it. */

import { withSyncRegistryLock } from '../../lib/sync.js'
import { planCreate, planDelete, applyPlan, commonUsers, linkOnPath } from '../../lib/commonEdit.js'
import { withoutPath } from '../../lib/answerPaths.js'
import { isRepoPath } from '../../lib/safePath.js'

export function commonRoutes(router) {
  // A folder's _common (#101): what making or removing one changes, listed
  // before anything is written; then all of it, or nothing.
  const planFor = (gitopsDir, q) => (q.action === 'delete' ? planDelete(gitopsDir, q.path) : planCreate(gitopsDir, q.folder, q.chart))

  router.get('/common/plan', async (req, res) => {
    try {
      const out = await planFor(req.gitopsDir, req.query)
      if (!out.plan) return res.status(out.status).json(out.body)
      res.json(out.plan)
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  // Under the commit lock, for the whole plan, write and check. `expected`
  // is the plan's, as shown: a file changed since refuses it.
  router.post('/common', async (req, res) => {
    try {
      const { action, expected } = req.body || {}
      if (action !== 'create' && action !== 'delete') return res.status(400).json({ error: 'action is create or delete' })
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        return res.status(400).json({ error: 'expected is needed: the plan\'s expected, from GET /common/plan, as it was shown' })
      }
      const { status, body } = await withSyncRegistryLock(req.gitopsDir, async () => {
        const out = await planFor(req.gitopsDir, req.body)
        if (!out.plan) return out
        const same = JSON.stringify(Object.entries(expected).sort()) === JSON.stringify(Object.entries(out.plan.expected).sort())
        if (!same) return { status: 409, body: { error: 'The repo changed since the list was made: look at the changes again', plan: out.plan } }
        return applyPlan(req.gitopsDir, out)
      })
      res.status(status).json(body)
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.get('/common/users', async (req, res) => {
    try {
      const rel = String(req.query.path || '')
      if (rel && !isRepoPath(rel, { hidden: true })) return res.status(400).json({ error: 'Invalid path' })
      if (await linkOnPath(req.gitopsDir, rel)) return res.status(400).json({ error: `${rel} goes through a link` })
      res.json(await commonUsers(req.gitopsDir, rel.replace(/\/+$/, '')))
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })
}
