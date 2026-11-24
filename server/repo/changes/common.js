/**
 * common: a folder's `_common` made or removed (#101), with the values
 * moved between it and the charts on it (lib/commonEdit.js plans it).
 *
 *   { kind: 'common', action: 'create', folder, chart }
 *   { kind: 'common', action: 'delete', path }
 *
 * The plan the dialog shows (GET /folders/common/plan) and the one written
 * are the same computation: every file it writes, and — removing one —
 * every file under the `_common` and its folders, all or none. Before
 * anything is written each deployment it touches is rendered as it is and
 * as it will be, in a copy of the repo: one that would deploy something
 * else refuses it (409).
 *
 * version: the plan's `expected` (each file as it is and as it will be),
 * as the dialog sends it back; compared when sent. A change to any file
 * the plan read while it waits for the lock is planned again under the
 * lock: when that plan's `expected` is not the first one's, it is refused
 * (409, with the new plan), never written over.
 */
import { defineChange } from '../write.js'
import { planCreate, planDelete, expectedNow } from '../../lib/commonEdit.js'

/** A plan's `expected` (a map of file → hash) as one string, the order of its keys aside. */
export const expectedVersion = expected => JSON.stringify(Object.entries(expected).sort())

defineChange('common', {
  policy: 'commonMove',

  async plan(repo, { action, folder, chart, path }) {
    const out = action === 'delete' ? await planDelete(repo, path) : await planCreate(repo, folder, chart)
    if (!out.plan) return { refusal: out }
    return { files: out.files, facts: { plan: out.plan, check: out.check } }
  },

  // The plan's `expected` as the repo is now: each file it writes and, on a
  // removal, every one under the _common, a link by where it leads.
  version: async (repo, change, facts) => expectedVersion(await expectedNow(repo.root, facts.check)),
  strict: () => new Set(),
  table: () => 'commonMove',
  refused: () => ({ status: 409, body: { error: 'refused' } }),
  changed: plan => ({ status: 409, body: { error: 'The repo changed since the list was made: look at the changes again', plan: plan.facts.plan } }),
  answer: plan => ({ ok: true, ...plan.facts.plan }),
})
