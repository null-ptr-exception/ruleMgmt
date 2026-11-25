// Preloaded into a server the tests stop with SIGTERM. Node writes
// NODE_V8_COVERAGE's file when the process exits, and a signal that ends it
// is no exit: it is written here, and the signal then ends the process as it
// would have. Without NODE_V8_COVERAGE nothing is added.
import v8 from 'node:v8'

if (process.env.NODE_V8_COVERAGE) {
  process.once('SIGTERM', () => {
    v8.takeCoverage()
    process.kill(process.pid, 'SIGTERM')
  })
}
