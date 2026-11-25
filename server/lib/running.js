/**
 * The child processes AlertForge has started (Helm, a checker, git) that
 * have not ended yet: a command that is stopped stops them as well
 * (copyRepo.js, on SIGINT and SIGTERM). One left running would go on
 * writing into a temp folder already removed, making it again.
 *
 *   track(execFile(...))   returns the child
 *   killAll()              SIGKILL to each one still running
 */
const running = new Set()

export function track(child) {
  running.add(child)
  const done = () => running.delete(child)
  child.once('exit', done)
  child.once('error', done)
  return child
}

export function killAll() {
  for (const child of running) {
    try { child.kill('SIGKILL') } catch { /* gone already */ }
  }
}
