/**
 * The commit lock: one per workspace, taken by every write of the repo and
 * by Commit, Push, Pull and Discard, so none of them sees another's files
 * half-written.
 *
 *   withSyncRegistryLock(dir, fn)   run fn holding the lock; calls queue
 *   holdSyncRegistryLock            Express middleware: a write request holds
 *                                   it until its answer ends
 *   holdsLock(dir)                  whether the running call already holds it
 *   lockWaiters(dir)                how many calls wait for it
 *
 * A per-directory promise chain is enough: the app runs as a per-user
 * JupyterHub singleuser server, so there is exactly one Node process per
 * repo — no cross-process locking. Code outside AlertForge that writes the
 * repo is not held by it.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const registryLocks = new Map()
// Which workspaces' locks the running request already holds. The lock is not
// re-entrant: taking it again from inside would wait on itself for good, and
// every later commit and save behind it. That is refused at once instead.
const held = new AsyncLocalStorage()
// How many calls wait for each workspace's lock (not the one holding it).
const waiting = new Map()

/** How many calls are waiting for the commit lock of `gitopsDir`, not counting the one holding it. */
export const lockWaiters = gitopsDir => waiting.get(gitopsDir) || 0

export function withSyncRegistryLock(gitopsDir, fn) {
  if (held.getStore()?.includes(gitopsDir)) {
    return Promise.reject(new Error('the commit lock is already held by this request: it cannot be taken again inside it'))
  }
  waiting.set(gitopsDir, lockWaiters(gitopsDir) + 1)
  const run = () => {
    const n = lockWaiters(gitopsDir) - 1
    if (n > 0) waiting.set(gitopsDir, n); else waiting.delete(gitopsDir)
    return held.run([...(held.getStore() || []), gitopsDir], fn)
  }
  const prev = registryLocks.get(gitopsDir) || Promise.resolve()
  const next = prev.then(run, run)
  registryLocks.set(gitopsDir, next.catch(() => {}))
  return next
}

// Longest a write may hold the lock: past it the lock is let go, so a
// handler that never answers cannot stop every commit and save behind it.
export const HOLD_LIMIT_MS = 60000

/**
 * Express middleware: a request that writes files holds the same lock as a
 * commit until its response is sent, so a commit never adds or checks a
 * chart half-written (a save writes rules, then templates, then the schema).
 * Reads are not held, nor OPTIONS. It is let go when the handler answers,
 * whether or not the client is still there, or after HOLD_LIMIT_MS. The
 * lock is not re-entrant: a handler behind this that takes
 * withSyncRegistryLock itself gets an error at once, not a wait on itself.
 * The deployments and sync routers take it inside their handlers instead.
 */
export function holdSyncRegistryLock(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  withSyncRegistryLock(req.gitopsDir, () => new Promise(resolve => {
    let done = false
    const release = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(release, HOLD_LIMIT_MS)
    // Held until the handler answers (res.end), not until the socket says
    // so: a client that left fires 'close' too early — while the handler is
    // still writing — or, if it left while waiting here, never again, and
    // on a destroyed socket 'finish' never comes.
    const end = res.end
    res.end = function (...args) {
      res.end = end
      try { return end.apply(this, args) } finally { release() }
    }
    next()
  })).catch(next)
}

/** Whether the running call (its async context) already holds the lock of `gitopsDir`. */
export const holdsLock = gitopsDir => !!held.getStore()?.includes(gitopsDir)
