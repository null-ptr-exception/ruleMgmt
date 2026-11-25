// Preloaded into the E2E server (playwright.config.js, webServer).
//
// Node's server closes a keep-alive connection after 5 s idle (plus a 1 s
// margin). Playwright's request fixture keeps its connections open with no
// idle limit of its own, so a request sent about 6 s after the one before
// can go out on a connection the server is closing that moment: the call
// fails with "read ECONNRESET". Under load this happened about once in 270
// requests sent 6 s apart; fetch() from Chromium, the same way, never
// failed. A test lasts 30 s at most, so the test server keeps an idle
// connection open longer than that.
import http from 'node:http'
// For npm run test:e2e:coverage; nothing without it.
import '../coverage/on-sigterm.mjs'

const listen = http.Server.prototype.listen
http.Server.prototype.listen = function (...args) {
  this.keepAliveTimeout = 60_000
  return listen.apply(this, args)
}
