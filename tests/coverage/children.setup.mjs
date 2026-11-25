// Run in every vitest worker (vitest.config.js). Under `npm run test:coverage`
// the Node processes a test starts — server.js, the command-line tools — write
// what they ran to COVERAGE_CHILDREN. Set here, not for the workers: vitest
// counts those itself.
if (process.env.COVERAGE_CHILDREN) process.env.NODE_V8_COVERAGE = process.env.COVERAGE_CHILDREN
