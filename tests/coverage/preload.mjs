// Preloaded into a process the tests start whose coverage needs help.
// Without NODE_V8_COVERAGE nothing is added.
//
// Stopped with SIGTERM: Node writes NODE_V8_COVERAGE's file when the process
// exits, and a signal that ends it is no exit. It is written here, and the
// signal then ends the process as it would have.
//
// Run from a copy or a folder of links: V8's file names scripts by URL and
// holds no text. The sha256 of each script's text as it was loaded is written
// beside it (texts-<pid>.json), so that addNode (lib.mjs) counts this repo's
// scripts and no other text under the same name.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import v8 from 'node:v8'

const dir = process.env.NODE_V8_COVERAGE
if (dir) {
  const texts = {}
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context)
      if (url.startsWith('file:') && !url.includes('/node_modules/') && loaded.source != null) {
        texts[url] = createHash('sha256').update(loaded.source).digest('hex').slice(0, 16)
      }
      return loaded
    },
  })
  const write = () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `texts-${process.pid}.json`), JSON.stringify(texts))
  }
  process.once('exit', write)
  process.once('SIGTERM', () => {
    write()
    v8.takeCoverage()
    process.kill(process.pid, 'SIGTERM')
  })
}
